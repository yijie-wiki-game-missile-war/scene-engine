from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal
import threading
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
        self.callback_thread_ids = defaultdict(list)
        self.display_matrix_pool = DisplayMatrixPool()
        self.display_node_id = self.display_matrix_pool.append(transform(World()))

    def read_counters(self, world: World) -> WorldCounters:
        self.callback_thread_ids["read_counters"].append(threading.get_ident())
        return WorldCounters(world.tick, world.world_revision)

    def write_counters(self, world: World, counters: WorldCounters) -> None:
        self.callback_thread_ids["write_counters"].append(threading.get_ident())
        world.tick = counters.source_tick
        world.world_revision = counters.world_revision

    def step(self, world: World, context) -> MutationResult:
        self.callback_thread_ids["step"].append(threading.get_ident())
        self.steps += 1
        self.callback_rates["step"].append(context.ticks_per_second)
        if self.reenter:
            self.runtime.pump()
        if self.fail_step:
            raise RuntimeError("step failed")
        world.value += 1.5
        return MutationResult.changed()

    def handle_input(self, world: World, request, context) -> MutationResult:
        self.callback_thread_ids["handle_input"].append(threading.get_ident())
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
        self.callback_thread_ids["build_checkpoint"].append(threading.get_ident())
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
        self.callback_thread_ids["build_commit"].append(threading.get_ident())
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
                DisplayCommand.set_transform_batch((self.display_node_id,)),
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


class PropertyEventProgram(Program):
    def build_commit(self, world: World, mutation, context) -> ProductCommit:
        base = super().build_commit(world, mutation, context)
        if context.commit.cause != "tick":
            return base
        return ProductCommit(
            base.world_codec,
            base.world_patch,
            base.display_matrix_pool,
            (
                base.display_commands[0],
                DisplayCommand.set_parent(self.display_node_id, None),
                DisplayCommand.set_property(self.display_node_id, "coins", 7),
                DisplayCommand.set_property(self.display_node_id, "flash", None),
                DisplayCommand.emit_event(
                    self.display_node_id, "explode", {"damage": 3}
                ),
                DisplayCommand.unset_property(self.display_node_id, "flash"),
            ),
        )


class Transport:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self.sent = defaultdict(list)
        self.closed = []
        self.failed = []
        self.operations = []
        self.send_thread_ids = []
        self.close_thread_ids = []
        self._fail_next = defaultdict(int)

    def send(self, client_id, raw):
        thread_id = threading.get_ident()
        with self._condition:
            self.send_thread_ids.append(thread_id)
            if self._fail_next[client_id]:
                self._fail_next[client_id] -= 1
                self.failed.append((client_id, raw))
                self.operations.append(("send-failed", client_id, raw))
                self._condition.notify_all()
                raise RuntimeError("synthetic transport send failure")
            self.sent[client_id].append(raw)
            self.operations.append(("send", client_id, raw))
            self._condition.notify_all()
        return True

    def close(self, client_id, reason):
        thread_id = threading.get_ident()
        with self._condition:
            self.close_thread_ids.append(thread_id)
            self.closed.append((client_id, reason))
            self.operations.append(("close", client_id, reason))
            self._condition.notify_all()

    def fail_next_send(self, client_id) -> None:
        with self._condition:
            self._fail_next[client_id] += 1

    def wait_sent(self, client_id, count, *, timeout=5.0):
        with self._condition:
            assert self._condition.wait_for(
                lambda: len(self.sent[client_id]) >= count,
                timeout=timeout,
            ), f"timed out waiting for {count} sends to {client_id!r}"
            return tuple(self.sent[client_id])

    def sent_packets(self, client_id):
        with self._condition:
            return tuple(self.sent[client_id])

    def wait_matching_sent(self, client_id, predicate, *, timeout=5.0):
        with self._condition:
            match = None

            def matched():
                nonlocal match
                for packet in reversed(self.sent[client_id]):
                    if predicate(packet):
                        match = packet
                        return True
                return False

            assert self._condition.wait_for(
                matched,
                timeout=timeout,
            ), f"timed out waiting for a matching send to {client_id!r}"
            return match

    def wait_closed(self, count, *, timeout=5.0):
        with self._condition:
            assert self._condition.wait_for(
                lambda: len(self.closed) >= count,
                timeout=timeout,
            ), f"timed out waiting for {count} transport closes"
            return tuple(self.closed)

    def closed_calls(self):
        with self._condition:
            return tuple(self.closed)

    def wait_failed(self, count, *, timeout=5.0):
        with self._condition:
            assert self._condition.wait_for(
                lambda: len(self.failed) >= count,
                timeout=timeout,
            ), f"timed out waiting for {count} transport failures"
            return tuple(self.failed)

    def operation_log(self):
        with self._condition:
            return tuple(self.operations)


class BlockingFirstSendTransport(Transport):
    def __init__(self) -> None:
        super().__init__()
        self.send_entered = threading.Event()
        self.release_send = threading.Event()
        self._block_lock = threading.Lock()
        self._block_first_send = True

    def send(self, client_id, raw):
        with self._block_lock:
            block = self._block_first_send
            self._block_first_send = False
        if block:
            self.send_entered.set()
            if not self.release_send.wait(30.0):
                raise TimeoutError("test did not release blocked transport send")
        return super().send(client_id, raw)


class Recorder:
    def __init__(self) -> None:
        self.appended = []
        self.sealed = False
        self.append_thread_ids = []
        self.seal_thread_ids = []

    def append(self, packet_bytes, *, checkpoint):
        self.append_thread_ids.append(threading.get_ident())
        self.appended.append((packet_bytes, checkpoint))

    def seal(self):
        self.seal_thread_ids.append(threading.get_ident())
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


_RUNTIMES_TO_STOP = []


@pytest.fixture(autouse=True)
def stop_runtime_workers_after_each_test():
    yield
    for runtime in reversed(_RUNTIMES_TO_STOP):
        try:
            if runtime.health.state == "running":
                runtime.stop()
        except RuntimeFatalError:
            pass
    _RUNTIMES_TO_STOP.clear()


def make_runtime(*, config=None, recorder=None, transport=None, program=None):
    clock = ManualClock()
    world = World()
    program = program or Program()
    transport = transport or Transport()
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
    _RUNTIMES_TO_STOP.append(runtime)
    return runtime, clock, world, program, transport


def test_runtime_rate_is_fixed_by_contract_but_carried_as_config_value() -> None:
    config = RuntimeConfig()
    assert config.ticks_per_second == TICKS_PER_SECOND == 60
    for invalid_rate in (30, True, 60.0, Decimal(60), 60 + 0j):
        with pytest.raises(ConfigurationError, match="must equal 60"):
            RuntimeConfig(ticks_per_second=invalid_rate)


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("maximum_transport_pending_count", 0),
        ("maximum_transport_pending_count", True),
        ("maximum_transport_pending_count", 1.0),
        ("maximum_transport_pending_bytes", -1),
        ("maximum_transport_pending_bytes", False),
        ("maximum_transport_pending_bytes", Decimal(1)),
        ("maximum_transport_pending_control_count", 0),
        ("maximum_transport_pending_control_count", True),
        ("maximum_transport_pending_control_count", 1.0),
        ("transport_shutdown_timeout_seconds", 0),
        ("transport_shutdown_timeout_seconds", -1.0),
        ("transport_shutdown_timeout_seconds", True),
        ("transport_shutdown_timeout_seconds", float("inf")),
        ("transport_shutdown_timeout_seconds", float("nan")),
    ),
)
def test_transport_dispatcher_config_rejects_invalid_bounds(field, value) -> None:
    with pytest.raises(ConfigurationError, match=field):
        RuntimeConfig(**{field: value})


def test_transport_control_capacity_reserves_session_and_rejection_closes() -> None:
    with pytest.raises(ConfigurationError, match="twice maximum_clients"):
        RuntimeConfig(
            maximum_clients=2,
            maximum_transport_pending_control_count=3,
        )


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
    if packet is None:
        packet = transport.wait_matching_sent(
            client_id,
            lambda raw: (
                (decoded := read_engine_packet(raw)).kind
                in {PacketKind.CHECKPOINT, PacketKind.COMMIT}
                and decoded.header["commit_seq"] == runtime.commit_seq
            ),
        )
    state = read_engine_packet(packet)
    runtime.receive_client_packet(
        client_id,
        encode_ack(
            stream_id=state.header["stream_id"],
            commit_seq=state.header["commit_seq"],
            last_command_seq=state.header["last_command_seq"],
        ),
    )


def wait_engine_packet(
    transport,
    client_id,
    *,
    kind=None,
    commit_seq=None,
    input_id=None,
):
    def matches(raw):
        packet = read_engine_packet(raw)
        return (
            (kind is None or packet.kind is kind)
            and (
                commit_seq is None
                or packet.header.get("commit_seq") == commit_seq
            )
            and (input_id is None or packet.header.get("input_id") == input_id)
        )

    return read_engine_packet(
        transport.wait_matching_sent(client_id, matches)
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
    tick = wait_engine_packet(
        transport,
        "a",
        kind=PacketKind.COMMIT,
        commit_seq=1,
    )
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
        "node-set-transform-batch",
        "node-set-state",
    ]
    acknowledge(runtime, transport, "a")

    send_input(runtime, "a", input_id="a:1", command="increment", args={"amount": 2.5})
    runtime.pump()
    changed = wait_engine_packet(
        transport,
        "a",
        kind=PacketKind.COMMIT,
        commit_seq=2,
    )
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
        response = wait_engine_packet(
            transport,
            "a",
            kind=PacketKind.INPUT_RESULT,
            input_id=f"a:{number}",
        )
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
    first_response = transport.wait_matching_sent(
        "a",
        lambda raw: (
            (packet := read_engine_packet(raw)).kind is PacketKind.INPUT_RESULT
            and packet.header["input_id"] == "a:no-op"
        ),
    )
    sent_count = len(transport.sent_packets("a"))
    runtime.receive_client_packet("a", no_op)
    duplicate_packets = transport.wait_sent("a", sent_count + 1)
    assert duplicate_packets[-1] == first_response
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
    assert transport.wait_closed(1)[-1] == ("a", "client-packet-invalid")


def test_duplicate_connect_or_disconnect_discards_queued_inputs() -> None:
    runtime, _, world, program, transport = make_runtime()
    runtime.client_connected("duplicate")
    acknowledge(runtime, transport, "duplicate")
    send_input(
        runtime,
        "duplicate",
        input_id="duplicate:old",
        command="increment",
        args={"amount": 7.0},
    )
    runtime.client_connected("duplicate")
    assert runtime.health.client_count == 0
    runtime.pump()
    assert world.value == 0.0
    assert runtime.commit_seq == 0
    assert program.input_calls == 0
    assert transport.wait_closed(1)[-1] == (
        "duplicate",
        "client-replaced",
    )

    runtime.client_connected("old-connection")
    acknowledge(runtime, transport, "old-connection")
    send_input(
        runtime,
        "old-connection",
        input_id="old-connection:gone",
        command="increment",
        args={"amount": 9.0},
    )
    runtime.client_disconnected("old-connection")
    runtime.client_connected("new-connection")
    acknowledge(runtime, transport, "new-connection")
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
    assert transport.wait_sent("first", 1)[0] is cached.raw_bytes
    assert transport.wait_sent("second", 1)[0] is cached.raw_bytes
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
    assert transport.wait_sent("late-first", 1)[0] is current.raw_bytes
    assert transport.wait_sent("late-second", 1)[0] is current.raw_bytes
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
    assert transport.wait_sent("after-eviction", 1)[0] is rebuilt.raw_bytes


def test_multiple_clients_share_commit_bytes_and_bad_ack_is_isolated() -> None:
    runtime, clock, _, _, transport = make_runtime()
    for client_id in ("a", "b"):
        runtime.client_connected(client_id)
        acknowledge(runtime, transport, client_id)
    assert transport.sent_packets("a")[0] is transport.sent_packets("b")[0]
    clock.advance(1 / 60)
    runtime.pump()
    a_packets = transport.wait_sent("a", 2)
    b_packets = transport.wait_sent("b", 2)
    assert a_packets[-1] is b_packets[-1]
    runtime.receive_client_packet(
        "b",
        encode_ack(
            stream_id=runtime.stream_id,
            commit_seq=runtime.commit_seq + 1,
            last_command_seq=runtime._display_command_seq,
        ),
    )
    assert runtime.health.client_count == 1
    assert transport.wait_closed(1)[-1][0] == "b"
    acknowledge(runtime, transport, "a")


def test_blocked_transport_does_not_block_pump_and_preserves_fifo_snapshots() -> None:
    transport = BlockingFirstSendTransport()
    runtime, clock, _, _, _ = make_runtime(transport=transport)
    runtime.client_connected("blocked")
    assert transport.send_entered.wait(5.0)

    clock.advance(2 / TICKS_PER_SECOND)
    pump_done = threading.Event()
    pump_results = []
    pump_errors = []

    def pump_runtime() -> None:
        try:
            pump_results.append(runtime.pump())
        except BaseException as exc:
            pump_errors.append(exc)
        finally:
            pump_done.set()

    pump_thread = threading.Thread(target=pump_runtime)
    pump_thread.start()
    try:
        assert pump_done.wait(5.0), "pump waited for the blocked transport"
        assert not pump_errors
        assert pump_results[0].ticks_committed == 2
        assert not transport.release_send.is_set()
    finally:
        transport.release_send.set()
        pump_thread.join(5.0)
    assert not pump_thread.is_alive()

    packets = tuple(read_engine_packet(raw) for raw in transport.wait_sent("blocked", 3))
    assert [(packet.kind, packet.header["commit_seq"]) for packet in packets] == [
        (PacketKind.CHECKPOINT, 0),
        (PacketKind.COMMIT, 1),
        (PacketKind.COMMIT, 2),
    ]
    translations = []
    for packet in packets[1:]:
        command_stream = decode_display_command_stream_binary(
            packet.attachments[1].bytes,
            expected_source_tick=packet.header["source_tick"],
            expected_last_command_seq=packet.header["last_command_seq"],
        )
        translations.append(float(command_stream["dirty_matrices"].reshape(-1)[12]))
    assert translations == [1.5, 3.0]


def test_transform_reparent_properties_and_event_share_one_ordered_background_packet() -> None:
    runtime, clock, _, _, transport = make_runtime(program=PropertyEventProgram())
    runtime.client_connected("messages")
    acknowledge(runtime, transport, "messages")

    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()
    packet = read_engine_packet(transport.wait_sent("messages", 2)[-1])
    stream = decode_display_command_stream_binary(
        packet.attachments[1].bytes,
        expected_source_tick=packet.header["source_tick"],
        expected_last_command_seq=packet.header["last_command_seq"],
    )

    assert [command["kind"] for command in stream["commands"]] == [
        "node-set-transform-batch",
        "node-set-parent",
        "node-set-property",
        "node-set-property",
        "node-emit-event",
        "node-unset-property",
    ]
    assert stream["commands"][2]["value"] == 7
    assert stream["commands"][3]["value"] is None
    assert stream["commands"][4]["payload"] == {"damage": 3}


def test_transport_calls_use_worker_while_program_and_recorder_stay_on_owner() -> None:
    owner_thread_id = threading.get_ident()
    recorder = Recorder()
    runtime, clock, _, program, transport = make_runtime(recorder=recorder)

    runtime.client_connected("a")
    acknowledge(runtime, transport, "a")
    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()
    transport.wait_sent("a", 2)
    runtime.stop()
    transport.wait_closed(1)

    callback_thread_ids = {
        thread_id
        for calls in program.callback_thread_ids.values()
        for thread_id in calls
    }
    assert callback_thread_ids == {owner_thread_id}
    assert set(recorder.append_thread_ids) == {owner_thread_id}
    assert recorder.seal_thread_ids == [owner_thread_id]
    transport_thread_ids = set(transport.send_thread_ids + transport.close_thread_ids)
    assert len(transport_thread_ids) == 1
    assert owner_thread_id not in transport_thread_ids


def test_health_returns_cached_snapshot_while_runtime_operation_is_active() -> None:
    runtime, clock, _, program, _ = make_runtime()
    entered_step = threading.Event()
    release_step = threading.Event()
    original_step = program.step

    def blocked_step(world, context):
        entered_step.set()
        if not release_step.wait(5.0):
            raise TimeoutError("test did not release blocked step")
        return original_step(world, context)

    program.step = blocked_step
    clock.advance(1 / TICKS_PER_SECOND)
    pump_errors = []

    def pump_runtime() -> None:
        try:
            runtime.pump()
        except BaseException as exc:
            pump_errors.append(exc)

    pump_thread = threading.Thread(target=pump_runtime)
    pump_thread.start()
    assert entered_step.wait(5.0)
    cached = runtime.health
    assert cached.commit_seq == 0
    assert cached.source_tick == 0

    release_step.set()
    pump_thread.join(5.0)
    assert not pump_thread.is_alive()
    assert not pump_errors
    assert runtime.health.commit_seq == 1


def test_async_send_failure_closes_only_the_failed_session() -> None:
    runtime, clock, _, _, transport = make_runtime()
    for client_id in ("failed", "healthy"):
        runtime.client_connected(client_id)
        acknowledge(runtime, transport, client_id)

    transport.fail_next_send("failed")
    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()
    transport.wait_failed(1)
    transport.wait_sent("healthy", 2)

    runtime.pump()
    assert runtime.health.client_count == 1
    assert set(runtime._sessions) == {"healthy"}
    closed = transport.wait_closed(1)
    assert closed == (("failed", "transport-send-failed"),)
    acknowledge(runtime, transport, "healthy")
    assert all(client_id != "healthy" for client_id, _ in transport.closed_calls())


def test_disconnect_cancels_old_epoch_before_a_new_connection_baseline() -> None:
    transport = BlockingFirstSendTransport()
    runtime, clock, _, _, _ = make_runtime(transport=transport)
    runtime.client_connected("old-connection")
    assert transport.send_entered.wait(5.0)

    try:
        clock.advance(1 / TICKS_PER_SECOND)
        runtime.pump()
        runtime.client_disconnected("old-connection")
        runtime.client_connected("new-connection")
        assert not transport.release_send.is_set()
    finally:
        transport.release_send.set()

    old_sent = transport.wait_sent("old-connection", 1)
    new_sent = transport.wait_sent("new-connection", 1)
    closed = transport.wait_closed(1)
    assert read_engine_packet(old_sent[0]).header["commit_seq"] == 0
    new_checkpoint = read_engine_packet(new_sent[0])
    assert new_checkpoint.kind is PacketKind.CHECKPOINT
    assert new_checkpoint.header["commit_seq"] == 1
    assert closed == (("old-connection", "client-disconnected"),)
    assert [(kind, client_id) for kind, client_id, _ in transport.operation_log()] == [
        ("send", "old-connection"),
        ("close", "old-connection"),
        ("send", "new-connection"),
    ]


def test_stop_drains_sender_and_joins_worker_without_leak() -> None:
    transport = BlockingFirstSendTransport()
    runtime, clock, _, _, _ = make_runtime(transport=transport)
    sender = runtime._transport_sender
    assert sender is not None
    worker = sender._worker
    assert worker is not None and worker.is_alive()

    runtime.client_connected("a")
    assert transport.send_entered.wait(5.0)
    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()

    stop_started = threading.Event()
    stop_done = threading.Event()
    stop_errors = []

    def stop_runtime() -> None:
        stop_started.set()
        try:
            runtime.stop()
        except BaseException as exc:
            stop_errors.append(exc)
        finally:
            stop_done.set()

    stop_thread = threading.Thread(target=stop_runtime)
    stop_thread.start()
    try:
        assert stop_started.wait(5.0)
        with sender._condition:
            assert sender._condition.wait_for(
                lambda: sender._state == "draining",
                timeout=5.0,
            )
        assert not stop_done.is_set()
    finally:
        transport.release_send.set()
    assert stop_done.wait(5.0)
    stop_thread.join(5.0)

    assert not stop_errors
    assert not stop_thread.is_alive()
    packets = tuple(read_engine_packet(raw) for raw in transport.wait_sent("a", 2))
    assert [(packet.kind, packet.header["commit_seq"]) for packet in packets] == [
        (PacketKind.CHECKPOINT, 0),
        (PacketKind.COMMIT, 1),
    ]
    assert transport.wait_closed(1) == (("a", "runtime-stopped"),)
    assert sender.health.state == "stopped"
    assert not sender.health.worker_alive
    assert not worker.is_alive()


def test_stop_still_closes_session_when_an_accepted_send_fails() -> None:
    transport = BlockingFirstSendTransport()
    transport.fail_next_send("a")
    runtime, clock, _, _, _ = make_runtime(transport=transport)
    runtime.client_connected("a")
    assert transport.send_entered.wait(5.0)
    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()

    stop_done = threading.Event()
    stop_errors = []

    def stop_runtime() -> None:
        try:
            runtime.stop()
        except BaseException as exc:
            stop_errors.append(exc)
        finally:
            stop_done.set()

    stop_thread = threading.Thread(target=stop_runtime)
    stop_thread.start()
    sender = runtime._transport_sender
    assert sender is not None
    with sender._condition:
        assert sender._condition.wait_for(
            lambda: sender._state == "draining",
            timeout=5.0,
        )
    transport.release_send.set()
    assert stop_done.wait(5.0)
    stop_thread.join(5.0)

    assert not stop_errors
    assert transport.wait_closed(1) == (("a", "runtime-stopped"),)
    assert [(kind, client_id) for kind, client_id, _ in transport.operation_log()] == [
        ("send-failed", "a"),
        ("close", "a"),
    ]


def test_stop_timeout_reports_fatal_but_keeps_graceful_drain_alive() -> None:
    transport = BlockingFirstSendTransport()
    config = RuntimeConfig(transport_shutdown_timeout_seconds=0.01)
    runtime, clock, _, _, _ = make_runtime(config=config, transport=transport)
    runtime.client_connected("a")
    assert transport.send_entered.wait(5.0)
    clock.advance(1 / TICKS_PER_SECOND)
    runtime.pump()

    with pytest.raises(RuntimeFatalError, match="shutdown failed"):
        runtime.stop()
    assert runtime.health.state == "fatal"
    sender = runtime._transport_sender
    assert sender is not None
    assert sender.health.state == "draining"

    transport.release_send.set()
    packets = tuple(read_engine_packet(raw) for raw in transport.wait_sent("a", 2))
    assert [packet.header["commit_seq"] for packet in packets] == [0, 1]
    assert transport.wait_closed(1) == (("a", "runtime-stopped"),)
    assert sender.shutdown(drain=True, timeout_seconds=5.0)


def test_rejected_connection_closes_are_bounded_while_transport_is_blocked() -> None:
    transport = BlockingFirstSendTransport()
    config = RuntimeConfig(
        maximum_clients=1,
        maximum_transport_pending_control_count=2,
    )
    runtime, _, _, _, _ = make_runtime(config=config, transport=transport)
    runtime.client_connected("admitted")
    assert transport.send_entered.wait(5.0)

    runtime.client_connected("first-rejected")
    with pytest.raises(RuntimeBusyError, match="close capacity"):
        runtime.client_connected("caller-must-close")
    sender = runtime._transport_sender
    assert sender is not None
    assert sender.health.pending_control_count == 1

    transport.release_send.set()
    assert transport.wait_closed(1) == (
        ("first-rejected", "maximum-clients"),
    )
    assert all(
        client_id != "caller-must-close"
        for client_id, _ in transport.closed_calls()
    )


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
    closed = transport.wait_closed(1)
    assert any(client == "slow" and reason == "global-retention-evicted"
               for client, reason in closed)
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
    zero_a = transport.wait_sent("zero-a", 1)
    zero_b = transport.wait_sent("zero-b", 1)
    assert zero_a[0] is zero_b[0]
    clock.advance(1 / 60)
    runtime.pump()
    runtime.client_connected("one")
    assert runtime.health.retained_packet_count <= 2
    assert runtime.health.retained_bytes <= config.maximum_global_retained_bytes
    assert any(
        client in {"zero-a", "zero-b"}
        for client, _ in transport.wait_closed(1)
    )
    clock.advance(1 / 60)
    runtime.pump()
    runtime.client_connected("two")
    assert runtime.health.retained_packet_count <= 2
    assert runtime.health.retained_bytes <= config.maximum_global_retained_bytes
    closed = transport.wait_closed(3)
    assert any(client == "one" and reason == "global-retention-evicted"
               for client, reason in closed)


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
    assert transport.wait_sent("after-periodic", 1)[0] is cached.raw_bytes


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
    assert transport.wait_closed(1)[-1] == (
        "active",
        "global-retention-evicted",
    )
    delivered_kinds = [
        read_engine_packet(raw).kind for raw in transport.sent_packets("active")
    ]
    assert delivered_kinds[0] is PacketKind.CHECKPOINT
    assert all(kind is PacketKind.COMMIT for kind in delivered_kinds[1:])
    assert len(delivered_kinds) <= 2

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
            DisplayCommand.set_transform_batch((program.display_node_id,)),
            DisplayCommand.set_state(program.display_node_id, {}),
        ),
    )
    assert retry.dirty_node_ids.tolist() == [program.display_node_id]
