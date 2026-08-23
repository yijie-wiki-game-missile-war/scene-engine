from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import pytest

from scene_engine import (
    ManualClock,
    MutationResult,
    ProductCheckpoint,
    ProductCommit,
    RuntimeBusyError,
    RuntimeConfig,
    RuntimeFatalError,
    SceneEngineRuntime,
    WorldCounters,
)
from scene_engine.recording import PacketLogWriter, read_packet_log
from scene_engine.scene import SceneNode, VisualType, encode_scene_bootstrap, encode_scene_frame
from scene_engine.wire import PacketKind, encode_ack, encode_input, read_engine_packet


@dataclass
class World:
    tick: int = 0
    world_revision: int = 0
    value: float = 0.0


class Program:
    def __init__(self) -> None:
        self.fail_step = False
        self.fail_build = False
        self.runtime = None
        self.reenter = False
        self.steps = 0
        self.input_calls = 0
        self.invalid_commit_scene = False
        self.world_codec = "example-world@1"

    def read_counters(self, world: World) -> WorldCounters:
        return WorldCounters(world.tick, world.world_revision)

    def write_counters(self, world: World, counters: WorldCounters) -> None:
        world.tick = counters.source_tick
        world.world_revision = counters.world_revision

    def step(self, world: World, context) -> MutationResult:
        self.steps += 1
        if self.reenter:
            self.runtime.pump()
        if self.fail_step:
            raise RuntimeError("step failed")
        world.value += 1.5
        return MutationResult.changed()

    def handle_input(self, world: World, request, context) -> MutationResult:
        self.input_calls += 1
        if request.command == "reject":
            return MutationResult.rejected("denied", result_payload={"value": world.value})
        if request.command == "no-op":
            return MutationResult.no_op(reason_code="unchanged", result_payload={"value": 1.0})
        if request.command != "increment":
            return MutationResult.rejected("unknown-command")
        world.value += float(request.args["amount"])
        return MutationResult.changed()

    def build_checkpoint(self, world: World, context) -> ProductCheckpoint:
        return ProductCheckpoint(
            self.world_codec,
            {"tick": world.tick, "value": world.value, "world_revision": world.world_revision},
            bootstrap(),
            frame(world),
        )

    def build_commit(self, world: World, mutation, context) -> ProductCommit:
        if self.fail_build:
            raise RuntimeError("publication failed")
        changes = []
        if context.commit.cause == "tick":
            changes.append({"op": "set", "path": ["tick"], "value": world.tick})
        changes.extend(
            [
                {"op": "set", "path": ["value"], "value": world.value},
                {
                    "op": "set",
                    "path": ["world_revision"],
                    "value": world.world_revision,
                },
            ]
        )
        product_frame = frame(world) if context.commit.cause == "tick" else None
        if self.invalid_commit_scene:
            product_frame = encode_scene_frame(
                source_tick=world.tick,
                nodes=(
                    SceneNode(
                        1,
                        0,
                        2,
                        1,
                        (world.value, 0.0, 0.0),
                        (0.0, 0.0, 0.0, 1.0),
                        (1.0, 1.0, 1.0),
                    ),
                ),
            )
        return ProductCommit(
            self.world_codec,
            {"schema": "scene-engine-json-tree@1", "changes": changes},
            product_frame,
            {"value": world.value},
        )


class Transport:
    def __init__(self) -> None:
        self.sent = defaultdict(list)
        self.closed = []

    def send(self, client_id, raw):
        self.sent[client_id].append(raw)
        return True

    def close(self, client_id, reason):
        self.closed.append((client_id, reason))


def bootstrap() -> bytes:
    return encode_scene_bootstrap(
        maximum_dynamic_nodes=8,
        maximum_frame_bytes=4096,
        visual_types=(VisualType(1),),
    )


def frame(world: World) -> bytes:
    return encode_scene_frame(
        source_tick=world.tick,
        nodes=(
            SceneNode(
                1,
                0,
                1,
                1,
                (world.value, 0.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
                (1.0, 1.0, 1.0),
            ),
        ),
    )


def make_runtime(*, config=None, recorder=None):
    clock = ManualClock()
    world = World()
    program = Program()
    transport = Transport()
    runtime = SceneEngineRuntime(
        world=world,
        program=program,
        transport=transport,
        recorder=recorder,
        config=config,
        clock=clock,
        stream_id="runtime-stream",
    )
    program.runtime = runtime
    runtime.start()
    return runtime, clock, world, program, transport


def acknowledge(runtime, transport, client_id, packet=None):
    state = read_engine_packet(packet or transport.sent[client_id][-1])
    runtime.receive_client_packet(
        client_id,
        encode_ack(stream_id=state.header["stream_id"], commit_seq=state.header["commit_seq"]),
    )


def send_input(runtime, client_id, *, input_id, command, args=None):
    runtime.receive_client_packet(
        client_id,
        encode_input(
            input_id=input_id,
            observed_stream_id=runtime.stream_id,
            observed_commit_seq=runtime.commit_seq,
            command=command,
            args=args or {},
        ),
    )


def test_tick_and_changed_input_have_one_commit_cursor_and_tick_frame() -> None:
    runtime, clock, world, _, transport = make_runtime()
    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")
    clock.advance(1 / 60)
    result = runtime.pump()
    tick = read_engine_packet(transport.sent["a"][-1])
    assert result.ticks_committed == 1
    assert tick.kind is PacketKind.COMMIT
    assert tick.header["cause"] == "tick"
    assert tick.header["commit_seq"] == tick.header["source_tick"] == 1
    assert any(item.kind.name == "SCENE_FRAME" for item in tick.attachments)
    acknowledge(runtime, transport, "a")

    send_input(runtime, "a", input_id="a:1", command="increment", args={"amount": 2.5})
    runtime.pump()
    changed = read_engine_packet(transport.sent["a"][-1])
    assert changed.header["cause"] == "input"
    assert changed.header["causation_id"] == "a:1"
    assert changed.header["source_tick"] == 1
    assert changed.header["world_revision"] == changed.header["commit_seq"] == 2
    assert world.value == 4.0


def test_noop_and_rejected_input_do_not_change_any_counter() -> None:
    runtime, _, world, _, transport = make_runtime()
    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")
    before = (world.tick, world.world_revision, runtime.commit_seq)
    for number, command in enumerate(("no-op", "reject"), 1):
        send_input(runtime, "a", input_id=f"a:{number}", command=command)
        runtime.pump()
        response = read_engine_packet(transport.sent["a"][-1])
        assert response.kind is PacketKind.INPUT_RESULT
        assert response.header["status"] in {"no-op", "rejected"}
        assert (world.tick, world.world_revision, runtime.commit_seq) == before


def test_input_idempotency_replays_noop_once_and_never_reexecutes_changed() -> None:
    runtime, _, world, program, transport = make_runtime()
    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")

    no_op = encode_input(
        input_id="a:no-op",
        observed_stream_id=runtime.stream_id,
        observed_commit_seq=runtime.commit_seq,
        command="no-op",
        args={},
    )
    runtime.receive_client_packet("a", no_op)
    runtime.pump()
    first_response = transport.sent["a"][-1]
    sent_count = len(transport.sent["a"])
    runtime.receive_client_packet("a", no_op)
    assert len(transport.sent["a"]) == sent_count + 1
    assert transport.sent["a"][-1] == first_response
    assert program.input_calls == 1

    changed = encode_input(
        input_id="a:changed",
        observed_stream_id=runtime.stream_id,
        observed_commit_seq=runtime.commit_seq,
        command="increment",
        args={"amount": 2.0},
    )
    runtime.receive_client_packet("a", changed)
    runtime.pump()
    committed = runtime.commit_seq
    value = world.value
    calls = program.input_calls
    runtime.receive_client_packet("a", changed)
    runtime.pump()
    assert runtime.commit_seq == committed
    assert world.value == value
    assert program.input_calls == calls


def test_conflicting_duplicate_input_closes_only_its_session() -> None:
    runtime, _, _, _, transport = make_runtime()
    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")
    send_input(runtime, "a", input_id="a:1", command="no-op")
    runtime.pump()
    conflict = encode_input(
        input_id="a:1",
        observed_stream_id=runtime.stream_id,
        observed_commit_seq=runtime.commit_seq,
        command="reject",
        args={},
    )
    runtime.receive_client_packet("a", conflict)
    assert runtime.health.client_count == 0
    assert transport.closed[-1] == ("a", "client-packet-invalid")


def test_disconnect_or_same_id_replacement_discards_queued_inputs() -> None:
    runtime, _, world, program, transport = make_runtime()
    runtime.client_connected("same")
    acknowledge(runtime, transport, "same")
    send_input(
        runtime,
        "same",
        input_id="same:old",
        command="increment",
        args={"amount": 7.0},
    )
    runtime.client_connected("same")
    acknowledge(runtime, transport, "same")
    runtime.pump()
    assert world.value == 0.0
    assert runtime.commit_seq == 0
    assert program.input_calls == 0

    send_input(
        runtime,
        "same",
        input_id="same:gone",
        command="increment",
        args={"amount": 9.0},
    )
    runtime.client_disconnected("same")
    runtime.client_connected("same")
    acknowledge(runtime, transport, "same")
    runtime.pump()
    assert world.value == 0.0
    assert runtime.commit_seq == 0
    assert program.input_calls == 0


def test_nonzero_checkpoint_is_independently_materialized_for_new_client() -> None:
    runtime, clock, _, _, transport = make_runtime()
    clock.advance(2 / 60)
    runtime.pump()
    runtime.client_connected("late")
    checkpoint = read_engine_packet(transport.sent["late"][0])
    assert checkpoint.kind is PacketKind.CHECKPOINT
    assert checkpoint.header["commit_seq"] == 2
    assert checkpoint.header["source_tick"] == 2
    assert checkpoint.header["world_revision"] == 2


def test_multiple_clients_share_commit_bytes_and_bad_ack_is_isolated() -> None:
    runtime, clock, _, _, transport = make_runtime()
    for client_id in ("a", "b"):
        runtime.client_connected(client_id)
        acknowledge(runtime, transport, client_id)
    assert transport.sent["a"][0] is transport.sent["b"][0]
    clock.advance(1 / 60)
    runtime.pump()
    assert transport.sent["a"][-1] is transport.sent["b"][-1]
    runtime.receive_client_packet(
        "b", encode_ack(stream_id=runtime.stream_id, commit_seq=runtime.commit_seq + 1)
    )
    assert runtime.health.client_count == 1
    assert transport.closed[-1][0] == "b"
    acknowledge(runtime, transport, "a")


def test_global_count_retention_evicts_only_lagging_session() -> None:
    config = RuntimeConfig(maximum_global_retained_packets=1)
    runtime, clock, _, _, transport = make_runtime(config=config)
    for client_id in ("healthy", "slow"):
        runtime.client_connected(client_id)
        acknowledge(runtime, transport, client_id)
    clock.advance(1 / 60)
    runtime.pump()
    acknowledge(runtime, transport, "healthy")
    clock.advance(1 / 60)
    runtime.pump()
    assert any(client == "slow" and reason == "global-retention-evicted"
               for client, reason in transport.closed)
    assert runtime.health.client_count == 1
    acknowledge(runtime, transport, "healthy")


def test_global_byte_retention_closes_sessions_when_one_packet_cannot_fit() -> None:
    config = RuntimeConfig(maximum_global_retained_bytes=1)
    runtime, clock, _, _, transport = make_runtime(config=config)
    runtime.client_connected("a")
    assert runtime.health.client_count == 0
    assert transport.closed[-1] == ("a", "global-retention-capacity")
    clock.advance(1 / 60)
    runtime.pump()
    assert runtime.health.retained_packet_count == 0
    assert runtime.health.client_count == 0


def test_staggered_slow_checkpoints_are_shared_and_globally_bounded() -> None:
    config = RuntimeConfig(maximum_global_retained_packets=2)
    runtime, clock, _, _, transport = make_runtime(config=config)
    runtime.client_connected("zero-a")
    runtime.client_connected("zero-b")
    assert transport.sent["zero-a"][0] is transport.sent["zero-b"][0]
    clock.advance(1 / 60)
    runtime.pump()
    runtime.client_connected("one")
    assert runtime.health.retained_packet_count <= 2
    assert runtime.health.retained_bytes <= config.maximum_global_retained_bytes
    assert any(client in {"zero-a", "zero-b"} for client, _ in transport.closed)
    clock.advance(1 / 60)
    runtime.pump()
    runtime.client_connected("two")
    assert runtime.health.retained_packet_count <= 2
    assert runtime.health.retained_bytes <= config.maximum_global_retained_bytes
    assert any(client == "one" and reason == "global-retention-evicted"
               for client, reason in transport.closed)


def test_recorder_starts_with_checkpoint_and_preserves_exact_commit(tmp_path) -> None:
    recorder = PacketLogWriter(tmp_path, fsync=False)
    runtime, clock, _, _, _ = make_runtime(recorder=recorder)
    clock.advance(1 / 60)
    runtime.pump()
    runtime.stop()
    log = read_packet_log(tmp_path)
    assert [entry.checkpoint for entry in log.entries] == [True, False]
    assert read_engine_packet(log.packet_at(1)).header["cause"] == "tick"


@pytest.mark.parametrize("failure", ["step", "build", "reenter"])
def test_program_or_publication_failure_is_fatal_and_never_retried(failure) -> None:
    runtime, clock, _, program, _ = make_runtime()
    if failure == "step":
        program.fail_step = True
    elif failure == "build":
        program.fail_build = True
    else:
        program.reenter = True
    clock.advance(1 / 60)
    with pytest.raises(RuntimeFatalError):
        runtime.pump()
    attempted = program.steps
    assert runtime.health.state == "fatal"
    with pytest.raises(RuntimeFatalError):
        runtime.pump()
    assert program.steps == attempted
    if failure == "reenter":
        assert isinstance(runtime.health.fatal_cause, RuntimeBusyError)


def test_runtime_has_no_public_mutable_world_escape_hatch() -> None:
    assert not hasattr(SceneEngineRuntime, "inspect_world")
    assert not hasattr(SceneEngineRuntime, "execute_world_operation")
    assert not hasattr(SceneEngineRuntime, "export_committed_state")


@pytest.mark.parametrize("failure", ["codec", "scene"])
def test_stream_codec_and_scene_catalog_are_frozen_before_first_commit(failure) -> None:
    runtime, clock, _, program, _ = make_runtime()
    if failure == "codec":
        program.world_codec = "other-world@1"
    else:
        program.invalid_commit_scene = True
    clock.advance(1 / 60)
    with pytest.raises(RuntimeFatalError):
        runtime.pump()
    assert runtime.health.state == "fatal"
