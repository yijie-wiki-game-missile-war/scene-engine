from __future__ import annotations

import math
import struct

import pytest

import scene_engine.display_binary as display_binary_module
from scene_engine.display import (
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    encode_display_checkpoint,
    encode_display_command_stream,
)
from scene_engine.display_binary import (
    DISPLAY_BINARY_CHECKPOINT_MAGIC,
    DISPLAY_BINARY_COMMAND_STREAM_MAGIC,
    DISPLAY_BINARY_SCALAR_FLOAT32,
    DISPLAY_BINARY_VERSION,
    DISPLAY_CHECKPOINT_KIND,
    DISPLAY_CHECKPOINT_SCHEMA,
    DISPLAY_COMMAND_SCHEMA,
    DISPLAY_COMMAND_STREAM_KIND,
    DISPLAY_COMMAND_STREAM_SCHEMA,
    decode_display_checkpoint_binary,
    decode_display_command_stream_binary,
    encode_display_checkpoint_binary,
    encode_display_command_stream_binary,
)
from scene_engine.errors import ConfigurationError, WireError


HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
IDENTITY = [
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
]
POSE = [
    1.5, 0.0, 0.0, 0.0,
    0.25, 2.0, 0.0, 0.0,
    0.1, 0.2, 0.75, 0.0,
    1.25, -2.5, 3.75, 1.0,
]
OPAQUE_MATRIX_BITS = (
    0x7FC01234,
    0x80000000,
    0x7F800000,
    0x3F800000,
    0xBF800000,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
)


def checkpoint(*, transform: list = POSE, state: dict | None = None) -> dict:
    return {
        "schema": DISPLAY_CHECKPOINT_SCHEMA,
        "scene_name": "main",
        "scene_catalog_hash": HASH_A,
        "prefab_catalog_hash": HASH_B,
        "state_schema_hash": HASH_C,
        "last_command_seq": 7,
        "nodes": [
            {
                "name": "py/root",
                "parent_name": None,
                "prefab_id": "world/root",
                "transform_mode": "live",
                "transform": transform,
                "visible": True,
                "state": {"mode": "ready"} if state is None else state,
            },
            {
                "name": "py/child",
                "parent_name": "py/root",
                "prefab_id": "world/child",
                "transform_mode": "initial",
                "transform": IDENTITY,
                "visible": False,
                "state": {},
            },
        ],
    }


def command_stream() -> dict:
    variants = [
        (
            "node-create",
            {
                "parent_name": None,
                "prefab_id": "world/root",
                "transform_mode": "live",
                "transform": POSE,
                "visible": True,
                "state": {"created": True},
            },
        ),
        ("node-set-transform", {"transform": POSE}),
        ("node-set-parent", {"parent_name": None}),
        ("node-set-visible", {"visible": False}),
        ("node-set-state", {"state": {"items": [1, 2]}}),
        (
            "node-replace-prefab",
            {"prefab_id": "world/replacement", "state": {"mode": "other"}},
        ),
        ("node-remove", {}),
    ]
    base = 10
    return {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": base,
        "last_command_seq": base + len(variants),
        "commands": [
            {
                "schema": DISPLAY_COMMAND_SCHEMA,
                "command_seq": base + index,
                "source_tick": 20,
                "kind": kind,
                "name": f"py/node-{index}",
                **fields,
            }
            for index, (kind, fields) in enumerate(variants, 1)
        ],
    }


def test_binary_checkpoint_round_trips_semantics_and_seals_cursor() -> None:
    encoded = encode_display_checkpoint_binary(checkpoint(), 7)

    assert encoded.kind == DISPLAY_CHECKPOINT_KIND
    assert encoded.last_command_seq == 7
    assert encoded.source_tick is None
    assert encoded.base_command_seq is None
    assert bytes(encoded) == encoded.bytes
    assert encoded.bytes[:4] == DISPLAY_BINARY_CHECKPOINT_MAGIC
    assert encoded.bytes[4] == DISPLAY_BINARY_VERSION == 2
    assert encoded.bytes[5] == DISPLAY_BINARY_SCALAR_FLOAT32
    assert struct.unpack_from("<H", encoded.bytes, 6)[0] == 0
    assert struct.unpack_from("<Q", encoded.bytes, 8)[0] == 7
    _parent_offset, matrix_offset = _first_checkpoint_node_offsets(encoded.bytes)
    matrix = struct.unpack_from("<16f", encoded.bytes, matrix_offset)
    assert len(matrix) == 16
    assert (matrix[3], matrix[7], matrix[11], matrix[15]) == (0.0, 0.0, 0.0, 1.0)
    assert matrix == pytest.approx(POSE, abs=1e-6)

    decoded = decode_display_checkpoint_binary(encoded.bytes, 7)
    assert decoded["schema"] == DISPLAY_CHECKPOINT_SCHEMA
    assert decoded["last_command_seq"] == 7
    assert [node["name"] for node in decoded["nodes"]] == ["py/root", "py/child"]
    assert decoded["nodes"][1]["parent_name"] == "py/root"
    assert decoded["nodes"][1]["transform_mode"] == "initial"
    assert decoded["nodes"][1]["visible"] is False
    assert decoded["nodes"][0]["state"] == {"mode": "ready"}
    assert decoded["nodes"][0]["transform"] == pytest.approx(POSE, abs=1e-6)

    with pytest.raises(WireError, match="cursor"):
        decode_display_checkpoint_binary(encoded.bytes, 8)


def test_binary_matrix_round_trip_preserves_shear_and_float32_bits() -> None:
    matrix = [(-0.0 if value == 0.0 else value) for value in POSE]
    encoded = encode_display_checkpoint_binary(checkpoint(transform=matrix), 7)
    _parent_offset, matrix_offset = _first_checkpoint_node_offsets(encoded.bytes)
    bits = struct.unpack_from("<16I", encoded.bytes, matrix_offset)
    assert all(bits[index] == 0x80000000 for index in (1, 2, 3, 6, 7, 11))

    decoded = decode_display_checkpoint_binary(encoded.bytes, 7)
    assert decoded["nodes"][0]["transform"] == pytest.approx(POSE, abs=1e-6)
    assert all(
        struct.pack("<f", decoded["nodes"][0]["transform"][index])
        == b"\x00\x00\x00\x80"
        for index in (1, 2, 3, 6, 7, 11)
    )
    assert encode_display_checkpoint_binary(decoded, 7).bytes == encoded.bytes


def test_typed_stream_encoder_reuses_the_transform_matrix_bytes() -> None:
    transform = DisplayTransform.from_matrix(POSE)
    command = DisplayCommand.set_transform("py/root", transform)
    stream, cursor = encode_display_command_stream(
        base_command_seq=7,
        source_tick=9,
        commands=(command,),
    )

    assert command.fields["transform"] is transform
    assert display_binary_module._encode_matrix(transform) is transform.matrix_bytes
    encoded = encode_display_command_stream_binary(stream, 9, cursor)
    decoded = decode_display_command_stream_binary(encoded.bytes, 9, cursor)
    assert decoded["commands"][0]["transform"] == pytest.approx(POSE, abs=1e-6)


def test_typed_stream_encoder_transmits_opaque_matrix_bits_exactly() -> None:
    raw = struct.pack("<16I", *OPAQUE_MATRIX_BITS)
    transform = DisplayTransform(matrix_bytes=raw)
    command = DisplayCommand.set_transform("py/root", transform)
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(command,),
    )

    encoded = encode_display_command_stream_binary(stream, 1, cursor)

    assert display_binary_module._encode_matrix(transform) is raw
    assert encoded.bytes.endswith(raw)


def test_typed_checkpoint_encoder_transmits_opaque_matrix_bits_exactly() -> None:
    raw = struct.pack("<16I", *OPAQUE_MATRIX_BITS)
    transform = DisplayTransform(matrix_bytes=raw)
    checkpoint_seal = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        nodes=(
            DisplayNode(
                name="py/root",
                parent_name=None,
                prefab_id="world/root",
                transform_mode="live",
                transform=transform,
                visible=True,
                state={},
            ),
        ),
    )

    encoded = encode_display_checkpoint_binary(checkpoint_seal, 0)
    _parent_offset, matrix_offset = _first_checkpoint_node_offsets(encoded.bytes)

    assert checkpoint_seal.nodes[0].transform is transform
    assert encoded.bytes[matrix_offset : matrix_offset + len(raw)] == raw


def test_typed_outbound_stream_trusts_target_but_binary_decoder_validates_it() -> None:
    command = DisplayCommand.set_transform("product-owned-target", DisplayTransform.identity())
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(command,),
    )

    encoded = encode_display_command_stream_binary(stream, 1, cursor)
    with pytest.raises(WireError, match="authority Node name"):
        decode_display_command_stream_binary(encoded.bytes, 1, cursor)


def test_binary_command_stream_round_trips_all_opcodes_and_seals_header_values() -> None:
    value = command_stream()
    encoded = encode_display_command_stream_binary(value, 20, 17)

    assert encoded.kind == DISPLAY_COMMAND_STREAM_KIND
    assert encoded.base_command_seq == 10
    assert encoded.source_tick == 20
    assert encoded.last_command_seq == 17
    assert encoded.bytes[:4] == DISPLAY_BINARY_COMMAND_STREAM_MAGIC
    assert struct.unpack_from("<Q", encoded.bytes, 8)[0] == 10
    assert struct.unpack_from("<Q", encoded.bytes, 16)[0] == 20
    assert struct.unpack_from("<I", encoded.bytes, 24)[0] == 7

    decoded = decode_display_command_stream_binary(encoded.bytes, 20, 17)
    assert decoded["schema"] == DISPLAY_COMMAND_STREAM_SCHEMA
    assert decoded["base_command_seq"] == 10
    assert decoded["last_command_seq"] == 17
    assert [command["kind"] for command in decoded["commands"]] == [
        "node-create",
        "node-set-transform",
        "node-set-parent",
        "node-set-visible",
        "node-set-state",
        "node-replace-prefab",
        "node-remove",
    ]
    assert [command["command_seq"] for command in decoded["commands"]] == list(
        range(11, 18)
    )
    assert {command["source_tick"] for command in decoded["commands"]} == {20}
    assert decoded["commands"][2]["parent_name"] is None
    assert decoded["commands"][3]["visible"] is False
    assert decoded["commands"][4]["state"] == {"items": [1, 2]}

    with pytest.raises(WireError, match="source tick"):
        decode_display_command_stream_binary(encoded.bytes, 21, 17)
    with pytest.raises(WireError, match="cursor"):
        decode_display_command_stream_binary(encoded.bytes, 20, 18)


@pytest.mark.parametrize(
    ("offset", "replacement", "match"),
    [
        (0, b"NOPE", "magic"),
        (4, b"\x01", "version"),
        (5, b"\x02", "scalar"),
        (6, b"\x01\x00", "flags"),
    ],
)
def test_binary_header_and_framing_corruption_fail_closed(
    offset: int, replacement: bytes, match: str
) -> None:
    raw = bytearray(encode_display_checkpoint_binary(checkpoint(), 7).bytes)
    raw[offset : offset + len(replacement)] = replacement
    with pytest.raises(WireError, match=match):
        decode_display_checkpoint_binary(raw, 7)

    valid = encode_display_checkpoint_binary(checkpoint(), 7).bytes
    with pytest.raises(WireError, match="truncated"):
        decode_display_checkpoint_binary(valid[:-1], 7)
    with pytest.raises(WireError, match="trailing"):
        decode_display_checkpoint_binary(valid + b"\x00", 7)


def test_binary_checkpoint_rejects_parent_cycles_but_accepts_opaque_matrices() -> None:
    raw = bytearray(encode_display_checkpoint_binary(checkpoint(), 7).bytes)
    parent_offset, matrix_offset = _first_checkpoint_node_offsets(raw)

    invalid_parent = bytearray(raw)
    struct.pack_into("<I", invalid_parent, parent_offset, 0)
    with pytest.raises(WireError, match="earlier"):
        decode_display_checkpoint_binary(invalid_parent, 7)

    nonfinite = bytearray(raw)
    struct.pack_into("<I", nonfinite, matrix_offset, 0x7FC00000)
    assert math.isnan(
        decode_display_checkpoint_binary(nonfinite, 7)["nodes"][0]["transform"][0]
    )

    shear = bytearray(raw)
    struct.pack_into("<f", shear, matrix_offset + 4 * 4, 0.5)
    assert decode_display_checkpoint_binary(shear, 7)["nodes"][0]["transform"][4] == 0.5

    reflection = bytearray(raw)
    for component in range(3):
        offset = matrix_offset + component * 4
        before = struct.unpack_from("<f", reflection, offset)[0]
        struct.pack_into("<f", reflection, offset, -before)
    assert decode_display_checkpoint_binary(reflection, 7)["nodes"][0][
        "transform"
    ][0] == -POSE[0]


def test_binary_state_json_and_float32_quantization_fail_closed() -> None:
    deeply_nested = checkpoint(state={"outer": {"inner": 1}})
    encoded = encode_display_checkpoint_binary(deeply_nested, 7)
    with pytest.raises(WireError, match="state JSON"):
        decode_display_checkpoint_binary(encoded.bytes, 7, maximum_json_depth=1)
    with pytest.raises(ConfigurationError, match="canonical JSON"):
        encode_display_checkpoint_binary(
            deeply_nested,
            7,
            maximum_json_depth=1,
        )

    duplicate = _replace_first_state(encoded.bytes, b'{"x":1,"x":2}')
    with pytest.raises(WireError, match="duplicate"):
        decode_display_checkpoint_binary(duplicate, 7)

    unsafe = _replace_first_state(encoded.bytes, b'{"x":9007199254740992}')
    with pytest.raises(WireError, match="unsafe"):
        decode_display_checkpoint_binary(unsafe, 7)

    with pytest.raises(ConfigurationError, match="float32"):
        encode_display_checkpoint_binary(
            checkpoint(
                transform=[*IDENTITY[:12], 1e100, 0.0, 0.0, 1.0]
            ),
            7,
        )
    singular = [
        0.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
    encoded_singular = encode_display_checkpoint_binary(
        checkpoint(transform=singular),
        7,
    )
    assert decode_display_checkpoint_binary(encoded_singular.bytes, 7)["nodes"][0][
        "transform"
    ] == singular
    with pytest.raises(ConfigurationError, match="sixteen-value matrix"):
        encode_display_checkpoint_binary(
            checkpoint(
                transform={
                    "position": [0.0, 0.0, 0.0],
                    "rotationXyzw": [0.1, 0.2, 0.3, 0.9],
                    "scale": [1e-42, 1.0, 1.0],
                }
            ),
            7,
        )


def test_binary_encoder_accepts_only_current_semantic_record_versions() -> None:
    old = checkpoint()
    old["schema"] = "scene-engine-display-checkpoint@4"
    with pytest.raises(ConfigurationError, match="schema"):
        encode_display_checkpoint_binary(old, 7)

    commands = command_stream()
    commands["commands"][0]["schema"] = "scene-engine-node-command@4"
    with pytest.raises(ConfigurationError, match="fields"):
        encode_display_command_stream_binary(commands, 20, 17)

def _first_checkpoint_node_offsets(raw: bytes | bytearray) -> tuple[int, int]:
    cursor = 8 + 8
    scene_length = struct.unpack_from("<H", raw, cursor)[0]
    cursor += 2 + scene_length + 32 * 3
    node_count = struct.unpack_from("<I", raw, cursor)[0]
    assert node_count >= 1
    cursor += 4
    name_length = struct.unpack_from("<H", raw, cursor)[0]
    cursor += 2 + name_length
    parent_offset = cursor
    cursor += 4
    prefab_length = struct.unpack_from("<H", raw, cursor)[0]
    cursor += 2 + prefab_length
    cursor += 1
    return parent_offset, cursor


def _replace_first_state(raw: bytes, replacement: bytes) -> bytes:
    _parent_offset, matrix_offset = _first_checkpoint_node_offsets(raw)
    length_offset = matrix_offset + 16 * 4
    original_length = struct.unpack_from("<I", raw, length_offset)[0]
    state_offset = length_offset + 4
    return (
        raw[:length_offset]
        + struct.pack("<I", len(replacement))
        + replacement
        + raw[state_offset + original_length :]
    )
