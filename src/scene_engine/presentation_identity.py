"""Monotonic display-ID allocation for one presentation scene epoch."""

from __future__ import annotations

from threading import Lock

from .binary_schema import UINT64_MAX
from .errors import ConfigurationError


class PresentationIdAllocator:
    """Allocate never-reused IDs without retaining retired-ID history."""

    def __init__(self, *, maximum_static_display_id: int = 0) -> None:
        if (
            isinstance(maximum_static_display_id, bool)
            or not isinstance(maximum_static_display_id, int)
            or not 0 <= maximum_static_display_id < UINT64_MAX
        ):
            raise ConfigurationError("maximum_static_display_id is out of range")
        self._lock = Lock()
        self._max_seen_display_id = maximum_static_display_id

    @property
    def max_seen_display_id(self) -> int:
        with self._lock:
            return self._max_seen_display_id

    @property
    def next_display_id(self) -> int:
        with self._lock:
            if self._max_seen_display_id == UINT64_MAX:
                raise ConfigurationError("presentation display ID space is exhausted")
            return self._max_seen_display_id + 1

    def allocate(self) -> int:
        with self._lock:
            if self._max_seen_display_id == UINT64_MAX:
                raise ConfigurationError("presentation display ID space is exhausted")
            self._max_seen_display_id += 1
            return self._max_seen_display_id

    def allocate_many(self, count: int) -> tuple[int, ...]:
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ConfigurationError("allocation count must be a non-negative integer")
        with self._lock:
            if count > UINT64_MAX - self._max_seen_display_id:
                raise ConfigurationError("presentation display ID space is exhausted")
            first = self._max_seen_display_id + 1
            self._max_seen_display_id += count
            return tuple(range(first, first + count))


__all__ = ["PresentationIdAllocator"]
