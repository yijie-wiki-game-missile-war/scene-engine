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


class DisplayFrameError(SceneEngineError, ValueError):
    """A display frame violates the local binary/profile contract."""


class DisplayExportError(DisplayFrameError):
    """Gameplay could not export a complete display sample."""


class SceneBootstrapError(SceneEngineError, ValueError):
    """A SceneBootstrap violates the ordered presentation profile."""


class PresentationFrameError(DisplayFrameError):
    """A schema-V2 presentation frame is malformed or non-canonical."""


class PresentationControlError(SceneEngineError, ValueError):
    """A presentation control/correlation envelope is invalid."""


class PresentationTransportError(SceneEngineError, RuntimeError):
    """An ordered presentation session violated flow-control state."""


class PresentationBackpressureError(PresentationTransportError):
    """A viewer queue reached a hard frame or byte limit."""


class PresentationArchiveError(SceneEngineError, RuntimeError):
    """A presentation archive stream or identity is invalid."""


class MailboxError(SceneEngineError, RuntimeError):
    """A latest-frame mailbox ownership rule was violated."""


class PacketError(SceneEngineError, ValueError):
    """A transport packet is malformed or unsupported."""


class ConsumerError(SceneEngineError, ValueError):
    """A complete-frame consumer rejected an otherwise decoded frame."""
