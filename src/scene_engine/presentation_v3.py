"""Canonical SceneBootstrapV3 and PresentationFrameV3 codecs."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
import struct
import unicodedata
from typing import Any, Iterable, Optional, Tuple

from .authority_cursor import AuthorityCursorEnvelope
from .binary_schema import UINT16_MAX, UINT32_MAX, UINT64_MAX
from .errors import (
    ConfigurationError,
    PresentationFrameError,
    PresentationTreeError,
    SceneBootstrapError,
)
from .presentation_schema import (
    ANIMATION_ALLOWED_FLAGS,
    ANIMATION_STATE_RECORD_BYTES,
    ANIMATION_STATE_RECORD_V3,
    BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V3,
    BOOTSTRAP_SECTION_ANIMATION_STATES,
    BOOTSTRAP_SECTION_AUTHORITY_BASELINE,
    BOOTSTRAP_SECTION_IDENTITY,
    BOOTSTRAP_SECTION_NODE_INTERACTION_BYTES,
    BOOTSTRAP_SECTION_NODE_INTERACTION_REFS,
    BOOTSTRAP_SECTION_NODE_PROFILE_BYTES,
    BOOTSTRAP_SECTION_NODE_PROFILE_REFS,
    BOOTSTRAP_SECTION_SCENE_METADATA_BYTES,
    BOOTSTRAP_SECTION_SCENE_METADATA_REFS,
    BOOTSTRAP_SECTION_STATIC_NODES,
    BOOTSTRAP_SECTION_VISUAL_TYPES,
    BOOTSTRAP_SESSION_IDENTITY_HEADER_V3,
    FRAME_SECTION_DYNAMIC_NODES,
    FRAME_SECTION_EVENTS,
    FRAME_SECTION_EVENT_BYTES,
    FRAME_SECTION_NODE_INTERACTION_BYTES,
    FRAME_SECTION_NODE_INTERACTION_REFS,
    FRAME_SECTION_NODE_PROFILE_BYTES,
    FRAME_SECTION_NODE_PROFILE_REFS,
    NODE_PAYLOAD_REF_BYTES,
    NODE_PAYLOAD_REF_V3,
    PRESENTATION_EVENT_ALLOWED_FLAGS,
    PRESENTATION_EVENT_RECORD_BYTES,
    PRESENTATION_EVENT_RECORD_V3,
    PRESENTATION_FRAME_FLAG_COMPLETE_DYNAMIC_SET,
    PRESENTATION_FRAME_HEADER_BYTES,
    PRESENTATION_FRAME_HEADER_V3,
    PRESENTATION_FRAME_SCHEMA_VERSION,
    PRESENTATION_NODE_ALLOWED_FLAGS,
    PRESENTATION_NODE_RECORD_BYTES,
    PRESENTATION_NODE_RECORD_V3,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_V3,
    PRESENTATION_SECTION_FLAG_REQUIRED,
    PRESENTATION_TICKS_PER_SECOND,
    SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
    SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET,
    SCENE_BOOTSTRAP_HEADER_BYTES,
    SCENE_BOOTSTRAP_HEADER_V3,
    SCENE_BOOTSTRAP_SCHEMA_VERSION,
    SCENE_METADATA_REF_BYTES,
    SCENE_METADATA_REF_V3,
    VISUAL_TYPE_ALLOWED_FLAGS,
    VISUAL_TYPE_RECORD_BYTES,
    VISUAL_TYPE_RECORD_V3,
)


_QUATERNION_TOLERANCE = 1e-3
_MAX_IDENTITY_UTF8_BYTES = 4096

_BOOTSTRAP_SECTION_TYPES = (
    BOOTSTRAP_SECTION_IDENTITY,
    BOOTSTRAP_SECTION_AUTHORITY_BASELINE,
    BOOTSTRAP_SECTION_STATIC_NODES,
    BOOTSTRAP_SECTION_NODE_PROFILE_REFS,
    BOOTSTRAP_SECTION_NODE_PROFILE_BYTES,
    BOOTSTRAP_SECTION_NODE_INTERACTION_REFS,
    BOOTSTRAP_SECTION_NODE_INTERACTION_BYTES,
    BOOTSTRAP_SECTION_SCENE_METADATA_REFS,
    BOOTSTRAP_SECTION_SCENE_METADATA_BYTES,
    BOOTSTRAP_SECTION_VISUAL_TYPES,
    BOOTSTRAP_SECTION_ANIMATION_STATES,
)
_BOOTSTRAP_STRIDES = (
    0,
    0,
    PRESENTATION_NODE_RECORD_BYTES,
    NODE_PAYLOAD_REF_BYTES,
    1,
    NODE_PAYLOAD_REF_BYTES,
    1,
    SCENE_METADATA_REF_BYTES,
    1,
    VISUAL_TYPE_RECORD_BYTES,
    ANIMATION_STATE_RECORD_BYTES,
)
_FRAME_SECTION_TYPES = (
    FRAME_SECTION_DYNAMIC_NODES,
    FRAME_SECTION_NODE_PROFILE_REFS,
    FRAME_SECTION_NODE_PROFILE_BYTES,
    FRAME_SECTION_NODE_INTERACTION_REFS,
    FRAME_SECTION_NODE_INTERACTION_BYTES,
    FRAME_SECTION_EVENTS,
    FRAME_SECTION_EVENT_BYTES,
)
_FRAME_STRIDES = (
    PRESENTATION_NODE_RECORD_BYTES,
    NODE_PAYLOAD_REF_BYTES,
    1,
    NODE_PAYLOAD_REF_BYTES,
    1,
    PRESENTATION_EVENT_RECORD_BYTES,
    1,
)


@dataclass(frozen=True)
class EngineSessionIdentityV3:
    run_id: str
    viewer_scope: str
    profile_id: str


@dataclass(frozen=True)
class OpaquePayloadV3:
    payload_type_id: int
    data: bytes
    flags: int = 0


@dataclass(frozen=True)
class SceneMetadataV3:
    metadata_type_id: int
    data: bytes
    flags: int = 0


@dataclass(frozen=True)
class VisualTypeRecordV3:
    visual_type_id: int
    flags: int = 0
    profile_type_id: int = 0
    interaction_type_id: int = 0


@dataclass(frozen=True)
class AnimationStateRecordV3:
    animation_state_id: int
    flags: int
    duration_ticks: int


@dataclass(frozen=True)
class PresentationNodeV3:
    display_id: int
    parent_display_id: int
    visual_type_id: int
    flags: int
    local_position: Tuple[float, float, float]
    local_rotation_xyzw: Tuple[float, float, float, float]
    local_scale: Tuple[float, float, float]
    animation_state_id: int = 0
    animation_start_tick: int = 0
    animation_flags: int = 0
    profile: Optional[OpaquePayloadV3] = None
    interaction: Optional[OpaquePayloadV3] = None


PresentationNodeRecordV3 = PresentationNodeV3


@dataclass(frozen=True)
class PresentationEventV3:
    event_id: int
    event_type_id: int
    flags: int
    source_display_id: int
    target_display_id: int
    start_tick: int
    payload: bytes = b""


@dataclass(frozen=True)
class PresentationSectionEntryV3:
    section_type: int
    flags: int
    record_count: int
    byte_offset: int
    byte_length: int
    record_stride: int
    reserved0: int


@dataclass(frozen=True)
class SceneBootstrapHeaderV3:
    schema_version: int
    flags: int
    header_bytes: int
    section_count: int
    scene_epoch: int
    bootstrap_id: int
    ticks_per_second: int
    coordinate_profile: int
    world_units_per_meter: float
    maximum_dynamic_nodes: int
    maximum_frame_bytes: int
    directory_bytes: int
    payload_bytes: int
    content_sha256: bytes
    reserved: bytes


@dataclass(frozen=True)
class SceneBootstrapV3View:
    header: SceneBootstrapHeaderV3
    identity: EngineSessionIdentityV3
    authority_baseline: AuthorityCursorEnvelope
    static_nodes: Tuple[PresentationNodeV3, ...]
    scene_metadata: Tuple[SceneMetadataV3, ...]
    visual_types: Tuple[VisualTypeRecordV3, ...]
    animation_states: Tuple[AnimationStateRecordV3, ...]
    directory: Tuple[PresentationSectionEntryV3, ...]
    data: bytes

    @property
    def scene_epoch(self) -> int:
        return self.header.scene_epoch

    @property
    def bootstrap_id(self) -> int:
        return self.header.bootstrap_id


@dataclass(frozen=True)
class PresentationFrameHeaderV3:
    schema_version: int
    flags: int
    header_bytes: int
    section_count: int
    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    projection_id: int
    ticks_per_second: int
    reserved0: int
    node_count: int
    profile_count: int
    interaction_count: int
    payload_bytes: int
    directory_bytes: int
    event_count: int
    reserved1: int


@dataclass(frozen=True)
class PresentationFrameV3View:
    header: PresentationFrameHeaderV3
    nodes: Tuple[PresentationNodeV3, ...]
    events: Tuple[PresentationEventV3, ...]
    directory: Tuple[PresentationSectionEntryV3, ...]
    data: bytes

    @property
    def frame_seq(self) -> int:
        return self.header.frame_seq

    @property
    def source_tick(self) -> int:
        return self.header.source_tick


def encode_scene_bootstrap_v3(
    *,
    scene_epoch: int,
    bootstrap_id: int,
    identity: EngineSessionIdentityV3,
    authority_baseline: AuthorityCursorEnvelope,
    maximum_dynamic_nodes: int,
    maximum_frame_bytes: int,
    static_nodes: Iterable[PresentationNodeV3] = (),
    scene_metadata: Iterable[SceneMetadataV3] = (),
    visual_types: Iterable[VisualTypeRecordV3] = (),
    animation_states: Iterable[AnimationStateRecordV3] = (),
    ticks_per_second: int = PRESENTATION_TICKS_PER_SECOND,
    coordinate_profile: int = SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
    world_units_per_meter: float = 1.0,
) -> bytes:
    epoch = _uint("scene_epoch", scene_epoch, UINT64_MAX, minimum=1)
    bootstrap = _uint("bootstrap_id", bootstrap_id, UINT64_MAX, minimum=1)
    if not isinstance(identity, EngineSessionIdentityV3):
        raise ConfigurationError("identity must be EngineSessionIdentityV3")
    if not isinstance(authority_baseline, AuthorityCursorEnvelope):
        raise ConfigurationError("authority_baseline must be AuthorityCursorEnvelope")
    _require_60_tps(ticks_per_second, ConfigurationError)
    _uint("coordinate_profile", coordinate_profile, UINT16_MAX, minimum=1)
    maximum_nodes = _uint("maximum_dynamic_nodes", maximum_dynamic_nodes, UINT32_MAX)
    maximum_bytes = _uint("maximum_frame_bytes", maximum_frame_bytes, UINT32_MAX, minimum=1)
    world_units = _finite_float("world_units_per_meter", world_units_per_meter, ConfigurationError)
    if world_units <= 0:
        raise ConfigurationError("world_units_per_meter must be positive")

    visuals = tuple(visual_types)
    animations = tuple(animation_states)
    nodes = tuple(static_nodes)
    metadata = tuple(scene_metadata)
    _validate_visual_types(visuals, ConfigurationError)
    _validate_animation_states(animations, ConfigurationError)
    _validate_nodes(
        nodes,
        visual_types=visuals,
        animation_states=animations,
        source_tick=None,
        error_type=ConfigurationError,
    )
    _validate_bootstrap_tree(nodes, ConfigurationError)
    _validate_metadata(metadata, ConfigurationError)
    if len(nodes) > UINT32_MAX:
        raise ConfigurationError("static node count exceeds uint32")

    identity_bytes = _encode_identity(identity)
    authority_bytes = _encode_authority_baseline(authority_baseline)
    node_bytes = _encode_nodes(nodes)
    profile_refs, profile_blob, profile_count = _encode_node_payloads(nodes, "profile")
    interaction_refs, interaction_blob, interaction_count = _encode_node_payloads(
        nodes, "interaction"
    )
    del profile_count, interaction_count
    metadata_refs, metadata_blob = _encode_metadata(metadata)
    visual_bytes = b"".join(
        VISUAL_TYPE_RECORD_V3.pack(
            item.visual_type_id,
            item.flags,
            item.profile_type_id,
            item.interaction_type_id,
        )
        for item in visuals
    )
    animation_bytes = b"".join(
        ANIMATION_STATE_RECORD_V3.pack(
            item.animation_state_id, item.flags, item.duration_ticks, 0
        )
        for item in animations
    )
    sections = (
        (1, 0, identity_bytes),
        (1, 0, authority_bytes),
        (len(nodes), PRESENTATION_NODE_RECORD_BYTES, node_bytes),
        (len(nodes), NODE_PAYLOAD_REF_BYTES, profile_refs),
        (len(profile_blob), 1, _pad4(profile_blob)),
        (len(nodes), NODE_PAYLOAD_REF_BYTES, interaction_refs),
        (len(interaction_blob), 1, _pad4(interaction_blob)),
        (len(metadata), SCENE_METADATA_REF_BYTES, metadata_refs),
        (len(metadata_blob), 1, _pad4(metadata_blob)),
        (len(visuals), VISUAL_TYPE_RECORD_BYTES, visual_bytes),
        (len(animations), ANIMATION_STATE_RECORD_BYTES, animation_bytes),
    )
    directory, payload = _encode_directory(
        SCENE_BOOTSTRAP_HEADER_BYTES,
        _BOOTSTRAP_SECTION_TYPES,
        sections,
    )
    header = SCENE_BOOTSTRAP_HEADER_V3.pack(
        SCENE_BOOTSTRAP_SCHEMA_VERSION,
        SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET,
        SCENE_BOOTSTRAP_HEADER_BYTES,
        len(sections),
        epoch,
        bootstrap,
        ticks_per_second,
        coordinate_profile,
        world_units,
        maximum_nodes,
        maximum_bytes,
        len(directory),
        len(payload),
        hashlib.sha256(directory + payload).digest(),
        b"\x00" * 16,
    )
    return header + directory + payload


def parse_scene_bootstrap_v3(
    data: Any,
    *,
    maximum_bootstrap_bytes: int = 64 * 1024 * 1024,
    maximum_static_nodes: int = 1_000_000,
    maximum_scene_metadata: int = 65_536,
    maximum_visual_types: int = 65_536,
    maximum_animation_states: int = 65_536,
) -> SceneBootstrapV3View:
    raw = _canonical_bytes(data, maximum_bootstrap_bytes, SceneBootstrapError)
    if len(raw) < SCENE_BOOTSTRAP_HEADER_BYTES:
        raise SceneBootstrapError("bootstrap header is truncated")
    header = SceneBootstrapHeaderV3(*SCENE_BOOTSTRAP_HEADER_V3.unpack_from(raw))
    if (
        header.schema_version != SCENE_BOOTSTRAP_SCHEMA_VERSION
        or header.flags != SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET
        or header.header_bytes != SCENE_BOOTSTRAP_HEADER_BYTES
        or header.section_count != len(_BOOTSTRAP_SECTION_TYPES)
        or header.scene_epoch == 0
        or header.bootstrap_id == 0
        or header.ticks_per_second != PRESENTATION_TICKS_PER_SECOND
        or header.coordinate_profile
        != SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32
        or not math.isfinite(header.world_units_per_meter)
        or header.world_units_per_meter <= 0
        or header.maximum_frame_bytes == 0
        or header.directory_bytes
        != len(_BOOTSTRAP_SECTION_TYPES) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
        or header.header_bytes + header.directory_bytes + header.payload_bytes != len(raw)
        or header.reserved != b"\x00" * 16
    ):
        raise SceneBootstrapError("bootstrap header is non-canonical")
    if hashlib.sha256(raw[header.header_bytes :]).digest() != header.content_sha256:
        raise SceneBootstrapError("bootstrap content_sha256 mismatch")
    entries = _parse_directory(
        raw,
        header_bytes=SCENE_BOOTSTRAP_HEADER_BYTES,
        section_types=_BOOTSTRAP_SECTION_TYPES,
        strides=_BOOTSTRAP_STRIDES,
        count_limits=(
            1,
            1,
            maximum_static_nodes,
            maximum_static_nodes,
            UINT32_MAX,
            maximum_static_nodes,
            UINT32_MAX,
            maximum_scene_metadata,
            UINT32_MAX,
            maximum_visual_types,
            maximum_animation_states,
        ),
        variable_sections=frozenset((0, 1, 4, 6, 8)),
        error_type=SceneBootstrapError,
    )
    identity = _parse_identity(_slice(raw, entries[0]), SceneBootstrapError)
    authority = _parse_authority_baseline(_slice(raw, entries[1]), SceneBootstrapError)
    visual_types = _parse_visual_types(raw, entries[9], SceneBootstrapError)
    animations = _parse_animation_states(raw, entries[10], SceneBootstrapError)
    nodes_without_payload = _parse_nodes(raw, entries[2], SceneBootstrapError)
    profiles = _parse_node_payloads(
        raw, entries[3], entries[4], nodes_without_payload, SceneBootstrapError
    )
    interactions = _parse_node_payloads(
        raw, entries[5], entries[6], nodes_without_payload, SceneBootstrapError
    )
    nodes = _attach_payloads(nodes_without_payload, profiles, interactions)
    metadata = _parse_metadata(raw, entries[7], entries[8], SceneBootstrapError)
    _validate_visual_types(visual_types, SceneBootstrapError)
    _validate_animation_states(animations, SceneBootstrapError)
    _validate_nodes(
        nodes,
        visual_types=visual_types,
        animation_states=animations,
        source_tick=None,
        error_type=SceneBootstrapError,
    )
    _validate_bootstrap_tree(nodes, SceneBootstrapError)
    _validate_metadata(metadata, SceneBootstrapError)
    return SceneBootstrapV3View(
        header,
        identity,
        authority,
        nodes,
        metadata,
        visual_types,
        animations,
        entries,
        raw,
    )


def encode_presentation_frame_v3(
    *,
    scene_epoch: int,
    bootstrap_id: int,
    frame_seq: int,
    source_tick: int,
    projection_id: int,
    nodes: Iterable[PresentationNodeV3],
    events: Iterable[PresentationEventV3] = (),
    ticks_per_second: int = PRESENTATION_TICKS_PER_SECOND,
) -> bytes:
    epoch = _uint("scene_epoch", scene_epoch, UINT64_MAX, minimum=1)
    bootstrap = _uint("bootstrap_id", bootstrap_id, UINT64_MAX, minimum=1)
    sequence = _uint("frame_seq", frame_seq, UINT64_MAX, minimum=1)
    tick = _uint("source_tick", source_tick, UINT64_MAX)
    projection = _uint("projection_id", projection_id, UINT64_MAX, minimum=1)
    _require_60_tps(ticks_per_second, ConfigurationError)
    node_values = tuple(nodes)
    event_values = tuple(events)
    (
        node_bytes,
        profile_refs,
        profile_blob,
        profile_count,
        interaction_refs,
        interaction_blob,
        interaction_count,
    ) = _validate_and_encode_frame_nodes(
        node_values,
        source_tick=tick,
        error_type=ConfigurationError,
    )
    _validate_events(event_values, tick, ConfigurationError)
    if len(node_values) > UINT32_MAX or len(event_values) > UINT32_MAX:
        raise ConfigurationError("frame count exceeds uint32")
    event_bytes, event_blob = _encode_events(event_values)
    sections = (
        (len(node_values), PRESENTATION_NODE_RECORD_BYTES, node_bytes),
        (len(node_values), NODE_PAYLOAD_REF_BYTES, profile_refs),
        (len(profile_blob), 1, _pad4(profile_blob)),
        (len(node_values), NODE_PAYLOAD_REF_BYTES, interaction_refs),
        (len(interaction_blob), 1, _pad4(interaction_blob)),
        (len(event_values), PRESENTATION_EVENT_RECORD_BYTES, event_bytes),
        (len(event_blob), 1, _pad4(event_blob)),
    )
    directory, payload_bytes = _encode_directory_entries(
        PRESENTATION_FRAME_HEADER_BYTES, _FRAME_SECTION_TYPES, sections
    )
    header = PRESENTATION_FRAME_HEADER_V3.pack(
        PRESENTATION_FRAME_SCHEMA_VERSION,
        PRESENTATION_FRAME_FLAG_COMPLETE_DYNAMIC_SET,
        PRESENTATION_FRAME_HEADER_BYTES,
        len(sections),
        epoch,
        bootstrap,
        sequence,
        tick,
        projection,
        ticks_per_second,
        0,
        len(node_values),
        profile_count,
        interaction_count,
        payload_bytes,
        len(directory),
        len(event_values),
        0,
    )
    return b"".join((header, directory, *(section[2] for section in sections)))


def parse_presentation_frame_v3(
    data: Any,
    *,
    maximum_frame_nodes: int = 1_000_000,
    maximum_frame_events: int = 1_000_000,
    maximum_frame_bytes: int = 64 * 1024 * 1024,
) -> PresentationFrameV3View:
    raw = _canonical_bytes(data, maximum_frame_bytes, PresentationFrameError)
    if len(raw) < PRESENTATION_FRAME_HEADER_BYTES:
        raise PresentationFrameError("frame header is truncated")
    header = PresentationFrameHeaderV3(*PRESENTATION_FRAME_HEADER_V3.unpack_from(raw))
    if (
        header.schema_version != PRESENTATION_FRAME_SCHEMA_VERSION
        or header.flags != PRESENTATION_FRAME_FLAG_COMPLETE_DYNAMIC_SET
        or header.header_bytes != PRESENTATION_FRAME_HEADER_BYTES
        or header.section_count != len(_FRAME_SECTION_TYPES)
        or header.scene_epoch == 0
        or header.bootstrap_id == 0
        or header.frame_seq == 0
        or header.projection_id == 0
        or header.ticks_per_second != PRESENTATION_TICKS_PER_SECOND
        or header.reserved0 != 0
        or header.reserved1 != 0
        or header.node_count > maximum_frame_nodes
        or header.event_count > maximum_frame_events
        or header.profile_count > header.node_count
        or header.interaction_count > header.node_count
        or header.directory_bytes
        != len(_FRAME_SECTION_TYPES) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
        or header.header_bytes + header.directory_bytes + header.payload_bytes != len(raw)
    ):
        raise PresentationFrameError("frame header is non-canonical")
    entries = _parse_directory(
        raw,
        header_bytes=PRESENTATION_FRAME_HEADER_BYTES,
        section_types=_FRAME_SECTION_TYPES,
        strides=_FRAME_STRIDES,
        count_limits=(
            header.node_count,
            header.node_count,
            UINT32_MAX,
            header.node_count,
            UINT32_MAX,
            header.event_count,
            UINT32_MAX,
        ),
        exact_counts={0: header.node_count, 1: header.node_count, 3: header.node_count, 5: header.event_count},
        variable_sections=frozenset((2, 4, 6)),
        error_type=PresentationFrameError,
    )
    raw_nodes = _parse_nodes(raw, entries[0], PresentationFrameError)
    profiles = _parse_node_payloads(
        raw, entries[1], entries[2], raw_nodes, PresentationFrameError
    )
    interactions = _parse_node_payloads(
        raw, entries[3], entries[4], raw_nodes, PresentationFrameError
    )
    nodes = _attach_payloads(raw_nodes, profiles, interactions)
    events = _parse_events(raw, entries[5], entries[6], PresentationFrameError)
    if sum(item is not None for item in profiles) != header.profile_count:
        raise PresentationFrameError("frame profile_count mismatch")
    if sum(item is not None for item in interactions) != header.interaction_count:
        raise PresentationFrameError("frame interaction_count mismatch")
    _validate_nodes(
        nodes,
        visual_types=None,
        animation_states=None,
        source_tick=header.source_tick,
        error_type=PresentationFrameError,
    )
    _validate_events(events, header.source_tick, PresentationFrameError)
    return PresentationFrameV3View(header, nodes, events, entries, raw)


def _encode_nodes(nodes: Tuple[PresentationNodeV3, ...]) -> bytes:
    return b"".join(
        PRESENTATION_NODE_RECORD_V3.pack(
            item.display_id,
            item.parent_display_id,
            item.visual_type_id,
            item.flags,
            *item.local_position,
            *item.local_rotation_xyzw,
            *item.local_scale,
            item.animation_state_id,
            item.animation_start_tick,
            item.animation_flags,
        )
        for item in nodes
    )


def _validate_and_encode_frame_nodes(
    nodes,
    *,
    source_tick,
    error_type,
    visual_types=None,
    animation_states=None,
    encode=True,
):
    """Validate and encode the complete dynamic set in one linear pass.

    The public writer still performs every V3 validation for every node.  Keeping
    the record and its two payload references in the same pass avoids walking a
    60 Hz frame four times and avoids the temporary ``struct.pack`` objects made
    by ``bytes.join``.
    """

    count = len(nodes)
    node_records = (
        bytearray(count * PRESENTATION_NODE_RECORD_BYTES) if encode else None
    )
    profile_refs = bytearray(count * NODE_PAYLOAD_REF_BYTES) if encode else None
    interaction_refs = bytearray(count * NODE_PAYLOAD_REF_BYTES) if encode else None
    profile_blob = bytearray() if encode else None
    interaction_blob = bytearray() if encode else None
    profile_count = 0
    interaction_count = 0
    previous = 0
    visuals = (
        None
        if visual_types is None
        else {item.visual_type_id: item for item in visual_types}
    )
    animations = (
        None
        if animation_states is None
        else {item.animation_state_id for item in animation_states}
    )

    uint32_max = UINT32_MAX
    uint64_max = UINT64_MAX
    allowed_node_flags = PRESENTATION_NODE_ALLOWED_FLAGS
    allowed_animation_flags = ANIMATION_ALLOWED_FLAGS
    node_struct = PRESENTATION_NODE_RECORD_V3
    payload_ref_struct = NODE_PAYLOAD_REF_V3
    finite = math.isfinite
    sqrt = math.sqrt
    exact_type = type

    for index, item in enumerate(nodes):
        if not isinstance(item, PresentationNodeV3):
            raise error_type("nodes must contain PresentationNodeV3")

        display_id = item.display_id
        parent_id = item.parent_display_id
        visual_type_id = item.visual_type_id
        flags = item.flags
        animation_id = item.animation_state_id
        animation_start_tick = item.animation_start_tick
        animation_flags = item.animation_flags

        if (
            exact_type(display_id) is not int
            and (isinstance(display_id, bool) or not isinstance(display_id, int))
        ) or not 1 <= display_id <= uint64_max:
            raise error_type("display_id is out of range")
        if (
            exact_type(parent_id) is not int
            and (isinstance(parent_id, bool) or not isinstance(parent_id, int))
        ) or not 0 <= parent_id <= uint64_max:
            raise error_type("parent_display_id is out of range")
        if display_id <= previous or (parent_id and parent_id >= display_id):
            raise error_type("node IDs/parent order are non-canonical")
        if (
            exact_type(visual_type_id) is not int
            and (
                isinstance(visual_type_id, bool)
                or not isinstance(visual_type_id, int)
            )
        ) or not 1 <= visual_type_id <= uint32_max:
            raise error_type("visual_type_id is out of range")
        if (
            exact_type(flags) is not int
            and (isinstance(flags, bool) or not isinstance(flags, int))
        ) or not 0 <= flags <= uint32_max:
            raise error_type("node flags is out of range")
        if flags & ~allowed_node_flags:
            raise error_type("node flags contain unknown bits")

        position = item.local_position
        rotation = item.local_rotation_xyzw
        scale = item.local_scale
        try:
            if len(position) != 3:
                raise error_type("local_position must contain finite floats")
            px, py, pz = position
        except error_type:
            raise
        except (TypeError, ValueError) as exc:
            raise error_type("local_position must contain finite floats") from exc
        try:
            if not (finite(px) and finite(py) and finite(pz)):
                raise error_type("local_position must contain finite floats")
        except error_type:
            raise
        except (TypeError, ValueError):
            try:
                if not (
                    finite(float(px)) and finite(float(py)) and finite(float(pz))
                ):
                    raise error_type("local_position must contain finite floats")
            except error_type:
                raise
            except (TypeError, ValueError) as conversion_exc:
                raise error_type(
                    "local_position must contain finite floats"
                ) from conversion_exc
        try:
            if len(rotation) != 4:
                raise error_type("local_rotation_xyzw must contain finite floats")
            rx, ry, rz, rw = rotation
        except error_type:
            raise
        except (TypeError, ValueError) as exc:
            raise error_type(
                "local_rotation_xyzw must contain finite floats"
            ) from exc
        try:
            rx_value, ry_value, rz_value, rw_value = rx, ry, rz, rw
            if not (
                finite(rx_value)
                and finite(ry_value)
                and finite(rz_value)
                and finite(rw_value)
            ):
                raise error_type("local_rotation_xyzw must contain finite floats")
        except error_type:
            raise
        except (TypeError, ValueError):
            try:
                rx_value, ry_value, rz_value, rw_value = (
                    float(rx),
                    float(ry),
                    float(rz),
                    float(rw),
                )
                if not (
                    finite(rx_value)
                    and finite(ry_value)
                    and finite(rz_value)
                    and finite(rw_value)
                ):
                    raise error_type(
                        "local_rotation_xyzw must contain finite floats"
                    )
            except error_type:
                raise
            except (TypeError, ValueError) as conversion_exc:
                raise error_type(
                    "local_rotation_xyzw must contain finite floats"
                ) from conversion_exc
        try:
            if len(scale) != 3:
                raise error_type("local_scale must contain finite floats")
            sx, sy, sz = scale
        except error_type:
            raise
        except (TypeError, ValueError) as exc:
            raise error_type("local_scale must contain finite floats") from exc
        try:
            sx_value, sy_value, sz_value = sx, sy, sz
            if not (finite(sx_value) and finite(sy_value) and finite(sz_value)):
                raise error_type("local_scale must contain finite floats")
        except error_type:
            raise
        except (TypeError, ValueError):
            try:
                sx_value, sy_value, sz_value = float(sx), float(sy), float(sz)
                if not (
                    finite(sx_value)
                    and finite(sy_value)
                    and finite(sz_value)
                ):
                    raise error_type("local_scale must contain finite floats")
            except error_type:
                raise
            except (TypeError, ValueError) as conversion_exc:
                raise error_type(
                    "local_scale must contain finite floats"
                ) from conversion_exc
        if sx_value <= 0 or sy_value <= 0 or sz_value <= 0:
            raise error_type("local_scale must be positive")
        rotation_norm = sqrt(
            rx_value * rx_value
            + ry_value * ry_value
            + rz_value * rz_value
            + rw_value * rw_value
        )
        if abs(rotation_norm - 1.0) > _QUATERNION_TOLERANCE:
            raise error_type("local_rotation_xyzw must be normalized")

        if (
            exact_type(animation_id) is not int
            and (isinstance(animation_id, bool) or not isinstance(animation_id, int))
        ) or not 0 <= animation_id <= uint32_max:
            raise error_type("animation_state_id is out of range")
        if (
            exact_type(animation_start_tick) is not int
            and (
                isinstance(animation_start_tick, bool)
                or not isinstance(animation_start_tick, int)
            )
        ) or not 0 <= animation_start_tick <= uint64_max:
            raise error_type("animation_start_tick is out of range")
        if (
            exact_type(animation_flags) is not int
            and (
                isinstance(animation_flags, bool)
                or not isinstance(animation_flags, int)
            )
        ) or not 0 <= animation_flags <= uint32_max:
            raise error_type("animation_flags is out of range")
        if animation_flags & ~allowed_animation_flags:
            raise error_type("animation flags contain unknown bits")
        if source_tick is not None and animation_start_tick > source_tick:
            raise error_type("animation_start_tick exceeds source_tick")
        if animations is not None and animation_id and animation_id not in animations:
            raise error_type("node references unknown animation state")
        visual = None if visuals is None else visuals.get(visual_type_id)
        if visuals is not None and visual is None:
            raise error_type("node references unknown visual type")

        if encode:
            node_struct.pack_into(
                node_records,
                index * PRESENTATION_NODE_RECORD_BYTES,
                display_id,
                parent_id,
                visual_type_id,
                flags,
                px,
                py,
                pz,
                rx,
                ry,
                rz,
                rw,
                sx,
                sy,
                sz,
                animation_id,
                animation_start_tick,
                animation_flags,
            )

        profile = item.profile
        expected_profile_type = None if visual is None else visual.profile_type_id
        if profile is None:
            if expected_profile_type not in (None, 0):
                raise error_type(
                    "node profile type does not match visual registry"
                )
            if encode:
                payload_ref_struct.pack_into(
                    profile_refs,
                    index * NODE_PAYLOAD_REF_BYTES,
                    display_id,
                    0,
                    0,
                    len(profile_blob),
                    0,
                )
        else:
            profile_raw = _payload_bytes(profile, "profile", error_type)
            if (
                expected_profile_type is not None
                and profile.payload_type_id != expected_profile_type
            ):
                raise error_type("node profile type does not match visual registry")
            if encode:
                payload_ref_struct.pack_into(
                    profile_refs,
                    index * NODE_PAYLOAD_REF_BYTES,
                    display_id,
                    profile.payload_type_id,
                    profile.flags,
                    len(profile_blob),
                    len(profile_raw),
                )
                profile_blob.extend(profile_raw)
                profile_count += 1

        interaction = item.interaction
        expected_interaction_type = (
            None if visual is None else visual.interaction_type_id
        )
        if interaction is None:
            if expected_interaction_type not in (None, 0):
                raise error_type(
                    "node interaction type does not match visual registry"
                )
            if encode:
                payload_ref_struct.pack_into(
                    interaction_refs,
                    index * NODE_PAYLOAD_REF_BYTES,
                    display_id,
                    0,
                    0,
                    len(interaction_blob),
                    0,
                )
        else:
            interaction_raw = _payload_bytes(interaction, "interaction", error_type)
            if (
                expected_interaction_type is not None
                and interaction.payload_type_id != expected_interaction_type
            ):
                raise error_type(
                    "node interaction type does not match visual registry"
                )
            if encode:
                payload_ref_struct.pack_into(
                    interaction_refs,
                    index * NODE_PAYLOAD_REF_BYTES,
                    display_id,
                    interaction.payload_type_id,
                    interaction.flags,
                    len(interaction_blob),
                    len(interaction_raw),
                )
                interaction_blob.extend(interaction_raw)
                interaction_count += 1

        previous = display_id

    if encode:
        return (
            node_records,
            profile_refs,
            profile_blob,
            profile_count,
            interaction_refs,
            interaction_blob,
            interaction_count,
        )
    return None


def _parse_nodes(raw: bytes, entry: PresentationSectionEntryV3, error_type):
    result = []
    for index in range(entry.record_count):
        values = PRESENTATION_NODE_RECORD_V3.unpack_from(
            raw, entry.byte_offset + index * entry.record_stride
        )
        result.append(
            PresentationNodeV3(
                display_id=values[0],
                parent_display_id=values[1],
                visual_type_id=values[2],
                flags=values[3],
                local_position=tuple(values[4:7]),
                local_rotation_xyzw=tuple(values[7:11]),
                local_scale=tuple(values[11:14]),
                animation_state_id=values[14],
                animation_start_tick=values[15],
                animation_flags=values[16],
            )
        )
    return tuple(result)


def _encode_node_payloads(nodes, field):
    refs = bytearray()
    blob = bytearray()
    present = 0
    for node in nodes:
        payload = getattr(node, field)
        if payload is None:
            refs.extend(NODE_PAYLOAD_REF_V3.pack(node.display_id, 0, 0, len(blob), 0))
            continue
        raw = _payload_bytes(payload, field, ConfigurationError)
        refs.extend(
            NODE_PAYLOAD_REF_V3.pack(
                node.display_id,
                payload.payload_type_id,
                payload.flags,
                len(blob),
                len(raw),
            )
        )
        blob.extend(raw)
        present += 1
    return bytes(refs), bytes(blob), present


def _parse_node_payloads(raw, refs_entry, blob_entry, nodes, error_type):
    blob = _logical_blob(raw, blob_entry, error_type)
    result = []
    expected_offset = 0
    for index, node in enumerate(nodes):
        values = NODE_PAYLOAD_REF_V3.unpack_from(
            raw, refs_entry.byte_offset + index * refs_entry.record_stride
        )
        display_id, payload_type_id, flags, offset, length = values
        if display_id != node.display_id or offset != expected_offset or flags != 0:
            raise error_type("node payload reference is non-canonical")
        if payload_type_id == 0:
            if length != 0:
                raise error_type("absent node payload has bytes")
            result.append(None)
        else:
            if length == 0 or offset + length > len(blob):
                raise error_type("node payload range is invalid")
            result.append(OpaquePayloadV3(payload_type_id, blob[offset : offset + length], flags))
            expected_offset += length
    if expected_offset != len(blob):
        raise error_type("node payload blob has trailing bytes")
    return tuple(result)


def _attach_payloads(nodes, profiles, interactions):
    return tuple(
        PresentationNodeV3(
            display_id=node.display_id,
            parent_display_id=node.parent_display_id,
            visual_type_id=node.visual_type_id,
            flags=node.flags,
            local_position=node.local_position,
            local_rotation_xyzw=node.local_rotation_xyzw,
            local_scale=node.local_scale,
            animation_state_id=node.animation_state_id,
            animation_start_tick=node.animation_start_tick,
            animation_flags=node.animation_flags,
            profile=profiles[index],
            interaction=interactions[index],
        )
        for index, node in enumerate(nodes)
    )


def _encode_metadata(values):
    refs = bytearray()
    blob = bytearray()
    for item in values:
        raw = _payload_bytes(item, "scene metadata", ConfigurationError)
        refs.extend(
            SCENE_METADATA_REF_V3.pack(
                item.metadata_type_id, item.flags, len(blob), len(raw)
            )
        )
        blob.extend(raw)
    return bytes(refs), bytes(blob)


def _parse_metadata(raw, refs_entry, blob_entry, error_type):
    blob = _logical_blob(raw, blob_entry, error_type)
    result = []
    expected_offset = 0
    for index in range(refs_entry.record_count):
        metadata_type_id, flags, offset, length = SCENE_METADATA_REF_V3.unpack_from(
            raw, refs_entry.byte_offset + index * refs_entry.record_stride
        )
        if (
            metadata_type_id == 0
            or flags != 0
            or offset != expected_offset
            or length == 0
            or offset + length > len(blob)
        ):
            raise error_type("scene metadata reference is non-canonical")
        result.append(SceneMetadataV3(metadata_type_id, blob[offset : offset + length], flags))
        expected_offset += length
    if expected_offset != len(blob):
        raise error_type("scene metadata blob has trailing bytes")
    return tuple(result)


def _encode_events(events):
    records = bytearray()
    blob = bytearray()
    for item in events:
        payload = _bytes(item.payload, "event payload", ConfigurationError, allow_empty=True)
        records.extend(
            PRESENTATION_EVENT_RECORD_V3.pack(
                item.event_id,
                item.event_type_id,
                item.flags,
                item.source_display_id,
                item.target_display_id,
                item.start_tick,
                len(blob),
                len(payload),
            )
        )
        blob.extend(payload)
    return bytes(records), bytes(blob)


def _parse_events(raw, records_entry, blob_entry, error_type):
    blob = _logical_blob(raw, blob_entry, error_type)
    result = []
    expected_offset = 0
    for index in range(records_entry.record_count):
        values = PRESENTATION_EVENT_RECORD_V3.unpack_from(
            raw, records_entry.byte_offset + index * records_entry.record_stride
        )
        offset, length = values[6], values[7]
        if offset != expected_offset or offset + length > len(blob):
            raise error_type("event payload range is non-canonical")
        result.append(PresentationEventV3(*values[:6], payload=blob[offset : offset + length]))
        expected_offset += length
    if expected_offset != len(blob):
        raise error_type("event payload blob has trailing bytes")
    return tuple(result)


def _parse_visual_types(raw, entry, error_type):
    return tuple(
        VisualTypeRecordV3(
            *VISUAL_TYPE_RECORD_V3.unpack_from(
                raw, entry.byte_offset + index * entry.record_stride
            )
        )
        for index in range(entry.record_count)
    )


def _parse_animation_states(raw, entry, error_type):
    result = []
    for index in range(entry.record_count):
        values = ANIMATION_STATE_RECORD_V3.unpack_from(
            raw, entry.byte_offset + index * entry.record_stride
        )
        if values[3] != 0:
            raise error_type("animation state reserved field must be zero")
        result.append(AnimationStateRecordV3(*values[:3]))
    return tuple(result)


def _validate_nodes(
    nodes,
    *,
    visual_types,
    animation_states,
    source_tick,
    error_type,
):
    _validate_and_encode_frame_nodes(
        nodes,
        source_tick=source_tick,
        error_type=error_type,
        visual_types=visual_types,
        animation_states=animation_states,
        encode=False,
    )


def _validate_bootstrap_tree(nodes, error_type):
    from .presentation_tree_validation import validate_presentation_node_tree

    try:
        validate_presentation_node_tree(nodes)
    except PresentationTreeError as exc:
        raise error_type(str(exc)) from exc


def _validate_visual_types(values, error_type):
    previous = 0
    for item in values:
        if not isinstance(item, VisualTypeRecordV3):
            raise error_type("visual_types must contain VisualTypeRecordV3")
        visual_id = _uint(
            "visual_type_id", item.visual_type_id, UINT32_MAX, minimum=1, error_type=error_type
        )
        if visual_id <= previous:
            raise error_type("visual types must be strictly increasing")
        flags = _uint("visual flags", item.flags, UINT32_MAX, error_type=error_type)
        if flags & ~VISUAL_TYPE_ALLOWED_FLAGS:
            raise error_type("visual flags contain unknown bits")
        _uint("profile_type_id", item.profile_type_id, UINT32_MAX, error_type=error_type)
        _uint("interaction_type_id", item.interaction_type_id, UINT32_MAX, error_type=error_type)
        previous = visual_id


def _validate_animation_states(values, error_type):
    previous = 0
    for item in values:
        if not isinstance(item, AnimationStateRecordV3):
            raise error_type("animation_states must contain AnimationStateRecordV3")
        state_id = _uint(
            "animation_state_id", item.animation_state_id, UINT32_MAX, minimum=1, error_type=error_type
        )
        if state_id <= previous:
            raise error_type("animation states must be strictly increasing")
        flags = _uint("animation flags", item.flags, UINT32_MAX, error_type=error_type)
        if flags & ~ANIMATION_ALLOWED_FLAGS:
            raise error_type("animation flags contain unknown bits")
        _uint("duration_ticks", item.duration_ticks, UINT32_MAX, minimum=1, error_type=error_type)
        previous = state_id


def _validate_metadata(values, error_type):
    previous = 0
    for item in values:
        if not isinstance(item, SceneMetadataV3):
            raise error_type("scene_metadata must contain SceneMetadataV3")
        type_id = _uint(
            "metadata_type_id", item.metadata_type_id, UINT32_MAX, minimum=1, error_type=error_type
        )
        if type_id <= previous:
            raise error_type("scene metadata types must be strictly increasing")
        _payload_bytes(item, "scene metadata", error_type)
        previous = type_id


def _validate_events(values, source_tick, error_type):
    previous = 0
    for item in values:
        if not isinstance(item, PresentationEventV3):
            raise error_type("events must contain PresentationEventV3")
        event_id = _uint("event_id", item.event_id, UINT64_MAX, minimum=1, error_type=error_type)
        if event_id <= previous:
            raise error_type("event IDs must be strictly increasing")
        _uint("event_type_id", item.event_type_id, UINT32_MAX, minimum=1, error_type=error_type)
        flags = _uint("event flags", item.flags, UINT32_MAX, error_type=error_type)
        if flags & ~PRESENTATION_EVENT_ALLOWED_FLAGS:
            raise error_type("event flags contain unknown bits")
        _uint("source_display_id", item.source_display_id, UINT64_MAX, error_type=error_type)
        _uint("target_display_id", item.target_display_id, UINT64_MAX, error_type=error_type)
        start = _uint("start_tick", item.start_tick, UINT64_MAX, error_type=error_type)
        if start > source_tick:
            raise error_type("event start_tick exceeds source_tick")
        _bytes(item.payload, "event payload", error_type, allow_empty=True)
        previous = event_id


def _encode_identity(value):
    strings = tuple(
        _canonical_text(getattr(value, field), field).encode("utf-8")
        for field in ("run_id", "viewer_scope", "profile_id")
    )
    if any(len(item) > UINT16_MAX for item in strings):
        raise ConfigurationError("session identity string exceeds uint16")
    total = sum(len(item) for item in strings)
    if total > _MAX_IDENTITY_UTF8_BYTES:
        raise ConfigurationError("session identity exceeds byte limit")
    return _pad4(
        BOOTSTRAP_SESSION_IDENTITY_HEADER_V3.pack(
            *(len(item) for item in strings), total, 0
        )
        + b"".join(strings)
    )


def _parse_identity(raw, error_type):
    if len(raw) < BOOTSTRAP_SESSION_IDENTITY_HEADER_V3.size:
        raise error_type("session identity is truncated")
    run_length, viewer_length, profile_length, total, reserved = (
        BOOTSTRAP_SESSION_IDENTITY_HEADER_V3.unpack_from(raw)
    )
    lengths = (run_length, viewer_length, profile_length)
    if (
        reserved != 0
        or any(length == 0 for length in lengths)
        or total != sum(lengths)
        or total > _MAX_IDENTITY_UTF8_BYTES
        or _align4(BOOTSTRAP_SESSION_IDENTITY_HEADER_V3.size + total) != len(raw)
    ):
        raise error_type("session identity is non-canonical")
    cursor = BOOTSTRAP_SESSION_IDENTITY_HEADER_V3.size
    values = []
    for length in lengths:
        values.append(_decode_text(raw[cursor : cursor + length], error_type))
        cursor += length
    _zero_padding(raw, cursor, error_type)
    return EngineSessionIdentityV3(*values)


def _encode_authority_baseline(value):
    codec = _canonical_text(value.codec_identity, "codec_identity").encode("utf-8")
    cursor = _bytes(value.canonical_bytes, "canonical_bytes", ConfigurationError)
    if len(codec) > UINT16_MAX or len(cursor) > UINT32_MAX:
        raise ConfigurationError("authority baseline exceeds field range")
    total = len(codec) + len(cursor)
    if total > UINT32_MAX:
        raise ConfigurationError("authority baseline exceeds uint32")
    return _pad4(
        BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V3.pack(
            len(codec), len(cursor), total, 0
        )
        + codec
        + cursor
    )


def _parse_authority_baseline(raw, error_type):
    if len(raw) < BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V3.size:
        raise error_type("authority baseline is truncated")
    codec_length, cursor_length, total, reserved = (
        BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V3.unpack_from(raw)
    )
    if (
        reserved != 0
        or codec_length == 0
        or cursor_length == 0
        or total != codec_length + cursor_length
        or _align4(BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V3.size + total) != len(raw)
    ):
        raise error_type("authority baseline is non-canonical")
    start = BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V3.size
    codec = _decode_text(raw[start : start + codec_length], error_type)
    cursor_start = start + codec_length
    cursor = raw[cursor_start : cursor_start + cursor_length]
    _zero_padding(raw, cursor_start + cursor_length, error_type)
    try:
        return AuthorityCursorEnvelope(codec, cursor)
    except Exception as exc:
        raise error_type("authority baseline is invalid") from exc


def _encode_directory(header_bytes, section_types, sections):
    directory, _ = _encode_directory_entries(header_bytes, section_types, sections)
    payload = bytearray()
    for _, _, data in sections:
        payload.extend(data)
    return directory, bytes(payload)


def _encode_directory_entries(header_bytes, section_types, sections):
    directory_bytes = len(sections) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
    offset = header_bytes + directory_bytes
    directory = bytearray(directory_bytes)
    payload_bytes = 0
    for index, (section_type, (record_count, stride, data)) in enumerate(
        zip(section_types, sections)
    ):
        if offset % 4:
            raise ConfigurationError("section offset is not four-byte aligned")
        PRESENTATION_SECTION_DIRECTORY_ENTRY_V3.pack_into(
            directory,
            index * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES,
            section_type,
            PRESENTATION_SECTION_FLAG_REQUIRED,
            record_count,
            offset,
            len(data),
            stride,
            0,
        )
        offset += len(data)
        payload_bytes += len(data)
    return bytes(directory), payload_bytes


def _parse_directory(
    raw,
    *,
    header_bytes,
    section_types,
    strides,
    count_limits,
    variable_sections,
    error_type,
    exact_counts=None,
):
    expected_offset = header_bytes + len(section_types) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
    entries = []
    exact_counts = exact_counts or {}
    for index, (section_type, stride, count_limit) in enumerate(
        zip(section_types, strides, count_limits)
    ):
        offset = header_bytes + index * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
        entry = PresentationSectionEntryV3(
            *PRESENTATION_SECTION_DIRECTORY_ENTRY_V3.unpack_from(raw, offset)
        )
        if (
            entry.section_type != section_type
            or entry.flags != PRESENTATION_SECTION_FLAG_REQUIRED
            or entry.record_stride != stride
            or entry.reserved0 != 0
            or entry.record_count > count_limit
            or entry.record_count != exact_counts.get(index, entry.record_count)
            or entry.byte_offset != expected_offset
            or entry.byte_offset % 4 != 0
            or entry.byte_offset + entry.byte_length > len(raw)
        ):
            raise error_type("section directory is non-canonical")
        if index in variable_sections:
            if index in (0, 1):
                if entry.record_count != 1 or entry.record_stride != 0:
                    raise error_type("single-record variable section is invalid")
            else:
                if entry.byte_length != _align4(entry.record_count):
                    raise error_type("byte blob section length is non-canonical")
                _zero_padding(
                    raw[entry.byte_offset : entry.byte_offset + entry.byte_length],
                    entry.record_count,
                    error_type,
                )
        elif entry.byte_length != entry.record_count * entry.record_stride:
            raise error_type("fixed section byte length is invalid")
        expected_offset += entry.byte_length
        entries.append(entry)
    if expected_offset != len(raw):
        raise error_type("message has trailing or unindexed bytes")
    return tuple(entries)


def _logical_blob(raw, entry, error_type):
    section = _slice(raw, entry)
    _zero_padding(section, entry.record_count, error_type)
    return section[: entry.record_count]


def _slice(raw, entry):
    return raw[entry.byte_offset : entry.byte_offset + entry.byte_length]


def _payload_bytes(value, field, error_type):
    type_id = getattr(value, "payload_type_id", None)
    if type_id is None:
        type_id = getattr(value, "metadata_type_id", None)
    if (
        isinstance(type_id, bool)
        or not isinstance(type_id, int)
        or not 1 <= type_id <= UINT32_MAX
    ):
        raise error_type("{}_type_id is out of range".format(field))
    flags = value.flags
    if (
        isinstance(flags, bool)
        or not isinstance(flags, int)
        or not 0 <= flags <= UINT32_MAX
    ):
        raise error_type("{} flags is out of range".format(field))
    if flags != 0:
        raise error_type("{} flags must be zero in V3".format(field))
    return _bytes(value.data, field, error_type)


def _canonical_bytes(value, maximum, error_type):
    _uint("maximum bytes", maximum, UINT32_MAX, error_type=ConfigurationError)
    try:
        view = memoryview(value)
    except TypeError as exc:
        raise error_type("binary input must support the buffer protocol") from exc
    if not view.c_contiguous:
        raise error_type("binary input must be C-contiguous")
    try:
        byte_view = view.cast("B")
    except (TypeError, ValueError) as exc:
        raise error_type("binary input must be byte-addressable") from exc
    if byte_view.nbytes > maximum:
        raise error_type("message exceeds byte limit")
    return value if isinstance(value, bytes) else byte_view.tobytes()


def _bytes(value, field, error_type, *, allow_empty=False):
    if type(value) is bytes:
        raw = value
    else:
        try:
            raw = bytes(memoryview(value).cast("B"))
        except (TypeError, ValueError) as exc:
            raise error_type("{} must be bytes".format(field)) from exc
    if not raw and not allow_empty:
        raise error_type("{} must not be empty".format(field))
    if len(raw) > UINT32_MAX:
        raise error_type("{} exceeds uint32".format(field))
    return raw


def _uint(field, value, maximum, minimum=0, error_type=ConfigurationError):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise error_type("{} is out of range".format(field))
    return value


def _finite_float(field, value, error_type):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise error_type("{} must be finite".format(field))
    return float(value)


def _require_60_tps(value, error_type):
    if value != PRESENTATION_TICKS_PER_SECOND:
        raise error_type("ticks_per_second must be 60")


def _canonical_text(value, field):
    if (
        not isinstance(value, str)
        or not value
        or value.strip() != value
        or "\x00" in value
        or unicodedata.normalize("NFC", value) != value
    ):
        raise ConfigurationError("{} is not canonical text".format(field))
    return value


def _decode_text(value, error_type):
    try:
        text = value.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise error_type("text is not UTF-8") from exc
    try:
        return _canonical_text(text, "text")
    except ConfigurationError as exc:
        raise error_type("text is not canonical") from exc


def _align4(value):
    return (value + 3) & ~3


def _pad4(value):
    padding = _align4(len(value)) - len(value)
    return value if padding == 0 else value + b"\x00" * padding


def _zero_padding(value, start, error_type):
    if any(value[start:]):
        raise error_type("section padding must be zero")


__all__ = [
    "AnimationStateRecordV3",
    "EngineSessionIdentityV3",
    "OpaquePayloadV3",
    "PresentationEventV3",
    "PresentationFrameHeaderV3",
    "PresentationFrameV3View",
    "PresentationNodeRecordV3",
    "PresentationNodeV3",
    "PresentationSectionEntryV3",
    "SceneBootstrapHeaderV3",
    "SceneBootstrapV3View",
    "SceneMetadataV3",
    "VisualTypeRecordV3",
    "encode_presentation_frame_v3",
    "encode_scene_bootstrap_v3",
    "parse_presentation_frame_v3",
    "parse_scene_bootstrap_v3",
]
