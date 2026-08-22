"""Public exception hierarchy for the scene engine."""


class SceneEngineError(Exception):
    """Base class for engine failures."""


class ConfigurationError(SceneEngineError, ValueError):
    """Runtime or resource limits are invalid."""


class RuntimeStoppedError(SceneEngineError, RuntimeError):
    """An operation requires a running runtime."""


class RuntimeBusyError(SceneEngineError, RuntimeError):
    """A caller attempted to enter pump while another pump was active."""


class CommandQueueFullError(SceneEngineError, RuntimeError):
    """The bounded command queue cannot accept another intent."""


class SimulationFatalError(SceneEngineError, RuntimeError):
    """Gameplay raised from a tick and the runtime became permanently fatal."""


class AuthorityCommitFatalError(SimulationFatalError):
    """Mandatory authority publication failed after gameplay committed a tick."""


class PresentationExportError(SceneEngineError, RuntimeError):
    """An adapter could not export a complete presentation sample."""


class SceneBootstrapError(SceneEngineError, ValueError):
    """A SceneBootstrap violates the ordered presentation profile."""


class PresentationTreeError(SceneEngineError, ValueError):
    """A V3 parent/local presentation tree is invalid."""


class PresentationFrameError(SceneEngineError, ValueError):
    """A schema-V3 presentation frame is malformed or non-canonical."""


class PresentationControlError(SceneEngineError, ValueError):
    """A presentation control/correlation envelope is invalid."""


class PresentationTransportError(SceneEngineError, RuntimeError):
    """An ordered presentation session violated flow-control state."""


class PresentationBackpressureError(PresentationTransportError):
    """A viewer queue reached a hard frame or byte limit."""


class PresentationArchiveError(SceneEngineError, RuntimeError):
    """A presentation archive stream or identity is invalid."""


class PacketError(SceneEngineError, ValueError):
    """A transport packet is malformed or unsupported."""
