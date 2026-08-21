"""Frozen packed-binary declarations for the experimental display profile.

The :class:`struct.Struct` objects in this module always use an explicit
little-endian prefix.  They are wire declarations, not native Python or C
object layouts.
"""

from __future__ import annotations

import struct


UINT16_MAX = (1 << 16) - 1
UINT32_MAX = (1 << 32) - 1
UINT64_MAX = (1 << 64) - 1


DISPLAY_FRAME_SCHEMA_VERSION = 1
DISPLAY_FRAME_FLAG_COMPLETE_DYNAMIC_SET = 1 << 0
DISPLAY_FRAME_HEADER_BYTES = 64

SECTION_DIRECTORY_ENTRY_BYTES = 20
SECTION_FLAG_REQUIRED = 1 << 0
SECTION_TYPE_DYNAMIC_ENTITIES = 1

DYNAMIC_ENTITY_RECORD_BYTES = 72
DYNAMIC_ENTITY_FLAG_VISIBLE = 1 << 0

DISPLAY_FRAME_HEADER_V1 = struct.Struct("<HHHHQQQQHHIIIII")
SECTION_DIRECTORY_ENTRY_V1 = struct.Struct("<HHIIIHH")
DYNAMIC_ENTITY_RECORD_V1 = struct.Struct("<QII3f4f3fIQI")


PACKET_MAGIC = b"SEDF"
PACKET_VERSION = 1
PACKET_HEADER_BYTES = 24
PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP = 1
PACKET_MESSAGE_TYPE_DISPLAY_FRAME = 2
PACKET_COMPRESSION_NONE = 0
PACKET_HEADER_V1 = struct.Struct("<4sHBBHHIII")


def _assert_frozen_sizes() -> None:
    """Fail at import time if a format is accidentally changed."""

    expected = (
        (DISPLAY_FRAME_HEADER_V1, DISPLAY_FRAME_HEADER_BYTES),
        (SECTION_DIRECTORY_ENTRY_V1, SECTION_DIRECTORY_ENTRY_BYTES),
        (DYNAMIC_ENTITY_RECORD_V1, DYNAMIC_ENTITY_RECORD_BYTES),
        (PACKET_HEADER_V1, PACKET_HEADER_BYTES),
    )
    for declaration, byte_count in expected:
        if declaration.size != byte_count:  # pragma: no cover - import guard
            raise RuntimeError(
                "packed binary declaration has size {} instead of {}".format(
                    declaration.size, byte_count
                )
            )


_assert_frozen_sizes()


__all__ = [
    "DISPLAY_FRAME_SCHEMA_VERSION",
    "DISPLAY_FRAME_FLAG_COMPLETE_DYNAMIC_SET",
    "DISPLAY_FRAME_HEADER_BYTES",
    "SECTION_DIRECTORY_ENTRY_BYTES",
    "SECTION_FLAG_REQUIRED",
    "SECTION_TYPE_DYNAMIC_ENTITIES",
    "DYNAMIC_ENTITY_RECORD_BYTES",
    "DYNAMIC_ENTITY_FLAG_VISIBLE",
    "DISPLAY_FRAME_HEADER_V1",
    "SECTION_DIRECTORY_ENTRY_V1",
    "DYNAMIC_ENTITY_RECORD_V1",
    "PACKET_MAGIC",
    "PACKET_VERSION",
    "PACKET_HEADER_BYTES",
    "PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP",
    "PACKET_MESSAGE_TYPE_DISPLAY_FRAME",
    "PACKET_COMPRESSION_NONE",
    "PACKET_HEADER_V1",
    "UINT16_MAX",
    "UINT32_MAX",
    "UINT64_MAX",
]
