import struct

import pytest

from scene_engine.consumer import CompleteFrameConsumer, StaleFramePolicy
from scene_engine.display_frame import DisplayFrameWriter
from scene_engine.errors import ConsumerError, DisplayFrameError
from scene_engine.types import DisplayPose


MAXIMUM_FRAME_ENTITIES = 16
MAXIMUM_FRAME_BYTES = 4096


def _consumer(
    *, stale_frame_policy: StaleFramePolicy = StaleFramePolicy.IGNORE
) -> CompleteFrameConsumer:
    return CompleteFrameConsumer(
        scene_epoch=7,
        bootstrap_id=11,
        ticks_per_second=60,
        maximum_frame_entities=MAXIMUM_FRAME_ENTITIES,
        maximum_frame_bytes=MAXIMUM_FRAME_BYTES,
        stale_frame_policy=stale_frame_policy,
    )


def _frame(
    frame_seq: int,
    source_tick: int,
    entities,
    *,
    scene_epoch: int = 7,
    bootstrap_id: int = 11,
    ticks_per_second: int = 60,
):
    writer = DisplayFrameWriter(
        scene_epoch=scene_epoch,
        bootstrap_id=bootstrap_id,
        frame_seq=frame_seq,
        source_tick=source_tick,
        ticks_per_second=ticks_per_second,
        maximum_frame_entities=MAXIMUM_FRAME_ENTITIES,
        maximum_frame_bytes=MAXIMUM_FRAME_BYTES,
    )
    for display_id, visible, x in entities:
        writer.add_entity(
            display_id=display_id,
            visual_type_id=display_id + 100,
            flags=1 if visible else 0,
            pose=DisplayPose(
                position=(float(x), 0.0, 0.0),
                rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
                scale=(1.0, 1.0, 1.0),
            ),
            animation_state_id=3,
            animation_start_tick=source_tick,
        )
    return writer.seal()


def test_complete_set_gap_removes_absent_and_retains_invisible_entity() -> None:
    consumer = _consumer()
    first = consumer.consume(
        _frame(1, 2, [(1, True, 10), (2, False, 20)])
    )
    first_snapshot = consumer.entities
    assert first.installed
    assert (first.created_count, first.updated_count, first.removed_count) == (2, 0, 0)
    assert not first_snapshot[2].visible

    # Both frame-sequence and source-tick gaps are normal latest-only behavior.
    latest = consumer.consume(
        _frame(9, 30, [(2, False, 25), (3, True, 40)]).data
    )

    assert latest.installed
    assert (latest.created_count, latest.updated_count, latest.removed_count) == (1, 1, 1)
    assert latest.active_entity_count == 2
    assert consumer.installed_frame_seq == 9
    assert consumer.installed_source_tick == 30
    assert set(consumer.entities) == {2, 3}
    assert consumer.entities[2].position == (25.0, 0.0, 0.0)
    assert not consumer.entities[2].visible
    assert consumer.max_seen_display_id == 3
    # Published read snapshots remain coherent across the atomic dictionary swap.
    assert set(first_snapshot) == {1, 2}


def test_stale_frames_are_ignored_by_default_before_retired_id_checks() -> None:
    consumer = _consumer()
    old_frame = _frame(1, 1, [(1, True, 1), (2, True, 2)])
    consumer.consume(old_frame)
    consumer.consume(_frame(4, 8, [(2, True, 8)]))

    result = consumer.consume(old_frame)

    assert result.ignored
    assert result.reason == "stale_frame_seq"
    assert set(consumer.entities) == {2}
    assert consumer.installed_frame_seq == 4


def test_stale_reject_policy_is_explicit_and_atomic() -> None:
    consumer = _consumer(stale_frame_policy=StaleFramePolicy.REJECT)
    consumer.consume(_frame(5, 10, [(1, True, 10)]))

    with pytest.raises(ConsumerError, match="stale"):
        consumer.consume(_frame(5, 10, [(2, True, 99)]))

    assert set(consumer.entities) == {1}
    assert consumer.entities[1].position == (10.0, 0.0, 0.0)


def test_newer_frame_sequence_cannot_move_source_tick_backwards() -> None:
    consumer = _consumer()
    consumer.consume(_frame(5, 10, [(1, True, 10)]))

    with pytest.raises(ConsumerError, match="source_tick"):
        consumer.consume(_frame(6, 9, [(1, True, 9)]))

    assert consumer.installed_frame_seq == 5
    assert consumer.installed_source_tick == 10
    assert consumer.entities[1].position == (10.0, 0.0, 0.0)


def test_retired_id_reappearance_rejects_the_whole_newer_frame() -> None:
    consumer = _consumer()
    consumer.consume(_frame(1, 1, [(1, True, 1), (2, True, 2)]))
    consumer.consume(_frame(2, 2, [(2, True, 3), (3, True, 4)]))
    before = consumer.entities

    with pytest.raises(ConsumerError, match="display_id 1"):
        consumer.consume(_frame(8, 20, [(1, True, 100), (3, True, 30)]))

    assert consumer.installed_frame_seq == 2
    assert consumer.entities is not before
    assert dict(consumer.entities) == dict(before)
    assert consumer.max_seen_display_id == 3


def test_new_display_ids_must_follow_the_epoch_monotonic_allocator() -> None:
    consumer = _consumer()
    consumer.consume(_frame(1, 1, [(5, True, 5)]))

    with pytest.raises(ConsumerError, match="non-monotonic display_id 4"):
        consumer.consume(_frame(2, 2, [(4, True, 4), (5, True, 6)]))

    assert consumer.installed_frame_seq == 1
    assert set(consumer.entities) == {5}
    assert consumer.max_seen_display_id == 5


@pytest.mark.parametrize(
    "frame, message",
    [
        (_frame(2, 2, [(1, True, 2)], scene_epoch=8), "scene_epoch"),
        (_frame(2, 2, [(1, True, 2)], bootstrap_id=12), "bootstrap_id"),
        (_frame(2, 2, [(1, True, 2)], ticks_per_second=30), "ticks_per_second"),
    ],
)
def test_epoch_bootstrap_and_timing_mismatch_are_rejected_atomically(
    frame, message: str
) -> None:
    consumer = _consumer()
    consumer.consume(_frame(1, 1, [(1, True, 1)]))

    with pytest.raises(ConsumerError, match=message):
        consumer.consume(frame)

    assert consumer.installed_frame_seq == 1
    assert set(consumer.entities) == {1}


def test_malformed_newer_frame_never_partially_reconciles() -> None:
    consumer = _consumer()
    consumer.consume(_frame(1, 1, [(1, True, 1)]))
    malformed = bytearray(_frame(2, 2, [(2, True, 2), (3, True, 3)]).data)
    # Dynamic records begin at byte 84.  Make the second ID duplicate the first.
    struct.pack_into("<Q", malformed, 84 + 72, 2)

    with pytest.raises(DisplayFrameError, match="strictly increasing"):
        consumer.consume(malformed)

    assert consumer.installed_frame_seq == 1
    assert set(consumer.entities) == {1}
