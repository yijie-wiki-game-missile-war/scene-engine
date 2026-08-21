"""Renderer-neutral public types and gameplay ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, Tuple


Tick = int
FrameSeq = int
DisplayEntityId = int
VisualTypeId = int


@dataclass(frozen=True)
class TickContext:
    tick: Tick
    ticks_per_second: int
    elapsed_ticks: int = 1


@dataclass(frozen=True)
class DisplayPose:
    """Absolute renderer-neutral world pose at a completed source tick."""

    position: Tuple[float, float, float]
    rotation_xyzw: Tuple[float, float, float, float]
    scale: Tuple[float, float, float]


class DisplayFrameWriterPort(Protocol):
    @property
    def source_tick(self) -> Tick:
        ...

    @property
    def frame_seq(self) -> FrameSeq:
        ...

    def add_entity(
        self,
        *,
        display_id: DisplayEntityId,
        visual_type_id: VisualTypeId,
        pose: DisplayPose,
        flags: int = 0,
        animation_state_id: int = 0,
        animation_start_tick: Tick = 0,
        animation_flags: int = 0,
    ) -> None:
        ...


class GameSimulation(Protocol):
    def step(
        self,
        context: TickContext,
        commands: Tuple[Any, ...],
    ) -> None:
        """Normal return commits the tick; an escaping exception is fatal."""

    def write_display_frame(self, writer: DisplayFrameWriterPort) -> None:
        """Write the complete dynamic display set after a committed tick."""
