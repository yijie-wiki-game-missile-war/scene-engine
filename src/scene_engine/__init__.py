"""Minimal convenience surface for the Scene Engine runtime."""

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
from .runtime import RuntimeConfig, SceneEngineRuntime

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
