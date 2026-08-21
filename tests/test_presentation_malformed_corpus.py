from __future__ import annotations

import json
from pathlib import Path
import struct

import pytest

from scene_engine.errors import PresentationFrameError, SceneBootstrapError
from scene_engine.presentation_frame import parse_presentation_frame
from scene_engine.scene_bootstrap import parse_scene_bootstrap


FIXTURES = Path(__file__).parent / "fixtures"
CORPUS = json.loads(
    (FIXTURES / "presentation_malformed_v1.json").read_text(encoding="utf-8")
)
BOOTSTRAP = bytes.fromhex(
    (FIXTURES / "scene_bootstrap_v1.hex").read_text(encoding="ascii")
)
FRAME = bytes.fromhex(
    (FIXTURES / "presentation_frame_v2.hex").read_text(encoding="ascii")
)


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda case: case["id"])
def test_shared_malformed_corpus_fails_closed(case) -> None:
    source = BOOTSTRAP if case["target"] == "bootstrap" else FRAME
    malformed = mutate(source, case["operation"])
    if case["target"] == "bootstrap":
        with pytest.raises(SceneBootstrapError):
            parse_scene_bootstrap(
                malformed,
                maximum_bootstrap_bytes=1024 * 1024,
                maximum_static_nodes=100,
                maximum_topology_nodes=100,
                maximum_adjacencies=200,
                maximum_visual_types=100,
                maximum_animation_states=100,
            )
    else:
        with pytest.raises(PresentationFrameError):
            parse_presentation_frame(
                malformed,
                maximum_frame_entities=100,
                maximum_frame_events=100,
                maximum_frame_bytes=1024 * 1024,
            )


def mutate(source: bytes, operation) -> bytes:
    kind = operation["kind"]
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
        raise AssertionError("unknown malformed corpus operation: {}".format(kind))
    return bytes(value)
