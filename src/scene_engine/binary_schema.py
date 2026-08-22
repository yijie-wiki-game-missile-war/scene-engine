"""Frozen primitive and PacketHeaderV1 declarations.

The :class:`struct.Struct` objects in this module always use an explicit
little-endian prefix.  They are wire declarations, not native Python or C
object layouts.
"""

from __future__ import annotations

import struct


UINT16_MAX = (1 << 16) - 1
UINT32_MAX = (1 << 32) - 1
UINT64_MAX = (1 << 64) - 1


PACKET_MAGIC = b"SEDF"
PACKET_VERSION = 1
PACKET_HEADER_BYTES = 24
PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3 = 1
PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3 = 2
PACKET_COMPRESSION_NONE = 0
PACKET_HEADER_V1 = struct.Struct("<4sHBBHHIII")


def _assert_frozen_sizes() -> None:
    """Fail at import time if a format is accidentally changed."""

    expected = ((PACKET_HEADER_V1, PACKET_HEADER_BYTES),)
    for declaration, byte_count in expected:
        if declaration.size != byte_count:  # pragma: no cover - import guard
            raise RuntimeError(
                "packed binary declaration has size {} instead of {}".format(
                    declaration.size, byte_count
                )
            )


_assert_frozen_sizes()


__all__ = [
    "PACKET_MAGIC",
    "PACKET_VERSION",
    "PACKET_HEADER_BYTES",
    "PACKET_MESSAGE_TYPE_SCENE_BOOTSTRAP_V3",
    "PACKET_MESSAGE_TYPE_PRESENTATION_FRAME_V3",
    "PACKET_COMPRESSION_NONE",
    "PACKET_HEADER_V1",
    "UINT16_MAX",
    "UINT32_MAX",
    "UINT64_MAX",
]
