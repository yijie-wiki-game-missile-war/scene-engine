from __future__ import annotations

import json
from pathlib import Path
import hashlib
import struct

import pytest

from scene_engine.errors import PresentationFrameError, SceneBootstrapError
from scene_engine.presentation_frame import parse_presentation_frame_v3
from scene_engine.scene_bootstrap import parse_scene_bootstrap_v3


FIXTURES = Path(__file__).parent / "fixtures"
CORPUS = json.loads(
    (FIXTURES / "presentation_malformed_v3.json").read_text(encoding="utf-8")
)
BOOTSTRAP = bytes.fromhex(
    (FIXTURES / "scene_bootstrap_v3.hex").read_text(encoding="ascii")
)
FRAME = bytes.fromhex(
    (FIXTURES / "presentation_frame_v3.hex").read_text(encoding="ascii")
)


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda case: case["id"])
def test_shared_v3_malformed_corpus_fails_closed(case) -> None:
    source = BOOTSTRAP if case["target"] == "bootstrap" else FRAME
    malformed = mutate(source, case["operation"])
    if case["target"] == "bootstrap":
        with pytest.raises(SceneBootstrapError):
            parse_scene_bootstrap_v3(
                malformed,
                maximum_bootstrap_bytes=1024 * 1024,
                maximum_static_nodes=100,
                maximum_scene_metadata=100,
                maximum_visual_types=100,
                maximum_animation_states=100,
            )
    else:
        with pytest.raises(PresentationFrameError):
            parse_presentation_frame_v3(
                malformed,
                maximum_frame_nodes=100,
                maximum_frame_events=100,
                maximum_frame_bytes=1024 * 1024,
            )


def mutate(source: bytes, operation) -> bytes:
    kind = operation["kind"]
    if kind == "bootstrap_identity_over_limit":
        run = b"r" * 4095
        viewer = b"v"
        profile = b"p"
        payload = struct.pack(
            "<HHHIH", len(run), len(viewer), len(profile),
            len(run) + len(viewer) + len(profile), 0,
        ) + run + viewer + profile
        return _replace_bootstrap_section(source, 0, _pad4(payload))
    if kind == "bootstrap_codec_identity_over_limit":
        codec = b"a" * 161
        cursor = b"c"
        payload = struct.pack(
            "<HIIH", len(codec), len(cursor), len(codec) + len(cursor), 0,
        ) + codec + cursor
        return _replace_bootstrap_section(source, 1, _pad4(payload))
    if kind == "bootstrap_cursor_over_limit":
        codec = b"c"
        cursor = b"x" * (16 * 1024 + 1)
        payload = struct.pack(
            "<HIIH", len(codec), len(cursor), len(codec) + len(cursor), 0,
        ) + codec + cursor
        return _replace_bootstrap_section(source, 1, _pad4(payload))
    if kind == "bootstrap_remove_node_payload":
        return _remove_bootstrap_node_payload(
            source,
            operation["payload"],
            operation["node_index"],
        )
    if kind == "truncate":
        return source[: operation["length"]]
    if kind == "append_u8":
        return source + bytes((operation["value"],))
    value = bytearray(source)
    offset = operation["offset"]
    if kind == "xor_u8":
        value[offset] ^= operation["value"]
    elif kind == "write_u8":
        value[offset] = operation["value"]
    elif kind == "write_u16":
        struct.pack_into("<H", value, offset, operation["value"])
    elif kind == "write_u32":
        struct.pack_into("<I", value, offset, operation["value"])
    elif kind == "write_u64":
        struct.pack_into("<Q", value, offset, operation["value"])
    else:  # pragma: no cover - corpus schema guard
        raise AssertionError(f"unknown malformed corpus operation: {kind}")
    return bytes(value)


def _remove_bootstrap_node_payload(
    source: bytes,
    payload: str,
    node_index: int,
) -> bytes:
    refs_index, blob_index = {
        "profile": (3, 4),
        "interaction": (5, 6),
    }[payload]
    value = bytearray(source)
    refs_entry = 96 + refs_index * 20
    blob_entry = 96 + blob_index * 20
    node_count = struct.unpack_from("<I", value, refs_entry + 4)[0]
    if not 0 <= node_index < node_count:
        raise AssertionError("node_index is outside the bootstrap fixture")
    refs_offset = struct.unpack_from("<I", value, refs_entry + 8)[0]
    blob_offset = struct.unpack_from("<I", value, blob_entry + 8)[0]
    blob_count = struct.unpack_from("<I", value, blob_entry + 4)[0]
    target_ref = refs_offset + node_index * 24
    removed_offset, removed_length = struct.unpack_from("<II", value, target_ref + 16)
    if removed_length == 0:
        raise AssertionError("fixture payload selected for removal is already absent")
    struct.pack_into("<IIII", value, target_ref + 8, 0, 0, removed_offset, 0)
    for index in range(node_index + 1, node_count):
        ref = refs_offset + index * 24
        offset = struct.unpack_from("<I", value, ref + 16)[0]
        struct.pack_into("<I", value, ref + 16, offset - removed_length)
    logical_blob = bytes(value[blob_offset : blob_offset + blob_count])
    logical_blob = (
        logical_blob[:removed_offset]
        + logical_blob[removed_offset + removed_length :]
    )
    return _replace_bootstrap_section(
        bytes(value),
        blob_index,
        _pad4(logical_blob),
        record_count=len(logical_blob),
    )


def _replace_bootstrap_section(
    source: bytes,
    section_index: int,
    replacement: bytes,
    *,
    record_count: int | None = None,
) -> bytes:
    value = bytearray(source)
    entry = 96 + section_index * 20
    old_offset, old_length = struct.unpack_from("<II", value, entry + 8)
    delta = len(replacement) - old_length
    result = bytearray(
        value[:old_offset] + replacement + value[old_offset + old_length :]
    )
    if record_count is not None:
        struct.pack_into("<I", result, entry + 4, record_count)
    struct.pack_into("<I", result, entry + 12, len(replacement))
    for index in range(section_index + 1, 11):
        following = 96 + index * 20
        offset = struct.unpack_from("<I", result, following + 8)[0]
        struct.pack_into("<I", result, following + 8, offset + delta)
    payload_bytes = struct.unpack_from("<I", result, 44)[0]
    struct.pack_into("<I", result, 44, payload_bytes + delta)
    result[48:80] = hashlib.sha256(result[96:]).digest()
    return bytes(result)


def _pad4(value: bytes) -> bytes:
    return value + b"\x00" * ((-len(value)) % 4)
