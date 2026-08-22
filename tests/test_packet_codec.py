from __future__ import annotations

from pathlib import Path
import struct

import pytest

import scene_engine
import scene_engine.packet_codec as packet_codec
from scene_engine.binary_schema import (
    PACKET_HEADER_V1,
    PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3,
    PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3,
)
from scene_engine.errors import ConfigurationError, PacketError, PresentationFrameError
from scene_engine.packet_codec import (
    decode_presentation_frame_v3_packet,
    decode_scene_bootstrap_v3_packet,
    encode_packet,
    encode_presentation_frame_v3_packet,
    encode_scene_bootstrap_v3_packet,
    parse_packet,
)


FIXTURES = Path(__file__).parent / "fixtures"
BOOTSTRAP_FIXTURE = FIXTURES / "scene_bootstrap_v3.hex"
FRAME_FIXTURE = FIXTURES / "presentation_frame_v3.hex"


def _fixture(path: Path) -> bytes:
    return bytes.fromhex(path.read_text(encoding="ascii"))


def _parse(data: object, *, stored: int = 4096, uncompressed: int = 4096):
    return parse_packet(
        data,
        maximum_stored_bytes=stored,
        maximum_uncompressed_bytes=uncompressed,
    )


def test_packet_header_has_frozen_24_byte_layout() -> None:
    assert PACKET_HEADER_V1.size == 24


def test_v3_frame_codec_none_envelope_is_byte_exact() -> None:
    payload = _fixture(FRAME_FIXTURE)
    packet = encode_presentation_frame_v3_packet(payload)
    expected_header = bytes.fromhex(
        "53454446"  # SEDF
        "0100"      # packet_version 1
        "02"        # PresentationFrameV3
        "00"        # codec none
        "0000"      # flags
        "1800"      # header_bytes 24
        "38020000"  # uncompressed_bytes 568
        "38020000"  # stored_bytes 568
        "00000000"  # reserved0
    )

    assert packet == expected_header + payload
    parsed = _parse(packet)
    assert parsed.data is packet
    assert parsed.payload == payload
    assert parsed.header.message_type == PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3
    assert parsed.header.stored_bytes == len(payload)


def test_explicit_v3_packet_encoders_freeze_message_type() -> None:
    bootstrap = encode_scene_bootstrap_v3_packet(_fixture(BOOTSTRAP_FIXTURE))
    frame = encode_presentation_frame_v3_packet(_fixture(FRAME_FIXTURE))

    assert _parse(bootstrap).header.message_type == PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3
    assert _parse(frame).header.message_type == PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3
    with pytest.raises(PacketError):
        encode_packet(b"payload", message_type=3)
    with pytest.raises(PacketError):
        encode_packet(
            b"payload",
            message_type=PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3,
            compression_codec=1,
        )


def test_packet_parser_applies_budgets_before_copying_payload() -> None:
    payload = _fixture(FRAME_FIXTURE)
    packet = encode_presentation_frame_v3_packet(payload)

    with pytest.raises(PacketError, match="maximum_stored_bytes"):
        _parse(packet, stored=len(payload) - 1)
    with pytest.raises(PacketError, match="maximum_uncompressed_bytes"):
        _parse(packet, uncompressed=len(payload) - 1)
    with pytest.raises(ConfigurationError):
        _parse(packet, stored=-1)


@pytest.mark.parametrize(
    "offset,packed",
    [
        (0, b"NOPE"),
        (4, struct.pack("<H", 2)),
        (6, struct.pack("<B", 3)),
        (7, struct.pack("<B", 1)),
        (8, struct.pack("<H", 1)),
        (10, struct.pack("<H", 20)),
        (16, struct.pack("<I", 567)),
        (20, struct.pack("<I", 1)),
    ],
)
def test_packet_parser_rejects_malformed_header(offset: int, packed: bytes) -> None:
    packet = bytearray(
        encode_presentation_frame_v3_packet(_fixture(FRAME_FIXTURE))
    )
    packet[offset : offset + len(packed)] = packed

    with pytest.raises(PacketError):
        _parse(packet)


def test_packet_parser_rejects_truncation_and_trailing_bytes() -> None:
    packet = encode_presentation_frame_v3_packet(_fixture(FRAME_FIXTURE))
    with pytest.raises(PacketError):
        _parse(packet[:-1])
    with pytest.raises(PacketError):
        _parse(packet + b"\x00")


def test_v3_decoders_validate_message_type_and_inner_schema() -> None:
    bootstrap = decode_scene_bootstrap_v3_packet(
        encode_scene_bootstrap_v3_packet(_fixture(BOOTSTRAP_FIXTURE)),
        maximum_stored_bytes=4096,
        maximum_uncompressed_bytes=4096,
        maximum_bootstrap_bytes=4096,
        maximum_static_nodes=10,
        maximum_scene_metadata=10,
        maximum_visual_types=10,
        maximum_animation_states=10,
    )
    assert bootstrap.identity.viewer_scope == "viewer:test"

    frame_bytes = _fixture(FRAME_FIXTURE)
    frame = decode_presentation_frame_v3_packet(
        encode_presentation_frame_v3_packet(frame_bytes),
        maximum_stored_bytes=4096,
        maximum_uncompressed_bytes=4096,
        maximum_frame_nodes=10,
        maximum_frame_events=10,
        maximum_frame_bytes=4096,
    )
    assert frame.frame_seq == 60

    with pytest.raises(PacketError, match="not SceneBootstrapV3"):
        decode_scene_bootstrap_v3_packet(
            encode_presentation_frame_v3_packet(frame_bytes),
            maximum_stored_bytes=4096,
            maximum_uncompressed_bytes=4096,
            maximum_bootstrap_bytes=4096,
            maximum_static_nodes=10,
            maximum_scene_metadata=10,
            maximum_visual_types=10,
            maximum_animation_states=10,
        )

    malformed = bytearray(frame_bytes)
    struct.pack_into("<H", malformed, 0, 2)
    with pytest.raises(PresentationFrameError):
        decode_presentation_frame_v3_packet(
            encode_presentation_frame_v3_packet(malformed),
            maximum_stored_bytes=4096,
            maximum_uncompressed_bytes=4096,
            maximum_frame_nodes=10,
            maximum_frame_events=10,
            maximum_frame_bytes=4096,
        )


def test_v1_and_unversioned_packet_aliases_are_not_exported() -> None:
    for name in (
        "decode_display_frame_packet",
        "encode_display_frame_packet",
        "decode_presentation_frame_packet",
        "encode_presentation_frame_packet",
        "decode_scene_bootstrap_packet",
        "encode_scene_bootstrap_packet",
        "pack_packet",
        "decode_packet",
        "PacketHeader",
    ):
        assert not hasattr(packet_codec, name)
        assert not hasattr(scene_engine, name)
