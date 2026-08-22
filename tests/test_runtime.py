from __future__ import annotations

import inspect
from typing import Any, List, Tuple

import pytest

from scene_engine.clock import ManualClock, SystemMonotonicClock
from scene_engine.errors import (
    AuthorityCommitFatalError,
    CommandQueueFullError,
    ConfigurationError,
    RuntimeBusyError,
    RuntimeStoppedError,
    SimulationFatalError,
)
from scene_engine.runtime import RuntimeConfig, SceneEngineRuntime
from scene_engine.types import TickContext


class RecordingSimulation:
    def __init__(self) -> None:
        self.steps: List[Tuple[TickContext, Tuple[Any, ...]]] = []

    def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
        self.steps.append((context, commands))

def config(**changes: Any) -> RuntimeConfig:
    values = dict(
        ticks_per_second=60,
        display_frames_per_second=30,
        maximum_ticks_per_pump=120,
        maximum_frame_nodes=100,
        maximum_frame_bytes=64_000,
        maximum_pending_commands=128,
        strict_authority_presentation=False,
    )
    values.update(changes)
    return RuntimeConfig(**values)


def test_manual_and_system_clocks_expose_monotonic_seconds() -> None:
    manual = ManualClock(2.0)
    assert manual.now() == 2.0
    assert manual.advance(0.25) == 2.25
    manual.set(3.0)
    assert manual.seconds == 3.0
    with pytest.raises(ValueError):
        manual.advance(-0.1)
    with pytest.raises(ValueError):
        manual.set(2.0)

    system = SystemMonotonicClock()
    assert system.now() <= system.now()


@pytest.mark.parametrize(
    "changes",
    [
        {"ticks_per_second": 0},
        {"display_frames_per_second": 0},
        {"display_frames_per_second": 61},
        {"maximum_ticks_per_pump": -1},
        {"maximum_frame_nodes": 0},
        {"maximum_frame_bytes": 0},
        {"maximum_pending_commands": 0},
        {"ticks_per_second": True},
        {"ticks_per_second": 60.0},
    ],
)
def test_runtime_config_rejects_invalid_or_non_integral_limits(changes: Any) -> None:
    with pytest.raises(ConfigurationError):
        config(**changes)


def test_removed_v1_writer_ports_are_not_runtime_fallbacks() -> None:
    parameters = inspect.signature(SceneEngineRuntime.__init__).parameters
    assert "writer_factory" not in parameters
    assert "frame_sink" not in parameters
    assert "maximum_frame_entities" not in RuntimeConfig.__dataclass_fields__
    assert "maximum_outstanding_leases" not in RuntimeConfig.__dataclass_fields__


def test_strict_authority_presentation_requires_exact_ports_and_rates() -> None:
    with pytest.raises(ConfigurationError, match="one display frame per tick"):
        config(strict_authority_presentation=True)
    with pytest.raises(ConfigurationError, match="authority_commit"):
        SceneEngineRuntime(
            RecordingSimulation(),
            config=config(
                display_frames_per_second=60,
                strict_authority_presentation=True,
            ),
            frame_export=lambda request: {"frame_seq": request.frame_seq},
        )
    with pytest.raises(ConfigurationError, match="frame_export"):
        SceneEngineRuntime(
            RecordingSimulation(),
            config=config(
                display_frames_per_second=60,
                strict_authority_presentation=True,
            ),
            authority_commit=lambda request: {"projection_id": request.context.tick},
        )


def test_one_manual_second_executes_exactly_sixty_ordered_steps() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    runtime = SceneEngineRuntime(simulation, config=config(), clock=clock)

    clock.advance(1.0)
    result = runtime.pump()

    assert [context.tick for context, _ in simulation.steps] == list(range(1, 61))
    assert all(context.ticks_per_second == 60 for context, _ in simulation.steps)
    assert all(context.elapsed_ticks == 1 for context, _ in simulation.steps)
    assert result.ticks_committed == 60
    assert result.caught_up
    assert runtime.current_tick == 60


def test_catch_up_is_bounded_but_never_skips_overdue_ticks() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    runtime = SceneEngineRuntime(
        simulation,
        config=config(maximum_ticks_per_pump=4),
        clock=clock,
    )

    clock.advance(10.0 / 60.0)
    first = runtime.pump()
    second = runtime.pump()
    third = runtime.pump()

    assert first.ticks_committed == 4
    assert first.ticks_remaining == 6
    assert second.ticks_committed == 4
    assert third.ticks_committed == 2
    assert [context.tick for context, _ in simulation.steps] == list(range(1, 11))


def test_commands_are_assigned_and_frozen_at_explicit_tick_boundaries() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    runtime: SceneEngineRuntime

    class EnqueueDuringStep(RecordingSimulation):
        def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
            super().step(context, commands)
            if context.tick == 1:
                assert runtime.enqueue_command("during-step") == 2

    simulation = EnqueueDuringStep()
    runtime = SceneEngineRuntime(simulation, config=config(), clock=clock)
    assert runtime.enqueue_command("a") == 1
    assert runtime.enqueue_command("b") == 1

    clock.advance(2.0 / 60.0)
    runtime.pump()

    assert simulation.steps[0][1] == ("a", "b")
    assert isinstance(simulation.steps[0][1], tuple)
    assert simulation.steps[1][1] == ("during-step",)


def test_command_queue_is_bounded_until_the_assigned_tick_starts() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    runtime = SceneEngineRuntime(
        simulation,
        config=config(maximum_pending_commands=2),
        clock=clock,
    )
    runtime.enqueue_command("a")
    runtime.enqueue_command("b")

    with pytest.raises(CommandQueueFullError, match="maximum_pending_commands"):
        runtime.enqueue_command("overflow")

    assert runtime.health.pending_commands == 2
    clock.advance(1.0 / 60.0)
    runtime.pump()
    assert simulation.steps[0][1] == ("a", "b")
    assert runtime.health.pending_commands == 0


def test_gameplay_exception_is_fatal_and_failed_tick_is_never_committed_or_retried() -> None:
    clock = ManualClock()

    class FailingSimulation(RecordingSimulation):
        def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
            super().step(context, commands)
            if context.tick == 2:
                raise LookupError("broken world")

    simulation = FailingSimulation()
    exported_ticks: List[int] = []
    runtime = SceneEngineRuntime(
        simulation,
        config=config(display_frames_per_second=60),
        clock=clock,
        frame_export=lambda request: exported_ticks.append(request.source_tick),
    )
    clock.advance(3.0 / 60.0)

    with pytest.raises(SimulationFatalError) as raised:
        runtime.pump()

    assert isinstance(raised.value.__cause__, LookupError)
    assert runtime.current_tick == 1
    assert [context.tick for context, _ in simulation.steps] == [1, 2]
    assert exported_ticks == [1]
    assert runtime.health.fatal
    assert runtime.health.fatal_tick == 2

    with pytest.raises(SimulationFatalError):
        runtime.pump()
    assert [context.tick for context, _ in simulation.steps] == [1, 2]


def test_non_exception_escape_is_still_fatal_and_cannot_retry_the_tick() -> None:
    clock = ManualClock()

    class ProcessSignal(BaseException):
        pass

    class SignallingSimulation(RecordingSimulation):
        def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
            super().step(context, commands)
            raise ProcessSignal("stop now")

    simulation = SignallingSimulation()
    runtime = SceneEngineRuntime(simulation, config=config(), clock=clock)
    clock.advance(1.0 / 60.0)

    with pytest.raises(ProcessSignal):
        runtime.pump()

    assert runtime.current_tick == 0
    assert runtime.health.fatal
    assert runtime.health.fatal_tick == 1
    with pytest.raises(SimulationFatalError):
        runtime.pump()
    assert len(simulation.steps) == 1


def test_rational_display_schedule_attempts_thirty_samples_over_sixty_ticks() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    samples: List[Tuple[int, int]] = []
    runtime = SceneEngineRuntime(
        simulation,
        config=config(display_frames_per_second=30),
        clock=clock,
        frame_export=lambda request: samples.append(
            (request.frame_seq, request.source_tick)
        ),
    )

    clock.advance(1.0)
    result = runtime.pump()

    assert len(simulation.steps) == 60
    assert samples == [(seq, seq * 2) for seq in range(1, 31)]
    assert result.display_samples_attempted == 30
    assert result.display_samples_succeeded == 30
    assert runtime.health.last_successful_frame_seq == 30


def test_non_divisible_display_rate_uses_exact_rational_accumulator() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    samples: List[int] = []
    runtime = SceneEngineRuntime(
        simulation,
        config=config(display_frames_per_second=20),
        clock=clock,
        frame_export=lambda request: samples.append(request.source_tick),
    )

    clock.advance(1.0)
    runtime.pump()

    assert samples == list(range(3, 61, 3))


def test_display_export_failure_skips_one_sample_then_recovers_without_stopping_gameplay() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    attempts: List[Tuple[int, int]] = []

    def exporter(request: Any) -> None:
        attempts.append((request.frame_seq, request.source_tick))
        if len(attempts) == 1:
            raise ValueError("encoder unavailable")

    runtime = SceneEngineRuntime(
        simulation,
        config=config(display_frames_per_second=30),
        clock=clock,
        frame_export=exporter,
    )
    clock.advance(4.0 / 60.0)
    result = runtime.pump()

    assert [context.tick for context, _ in simulation.steps] == [1, 2, 3, 4]
    assert attempts == [(1, 2), (1, 4)]
    assert result.display_samples_failed == 1
    assert result.display_samples_succeeded == 1
    assert runtime.current_tick == 4
    assert runtime.health.running
    assert runtime.health.display_samples_failed == 1
    assert runtime.health.consecutive_display_export_failures == 0
    assert runtime.health.last_successful_frame_seq == 1


def test_display_or_renderer_activity_never_advances_gameplay_time() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    render_samples: List[int] = []
    runtime = SceneEngineRuntime(
        simulation,
        config=config(),
        clock=clock,
        frame_export=lambda request: render_samples.append(request.source_tick),
    )

    for _ in range(100):
        result = runtime.pump()
        assert result.ticks_committed == 0
    assert runtime.current_tick == 0
    assert render_samples == []

    clock.advance(1.0 / 60.0)
    runtime.pump()
    assert runtime.current_tick == 1
    assert render_samples == []  # 30 FPS sample is not due until tick 2.


def test_strict_profile_commits_authority_before_every_display_frame() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    order: List[Tuple[str, int, Any]] = []

    def commit(request: Any) -> dict[str, int]:
        result = {"projection_id": request.context.tick}
        order.append(("authority", request.context.tick, result))
        return result

    def export(request: Any) -> Any:
        order.append(("display", request.source_tick, request.authority_commit))
        return {"frame_seq": request.frame_seq}

    runtime = SceneEngineRuntime(
        simulation,
        config=config(
            display_frames_per_second=60,
            strict_authority_presentation=True,
        ),
        clock=clock,
        authority_commit=commit,
        frame_export=export,
    )
    clock.advance(2.0 / 60.0)

    result = runtime.pump()

    assert order == [
        ("authority", 1, {"projection_id": 1}),
        ("display", 1, {"projection_id": 1}),
        ("authority", 2, {"projection_id": 2}),
        ("display", 2, {"projection_id": 2}),
    ]
    assert result.authority_commits_attempted == 2
    assert result.authority_commits_succeeded == 2
    assert runtime.health.presentation_epoch_valid


def test_strict_profile_emits_sixty_authority_and_display_commits_per_second() -> None:
    clock = ManualClock()
    authority_ticks: List[int] = []
    display_ticks: List[int] = []
    runtime = SceneEngineRuntime(
        RecordingSimulation(),
        config=config(
            display_frames_per_second=60,
            strict_authority_presentation=True,
        ),
        clock=clock,
        authority_commit=lambda request: (
            authority_ticks.append(request.context.tick)
            or {"projection_id": request.context.tick}
        ),
        frame_export=lambda request: (
            display_ticks.append(request.source_tick)
            or {"frame_seq": request.frame_seq}
        ),
    )
    clock.advance(1.0)

    result = runtime.pump()

    assert authority_ticks == list(range(1, 61))
    assert display_ticks == list(range(1, 61))
    assert result.authority_commits_succeeded == 60
    assert result.display_samples_succeeded == 60


def test_same_tick_external_commit_advances_frame_sequence_not_tick() -> None:
    clock = ManualClock()
    exported: List[Any] = []
    runtime = SceneEngineRuntime(
        RecordingSimulation(),
        config=config(
            display_frames_per_second=60,
            strict_authority_presentation=True,
        ),
        clock=clock,
        authority_commit=lambda request: {"projection_id": request.context.tick},
        frame_export=lambda request: exported.append(request) or {
            "frame_seq": request.frame_seq,
            "source_tick": request.source_tick,
        },
    )

    clock.advance(1.0 / 60.0)
    runtime.pump()
    extra = runtime.export_committed_state({"projection_id": "command:1"})

    assert runtime.current_tick == 1
    assert [item.frame_seq for item in exported] == [1, 2]
    assert [item.source_tick for item in exported] == [1, 1]
    assert extra == {"frame_seq": 2, "source_tick": 1}


def test_strict_authority_failure_is_fatal_after_committed_tick() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()

    def commit(request: Any) -> dict[str, int]:
        if request.context.tick == 2:
            raise LookupError("v5 unavailable")
        return {"projection_id": request.context.tick}

    runtime = SceneEngineRuntime(
        simulation,
        config=config(
            display_frames_per_second=60,
            strict_authority_presentation=True,
        ),
        clock=clock,
        authority_commit=commit,
        frame_export=lambda request: {"frame_seq": request.frame_seq},
    )
    clock.advance(3.0 / 60.0)

    with pytest.raises(AuthorityCommitFatalError) as raised:
        runtime.pump()

    assert isinstance(raised.value.__cause__, LookupError)
    assert runtime.current_tick == 2
    assert runtime.health.ticks_committed == 2
    assert runtime.health.authority_commits_succeeded == 1
    assert runtime.health.fatal_tick == 2


def test_strict_display_gap_invalidates_epoch_until_new_bootstrap() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    attempts: List[Tuple[int, int]] = []

    def export(request: Any) -> Any:
        attempts.append((request.scene_epoch, request.source_tick))
        if request.scene_epoch == 1:
            raise ValueError("binary sink unavailable")
        return {"frame_seq": request.frame_seq}

    runtime = SceneEngineRuntime(
        simulation,
        config=config(
            display_frames_per_second=60,
            strict_authority_presentation=True,
        ),
        clock=clock,
        authority_commit=lambda request: {"projection_id": request.context.tick},
        frame_export=export,
    )
    clock.advance(2.0 / 60.0)
    result = runtime.pump()

    assert result.ticks_committed == 2
    assert attempts == [(1, 1)]
    assert not runtime.health.presentation_epoch_valid

    runtime.activate_presentation_epoch(scene_epoch=2, bootstrap_id=2)
    clock.advance(1.0 / 60.0)
    runtime.pump()
    assert attempts == [(1, 1), (2, 3)]
    assert runtime.health.last_successful_frame_seq == 1


def test_pump_is_non_reentrant_and_fails_fast_instead_of_deadlocking() -> None:
    clock = ManualClock()
    runtime: SceneEngineRuntime

    class ReentrantSimulation(RecordingSimulation):
        def step(self, context: TickContext, commands: Tuple[Any, ...]) -> None:
            with pytest.raises(RuntimeBusyError, match="already active"):
                runtime.pump()
            super().step(context, commands)

    simulation = ReentrantSimulation()
    runtime = SceneEngineRuntime(simulation, config=config(), clock=clock)
    clock.advance(1.0 / 60.0)

    result = runtime.pump()

    assert result.ticks_committed == 1
    assert runtime.current_tick == 1
    assert not runtime.health.fatal


def test_stop_is_idempotent_and_rejects_future_work() -> None:
    clock = ManualClock()
    simulation = RecordingSimulation()
    runtime = SceneEngineRuntime(simulation, config=config(), clock=clock)
    runtime.enqueue_command("discarded")

    runtime.stop()
    runtime.stop()
    clock.advance(1.0)

    assert runtime.health.stopped
    assert runtime.health.pending_commands == 0
    with pytest.raises(RuntimeStoppedError):
        runtime.pump()
    with pytest.raises(RuntimeStoppedError):
        runtime.enqueue_command("too late")
    assert simulation.steps == []
