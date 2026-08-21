from typing import Any, Tuple

import pytest

from scene_engine.binary_schema import UINT16_MAX, UINT64_MAX
from scene_engine.clock import ManualClock
from scene_engine.display_frame import parse_display_frame
from scene_engine.errors import ConfigurationError
from scene_engine.host import SceneEngine
from scene_engine.runtime import RuntimeConfig
from scene_engine.types import DisplayPose, TickContext


class EmptySimulation:
    def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
        pass

    def write_display_frame(self, writer: Any) -> None:
        pass


def _config(**changes: int) -> RuntimeConfig:
    values = dict(
        ticks_per_second=60,
        display_frames_per_second=60,
        maximum_ticks_per_pump=60,
        maximum_frame_entities=16,
        maximum_frame_bytes=4096,
        maximum_pending_commands=16,
        maximum_outstanding_leases=2,
    )
    values.update(changes)
    return RuntimeConfig(**values)


@pytest.mark.parametrize(
    "config, kwargs",
    [
        (_config(maximum_frame_bytes=1), {}),
        (
            _config(
                ticks_per_second=UINT16_MAX + 1,
                display_frames_per_second=1,
            ),
            {},
        ),
        (_config(), {"scene_epoch": UINT64_MAX + 1}),
        (_config(), {"bootstrap_id": UINT64_MAX + 1}),
        (_config(), {"initial_tick": UINT64_MAX}),
    ],
)
def test_host_rejects_values_the_binary_profile_cannot_represent(
    config: RuntimeConfig,
    kwargs: Any,
) -> None:
    with pytest.raises(ConfigurationError):
        SceneEngine(EmptySimulation(), config=config, **kwargs)


def test_producer_tracker_rejects_id_reuse_even_when_consumer_would_skip_removal() -> None:
    clock = ManualClock()

    class ReusingSimulation:
        def __init__(self) -> None:
            self.tick = 0

        def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
            self.tick = context.tick

        def write_display_frame(self, writer: Any) -> None:
            # ID 1 exists in frame 1, is absent/retired in frame 2, then is
            # illegally reused in frame 3.  The mailbox consumer need not have
            # acquired frame 2 for the producer-side tracker to catch this.
            if self.tick in (1, 3):
                writer.add_entity(
                    display_id=1,
                    visual_type_id=101,
                    pose=DisplayPose(
                        position=(float(self.tick), 0.0, 0.0),
                        rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
                        scale=(1.0, 1.0, 1.0),
                    ),
                )

    simulation = ReusingSimulation()
    engine = SceneEngine(
        simulation,
        config=_config(),
        clock=clock,
        scene_epoch=7,
        bootstrap_id=11,
    )
    clock.advance(3.0 / 60.0)

    result = engine.pump()

    assert result.ticks_committed == 3
    assert result.display_samples_succeeded == 2
    assert result.display_samples_failed == 1
    assert engine.current_tick == 3
    assert engine.health.last_successful_frame_seq == 2
    assert engine.max_seen_display_id == 1
    assert engine.active_display_ids == frozenset()

    lease = engine.acquire_latest_display_frame(0)
    assert lease is not None
    try:
        decoded = parse_display_frame(
            lease.data,
            maximum_frame_entities=16,
            maximum_frame_bytes=4096,
        )
        assert decoded.frame_seq == 2
        assert decoded.records == ()
    finally:
        engine.release_display_frame(lease.lease_token)


def test_failed_downstream_publish_does_not_commit_identity_state() -> None:
    clock = ManualClock()
    engine = SceneEngine(
        EmptySimulation(),
        config=_config(),
        clock=clock,
        scene_epoch=7,
        bootstrap_id=11,
    )
    original_mailbox = engine._mailbox

    class FailingMailbox:
        def publish(self, frame: object) -> None:
            raise RuntimeError("sink unavailable")

    engine._mailbox = FailingMailbox()  # type: ignore[assignment]
    clock.advance(1.0 / 60.0)
    first = engine.pump()

    assert first.display_samples_failed == 1
    assert engine.health.last_successful_frame_seq == 0
    assert engine.max_seen_display_id == 0

    engine._mailbox = original_mailbox
    clock.advance(1.0 / 60.0)
    second = engine.pump()

    assert second.display_samples_succeeded == 1
    assert engine.health.last_successful_frame_seq == 1
    assert engine.latest_display_frame_seq == 1
