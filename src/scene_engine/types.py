"""Renderer-neutral public types and gameplay ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, Tuple


Tick = int
FrameSeq = int


@dataclass(frozen=True)
class TickContext:
    tick: Tick
    ticks_per_second: int
    elapsed_ticks: int = 1


class GameSimulation(Protocol):
    def step(
        self,
        context: TickContext,
        commands: Tuple[Any, ...],
    ) -> None:
        """Normal return commits the tick; an escaping exception is fatal."""
