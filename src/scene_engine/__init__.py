"""Scene Engine generic runtime and presentation platform.

Production consumers use the opaque-cursor V2 control/session, Archive V2,
Bootstrap V2, complete frames, and fixed-step runtime exported here.  The
latest-frame mailbox and legacy host are deliberately isolated under
``scene_engine.experimental``.
"""

from .authority_cursor import (
    AuthorityCursorCodec,
    AuthorityCursorEnvelope,
    envelope_cursor,
    validate_envelope_with_codec,
)
from .clock import ManualClock, MonotonicClock, SystemMonotonicClock
from .errors import (
    AuthorityCommitFatalError,
    ConfigurationError,
    DisplayExportError,
    PacketError,
    PresentationArchiveError,
    PresentationBackpressureError,
    PresentationControlError,
    PresentationFrameError,
    PresentationTransportError,
    RuntimeBusyError,
    RuntimeStoppedError,
    SceneBootstrapError,
    SceneEngineError,
    SimulationFatalError,
)
from .identity import DisplayIdentityTracker
from .packet_codec import (
    PacketHeaderV1,
    PacketView,
    decode_display_frame_packet,
    decode_presentation_frame_packet,
    decode_scene_bootstrap_packet,
    decode_scene_bootstrap_v2_packet,
    encode_display_frame_packet,
    encode_scene_bootstrap_packet,
    parse_packet,
)
from .presentation_archive import (
    PRESENTATION_ARCHIVE_INDEX,
    PRESENTATION_ARCHIVE_MANIFEST,
    PRESENTATION_ARCHIVE_SCHEMA_IDENTITY,
    PRESENTATION_ARCHIVE_SEGMENTS,
    PresentationArchiveLimits,
    PresentationArchiveWriter,
)
from .presentation_control_v2 import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    SCENE_PRESENTATION_CONTROL_PROTOCOL,
    SCENE_PRESENTATION_CONTROL_SCHEMA_VERSION,
    cursor_envelope_from_json,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
    parse_presentation_control_v2,
    validate_presentation_control_v2,
)
from .presentation_frame import (
    InteractionMappingV1,
    InteractionRecordV1,
    OwnerStateRecordV1,
    OwnerStateV1,
    PresentationEntityRecordV2,
    PresentationEntityV2,
    PresentationEventV1,
    PresentationFrameHeaderV2,
    PresentationFrameView,
    SealedPresentationFrame,
    encode_presentation_frame,
    parse_presentation_frame,
)
from .presentation_session import (
    OrderedPresentationSession,
    PresentationFramePacket,
    PresentationSessionLimits,
    PresentationTransmission,
)
from .runtime import (
    AuthorityCommitCallback,
    AuthorityCommitRequest,
    DisplayExportRequest,
    PumpResult,
    RuntimeConfig,
    RuntimeHealth,
    SceneEngineRuntime,
)
from .scene_bootstrap import (
    AdjacencyRecordV1,
    AnimationRegistryRecordV1,
    BootstrapIdentityV1,
    SceneBootstrapHeaderV1,
    SceneBootstrapView,
    StaticNodeRecordV1,
    TopologyNodeRecordV1,
    VisualRegistryRecordV1,
    encode_scene_bootstrap,
    parse_scene_bootstrap,
)
from .scene_bootstrap_v2 import (
    EngineSessionIdentityV2,
    SceneBootstrapV2View,
    encode_scene_bootstrap_v2,
    parse_scene_bootstrap_v2,
)
from .types import DisplayPose, GameSimulation, TickContext

__all__ = [name for name in globals() if not name.startswith("_")]
