"""Engine-owned fixed-tick runtime with renderer-neutral presentation sampling.

This module deliberately has no dependency on a gameplay implementation, the
presentation binary codec, a transport, or a renderer. Those concerns enter
through the small ports defined here and in :mod:`scene_engine.types`.
"""

from __future__ import annotations

import math
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Optional, Protocol

from .clock import MonotonicClock, SystemMonotonicClock
from .errors import (
    AuthorityCommitFatalError,
    ConfigurationError,
    PresentationExportError,
    RuntimeBusyError,
    RuntimeStoppedError,
    SimulationFatalError,
)
from .types import GameSimulation, Tick, TickContext


_RUNNING = "running"
_STOPPED = "stopped"
_FATAL = "fatal"


@dataclass(frozen=True)
class RuntimeConfig:
    """Validated runtime rates and bounded resource limits.

    The accumulator in ``SceneEngineRuntime`` provides an exact rational
    schedule when the two integer rates do not divide evenly.
    """

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
            raise ConfigurationError(
                "strict_authority_presentation must be a boolean"
            )
        if self.strict_authority_presentation and (
            self.display_frames_per_second != self.ticks_per_second
        ):
            raise ConfigurationError(
                "strict_authority_presentation requires one display frame per tick"
            )


@dataclass(frozen=True)
class AuthorityCommitRequest:
    """One post-step authority commit at an already committed global tick."""

    simulation: GameSimulation
    context: TickContext


class AuthorityCommitCallback(Protocol):
    """Materialize authority/projection state for one committed tick."""

    def __call__(self, request: AuthorityCommitRequest) -> Any:
        ...


@dataclass(frozen=True)
class PresentationExportRequest:
    """Metadata supplied to one binary-neutral presentation export attempt."""

    simulation: GameSimulation
    scene_epoch: int
    bootstrap_id: int
    source_tick: Tick
    frame_seq: int
    ticks_per_second: int
    maximum_frame_nodes: int
    maximum_frame_bytes: int
    authority_commit: Any = None


class FrameExportCallback(Protocol):
    """End-to-end presentation exporter invoked on a scheduled sample."""

    def __call__(self, request: PresentationExportRequest) -> Any:
        ...


@dataclass(frozen=True)
class PumpResult:
    """Work completed by one call to :meth:`SceneEngineRuntime.pump`."""

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
    """Immutable diagnostic snapshot; it never grants mutation authority."""

    state: str
    current_tick: Tick
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
    """Drive exactly one gameplay ``step`` for each committed integer tick.

    ``frame_export(request)`` is the sole presentation projection port. The
    adapter owns V3 encoding and publication; the runtime owns only scheduling
    and the commit/failure boundary.

    Display failures are isolated from gameplay.  A gameplay exception is not:
    it permanently marks the runtime fatal and the failed tick is never
    committed or retried.
    """

    def __init__(
        self,
        simulation: GameSimulation,
        *,
        config: Optional[RuntimeConfig] = None,
        clock: Optional[MonotonicClock] = None,
        frame_export: Optional[FrameExportCallback] = None,
        authority_commit: Optional[AuthorityCommitCallback] = None,
        scene_epoch: int = 1,
        bootstrap_id: int = 1,
        initial_tick: Tick = 0,
    ) -> None:
        if simulation is None:
            raise ConfigurationError("simulation is required")
        _require_positive_int("scene_epoch", scene_epoch)
        _require_positive_int("bootstrap_id", bootstrap_id)
        _require_non_negative_int("initial_tick", initial_tick)

        self._simulation = simulation
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
        self._initial_tick = initial_tick
        self._current_tick = initial_tick

        origin = self._read_clock()
        self._clock_origin = origin
        self._last_clock_seconds = origin

        # This is a Bresenham-style rational-rate accumulator.  Seeding it from
        # initial_tick preserves the global schedule when resuming at a tick.
        self._display_phase = (
            initial_tick * self._config.display_frames_per_second
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
            return RuntimeHealth(
                state=self._status,
                current_tick=self._current_tick,
                ticks_attempted=self._ticks_attempted,
                ticks_committed=self._ticks_committed,
                authority_commits_attempted=self._authority_commits_attempted,
                authority_commits_succeeded=self._authority_commits_succeeded,
                display_samples_attempted=self._display_samples_attempted,
                display_samples_succeeded=self._display_samples_succeeded,
                display_samples_failed=self._display_samples_failed,
                consecutive_display_export_failures=(
                    self._consecutive_display_export_failures
                ),
                last_successful_frame_seq=self._last_successful_frame_seq,
                presentation_epoch_valid=self._presentation_epoch_valid,
                fatal_tick=self._fatal_tick,
                fatal_cause=self._fatal_cause,
                last_display_export_error=self._last_display_export_error,
                last_authority_commit_error=self._last_authority_commit_error,
            )

    def pump(self) -> PumpResult:
        """Run overdue ticks in order, bounded by ``maximum_ticks_per_pump``."""

        with _non_reentrant_pump(self._pump_lock):
            with self._state_lock:
                self._require_running()

            now = self._read_clock()
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
            # A tiny absolute tolerance absorbs float error at an exact manual
            # boundary without accumulating a second time base.
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
                ticks_attempted += 1

                context = TickContext(
                    tick=tick,
                    ticks_per_second=self._config.ticks_per_second,
                    elapsed_ticks=1,
                )
                try:
                    self._simulation.step(context)
                except BaseException as exc:
                    with self._state_lock:
                        self._active_tick = None
                        self._status = _FATAL
                        self._fatal_tick = tick
                        self._fatal_cause = exc
                    if not isinstance(exc, Exception):
                        # Preserve process-level signals such as KeyboardInterrupt
                        # and SystemExit while still making a retry impossible.
                        raise
                    raise SimulationFatalError(
                        "gameplay raised while executing tick {}".format(tick)
                    ) from exc

                with self._state_lock:
                    # A normal return is the sole commit point.  The runtime
                    # never reads or writes a gameplay-owned world.tick field.
                    self._current_tick = tick
                    self._ticks_committed += 1
                    self._display_phase += (
                        self._config.display_frames_per_second
                    )
                    sample_is_due = (
                        self._display_phase >= self._config.ticks_per_second
                    )
                    if sample_is_due:
                        self._display_phase -= self._config.ticks_per_second
                    status_after_step = self._status
                ticks_committed += 1

                authority_result = None
                if self._authority_commit is not None:
                    authority_commits_attempted += 1
                    authority_result = self._attempt_authority_commit(
                        AuthorityCommitRequest(
                            simulation=self._simulation,
                            context=context,
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
                        if self._attempt_display_export(tick, authority_result):
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

    def stop(self) -> None:
        """Permanently stop future ticks; repeated calls are harmless."""

        with self._state_lock:
            if self._status == _FATAL:
                return
            if self._status == _STOPPED:
                return
            self._status = _STOPPED

    def activate_presentation_epoch(
        self, *, scene_epoch: int, bootstrap_id: int
    ) -> None:
        """Activate a newly bootstrapped epoch after a presentation failure."""

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

    def export_committed_state(self, authority_commit: Any) -> Any:
        """Export one extra complete frame at the current committed tick.

        A successful same-tick authority projection crosses this port after
        its commit. It advances ``frame_seq`` but never the global tick.
        """

        with self._pump_lock:
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
            if not self._attempt_display_export(source_tick, authority_commit):
                raise PresentationExportError(
                    "same-tick committed state export invalidated presentation epoch"
                )
            return self.last_exported_frame

    @property
    def _has_export_strategy(self) -> bool:
        return self._frame_export is not None

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
                "authority commit failed after tick {} committed".format(
                    request.context.tick
                )
            ) from exc
        with self._state_lock:
            self._authority_commits_succeeded += 1
            self._last_authority_commit = result
        return result

    def _attempt_display_export(
        self, source_tick: Tick, authority_commit: Any = None
    ) -> bool:
        with self._state_lock:
            frame_seq = self._last_successful_frame_seq + 1
            self._display_samples_attempted += 1

        request = PresentationExportRequest(
            simulation=self._simulation,
            scene_epoch=self._scene_epoch,
            bootstrap_id=self._bootstrap_id,
            source_tick=source_tick,
            frame_seq=frame_seq,
            ticks_per_second=self._config.ticks_per_second,
            maximum_frame_nodes=self._config.maximum_frame_nodes,
            maximum_frame_bytes=self._config.maximum_frame_bytes,
            authority_commit=authority_commit,
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
                message += " at tick {}".format(tick)
            raise SimulationFatalError(message) from self._fatal_cause
        if self._status == _STOPPED:
            raise RuntimeStoppedError("runtime has been stopped")


def _require_positive_int(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ConfigurationError("{} must be a positive integer".format(name))


def _require_non_negative_int(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ConfigurationError("{} must be a non-negative integer".format(name))


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
    "FrameExportCallback",
    "PresentationExportRequest",
    "PumpResult",
    "RuntimeConfig",
    "RuntimeHealth",
    "SceneEngineRuntime",
]
