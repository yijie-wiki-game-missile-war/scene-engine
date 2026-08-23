"""Public Scene Engine error hierarchy."""


class SceneEngineError(Exception):
    """Base class for deterministic Scene Engine failures."""


class ConfigurationError(SceneEngineError, ValueError):
    """Invalid static configuration or construction input."""


class RuntimeStateError(SceneEngineError, RuntimeError):
    """An operation is not valid in the runtime's current state."""


class RuntimeBusyError(RuntimeStateError):
    """A serialized runtime operation attempted to re-enter the runtime."""


class RuntimeFatalError(RuntimeStateError):
    """The authoritative runtime is permanently quarantined."""


class WireError(SceneEngineError, ValueError):
    """An Engine packet is malformed or violates a wire invariant."""


class JsonTreeError(SceneEngineError, ValueError):
    """A JSON snapshot or patch is malformed or cannot be applied."""


class SceneCodecError(SceneEngineError, ValueError):
    """A scene bootstrap or complete frame body is malformed."""


class SessionError(SceneEngineError, RuntimeError):
    """A client session violated ordering, ACK, or resource limits."""


class SessionBackpressureError(SessionError):
    """A session exceeded a configured pending or in-flight limit."""


class RecordingError(SceneEngineError, RuntimeError):
    """A packet log could not be written, verified, or sealed."""


__all__ = [
    "ConfigurationError",
    "JsonTreeError",
    "RecordingError",
    "RuntimeBusyError",
    "RuntimeFatalError",
    "RuntimeStateError",
    "SceneCodecError",
    "SceneEngineError",
    "SessionBackpressureError",
    "SessionError",
    "WireError",
]
