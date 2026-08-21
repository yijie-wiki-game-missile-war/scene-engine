from __future__ import annotations

from pathlib import Path
import struct

import pytest

from scene_engine.binary_schema import PACKET_HEADER_V1
from scene_engine.errors import ConfigurationError, DisplayFrameError, PacketError
from scene_engine.packet_codec import (
    decode_display_frame_packet,
    encode_packet,
    parse_packet,
)


FIXTURE = Path(__file__).parent / "fixtures" / "display_frame_v1.hex"


def _frame_bytes() -> bytes:
    return bytes.fromhex(FIXTURE.read_text(encoding="ascii"))


def _parse(data, *, stored=1000, uncompressed=1000):
    return parse_packet(
        data,
        maximum_stored_bytes=stored,
        maximum_uncompressed_bytes=uncompressed,
    )


def test_packet_header_has_frozen_24_byte_layout() -> None:
    assert PACKET_HEADER_V1.size == 24


def test_codec_none_envelope_is_byte_exact() -> None:
    payload = _frame_bytes()
    packet = encode_packet(payload)
    expected_header = bytes.fromhex(
        "53454446"  # SEDF
        "0100"      # packet_version 1
        "02"        # display.frame
        "00"        # codec none
        "0000"      # flags
        "1800"      # header_bytes 24
        "9c000000"  # uncompressed_bytes 156
        "9c000000"  # stored_bytes 156
        "00000000"  # reserved0
    )

    assert packet == expected_header + payload
    parsed = _parse(packet)
    assert parsed.data == packet
    assert parsed.payload == payload
    assert parsed.header.stored_bytes == len(payload)
    assert parsed.header.uncompressed_bytes == len(payload)
    assert parsed.header.compression_codec == 0


def test_codec_none_accepts_no_alternate_message_type_or_codec() -> None:
    with pytest.raises(PacketError):
        encode_packet(b"frame", message_type=1)
    with pytest.raises(PacketError):
        encode_packet(b"frame", compression_codec=1)


def test_packet_parser_applies_budgets_before_copying_payload() -> None:
    packet = encode_packet(_frame_bytes())

    with pytest.raises(PacketError, match="maximum_stored_bytes"):
        _parse(packet, stored=155)
    with pytest.raises(PacketError, match="maximum_uncompressed_bytes"):
        _parse(packet, uncompressed=155)
    with pytest.raises(ConfigurationError):
        _parse(packet, stored=-1)


@pytest.mark.parametrize(
    "offset,packed",
    [
        (0, b"NOPE"),
        (4, struct.pack("<H", 2)),
        (6, struct.pack("<B", 1)),
        (7, struct.pack("<B", 1)),
        (8, struct.pack("<H", 1)),
        (10, struct.pack("<H", 20)),
        (16, struct.pack("<I", 155)),
        (20, struct.pack("<I", 1)),
    ],
)
def test_packet_parser_rejects_malformed_header(offset, packed) -> None:
    packet = bytearray(encode_packet(_frame_bytes()))
    packet[offset : offset + len(packed)] = packed

    with pytest.raises(PacketError):
        _parse(packet)


def test_packet_parser_rejects_truncation_and_trailing_bytes() -> None:
    packet = encode_packet(_frame_bytes())
    with pytest.raises(PacketError):
        _parse(packet[:-1])
    with pytest.raises(PacketError):
        _parse(packet + b"\x00")


def test_combined_decoder_validates_inner_frame_before_returning() -> None:
    decoded = decode_display_frame_packet(
        encode_packet(_frame_bytes()),
        maximum_stored_bytes=1000,
        maximum_uncompressed_bytes=1000,
        maximum_frame_entities=10,
        maximum_frame_bytes=1000,
    )
    assert decoded.frame_seq == 0x2122232425262728
    assert decoded.records[0].world_position == (1.0, -2.0, 3.5)

    malformed_frame = bytearray(_frame_bytes())
    struct.pack_into("<H", malformed_frame, 42, 1)
    with pytest.raises(DisplayFrameError):
        decode_display_frame_packet(
            encode_packet(malformed_frame),
            maximum_stored_bytes=1000,
            maximum_uncompressed_bytes=1000,
            maximum_frame_entities=10,
            maximum_frame_bytes=1000,
        )
