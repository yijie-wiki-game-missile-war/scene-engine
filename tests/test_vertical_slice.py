from typing import Any, List, Tuple

from scene_engine.binary_schema import DYNAMIC_ENTITY_FLAG_VISIBLE
from scene_engine.clock import ManualClock
from scene_engine.consumer import CompleteFrameConsumer
from scene_engine.host import SceneEngine
from scene_engine.packet_codec import (
    decode_display_frame_packet,
    encode_display_frame_packet,
)
from scene_engine.runtime import RuntimeConfig
from scene_engine.types import DisplayPose, TickContext


MAXIMUM_FRAME_ENTITIES = 32
MAXIMUM_FRAME_BYTES = 8192


class VerticalSliceSimulation:
    def __init__(self) -> None:
        self.completed_ticks: List[int] = []
        self.last_completed_tick = 0

    def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
        assert commands == ()
        self.last_completed_tick = context.tick
        self.completed_ticks.append(context.tick)

    def write_display_frame(self, writer: Any) -> None:
        tick = self.last_completed_tick
        writer.add_entity(
            display_id=1,
            visual_type_id=101,
            flags=DYNAMIC_ENTITY_FLAG_VISIBLE,
            pose=_pose(float(tick)),
            animation_state_id=1,
            animation_start_tick=1,
        )
        # Presence with visible=false means hidden-but-alive, not removal.
        writer.add_entity(
            display_id=2,
            visual_type_id=202,
            flags=0,
            pose=_pose(20.0),
        )
        if 6 <= tick <= 20:
            writer.add_entity(
                display_id=3,
                visual_type_id=303,
                flags=DYNAMIC_ENTITY_FLAG_VISIBLE,
                pose=_pose(float(tick * 2)),
                animation_state_id=2,
                animation_start_tick=6,
            )
        if 10 <= tick <= 24:
            writer.add_entity(
                display_id=4,
                visual_type_id=404,
                flags=DYNAMIC_ENTITY_FLAG_VISIBLE,
                pose=_pose(30.0),
                animation_state_id=3,
                animation_start_tick=10,
            )


def _pose(x: float) -> DisplayPose:
    return DisplayPose(
        position=(x, 0.0, 0.0),
        rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        scale=(1.0, 1.0, 1.0),
    )


def test_sixty_tick_thirty_frame_sparse_consumer_vertical_slice() -> None:
    clock = ManualClock()
    simulation = VerticalSliceSimulation()
    config = RuntimeConfig(
        ticks_per_second=60,
        display_frames_per_second=30,
        maximum_ticks_per_pump=60,
        maximum_frame_entities=MAXIMUM_FRAME_ENTITIES,
        maximum_frame_bytes=MAXIMUM_FRAME_BYTES,
        maximum_pending_commands=32,
        maximum_outstanding_leases=2,
    )
    engine = SceneEngine(
        simulation,
        config=config,
        clock=clock,
        scene_epoch=7,
        bootstrap_id=11,
    )
    consumer = CompleteFrameConsumer(
        scene_epoch=7,
        bootstrap_id=11,
        ticks_per_second=60,
        maximum_frame_entities=MAXIMUM_FRAME_ENTITIES,
        maximum_frame_bytes=MAXIMUM_FRAME_BYTES,
    )
    selected_sequences = {1, 4, 9, 15, 30}
    installed_sequences = []

    for _ in range(60):
        clock.advance(1.0 / 60.0)
        engine.pump()
        latest_seq = engine.latest_display_frame_seq
        if (
            latest_seq not in selected_sequences
            or latest_seq == consumer.installed_frame_seq
        ):
            continue
        lease = engine.acquire_latest_display_frame(
            consumer.installed_frame_seq or 0
        )
        assert lease is not None
        try:
            packet = encode_display_frame_packet(lease.data)
            decoded = decode_display_frame_packet(
                packet,
                maximum_stored_bytes=MAXIMUM_FRAME_BYTES,
                maximum_uncompressed_bytes=MAXIMUM_FRAME_BYTES,
                maximum_frame_entities=MAXIMUM_FRAME_ENTITIES,
                maximum_frame_bytes=MAXIMUM_FRAME_BYTES,
            )
            result = consumer.consume(decoded)
            assert result.installed
            installed_sequences.append(result.frame_seq)
        finally:
            engine.release_display_frame(lease.lease_token)

    assert simulation.completed_ticks == list(range(1, 61))
    assert engine.current_tick == 60
    assert engine.health.display_samples_succeeded == 30
    assert engine.health.last_successful_frame_seq == 30
    assert installed_sequences == [1, 4, 9, 15, 30]

    assert consumer.installed_source_tick == 60
    assert set(consumer.entities) == {1, 2}
    assert consumer.entities[1].position == (60.0, 0.0, 0.0)
    assert not consumer.entities[2].visible
    assert consumer.max_seen_display_id == 4
