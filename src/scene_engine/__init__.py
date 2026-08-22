"""Minimal convenience surface for the Scene Engine fixed-step runtime.

Protocol records and codecs live in their explicit semantic modules.  The
package root intentionally exposes only the common runtime and its errors.
"""

from .clock import ManualClock
from .errors import (
    AuthorityCommitFatalError,
    ConfigurationError,
    PresentationExportError,
    RuntimeBusyError,
    RuntimeStoppedError,
    SceneEngineError,
    SimulationFatalError,
)
from .runtime import (
    RuntimeConfig,
    SceneEngineRuntime,
)

__all__ = [
    "AuthorityCommitFatalError",
    "ConfigurationError",
    "ManualClock",
    "PresentationExportError",
    "RuntimeBusyError",
    "RuntimeConfig",
    "RuntimeStoppedError",
    "SceneEngineError",
    "SceneEngineRuntime",
    "SimulationFatalError",
]
