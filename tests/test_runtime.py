from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
import pytest

import scene_engine.runtime as runtime_module
from scene_engine import (
    ConfigurationError,
    ManualClock,
    MutationResult,
    ProductCheckpoint,
    ProductCommit,
    RuntimeBusyError,
    RuntimeConfig,
    RuntimeFatalError,
    SceneEngineRuntime,
    TICKS_PER_SECOND,
    WorldCounters,
)
from scene_engine.recording import PacketLogWriter, read_packet_log
from scene_engine.display import (
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayMatrixPool,
    DisplayNode,
    DisplayTransform,
)
from scene_engine.display_binary import decode_display_command_stream_binary
from scene_engine.session import PacketRef
from scene_engine.wire import (
    AttachmentKind,
    PacketKind,
    encode_ack,
    encode_input,
    read_engine_packet,
)


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
        self.checkpoint_calls = 0
        self.invalid_commit_display = False
        self.mutate_checkpoint_pool = False
        self.world_codec = "example-world@1"
        self.callback_rates = defaultdict(list)
        self.display_matrix_pool = DisplayMatrixPool()
        self.display_node_id = self.display_matrix_pool.append(transform(World()))

    def read_counters(self, world: World) -> WorldCounters:
        return WorldCounters(world.tick, world.world_revision)

    def write_counters(self, world: World, counters: WorldCounters) -> None:
        world.tick = counters.source_tick
        world.world_revision = counters.world_revision

    def step(self, world: World, context) -> MutationResult:
        self.steps += 1
        self.callback_rates["step"].append(context.ticks_per_second)
        if self.reenter:
            self.runtime.pump()
        if self.fail_step:
            raise RuntimeError("step failed")
        world.value += 1.5
        return MutationResult.changed()

    def handle_input(self, world: World, request, context) -> MutationResult:
        self.input_calls += 1
        self.callback_rates["handle_input"].append(context.ticks_per_second)
        if request.command == "reject":
            return MutationResult.rejected("denied", result_payload={"value": world.value})
        if request.command == "no-op":
            return MutationResult.no_op(reason_code="unchanged", result_payload={"value": 1.0})
        if request.command != "increment":
            return MutationResult.rejected("unknown-command")
        world.value += float(request.args["amount"])
        return MutationResult.changed()

    def build_checkpoint(self, world: World, context) -> ProductCheckpoint:
        self.checkpoint_calls += 1
        self.callback_rates["build_checkpoint"].append(context.ticks_per_second)
        if self.mutate_checkpoint_pool:
            self.display_matrix_pool.set(self.display_node_id, transform(world))
        return ProductCheckpoint(
            self.world_codec,
            {"tick": world.tick, "value": world.value, "world_revision": world.world_revision},
            "main",
            catalog(),
            self.display_matrix_pool,
            nodes(world, self.display_node_id),
        )

    def build_commit(self, world: World, mutation, context) -> ProductCommit:
        self.callback_rates["build_commit"].append(context.ticks_per_second)
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
        display_commands = (
            (
                DisplayCommand.set_transform(self.display_node_id),
                DisplayCommand.set_state(
                    self.display_node_id, {"tick": world.tick, "value": world.value}
                ),
            )
            if context.commit.cause == "tick"
            else ()
        )
        if self.invalid_commit_display:
            display_commands = ("not-a-display-command",)
        elif context.commit.cause == "tick":
            self.display_matrix_pool.set(self.display_node_id, transform(world))
        return ProductCommit(
            self.world_codec,
            {"schema": "scene-engine-json-tree@1", "changes": changes},
            self.display_matrix_pool,
            display_commands,
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


class Recorder:
    def __init__(self) -> None:
        self.appended = []
        self.sealed = False

    def append(self, packet_bytes, *, checkpoint):
        self.appended.append((packet_bytes, checkpoint))

    def seal(self):
        self.sealed = True


def test_mutation_result_commit_context_is_changed_only() -> None:
    marker = object()
    changed = MutationResult.changed(marker)
    assert changed.commit_context is marker
    assert not hasattr(changed, "detail")

    no_op = MutationResult.no_op(
        reason_code="unchanged",
        result_payload={"value": 1},
    )
    rejected = MutationResult.rejected(
        "denied",
        result_payload={"value": 2},
    )
    assert no_op.commit_context is None
    assert rejected.commit_context is None

    with pytest.raises(ConfigurationError, match="only changed mutation"):
        MutationResult("no-op", marker)
    with pytest.raises(ConfigurationError, match="only changed mutation"):
        MutationResult("rejected", marker, "denied")
    with pytest.raises(TypeError):
        MutationResult.no_op(marker)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        MutationResult.rejected("denied", marker)  # type: ignore[call-arg]


def catalog() -> DisplayCatalogIdentity:
    return DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64)


def transform(world: World) -> DisplayTransform:
    return DisplayTransform.from_matrix(
        (
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            world.value,
            0.0,
            0.0,
            1.0,
        )
    )


def nodes(world: World, node_id: int = 0) -> tuple[DisplayNode, ...]:
    return (
        DisplayNode(
            node_id=node_id,
            parent_node_id=None,
            prefab_id="example.node",
            transform_mode="live",
            visible=True,
            state={"tick": world.tick, "value": world.value},
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


def test_runtime_rate_is_fixed_by_contract_but_carried_as_config_value() -> None:
    config = RuntimeConfig()
    assert config.ticks_per_second == TICKS_PER_SECOND == 60
    for invalid_rate in (30, True, 60.0, Decimal(60), 60 + 0j):
        with pytest.raises(ConfigurationError, match="must equal 60"):
            RuntimeConfig(ticks_per_second=invalid_rate)


def test_every_product_callback_receives_the_contract_rate() -> None:
    runtime, clock, _, program, transport = make_runtime()
    assert program.callback_rates["build_checkpoint"] == [TICKS_PER_SECOND]

    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")
    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()
    acknowledge(runtime, transport, "a")

    send_input(
        runtime,
        "a",
        input_id="a:rate",
        command="increment",
        args={"amount": 1.0},
    )
    runtime.pump()

    assert program.callback_rates["step"] == [TICKS_PER_SECOND]
    assert program.callback_rates["handle_input"] == [TICKS_PER_SECOND]
    assert program.callback_rates["build_commit"] == [
        TICKS_PER_SECOND,
        TICKS_PER_SECOND,
    ]


def acknowledge(runtime, transport, client_id, packet=None):
    state = read_engine_packet(packet or transport.sent[client_id][-1])
    runtime.receive_client_packet(
        client_id,
        encode_ack(
            stream_id=state.header["stream_id"],
            commit_seq=state.header["commit_seq"],
            last_command_seq=state.header["last_command_seq"],
        ),
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


def test_tick_and_changed_input_have_one_commit_cursor_and_display_seal() -> None:
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
    assert [item.kind for item in tick.attachments] == [
        AttachmentKind.WORLD_PATCH,
        AttachmentKind.DISPLAY_COMMAND_STREAM,
    ]
    command_stream = decode_display_command_stream_binary(
        tick.attachments[1].bytes,
        expected_source_tick=tick.header["source_tick"],
        expected_last_command_seq=tick.header["last_command_seq"],
    )
    assert command_stream["base_command_seq"] == 0
    assert command_stream["last_command_seq"] == tick.header["last_command_seq"] == 2
    assert [record["kind"] for record in command_stream["commands"]] == [
        "node-set-transform",
        "node-set-state",
    ]
    acknowledge(runtime, transport, "a")

    send_input(runtime, "a", input_id="a:1", command="increment", args={"amount": 2.5})
    runtime.pump()
    changed = read_engine_packet(transport.sent["a"][-1])
    assert changed.header["cause"] == "input"
    assert changed.header["causation_id"] == "a:1"
    assert changed.header["source_tick"] == 1
    assert changed.header["world_revision"] == changed.header["commit_seq"] == 2
    assert changed.header["last_command_seq"] == 2
    changed_stream = decode_display_command_stream_binary(
        changed.attachments[1].bytes,
        expected_source_tick=changed.header["source_tick"],
        expected_last_command_seq=changed.header["last_command_seq"],
    )
    assert changed_stream["commands"] == []
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


def test_start_retains_one_checkpoint_shared_by_recorder_and_clients() -> None:
    recorder = Recorder()
    runtime, _, _, program, transport = make_runtime(recorder=recorder)

    cached = runtime._checkpoint_cache
    assert program.checkpoint_calls == 1
    assert cached is not None
    assert (
        cached.stream_id,
        cached.commit_seq,
        cached.source_tick,
        cached.world_revision,
    ) == (runtime.stream_id, 0, 0, 0)
    assert any(packet is cached for packet in runtime._retained)
    assert runtime.health.retained_packet_count == 1
    assert runtime.health.retained_bytes == cached.byte_length
    assert recorder.appended == [(cached.raw_bytes, True)]
    assert recorder.appended[0][0] is cached.raw_bytes

    runtime.client_connected("first")
    runtime.client_connected("second")

    assert program.checkpoint_calls == 1
    assert transport.sent["first"][0] is cached.raw_bytes
    assert transport.sent["second"][0] is cached.raw_bytes
    assert runtime._sessions["first"].references_packet(cached)
    assert runtime._sessions["second"].references_packet(cached)


def test_commit_invalidates_checkpoint_and_next_revision_builds_once() -> None:
    runtime, clock, _, program, transport = make_runtime()
    initial = runtime._checkpoint_cache
    clock.advance(2 / 60)
    runtime.pump()

    assert program.checkpoint_calls == 1
    assert runtime._checkpoint_cache is None

    runtime.client_connected("late-first")
    current = runtime._checkpoint_cache
    runtime.client_connected("late-second")

    assert program.checkpoint_calls == 2
    assert current is not None and current is not initial
    assert any(packet is current for packet in runtime._retained)
    assert transport.sent["late-first"][0] is current.raw_bytes
    assert transport.sent["late-second"][0] is current.raw_bytes
    assert runtime._sessions["late-first"].references_packet(current)
    assert runtime._sessions["late-second"].references_packet(current)
    checkpoint = read_engine_packet(current.raw_bytes)
    assert checkpoint.kind is PacketKind.CHECKPOINT
    assert checkpoint.header["commit_seq"] == 2
    assert checkpoint.header["source_tick"] == 2
    assert checkpoint.header["world_revision"] == 2


def test_evicted_current_checkpoint_is_rebuilt_and_retained_safely() -> None:
    config = RuntimeConfig(maximum_global_retained_packets=1)
    runtime, _, _, program, transport = make_runtime(config=config)
    original = runtime._checkpoint_cache
    assert original is not None

    evictor = PacketRef(
        b"evictor",
        runtime.stream_id,
        runtime.commit_seq,
        runtime.current_tick,
        0,
        original.last_command_seq,
    )
    assert runtime._retain_packet(evictor)
    assert runtime._checkpoint_cache is None
    assert all(packet is not original for packet in runtime._retained)

    runtime.client_connected("after-eviction")

    rebuilt = runtime._checkpoint_cache
    assert program.checkpoint_calls == 2
    assert rebuilt is not None and rebuilt is not original
    assert rebuilt.raw_bytes == original.raw_bytes
    assert any(packet is rebuilt for packet in runtime._retained)
    assert transport.sent["after-eviction"][0] is rebuilt.raw_bytes


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
        "b",
        encode_ack(
            stream_id=runtime.stream_id,
            commit_seq=runtime.commit_seq + 1,
            last_command_seq=runtime._display_command_seq,
        ),
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


def test_checkpoint_over_global_byte_capacity_is_fatal_during_start() -> None:
    config = RuntimeConfig(maximum_global_retained_bytes=1)
    world = World()
    program = Program()
    recorder = Recorder()
    runtime = SceneEngineRuntime(
        world=world,
        program=program,
        transport=Transport(),
        recorder=recorder,
        config=config,
        clock=ManualClock(),
        stream_id="runtime-stream",
    )

    with pytest.raises(RuntimeFatalError, match="initial checkpoint failed"):
        runtime.start()

    assert program.checkpoint_calls == 1
    assert runtime.health.state == "fatal"
    assert runtime.health.retained_packet_count == 0
    assert runtime._checkpoint_cache is None
    assert runtime.health.client_count == 0
    assert recorder.appended == []


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


def test_periodic_recorder_uses_current_checkpoint_cache_after_commit() -> None:
    recorder = Recorder()
    config = RuntimeConfig(recording_checkpoint_interval_commits=1)
    runtime, clock, _, program, transport = make_runtime(
        config=config,
        recorder=recorder,
    )

    clock.advance(1 / 60)
    runtime.pump()

    assert [checkpoint for _, checkpoint in recorder.appended] == [True, False, True]
    commit = read_engine_packet(recorder.appended[1][0])
    periodic = read_engine_packet(recorder.appended[2][0])
    assert commit.kind is PacketKind.COMMIT
    assert periodic.kind is PacketKind.CHECKPOINT
    assert (
        periodic.header["commit_seq"],
        periodic.header["source_tick"],
        periodic.header["world_revision"],
        periodic.header["last_command_seq"],
    ) == (
        commit.header["commit_seq"],
        commit.header["source_tick"],
        commit.header["world_revision"],
        commit.header["last_command_seq"],
    )
    cached = runtime._checkpoint_cache
    assert cached is not None
    assert recorder.appended[2][0] is cached.raw_bytes
    assert program.checkpoint_calls == 2

    runtime.client_connected("after-periodic")

    assert program.checkpoint_calls == 2
    assert transport.sent["after-periodic"][0] is cached.raw_bytes


def test_oversized_periodic_checkpoint_records_anchor_and_evicts_session(
    tmp_path,
) -> None:
    probe_world = World(tick=9, world_revision=9)
    probe_program = Program()
    probe_clock = ManualClock()
    probe = SceneEngineRuntime(
        world=probe_world,
        program=probe_program,
        transport=Transport(),
        clock=probe_clock,
        stream_id="runtime-stream",
        initial_commit_seq=9,
    )
    probe_program.runtime = probe
    probe.start()
    initial_checkpoint_bytes = probe.health.retained_bytes
    probe_clock.advance(1 / 60)
    probe.pump()
    probe_commit_bytes = next(
        packet.byte_length for packet in probe._retained if not packet.checkpoint
    )
    probe.stop()

    recorder = PacketLogWriter(tmp_path, fsync=False)
    config = RuntimeConfig(
        maximum_global_retained_bytes=max(
            initial_checkpoint_bytes,
            probe_commit_bytes,
        ),
        recording_checkpoint_interval_commits=1,
    )
    clock = ManualClock()
    world = World(tick=9, world_revision=9)
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
        initial_commit_seq=9,
    )
    program.runtime = runtime
    runtime.start()
    assert runtime.health.retained_bytes == initial_checkpoint_bytes
    runtime.client_connected("active")
    acknowledge(runtime, transport, "active")

    clock.advance(1 / 60)
    runtime.pump()

    assert runtime.health.state == "running"
    assert runtime.health.client_count == 0
    assert runtime.health.retained_packet_count == 1
    assert runtime._checkpoint_cache is not None
    assert program.checkpoint_calls == 2
    assert transport.closed[-1] == ("active", "global-retention-evicted")
    assert [
        read_engine_packet(raw).kind for raw in transport.sent["active"]
    ] == [PacketKind.CHECKPOINT, PacketKind.COMMIT]

    runtime.stop()
    log = read_packet_log(tmp_path)
    assert [entry.checkpoint for entry in log.entries] == [True, False, True]
    initial = read_engine_packet(log.packet_at(0))
    commit = read_engine_packet(log.packet_at(1))
    periodic = read_engine_packet(log.packet_at(2))
    assert initial.header["commit_seq"] == 9
    assert commit.header["commit_seq"] == 10
    assert periodic.header["commit_seq"] == 10
    assert periodic.header["source_tick"] == commit.header["source_tick"] == 10
    assert periodic.header["world_revision"] == commit.header["world_revision"] == 10
    assert periodic.header["last_command_seq"] == commit.header["last_command_seq"]
    assert len(log.packet_at(0)) == initial_checkpoint_bytes
    assert len(log.packet_at(2)) > initial_checkpoint_bytes


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


@pytest.mark.parametrize("failure", ["codec", "display"])
def test_stream_codec_and_display_commands_are_validated_before_commit(failure) -> None:
    runtime, clock, _, program, _ = make_runtime()
    if failure == "codec":
        program.world_codec = "other-world@1"
    else:
        program.invalid_commit_display = True
    clock.advance(1 / 60)
    with pytest.raises(RuntimeFatalError):
        runtime.pump()
    assert runtime.health.state == "fatal"


def test_product_display_port_is_structured_and_has_no_legacy_alias() -> None:
    pool = DisplayMatrixPool()
    pool.append(transform(World()))
    product = ProductCheckpoint(
        "example-world@1",
        {"tick": 0},
        "main",
        catalog(),
        pool,
        list(nodes(World())),
    )
    assert isinstance(product.display_nodes, tuple)
    assert not hasattr(product, "scene_frame")
    assert not hasattr(product, "scene_bootstrap")
    commit = ProductCommit(
        "example-world@1",
        {"schema": "scene-engine-json-tree@1", "changes": []},
        pool,
        [],
    )
    assert not hasattr(commit, "events")
    assert isinstance(commit.display_commands, tuple)
    with pytest.raises(TypeError):
        ProductCheckpoint(  # type: ignore[call-arg]
            "example-world@1",
            {"tick": 0},
            "main",
            catalog(),
            pool,
            scene_frame=b"legacy",
        )
    with pytest.raises(ConfigurationError):
        ProductCommit(
            "example-world@1",
            {"schema": "scene-engine-json-tree@1", "changes": []},
            pool,
            ("invalid",),
        )
    with pytest.raises(TypeError):
        ProductCommit(  # type: ignore[call-arg]
            "example-world@1",
            {"schema": "scene-engine-json-tree@1", "changes": []},
            pool,
            events={},
        )


def test_checkpoint_and_each_display_command_stream_encode_once(
    monkeypatch,
) -> None:
    checkpoint_calls = 0
    encode_ticks = []
    real_checkpoint = runtime_module.encode_display_checkpoint
    real_encode = runtime_module.encode_display_command_stream

    def counted_checkpoint(*args, **kwargs):
        nonlocal checkpoint_calls
        checkpoint_calls += 1
        return real_checkpoint(*args, **kwargs)

    def counted_encode(*args, **kwargs):
        encode_ticks.append(kwargs["source_tick"])
        return real_encode(*args, **kwargs)

    monkeypatch.setattr(runtime_module, "encode_display_checkpoint", counted_checkpoint)
    monkeypatch.setattr(
        runtime_module,
        "encode_display_command_stream",
        counted_encode,
    )
    runtime, clock, _, _, transport = make_runtime()
    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")
    clock.advance(1 / 60)
    runtime.pump()

    assert checkpoint_calls == 1
    assert encode_ticks == [1]
    assert not hasattr(runtime_module, "encode_scene_frame_against_bootstrap")


def test_noninitial_checkpoint_build_is_read_only_for_the_matrix_pool() -> None:
    runtime, clock, _, program, transport = make_runtime()
    runtime.client_connected("existing")
    acknowledge(runtime, transport, "existing")
    clock.advance(1 / 60)
    runtime.pump()
    assert runtime._checkpoint_cache is None

    program.mutate_checkpoint_pool = True
    with pytest.raises(RuntimeFatalError, match="checkpoint materialization"):
        runtime.client_connected("late")
    assert runtime.health.state == "fatal"
    assert isinstance(runtime.health.fatal_cause, RuntimeError)
    assert "modified the display matrix pool" in str(runtime.health.fatal_cause)


def test_periodic_checkpoint_cannot_mutate_the_matrix_pool() -> None:
    recorder = Recorder()
    runtime, clock, _, program, _ = make_runtime(
        config=RuntimeConfig(recording_checkpoint_interval_commits=1),
        recorder=recorder,
    )
    program.mutate_checkpoint_pool = True
    clock.advance(1 / 60)

    with pytest.raises(RuntimeFatalError, match="periodic"):
        runtime.pump()
    assert runtime.health.state == "fatal"
    assert isinstance(runtime.health.fatal_cause, RuntimeError)
    assert "modified the display matrix pool" in str(runtime.health.fatal_cause)


def test_failed_commit_packet_encode_keeps_matrix_row_dirty(monkeypatch) -> None:
    runtime, clock, _, program, _ = make_runtime()

    def fail_encode_commit(**_kwargs):
        raise WireError("synthetic packet failure")

    monkeypatch.setattr(runtime_module, "encode_commit", fail_encode_commit)
    clock.advance(1 / 60)
    with pytest.raises(RuntimeFatalError):
        runtime.pump()

    retry, _ = runtime_module.encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=program.display_matrix_pool,
        commands=(
            DisplayCommand.set_transform(program.display_node_id),
            DisplayCommand.set_state(program.display_node_id, {}),
        ),
    )
    assert retry.dirty_node_ids.tolist() == [program.display_node_id]
