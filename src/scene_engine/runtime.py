"""Engine-owned fixed-step runtime, transaction boundary, and packet fan-out."""

from __future__ import annotations

import math
import threading
import uuid
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .clock import MonotonicClock, SystemMonotonicClock
from .display import (
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    encode_display_checkpoint,
    encode_display_command_stream,
    validate_display_nodes,
)
from .errors import (
    ConfigurationError,
    RuntimeBusyError,
    RuntimeFatalError,
    RuntimeStateError,
    SessionError,
    WireError,
)
from .json_tree import validate_json_patch, validate_json_value
from .session import ClientSession, InputOutcome, PacketRef, SessionHealth
from .wire import (
    DEFAULT_ENGINE_LIMITS,
    MAXIMUM_SAFE_INTEGER,
    EngineLimits,
    PacketKind,
    encode_checkpoint,
    encode_commit,
    encode_input_result,
    read_engine_packet,
)


CREATED = "created"
RUNNING = "running"
STOPPED = "stopped"
FATAL = "fatal"
TICKS_PER_SECOND = 60


@dataclass(frozen=True, slots=True)
class WorldCounters:
    source_tick: int
    world_revision: int

    def __post_init__(self) -> None:
        _counter(self.source_tick, "source_tick")
        _counter(self.world_revision, "world_revision")


@dataclass(frozen=True, slots=True)
class EngineCommit:
    stream_id: str
    commit_seq: int
    source_tick: int
    world_revision: int
    cause: str
    causation_id: str | None

    def __post_init__(self) -> None:
        _text(self.stream_id, "stream_id")
        _counter(self.commit_seq, "commit_seq")
        _counter(self.source_tick, "source_tick")
        _counter(self.world_revision, "world_revision")
        if self.cause not in {"tick", "input", "system"}:
            raise ConfigurationError("commit cause is invalid")
        if self.cause == "input":
            _text(self.causation_id, "causation_id")
        elif self.causation_id is not None:
            raise ConfigurationError("non-input causation_id must be null")


@dataclass(frozen=True, slots=True)
class EngineInput:
    input_id: str
    observed_stream_id: str
    observed_commit_seq: int
    command: str
    args: Mapping[str, Any]

    def __post_init__(self) -> None:
        _text(self.input_id, "input_id")
        _text(self.observed_stream_id, "observed_stream_id")
        _counter(self.observed_commit_seq, "observed_commit_seq")
        _text(self.command, "command")
        if not isinstance(self.args, dict):
            raise ConfigurationError("input args must be a JSON object")
        validate_json_value(self.args)
        object.__setattr__(self, "args", _copy_json_value(self.args))


@dataclass(frozen=True, slots=True)
class MutationResult:
    """Product mutation outcome.

    ``no-op`` and ``rejected`` may carry a ``reason_code`` and
    ``result_payload`` for client diagnostics; a ``changed`` mutation is
    described by its commit records and can carry neither.
    """

    status: str
    detail: Any = None
    reason_code: str | None = None
    result_payload: Any = None

    def __post_init__(self) -> None:
        if self.status not in {"changed", "no-op", "rejected"}:
            raise ConfigurationError("mutation status is invalid")
        if self.status == "changed" and (
            self.reason_code is not None or self.result_payload is not None
        ):
            raise ConfigurationError(
                "changed mutation cannot have a reason_code or result_payload"
            )
        if self.status == "rejected":
            _text(self.reason_code, "reason_code")
        elif self.reason_code is not None:
            _text(self.reason_code, "reason_code")
        if self.result_payload is not None:
            validate_json_value(self.result_payload)

    @classmethod
    def changed(cls, detail: Any = None) -> "MutationResult":
        return cls("changed", detail)

    @classmethod
    def no_op(
        cls,
        detail: Any = None,
        *,
        reason_code: str | None = None,
        result_payload: Any = None,
    ) -> "MutationResult":
        return cls("no-op", detail, reason_code, result_payload)

    @classmethod
    def rejected(
        cls,
        reason_code: str,
        detail: Any = None,
        *,
        result_payload: Any = None,
    ) -> "MutationResult":
        return cls("rejected", detail, reason_code, result_payload)


@dataclass(frozen=True, slots=True)
class ProductCheckpoint:
    world_codec: str
    world_snapshot: Mapping[str, Any]
    scene_name: str
    display_catalog: DisplayCatalogIdentity
    display_nodes: tuple[DisplayNode, ...]

    def __post_init__(self) -> None:
        _text(self.world_codec, "world_codec")
        if not isinstance(self.world_snapshot, dict):
            raise ConfigurationError("world_snapshot must be a JSON object")
        validate_json_value(self.world_snapshot)
        _text(self.scene_name, "scene_name")
        if not isinstance(self.display_catalog, DisplayCatalogIdentity):
            raise ConfigurationError(
                "display_catalog must be DisplayCatalogIdentity"
            )
        normalized_nodes = _display_records(
            self.display_nodes,
            DisplayNode,
            "display_nodes",
        )
        object.__setattr__(
            self,
            "display_nodes",
            validate_display_nodes(normalized_nodes),
        )


@dataclass(frozen=True, slots=True)
class ProductCommit:
    world_codec: str
    world_patch: Mapping[str, Any]
    display_commands: tuple[DisplayCommand, ...] = ()

    def __post_init__(self) -> None:
        _text(self.world_codec, "world_codec")
        if not isinstance(self.world_patch, dict):
            raise ConfigurationError("world_patch must be a JSON object")
        validate_json_patch(self.world_patch)
        object.__setattr__(
            self,
            "display_commands",
            _display_records(
                self.display_commands,
                DisplayCommand,
                "display_commands",
            ),
        )


@dataclass(frozen=True, slots=True)
class TickContext:
    commit: EngineCommit
    ticks_per_second: int

    @property
    def tick(self) -> int:
        return self.commit.source_tick


@dataclass(frozen=True, slots=True)
class InputContext:
    proposed_commit: EngineCommit
    stale_observation: bool


@dataclass(frozen=True, slots=True)
class CheckpointContext:
    stream_id: str
    commit_seq: int
    source_tick: int
    world_revision: int
    ticks_per_second: int


@dataclass(frozen=True, slots=True)
class CommitContext:
    commit: EngineCommit
    ticks_per_second: int


class EngineProgram(Protocol):
    """The only product port allowed to borrow the authoritative world."""

    def read_counters(self, world: Any) -> WorldCounters: ...

    def write_counters(self, world: Any, counters: WorldCounters) -> None: ...

    def step(self, world: Any, context: TickContext) -> MutationResult: ...

    def handle_input(
        self, world: Any, request: EngineInput, context: InputContext
    ) -> MutationResult: ...

    def build_checkpoint(
        self, world: Any, context: CheckpointContext
    ) -> ProductCheckpoint: ...

    def build_commit(
        self, world: Any, mutation: MutationResult, context: CommitContext
    ) -> ProductCommit: ...


class EngineTransport(Protocol):
    def send(self, client_id: Any, packet_bytes: bytes) -> Any: ...

    def close(self, client_id: Any, reason: str) -> Any: ...


class EngineRecorder(Protocol):
    def append(self, packet_bytes: bytes, *, checkpoint: bool) -> Any: ...

    def seal(self) -> Any: ...


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Bounded runtime limits.

    The 60 Hz rate is fixed by the runtime contract; ``ticks_per_second``
    exists so configurations state the rate explicitly and accepts only
    ``TICKS_PER_SECOND``.
    """

    ticks_per_second: int = TICKS_PER_SECOND
    maximum_ticks_per_pump: int = 120
    maximum_inputs_per_pump: int = 256
    maximum_clients: int = 1024
    maximum_in_flight_commits: int = 8
    maximum_session_pending_bytes: int = 64 * 1024 * 1024
    maximum_global_retained_packets: int = 4096
    maximum_global_retained_bytes: int = 256 * 1024 * 1024
    ack_timeout_ticks: int = 600
    maximum_packet_bytes: int = 64 * 1024 * 1024
    recording_checkpoint_interval_commits: int = 0

    def __post_init__(self) -> None:
        if (
            self.ticks_per_second != TICKS_PER_SECOND
            or isinstance(self.ticks_per_second, bool)
        ):
            raise ConfigurationError(
                "ticks_per_second must equal 60; the runtime contract fixes the rate"
            )
        for field in (
            "maximum_ticks_per_pump",
            "maximum_inputs_per_pump",
            "maximum_clients",
            "maximum_in_flight_commits",
            "maximum_session_pending_bytes",
            "maximum_global_retained_packets",
            "maximum_global_retained_bytes",
            "ack_timeout_ticks",
            "maximum_packet_bytes",
        ):
            _positive(getattr(self, field), field)
        interval = self.recording_checkpoint_interval_commits
        if isinstance(interval, bool) or not isinstance(interval, int) or interval < 0:
            raise ConfigurationError(
                "recording_checkpoint_interval_commits must be non-negative"
            )

    def engine_limits(self) -> EngineLimits:
        defaults = DEFAULT_ENGINE_LIMITS
        return EngineLimits(
            maximum_packet_bytes=self.maximum_packet_bytes,
            maximum_header_bytes=defaults.maximum_header_bytes,
            maximum_attachment_count=defaults.maximum_attachment_count,
            maximum_attachment_bytes=min(
                defaults.maximum_attachment_bytes, self.maximum_packet_bytes
            ),
            maximum_world_patch_changes=defaults.maximum_world_patch_changes,
            maximum_json_path_segments=defaults.maximum_json_path_segments,
            maximum_json_depth=defaults.maximum_json_depth,
            maximum_pending_inputs_per_client=self.maximum_inputs_per_pump,
            maximum_in_flight_commits=self.maximum_in_flight_commits,
            maximum_session_pending_bytes=self.maximum_session_pending_bytes,
            maximum_global_retained_packets=self.maximum_global_retained_packets,
            maximum_global_retained_bytes=self.maximum_global_retained_bytes,
            ack_timeout_ticks=self.ack_timeout_ticks,
        )


@dataclass(frozen=True, slots=True)
class PumpResult:
    clock_seconds: float
    target_tick: int
    inputs_processed: int
    ticks_attempted: int
    ticks_committed: int
    ticks_remaining: int
    current_tick: int
    commit_seq: int
    caught_up: bool
    backlog_truncated: bool


@dataclass(frozen=True, slots=True)
class RuntimeHealth:
    state: str
    stream_id: str
    commit_seq: int
    source_tick: int
    world_revision: int
    client_count: int
    retained_packet_count: int
    retained_bytes: int
    pending_input_count: int
    fatal_cause: BaseException | None
    sessions: tuple[SessionHealth, ...]


@dataclass(frozen=True, slots=True)
class _QueuedInput:
    client_id: Any
    request: EngineInput
    raw_bytes: bytes


class SceneEngineRuntime:
    """Own one mutable world, integer clock, commit stream, and all sessions.

    Fatal transitions are one-way: a failed transaction may leave the world
    with counters ahead of the published stream, so after ``FATAL`` the world
    must be discarded and rebuilt from a checkpoint, never reused.
    """

    def __init__(
        self,
        *,
        world: Any,
        program: EngineProgram,
        transport: EngineTransport | None = None,
        recorder: EngineRecorder | None = None,
        config: RuntimeConfig | None = None,
        clock: MonotonicClock | None = None,
        stream_id: str | None = None,
        initial_commit_seq: int = 0,
    ) -> None:
        if world is None:
            raise ConfigurationError("world is required")
        for method in (
            "read_counters",
            "write_counters",
            "step",
            "handle_input",
            "build_checkpoint",
            "build_commit",
        ):
            if not callable(getattr(program, method, None)):
                raise ConfigurationError(f"program must provide {method}()")
        if transport is not None and (
            not callable(getattr(transport, "send", None))
            or not callable(getattr(transport, "close", None))
        ):
            raise ConfigurationError("transport must provide send() and close()")
        if recorder is not None and (
            not callable(getattr(recorder, "append", None))
            or not callable(getattr(recorder, "seal", None))
        ):
            raise ConfigurationError("recorder must provide append() and seal()")
        self._config = config or RuntimeConfig()
        if not isinstance(self._config, RuntimeConfig):
            raise ConfigurationError("config must be RuntimeConfig")
        self._limits = self._config.engine_limits()
        self._clock = clock or SystemMonotonicClock()
        if not callable(getattr(self._clock, "now", None)):
            raise ConfigurationError("clock must provide now()")
        identity = stream_id or str(uuid.uuid4())
        _text(identity, "stream_id")
        _counter(initial_commit_seq, "initial_commit_seq")

        self._world = world
        self._program = program
        self._transport = transport
        self._recorder = recorder
        self._stream_id = identity
        self._commit_seq = initial_commit_seq
        counters = self._read_world_counters()
        self._source_tick = counters.source_tick
        self._world_revision = counters.world_revision
        self._initial_tick = counters.source_tick
        self._state = CREATED
        self._clock_origin = 0.0
        self._last_clock_seconds = 0.0
        self._sessions: dict[Any, ClientSession] = {}
        self._input_queue: deque[_QueuedInput] = deque()
        self._pending_input_ids: dict[Any, dict[str, bytes]] = {}
        self._retained: deque[PacketRef] = deque()
        self._retained_bytes = 0
        self._checkpoint_cache: PacketRef | None = None
        self._world_codec: str | None = None
        self._display_scene_name: str | None = None
        self._display_catalog: DisplayCatalogIdentity | None = None
        self._display_command_seq = 0
        self._fatal_cause: BaseException | None = None
        self._operation_lock = threading.Lock()

    @property
    def config(self) -> RuntimeConfig:
        return self._config

    @property
    def stream_id(self) -> str:
        return self._stream_id

    @property
    def current_tick(self) -> int:
        return self._source_tick

    @property
    def commit_seq(self) -> int:
        return self._commit_seq

    @property
    def health(self) -> RuntimeHealth:
        """Best-effort snapshot; never waits when another operation is active."""
        acquired = self._operation_lock.acquire(blocking=False)
        try:
            return self._build_health()
        finally:
            if acquired:
                self._operation_lock.release()

    def _build_health(self) -> RuntimeHealth:
        return RuntimeHealth(
            self._state,
            self._stream_id,
            self._commit_seq,
            self._source_tick,
            self._world_revision,
            len(self._sessions),
            len(self._retained),
            self._retained_bytes,
            len(self._input_queue),
            self._fatal_cause,
            tuple(session.health for session in self._sessions.values()),
        )

    def start(self, now_seconds: float | None = None) -> None:
        with _serialized(self._operation_lock):
            if self._state != CREATED:
                raise RuntimeStateError("runtime can only start from CREATED")
            now = self._clock_time() if now_seconds is None else _finite_time(now_seconds)
            self._clock_origin = now
            self._last_clock_seconds = now
            try:
                checkpoint, retained = self._get_or_build_current_checkpoint()
                if not retained:
                    raise RuntimeError(
                        "initial checkpoint exceeds global retention capacity"
                    )
                self._record_state_packet(checkpoint.raw_bytes, checkpoint=True)
            except BaseException as exc:
                self._mark_fatal(exc)
                if not isinstance(exc, Exception):
                    raise
                raise RuntimeFatalError("initial checkpoint failed") from exc
            self._state = RUNNING

    def pump(self, now_seconds: float | None = None) -> PumpResult:
        with _serialized(self._operation_lock):
            self._require_running()
            now = self._clock_time() if now_seconds is None else _finite_time(now_seconds)
            if now < self._last_clock_seconds and not math.isclose(
                now, self._last_clock_seconds, rel_tol=0, abs_tol=1e-12
            ):
                raise ConfigurationError("monotonic clock moved backwards")
            self._last_clock_seconds = max(now, self._last_clock_seconds)
            inputs_processed = 0
            while self._input_queue and inputs_processed < self._config.maximum_inputs_per_pump:
                queued = self._input_queue.popleft()
                self._process_input(queued)
                inputs_processed += 1
                if self._state == FATAL:
                    raise RuntimeFatalError("runtime became fatal while processing input") from self._fatal_cause

            scaled = (now - self._clock_origin) * TICKS_PER_SECOND
            if not math.isfinite(scaled):
                raise ConfigurationError("clock range is too large")
            target_tick = self._initial_tick + int(math.floor(scaled + 1e-9))
            overdue = max(0, target_tick - self._source_tick)
            attempts = min(overdue, self._config.maximum_ticks_per_pump)
            committed = 0
            for _ in range(attempts):
                self._commit_tick()
                committed += 1
            self._check_sessions()
            remaining = max(0, target_tick - self._source_tick)
            return PumpResult(
                now,
                target_tick,
                inputs_processed,
                attempts,
                committed,
                remaining,
                self._source_tick,
                self._commit_seq,
                remaining == 0,
                attempts < overdue,
            )

    def client_connected(self, client_id: Any) -> None:
        with _serialized(self._operation_lock):
            self._require_running()
            if self._transport is None:
                raise ConfigurationError("client connections require a transport")
            if client_id in self._sessions:
                self._drop_session(client_id, "client-replaced")
            if len(self._sessions) >= self._config.maximum_clients:
                try:
                    self._transport.close(client_id, "maximum-clients")
                except Exception:
                    pass
                return
            try:
                checkpoint, retained = self._get_or_build_current_checkpoint()
                if not retained:
                    try:
                        self._transport.close(client_id, "global-retention-capacity")
                    except Exception:
                        pass
                    return
                session = ClientSession(
                    client_id=client_id,
                    stream_id=self._stream_id,
                    baseline_commit_seq=self._commit_seq,
                    baseline_command_seq=checkpoint.last_command_seq,
                    current_tick=self._source_tick,
                    send=self._transport.send,
                    close=self._transport.close,
                    limits=self._limits,
                )
                self._sessions[client_id] = session
                self._pending_input_ids[client_id] = {}
                session.enqueue(checkpoint, current_tick=self._source_tick)
            except SessionError:
                self._drop_session(client_id, "checkpoint-send-failed")
            except BaseException as exc:
                self._mark_fatal(exc)
                if not isinstance(exc, Exception):
                    raise
                raise RuntimeFatalError("client checkpoint materialization failed") from exc

    def client_disconnected(self, client_id: Any) -> None:
        with _serialized(self._operation_lock):
            self._drop_session(client_id, "client-disconnected")

    def receive_client_packet(self, client_id: Any, raw_bytes: Any) -> None:
        with _serialized(self._operation_lock):
            self._require_running()
            session = self._sessions.get(client_id)
            if session is None or session.closed:
                return
            try:
                packet = read_engine_packet(raw_bytes, limits=self._limits)
                if packet.kind is PacketKind.ACK:
                    session.acknowledge(
                        stream_id=packet.header["stream_id"],
                        commit_seq=packet.header["commit_seq"],
                        last_command_seq=packet.header["last_command_seq"],
                        current_tick=self._source_tick,
                    )
                    return
                if packet.kind is not PacketKind.INPUT:
                    raise SessionError("client packet kind is not accepted")
                attachment = packet.attachments[0]
                if not isinstance(attachment.value, dict):
                    raise SessionError("input payload must be a JSON object")
                request = EngineInput(
                    packet.header["input_id"],
                    packet.header["observed_stream_id"],
                    packet.header["observed_commit_seq"],
                    packet.header["command"],
                    attachment.value,
                )
                raw = packet.raw_bytes
                previous = session.previous_input(request.input_id, raw)
                if previous is not None:
                    if previous.response_bytes is not None:
                        session.send_ephemeral(previous.response_bytes)
                    return
                pending = self._pending_input_ids[client_id]
                pending_raw = pending.get(request.input_id)
                if pending_raw is not None:
                    if pending_raw != raw:
                        raise SessionError("input-id-conflict")
                    return
                session.begin_input()
                pending[request.input_id] = raw
                self._input_queue.append(_QueuedInput(client_id, request, raw))
            except (WireError, SessionError, ConfigurationError):
                self._drop_session(client_id, "client-packet-invalid")

    def stop(self) -> None:
        with _serialized(self._operation_lock):
            if self._state == STOPPED:
                return
            if self._state == FATAL:
                raise RuntimeFatalError("fatal runtime cannot be normally stopped") from self._fatal_cause
            try:
                if self._recorder is not None and self._state == RUNNING:
                    self._recorder.seal()
            except BaseException as exc:
                self._mark_fatal(exc)
                if not isinstance(exc, Exception):
                    raise
                raise RuntimeFatalError("recorder seal failed") from exc
            self._state = STOPPED
            for client_id in tuple(self._sessions):
                self._drop_session(client_id, "runtime-stopped")
            self._input_queue.clear()

    def _commit_tick(self) -> None:
        before = self._assert_world_counters()
        proposed = EngineCommit(
            self._stream_id,
            self._commit_seq + 1,
            self._source_tick + 1,
            self._world_revision + 1,
            "tick",
            None,
        )
        try:
            self._write_world_counters(
                WorldCounters(proposed.source_tick, before.world_revision)
            )
            mutation = self._program.step(
                self._world,
                TickContext(proposed, TICKS_PER_SECOND),
            )
            if not isinstance(mutation, MutationResult) or mutation.status != "changed":
                raise RuntimeError("tick step must return a changed MutationResult")
            self._write_world_counters(
                WorldCounters(proposed.source_tick, proposed.world_revision)
            )
            product = self._program.build_commit(
                self._world,
                mutation,
                CommitContext(proposed, TICKS_PER_SECOND),
            )
            packet = self._encode_product_commit(proposed, product)
            self._record_state_packet(packet.raw_bytes, checkpoint=False)
        except BaseException as exc:
            self._mark_fatal(exc)
            if not isinstance(exc, Exception):
                raise
            raise RuntimeFatalError("tick transaction failed") from exc
        self._publish_commit(proposed, packet)

    def _process_input(self, queued: _QueuedInput) -> None:
        session = self._sessions.get(queued.client_id)
        if session is None or session.closed:
            return
        pending = self._pending_input_ids.get(queued.client_id)
        try:
            before = self._assert_world_counters()
            proposed = EngineCommit(
                self._stream_id,
                self._commit_seq + 1,
                self._source_tick,
                self._world_revision + 1,
                "input",
                queued.request.input_id,
            )
            stale = (
                queued.request.observed_stream_id != self._stream_id
                or queued.request.observed_commit_seq != self._commit_seq
            )
            mutation = self._program.handle_input(
                self._world, queued.request, InputContext(proposed, stale)
            )
            if not isinstance(mutation, MutationResult):
                raise RuntimeError("handle_input must return MutationResult")
            if mutation.status != "changed":
                after = self._read_world_counters()
                if after != before:
                    raise RuntimeError("unchanged input modified Engine counters")
                response = encode_input_result(
                    input_id=queued.request.input_id,
                    status=mutation.status,
                    reason_code=mutation.reason_code,
                    result=mutation.result_payload,
                    limits=self._limits,
                )
                outcome = InputOutcome(queued.raw_bytes, response, None)
                session.remember_input(queued.request.input_id, outcome)
                try:
                    session.send_ephemeral(response)
                except SessionError:
                    self._drop_session(queued.client_id, "input-result-send-failed")
                return

            self._write_world_counters(
                WorldCounters(proposed.source_tick, proposed.world_revision)
            )
            product = self._program.build_commit(
                self._world,
                mutation,
                CommitContext(proposed, TICKS_PER_SECOND),
            )
            packet = self._encode_product_commit(proposed, product)
            self._record_state_packet(packet.raw_bytes, checkpoint=False)
            self._publish_commit(proposed, packet)
            session = self._sessions.get(queued.client_id)
            if session is not None and not session.closed:
                session.remember_input(
                    queued.request.input_id,
                    InputOutcome(queued.raw_bytes, None, proposed.commit_seq),
                )
        except BaseException as exc:
            self._mark_fatal(exc)
            if not isinstance(exc, Exception):
                raise
            raise RuntimeFatalError("input transaction failed") from exc
        finally:
            if pending is not None:
                pending.pop(queued.request.input_id, None)
            current_session = self._sessions.get(queued.client_id)
            if current_session is not None and current_session.health.pending_input_count:
                current_session.finish_input()

    def _encode_product_commit(
        self, proposed: EngineCommit, product: Any
    ) -> PacketRef:
        if not isinstance(product, ProductCommit):
            raise RuntimeError("build_commit must return ProductCommit")
        if (
            self._world_codec is None
            or self._display_scene_name is None
            or self._display_catalog is None
        ):
            raise RuntimeError("stream publication contract is not initialized")
        if product.world_codec != self._world_codec:
            raise RuntimeError("world_codec changed within one stream")
        validate_json_patch(
            product.world_patch,
            maximum_changes=self._limits.maximum_world_patch_changes,
            maximum_path_segments=self._limits.maximum_json_path_segments,
            maximum_json_depth=self._limits.maximum_json_depth,
        )
        display_commands, next_command_seq = encode_display_command_stream(
            base_command_seq=self._display_command_seq,
            source_tick=proposed.source_tick,
            commands=product.display_commands,
        )
        raw = encode_commit(
            stream_id=proposed.stream_id,
            commit_seq=proposed.commit_seq,
            source_tick=proposed.source_tick,
            world_revision=proposed.world_revision,
            last_command_seq=next_command_seq,
            cause=proposed.cause,
            causation_id=proposed.causation_id,
            world_codec=product.world_codec,
            world_patch=product.world_patch,
            display_commands=display_commands,
            limits=self._limits,
        )
        self._display_command_seq = next_command_seq
        return PacketRef(
            raw,
            proposed.stream_id,
            proposed.commit_seq,
            proposed.source_tick,
            proposed.world_revision,
            next_command_seq,
            False,
        )

    def _materialize_checkpoint(self) -> PacketRef:
        before = self._assert_world_counters()
        context = CheckpointContext(
            self._stream_id,
            self._commit_seq,
            self._source_tick,
            self._world_revision,
            TICKS_PER_SECOND,
        )
        product = self._program.build_checkpoint(self._world, context)
        if not isinstance(product, ProductCheckpoint):
            raise RuntimeError("build_checkpoint must return ProductCheckpoint")
        if self._read_world_counters() != before:
            raise RuntimeError("build_checkpoint modified Engine counters")
        if self._world_codec is not None and product.world_codec != self._world_codec:
            raise RuntimeError("world_codec changed within one stream")
        if self._display_scene_name is not None and (
            product.scene_name != self._display_scene_name
            or product.display_catalog != self._display_catalog
        ):
            raise RuntimeError("display scene or catalog changed within one stream")
        display_checkpoint = encode_display_checkpoint(
            scene_name=product.scene_name,
            catalog=product.display_catalog,
            last_command_seq=self._display_command_seq,
            nodes=product.display_nodes,
        )
        raw = encode_checkpoint(
            stream_id=self._stream_id,
            commit_seq=self._commit_seq,
            source_tick=self._source_tick,
            world_revision=self._world_revision,
            last_command_seq=self._display_command_seq,
            world_codec=product.world_codec,
            world_snapshot=product.world_snapshot,
            display_checkpoint=display_checkpoint,
            limits=self._limits,
        )
        if self._world_codec is None:
            self._world_codec = product.world_codec
            self._display_scene_name = product.scene_name
            self._display_catalog = product.display_catalog
        return PacketRef(
            raw,
            self._stream_id,
            self._commit_seq,
            self._source_tick,
            self._world_revision,
            self._display_command_seq,
            True,
        )

    def _record_state_packet(self, raw_bytes: bytes, *, checkpoint: bool) -> None:
        if self._recorder is not None:
            self._recorder.append(raw_bytes, checkpoint=checkpoint)

    def _publish_commit(self, proposed: EngineCommit, packet: PacketRef) -> None:
        self._commit_seq = proposed.commit_seq
        self._source_tick = proposed.source_tick
        self._world_revision = proposed.world_revision
        self._checkpoint_cache = None
        current_retained = self._retain_packet(packet)
        if not current_retained:
            for client_id in tuple(self._sessions):
                self._drop_session(client_id, "global-retention-capacity")
        else:
            for client_id, session in tuple(self._sessions.items()):
                try:
                    session.enqueue(packet, current_tick=self._source_tick)
                except SessionError:
                    self._drop_session(client_id, "session-backpressure")
        interval = self._config.recording_checkpoint_interval_commits
        if self._recorder is not None and interval and self._commit_seq % interval == 0:
            try:
                checkpoint, _ = self._get_or_build_current_checkpoint()
                self._record_state_packet(checkpoint.raw_bytes, checkpoint=True)
            except BaseException as exc:
                self._mark_fatal(exc)
                if not isinstance(exc, Exception):
                    raise
                raise RuntimeFatalError("periodic recording checkpoint failed") from exc

    def _get_or_build_current_checkpoint(self) -> tuple[PacketRef, bool]:
        cached = self._checkpoint_cache
        if (
            cached is not None
            and cached.stream_id == self._stream_id
            and cached.commit_seq == self._commit_seq
            and cached.source_tick == self._source_tick
            and cached.world_revision == self._world_revision
            and any(item is cached for item in self._retained)
        ):
            return cached, True
        checkpoint = self._materialize_checkpoint()
        retained = self._retain_packet(checkpoint)
        if retained:
            self._checkpoint_cache = checkpoint
        return checkpoint, retained

    def _retain_packet(self, packet: PacketRef) -> bool:
        if any(item is packet for item in self._retained):
            return True
        self._retained.append(packet)
        self._retained_bytes += packet.byte_length
        evicted: list[PacketRef] = []
        while (
            len(self._retained) > self._config.maximum_global_retained_packets
            or self._retained_bytes > self._config.maximum_global_retained_bytes
        ):
            removed = self._retained.popleft()
            self._retained_bytes -= removed.byte_length
            evicted.append(removed)
            if removed is self._checkpoint_cache:
                self._checkpoint_cache = None
        if evicted:
            for client_id, session in tuple(self._sessions.items()):
                if any(session.references_packet(removed) for removed in evicted):
                    self._drop_session(client_id, "global-retention-evicted")
        return any(retained is packet for retained in self._retained)

    def _check_sessions(self) -> None:
        for client_id, session in tuple(self._sessions.items()):
            try:
                session.check_timeout(current_tick=self._source_tick)
                session.flush(current_tick=self._source_tick)
            except SessionError:
                self._drop_session(client_id, "session-timeout")

    def _drop_session(self, client_id: Any, reason: str) -> None:
        session = self._sessions.pop(client_id, None)
        self._pending_input_ids.pop(client_id, None)
        if self._input_queue:
            self._input_queue = deque(
                queued for queued in self._input_queue if queued.client_id != client_id
            )
        if session is not None:
            session.close(reason)

    def _read_world_counters(self) -> WorldCounters:
        value = self._program.read_counters(self._world)
        if not isinstance(value, WorldCounters):
            raise ConfigurationError("read_counters must return WorldCounters")
        return value

    def _write_world_counters(self, counters: WorldCounters) -> None:
        self._program.write_counters(self._world, counters)
        if self._read_world_counters() != counters:
            raise RuntimeError("write_counters did not install the requested counters")

    def _assert_world_counters(self) -> WorldCounters:
        value = self._read_world_counters()
        expected = WorldCounters(self._source_tick, self._world_revision)
        if value != expected:
            raise RuntimeError("authoritative world counters diverged from Engine")
        return value

    def _clock_time(self) -> float:
        try:
            return _finite_time(self._clock.now())
        except (TypeError, ValueError, OverflowError) as exc:
            raise ConfigurationError("clock.now() must return finite seconds") from exc

    def _require_running(self) -> None:
        if self._state == FATAL:
            raise RuntimeFatalError("runtime is fatal") from self._fatal_cause
        if self._state != RUNNING:
            raise RuntimeStateError("runtime is not running")

    def _mark_fatal(self, exc: BaseException) -> None:
        self._state = FATAL
        self._fatal_cause = exc
        for client_id in tuple(self._sessions):
            self._drop_session(client_id, "runtime-fatal")
        close_incomplete = getattr(self._recorder, "close_incomplete", None)
        if callable(close_incomplete):
            try:
                close_incomplete()
            except Exception:
                pass


def _copy_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _copy_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_copy_json_value(item) for item in value]
    return value


def _counter(value: Any, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAXIMUM_SAFE_INTEGER
    ):
        raise ConfigurationError(f"{field} must be a non-negative safe integer")
    return value


def _positive(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigurationError(f"{field} must be a positive integer")
    return value


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ConfigurationError(f"{field} must be a non-empty canonical string")
    return value


def _display_records(value: Any, record_type: type, field: str) -> tuple[Any, ...]:
    try:
        records = tuple(value)
    except TypeError as exc:
        raise ConfigurationError(f"{field} must be an iterable of records") from exc
    if any(not isinstance(record, record_type) for record in records):
        raise ConfigurationError(
            f"{field} must contain only {record_type.__name__} records"
        )
    return records


def _finite_time(value: Any) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ConfigurationError("time must be finite seconds")
    return result


@contextmanager
def _serialized(lock: threading.Lock):
    if not lock.acquire(blocking=False):
        raise RuntimeBusyError("runtime operation is already active")
    try:
        yield
    finally:
        lock.release()


__all__ = [
    "CREATED",
    "FATAL",
    "RUNNING",
    "STOPPED",
    "CheckpointContext",
    "CommitContext",
    "EngineCommit",
    "EngineInput",
    "EngineProgram",
    "EngineRecorder",
    "EngineTransport",
    "InputContext",
    "MutationResult",
    "ProductCheckpoint",
    "ProductCommit",
    "PumpResult",
    "RuntimeConfig",
    "RuntimeHealth",
    "SceneEngineRuntime",
    "TICKS_PER_SECOND",
    "TickContext",
    "WorldCounters",
]
