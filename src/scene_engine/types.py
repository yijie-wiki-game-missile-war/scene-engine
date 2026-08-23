"""Renderer-neutral public types and gameplay ports."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


Tick = int
FrameSeq = int


@dataclass(frozen=True, slots=True)
class TickContext:
    tick: Tick
    ticks_per_second: int
    elapsed_ticks: int = 1


class GameSimulation(Protocol):
    """Legacy stateless simulation port.

    New integrations should prefer :class:`WorldProgram`, which lets the
    Engine own the authoritative mutable world while gameplay only borrows it
    during a call.
    """

    def step(self, context: TickContext) -> None:
        """Normal return commits the tick; an escaping exception is fatal."""


class WorldProgram(Protocol):
    """Gameplay rules executed against the Engine-owned authoritative world."""

    def step(self, world: Any, context: TickContext) -> Any:
        """Mutate the borrowed world for exactly ``context.tick``.

        The program must not retain ``world`` after this method returns and
        must not advance ``world.tick`` itself.  The return value is passed to
        the authority commit callback after the Engine has normalized the
        world revision.
        """
