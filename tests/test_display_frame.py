from __future__ import annotations

from pathlib import Path
import struct

import pytest

from scene_engine.binary_schema import (
    DISPLAY_FRAME_HEADER_BYTES,
    DISPLAY_FRAME_HEADER_V1,
    DYNAMIC_ENTITY_RECORD_BYTES,
    SECTION_DIRECTORY_ENTRY_BYTES,
    SECTION_DIRECTORY_ENTRY_V1,
)
from scene_engine.display_frame import (
    DisplayFrameWriter,
    parse_display_frame,
)
from scene_engine.errors import (
    ConfigurationError,
    DisplayExportError,
    DisplayFrameError,
)
from scene_engine.types import DisplayPose


FIXTURE = Path(__file__).parent / "fixtures" / "display_frame_v1.hex"
PAYLOAD_OFFSET = DISPLAY_FRAME_HEADER_BYTES + SECTION_DIRECTORY_ENTRY_BYTES


def _golden_bytes() -> bytes:
    return bytes.fromhex(FIXTURE.read_text(encoding="ascii"))


def _pose(
    *,
    position=(1.0, -2.0, 3.5),
    rotation=(0.0, 0.0, 0.0, 1.0),
    scale=(1.0, 2.0, 0.5),
) -> DisplayPose:
    return DisplayPose(
        position=position,
        rotation_xyzw=rotation,
        scale=scale,
    )


def _golden_writer(*, maximum_entities=10, maximum_bytes=1000):
    return DisplayFrameWriter(
        scene_epoch=0x0102030405060708,
        bootstrap_id=0x1112131415161718,
        frame_seq=0x2122232425262728,
        source_tick=0x3132333435363738,
        ticks_per_second=60,
        maximum_frame_entities=maximum_entities,
        maximum_frame_bytes=maximum_bytes,
    )


def _write_golden_entity(writer: DisplayFrameWriter) -> None:
    writer.add_entity(
        display_id=0x0102030405060708,
        visual_type_id=0x11121314,
        flags=1,
        pose=_pose(),
        animation_state_id=0x21222324,
        animation_start_tick=0x3132333435363738,
        animation_flags=0x41424344,
    )


def _parse(data):
    return parse_display_frame(
        data,
        maximum_frame_entities=10,
        maximum_frame_bytes=1000,
    )


def test_frozen_struct_sizes_are_exact() -> None:
    assert DISPLAY_FRAME_HEADER_V1.size == 64
    assert SECTION_DIRECTORY_ENTRY_V1.size == 20
    assert DYNAMIC_ENTITY_RECORD_BYTES == 72


def test_writer_is_byte_identical_to_golden_vector() -> None:
    writer = _golden_writer()
    _write_golden_entity(writer)

    sealed = writer.seal()

    assert isinstance(sealed.data, bytes)
    assert len(sealed.data) == 64 + 20 + 72
    assert sealed.data == _golden_bytes()
    assert sealed.canonical_bytes is sealed.data


def test_parse_golden_vector_returns_complete_absolute_record() -> None:
    frame = _parse(_golden_bytes())

    assert frame.schema_version == 1
    assert frame.scene_epoch == 0x0102030405060708
    assert frame.bootstrap_id == 0x1112131415161718
    assert frame.frame_seq == 0x2122232425262728
    assert frame.source_tick == 0x3132333435363738
    assert frame.ticks_per_second == 60
    assert frame.entity_count == 1
    assert frame.entities is frame.records
    assert len(frame.directory) == 1

    record = frame.records[0]
    assert record.display_id == 0x0102030405060708
    assert record.visual_type_id == 0x11121314
    assert record.flags == 1
    assert record.world_position == (1.0, -2.0, 3.5)
    assert record.world_rotation_xyzw == (0.0, 0.0, 0.0, 1.0)
    assert record.world_scale == (1.0, 2.0, 0.5)
    assert record.pose == _pose()
    assert record.animation_state_id == 0x21222324
    assert record.animation_start_tick == 0x3132333435363738
    assert record.animation_flags == 0x41424344


def test_empty_complete_set_has_required_zero_length_section() -> None:
    sealed = _golden_writer().seal()
    frame = _parse(sealed.data)

    assert len(sealed.data) == 84
    assert frame.entity_count == 0
    assert frame.records == ()
    assert frame.directory[0].record_count == 0
    assert frame.directory[0].byte_offset == 84
    assert frame.directory[0].byte_length == 0
    assert frame.directory[0].record_stride == 72


def test_writer_requires_strictly_increasing_positive_ids() -> None:
    writer = _golden_writer()
    writer.add_entity(display_id=4, visual_type_id=1, pose=_pose())

    with pytest.raises(DisplayExportError):
        writer.add_entity(display_id=4, visual_type_id=1, pose=_pose())
    with pytest.raises(DisplayExportError):
        writer.add_entity(display_id=3, visual_type_id=1, pose=_pose())

    zero_writer = _golden_writer()
    with pytest.raises(DisplayExportError):
        zero_writer.add_entity(display_id=0, visual_type_id=1, pose=_pose())
    with pytest.raises(DisplayExportError):
        zero_writer.add_entity(display_id=1, visual_type_id=0, pose=_pose())


@pytest.mark.parametrize(
    "pose",
    [
        _pose(position=(float("nan"), 0.0, 0.0)),
        _pose(position=(float("inf"), 0.0, 0.0)),
        _pose(scale=(1.0, 1.0, float("-inf"))),
        _pose(rotation=(0.0, 0.0, 0.0, 0.998)),
        _pose(rotation=(0.0, 0.0, 0.0, 0.0)),
    ],
)
def test_writer_rejects_nonfinite_float_or_invalid_quaternion(pose) -> None:
    with pytest.raises(DisplayExportError):
        _golden_writer().add_entity(display_id=1, visual_type_id=1, pose=pose)


def test_writer_checks_count_and_byte_limits_before_append() -> None:
    entity_limited = _golden_writer(maximum_entities=0)
    with pytest.raises(DisplayExportError):
        entity_limited.add_entity(display_id=1, visual_type_id=1, pose=_pose())
    assert entity_limited.entity_count == 0

    byte_limited = _golden_writer(maximum_bytes=84)
    with pytest.raises(DisplayExportError):
        byte_limited.add_entity(display_id=1, visual_type_id=1, pose=_pose())
    assert byte_limited.entity_count == 0

    with pytest.raises(ConfigurationError):
        _golden_writer(maximum_bytes=83)


def test_seal_is_terminal_and_does_not_publish_mutable_storage() -> None:
    writer = _golden_writer()
    _write_golden_entity(writer)
    writer.seal()

    with pytest.raises(DisplayExportError):
        writer.add_entity(display_id=9, visual_type_id=1, pose=_pose())
    with pytest.raises(DisplayExportError):
        writer.seal()


def test_parser_rejects_frame_budget_before_record_traversal() -> None:
    data = bytearray(_golden_bytes())
    struct.pack_into("<I", data, 44, 50)

    with pytest.raises(DisplayFrameError, match="maximum_frame_entities"):
        parse_display_frame(
            data,
            maximum_frame_entities=1,
            maximum_frame_bytes=1000,
        )
    with pytest.raises(DisplayFrameError, match="maximum_frame_bytes"):
        parse_display_frame(
            _golden_bytes(),
            maximum_frame_entities=10,
            maximum_frame_bytes=84,
        )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda data: struct.pack_into("<H", data, 0, 2),  # schema
        lambda data: struct.pack_into("<H", data, 2, 0),  # complete flag
        lambda data: struct.pack_into("<H", data, 4, 60),  # header size
        lambda data: struct.pack_into("<H", data, 6, 2),  # section count
        lambda data: struct.pack_into("<H", data, 42, 1),  # reserved0
        lambda data: struct.pack_into("<I", data, 48, 1),  # event count
        lambda data: struct.pack_into("<I", data, 56, 40),  # directory size
        lambda data: struct.pack_into("<I", data, 60, 1),  # reserved1
        lambda data: struct.pack_into("<H", data, 64, 2),  # section type
        lambda data: struct.pack_into("<H", data, 66, 0),  # required flag
        lambda data: struct.pack_into("<I", data, 68, 2),  # record count
        lambda data: struct.pack_into("<I", data, 72, 86),  # misaligned offset
        lambda data: struct.pack_into("<I", data, 76, 73),  # section length
        lambda data: struct.pack_into("<H", data, 80, 71),  # stride
        lambda data: struct.pack_into("<H", data, 82, 1),  # dir reserved
    ],
)
def test_parser_rejects_noncanonical_header_or_directory(mutation) -> None:
    data = bytearray(_golden_bytes())
    mutation(data)
    with pytest.raises(DisplayFrameError):
        _parse(data)


def test_parser_rejects_truncation_and_trailing_bytes() -> None:
    with pytest.raises(DisplayFrameError):
        _parse(_golden_bytes()[:-1])
    with pytest.raises(DisplayFrameError):
        _parse(_golden_bytes() + b"\x00")


@pytest.mark.parametrize(
    "offset,packed",
    [
        (PAYLOAD_OFFSET, struct.pack("<Q", 0)),
        (PAYLOAD_OFFSET + 8, struct.pack("<I", 0)),
        (PAYLOAD_OFFSET + 16, struct.pack("<f", float("nan"))),
        (PAYLOAD_OFFSET + 44, struct.pack("<f", float("inf"))),
        (PAYLOAD_OFFSET + 28, struct.pack("<4f", 0.0, 0.0, 0.0, 0.0)),
    ],
)
def test_parser_rejects_invalid_complete_record(offset, packed) -> None:
    data = bytearray(_golden_bytes())
    data[offset : offset + len(packed)] = packed
    with pytest.raises(DisplayFrameError):
        _parse(data)


def test_parser_rejects_duplicate_or_descending_record_ids() -> None:
    writer = _golden_writer()
    writer.add_entity(display_id=1, visual_type_id=1, pose=_pose())
    writer.add_entity(display_id=2, visual_type_id=1, pose=_pose())
    data = bytearray(writer.seal().data)
    second_record = PAYLOAD_OFFSET + DYNAMIC_ENTITY_RECORD_BYTES
    struct.pack_into("<Q", data, second_record, 1)

    with pytest.raises(DisplayFrameError, match="strictly increasing"):
        _parse(data)


def test_parser_returns_an_immutable_copy_for_mutable_input() -> None:
    source = bytearray(_golden_bytes())
    parsed = _parse(source)
    source[-1] ^= 0xFF

    assert isinstance(parsed.data, bytes)
    assert parsed.data == _golden_bytes()
