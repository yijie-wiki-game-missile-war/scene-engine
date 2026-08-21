"""Writer and validating parser for complete dynamic display frames."""

from __future__ import annotations

from dataclasses import dataclass
import math
import struct
from typing import Any, Iterable, Tuple

from .binary_schema import (
    DISPLAY_FRAME_FLAG_COMPLETE_DYNAMIC_SET,
    DISPLAY_FRAME_HEADER_BYTES,
    DISPLAY_FRAME_HEADER_V1,
    DISPLAY_FRAME_SCHEMA_VERSION,
    DYNAMIC_ENTITY_RECORD_BYTES,
    DYNAMIC_ENTITY_RECORD_V1,
    SECTION_DIRECTORY_ENTRY_BYTES,
    SECTION_DIRECTORY_ENTRY_V1,
    SECTION_FLAG_REQUIRED,
    SECTION_TYPE_DYNAMIC_ENTITIES,
    UINT16_MAX,
    UINT32_MAX,
    UINT64_MAX,
)
from .errors import ConfigurationError, DisplayExportError, DisplayFrameError
from .types import DisplayPose


_QUATERNION_NORMALIZATION_TOLERANCE = 1e-3
_CURRENT_SECTION_COUNT = 1
_CURRENT_DIRECTORY_BYTES = SECTION_DIRECTORY_ENTRY_BYTES
_CURRENT_PAYLOAD_OFFSET = DISPLAY_FRAME_HEADER_BYTES + _CURRENT_DIRECTORY_BYTES
_MINIMUM_FRAME_BYTES = _CURRENT_PAYLOAD_OFFSET


@dataclass(frozen=True)
class DisplayFrameLimits:
    """Budgets which must be checked before record traversal."""

    maximum_frame_entities: int
    maximum_frame_bytes: int

    def __post_init__(self) -> None:
        _validate_limit(
            "maximum_frame_entities",
            self.maximum_frame_entities,
            minimum=0,
            maximum=UINT32_MAX,
        )
        _validate_limit(
            "maximum_frame_bytes",
            self.maximum_frame_bytes,
            minimum=_MINIMUM_FRAME_BYTES,
            maximum=UINT32_MAX,
        )


@dataclass(frozen=True)
class DisplayFrameHeaderV1:
    schema_version: int
    flags: int
    header_bytes: int
    section_count: int
    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    ticks_per_second: int
    reserved0: int
    entity_count: int
    event_count: int
    payload_bytes: int
    directory_bytes: int
    reserved1: int


@dataclass(frozen=True)
class SectionDirectoryEntryV1:
    section_type: int
    flags: int
    record_count: int
    byte_offset: int
    byte_length: int
    record_stride: int
    reserved0: int


@dataclass(frozen=True)
class DynamicEntityRecordV1:
    """One complete absolute replacement record, never a patch."""

    display_id: int
    visual_type_id: int
    flags: int
    world_position: Tuple[float, float, float]
    world_rotation_xyzw: Tuple[float, float, float, float]
    world_scale: Tuple[float, float, float]
    animation_state_id: int
    animation_start_tick: int
    animation_flags: int

    @property
    def pose(self) -> DisplayPose:
        return DisplayPose(
            position=self.world_position,
            rotation_xyzw=self.world_rotation_xyzw,
            scale=self.world_scale,
        )


@dataclass(frozen=True)
class SealedDisplayFrame:
    """Immutable canonical bytes plus the metadata needed by a mailbox."""

    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    ticks_per_second: int
    entity_count: int
    data: bytes
    schema_version: int = DISPLAY_FRAME_SCHEMA_VERSION

    @property
    def canonical_bytes(self) -> bytes:
        return self.data


@dataclass(frozen=True)
class DisplayFrameView:
    """A frame returned only after every header, range, and record validates."""

    header: DisplayFrameHeaderV1
    directory: Tuple[SectionDirectoryEntryV1, ...]
    records: Tuple[DynamicEntityRecordV1, ...]
    data: bytes

    @property
    def schema_version(self) -> int:
        return self.header.schema_version

    @property
    def scene_epoch(self) -> int:
        return self.header.scene_epoch

    @property
    def bootstrap_id(self) -> int:
        return self.header.bootstrap_id

    @property
    def frame_seq(self) -> int:
        return self.header.frame_seq

    @property
    def source_tick(self) -> int:
        return self.header.source_tick

    @property
    def ticks_per_second(self) -> int:
        return self.header.ticks_per_second

    @property
    def entity_count(self) -> int:
        return self.header.entity_count

    @property
    def entities(self) -> Tuple[DynamicEntityRecordV1, ...]:
        """Readable alias for consumers which reason in entity sets."""

        return self.records


class DisplayFrameWriter:
    """Build exactly one complete dynamic set in canonical ID order."""

    def __init__(
        self,
        *,
        scene_epoch: int,
        bootstrap_id: int,
        frame_seq: int,
        source_tick: int,
        ticks_per_second: int,
        maximum_frame_entities: int,
        maximum_frame_bytes: int,
    ) -> None:
        self._scene_epoch = _writer_uint("scene_epoch", scene_epoch, UINT64_MAX)
        self._bootstrap_id = _writer_uint("bootstrap_id", bootstrap_id, UINT64_MAX)
        self._frame_seq = _writer_uint("frame_seq", frame_seq, UINT64_MAX)
        self._source_tick = _writer_uint("source_tick", source_tick, UINT64_MAX)
        self._ticks_per_second = _writer_uint(
            "ticks_per_second", ticks_per_second, UINT16_MAX, minimum=1
        )
        self._limits = DisplayFrameLimits(
            maximum_frame_entities=maximum_frame_entities,
            maximum_frame_bytes=maximum_frame_bytes,
        )
        self._record_bytes = []  # type: list[bytes]
        self._last_display_id = 0
        self._sealed = False

    @property
    def source_tick(self) -> int:
        return self._source_tick

    @property
    def frame_seq(self) -> int:
        return self._frame_seq

    @property
    def entity_count(self) -> int:
        return len(self._record_bytes)

    def add_entity(
        self,
        *,
        display_id: int,
        visual_type_id: int,
        pose: DisplayPose,
        flags: int = 0,
        animation_state_id: int = 0,
        animation_start_tick: int = 0,
        animation_flags: int = 0,
    ) -> None:
        if self._sealed:
            raise DisplayExportError("cannot add an entity after the frame is sealed")

        canonical_display_id = _writer_uint(
            "display_id", display_id, UINT64_MAX, minimum=1
        )
        if canonical_display_id <= self._last_display_id:
            raise DisplayExportError(
                "display_id values must be strictly increasing within a frame"
            )

        next_count = len(self._record_bytes) + 1
        if next_count > self._limits.maximum_frame_entities:
            raise DisplayExportError("maximum_frame_entities would be exceeded")
        projected_bytes = _MINIMUM_FRAME_BYTES + next_count * DYNAMIC_ENTITY_RECORD_BYTES
        if projected_bytes > self._limits.maximum_frame_bytes:
            raise DisplayExportError("maximum_frame_bytes would be exceeded")

        canonical_visual_type_id = _writer_uint(
            "visual_type_id", visual_type_id, UINT32_MAX, minimum=1
        )
        canonical_flags = _writer_uint("flags", flags, UINT32_MAX)
        canonical_animation_state_id = _writer_uint(
            "animation_state_id", animation_state_id, UINT32_MAX
        )
        canonical_animation_start_tick = _writer_uint(
            "animation_start_tick", animation_start_tick, UINT64_MAX
        )
        canonical_animation_flags = _writer_uint(
            "animation_flags", animation_flags, UINT32_MAX
        )

        try:
            position = _canonical_float_tuple("position", pose.position, 3)
            rotation = _canonical_float_tuple(
                "rotation_xyzw", pose.rotation_xyzw, 4
            )
            scale = _canonical_float_tuple("scale", pose.scale, 3)
        except AttributeError as exc:
            raise DisplayExportError("pose must provide position, rotation_xyzw, and scale") from exc
        _validate_quaternion(rotation, DisplayExportError)

        try:
            packed = DYNAMIC_ENTITY_RECORD_V1.pack(
                canonical_display_id,
                canonical_visual_type_id,
                canonical_flags,
                *position,
                *rotation,
                *scale,
                canonical_animation_state_id,
                canonical_animation_start_tick,
                canonical_animation_flags,
            )
        except (OverflowError, struct.error) as exc:  # defensive after validation
            raise DisplayExportError("entity record cannot be represented by schema v1") from exc

        self._record_bytes.append(packed)
        self._last_display_id = canonical_display_id

    def seal(self) -> SealedDisplayFrame:
        if self._sealed:
            raise DisplayExportError("a DisplayFrameWriter can only be sealed once")

        entity_count = len(self._record_bytes)
        payload_bytes = entity_count * DYNAMIC_ENTITY_RECORD_BYTES
        total_bytes = _MINIMUM_FRAME_BYTES + payload_bytes
        if entity_count > self._limits.maximum_frame_entities:
            raise DisplayExportError("maximum_frame_entities was exceeded")
        if total_bytes > self._limits.maximum_frame_bytes:
            raise DisplayExportError("maximum_frame_bytes was exceeded")

        header = DISPLAY_FRAME_HEADER_V1.pack(
            DISPLAY_FRAME_SCHEMA_VERSION,
            DISPLAY_FRAME_FLAG_COMPLETE_DYNAMIC_SET,
            DISPLAY_FRAME_HEADER_BYTES,
            _CURRENT_SECTION_COUNT,
            self._scene_epoch,
            self._bootstrap_id,
            self._frame_seq,
            self._source_tick,
            self._ticks_per_second,
            0,
            entity_count,
            0,
            payload_bytes,
            _CURRENT_DIRECTORY_BYTES,
            0,
        )
        directory = SECTION_DIRECTORY_ENTRY_V1.pack(
            SECTION_TYPE_DYNAMIC_ENTITIES,
            SECTION_FLAG_REQUIRED,
            entity_count,
            _CURRENT_PAYLOAD_OFFSET,
            payload_bytes,
            DYNAMIC_ENTITY_RECORD_BYTES,
            0,
        )
        canonical = header + directory + b"".join(self._record_bytes)
        if len(canonical) != total_bytes:  # pragma: no cover - internal invariant
            raise AssertionError("canonical frame size calculation diverged")

        self._sealed = True
        return SealedDisplayFrame(
            scene_epoch=self._scene_epoch,
            bootstrap_id=self._bootstrap_id,
            frame_seq=self._frame_seq,
            source_tick=self._source_tick,
            ticks_per_second=self._ticks_per_second,
            entity_count=entity_count,
            data=canonical,
        )


def parse_display_frame(
    data: Any,
    *,
    maximum_frame_entities: int,
    maximum_frame_bytes: int,
) -> DisplayFrameView:
    """Validate the entire canonical frame before returning any records.

    Limits and all structural ranges are checked before record traversal.  A
    caller can therefore install the returned complete set atomically, while
    malformed input never exposes a partially decoded record collection.
    """

    limits = DisplayFrameLimits(
        maximum_frame_entities=maximum_frame_entities,
        maximum_frame_bytes=maximum_frame_bytes,
    )
    initial_view = _byte_view(data, DisplayFrameError)
    total_size = initial_view.nbytes
    if total_size > limits.maximum_frame_bytes:
        raise DisplayFrameError("frame exceeds maximum_frame_bytes")
    if total_size < DISPLAY_FRAME_HEADER_BYTES:
        raise DisplayFrameError("frame is shorter than DisplayFrameHeaderV1")

    # Freeze mutable buffers only after the outer byte budget is known.  This
    # also prevents a concurrent producer mutation from creating a mismatch
    # between the records validated below and the bytes retained by the view.
    canonical = data if isinstance(data, bytes) else initial_view.tobytes()
    view = memoryview(canonical)

    raw_header = DISPLAY_FRAME_HEADER_V1.unpack_from(view, 0)
    header = DisplayFrameHeaderV1(*raw_header)
    _validate_header(header, total_size, limits)

    directory_start = header.header_bytes
    entries = []  # type: list[SectionDirectoryEntryV1]
    previous_section_type = 0
    previous_end = header.header_bytes + header.directory_bytes
    for index in range(header.section_count):
        offset = directory_start + index * SECTION_DIRECTORY_ENTRY_BYTES
        entry = SectionDirectoryEntryV1(
            *SECTION_DIRECTORY_ENTRY_V1.unpack_from(view, offset)
        )
        if entry.section_type <= previous_section_type:
            raise DisplayFrameError("section_type values must be strictly increasing")
        if entry.reserved0 != 0:
            raise DisplayFrameError("section directory reserved0 must be zero")
        if entry.byte_offset % 4 != 0:
            raise DisplayFrameError("section payload must be 4-byte aligned")
        payload_region_start = header.header_bytes + header.directory_bytes
        if entry.byte_offset < payload_region_start:
            raise DisplayFrameError("section begins inside the header or directory")
        entry_end = entry.byte_offset + entry.byte_length
        if entry_end > total_size:
            raise DisplayFrameError("section range exceeds the frame")
        if entry.byte_offset < previous_end:
            raise DisplayFrameError("section ranges overlap or are out of payload order")
        if entry.record_stride == 0:
            if entry.record_count != 0:
                raise DisplayFrameError("non-empty fixed records require a stride")
        elif entry.record_count * entry.record_stride != entry.byte_length:
            raise DisplayFrameError("record_count * record_stride must equal byte_length")
        entries.append(entry)
        previous_section_type = entry.section_type
        previous_end = entry_end

    _validate_current_directory(header, entries, total_size)
    entity_entry = entries[0]

    # Only after all budgets, sizes, and ranges have validated do we traverse
    # attacker-controlled record_count records.
    records = []  # type: list[DynamicEntityRecordV1]
    previous_display_id = 0
    for index in range(entity_entry.record_count):
        offset = entity_entry.byte_offset + index * entity_entry.record_stride
        raw_record = DYNAMIC_ENTITY_RECORD_V1.unpack_from(view, offset)
        record = DynamicEntityRecordV1(
            display_id=raw_record[0],
            visual_type_id=raw_record[1],
            flags=raw_record[2],
            world_position=(raw_record[3], raw_record[4], raw_record[5]),
            world_rotation_xyzw=(
                raw_record[6],
                raw_record[7],
                raw_record[8],
                raw_record[9],
            ),
            world_scale=(raw_record[10], raw_record[11], raw_record[12]),
            animation_state_id=raw_record[13],
            animation_start_tick=raw_record[14],
            animation_flags=raw_record[15],
        )
        if record.display_id == 0 or record.display_id <= previous_display_id:
            raise DisplayFrameError(
                "display_id values must be positive and strictly increasing"
            )
        if record.visual_type_id == 0:
            raise DisplayFrameError("visual_type_id must be positive")
        _validate_finite(record.world_position, "world_position", DisplayFrameError)
        _validate_finite(
            record.world_rotation_xyzw, "world_rotation_xyzw", DisplayFrameError
        )
        _validate_finite(record.world_scale, "world_scale", DisplayFrameError)
        _validate_quaternion(record.world_rotation_xyzw, DisplayFrameError)
        records.append(record)
        previous_display_id = record.display_id

    return DisplayFrameView(
        header=header,
        directory=tuple(entries),
        records=tuple(records),
        data=canonical,
    )


def decode_display_frame(
    data: Any,
    *,
    maximum_frame_entities: int,
    maximum_frame_bytes: int,
) -> DisplayFrameView:
    """Compatibility spelling for callers that describe parsing as decoding."""

    return parse_display_frame(
        data,
        maximum_frame_entities=maximum_frame_entities,
        maximum_frame_bytes=maximum_frame_bytes,
    )


def _validate_header(
    header: DisplayFrameHeaderV1,
    total_size: int,
    limits: DisplayFrameLimits,
) -> None:
    if header.schema_version != DISPLAY_FRAME_SCHEMA_VERSION:
        raise DisplayFrameError("unsupported display frame schema_version")
    if header.flags != DISPLAY_FRAME_FLAG_COMPLETE_DYNAMIC_SET:
        raise DisplayFrameError("frame must contain exactly the complete-dynamic-set flag")
    if header.header_bytes != DISPLAY_FRAME_HEADER_BYTES:
        raise DisplayFrameError("header_bytes must be 64 for schema v1")
    if header.section_count != _CURRENT_SECTION_COUNT:
        raise DisplayFrameError("schema v1 slice requires exactly one section")
    if header.ticks_per_second == 0:
        raise DisplayFrameError("ticks_per_second must be positive")
    if header.reserved0 != 0 or header.reserved1 != 0:
        raise DisplayFrameError("display frame reserved fields must be zero")
    if header.entity_count > limits.maximum_frame_entities:
        raise DisplayFrameError("frame exceeds maximum_frame_entities")
    if header.event_count != 0:
        raise DisplayFrameError("event sections are not supported by this profile slice")
    expected_directory_bytes = header.section_count * SECTION_DIRECTORY_ENTRY_BYTES
    if header.directory_bytes != expected_directory_bytes:
        raise DisplayFrameError("directory_bytes does not match section_count")
    expected_total = header.header_bytes + header.directory_bytes + header.payload_bytes
    if expected_total != total_size:
        raise DisplayFrameError("frame length does not match header sizes")


def _validate_current_directory(
    header: DisplayFrameHeaderV1,
    entries: Iterable[SectionDirectoryEntryV1],
    total_size: int,
) -> None:
    entries_tuple = tuple(entries)
    if len(entries_tuple) != 1:  # already checked, keeps this helper total
        raise DisplayFrameError("schema v1 slice requires one directory entry")
    entry = entries_tuple[0]
    if entry.section_type != SECTION_TYPE_DYNAMIC_ENTITIES:
        raise DisplayFrameError("required dynamic entity section is missing")
    if entry.flags != SECTION_FLAG_REQUIRED:
        raise DisplayFrameError("dynamic entity section must have only the required flag")
    if entry.record_count != header.entity_count:
        raise DisplayFrameError("entity section count does not match header entity_count")
    if entry.record_stride != DYNAMIC_ENTITY_RECORD_BYTES:
        raise DisplayFrameError("dynamic entity record_stride must be 72")
    if entry.byte_offset != _CURRENT_PAYLOAD_OFFSET:
        raise DisplayFrameError("dynamic entity payload must immediately follow the directory")
    if entry.byte_length != header.payload_bytes:
        raise DisplayFrameError("unsupported padding or trailing payload bytes")
    if entry.byte_offset + entry.byte_length != total_size:
        raise DisplayFrameError("dynamic entity payload must end at the frame boundary")


def _canonical_float_tuple(
    field_name: str, values: Any, expected_length: int
) -> Tuple[float, ...]:
    try:
        value_tuple = tuple(values)
    except (TypeError, ValueError) as exc:
        raise DisplayExportError("{} must be an iterable".format(field_name)) from exc
    if len(value_tuple) != expected_length:
        raise DisplayExportError(
            "{} must contain exactly {} floats".format(field_name, expected_length)
        )

    canonical = []  # type: list[float]
    for value in value_tuple:
        if isinstance(value, bool):
            raise DisplayExportError("{} values must be floats".format(field_name))
        try:
            numeric = float(value)
            packed = struct.pack("<f", numeric)
            float32_value = struct.unpack("<f", packed)[0]
        except (TypeError, ValueError, OverflowError, struct.error) as exc:
            raise DisplayExportError(
                "{} contains a value outside finite float32".format(field_name)
            ) from exc
        if not math.isfinite(float32_value):
            raise DisplayExportError("{} values must be finite".format(field_name))
        canonical.append(float32_value)
    return tuple(canonical)


def _validate_finite(
    values: Iterable[float], field_name: str, error_type: Any
) -> None:
    if not all(math.isfinite(value) for value in values):
        raise error_type("{} values must be finite".format(field_name))


def _validate_quaternion(values: Iterable[float], error_type: Any) -> None:
    values_tuple = tuple(values)
    norm = math.sqrt(sum(component * component for component in values_tuple))
    if not math.isfinite(norm) or abs(norm - 1.0) > _QUATERNION_NORMALIZATION_TOLERANCE:
        raise error_type(
            "world quaternion normalization error exceeds {:.0e}".format(
                _QUATERNION_NORMALIZATION_TOLERANCE
            )
        )


def _validate_limit(
    field_name: str, value: Any, *, minimum: int, maximum: int
) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigurationError("{} must be an integer".format(field_name))
    if value < minimum or value > maximum:
        raise ConfigurationError(
            "{} must be in [{}, {}]".format(field_name, minimum, maximum)
        )


def _writer_uint(
    field_name: str,
    value: Any,
    maximum: int,
    *,
    minimum: int = 0,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise DisplayExportError("{} must be an integer".format(field_name))
    if value < minimum or value > maximum:
        raise DisplayExportError(
            "{} must be in [{}, {}]".format(field_name, minimum, maximum)
        )
    return value


def _byte_view(data: Any, error_type: Any) -> memoryview:
    try:
        view = memoryview(data)
    except TypeError as exc:
        raise error_type("binary input must support the buffer protocol") from exc
    if not view.c_contiguous:
        raise error_type("binary input must be C-contiguous")
    try:
        return view.cast("B")
    except (TypeError, ValueError) as exc:
        raise error_type("binary input must be byte-addressable") from exc


# Short names are useful to render-neutral consumer code while the V1 suffixes
# remain available anywhere the exact schema declaration matters.
DisplayFrameHeader = DisplayFrameHeaderV1
SectionDirectoryEntry = SectionDirectoryEntryV1
DynamicEntityRecord = DynamicEntityRecordV1


__all__ = [
    "DisplayFrameLimits",
    "DisplayFrameHeaderV1",
    "DisplayFrameHeader",
    "SectionDirectoryEntryV1",
    "SectionDirectoryEntry",
    "DynamicEntityRecordV1",
    "DynamicEntityRecord",
    "SealedDisplayFrame",
    "DisplayFrameView",
    "DisplayFrameWriter",
    "parse_display_frame",
    "decode_display_frame",
]
