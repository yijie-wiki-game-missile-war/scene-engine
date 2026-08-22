"""Scene Engine V3 runtime and presentation platform."""

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
    PacketError,
    PresentationArchiveError,
    PresentationBackpressureError,
    PresentationControlError,
    PresentationExportError,
    PresentationFrameError,
    PresentationTreeError,
    PresentationTransportError,
    RuntimeBusyError,
    RuntimeStoppedError,
    SceneBootstrapError,
    SceneEngineError,
    SimulationFatalError,
)
from .packet_codec import (
    PacketHeaderV1,
    PacketView,
    decode_presentation_frame_v3_packet,
    decode_scene_bootstrap_v3_packet,
    encode_packet,
    encode_presentation_frame_v3_packet,
    encode_scene_bootstrap_v3_packet,
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
from .presentation_identity import PresentationIdAllocator
from .presentation_tree_validation import (
    PresentationTreeValidationV3,
    PresentationWorldPoseV3,
    validate_presentation_frame_tree,
    validate_presentation_node_tree,
)
from .presentation_session import (
    DEFAULT_MAXIMUM_PRESENTATION_PACKET_BYTES,
    DEFAULT_MAXIMUM_PRESENTATION_PAYLOAD_BYTES,
    OrderedPresentationSession,
    PresentationFramePacket,
    PresentationResetRequired,
    PresentationResetRequiredError,
    PresentationSessionLimits,
    PresentationTransmission,
)
from .presentation_v3 import (
    AnimationStateRecordV3,
    EngineSessionIdentityV3,
    OpaquePayloadV3,
    PresentationEventV3,
    PresentationFrameHeaderV3,
    PresentationFrameV3View,
    PresentationNodeRecordV3,
    PresentationNodeV3,
    PresentationSectionEntryV3,
    SceneBootstrapHeaderV3,
    SceneBootstrapV3View,
    SceneMetadataV3,
    VisualTypeRecordV3,
    encode_presentation_frame_v3,
    encode_scene_bootstrap_v3,
    parse_presentation_frame_v3,
    parse_scene_bootstrap_v3,
)
from .runtime import (
    AuthorityCommitCallback,
    AuthorityCommitRequest,
    PresentationExportRequest,
    PumpResult,
    RuntimeConfig,
    RuntimeHealth,
    SceneEngineRuntime,
)
from .types import GameSimulation, TickContext

__all__ = [name for name in globals() if not name.startswith("_")]
