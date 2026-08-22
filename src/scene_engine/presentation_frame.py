"""Schema-V2 complete presentation frame writer/parser."""

from __future__ import annotations

from dataclasses import dataclass
import math
import struct
import unicodedata
from typing import Any, Iterable, Optional, Tuple

from .binary_schema import UINT32_MAX, UINT64_MAX
from .errors import ConfigurationError, PresentationFrameError
from .presentation_schema import (
    INTERACTION_DOMAIN_KINDS,
    INTERACTION_RECORD_BYTES,
    INTERACTION_RECORD_V1,
    PRESENTATION_TICKS_PER_SECOND,
    OWNER_STATE_RECORD_BYTES,
    OWNER_STATE_RECORD_V1,
    PRESENTATION_ENTITY_ALLOWED_FLAGS,
    PRESENTATION_ENTITY_FLAG_INTERACTIVE,
    PRESENTATION_ENTITY_RECORD_BYTES,
    PRESENTATION_ENTITY_RECORD_V2,
    PRESENTATION_EVENT_ALLOWED_FLAGS,
    PRESENTATION_EVENT_RECORD_BYTES,
    PRESENTATION_EVENT_RECORD_V1,
    PRESENTATION_FRAME_FLAG_COMPLETE_DYNAMIC_SET,
    PRESENTATION_FRAME_HEADER_BYTES,
    PRESENTATION_FRAME_HEADER_V2,
    PRESENTATION_FRAME_SCHEMA_VERSION,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_V1,
    PRESENTATION_SECTION_DYNAMIC_ENTITIES,
    PRESENTATION_SECTION_EVENTS,
    PRESENTATION_SECTION_FLAG_REQUIRED,
    PRESENTATION_SECTION_INTERACTIONS,
    PRESENTATION_SECTION_INTERACTION_STRINGS,
    PRESENTATION_SECTION_OWNER_STATES,
)
from .types import DisplayPose


_SECTION_TYPES = (
    PRESENTATION_SECTION_DYNAMIC_ENTITIES,
    PRESENTATION_SECTION_OWNER_STATES,
    PRESENTATION_SECTION_INTERACTIONS,
    PRESENTATION_SECTION_INTERACTION_STRINGS,
    PRESENTATION_SECTION_EVENTS,
)
_DIRECTORY_BYTES = len(_SECTION_TYPES) * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
_PAYLOAD_OFFSET = PRESENTATION_FRAME_HEADER_BYTES + _DIRECTORY_BYTES
_QUATERNION_TOLERANCE = 1e-3
_MAX_INTERACTION_STRING_BYTES = 4096


@dataclass(frozen=True)
class InteractionMappingV1:
    domain_kind: int
    capability_flags: int
    domain_value: str
    tile_q: int = 0
    tile_r: int = 0


@dataclass(frozen=True)
class OwnerStateV1:
    parent_display_id: int = 0
    mount_point_id: int = 0
    variant_id: int = 0
    damage_state_id: int = 0
    construction_state_id: int = 0
    assignment_state_id: int = 0
    side_id: int = 0
    color_rgba: int = 0
    owner_flags: int = 0
    scalar0: float = 0.0
    scalar1: float = 0.0
    scalar2: float = 0.0


@dataclass(frozen=True)
class PresentationEntityV2:
    display_id: int
    visual_type_id: int
    flags: int
    pose: DisplayPose
    animation_state_id: int = 0
    animation_start_tick: int = 0
    animation_flags: int = 0
    owner_state: OwnerStateV1 = OwnerStateV1()
    interaction: Optional[InteractionMappingV1] = None


@dataclass(frozen=True)
class PresentationEventV1:
    event_id: int
    effect_type_id: int
    flags: int
    source_display_id: int
    target_display_id: int
    start_tick: int


@dataclass(frozen=True)
class PresentationFrameHeaderV2:
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
    entity_count: int
    event_count: int
    interaction_count: int
    payload_bytes: int
    directory_bytes: int
    owner_state_count: int
    reserved1: int


@dataclass(frozen=True)
class PresentationSectionEntryV1:
    section_type: int
    flags: int
    record_count: int
    byte_offset: int
    byte_length: int
    record_stride: int
    reserved0: int


@dataclass(frozen=True)
class PresentationEntityRecordV2:
    display_id: int
    visual_type_id: int
    flags: int
    world_position: Tuple[float, float, float]
    world_rotation_xyzw: Tuple[float, float, float, float]
    world_scale: Tuple[float, float, float]
    animation_state_id: int
    animation_start_tick: int
    animation_flags: int


@dataclass(frozen=True)
class OwnerStateRecordV1:
    display_id: int
    parent_display_id: int
    mount_point_id: int
    variant_id: int
    damage_state_id: int
    construction_state_id: int
    assignment_state_id: int
    side_id: int
    color_rgba: int
    owner_flags: int
    scalar0: float
    scalar1: float
    scalar2: float


@dataclass(frozen=True)
class InteractionRecordV1:
    display_id: int
    domain_kind: int
    capability_flags: int
    domain_value: str
    tile_q: int
    tile_r: int


@dataclass(frozen=True)
class PresentationFrameView:
    header: PresentationFrameHeaderV2
    entities: Tuple[PresentationEntityRecordV2, ...]
    owner_states: Tuple[OwnerStateRecordV1, ...]
    interactions: Tuple[InteractionRecordV1, ...]
    events: Tuple[PresentationEventV1, ...]
    directory: Tuple[PresentationSectionEntryV1, ...]
    data: bytes

    @property
    def frame_seq(self) -> int:
        return self.header.frame_seq

    @property
    def source_tick(self) -> int:
        return self.header.source_tick

    @property
    def projection_id(self) -> int:
        return self.header.projection_id


@dataclass(frozen=True)
class SealedPresentationFrame:
    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    projection_id: int
    entity_count: int
    event_count: int
    data: bytes
    schema_version: int = PRESENTATION_FRAME_SCHEMA_VERSION


def encode_presentation_frame(
    *,
    scene_epoch: int,
    bootstrap_id: int,
    frame_seq: int,
    source_tick: int,
    projection_id: int,
    entities: Iterable[PresentationEntityV2],
    events: Iterable[PresentationEventV1] = (),
    maximum_frame_entities: int,
    maximum_frame_events: int,
    maximum_frame_bytes: int,
) -> SealedPresentationFrame:
    epoch = _uint("scene_epoch", scene_epoch, UINT64_MAX, minimum=1)
    bootstrap = _uint("bootstrap_id", bootstrap_id, UINT64_MAX, minimum=1)
    sequence = _uint("frame_seq", frame_seq, UINT64_MAX, minimum=1)
    tick = _uint("source_tick", source_tick, UINT64_MAX)
    projection = _uint("projection_id", projection_id, UINT64_MAX, minimum=1)
    entity_limit = _limit("maximum_frame_entities", maximum_frame_entities)
    event_limit = _limit("maximum_frame_events", maximum_frame_events)
    byte_limit = _limit("maximum_frame_bytes", maximum_frame_bytes)
    entity_values = tuple(entities)
    event_values = tuple(events)
    if len(entity_values) > entity_limit:
        raise PresentationFrameError("frame exceeds maximum_frame_entities")
    if len(event_values) > event_limit:
        raise PresentationFrameError("frame exceeds maximum_frame_events")

    base_parts = []
    owner_parts = []
    interaction_parts = []
    string_parts = []
    string_offset = 0
    previous_id = 0
    interaction_count = 0
    for value in entity_values:
        if not isinstance(value, PresentationEntityV2):
            raise PresentationFrameError("entities must contain PresentationEntityV2")
        display_id = _uint("entity.display_id", value.display_id, UINT64_MAX, minimum=1)
        if display_id <= previous_id:
            raise PresentationFrameError("entity display IDs must be strictly increasing")
        flags = _uint("entity.flags", value.flags, UINT32_MAX)
        if flags & ~PRESENTATION_ENTITY_ALLOWED_FLAGS:
            raise PresentationFrameError("entity contains unknown flags")
        if bool(flags & PRESENTATION_ENTITY_FLAG_INTERACTIVE) != (value.interaction is not None):
            raise PresentationFrameError("interactive flag and mapping must agree")
        position, rotation, scale = _pose(value.pose)
        animation_start = _uint(
            "entity.animation_start_tick", value.animation_start_tick, UINT64_MAX
        )
        if animation_start > tick:
            raise PresentationFrameError("animation_start_tick cannot exceed source_tick")
        base_parts.append(
            PRESENTATION_ENTITY_RECORD_V2.pack(
                display_id,
                _uint("entity.visual_type_id", value.visual_type_id, UINT32_MAX, minimum=1),
                flags,
                *position,
                *rotation,
                *scale,
                _uint("entity.animation_state_id", value.animation_state_id, UINT32_MAX),
                animation_start,
                _uint("entity.animation_flags", value.animation_flags, UINT32_MAX),
            )
        )
        owner_parts.append(_encode_owner_state(display_id, value.owner_state))
        if value.interaction is not None:
            encoded = _interaction_string(value.interaction.domain_value)
            if string_offset + len(encoded) > _MAX_INTERACTION_STRING_BYTES:
                raise PresentationFrameError("interaction string table exceeds byte limit")
            interaction_parts.append(
                INTERACTION_RECORD_V1.pack(
                    display_id,
                    _interaction_kind(value.interaction.domain_kind),
                    _uint("interaction.capability_flags", value.interaction.capability_flags, UINT32_MAX, minimum=1),
                    string_offset,
                    len(encoded),
                    _int32("interaction.tile_q", value.interaction.tile_q),
                    _int32("interaction.tile_r", value.interaction.tile_r),
                )
            )
            string_parts.append(encoded)
            string_offset += len(encoded)
            interaction_count += 1
        previous_id = display_id

    event_parts = []
    previous_event_id = 0
    for value in event_values:
        if not isinstance(value, PresentationEventV1):
            raise PresentationFrameError("events must contain PresentationEventV1")
        event_id = _uint("event.event_id", value.event_id, UINT64_MAX, minimum=1)
        if event_id <= previous_event_id:
            raise PresentationFrameError("event IDs must be strictly increasing")
        flags = _uint("event.flags", value.flags, UINT32_MAX)
        if flags & ~PRESENTATION_EVENT_ALLOWED_FLAGS:
            raise PresentationFrameError("event contains unknown flags")
        start_tick = _uint("event.start_tick", value.start_tick, UINT64_MAX)
        if start_tick > tick:
            raise PresentationFrameError("event start_tick cannot exceed source_tick")
        event_parts.append(
            PRESENTATION_EVENT_RECORD_V1.pack(
                event_id,
                _uint("event.effect_type_id", value.effect_type_id, UINT32_MAX, minimum=1),
                flags,
                _uint("event.source_display_id", value.source_display_id, UINT64_MAX),
                _uint("event.target_display_id", value.target_display_id, UINT64_MAX),
                start_tick,
            )
        )
        previous_event_id = event_id

    interaction_strings = b"".join(string_parts)
    interaction_strings += b"\x00" * (_align4(len(interaction_strings)) - len(interaction_strings))
    section_payloads = (
        b"".join(base_parts),
        b"".join(owner_parts),
        b"".join(interaction_parts),
        interaction_strings,
        b"".join(event_parts),
    )
    counts = (
        len(entity_values),
        len(entity_values),
        interaction_count,
        interaction_count,
        len(event_values),
    )
    strides = (
        PRESENTATION_ENTITY_RECORD_BYTES,
        OWNER_STATE_RECORD_BYTES,
        INTERACTION_RECORD_BYTES,
        0,
        PRESENTATION_EVENT_RECORD_BYTES,
    )
    directory_parts = []
    next_offset = _PAYLOAD_OFFSET
    for section_type, payload, count, stride in zip(
        _SECTION_TYPES, section_payloads, counts, strides
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
    payload = b"".join(section_payloads)
    total = PRESENTATION_FRAME_HEADER_BYTES + len(directory) + len(payload)
    if total > byte_limit:
        raise PresentationFrameError("frame exceeds maximum_frame_bytes")
    header = PRESENTATION_FRAME_HEADER_V2.pack(
        PRESENTATION_FRAME_SCHEMA_VERSION,
        PRESENTATION_FRAME_FLAG_COMPLETE_DYNAMIC_SET,
        PRESENTATION_FRAME_HEADER_BYTES,
        len(_SECTION_TYPES),
        epoch,
        bootstrap,
        sequence,
        tick,
        projection,
        PRESENTATION_TICKS_PER_SECOND,
        0,
        len(entity_values),
        len(event_values),
        interaction_count,
        len(payload),
        len(directory),
        len(entity_values),
        0,
    )
    return SealedPresentationFrame(
        scene_epoch=epoch,
        bootstrap_id=bootstrap,
        frame_seq=sequence,
        source_tick=tick,
        projection_id=projection,
        entity_count=len(entity_values),
        event_count=len(event_values),
        data=header + directory + payload,
    )


def parse_presentation_frame(
    data: Any,
    *,
    maximum_frame_entities: int,
    maximum_frame_events: int,
    maximum_frame_bytes: int,
) -> PresentationFrameView:
    entity_limit = _limit("maximum_frame_entities", maximum_frame_entities)
    event_limit = _limit("maximum_frame_events", maximum_frame_events)
    byte_limit = _limit("maximum_frame_bytes", maximum_frame_bytes)
    view0 = _byte_view(data)
    if view0.nbytes > byte_limit:
        raise PresentationFrameError("frame exceeds maximum_frame_bytes")
    if view0.nbytes < PRESENTATION_FRAME_HEADER_BYTES:
        raise PresentationFrameError("frame is shorter than PresentationFrameHeaderV2")
    canonical = data if isinstance(data, bytes) else view0.tobytes()
    view = memoryview(canonical)
    header = PresentationFrameHeaderV2(*PRESENTATION_FRAME_HEADER_V2.unpack_from(view, 0))
    _validate_header(header, len(canonical), entity_limit, event_limit)
    entries = _parse_directory(view, header)
    entities = _parse_entities(view, entries[0], header.source_tick)
    owner_states = _parse_owner_states(view, entries[1], entities)
    interactions = _parse_interactions(view, entries[2], entries[3])
    events = _parse_events(view, entries[4], header.source_tick)
    interactive_ids = {
        record.display_id
        for record in entities
        if record.flags & PRESENTATION_ENTITY_FLAG_INTERACTIVE
    }
    if interactive_ids != {record.display_id for record in interactions}:
        raise PresentationFrameError("interactive entity set and mapping set differ")
    return PresentationFrameView(
        header=header,
        entities=entities,
        owner_states=owner_states,
        interactions=interactions,
        events=events,
        directory=entries,
        data=canonical,
    )


def _encode_owner_state(display_id, value):
    if not isinstance(value, OwnerStateV1):
        raise PresentationFrameError("owner_state must be OwnerStateV1")
    scalars = tuple(_float32("owner scalar", item) for item in (value.scalar0, value.scalar1, value.scalar2))
    return OWNER_STATE_RECORD_V1.pack(
        display_id,
        _uint("owner.parent_display_id", value.parent_display_id, UINT64_MAX),
        _uint("owner.mount_point_id", value.mount_point_id, UINT32_MAX),
        _uint("owner.variant_id", value.variant_id, UINT32_MAX),
        _uint("owner.damage_state_id", value.damage_state_id, UINT32_MAX),
        _uint("owner.construction_state_id", value.construction_state_id, UINT32_MAX),
        _uint("owner.assignment_state_id", value.assignment_state_id, UINT32_MAX),
        _uint("owner.side_id", value.side_id, UINT32_MAX),
        _uint("owner.color_rgba", value.color_rgba, UINT32_MAX),
        _uint("owner.owner_flags", value.owner_flags, UINT32_MAX),
        *scalars,
        0,
    )


def _validate_header(header, total, entity_limit, event_limit):
    if header.schema_version != PRESENTATION_FRAME_SCHEMA_VERSION:
        raise PresentationFrameError("unsupported presentation frame schema_version")
    if header.flags != PRESENTATION_FRAME_FLAG_COMPLETE_DYNAMIC_SET:
        raise PresentationFrameError("presentation frame flags are non-canonical")
    if header.header_bytes != PRESENTATION_FRAME_HEADER_BYTES or header.section_count != len(_SECTION_TYPES):
        raise PresentationFrameError("presentation frame header layout mismatch")
    if min(header.scene_epoch, header.bootstrap_id, header.frame_seq, header.projection_id) == 0:
        raise PresentationFrameError("presentation frame identities must be positive")
    if header.ticks_per_second != PRESENTATION_TICKS_PER_SECOND:
        raise PresentationFrameError("presentation frame TPS must be 60")
    if header.reserved0 != 0 or header.reserved1 != 0:
        raise PresentationFrameError("presentation frame reserved fields must be zero")
    if header.entity_count > entity_limit or header.event_count > event_limit:
        raise PresentationFrameError("presentation frame exceeds local record limit")
    if header.interaction_count > header.entity_count or header.owner_state_count != header.entity_count:
        raise PresentationFrameError("presentation frame counts are inconsistent")
    if header.directory_bytes != _DIRECTORY_BYTES:
        raise PresentationFrameError("presentation directory_bytes mismatch")
    if header.header_bytes + header.directory_bytes + header.payload_bytes != total:
        raise PresentationFrameError("presentation frame length mismatch")


def _parse_directory(view, header):
    strides = (
        PRESENTATION_ENTITY_RECORD_BYTES,
        OWNER_STATE_RECORD_BYTES,
        INTERACTION_RECORD_BYTES,
        0,
        PRESENTATION_EVENT_RECORD_BYTES,
    )
    counts = (
        header.entity_count,
        header.owner_state_count,
        header.interaction_count,
        header.interaction_count,
        header.event_count,
    )
    entries = []
    previous_end = _PAYLOAD_OFFSET
    for index, (section_type, stride, count) in enumerate(zip(_SECTION_TYPES, strides, counts)):
        offset = PRESENTATION_FRAME_HEADER_BYTES + index * PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES
        entry = PresentationSectionEntryV1(*PRESENTATION_SECTION_DIRECTORY_ENTRY_V1.unpack_from(view, offset))
        if entry.section_type != section_type or entry.flags != PRESENTATION_SECTION_FLAG_REQUIRED:
            raise PresentationFrameError("presentation section directory is non-canonical")
        if entry.record_count != count or entry.record_stride != stride or entry.reserved0 != 0:
            raise PresentationFrameError("presentation section count/stride mismatch")
        if stride and entry.byte_length != count * stride:
            raise PresentationFrameError("presentation fixed section length mismatch")
        if entry.byte_offset != previous_end or entry.byte_offset % 4:
            raise PresentationFrameError("presentation sections must be contiguous and aligned")
        previous_end = entry.byte_offset + entry.byte_length
        if previous_end > len(view):
            raise PresentationFrameError("presentation section exceeds frame")
        entries.append(entry)
    if previous_end != len(view):
        raise PresentationFrameError("presentation frame has unindexed bytes")
    return tuple(entries)


def _parse_entities(view, entry, source_tick):
    result = []
    previous = 0
    for index in range(entry.record_count):
        raw = PRESENTATION_ENTITY_RECORD_V2.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        record = PresentationEntityRecordV2(
            raw[0], raw[1], raw[2], tuple(raw[3:6]), tuple(raw[6:10]),
            tuple(raw[10:13]), raw[13], raw[14], raw[15],
        )
        if record.display_id == 0 or record.display_id <= previous or record.visual_type_id == 0:
            raise PresentationFrameError("entity identities must be positive and increasing")
        if record.flags & ~PRESENTATION_ENTITY_ALLOWED_FLAGS:
            raise PresentationFrameError("entity contains unknown flags")
        _validate_pose(record.world_position, record.world_rotation_xyzw, record.world_scale)
        if record.animation_start_tick > source_tick:
            raise PresentationFrameError("animation_start_tick exceeds source_tick")
        result.append(record)
        previous = record.display_id
    return tuple(result)


def _parse_owner_states(view, entry, entities):
    result = []
    for index, entity in enumerate(entities):
        raw = OWNER_STATE_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        if raw[0] != entity.display_id or raw[13] != 0:
            raise PresentationFrameError("owner state identity/reserved mismatch")
        if not all(math.isfinite(value) for value in raw[10:13]):
            raise PresentationFrameError("owner state scalars must be finite")
        result.append(OwnerStateRecordV1(*raw[:13]))
    return tuple(result)


def _parse_interactions(view, record_entry, string_entry):
    string_view = view[string_entry.byte_offset:string_entry.byte_offset + string_entry.byte_length]
    result = []
    previous = 0
    expected_offset = 0
    for index in range(record_entry.record_count):
        raw = INTERACTION_RECORD_V1.unpack_from(view, record_entry.byte_offset + index * record_entry.record_stride)
        display_id, domain_kind, capability_flags, offset, length, tile_q, tile_r = raw
        if display_id == 0 or display_id <= previous or capability_flags == 0:
            raise PresentationFrameError("interaction identities/capabilities are invalid")
        if domain_kind not in INTERACTION_DOMAIN_KINDS or length == 0 or offset != expected_offset:
            raise PresentationFrameError("interaction string mapping is non-canonical")
        end = offset + length
        if end > len(string_view):
            raise PresentationFrameError("interaction string range exceeds section")
        domain_value = _decode_interaction_string(string_view[offset:end].tobytes())
        result.append(InteractionRecordV1(display_id, domain_kind, capability_flags, domain_value, tile_q, tile_r))
        previous = display_id
        expected_offset = end
    if _align4(expected_offset) != len(string_view) or any(string_view[expected_offset:]):
        raise PresentationFrameError("interaction string padding is non-canonical")
    return tuple(result)


def _parse_events(view, entry, source_tick):
    result = []
    previous = 0
    for index in range(entry.record_count):
        raw = PRESENTATION_EVENT_RECORD_V1.unpack_from(view, entry.byte_offset + index * entry.record_stride)
        record = PresentationEventV1(*raw)
        if record.event_id == 0 or record.event_id <= previous or record.effect_type_id == 0:
            raise PresentationFrameError("event identities must be positive and increasing")
        if record.flags & ~PRESENTATION_EVENT_ALLOWED_FLAGS or record.start_tick > source_tick:
            raise PresentationFrameError("event flags/start_tick are invalid")
        result.append(record)
        previous = record.event_id
    return tuple(result)


def _pose(value):
    try:
        position = tuple(_float32("position", item) for item in value.position)
        rotation = tuple(_float32("rotation", item) for item in value.rotation_xyzw)
        scale = tuple(_float32("scale", item) for item in value.scale)
    except (AttributeError, TypeError) as exc:
        raise PresentationFrameError("pose must provide position/rotation/scale") from exc
    if (len(position), len(rotation), len(scale)) != (3, 4, 3):
        raise PresentationFrameError("pose component count is invalid")
    _validate_pose(position, rotation, scale)
    return position, rotation, scale


def _validate_pose(position, rotation, scale):
    if not all(math.isfinite(value) for value in position + rotation + scale):
        raise PresentationFrameError("pose values must be finite")
    norm = math.sqrt(sum(value * value for value in rotation))
    if abs(norm - 1.0) > _QUATERNION_TOLERANCE:
        raise PresentationFrameError("pose quaternion is not normalized")


def _interaction_string(value):
    if not isinstance(value, str) or not value or value.strip() != value or "\x00" in value:
        raise PresentationFrameError("interaction domain value must be canonical string")
    if unicodedata.normalize("NFC", value) != value:
        raise PresentationFrameError("interaction domain value must use NFC")
    return value.encode("utf-8")


def _decode_interaction_string(value):
    try:
        decoded = value.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise PresentationFrameError("interaction string is not UTF-8") from exc
    _interaction_string(decoded)
    return decoded


def _interaction_kind(value):
    if value not in INTERACTION_DOMAIN_KINDS:
        raise PresentationFrameError("interaction domain_kind is unknown")
    return value


def _align4(value):
    return (value + 3) & ~3


def _uint(name, value, maximum, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise PresentationFrameError("{} is outside the frozen integer range".format(name))
    return value


def _int32(name, value):
    if isinstance(value, bool) or not isinstance(value, int) or not -(1 << 31) <= value < (1 << 31):
        raise PresentationFrameError("{} must be signed int32".format(name))
    return value


def _float32(name, value):
    if isinstance(value, bool):
        raise PresentationFrameError("{} must be float32".format(name))
    try:
        result = struct.unpack("<f", struct.pack("<f", float(value)))[0]
    except (TypeError, ValueError, OverflowError, struct.error) as exc:
        raise PresentationFrameError("{} must be finite float32".format(name)) from exc
    if not math.isfinite(result):
        raise PresentationFrameError("{} must be finite float32".format(name))
    return result


def _limit(name, value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= UINT32_MAX:
        raise ConfigurationError("{} must be uint32".format(name))
    return value


def _byte_view(data):
    try:
        view = memoryview(data)
    except TypeError as exc:
        raise PresentationFrameError("frame input must support buffer protocol") from exc
    if not view.c_contiguous:
        raise PresentationFrameError("frame input must be C-contiguous")
    return view.cast("B")


__all__ = [
    "InteractionMappingV1",
    "InteractionRecordV1",
    "OwnerStateRecordV1",
    "OwnerStateV1",
    "PresentationEntityRecordV2",
    "PresentationEntityV2",
    "PresentationEventV1",
    "PresentationFrameHeaderV2",
    "PresentationFrameView",
    "PresentationSectionEntryV1",
    "SealedPresentationFrame",
    "encode_presentation_frame",
    "parse_presentation_frame",
]
