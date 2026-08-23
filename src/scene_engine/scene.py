"""Renderer-neutral ``scene-engine-scene@1`` binary body codec.

Outer Engine packets own stream, commit, tick, revision, and causation.  Scene
bodies contain only the static catalog or one complete dynamic node set.
"""

from __future__ import annotations

import hashlib
import math
import struct
from dataclasses import dataclass, replace
from typing import Any, Iterable, Sequence

from .errors import SceneCodecError


SCENE_CODEC = "scene-engine-scene@1"
SCENE_TICKS_PER_SECOND = 60
SCENE_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32 = 1

_UINT16_MAX = (1 << 16) - 1
_UINT32_MAX = (1 << 32) - 1
_UINT64_MAX = (1 << 64) - 1
_REQUIRED = 1
_NODE_VISIBLE = 1
_VISUAL_ALLOWED_FLAGS = 0b111
_ANIMATION_ALLOWED_FLAGS = 0b111
_EVENT_ALLOWED_FLAGS = 0b1

_DIRECTORY_ENTRY = struct.Struct("<HHIIIHH")
_BOOTSTRAP_HEADER = struct.Struct("<HHHHHHfIIII32s16s")
_FRAME_HEADER = struct.Struct("<HHHHIIIIII8s")
_NODE_RECORD = struct.Struct("<QQII3f4f3fIQI")
_PAYLOAD_REF = struct.Struct("<QIIII")
_METADATA_REF = struct.Struct("<IIII")
_VISUAL_RECORD = struct.Struct("<IIII")
_ANIMATION_RECORD = struct.Struct("<IIII")
_EVENT_RECORD = struct.Struct("<QIIQQQII")

_BOOTSTRAP_VERSION = 1
_FRAME_VERSION = 1
_BOOTSTRAP_COMPLETE = 1
_FRAME_COMPLETE = 1
_BOOTSTRAP_TYPES = (1, 2, 3, 4, 5, 6, 7, 8, 9)
_BOOTSTRAP_STRIDES = (
    _NODE_RECORD.size,
    _PAYLOAD_REF.size,
    1,
    _PAYLOAD_REF.size,
    1,
    _METADATA_REF.size,
    1,
    _VISUAL_RECORD.size,
    _ANIMATION_RECORD.size,
)
_FRAME_TYPES = (1, 2, 3, 4, 5, 6, 7)
_FRAME_STRIDES = (
    _NODE_RECORD.size,
    _PAYLOAD_REF.size,
    1,
    _PAYLOAD_REF.size,
    1,
    _EVENT_RECORD.size,
    1,
)


@dataclass(frozen=True, slots=True)
class OpaquePayload:
    payload_type_id: int
    data: bytes
    flags: int = 0


@dataclass(frozen=True, slots=True)
class SceneMetadata:
    metadata_type_id: int
    data: bytes
    flags: int = 0


@dataclass(frozen=True, slots=True)
class VisualType:
    visual_type_id: int
    flags: int = 0
    profile_type_id: int = 0
    interaction_type_id: int = 0


@dataclass(frozen=True, slots=True)
class AnimationState:
    animation_state_id: int
    flags: int
    duration_ticks: int


@dataclass(frozen=True, slots=True)
class SceneNode:
    display_id: int
    parent_display_id: int
    visual_type_id: int
    flags: int
    local_position: tuple[float, float, float]
    local_rotation_xyzw: tuple[float, float, float, float]
    local_scale: tuple[float, float, float]
    animation_state_id: int = 0
    animation_start_tick: int = 0
    animation_flags: int = 0
    profile: OpaquePayload | None = None
    interaction: OpaquePayload | None = None


@dataclass(frozen=True, slots=True)
class SceneEvent:
    event_id: int
    event_type_id: int
    flags: int
    source_display_id: int
    target_display_id: int
    start_tick: int
    payload: bytes = b""


@dataclass(frozen=True, slots=True)
class SceneSection:
    section_type: int
    flags: int
    record_count: int
    byte_offset: int
    byte_length: int
    record_stride: int
    reserved: int


@dataclass(frozen=True, slots=True)
class SceneBootstrapHeader:
    schema_version: int
    flags: int
    header_bytes: int
    section_count: int
    ticks_per_second: int
    coordinate_profile: int
    world_units_per_meter: float
    maximum_dynamic_nodes: int
    maximum_frame_bytes: int
    directory_bytes: int
    payload_bytes: int
    content_sha256: bytes
    reserved: bytes


@dataclass(frozen=True, slots=True)
class SceneBootstrapView:
    header: SceneBootstrapHeader
    static_nodes: tuple[SceneNode, ...]
    scene_metadata: tuple[SceneMetadata, ...]
    visual_types: tuple[VisualType, ...]
    animation_states: tuple[AnimationState, ...]
    directory: tuple[SceneSection, ...]
    data: bytes


@dataclass(frozen=True, slots=True)
class SceneFrameHeader:
    schema_version: int
    flags: int
    header_bytes: int
    section_count: int
    node_count: int
    profile_count: int
    interaction_count: int
    payload_bytes: int
    directory_bytes: int
    event_count: int
    reserved: bytes


@dataclass(frozen=True, slots=True)
class SceneFrameView:
    header: SceneFrameHeader
    source_tick: int
    nodes: tuple[SceneNode, ...]
    events: tuple[SceneEvent, ...]
    directory: tuple[SceneSection, ...]
    data: bytes


def encode_scene_bootstrap(
    *,
    maximum_dynamic_nodes: int,
    maximum_frame_bytes: int,
    static_nodes: Iterable[SceneNode] = (),
    scene_metadata: Iterable[SceneMetadata] = (),
    visual_types: Iterable[VisualType] = (),
    animation_states: Iterable[AnimationState] = (),
    ticks_per_second: int = SCENE_TICKS_PER_SECOND,
    coordinate_profile: int = SCENE_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32,
    world_units_per_meter: float = 1.0,
) -> bytes:
    _require_60(ticks_per_second)
    _uint(coordinate_profile, "coordinate_profile", _UINT16_MAX, minimum=1)
    maximum_nodes = _uint(maximum_dynamic_nodes, "maximum_dynamic_nodes", _UINT32_MAX)
    maximum_bytes = _uint(
        maximum_frame_bytes, "maximum_frame_bytes", _UINT32_MAX, minimum=1
    )
    world_units = _finite(world_units_per_meter, "world_units_per_meter")
    if world_units <= 0:
        raise SceneCodecError("world_units_per_meter must be positive")
    nodes = tuple(static_nodes)
    metadata = tuple(scene_metadata)
    visuals = tuple(visual_types)
    animations = tuple(animation_states)
    _validate_visuals(visuals)
    _validate_animations(animations)
    _validate_nodes(nodes, visuals, animations, source_tick=None)
    _validate_tree(nodes, (), maximum_depth=64)
    _validate_metadata(metadata)
    if len(nodes) > _UINT32_MAX:
        raise SceneCodecError("static node count exceeds uint32")

    node_bytes = _encode_nodes(nodes)
    profile_refs, profile_blob, _ = _encode_node_payloads(nodes, "profile")
    interaction_refs, interaction_blob, _ = _encode_node_payloads(
        nodes, "interaction"
    )
    metadata_refs, metadata_blob = _encode_metadata(metadata)
    visual_bytes = b"".join(
        _VISUAL_RECORD.pack(
            item.visual_type_id,
            item.flags,
            item.profile_type_id,
            item.interaction_type_id,
        )
        for item in visuals
    )
    animation_bytes = b"".join(
        _ANIMATION_RECORD.pack(
            item.animation_state_id, item.flags, item.duration_ticks, 0
        )
        for item in animations
    )
    sections = (
        (len(nodes), _NODE_RECORD.size, node_bytes),
        (len(nodes), _PAYLOAD_REF.size, profile_refs),
        (len(profile_blob), 1, _pad4(profile_blob)),
        (len(nodes), _PAYLOAD_REF.size, interaction_refs),
        (len(interaction_blob), 1, _pad4(interaction_blob)),
        (len(metadata), _METADATA_REF.size, metadata_refs),
        (len(metadata_blob), 1, _pad4(metadata_blob)),
        (len(visuals), _VISUAL_RECORD.size, visual_bytes),
        (len(animations), _ANIMATION_RECORD.size, animation_bytes),
    )
    directory, payload = _encode_sections(
        _BOOTSTRAP_HEADER.size, _BOOTSTRAP_TYPES, sections
    )
    header = _BOOTSTRAP_HEADER.pack(
        _BOOTSTRAP_VERSION,
        _BOOTSTRAP_COMPLETE,
        _BOOTSTRAP_HEADER.size,
        len(sections),
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


def parse_scene_bootstrap(
    data: Any,
    *,
    maximum_bootstrap_bytes: int = 64 * 1024 * 1024,
    maximum_static_nodes: int = 1_000_000,
    maximum_scene_metadata: int = 65_536,
    maximum_visual_types: int = 65_536,
    maximum_animation_states: int = 65_536,
    maximum_tree_depth: int = 64,
) -> SceneBootstrapView:
    raw = _body_bytes(data, maximum_bootstrap_bytes, "bootstrap")
    if len(raw) < _BOOTSTRAP_HEADER.size:
        raise SceneCodecError("bootstrap header is truncated")
    header = SceneBootstrapHeader(*_BOOTSTRAP_HEADER.unpack_from(raw))
    if (
        header.schema_version != _BOOTSTRAP_VERSION
        or header.flags != _BOOTSTRAP_COMPLETE
        or header.header_bytes != _BOOTSTRAP_HEADER.size
        or header.section_count != len(_BOOTSTRAP_TYPES)
        or header.ticks_per_second != SCENE_TICKS_PER_SECOND
        or header.coordinate_profile
        != SCENE_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32
        or not math.isfinite(header.world_units_per_meter)
        or header.world_units_per_meter <= 0
        or header.maximum_frame_bytes == 0
        or header.directory_bytes != len(_BOOTSTRAP_TYPES) * _DIRECTORY_ENTRY.size
        or header.header_bytes + header.directory_bytes + header.payload_bytes
        != len(raw)
        or header.reserved != b"\x00" * 16
    ):
        raise SceneCodecError("bootstrap header is non-canonical")
    if hashlib.sha256(raw[header.header_bytes :]).digest() != header.content_sha256:
        raise SceneCodecError("bootstrap content hash mismatch")
    entries = _parse_sections(
        raw,
        header_bytes=_BOOTSTRAP_HEADER.size,
        section_types=_BOOTSTRAP_TYPES,
        strides=_BOOTSTRAP_STRIDES,
        limits=(
            maximum_static_nodes,
            maximum_static_nodes,
            _UINT32_MAX,
            maximum_static_nodes,
            _UINT32_MAX,
            maximum_scene_metadata,
            _UINT32_MAX,
            maximum_visual_types,
            maximum_animation_states,
        ),
        variable=frozenset((2, 4, 6)),
    )
    visuals = _parse_visuals(raw, entries[7])
    animations = _parse_animations(raw, entries[8])
    bare_nodes = _parse_nodes(raw, entries[0])
    profiles = _parse_node_payloads(raw, entries[1], entries[2], bare_nodes)
    interactions = _parse_node_payloads(raw, entries[3], entries[4], bare_nodes)
    nodes = _attach_payloads(bare_nodes, profiles, interactions)
    metadata = _parse_metadata(raw, entries[5], entries[6])
    _validate_visuals(visuals)
    _validate_animations(animations)
    _validate_nodes(nodes, visuals, animations, source_tick=None)
    _validate_tree(nodes, (), maximum_depth=maximum_tree_depth)
    _validate_metadata(metadata)
    return SceneBootstrapView(
        header, nodes, metadata, visuals, animations, entries, raw
    )


def encode_scene_frame(
    *,
    source_tick: int,
    nodes: Iterable[SceneNode],
    events: Iterable[SceneEvent] = (),
) -> bytes:
    tick = _uint(source_tick, "source_tick", _UINT64_MAX)
    nodes = tuple(nodes)
    events = tuple(events)
    _validate_nodes(nodes, None, None, source_tick=tick)
    _validate_events(events, tick)
    if len(nodes) > _UINT32_MAX or len(events) > _UINT32_MAX:
        raise SceneCodecError("frame record count exceeds uint32")
    node_bytes = _encode_nodes(nodes)
    profile_refs, profile_blob, profile_count = _encode_node_payloads(
        nodes, "profile"
    )
    interaction_refs, interaction_blob, interaction_count = _encode_node_payloads(
        nodes, "interaction"
    )
    event_records, event_blob = _encode_events(events)
    sections = (
        (len(nodes), _NODE_RECORD.size, node_bytes),
        (len(nodes), _PAYLOAD_REF.size, profile_refs),
        (len(profile_blob), 1, _pad4(profile_blob)),
        (len(nodes), _PAYLOAD_REF.size, interaction_refs),
        (len(interaction_blob), 1, _pad4(interaction_blob)),
        (len(events), _EVENT_RECORD.size, event_records),
        (len(event_blob), 1, _pad4(event_blob)),
    )
    directory, payload = _encode_sections(_FRAME_HEADER.size, _FRAME_TYPES, sections)
    header = _FRAME_HEADER.pack(
        _FRAME_VERSION,
        _FRAME_COMPLETE,
        _FRAME_HEADER.size,
        len(sections),
        len(nodes),
        profile_count,
        interaction_count,
        len(payload),
        len(directory),
        len(events),
        b"\x00" * 8,
    )
    return header + directory + payload


def parse_scene_frame(
    data: Any,
    *,
    source_tick: int,
    maximum_frame_nodes: int = 1_000_000,
    maximum_frame_events: int = 1_000_000,
    maximum_frame_bytes: int = 64 * 1024 * 1024,
) -> SceneFrameView:
    tick = _uint(source_tick, "source_tick", _UINT64_MAX)
    raw = _body_bytes(data, maximum_frame_bytes, "frame")
    if len(raw) < _FRAME_HEADER.size:
        raise SceneCodecError("frame header is truncated")
    header = SceneFrameHeader(*_FRAME_HEADER.unpack_from(raw))
    if (
        header.schema_version != _FRAME_VERSION
        or header.flags != _FRAME_COMPLETE
        or header.header_bytes != _FRAME_HEADER.size
        or header.section_count != len(_FRAME_TYPES)
        or header.node_count > maximum_frame_nodes
        or header.event_count > maximum_frame_events
        or header.profile_count > header.node_count
        or header.interaction_count > header.node_count
        or header.directory_bytes != len(_FRAME_TYPES) * _DIRECTORY_ENTRY.size
        or header.header_bytes + header.directory_bytes + header.payload_bytes
        != len(raw)
        or header.reserved != b"\x00" * 8
    ):
        raise SceneCodecError("frame header is non-canonical")
    entries = _parse_sections(
        raw,
        header_bytes=_FRAME_HEADER.size,
        section_types=_FRAME_TYPES,
        strides=_FRAME_STRIDES,
        limits=(
            header.node_count,
            header.node_count,
            _UINT32_MAX,
            header.node_count,
            _UINT32_MAX,
            header.event_count,
            _UINT32_MAX,
        ),
        exact={
            0: header.node_count,
            1: header.node_count,
            3: header.node_count,
            5: header.event_count,
        },
        variable=frozenset((2, 4, 6)),
    )
    bare_nodes = _parse_nodes(raw, entries[0])
    profiles = _parse_node_payloads(raw, entries[1], entries[2], bare_nodes)
    interactions = _parse_node_payloads(raw, entries[3], entries[4], bare_nodes)
    nodes = _attach_payloads(bare_nodes, profiles, interactions)
    events = _parse_events(raw, entries[5], entries[6])
    if sum(item is not None for item in profiles) != header.profile_count:
        raise SceneCodecError("frame profile_count mismatch")
    if sum(item is not None for item in interactions) != header.interaction_count:
        raise SceneCodecError("frame interaction_count mismatch")
    _validate_nodes(nodes, None, None, source_tick=tick)
    _validate_events(events, tick)
    return SceneFrameView(header, tick, nodes, events, entries, raw)


def validate_scene_tree(
    nodes: Iterable[SceneNode],
    *,
    static_nodes: Iterable[SceneNode] = (),
    maximum_depth: int = 64,
) -> dict[int, tuple[float, ...]]:
    """Validate the sole parent/local tree and return derived world poses."""

    return _validate_tree(tuple(nodes), tuple(static_nodes), maximum_depth=maximum_depth)


def validate_scene_frame_against_bootstrap(
    frame: SceneFrameView,
    bootstrap: SceneBootstrapView,
    *,
    maximum_depth: int = 64,
) -> dict[int, tuple[float, ...]]:
    """Validate a complete frame against the stream-frozen catalog and tree."""

    if not isinstance(frame, SceneFrameView) or not isinstance(
        bootstrap, SceneBootstrapView
    ):
        raise SceneCodecError("frame and bootstrap views are required")
    if (
        len(frame.data) > bootstrap.header.maximum_frame_bytes
        or len(frame.nodes) > bootstrap.header.maximum_dynamic_nodes
    ):
        raise SceneCodecError("frame exceeds bootstrap limits")
    _validate_nodes(
        frame.nodes,
        bootstrap.visual_types,
        bootstrap.animation_states,
        source_tick=frame.source_tick,
    )
    return _validate_tree(
        frame.nodes,
        bootstrap.static_nodes,
        maximum_depth=maximum_depth,
    )


def _encode_nodes(nodes: Sequence[SceneNode]) -> bytes:
    return b"".join(
        _NODE_RECORD.pack(
            node.display_id,
            node.parent_display_id,
            node.visual_type_id,
            node.flags,
            *node.local_position,
            *node.local_rotation_xyzw,
            *node.local_scale,
            node.animation_state_id,
            node.animation_start_tick,
            node.animation_flags,
        )
        for node in nodes
    )


def _parse_nodes(raw: bytes, entry: SceneSection) -> tuple[SceneNode, ...]:
    result = []
    for index in range(entry.record_count):
        values = _NODE_RECORD.unpack_from(raw, entry.byte_offset + index * _NODE_RECORD.size)
        result.append(
            SceneNode(
                values[0],
                values[1],
                values[2],
                values[3],
                tuple(values[4:7]),
                tuple(values[7:11]),
                tuple(values[11:14]),
                values[14],
                values[15],
                values[16],
            )
        )
    return tuple(result)


def _encode_node_payloads(
    nodes: Sequence[SceneNode], field: str
) -> tuple[bytes, bytes, int]:
    refs: list[bytes] = []
    blob = bytearray()
    count = 0
    for node in nodes:
        payload = getattr(node, field)
        if payload is None:
            refs.append(_PAYLOAD_REF.pack(node.display_id, 0, 0, len(blob), 0))
            continue
        if not isinstance(payload, OpaquePayload):
            raise SceneCodecError(f"node {field} must be OpaquePayload")
        payload_type = _uint(
            payload.payload_type_id, f"{field}.payload_type_id", _UINT32_MAX, minimum=1
        )
        flags = _uint(payload.flags, f"{field}.flags", _UINT32_MAX)
        data = _owned_nonempty(payload.data, f"{field}.data")
        if len(blob) + len(data) > _UINT32_MAX:
            raise SceneCodecError(f"{field} payload blob exceeds uint32")
        refs.append(
            _PAYLOAD_REF.pack(node.display_id, payload_type, flags, len(blob), len(data))
        )
        blob.extend(data)
        count += 1
    return b"".join(refs), bytes(blob), count


def _parse_node_payloads(
    raw: bytes,
    refs: SceneSection,
    blob: SceneSection,
    nodes: Sequence[SceneNode],
) -> tuple[OpaquePayload | None, ...]:
    result: list[OpaquePayload | None] = []
    expected_offset = 0
    for index, node in enumerate(nodes):
        display_id, payload_type, flags, offset, length = _PAYLOAD_REF.unpack_from(
            raw, refs.byte_offset + index * _PAYLOAD_REF.size
        )
        if display_id != node.display_id or offset != expected_offset:
            raise SceneCodecError("node payload refs are non-canonical")
        if payload_type == 0:
            if flags != 0 or length != 0:
                raise SceneCodecError("absent node payload ref is non-canonical")
            result.append(None)
        else:
            if length == 0 or offset + length > blob.record_count:
                raise SceneCodecError("node payload ref is out of bounds")
            data = bytes(raw[blob.byte_offset + offset : blob.byte_offset + offset + length])
            result.append(OpaquePayload(payload_type, data, flags))
            expected_offset += length
    if expected_offset != blob.record_count:
        raise SceneCodecError("node payload blob has trailing bytes")
    return tuple(result)


def _attach_payloads(nodes, profiles, interactions) -> tuple[SceneNode, ...]:
    return tuple(
        replace(node, profile=profiles[index], interaction=interactions[index])
        for index, node in enumerate(nodes)
    )


def _encode_metadata(values: Sequence[SceneMetadata]) -> tuple[bytes, bytes]:
    refs: list[bytes] = []
    blob = bytearray()
    for item in values:
        data = _owned_nonempty(item.data, "scene_metadata.data")
        if len(blob) + len(data) > _UINT32_MAX:
            raise SceneCodecError("scene metadata blob exceeds uint32")
        refs.append(
            _METADATA_REF.pack(
                item.metadata_type_id, item.flags, len(blob), len(data)
            )
        )
        blob.extend(data)
    return b"".join(refs), bytes(blob)


def _parse_metadata(
    raw: bytes, refs: SceneSection, blob: SceneSection
) -> tuple[SceneMetadata, ...]:
    result = []
    expected_offset = 0
    for index in range(refs.record_count):
        metadata_type, flags, offset, length = _METADATA_REF.unpack_from(
            raw, refs.byte_offset + index * _METADATA_REF.size
        )
        if offset != expected_offset or length == 0 or offset + length > blob.record_count:
            raise SceneCodecError("scene metadata refs are non-canonical")
        data = bytes(raw[blob.byte_offset + offset : blob.byte_offset + offset + length])
        result.append(SceneMetadata(metadata_type, data, flags))
        expected_offset += length
    if expected_offset != blob.record_count:
        raise SceneCodecError("scene metadata blob has trailing bytes")
    return tuple(result)


def _parse_visuals(raw: bytes, entry: SceneSection) -> tuple[VisualType, ...]:
    return tuple(
        VisualType(*_VISUAL_RECORD.unpack_from(raw, entry.byte_offset + index * _VISUAL_RECORD.size))
        for index in range(entry.record_count)
    )


def _parse_animations(raw: bytes, entry: SceneSection) -> tuple[AnimationState, ...]:
    result = []
    for index in range(entry.record_count):
        identity, flags, duration, reserved = _ANIMATION_RECORD.unpack_from(
            raw, entry.byte_offset + index * _ANIMATION_RECORD.size
        )
        if reserved != 0:
            raise SceneCodecError("animation reserved field must be zero")
        result.append(AnimationState(identity, flags, duration))
    return tuple(result)


def _encode_events(values: Sequence[SceneEvent]) -> tuple[bytes, bytes]:
    records: list[bytes] = []
    blob = bytearray()
    for item in values:
        data = _owned_bytes(item.payload, "event.payload")
        if len(blob) + len(data) > _UINT32_MAX:
            raise SceneCodecError("event payload blob exceeds uint32")
        records.append(
            _EVENT_RECORD.pack(
                item.event_id,
                item.event_type_id,
                item.flags,
                item.source_display_id,
                item.target_display_id,
                item.start_tick,
                len(blob),
                len(data),
            )
        )
        blob.extend(data)
    return b"".join(records), bytes(blob)


def _parse_events(
    raw: bytes, records: SceneSection, blob: SceneSection
) -> tuple[SceneEvent, ...]:
    result = []
    expected_offset = 0
    for index in range(records.record_count):
        values = _EVENT_RECORD.unpack_from(
            raw, records.byte_offset + index * _EVENT_RECORD.size
        )
        offset, length = values[-2:]
        if offset != expected_offset or offset + length > blob.record_count:
            raise SceneCodecError("event payload refs are non-canonical")
        payload = bytes(raw[blob.byte_offset + offset : blob.byte_offset + offset + length])
        result.append(SceneEvent(*values[:-2], payload))
        expected_offset += length
    if expected_offset != blob.record_count:
        raise SceneCodecError("event payload blob has trailing bytes")
    return tuple(result)


def _validate_nodes(nodes, visuals, animations, source_tick) -> None:
    visual_by_id = None if visuals is None else {item.visual_type_id: item for item in visuals}
    animation_ids = None if animations is None else {item.animation_state_id for item in animations}
    previous = 0
    for node in nodes:
        if not isinstance(node, SceneNode):
            raise SceneCodecError("nodes must contain SceneNode")
        display_id = _uint(node.display_id, "display_id", _UINT64_MAX, minimum=1)
        if display_id <= previous:
            raise SceneCodecError("nodes must be strictly ordered by display_id")
        previous = display_id
        _uint(node.parent_display_id, "parent_display_id", _UINT64_MAX)
        visual_id = _uint(node.visual_type_id, "visual_type_id", _UINT32_MAX, minimum=1)
        flags = _uint(node.flags, "node.flags", _UINT32_MAX)
        if flags & ~_NODE_VISIBLE:
            raise SceneCodecError("node flags contain an unknown bit")
        position = _tuple(node.local_position, 3, "local_position")
        rotation = _tuple(node.local_rotation_xyzw, 4, "local_rotation_xyzw")
        scale = _tuple(node.local_scale, 3, "local_scale")
        if any(value <= 0 for value in scale):
            raise SceneCodecError("local_scale must be positive")
        if abs(math.sqrt(sum(value * value for value in rotation)) - 1.0) > 1e-3:
            raise SceneCodecError("local_rotation_xyzw must be normalized")
        del position
        animation_id = _uint(node.animation_state_id, "animation_state_id", _UINT32_MAX)
        animation_start = _uint(
            node.animation_start_tick, "animation_start_tick", _UINT64_MAX
        )
        animation_flags = _uint(node.animation_flags, "animation_flags", _UINT32_MAX)
        if animation_flags & ~_ANIMATION_ALLOWED_FLAGS:
            raise SceneCodecError("animation flags contain an unknown bit")
        if source_tick is not None and animation_start > source_tick:
            raise SceneCodecError("animation_start_tick is later than source_tick")
        if visual_by_id is not None:
            visual = visual_by_id.get(visual_id)
            if visual is None:
                raise SceneCodecError("node references an unknown visual type")
            _validate_payload_type(node.profile, visual.profile_type_id, "profile")
            _validate_payload_type(
                node.interaction, visual.interaction_type_id, "interaction"
            )
        if animation_ids is not None and animation_id and animation_id not in animation_ids:
            raise SceneCodecError("node references an unknown animation state")


def _validate_payload_type(value, expected, field) -> None:
    actual = 0 if value is None else value.payload_type_id
    if actual != expected:
        raise SceneCodecError(f"node {field} payload type does not match registry")


def _validate_visuals(values: Sequence[VisualType]) -> None:
    previous = 0
    for item in values:
        if not isinstance(item, VisualType):
            raise SceneCodecError("visual_types must contain VisualType")
        identity = _uint(item.visual_type_id, "visual_type_id", _UINT32_MAX, minimum=1)
        if identity <= previous:
            raise SceneCodecError("visual types must be strictly ordered")
        previous = identity
        flags = _uint(item.flags, "visual.flags", _UINT32_MAX)
        if flags & ~_VISUAL_ALLOWED_FLAGS:
            raise SceneCodecError("visual flags contain an unknown bit")
        _uint(item.profile_type_id, "profile_type_id", _UINT32_MAX)
        _uint(item.interaction_type_id, "interaction_type_id", _UINT32_MAX)


def _validate_animations(values: Sequence[AnimationState]) -> None:
    previous = 0
    for item in values:
        if not isinstance(item, AnimationState):
            raise SceneCodecError("animation_states must contain AnimationState")
        identity = _uint(
            item.animation_state_id, "animation_state_id", _UINT32_MAX, minimum=1
        )
        if identity <= previous:
            raise SceneCodecError("animation states must be strictly ordered")
        previous = identity
        flags = _uint(item.flags, "animation.flags", _UINT32_MAX)
        if flags & ~_ANIMATION_ALLOWED_FLAGS:
            raise SceneCodecError("animation flags contain an unknown bit")
        _uint(item.duration_ticks, "duration_ticks", _UINT32_MAX, minimum=1)


def _validate_metadata(values: Sequence[SceneMetadata]) -> None:
    previous = 0
    for item in values:
        if not isinstance(item, SceneMetadata):
            raise SceneCodecError("scene_metadata must contain SceneMetadata")
        identity = _uint(
            item.metadata_type_id, "metadata_type_id", _UINT32_MAX, minimum=1
        )
        if identity <= previous:
            raise SceneCodecError("scene metadata must be strictly ordered")
        previous = identity
        if _uint(item.flags, "metadata.flags", _UINT32_MAX) != 0:
            raise SceneCodecError("scene metadata flags must be zero")
        _owned_nonempty(item.data, "scene_metadata.data")


def _validate_events(values: Sequence[SceneEvent], source_tick: int) -> None:
    previous = 0
    for item in values:
        if not isinstance(item, SceneEvent):
            raise SceneCodecError("events must contain SceneEvent")
        identity = _uint(item.event_id, "event_id", _UINT64_MAX, minimum=1)
        if identity <= previous:
            raise SceneCodecError("events must be strictly ordered")
        previous = identity
        _uint(item.event_type_id, "event_type_id", _UINT32_MAX, minimum=1)
        flags = _uint(item.flags, "event.flags", _UINT32_MAX)
        if flags & ~_EVENT_ALLOWED_FLAGS:
            raise SceneCodecError("event flags contain an unknown bit")
        _uint(item.source_display_id, "source_display_id", _UINT64_MAX)
        _uint(item.target_display_id, "target_display_id", _UINT64_MAX)
        if _uint(item.start_tick, "event.start_tick", _UINT64_MAX) > source_tick:
            raise SceneCodecError("event start_tick is later than source_tick")
        _owned_bytes(item.payload, "event.payload")


def _validate_tree(nodes, static_nodes, *, maximum_depth: int) -> dict[int, tuple[float, ...]]:
    if isinstance(maximum_depth, bool) or not isinstance(maximum_depth, int) or not 1 <= maximum_depth <= 65535:
        raise SceneCodecError("maximum_depth must be in [1, 65535]")
    values = tuple(static_nodes) + tuple(nodes)
    by_id: dict[int, SceneNode] = {}
    for node in values:
        if node.display_id in by_id:
            raise SceneCodecError("display_id is duplicated across the tree")
        by_id[node.display_id] = node
    for node in values:
        if node.parent_display_id and node.parent_display_id not in by_id:
            raise SceneCodecError("node parent is not present in the complete tree")
    depth: dict[int, int] = {}
    pose: dict[int, tuple[float, ...]] = {}
    for identity in by_id:
        chain: list[int] = []
        active: set[int] = set()
        cursor = identity
        while cursor not in depth:
            if cursor in active:
                raise SceneCodecError("scene parent graph contains a cycle")
            chain.append(cursor)
            active.add(cursor)
            parent = by_id[cursor].parent_display_id
            if parent == 0:
                break
            cursor = parent
        for current in reversed(chain):
            node = by_id[current]
            if node.parent_display_id == 0:
                current_depth = 1
                current_pose = (
                    *node.local_position,
                    *node.local_rotation_xyzw,
                    *node.local_scale,
                )
            else:
                current_depth = depth[node.parent_display_id] + 1
                current_pose = _compose_pose(pose[node.parent_display_id], node)
            if current_depth > maximum_depth:
                raise SceneCodecError("scene tree exceeds maximum_depth")
            depth[current] = current_depth
            pose[current] = current_pose
    return pose


def _compose_pose(parent: tuple[float, ...], child: SceneNode) -> tuple[float, ...]:
    pp = parent[0:3]
    pr = parent[3:7]
    ps = parent[7:10]
    cp = child.local_position
    cr = child.local_rotation_xyzw
    cs = child.local_scale
    scaled = tuple(ps[index] * cp[index] for index in range(3))
    rotated = _rotate(pr, scaled)
    return (
        *(pp[index] + rotated[index] for index in range(3)),
        *_multiply_quaternion(pr, cr),
        *(ps[index] * cs[index] for index in range(3)),
    )


def _multiply_quaternion(left, right):
    ax, ay, az, aw = left
    bx, by, bz, bw = right
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def _rotate(rotation, vector):
    x, y, z, w = rotation
    vx, vy, vz = vector
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx),
    )


def _encode_sections(header_bytes, types, sections):
    directory_bytes = len(types) * _DIRECTORY_ENTRY.size
    cursor = header_bytes + directory_bytes
    directory = []
    payload = []
    for section_type, (count, stride, data) in zip(types, sections, strict=True):
        if cursor % 4 != 0 or len(data) % 4 != 0:
            raise SceneCodecError("scene sections must be 4-byte aligned")
        directory.append(
            _DIRECTORY_ENTRY.pack(
                section_type, _REQUIRED, count, cursor, len(data), stride, 0
            )
        )
        payload.append(data)
        cursor += len(data)
    return b"".join(directory), b"".join(payload)


def _parse_sections(
    raw,
    *,
    header_bytes,
    section_types,
    strides,
    limits,
    variable=frozenset(),
    exact=None,
):
    expected_offset = header_bytes + len(section_types) * _DIRECTORY_ENTRY.size
    entries = []
    exact = {} if exact is None else exact
    for index, (section_type, stride, limit) in enumerate(
        zip(section_types, strides, limits, strict=True)
    ):
        offset = header_bytes + index * _DIRECTORY_ENTRY.size
        entry = SceneSection(*_DIRECTORY_ENTRY.unpack_from(raw, offset))
        if (
            entry.section_type != section_type
            or entry.flags != _REQUIRED
            or entry.record_stride != stride
            or entry.reserved != 0
            or entry.record_count > limit
            or entry.byte_offset != expected_offset
            or entry.byte_offset % 4 != 0
            or entry.byte_length % 4 != 0
            or entry.byte_offset + entry.byte_length > len(raw)
        ):
            raise SceneCodecError("scene section directory is non-canonical")
        if index in exact and entry.record_count != exact[index]:
            raise SceneCodecError("scene section record count mismatch")
        logical = entry.record_count if index in variable else entry.record_count * stride
        if entry.byte_length != _align4(logical):
            raise SceneCodecError("scene section length is non-canonical")
        if any(raw[entry.byte_offset + logical : entry.byte_offset + entry.byte_length]):
            raise SceneCodecError("scene section padding must be zero")
        expected_offset += entry.byte_length
        entries.append(entry)
    if expected_offset != len(raw):
        raise SceneCodecError("scene body has trailing bytes")
    return tuple(entries)


def _body_bytes(value: Any, maximum: int, field: str) -> bytes:
    raw = _owned_bytes(value, field)
    if len(raw) > maximum:
        raise SceneCodecError(f"{field} exceeds its byte limit")
    return raw


def _owned_bytes(value: Any, field: str) -> bytes:
    try:
        return bytes(value)
    except (TypeError, ValueError) as exc:
        raise SceneCodecError(f"{field} must be bytes-like") from exc


def _owned_nonempty(value: Any, field: str) -> bytes:
    raw = _owned_bytes(value, field)
    if not raw:
        raise SceneCodecError(f"{field} must not be empty")
    return raw


def _uint(value: Any, field: str, maximum: int, minimum: int = 0) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        raise SceneCodecError(f"{field} is outside its integer range")
    return value


def _finite(value: Any, field: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise SceneCodecError(f"{field} must be finite") from exc
    if not math.isfinite(result):
        raise SceneCodecError(f"{field} must be finite")
    return result


def _tuple(value, length: int, field: str) -> tuple[float, ...]:
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError) as exc:
        raise SceneCodecError(f"{field} must contain finite floats") from exc
    if len(result) != length or not all(math.isfinite(item) for item in result):
        raise SceneCodecError(f"{field} must contain finite floats")
    return result


def _require_60(value: Any) -> None:
    if value != SCENE_TICKS_PER_SECOND or isinstance(value, bool):
        raise SceneCodecError("ticks_per_second must equal 60")


def _align4(value: int) -> int:
    return (value + 3) & ~3


def _pad4(value: bytes) -> bytes:
    return value + b"\x00" * (_align4(len(value)) - len(value))


__all__ = [
    "AnimationState",
    "OpaquePayload",
    "SCENE_CODEC",
    "SCENE_COORDINATE_PROFILE_RH_Y_UP_Z_FORWARD_XYZW_F32",
    "SCENE_TICKS_PER_SECOND",
    "SceneBootstrapHeader",
    "SceneBootstrapView",
    "SceneEvent",
    "SceneFrameHeader",
    "SceneFrameView",
    "SceneMetadata",
    "SceneNode",
    "SceneSection",
    "VisualType",
    "encode_scene_bootstrap",
    "encode_scene_frame",
    "parse_scene_bootstrap",
    "parse_scene_frame",
    "validate_scene_tree",
    "validate_scene_frame_against_bootstrap",
]
