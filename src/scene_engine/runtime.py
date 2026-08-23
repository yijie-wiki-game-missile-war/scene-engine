"""Engine-owned fixed-tick runtime and authoritative world commit boundary.

The runtime supports a small legacy ``GameSimulation`` mode for generic users,
but the production ownership model is ``world + WorldProgram``: the mutable
world is private to the Engine and is only borrowed synchronously by gameplay
and commit adapters.  Tick, revision, commit ordering, authority publication
and presentation sampling therefore share one owner and one serial boundary.
"""

from __future__ import annotations

import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Optional, Protocol

from .clock import MonotonicClock, SystemMonotonicClock
from .errors import (
    AuthorityCommitFatalError,
    ConfigurationError,
    PresentationExportError,
    RuntimeBusyError,
    RuntimeStoppedError,
    SimulationFatalError,
)
from .types import GameSimulation, Tick, TickContext, WorldProgram


_RUNNING = "running"
_STOPPED = "stopped"
_FATAL = "fatal"


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Validated runtime rates and bounded resource limits."""

    ticks_per_second: int = 60
    display_frames_per_second: int = 30
    maximum_ticks_per_pump: int = 120
    maximum_frame_nodes: int = 10_000
    maximum_frame_bytes: int = 8 * 1024 * 1024
    strict_authority_presentation: bool = False

    def __post_init__(self) -> None:
        for name in (
            "ticks_per_second",
            "display_frames_per_second",
            "maximum_ticks_per_pump",
            "maximum_frame_nodes",
            "maximum_frame_bytes",
        ):
            _require_positive_int(name, getattr(self, name))
        if self.display_frames_per_second > self.ticks_per_second:
            raise ConfigurationError(
                "display_frames_per_second cannot exceed ticks_per_second"
            )
        if not isinstance(self.strict_authority_presentation, bool):
            raise ConfigurationError("strict_authority_presentation must be a boolean")
        if self.strict_authority_presentation and (
            self.display_frames_per_second != self.ticks_per_second
        ):
            raise ConfigurationError(
                "strict_authority_presentation requires one display frame per tick"
            )


@dataclass(frozen=True, slots=True)
class EngineCommit:
    """The sole ordered identity for one committed authoritative world state."""

    generation_id: int
    commit_seq: int
    source_tick: Tick
    world_revision: int
    cause: str
    causation_id: str | None = None

    def __post_init__(self) -> None:
        _require_positive_int("generation_id", self.generation_id)
        _require_non_negative_int("commit_seq", self.commit_seq)
        _require_non_negative_int("source_tick", self.source_tick)
        _require_non_negative_int("world_revision", self.world_revision)
        if not isinstance(self.cause, str) or not self.cause:
            raise ConfigurationError("cause must be a non-empty string")
        if self.causation_id is not None and (
            not isinstance(self.causation_id, str) or not self.causation_id
        ):
            raise ConfigurationError("causation_id must be null or a non-empty string")

    def as_dict(self) -> dict[str, Any]:
        return {
            "generation_id": self.generation_id,
            "commit_seq": self.commit_seq,
            "source_tick": self.source_tick,
            "world_revision": self.world_revision,
            "cause": self.cause,
            "causation_id": self.causation_id,
        }


@dataclass(frozen=True, slots=True)
class WorldOperationContext:
    """Identity reserved for one Engine-serialized same-tick operation."""

    current_tick: Tick
    proposed_commit: EngineCommit


@dataclass(frozen=True, slots=True)
class WorldOperationResult:
    """Result returned by a borrowed-world operation.

    ``changed`` declares whether an authoritative commit was produced.  A
    changed operation must leave ``world_revision`` at the revision reserved
    in ``proposed_commit``; the Engine verifies this before publication.
    """

    changed: bool
    value: Any = None

    def __post_init__(self) -> None:
        if not isinstance(self.changed, bool):
            raise TypeError("world operation changed must be a boolean")


@dataclass(frozen=True, slots=True)
class WorldOperationCommitResult:
    changed: bool
    value: Any
    engine_commit: EngineCommit | None
    authority_commit: Any = None
    presentation_export: Any = None


@dataclass(frozen=True, slots=True)
class GenerationCheckpointResult:
    """A checkpoint value materialized before its generation becomes live."""

    engine_commit: EngineCommit
    value: Any


@dataclass(frozen=True, slots=True)
class AuthorityCommitRequest:
    """One post-mutation authority materialization over a borrowed world."""

    simulation: GameSimulation | WorldProgram
    context: TickContext
    engine_commit: EngineCommit | None = None
    program_result: Any = None
    world: Any = None


class AuthorityCommitCallback(Protocol):
    def __call__(self, request: AuthorityCommitRequest) -> Any:
        ...


@dataclass(frozen=True, slots=True)
class PresentationExportRequest:
    """Metadata supplied to one complete presentation export attempt."""

    simulation: GameSimulation | WorldProgram
    scene_epoch: int
    bootstrap_id: int
    source_tick: Tick
    frame_seq: int
    ticks_per_second: int
    maximum_frame_nodes: int
    maximum_frame_bytes: int
    authority_commit: Any = None
    engine_commit: EngineCommit | None = None


class FrameExportCallback(Protocol):
    def __call__(self, request: PresentationExportRequest) -> Any:
        ...


@dataclass(frozen=True, slots=True)
class PumpResult:
    clock_seconds: float
    target_tick: Tick
    ticks_overdue: int
    ticks_attempted: int
    ticks_committed: int
    authority_commits_attempted: int
    authority_commits_succeeded: int
    ticks_remaining: int
    display_samples_due: int
    display_samples_attempted: int
    display_samples_succeeded: int
    display_samples_failed: int
    current_tick: Tick
    caught_up: bool
    stopped: bool


@dataclass(frozen=True)
class RuntimeHealth:
    state: str
    current_tick: Tick
    generation_id: int
    commit_seq: int
    world_owned: bool
    world_revision: int | None
    ticks_attempted: int
    ticks_committed: int
    authority_commits_attempted: int
    authority_commits_succeeded: int
    display_samples_attempted: int
    display_samples_succeeded: int
    display_samples_failed: int
    consecutive_display_export_failures: int
    last_successful_frame_seq: int
    presentation_epoch_valid: bool
    fatal_tick: Optional[Tick]
    fatal_cause: Optional[BaseException]
    last_display_export_error: Optional[BaseException]
    last_authority_commit_error: Optional[BaseException]

    @property
    def running(self) -> bool:
        return self.state == _RUNNING

    @property
    def stopped(self) -> bool:
        return self.state == _STOPPED

    @property
    def fatal(self) -> bool:
        return self.state == _FATAL

    @property
    def healthy(self) -> bool:
        return not self.fatal and self.presentation_epoch_valid


class SceneEngineRuntime:
    """Own time, authoritative world mutation, commits and publication order."""

    def __init__(
        self,
        simulation: GameSimulation | None = None,
        *,
        world: Any = None,
        world_program: WorldProgram | None = None,
        config: Optional[RuntimeConfig] = None,
        clock: Optional[MonotonicClock] = None,
        frame_export: Optional[FrameExportCallback] = None,
        authority_commit: Optional[AuthorityCommitCallback] = None,
        scene_epoch: int = 1,
        bootstrap_id: int = 1,
        initial_tick: Tick | None = None,
        generation_id: int = 1,
        initial_commit_seq: int = 0,
    ) -> None:
        legacy_mode = simulation is not None
        world_mode = world is not None or world_program is not None
        if legacy_mode == world_mode:
            raise ConfigurationError(
                "provide either simulation or the complete world + world_program pair"
            )
        if world_mode and (world is None or world_program is None):
            raise ConfigurationError("world and world_program are both required")
        _require_positive_int("scene_epoch", scene_epoch)
        _require_positive_int("bootstrap_id", bootstrap_id)
        _require_positive_int("generation_id", generation_id)
        _require_non_negative_int("initial_commit_seq", initial_commit_seq)

        self._simulation = simulation
        self._world = world
        self._world_program = world_program
        self._world_owned = world_mode
        if world_mode:
            world_tick = _world_counter(world, "tick")
            _world_counter(world, "world_revision")
            resolved_initial_tick = world_tick if initial_tick is None else initial_tick
            _require_non_negative_int("initial_tick", resolved_initial_tick)
            if resolved_initial_tick != world_tick:
                raise ConfigurationError("initial_tick must match the Engine-owned world tick")
        else:
            resolved_initial_tick = 0 if initial_tick is None else initial_tick
            _require_non_negative_int("initial_tick", resolved_initial_tick)

        self._config = config if config is not None else RuntimeConfig()
        if not isinstance(self._config, RuntimeConfig):
            raise ConfigurationError("config must be a RuntimeConfig")
        if self._config.strict_authority_presentation:
            if authority_commit is None:
                raise ConfigurationError(
                    "strict_authority_presentation requires an authority_commit callback"
                )
            if frame_export is None:
                raise ConfigurationError(
                    "strict_authority_presentation requires a complete frame_export callback"
                )
        self._clock = clock if clock is not None else SystemMonotonicClock()
        if not callable(getattr(self._clock, "now", None)):
            raise ConfigurationError("clock must provide now()")

        self._frame_export = frame_export
        self._authority_commit = authority_commit
        self._scene_epoch = scene_epoch
        self._bootstrap_id = bootstrap_id
        self._generation_id = generation_id
        self._commit_seq = initial_commit_seq
        self._initial_tick = resolved_initial_tick
        self._current_tick = resolved_initial_tick
        self._last_engine_commit: EngineCommit | None = None

        origin = self._read_clock()
        self._clock_origin = origin
        self._last_clock_seconds = origin
        self._display_phase = (
            resolved_initial_tick * self._config.display_frames_per_second
        ) % self._config.ticks_per_second

        self._status = _RUNNING
        self._active_tick: Optional[Tick] = None
        self._ticks_attempted = 0
        self._ticks_committed = 0
        self._authority_commits_attempted = 0
        self._authority_commits_succeeded = 0
        self._display_samples_attempted = 0
        self._display_samples_succeeded = 0
        self._display_samples_failed = 0
        self._consecutive_display_export_failures = 0
        self._last_successful_frame_seq = 0
        self._fatal_tick: Optional[Tick] = None
        self._fatal_cause: Optional[BaseException] = None
        self._last_display_export_error: Optional[BaseException] = None
        self._last_authority_commit_error: Optional[BaseException] = None
        self._last_authority_commit: Any = None
        self._last_exported_frame: Any = None
        self._presentation_epoch_valid = True

        self._state_lock = threading.RLock()
        self._pump_lock = threading.Lock()

    @property
    def config(self) -> RuntimeConfig:
        return self._config

    @property
    def current_tick(self) -> Tick:
        with self._state_lock:
            return self._current_tick

    @property
    def generation_id(self) -> int:
        with self._state_lock:
            return self._generation_id

    @property
    def commit_seq(self) -> int:
        with self._state_lock:
            return self._commit_seq

    @property
    def last_engine_commit(self) -> EngineCommit | None:
        with self._state_lock:
            return self._last_engine_commit

    @property
    def scene_epoch(self) -> int:
        return self._scene_epoch

    @property
    def bootstrap_id(self) -> int:
        return self._bootstrap_id

    @property
    def last_successful_frame_seq(self) -> int:
        with self._state_lock:
            return self._last_successful_frame_seq

    @property
    def last_exported_frame(self) -> Any:
        with self._state_lock:
            return self._last_exported_frame

    @property
    def last_authority_commit(self) -> Any:
        with self._state_lock:
            return self._last_authority_commit

    @property
    def health(self) -> RuntimeHealth:
        with self._state_lock:
            revision = (
                _world_counter(self._world, "world_revision")
                if self._world_owned
                else None
            )
            return RuntimeHealth(
                state=self._status,
                current_tick=self._current_tick,
                generation_id=self._generation_id,
                commit_seq=self._commit_seq,
                world_owned=self._world_owned,
                world_revision=revision,
                ticks_attempted=self._ticks_attempted,
                ticks_committed=self._ticks_committed,
                authority_commits_attempted=self._authority_commits_attempted,
                authority_commits_succeeded=self._authority_commits_succeeded,
                display_samples_attempted=self._display_samples_attempted,
                display_samples_succeeded=self._display_samples_succeeded,
                display_samples_failed=self._display_samples_failed,
                consecutive_display_export_failures=self._consecutive_display_export_failures,
                last_successful_frame_seq=self._last_successful_frame_seq,
                presentation_epoch_valid=self._presentation_epoch_valid,
                fatal_tick=self._fatal_tick,
                fatal_cause=self._fatal_cause,
                last_display_export_error=self._last_display_export_error,
                last_authority_commit_error=self._last_authority_commit_error,
            )

    def inspect_world(self, reader: Callable[[Any], Any]) -> Any:
        """Run a trusted synchronous read without releasing world ownership.

        The generic Engine cannot prove that an arbitrary Python callback is
        pure, but it fails closed if the callback changes either ordered world
        counter.
        """

        if not callable(reader):
            raise TypeError("world reader must be callable")
        with _non_reentrant_pump(self._pump_lock):
            with self._state_lock:
                self._require_running()
                if not self._world_owned:
                    raise ConfigurationError("inspect_world requires world ownership mode")
                tick = _world_counter(self._world, "tick")
                revision = _world_counter(self._world, "world_revision")
            try:
                result = reader(self._world)
                _assert_world_counters(self._world, tick=tick, revision=revision)
            except BaseException as exc:
                try:
                    _assert_world_counters(self._world, tick=tick, revision=revision)
                except Exception as counter_exc:
                    self._mark_fatal(tick, counter_exc)
                    if not isinstance(exc, Exception):
                        raise exc
                    raise SimulationFatalError(
                        "world inspection changed an authoritative counter"
                    ) from exc
                raise
            return result

    def pump(self, now_seconds: float | None = None) -> PumpResult:
        """Run overdue ticks in order, bounded by ``maximum_ticks_per_pump``."""

        with _non_reentrant_pump(self._pump_lock):
            with self._state_lock:
                self._require_running()

            now = self._read_clock() if now_seconds is None else _finite_seconds(now_seconds)
            with self._state_lock:
                if _clock_precedes(now, self._last_clock_seconds):
                    raise ConfigurationError("monotonic clock moved backwards")
                if now > self._last_clock_seconds:
                    self._last_clock_seconds = now
                start_tick = self._current_tick

            elapsed = max(0.0, now - self._clock_origin)
            scaled_ticks = elapsed * self._config.ticks_per_second
            if not math.isfinite(scaled_ticks):
                raise ConfigurationError("clock range is too large for scheduling")
            target_offset = int(math.floor(scaled_ticks + 1.0e-9))
            target_tick = self._initial_tick + target_offset
            ticks_overdue = max(0, target_tick - start_tick)
            tick_budget = min(ticks_overdue, self._config.maximum_ticks_per_pump)

            ticks_attempted = 0
            ticks_committed = 0
            authority_commits_attempted = 0
            authority_commits_succeeded = 0
            samples_due = 0
            samples_attempted = 0
            samples_succeeded = 0
            samples_failed = 0

            for _ in range(tick_budget):
                with self._state_lock:
                    if self._status != _RUNNING:
                        break
                    tick = self._current_tick + 1
                    self._active_tick = tick
                    self._ticks_attempted += 1
                    proposed_commit = self._proposed_commit(
                        source_tick=tick,
                        world_revision=(
                            _world_counter(self._world, "world_revision") + 1
                            if self._world_owned
                            else self._commit_seq + 1
                        ),
                        cause="tick",
                        causation_id=None,
                    )
                ticks_attempted += 1
                context = TickContext(
                    tick=tick,
                    ticks_per_second=self._config.ticks_per_second,
                    elapsed_ticks=1,
                )

                prior_tick: int | None = None
                prior_revision: int | None = None
                try:
                    if self._world_owned:
                        prior_tick = _world_counter(self._world, "tick")
                        prior_revision = _world_counter(self._world, "world_revision")
                        if prior_tick != tick - 1:
                            raise RuntimeError("engine_world_tick_diverged")
                        self._world.tick = tick
                        assert self._world_program is not None
                        program_result = self._world_program.step(self._world, context)
                        if _world_counter(self._world, "tick") != tick:
                            raise RuntimeError("world_program_must_not_write_tick")
                        # Product internals may still increment revisions while
                        # migrating. The Engine is the final and only externally
                        # observable revision writer at the commit boundary.
                        self._world.world_revision = proposed_commit.world_revision
                    else:
                        assert self._simulation is not None
                        self._simulation.step(context)
                        program_result = None
                except BaseException as exc:
                    if self._world_owned and prior_tick is not None and prior_revision is not None:
                        self._world.tick = prior_tick
                        self._world.world_revision = prior_revision
                    self._mark_fatal(tick, exc)
                    if not isinstance(exc, Exception):
                        raise
                    raise SimulationFatalError(
                        f"gameplay raised while executing tick {tick}"
                    ) from exc

                with self._state_lock:
                    self._current_tick = tick
                    self._ticks_committed += 1
                    self._commit_seq = proposed_commit.commit_seq
                    self._last_engine_commit = proposed_commit
                    self._display_phase += self._config.display_frames_per_second
                    sample_is_due = self._display_phase >= self._config.ticks_per_second
                    if sample_is_due:
                        self._display_phase -= self._config.ticks_per_second
                    status_after_step = self._status
                ticks_committed += 1

                authority_result = None
                if self._authority_commit is not None:
                    authority_commits_attempted += 1
                    authority_result = self._attempt_authority_commit(
                        AuthorityCommitRequest(
                            simulation=self._active_program,
                            context=context,
                            engine_commit=proposed_commit,
                            program_result=program_result,
                            world=self._world if self._world_owned else None,
                        )
                    )
                    authority_commits_succeeded += 1

                if sample_is_due:
                    samples_due += 1
                    if (
                        status_after_step == _RUNNING
                        and self._has_export_strategy
                        and self._presentation_epoch_valid
                    ):
                        samples_attempted += 1
                        if self._attempt_display_export(
                            tick,
                            authority_result,
                            engine_commit=proposed_commit,
                        ):
                            samples_succeeded += 1
                        else:
                            samples_failed += 1

                with self._state_lock:
                    self._active_tick = None
                    if self._status != _RUNNING:
                        break

            with self._state_lock:
                current_tick = self._current_tick
                stopped = self._status == _STOPPED
            ticks_remaining = max(0, target_tick - current_tick)
            return PumpResult(
                clock_seconds=now,
                target_tick=target_tick,
                ticks_overdue=ticks_overdue,
                ticks_attempted=ticks_attempted,
                ticks_committed=ticks_committed,
                authority_commits_attempted=authority_commits_attempted,
                authority_commits_succeeded=authority_commits_succeeded,
                ticks_remaining=ticks_remaining,
                display_samples_due=samples_due,
                display_samples_attempted=samples_attempted,
                display_samples_succeeded=samples_succeeded,
                display_samples_failed=samples_failed,
                current_tick=current_tick,
                caught_up=ticks_remaining == 0,
                stopped=stopped,
            )

    def execute_world_operation(
        self,
        operation: Callable[[Any, WorldOperationContext], WorldOperationResult],
        *,
        cause: str,
        causation_id: str | None = None,
        export_presentation: bool = True,
    ) -> WorldOperationCommitResult:
        """Serialize one command/query/control admission against the owned world.

        The operation may build its immutable product batch while borrowing the
        world. A changed result consumes exactly one Engine commit identity;
        rejected commands, queries, ACKs and accepted no-ops consume none.
        """

        if not callable(operation):
            raise TypeError("world operation must be callable")
        if not isinstance(cause, str) or not cause:
            raise ValueError("world operation cause must be non-empty")
        if not isinstance(export_presentation, bool):
            raise TypeError("export_presentation must be a boolean")
        with _non_reentrant_pump(self._pump_lock):
            with self._state_lock:
                self._require_running()
                if not self._world_owned:
                    raise ConfigurationError(
                        "execute_world_operation requires world ownership mode"
                    )
                if self._active_tick is not None:
                    raise RuntimeBusyError("cannot execute a world operation during an active tick")
                if (
                    export_presentation
                    and self._has_export_strategy
                    and not self._config.strict_authority_presentation
                ):
                    raise ConfigurationError(
                        "same-tick operation export requires strict_authority_presentation"
                )
                operation_tick = self._current_tick
                previous_tick = _world_counter(self._world, "tick")
                if previous_tick != operation_tick:
                    exc = RuntimeError("engine_world_tick_diverged")
                    self._mark_fatal(operation_tick, exc)
                    raise SimulationFatalError(
                        "Engine-owned world tick diverged before operation"
                    ) from exc
                previous_revision = _world_counter(self._world, "world_revision")
                proposed = self._proposed_commit(
                    source_tick=operation_tick,
                    world_revision=previous_revision + 1,
                    cause=cause,
                    causation_id=causation_id,
                )
                context = WorldOperationContext(operation_tick, proposed)

            try:
                outcome = operation(self._world, context)
            except BaseException as exc:
                # There is no generic, lossless rollback for an arbitrary
                # product aggregate. Quarantine the borrowed instance so any
                # partial mutation can never receive a later commit identity.
                self._mark_fatal(operation_tick, exc)
                if not isinstance(exc, Exception):
                    raise
                raise SimulationFatalError(
                    "world operation raised before its Engine commit"
                ) from exc
            if not isinstance(outcome, WorldOperationResult):
                exc = TypeError("world operation must return WorldOperationResult")
                self._mark_fatal(operation_tick, exc)
                raise SimulationFatalError(
                    "world operation returned an invalid result"
                ) from exc

            try:
                _assert_world_counters(
                    self._world,
                    tick=previous_tick,
                    revision=(
                        proposed.world_revision
                        if outcome.changed
                        else previous_revision
                    ),
                )
            except Exception as exc:
                self._mark_fatal(operation_tick, exc)
                raise SimulationFatalError(
                    "world operation violated its reserved Engine counters"
                ) from exc

            if not outcome.changed:
                return WorldOperationCommitResult(False, outcome.value, None)

            with self._state_lock:
                self._commit_seq = proposed.commit_seq
                self._last_engine_commit = proposed
            authority_result = None
            if self._authority_commit is not None:
                authority_result = self._attempt_authority_commit(
                    AuthorityCommitRequest(
                        simulation=self._active_program,
                        context=TickContext(
                            tick=operation_tick,
                            ticks_per_second=self._config.ticks_per_second,
                            elapsed_ticks=0,
                        ),
                        engine_commit=proposed,
                        program_result=outcome.value,
                        world=self._world,
                    )
                )
            exported = None
            if export_presentation and self._has_export_strategy:
                if not self._attempt_display_export(
                    operation_tick,
                    authority_result,
                    engine_commit=proposed,
                ):
                    raise PresentationExportError(
                        "same-tick committed state export invalidated presentation epoch"
                    )
                exported = self.last_exported_frame
            return WorldOperationCommitResult(
                True,
                outcome.value,
                proposed,
                authority_result,
                exported,
            )

    def stop(self) -> None:
        with self._state_lock:
            if self._status in {_FATAL, _STOPPED}:
                return
            self._status = _STOPPED

    def rotate_generation(
        self,
        materialize: Callable[[Any, EngineCommit], Any],
    ) -> GenerationCheckpointResult:
        """Atomically materialize and install a fresh checkpoint generation.

        The candidate identity is visible only to ``materialize`` until that
        callback returns successfully and the Engine verifies that checkpoint
        construction did not mutate the world's tick or revision.
        """

        if not callable(materialize):
            raise TypeError("generation checkpoint materializer must be callable")
        with _non_reentrant_pump(self._pump_lock):
            with self._state_lock:
                self._require_running()
                if not self._world_owned:
                    raise ConfigurationError(
                        "rotate_generation requires world ownership mode"
                    )
                if self._active_tick is not None:
                    raise RuntimeBusyError("cannot rotate generation during an active tick")
                tick = _world_counter(self._world, "tick")
                revision = _world_counter(self._world, "world_revision")
                if tick != self._current_tick:
                    exc = RuntimeError("engine_world_tick_diverged")
                    self._mark_fatal(self._current_tick, exc)
                    raise SimulationFatalError(
                        "Engine-owned world tick diverged before checkpoint"
                    ) from exc
                checkpoint = EngineCommit(
                    generation_id=self._generation_id + 1,
                    commit_seq=0,
                    source_tick=tick,
                    world_revision=revision,
                    cause="checkpoint",
                    causation_id=None,
                )
            try:
                value = materialize(self._world, checkpoint)
                _assert_world_counters(self._world, tick=tick, revision=revision)
            except BaseException as exc:
                self._mark_fatal(tick, exc)
                if not isinstance(exc, Exception):
                    raise
                raise SimulationFatalError(
                    "generation checkpoint materialization failed"
                ) from exc
            with self._state_lock:
                self._require_running()
                self._generation_id = checkpoint.generation_id
                self._commit_seq = checkpoint.commit_seq
                self._last_engine_commit = checkpoint
            return GenerationCheckpointResult(checkpoint, value)

    def activate_presentation_epoch(
        self, *, scene_epoch: int, bootstrap_id: int
    ) -> None:
        _require_positive_int("scene_epoch", scene_epoch)
        _require_positive_int("bootstrap_id", bootstrap_id)
        with self._state_lock:
            self._require_running()
            if scene_epoch <= self._scene_epoch:
                raise ConfigurationError("scene_epoch must increase")
            if bootstrap_id <= self._bootstrap_id:
                raise ConfigurationError("bootstrap_id must increase")
            self._scene_epoch = scene_epoch
            self._bootstrap_id = bootstrap_id
            self._last_successful_frame_seq = 0
            self._last_exported_frame = None
            self._last_display_export_error = None
            self._consecutive_display_export_failures = 0
            self._presentation_epoch_valid = True

    def export_committed_state(
        self,
        authority_commit: Any,
        *,
        engine_commit: EngineCommit | None = None,
    ) -> Any:
        """Export one complete frame at the current already-committed tick."""

        with _non_reentrant_pump(self._pump_lock):
            with self._state_lock:
                self._require_running()
                if self._active_tick is not None:
                    raise RuntimeBusyError(
                        "cannot export an external commit during an active tick"
                    )
                if not self._config.strict_authority_presentation:
                    raise ConfigurationError(
                        "export_committed_state requires strict_authority_presentation"
                    )
                if not self._has_export_strategy:
                    raise ConfigurationError(
                        "export_committed_state requires a display export strategy"
                    )
                if not self._presentation_epoch_valid:
                    raise PresentationExportError("presentation epoch is invalid")
                source_tick = self._current_tick
                identity = engine_commit or self._last_engine_commit
            if not self._attempt_display_export(
                source_tick,
                authority_commit,
                engine_commit=identity,
            ):
                raise PresentationExportError(
                    "same-tick committed state export invalidated presentation epoch"
                )
            return self.last_exported_frame

    @property
    def _active_program(self) -> GameSimulation | WorldProgram:
        value = self._world_program if self._world_owned else self._simulation
        assert value is not None
        return value

    @property
    def _has_export_strategy(self) -> bool:
        return self._frame_export is not None

    def _proposed_commit(
        self,
        *,
        source_tick: int,
        world_revision: int,
        cause: str,
        causation_id: str | None,
    ) -> EngineCommit:
        return EngineCommit(
            generation_id=self._generation_id,
            commit_seq=self._commit_seq + 1,
            source_tick=source_tick,
            world_revision=world_revision,
            cause=cause,
            causation_id=causation_id,
        )

    def _attempt_authority_commit(self, request: AuthorityCommitRequest) -> Any:
        with self._state_lock:
            self._authority_commits_attempted += 1
        try:
            assert self._authority_commit is not None
            result = self._authority_commit(request)
            if self._config.strict_authority_presentation and result is None:
                raise AuthorityCommitFatalError(
                    "strict_authority_presentation authority_commit returned None"
                )
        except BaseException as exc:
            with self._state_lock:
                self._active_tick = None
                self._status = _FATAL
                self._fatal_tick = request.context.tick
                self._fatal_cause = exc
                self._last_authority_commit_error = exc
            if not isinstance(exc, Exception):
                raise
            if isinstance(exc, AuthorityCommitFatalError):
                raise
            raise AuthorityCommitFatalError(
                f"authority commit failed after tick {request.context.tick} committed"
            ) from exc
        with self._state_lock:
            self._authority_commits_succeeded += 1
            self._last_authority_commit = result
        return result

    def _attempt_display_export(
        self,
        source_tick: Tick,
        authority_commit: Any = None,
        *,
        engine_commit: EngineCommit | None = None,
    ) -> bool:
        with self._state_lock:
            frame_seq = self._last_successful_frame_seq + 1
            self._display_samples_attempted += 1

        request = PresentationExportRequest(
            simulation=self._active_program,
            scene_epoch=self._scene_epoch,
            bootstrap_id=self._bootstrap_id,
            source_tick=source_tick,
            frame_seq=frame_seq,
            ticks_per_second=self._config.ticks_per_second,
            maximum_frame_nodes=self._config.maximum_frame_nodes,
            maximum_frame_bytes=self._config.maximum_frame_bytes,
            authority_commit=authority_commit,
            engine_commit=engine_commit,
        )
        try:
            assert self._frame_export is not None
            exported = self._frame_export(request)
            if self._config.strict_authority_presentation and exported is None:
                raise PresentationExportError(
                    "strict_authority_presentation frame_export returned None"
                )
        except Exception as exc:
            with self._state_lock:
                self._display_samples_failed += 1
                self._consecutive_display_export_failures += 1
                self._last_display_export_error = exc
                if self._config.strict_authority_presentation:
                    self._presentation_epoch_valid = False
            return False

        with self._state_lock:
            self._display_samples_succeeded += 1
            self._consecutive_display_export_failures = 0
            self._last_successful_frame_seq = frame_seq
            self._last_exported_frame = exported
        return True

    def _mark_fatal(self, tick: int, exc: BaseException) -> None:
        with self._state_lock:
            self._active_tick = None
            self._status = _FATAL
            self._fatal_tick = tick
            self._fatal_cause = exc

    def _read_clock(self) -> float:
        try:
            value = float(self._clock.now())
        except (TypeError, ValueError, OverflowError) as exc:
            raise ConfigurationError("clock.now() must return finite seconds") from exc
        if not math.isfinite(value):
            raise ConfigurationError("clock.now() must return finite seconds")
        return value

    def _require_running(self) -> None:
        if self._status == _FATAL:
            tick = self._fatal_tick
            message = "simulation is fatal"
            if tick is not None:
                message += f" at tick {tick}"
            raise SimulationFatalError(message) from self._fatal_cause
        if self._status == _STOPPED:
            raise RuntimeStoppedError("runtime has been stopped")


def _world_counter(world: Any, name: str) -> int:
    value = getattr(world, name, None)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ConfigurationError(f"Engine-owned world.{name} must be a non-negative integer")
    return value


def _assert_world_counters(world: Any, *, tick: int, revision: int) -> None:
    if (
        _world_counter(world, "tick") != tick
        or _world_counter(world, "world_revision") != revision
    ):
        raise RuntimeError("engine_world_counters_diverged")


def _require_positive_int(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigurationError(f"{name} must be a positive integer")


def _require_non_negative_int(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ConfigurationError(f"{name} must be a non-negative integer")


def _finite_seconds(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ConfigurationError("pump time must be finite seconds") from exc
    if not math.isfinite(result):
        raise ConfigurationError("pump time must be finite seconds")
    return result


def _clock_precedes(value: float, previous: float) -> bool:
    return value < previous and not math.isclose(
        value, previous, rel_tol=0.0, abs_tol=1.0e-12
    )


@contextmanager
def _non_reentrant_pump(lock: Any) -> Any:
    if not lock.acquire(blocking=False):
        raise RuntimeBusyError("runtime pump is already active")
    try:
        yield
    finally:
        lock.release()


__all__ = [
    "AuthorityCommitCallback",
    "AuthorityCommitRequest",
    "EngineCommit",
    "FrameExportCallback",
    "GenerationCheckpointResult",
    "PresentationExportRequest",
    "PumpResult",
    "RuntimeConfig",
    "RuntimeHealth",
    "SceneEngineRuntime",
    "WorldOperationCommitResult",
    "WorldOperationContext",
    "WorldOperationResult",
]
