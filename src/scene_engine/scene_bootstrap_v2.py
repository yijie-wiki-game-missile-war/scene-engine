"""Generic SceneBootstrap V2 with opaque authority baseline binding."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
from typing import Any, Iterable, Tuple

from .authority_cursor import AuthorityCursorEnvelope
from .binary_schema import UINT16_MAX, UINT32_MAX, UINT64_MAX
from .errors import ConfigurationError, SceneBootstrapError
from .presentation_schema import (
    ADJACENCY_RECORD_BYTES,
    ANIMATION_REGISTRY_RECORD_BYTES,
    BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V2,
    BOOTSTRAP_SECTION_ADJACENCIES,
    BOOTSTRAP_SECTION_ANIMATION_REGISTRY,
    BOOTSTRAP_SECTION_AUTHORITY_BASELINE,
    BOOTSTRAP_SECTION_IDENTITY,
    BOOTSTRAP_SECTION_STATIC_NODES,
    BOOTSTRAP_SECTION_TOPOLOGY_NODES,
    BOOTSTRAP_SECTION_VISUAL_REGISTRY,
    BOOTSTRAP_SESSION_IDENTITY_HEADER_V2,
    PRESENTATION_TICKS_PER_SECOND,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_V1,
    PRESENTATION_SECTION_FLAG_REQUIRED,
    SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
    SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET,
    SCENE_BOOTSTRAP_HEADER_BYTES,
    SCENE_BOOTSTRAP_HEADER_V1,
    SCENE_BOOTSTRAP_SCHEMA_VERSION_V2,
    STATIC_NODE_RECORD_BYTES,
    TOPOLOGY_NODE_RECORD_BYTES,
    VISUAL_REGISTRY_RECORD_BYTES,
)
from .scene_bootstrap import (
    AdjacencyRecordV1,
    AnimationRegistryRecordV1,
    BootstrapSectionEntryV1,
    SceneBootstrapHeaderV1,
    StaticNodeRecordV1,
    TopologyNodeRecordV1,
    VisualRegistryRecordV1,
    _decode_identity,
    _encode_adjacencies,
    _encode_animation_registry,
    _encode_static_nodes,
    _encode_topology_nodes,
    _encode_visual_registry,
    _identity_string,
    _parse_adjacencies,
    _parse_animation_registry,
    _parse_static_nodes,
    _parse_topology_nodes,
    _parse_visual_registry,
    _validate_cross_references,
)


@dataclass(frozen=True)
class EngineSessionIdentityV2:
    run_id: str
    viewer_scope: str
    profile_id: str


@dataclass(frozen=True)
class SceneBootstrapV2View:
    header: SceneBootstrapHeaderV1
    identity: EngineSessionIdentityV2
    authority_baseline: AuthorityCursorEnvelope
    static_nodes: Tuple[StaticNodeRecordV1, ...]
    topology_nodes: Tuple[TopologyNodeRecordV1, ...]
    adjacencies: Tuple[AdjacencyRecordV1, ...]
    visual_registry: Tuple[VisualRegistryRecordV1, ...]
    animation_registry: Tuple[AnimationRegistryRecordV1, ...]
    directory: Tuple[BootstrapSectionEntryV1, ...]
    data: bytes

    @property
    def scene_epoch(self) -> int:
        return self.header.scene_epoch

    @property
    def bootstrap_id(self) -> int:
        return self.header.bootstrap_id


_SECTION_TYPES = (
    BOOTSTRAP_SECTION_IDENTITY,
    BOOTSTRAP_SECTION_STATIC_NODES,
    BOOTSTRAP_SECTION_TOPOLOGY_NODES,
    BOOTSTRAP_SECTION_ADJACENCIES,
    BOOTSTRAP_SECTION_VISUAL_REGISTRY,
    BOOTSTRAP_SECTION_ANIMATION_REGISTRY,
    BOOTSTRAP_SECTION_AUTHORITY_BASELINE,
)
_STRIDES = (
    0,
    STATIC_NODE_RECORD_BYTES,
    TOPOLOGY_NODE_RECORD_BYTES,
    ADJACENCY_RECORD_BYTES,
    VISUAL_REGISTRY_RECORD_BYTES,
    ANIMATION_REGISTRY_RECORD_BYTES,
    0,
)
_DIRECTORY_BYTES = len(_SECTION_TYPES) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
_PAYLOAD_OFFSET = SCENE_BOOTSTRAP_HEADER_BYTES + _DIRECTORY_BYTES
_MAX_IDENTITY_UTF8_BYTES = 4096


def encode_scene_bootstrap_v2(
    *,
    scene_epoch: int,
    bootstrap_id: int,
    identity: EngineSessionIdentityV2,
    authority_baseline: AuthorityCursorEnvelope,
    static_nodes: Iterable[StaticNodeRecordV1] = (),
    topology_nodes: Iterable[TopologyNodeRecordV1] = (),
    adjacencies: Iterable[AdjacencyRecordV1] = (),
    visual_registry: Iterable[VisualRegistryRecordV1] = (),
    animation_registry: Iterable[AnimationRegistryRecordV1] = (),
    maximum_dynamic_entities: int,
    maximum_frame_bytes: int,
    world_units_per_meter: float = 1.0,
) -> bytes:
    epoch = _uint("scene_epoch", scene_epoch, UINT64_MAX, minimum=1)
    bootstrap = _uint("bootstrap_id", bootstrap_id, UINT64_MAX, minimum=1)
    dynamic_limit = _uint(
        "maximum_dynamic_entities", maximum_dynamic_entities, UINT32_MAX
    )
    frame_limit = _uint(
        "maximum_frame_bytes", maximum_frame_bytes, UINT32_MAX, minimum=1
    )
    units = _float32("world_units_per_meter", world_units_per_meter)
    if units <= 0:
        raise SceneBootstrapError("world_units_per_meter must be positive")
    if not isinstance(identity, EngineSessionIdentityV2):
        raise SceneBootstrapError("identity must be EngineSessionIdentityV2")
    if not isinstance(authority_baseline, AuthorityCursorEnvelope):
        raise SceneBootstrapError(
            "authority_baseline must be AuthorityCursorEnvelope"
        )
    static_values = tuple(static_nodes)
    topology_values = tuple(topology_nodes)
    adjacency_values = tuple(adjacencies)
    visual_values = tuple(visual_registry)
    animation_values = tuple(animation_registry)
    payloads = (
        _encode_session_identity(identity),
        _encode_static_nodes(static_values),
        _encode_topology_nodes(topology_values),
        _encode_adjacencies(adjacency_values),
        _encode_visual_registry(visual_values),
        _encode_animation_registry(animation_values),
        _encode_authority_baseline(authority_baseline),
    )
    counts = (
        1,
        len(static_values),
        len(topology_values),
        len(adjacency_values),
        len(visual_values),
        len(animation_values),
        1,
    )
    directory_parts = []
    next_offset = _PAYLOAD_OFFSET
    for section_type, payload, count, stride in zip(
        _SECTION_TYPES, payloads, counts, _STRIDES
    ):
        directory_parts.append(
            PRESENTATION_SECTION_DIRECTORY_ENTRY_V1.pack(
                section_type,
                PRESENTATION_SECTION_FLAG_REQUIRED,
                count,
                next_offset,
                len(payload),
                stride,
                0,
            )
        )
        next_offset += len(payload)
    directory = b"".join(directory_parts)
    payload = b"".join(payloads)
    header = SCENE_BOOTSTRAP_HEADER_V1.pack(
        SCENE_BOOTSTRAP_SCHEMA_VERSION_V2,
        SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET,
        SCENE_BOOTSTRAP_HEADER_BYTES,
        len(_SECTION_TYPES),
        epoch,
        bootstrap,
        PRESENTATION_TICKS_PER_SECOND,
        SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
        units,
        dynamic_limit,
        frame_limit,
        len(directory),
        len(payload),
        hashlib.sha256(directory + payload).digest(),
        b"\x00" * 16,
    )
    return header + directory + payload


def parse_scene_bootstrap_v2(
    data: Any,
    *,
    maximum_bootstrap_bytes: int,
    maximum_static_nodes: int,
    maximum_topology_nodes: int,
    maximum_adjacencies: int,
    maximum_visual_types: int,
    maximum_animation_states: int,
) -> SceneBootstrapV2View:
    limits = (
        _limit("maximum_bootstrap_bytes", maximum_bootstrap_bytes),
        _limit("maximum_static_nodes", maximum_static_nodes),
        _limit("maximum_topology_nodes", maximum_topology_nodes),
        _limit("maximum_adjacencies", maximum_adjacencies),
        _limit("maximum_visual_types", maximum_visual_types),
        _limit("maximum_animation_states", maximum_animation_states),
    )
    initial = _byte_view(data)
    if initial.nbytes > limits[0] or initial.nbytes < SCENE_BOOTSTRAP_HEADER_BYTES:
        raise SceneBootstrapError("bootstrap byte length is invalid")
    canonical = data if isinstance(data, bytes) else initial.tobytes()
    view = memoryview(canonical)
    header = SceneBootstrapHeaderV1(*SCENE_BOOTSTRAP_HEADER_V1.unpack_from(view, 0))
    _validate_header(header, len(canonical))
    entries = _parse_directory(view, header, limits[1:])
    if hashlib.sha256(view[header.header_bytes:].tobytes()).digest() != header.content_sha256:
        raise SceneBootstrapError("bootstrap content_sha256 mismatch")
    identity = _parse_session_identity(view, entries[0])
    static_nodes = _parse_static_nodes(view, entries[1])
    topology_nodes = _parse_topology_nodes(view, entries[2])
    adjacencies = _parse_adjacencies(view, entries[3])
    visual_registry = _parse_visual_registry(view, entries[4])
    animation_registry = _parse_animation_registry(view, entries[5])
    authority_baseline = _parse_authority_baseline(view, entries[6])
    _validate_cross_references(
        static_nodes,
        topology_nodes,
        adjacencies,
        visual_registry,
        animation_registry,
    )
    return SceneBootstrapV2View(
        header,
        identity,
        authority_baseline,
        static_nodes,
        topology_nodes,
        adjacencies,
        visual_registry,
        animation_registry,
        entries,
        canonical,
    )


def _encode_session_identity(identity: EngineSessionIdentityV2) -> bytes:
    encoded = tuple(
        _identity_string(value)
        for value in (identity.run_id, identity.viewer_scope, identity.profile_id)
    )
    total = sum(map(len, encoded))
    if total > _MAX_IDENTITY_UTF8_BYTES:
        raise SceneBootstrapError("bootstrap identity strings exceed byte limit")
    value = BOOTSTRAP_SESSION_IDENTITY_HEADER_V2.pack(
        *(len(item) for item in encoded), total, 0
    ) + b"".join(encoded)
    return value + b"\x00" * (_align4(len(value)) - len(value))


def _encode_authority_baseline(envelope: AuthorityCursorEnvelope) -> bytes:
    codec = _identity_string(envelope.codec_identity)
    cursor = envelope.canonical_bytes
    value = BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V2.pack(
        len(codec), len(cursor), len(codec) + len(cursor), 0
    ) + codec + cursor
    return value + b"\x00" * (_align4(len(value)) - len(value))


def _parse_session_identity(view: memoryview, entry) -> EngineSessionIdentityV2:
    lengths = BOOTSTRAP_SESSION_IDENTITY_HEADER_V2.unpack_from(view, entry.byte_offset)
    string_lengths = lengths[:3]
    total = lengths[3]
    if lengths[4] != 0 or any(item == 0 for item in string_lengths) or total != sum(string_lengths):
        raise SceneBootstrapError("bootstrap session identity is invalid")
    raw_end = entry.byte_offset + BOOTSTRAP_SESSION_IDENTITY_HEADER_V2.size + total
    section_end = entry.byte_offset + entry.byte_length
    if _align4(BOOTSTRAP_SESSION_IDENTITY_HEADER_V2.size + total) != entry.byte_length:
        raise SceneBootstrapError("bootstrap session identity length is invalid")
    if any(view[raw_end:section_end]):
        raise SceneBootstrapError("bootstrap session identity padding must be zero")
    cursor = entry.byte_offset + BOOTSTRAP_SESSION_IDENTITY_HEADER_V2.size
    values = []
    for length in string_lengths:
        values.append(_decode_identity(view[cursor:cursor + length].tobytes()))
        cursor += length
    return EngineSessionIdentityV2(*values)


def _parse_authority_baseline(view: memoryview, entry) -> AuthorityCursorEnvelope:
    codec_length, cursor_length, total, reserved = (
        BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V2.unpack_from(view, entry.byte_offset)
    )
    if reserved != 0 or codec_length == 0 or cursor_length == 0 or total != codec_length + cursor_length:
        raise SceneBootstrapError("bootstrap authority baseline is invalid")
    raw_end = entry.byte_offset + BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V2.size + total
    section_end = entry.byte_offset + entry.byte_length
    if _align4(BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V2.size + total) != entry.byte_length:
        raise SceneBootstrapError("bootstrap authority baseline length is invalid")
    if any(view[raw_end:section_end]):
        raise SceneBootstrapError("bootstrap authority baseline padding must be zero")
    cursor = entry.byte_offset + BOOTSTRAP_AUTHORITY_BASELINE_HEADER_V2.size
    codec = _decode_identity(view[cursor:cursor + codec_length].tobytes())
    cursor += codec_length
    return AuthorityCursorEnvelope(
        codec,
        view[cursor:cursor + cursor_length].tobytes(),
    )


def _validate_header(header: SceneBootstrapHeaderV1, total_size: int) -> None:
    if header.schema_version != SCENE_BOOTSTRAP_SCHEMA_VERSION_V2:
        raise SceneBootstrapError("unsupported bootstrap schema_version")
    if header.flags != SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET:
        raise SceneBootstrapError("bootstrap flags are not canonical")
    if header.header_bytes != SCENE_BOOTSTRAP_HEADER_BYTES:
        raise SceneBootstrapError("bootstrap header_bytes must be 96")
    if header.section_count != len(_SECTION_TYPES):
        raise SceneBootstrapError("bootstrap V2 requires exactly seven sections")
    if header.scene_epoch == 0 or header.bootstrap_id == 0:
        raise SceneBootstrapError("bootstrap identities must be positive")
    if header.ticks_per_second != PRESENTATION_TICKS_PER_SECOND:
        raise SceneBootstrapError("bootstrap ticks_per_second must be 60")
    if header.coordinate_profile != SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32:
        raise SceneBootstrapError("unsupported bootstrap coordinate profile")
    if not math.isfinite(header.world_units_per_meter) or header.world_units_per_meter <= 0:
        raise SceneBootstrapError("world_units_per_meter must be finite and positive")
    if header.maximum_frame_bytes == 0 or header.directory_bytes != _DIRECTORY_BYTES:
        raise SceneBootstrapError("bootstrap directory/limits are invalid")
    if header.header_bytes + header.directory_bytes + header.payload_bytes != total_size:
        raise SceneBootstrapError("bootstrap length does not match header")
    if header.reserved != b"\x00" * 16:
        raise SceneBootstrapError("bootstrap reserved bytes must be zero")


def _parse_directory(view, header, count_limits):
    entries = []
    previous_end = _PAYLOAD_OFFSET
    limits = (1,) + tuple(count_limits) + (1,)
    for index, (section_type, stride, count_limit) in enumerate(
        zip(_SECTION_TYPES, _STRIDES, limits)
    ):
        offset = SCENE_BOOTSTRAP_HEADER_BYTES + index * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
        entry = BootstrapSectionEntryV1(
            *PRESENTATION_SECTION_DIRECTORY_ENTRY_V1.unpack_from(view, offset)
        )
        if entry.section_type != section_type or entry.flags != PRESENTATION_SECTION_FLAG_REQUIRED:
            raise SceneBootstrapError("bootstrap section directory is non-canonical")
        if entry.reserved0 != 0 or entry.record_stride != stride or entry.record_count > count_limit:
            raise SceneBootstrapError("bootstrap section stride/count is invalid")
        if section_type in (BOOTSTRAP_SECTION_IDENTITY, BOOTSTRAP_SECTION_AUTHORITY_BASELINE):
            if entry.record_count != 1:
                raise SceneBootstrapError("bootstrap variable section count is invalid")
        elif entry.byte_length != entry.record_count * stride:
            raise SceneBootstrapError("bootstrap fixed section length mismatch")
        if entry.byte_offset % 4 or entry.byte_offset != previous_end:
            raise SceneBootstrapError("bootstrap sections must be contiguous and aligned")
        previous_end = entry.byte_offset + entry.byte_length
        if previous_end > len(view):
            raise SceneBootstrapError("bootstrap section exceeds message")
        entries.append(entry)
    if previous_end != len(view):
        raise SceneBootstrapError("bootstrap has trailing or unindexed bytes")
    return tuple(entries)


def _align4(value: int) -> int:
    return (value + 3) & ~3


def _uint(name, value, maximum, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise SceneBootstrapError("{} is outside the integer range".format(name))
    return value


def _float32(name, value):
    import struct
    try:
        result = struct.unpack("<f", struct.pack("<f", float(value)))[0]
    except (TypeError, ValueError, OverflowError, struct.error) as exc:
        raise SceneBootstrapError("{} must be finite float32".format(name)) from exc
    if not math.isfinite(result):
        raise SceneBootstrapError("{} must be finite float32".format(name))
    return result


def _limit(name, value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= UINT32_MAX:
        raise ConfigurationError("{} must be uint32".format(name))
    return value


def _byte_view(data):
    try:
        view = memoryview(data)
    except TypeError as exc:
        raise SceneBootstrapError("bootstrap input must support the buffer protocol") from exc
    if not view.c_contiguous:
        raise SceneBootstrapError("bootstrap input must be C-contiguous")
    return view.cast("B")


__all__ = [
    "EngineSessionIdentityV2",
    "SceneBootstrapV2View",
    "encode_scene_bootstrap_v2",
    "parse_scene_bootstrap_v2",
]
