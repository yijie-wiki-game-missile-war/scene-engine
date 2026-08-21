"""Clock ports used by the engine-owned fixed-tick runtime.

The runtime only reads a monotonic value expressed in seconds.  Keeping the
port this small makes deterministic tests possible without teaching gameplay
about wall-clock time.
"""

from __future__ import annotations

import math
import threading
import time
from numbers import Real
from typing import Protocol


class MonotonicClock(Protocol):
    """A monotonic seconds source."""

    def now(self) -> float:
        ...


class SystemMonotonicClock:
    """Production clock backed by :func:`time.monotonic`."""

    def now(self) -> float:
        return time.monotonic()


class ManualClock:
    """Thread-safe monotonic clock advanced explicitly by a caller.

    ``advance`` accepts zero so tests may pump repeatedly at the same instant,
    but neither ``advance`` nor ``set`` permits time to move backwards.
    """

    def __init__(self, initial_seconds: float = 0.0) -> None:
        self._lock = threading.Lock()
        self._seconds = _finite_seconds(initial_seconds, "initial_seconds")

    def now(self) -> float:
        with self._lock:
            return self._seconds

    @property
    def seconds(self) -> float:
        return self.now()

    def advance(self, seconds: float) -> float:
        delta = _finite_seconds(seconds, "seconds")
        if delta < 0.0:
            raise ValueError("seconds must be non-negative")
        with self._lock:
            updated = self._seconds + delta
            if not math.isfinite(updated):
                raise ValueError("manual clock value must remain finite")
            self._seconds = updated
            return self._seconds

    def set(self, seconds: float) -> None:
        value = _finite_seconds(seconds, "seconds")
        with self._lock:
            if value < self._seconds:
                raise ValueError("a monotonic clock cannot move backwards")
            self._seconds = value


def _finite_seconds(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError("{} must be a real number".format(name))
    converted = float(value)
    if not math.isfinite(converted):
        raise ValueError("{} must be finite".format(name))
    return converted
