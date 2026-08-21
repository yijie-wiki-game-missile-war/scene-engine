"""Canonical SceneBootstrap writer/parser for the MW presentation candidate."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
import struct
import unicodedata
from typing import Any, Iterable, Tuple

from .binary_schema import UINT16_MAX, UINT32_MAX, UINT64_MAX
from .errors import ConfigurationError, SceneBootstrapError
from .presentation_schema import (
    ADJACENCY_RECORD_BYTES,
    ADJACENCY_RECORD_V1,
    ANIMATION_ALLOWED_FLAGS,
    ANIMATION_REGISTRY_RECORD_BYTES,
    ANIMATION_REGISTRY_RECORD_V1,
    BOOTSTRAP_IDENTITY_HEADER_BYTES,
    BOOTSTRAP_IDENTITY_HEADER_V1,
    BOOTSTRAP_SECTION_ADJACENCIES,
    BOOTSTRAP_SECTION_ANIMATION_REGISTRY,
    BOOTSTRAP_SECTION_IDENTITY,
    BOOTSTRAP_SECTION_STATIC_NODES,
    BOOTSTRAP_SECTION_TOPOLOGY_NODES,
    BOOTSTRAP_SECTION_VISUAL_REGISTRY,
    MW_TICKS_PER_SECOND,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_V1,
    PRESENTATION_SECTION_FLAG_REQUIRED,
    SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
    SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET,
    SCENE_BOOTSTRAP_HEADER_BYTES,
    SCENE_BOOTSTRAP_HEADER_V1,
    SCENE_BOOTSTRAP_SCHEMA_VERSION,
    STATIC_NODE_ALLOWED_FLAGS,
    STATIC_NODE_RECORD_BYTES,
    STATIC_NODE_RECORD_V1,
    TOPOLOGY_NODE_RECORD_BYTES,
    TOPOLOGY_NODE_RECORD_V1,
    VISUAL_CAPABILITY_ALLOWED,
    VISUAL_REGISTRY_RECORD_BYTES,
    VISUAL_REGISTRY_RECORD_V1,
)


_SECTION_TYPES = (
    BOOTSTRAP_SECTION_IDENTITY,
    BOOTSTRAP_SECTION_STATIC_NODES,
    BOOTSTRAP_SECTION_TOPOLOGY_NODES,
    BOOTSTRAP_SECTION_ADJACENCIES,
    BOOTSTRAP_SECTION_VISUAL_REGISTRY,
    BOOTSTRAP_SECTION_ANIMATION_REGISTRY,
)
_DIRECTORY_BYTES = len(_SECTION_TYPES) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
_PAYLOAD_OFFSET = SCENE_BOOTSTRAP_HEADER_BYTES + _DIRECTORY_BYTES
_MAX_IDENTITY_UTF8_BYTES = 4096
_QUATERNION_TOLERANCE = 1e-3


@dataclass(frozen=True)
class BootstrapIdentityV1:
    run_id: str
    viewer_scope: str
    profile_id: str
    state_stream_id: str
    state_epoch: str
    snapshot_id: str
    state_seq: int
    world_revision: int


@dataclass(frozen=True)
class StaticNodeRecordV1:
    display_id: int
    parent_display_id: int
    visual_type_id: int
    owner_type_id: int
    flags: int
    world_position: Tuple[float, float, float]
    world_rotation_xyzw: Tuple[float, float, float, float]
    world_scale: Tuple[float, float, float]
    variant_id: int
    content_id: int


@dataclass(frozen=True)
class TopologyNodeRecordV1:
    static_display_id: int
    island_type_id: int
    tile_type_id: int
    axial_q: int
    axial_r: int
    terrain_type_id: int
    flags: int = 0


@dataclass(frozen=True)
class AdjacencyRecordV1:
    from_display_id: int
    to_display_id: int


@dataclass(frozen=True)
class VisualRegistryRecordV1:
    visual_type_id: int
    owner_type_id: int
    variant_id: int
    capability_flags: int
    resource_content_id: int
    placement_profile_id: int
    animation_registry_start: int
    animation_registry_count: int


@dataclass(frozen=True)
class AnimationRegistryRecordV1:
    animation_state_id: int
    flags: int
    duration_ticks: int


@dataclass(frozen=True)
class SceneBootstrapHeaderV1:
    schema_version: int
    flags: int
    header_bytes: int
    section_count: int
    scene_epoch: int
    bootstrap_id: int
    ticks_per_second: int
    coordinate_profile: int
    world_units_per_meter: float
    maximum_dynamic_entities: int
    maximum_frame_bytes: int
    directory_bytes: int
    payload_bytes: int
    content_sha256: bytes
    reserved: bytes


@dataclass(frozen=True)
class BootstrapSectionEntryV1:
    section_type: int
    flags: int
    record_count: int
    byte_offset: int
    byte_length: int
    record_stride: int
    reserved0: int


@dataclass(frozen=True)
class SceneBootstrapView:
    header: SceneBootstrapHeaderV1
    identity: BootstrapIdentityV1
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


def encode_scene_bootstrap(
    *,
    scene_epoch: int,
    bootstrap_id: int,
    identity: BootstrapIdentityV1,
    static_nodes: Iterable[StaticNodeRecordV1] = (),
    topology_nodes: Iterable[TopologyNodeRecordV1] = (),
    adjacencies: Iterable[AdjacencyRecordV1] = (),
    visual_registry: Iterable[VisualRegistryRecordV1] = (),
    animation_registry: Iterable[AnimationRegistryRecordV1] = (),
    maximum_dynamic_entities: int,
    maximum_frame_bytes: int,
    world_units_per_meter: float = 1.0,
) -> bytes:
    """Encode a complete static bootstrap without sorting caller input."""

    epoch = _uint("scene_epoch", scene_epoch, UINT64_MAX, minimum=1)
    bootstrap = _uint("bootstrap_id", bootstrap_id, UINT64_MAX, minimum=1)
    dynamic_limit = _uint(
        "maximum_dynamic_entities", maximum_dynamic_entities, UINT32_MAX
    )
    frame_limit = _uint("maximum_frame_bytes", maximum_frame_bytes, UINT32_MAX, minimum=1)
    units = _float32("world_units_per_meter", world_units_per_meter)
    if units <= 0:
        raise SceneBootstrapError("world_units_per_meter must be positive")

    identity_bytes = _encode_identity(identity)
    static_values = tuple(static_nodes)
    topology_values = tuple(topology_nodes)
    adjacency_values = tuple(adjacencies)
    visual_values = tuple(visual_registry)
    animation_values = tuple(animation_registry)

    section_payloads = (
        identity_bytes,
        _encode_static_nodes(static_values),
        _encode_topology_nodes(topology_values),
        _encode_adjacencies(adjacency_values),
        _encode_visual_registry(visual_values),
        _encode_animation_registry(animation_values),
    )
    counts = (
        1,
        len(static_values),
        len(topology_values),
        len(adjacency_values),
        len(visual_values),
        len(animation_values),
    )
    strides = (
        0,
        STATIC_NODE_RECORD_BYTES,
        TOPOLOGY_NODE_RECORD_BYTES,
        ADJACENCY_RECORD_BYTES,
        VISUAL_REGISTRY_RECORD_BYTES,
        ANIMATION_REGISTRY_RECORD_BYTES,
    )

    directory_parts = []
    payload_parts = []
    next_offset = _PAYLOAD_OFFSET
    for section_type, payload, count, stride in zip(
        _SECTION_TYPES, section_payloads, counts, strides
    ):
        if next_offset % 4 != 0:  # pragma: no cover - construction invariant
            raise AssertionError("bootstrap section offset lost alignment")
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
        payload_parts.append(payload)
        next_offset += len(payload)

    directory = b"".join(directory_parts)
    payload = b"".join(payload_parts)
    content_hash = hashlib.sha256(directory + payload).digest()
    header = SCENE_BOOTSTRAP_HEADER_V1.pack(
        SCENE_BOOTSTRAP_SCHEMA_VERSION,
        SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET,
        SCENE_BOOTSTRAP_HEADER_BYTES,
        len(_SECTION_TYPES),
        epoch,
        bootstrap,
        MW_TICKS_PER_SECOND,
        SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
        units,
        dynamic_limit,
        frame_limit,
        len(directory),
        len(payload),
        content_hash,
        b"\x00" * 16,
    )
    return header + directory + payload


def parse_scene_bootstrap(
    data: Any,
    *,
    maximum_bootstrap_bytes: int,
    maximum_static_nodes: int,
    maximum_topology_nodes: int,
    maximum_adjacencies: int,
    maximum_visual_types: int,
    maximum_animation_states: int,
) -> SceneBootstrapView:
    limits = (
        _limit("maximum_bootstrap_bytes", maximum_bootstrap_bytes),
        _limit("maximum_static_nodes", maximum_static_nodes),
        _limit("maximum_topology_nodes", maximum_topology_nodes),
        _limit("maximum_adjacencies", maximum_adjacencies),
        _limit("maximum_visual_types", maximum_visual_types),
        _limit("maximum_animation_states", maximum_animation_states),
    )
    view0 = _byte_view(data)
    if view0.nbytes > limits[0]:
        raise SceneBootstrapError("bootstrap exceeds maximum_bootstrap_bytes")
    if view0.nbytes < SCENE_BOOTSTRAP_HEADER_BYTES:
        raise SceneBootstrapError("bootstrap is shorter than SceneBootstrapHeaderV1")
    canonical = data if isinstance(data, bytes) else view0.tobytes()
    view = memoryview(canonical)
    header = SceneBootstrapHeaderV1(*SCENE_BOOTSTRAP_HEADER_V1.unpack_from(view, 0))
    _validate_header(header, len(canonical))

    entries = _parse_directory(view, header, limits[1:])
    content = view[header.header_bytes:].tobytes()
    if hashlib.sha256(content).digest() != header.content_sha256:
        raise SceneBootstrapError("bootstrap content_sha256 mismatch")

    identity = _parse_identity(view, entries[0])
    static_nodes = _parse_static_nodes(view, entries[1])
    topology_nodes = _parse_topology_nodes(view, entries[2])
    adjacencies = _parse_adjacencies(view, entries[3])
    visual_registry = _parse_visual_registry(view, entries[4])
    animation_registry = _parse_animation_registry(view, entries[5])
    _validate_cross_references(
        static_nodes,
        topology_nodes,
        adjacencies,
        visual_registry,
        animation_registry,
    )
    return SceneBootstrapView(
        header=header,
        identity=identity,
        static_nodes=static_nodes,
        topology_nodes=topology_nodes,
        adjacencies=adjacencies,
        visual_registry=visual_registry,
        animation_registry=animation_registry,
        directory=entries,
        data=canonical,
    )


def _encode_identity(identity: BootstrapIdentityV1) -> bytes:
    if not isinstance(identity, BootstrapIdentityV1):
        raise SceneBootstrapError("identity must be BootstrapIdentityV1")
    strings = (
        identity.run_id,
        identity.viewer_scope,
        identity.profile_id,
        identity.state_stream_id,
        identity.state_epoch,
        identity.snapshot_id,
    )
    encoded = tuple(_identity_string(value) for value in strings)
    total = sum(len(value) for value in encoded)
    if total > _MAX_IDENTITY_UTF8_BYTES:
        raise SceneBootstrapError("bootstrap identity strings exceed byte limit")
    state_seq = _uint("state_seq", identity.state_seq, UINT64_MAX)
    world_revision = _uint("world_revision", identity.world_revision, UINT64_MAX)
    header = BOOTSTRAP_IDENTITY_HEADER_V1.pack(
        *(len(value) for value in encoded),
        total,
        state_seq,
        world_revision,
    )
    value = header + b"".join(encoded)
    return value + b"\x00" * ((_align4(len(value)) - len(value)))


def _encode_static_nodes(values: Tuple[StaticNodeRecordV1, ...]) -> bytes:
    parts = []
    previous = 0
    for record in values:
        display_id = _uint("static.display_id", record.display_id, UINT64_MAX, minimum=1)
        if display_id <= previous:
            raise SceneBootstrapError("static display_id values must be strictly increasing")
        parent = _uint("static.parent_display_id", record.parent_display_id, UINT64_MAX)
        if parent >= display_id and parent != 0:
            raise SceneBootstrapError("static parent_display_id must precede its child")
        flags = _uint("static.flags", record.flags, UINT32_MAX)
        if flags & ~STATIC_NODE_ALLOWED_FLAGS:
            raise SceneBootstrapError("static node contains unknown flags")
        position, rotation, scale = _pose(
            record.world_position, record.world_rotation_xyzw, record.world_scale
        )
        parts.append(
            STATIC_NODE_RECORD_V1.pack(
                display_id,
                parent,
                _uint("static.visual_type_id", record.visual_type_id, UINT32_MAX, minimum=1),
                _uint("static.owner_type_id", record.owner_type_id, UINT32_MAX, minimum=1),
                flags,
                0,
                *position,
                *rotation,
                *scale,
                _uint("static.variant_id", record.variant_id, UINT32_MAX),
                _uint("static.content_id", record.content_id, UINT32_MAX, minimum=1),
            )
        )
        previous = display_id
    return b"".join(parts)


def _encode_topology_nodes(values: Tuple[TopologyNodeRecordV1, ...]) -> bytes:
    parts = []
    previous = 0
    for record in values:
        display_id = _uint("topology.static_display_id", record.static_display_id, UINT64_MAX, minimum=1)
        if display_id <= previous:
            raise SceneBootstrapError("topology display IDs must be strictly increasing")
        parts.append(
            TOPOLOGY_NODE_RECORD_V1.pack(
                display_id,
                _uint("topology.island_type_id", record.island_type_id, UINT32_MAX, minimum=1),
                _uint("topology.tile_type_id", record.tile_type_id, UINT32_MAX, minimum=1),
                _int32("topology.axial_q", record.axial_q),
                _int32("topology.axial_r", record.axial_r),
                _uint("topology.terrain_type_id", record.terrain_type_id, UINT32_MAX, minimum=1),
                _uint("topology.flags", record.flags, UINT32_MAX),
            )
        )
        previous = display_id
    return b"".join(parts)


def _encode_adjacencies(values: Tuple[AdjacencyRecordV1, ...]) -> bytes:
    parts = []
    previous = (0, 0)
    for record in values:
        pair = (
            _uint("adjacency.from_display_id", record.from_display_id, UINT64_MAX, minimum=1),
            _uint("adjacency.to_display_id", record.to_display_id, UINT64_MAX, minimum=1),
        )
        if pair[0] >= pair[1]:
            raise SceneBootstrapError("adjacency endpoints must use canonical ascending order")
        if pair <= previous:
            raise SceneBootstrapError("adjacency records must be strictly increasing")
        parts.append(ADJACENCY_RECORD_V1.pack(*pair))
        previous = pair
    return b"".join(parts)


def _encode_visual_registry(values: Tuple[VisualRegistryRecordV1, ...]) -> bytes:
    parts = []
    previous = 0
    for record in values:
        visual_id = _uint("visual.visual_type_id", record.visual_type_id, UINT32_MAX, minimum=1)
        if visual_id <= previous:
            raise SceneBootstrapError("visual_type_id values must be strictly increasing")
        capabilities = _uint("visual.capability_flags", record.capability_flags, UINT32_MAX)
        if capabilities & ~VISUAL_CAPABILITY_ALLOWED:
            raise SceneBootstrapError("visual registry contains unknown capability flags")
        parts.append(
            VISUAL_REGISTRY_RECORD_V1.pack(
                visual_id,
                _uint("visual.owner_type_id", record.owner_type_id, UINT32_MAX, minimum=1),
                _uint("visual.variant_id", record.variant_id, UINT32_MAX),
                capabilities,
                _uint("visual.resource_content_id", record.resource_content_id, UINT32_MAX, minimum=1),
                _uint("visual.placement_profile_id", record.placement_profile_id, UINT32_MAX, minimum=1),
                _uint("visual.animation_registry_start", record.animation_registry_start, UINT32_MAX),
                _uint("visual.animation_registry_count", record.animation_registry_count, UINT32_MAX),
            )
        )
        previous = visual_id
    return b"".join(parts)


def _encode_animation_registry(values: Tuple[AnimationRegistryRecordV1, ...]) -> bytes:
    parts = []
    previous = 0
    for record in values:
        animation_id = _uint("animation.animation_state_id", record.animation_state_id, UINT32_MAX, minimum=1)
        if animation_id <= previous:
            raise SceneBootstrapError("animation_state_id values must be strictly increasing")
        flags = _uint("animation.flags", record.flags, UINT32_MAX)
        if flags & ~ANIMATION_ALLOWED_FLAGS:
            raise SceneBootstrapError("animation registry contains unknown flags")
        parts.append(
            ANIMATION_REGISTRY_RECORD_V1.pack(
                animation_id,
                flags,
                _uint("animation.duration_ticks", record.duration_ticks, UINT32_MAX, minimum=1),
                0,
            )
        )
        previous = animation_id
    return b"".join(parts)


def _validate_header(header: SceneBootstrapHeaderV1, total_size: int) -> None:
    if header.schema_version != SCENE_BOOTSTRAP_SCHEMA_VERSION:
        raise SceneBootstrapError("unsupported bootstrap schema_version")
    if header.flags != SCENE_BOOTSTRAP_FLAG_COMPLETE_STATIC_SET:
        raise SceneBootstrapError("bootstrap flags are not canonical")
    if header.header_bytes != SCENE_BOOTSTRAP_HEADER_BYTES:
        raise SceneBootstrapError("bootstrap header_bytes must be 96")
    if header.section_count != len(_SECTION_TYPES):
        raise SceneBootstrapError("bootstrap requires exactly six sections")
    if header.scene_epoch == 0 or header.bootstrap_id == 0:
        raise SceneBootstrapError("bootstrap identities must be positive")
    if header.ticks_per_second != MW_TICKS_PER_SECOND:
        raise SceneBootstrapError("MW bootstrap ticks_per_second must be 60")
    if header.coordinate_profile != SCENE_BOOTSTRAP_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32:
        raise SceneBootstrapError("unsupported bootstrap coordinate profile")
    if not math.isfinite(header.world_units_per_meter) or header.world_units_per_meter <= 0:
        raise SceneBootstrapError("world_units_per_meter must be finite and positive")
    if header.maximum_frame_bytes == 0:
        raise SceneBootstrapError("maximum_frame_bytes must be positive")
    if header.directory_bytes != _DIRECTORY_BYTES:
        raise SceneBootstrapError("bootstrap directory_bytes mismatch")
    if header.header_bytes + header.directory_bytes + header.payload_bytes != total_size:
        raise SceneBootstrapError("bootstrap length does not match header")
    if header.reserved != b"\x00" * 16:
        raise SceneBootstrapError("bootstrap reserved bytes must be zero")


def _parse_directory(view, header, count_limits) -> Tuple[BootstrapSectionEntryV1, ...]:
    entries = []
    previous_end = _PAYLOAD_OFFSET
    strides = (0, STATIC_NODE_RECORD_BYTES, TOPOLOGY_NODE_RECORD_BYTES,
               ADJACENCY_RECORD_BYTES, VISUAL_REGISTRY_RECORD_BYTES,
               ANIMATION_REGISTRY_RECORD_BYTES)
    for index, (section_type, stride, count_limit) in enumerate(
        zip(_SECTION_TYPES, strides, (1,) + tuple(count_limits))
    ):
        offset = SCENE_BOOTSTRAP_HEADER_BYTES + index * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
        entry = BootstrapSectionEntryV1(*PRESENTATION_SECTION_DIRECTORY_ENTRY_V1.unpack_from(view, offset))
        if entry.section_type != section_type or entry.flags != PRESENTATION_SECTION_FLAG_REQUIRED:
            raise SceneBootstrapError("bootstrap section directory is non-canonical")
        if entry.reserved0 != 0 or entry.record_stride != stride:
            raise SceneBootstrapError("bootstrap section stride/reserved mismatch")
        if entry.record_count > count_limit:
            raise SceneBootstrapError("bootstrap section exceeds local record limit")
        if section_type == BOOTSTRAP_SECTION_IDENTITY:
            if entry.record_count != 1 or entry.byte_length < BOOTSTRAP_IDENTITY_HEADER_BYTES:
                raise SceneBootstrapError("bootstrap identity section is invalid")
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


def _parse_identity(view, entry) -> BootstrapIdentityV1:
    values = BOOTSTRAP_IDENTITY_HEADER_V1.unpack_from(view, entry.byte_offset)
    lengths = values[:6]
    total = values[6]
    if any(length == 0 for length in lengths) or total != sum(lengths):
        raise SceneBootstrapError("bootstrap identity lengths are invalid")
    if total > _MAX_IDENTITY_UTF8_BYTES:
        raise SceneBootstrapError("bootstrap identity strings exceed byte limit")
    raw_end = entry.byte_offset + BOOTSTRAP_IDENTITY_HEADER_BYTES + total
    section_end = entry.byte_offset + entry.byte_length
    if _align4(BOOTSTRAP_IDENTITY_HEADER_BYTES + total) != entry.byte_length:
        raise SceneBootstrapError("bootstrap identity padding is non-canonical")
    if any(view[raw_end:section_end]):
        raise SceneBootstrapError("bootstrap identity padding must be zero")
    cursor = entry.byte_offset + BOOTSTRAP_IDENTITY_HEADER_BYTES
    strings = []
    for length in lengths:
        strings.append(_decode_identity(view[cursor:cursor + length].tobytes()))
        cursor += length
    return BootstrapIdentityV1(*strings, state_seq=values[7], world_revision=values[8])


def _parse_static_nodes(view, entry):
    result = []
    previous = 0
    for index in range(entry.record_count):
        raw = STATIC_NODE_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        record = StaticNodeRecordV1(
            display_id=raw[0], parent_display_id=raw[1], visual_type_id=raw[2],
            owner_type_id=raw[3], flags=raw[4],
            world_position=tuple(raw[6:9]), world_rotation_xyzw=tuple(raw[9:13]),
            world_scale=tuple(raw[13:16]), variant_id=raw[16], content_id=raw[17],
        )
        if raw[5] != 0 or record.display_id <= previous or record.display_id == 0:
            raise SceneBootstrapError("static node identity/reserved is invalid")
        if record.parent_display_id and record.parent_display_id >= record.display_id:
            raise SceneBootstrapError("static parent must precede child")
        if record.visual_type_id == 0 or record.owner_type_id == 0 or record.content_id == 0:
            raise SceneBootstrapError("static node registry IDs must be positive")
        if record.flags & ~STATIC_NODE_ALLOWED_FLAGS:
            raise SceneBootstrapError("static node contains unknown flags")
        _validate_pose(record.world_position, record.world_rotation_xyzw, record.world_scale)
        result.append(record)
        previous = record.display_id
    return tuple(result)


def _parse_topology_nodes(view, entry):
    result = []
    previous = 0
    for index in range(entry.record_count):
        raw = TOPOLOGY_NODE_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        record = TopologyNodeRecordV1(*raw)
        if record.static_display_id == 0 or record.static_display_id <= previous:
            raise SceneBootstrapError("topology IDs must be positive and increasing")
        if min(record.island_type_id, record.tile_type_id, record.terrain_type_id) == 0:
            raise SceneBootstrapError("topology registry IDs must be positive")
        if record.flags != 0:
            raise SceneBootstrapError("topology flags are not defined")
        result.append(record)
        previous = record.static_display_id
    return tuple(result)


def _parse_adjacencies(view, entry):
    result = []
    previous = (0, 0)
    for index in range(entry.record_count):
        pair = ADJACENCY_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        if pair[0] == 0 or pair[0] >= pair[1] or pair <= previous:
            raise SceneBootstrapError("adjacency order is non-canonical")
        result.append(AdjacencyRecordV1(*pair))
        previous = pair
    return tuple(result)


def _parse_visual_registry(view, entry):
    result = []
    previous = 0
    for index in range(entry.record_count):
        raw = VISUAL_REGISTRY_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        record = VisualRegistryRecordV1(*raw)
        if record.visual_type_id == 0 or record.visual_type_id <= previous:
            raise SceneBootstrapError("visual registry IDs must be increasing")
        if min(record.owner_type_id, record.resource_content_id, record.placement_profile_id) == 0:
            raise SceneBootstrapError("visual registry references must be positive")
        if record.capability_flags & ~VISUAL_CAPABILITY_ALLOWED:
            raise SceneBootstrapError("visual registry contains unknown capabilities")
        result.append(record)
        previous = record.visual_type_id
    return tuple(result)


def _parse_animation_registry(view, entry):
    result = []
    previous = 0
    for index in range(entry.record_count):
        raw = ANIMATION_REGISTRY_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        record = AnimationRegistryRecordV1(raw[0], raw[1], raw[2])
        if raw[3] != 0 or record.animation_state_id == 0 or record.animation_state_id <= previous:
            raise SceneBootstrapError("animation identity/reserved is invalid")
        if record.duration_ticks == 0 or record.flags & ~ANIMATION_ALLOWED_FLAGS:
            raise SceneBootstrapError("animation registry state is invalid")
        result.append(record)
        previous = record.animation_state_id
    return tuple(result)


def _validate_cross_references(static_nodes, topology, adjacencies, visuals, animations):
    static_ids = {record.display_id for record in static_nodes}
    static_by_id = {record.display_id: record for record in static_nodes}
    visual_ids = {record.visual_type_id for record in visuals}
    animation_count = len(animations)
    for record in static_nodes:
        if record.parent_display_id and record.parent_display_id not in static_ids:
            raise SceneBootstrapError("static node parent is missing")
        if record.visual_type_id not in visual_ids:
            raise SceneBootstrapError("static node visual_type_id is missing from registry")
    for record in topology:
        tile = static_by_id.get(record.static_display_id)
        island = static_by_id.get(tile.parent_display_id) if tile is not None else None
        if (
            tile is None
            or island is None
            or island.parent_display_id != 0
        ):
            raise SceneBootstrapError(
                "topology node references an invalid static island parent"
            )
    topology_ids = {record.static_display_id for record in topology}
    if any(static_by_id[record.static_display_id].parent_display_id in topology_ids for record in topology):
        raise SceneBootstrapError("static island parent cannot also be a topology tile")
    for record in adjacencies:
        if record.from_display_id not in topology_ids or record.to_display_id not in topology_ids:
            raise SceneBootstrapError("adjacency references missing topology node")
    for record in visuals:
        end = record.animation_registry_start + record.animation_registry_count
        if end > animation_count:
            raise SceneBootstrapError("visual animation registry range is out of bounds")


def _pose(position, rotation, scale):
    canonical = (
        tuple(_float32("position", value) for value in position),
        tuple(_float32("rotation", value) for value in rotation),
        tuple(_float32("scale", value) for value in scale),
    )
    if tuple(map(len, canonical)) != (3, 4, 3):
        raise SceneBootstrapError("static pose has an invalid component count")
    _validate_pose(*canonical)
    return canonical


def _validate_pose(position, rotation, scale):
    if not all(math.isfinite(value) for value in position + rotation + scale):
        raise SceneBootstrapError("static pose values must be finite")
    norm = math.sqrt(sum(value * value for value in rotation))
    if abs(norm - 1.0) > _QUATERNION_TOLERANCE:
        raise SceneBootstrapError("static quaternion is not normalized")


def _identity_string(value: Any) -> bytes:
    if not isinstance(value, str) or not value or value.strip() != value or "\x00" in value:
        raise SceneBootstrapError("bootstrap identity must be a non-empty canonical string")
    if unicodedata.normalize("NFC", value) != value:
        raise SceneBootstrapError("bootstrap identity strings must use NFC")
    encoded = value.encode("utf-8")
    if len(encoded) > UINT16_MAX:
        raise SceneBootstrapError("bootstrap identity string is too long")
    return encoded


def _decode_identity(value: bytes) -> str:
    try:
        decoded = value.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise SceneBootstrapError("bootstrap identity is not valid UTF-8") from exc
    _identity_string(decoded)
    return decoded


def _align4(value: int) -> int:
    return (value + 3) & ~3


def _uint(name, value, maximum, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise SceneBootstrapError("{} is outside the frozen integer range".format(name))
    return value


def _int32(name, value):
    if isinstance(value, bool) or not isinstance(value, int) or not -(1 << 31) <= value < (1 << 31):
        raise SceneBootstrapError("{} must be signed int32".format(name))
    return value


def _float32(name, value):
    if isinstance(value, bool):
        raise SceneBootstrapError("{} must be float32".format(name))
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
    "AdjacencyRecordV1",
    "AnimationRegistryRecordV1",
    "BootstrapIdentityV1",
    "BootstrapSectionEntryV1",
    "SceneBootstrapHeaderV1",
    "SceneBootstrapView",
    "StaticNodeRecordV1",
    "TopologyNodeRecordV1",
    "VisualRegistryRecordV1",
    "encode_scene_bootstrap",
    "parse_scene_bootstrap",
]
