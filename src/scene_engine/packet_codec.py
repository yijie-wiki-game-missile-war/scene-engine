"""Exact codec-none envelope for canonical V3 presentation messages."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .binary_schema import (
    PACKET_COMPRESSION_NONE,
    PACKET_HEADER_BYTES,
    PACKET_HEADER_V1,
    PACKET_MAGIC,
    PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3,
    PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3,
    PACKET_VERSION,
    UINT32_MAX,
)
from .errors import ConfigurationError, PacketError
from .presentation_frame import PresentationFrameV3View, parse_presentation_frame_v3
from .scene_bootstrap import SceneBootstrapV3View, parse_scene_bootstrap_v3


_KNOWN_MESSAGE_TYPES = frozenset(
    (
        PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3,
        PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3,
    )
)


@dataclass(frozen=True)
class PacketHeaderV1:
    magic: bytes
    packet_version: int
    message_type: int
    compression_codec: int
    flags: int
    header_bytes: int
    uncompressed_bytes: int
    stored_bytes: int
    reserved0: int


@dataclass(frozen=True)
class PacketView:
    header: PacketHeaderV1
    payload: bytes
    data: bytes


def encode_packet(
    payload: Any,
    *,
    message_type: int,
    compression_codec: int = PACKET_COMPRESSION_NONE,
) -> bytes:
    """Wrap canonical bytes in PacketHeaderV1 without transforming them."""

    if message_type not in _KNOWN_MESSAGE_TYPES:
        raise PacketError("unsupported packet message_type")
    if compression_codec != PACKET_COMPRESSION_NONE:
        raise PacketError("only compression_codec 0/none is supported")
    payload_view = _byte_view(payload)
    payload_size = payload_view.nbytes
    if payload_size > UINT32_MAX:
        raise PacketError("payload cannot be represented by PacketHeaderV1")
    canonical_payload = payload if isinstance(payload, bytes) else payload_view.tobytes()
    header = PACKET_HEADER_V1.pack(
        PACKET_MAGIC,
        PACKET_VERSION,
        message_type,
        compression_codec,
        0,
        PACKET_HEADER_BYTES,
        payload_size,
        payload_size,
        0,
    )
    return header + canonical_payload


def encode_scene_bootstrap_v3_packet(bootstrap: Any) -> bytes:
    return encode_packet(
        bootstrap,
        message_type=PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3,
    )


def encode_presentation_frame_v3_packet(frame: Any) -> bytes:
    return encode_packet(
        frame,
        message_type=PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3,
    )


def parse_packet(
    data: Any,
    *,
    maximum_stored_bytes: int,
    maximum_uncompressed_bytes: int,
) -> PacketView:
    """Validate the complete envelope and budgets before exposing payload."""

    _validate_budget("maximum_stored_bytes", maximum_stored_bytes)
    _validate_budget("maximum_uncompressed_bytes", maximum_uncompressed_bytes)
    initial_view = _byte_view(data)
    if initial_view.nbytes < PACKET_HEADER_BYTES:
        raise PacketError("packet is shorter than PacketHeaderV1")
    if initial_view.nbytes > PACKET_HEADER_BYTES + maximum_stored_bytes:
        raise PacketError("packet exceeds maximum_stored_bytes")

    canonical = data if isinstance(data, bytes) else initial_view.tobytes()
    view = memoryview(canonical)
    header = PacketHeaderV1(*PACKET_HEADER_V1.unpack_from(view, 0))
    if header.magic != PACKET_MAGIC:
        raise PacketError("packet magic must be SEDF")
    if header.packet_version != PACKET_VERSION:
        raise PacketError("unsupported packet_version")
    if header.message_type not in _KNOWN_MESSAGE_TYPES:
        raise PacketError("unsupported packet message_type")
    if header.compression_codec != PACKET_COMPRESSION_NONE:
        raise PacketError("only compression_codec 0/none is supported")
    if header.flags != 0:
        raise PacketError("packet flags must be zero for version 1")
    if header.header_bytes != PACKET_HEADER_BYTES:
        raise PacketError("header_bytes must be 24 for PacketHeaderV1")
    if header.reserved0 != 0:
        raise PacketError("packet reserved0 must be zero")
    if header.stored_bytes > maximum_stored_bytes:
        raise PacketError("packet exceeds maximum_stored_bytes")
    if header.uncompressed_bytes > maximum_uncompressed_bytes:
        raise PacketError("packet exceeds maximum_uncompressed_bytes")
    if header.stored_bytes != header.uncompressed_bytes:
        raise PacketError("codec none requires stored_bytes == uncompressed_bytes")
    expected_total = header.header_bytes + header.stored_bytes
    if view.nbytes != expected_total:
        raise PacketError("packet length does not match stored_bytes")
    return PacketView(
        header=header,
        payload=view[header.header_bytes:expected_total].tobytes(),
        data=canonical,
    )


def decode_scene_bootstrap_v3_packet(
    data: Any,
    *,
    maximum_stored_bytes: int,
    maximum_uncompressed_bytes: int,
    maximum_bootstrap_bytes: int,
    maximum_static_nodes: int,
    maximum_scene_metadata: int,
    maximum_visual_types: int,
    maximum_animation_states: int,
) -> SceneBootstrapV3View:
    packet = parse_packet(
        data,
        maximum_stored_bytes=maximum_stored_bytes,
        maximum_uncompressed_bytes=maximum_uncompressed_bytes,
    )
    if packet.header.message_type != PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3:
        raise PacketError("packet message_type is not SceneBootstrapV3")
    return parse_scene_bootstrap_v3(
        packet.payload,
        maximum_bootstrap_bytes=maximum_bootstrap_bytes,
        maximum_static_nodes=maximum_static_nodes,
        maximum_scene_metadata=maximum_scene_metadata,
        maximum_visual_types=maximum_visual_types,
        maximum_animation_states=maximum_animation_states,
    )


def decode_presentation_frame_v3_packet(
    data: Any,
    *,
    maximum_stored_bytes: int,
    maximum_uncompressed_bytes: int,
    maximum_frame_nodes: int,
    maximum_frame_events: int,
    maximum_frame_bytes: int,
) -> PresentationFrameV3View:
    packet = parse_packet(
        data,
        maximum_stored_bytes=maximum_stored_bytes,
        maximum_uncompressed_bytes=maximum_uncompressed_bytes,
    )
    if packet.header.message_type != PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3:
        raise PacketError("packet message_type is not PresentationFrameV3")
    return parse_presentation_frame_v3(
        packet.payload,
        maximum_frame_nodes=maximum_frame_nodes,
        maximum_frame_events=maximum_frame_events,
        maximum_frame_bytes=maximum_frame_bytes,
    )


def _validate_budget(field_name: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigurationError("{} must be an integer".format(field_name))
    if value < 0 or value > UINT32_MAX:
        raise ConfigurationError(
            "{} must be in [0, {}]".format(field_name, UINT32_MAX)
        )


def _byte_view(data: Any) -> memoryview:
    try:
        view = memoryview(data)
    except TypeError as exc:
        raise PacketError("binary input must support the buffer protocol") from exc
    if not view.c_contiguous:
        raise PacketError("binary input must be C-contiguous")
    try:
        return view.cast("B")
    except (TypeError, ValueError) as exc:
        raise PacketError("binary input must be byte-addressable") from exc


__all__ = [
    "PacketHeaderV1",
    "PacketView",
    "decode_presentation_frame_v3_packet",
    "decode_scene_bootstrap_v3_packet",
    "encode_packet",
    "encode_presentation_frame_v3_packet",
    "encode_scene_bootstrap_v3_packet",
    "parse_packet",
]
