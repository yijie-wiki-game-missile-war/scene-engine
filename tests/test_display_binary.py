from __future__ import annotations

import struct

import numpy as np
import pytest

from scene_engine.display import (
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayMatrixPool,
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
    0x7F801234, 0xFF801234, 0x7FC01234, 0xFFC05678,
    0x80000000, 0x7F800000, 0xFF800000, 0x3F800000,
    0xBF800000, 0, 0, 0,
    0, 0, 0, 0,
)


def _tensor_row(matrix: list[float]) -> list[list[float]]:
    return np.asarray(matrix, dtype="<f4").reshape((4, 4)).tolist()


def _assert_immutable_c_array(
    value: object, *, dtype: str, shape: tuple[int, ...]
) -> np.ndarray:
    assert isinstance(value, np.ndarray)
    assert value.dtype == np.dtype(dtype)
    assert value.shape == shape
    assert value.flags.c_contiguous
    assert not value.flags.writeable
    assert not value.flags.owndata
    with pytest.raises(ValueError):
        value.flags.writeable = True
    return value


def checkpoint(*, state: dict | None = None) -> dict:
    return {
        "schema": DISPLAY_CHECKPOINT_SCHEMA,
        "scene_name": "main",
        "scene_catalog_hash": HASH_A,
        "prefab_catalog_hash": HASH_B,
        "state_schema_hash": HASH_C,
        "last_command_seq": 7,
        "matrix_pool_size": 3,
        "matrix_pool": [
            _tensor_row(POSE),
            np.zeros((4, 4), "<f4").tolist(),
            _tensor_row(IDENTITY),
        ],
        "nodes": [
            {
                "node_id": 0,
                "parent_node_id": None,
                "prefab_id": "world/root",
                "transform_mode": "live",
                "visible": True,
                "state": {"mode": "ready"} if state is None else state,
            },
            {
                "node_id": 2,
                "parent_node_id": 0,
                "prefab_id": "world/child",
                "transform_mode": "initial",
                "visible": False,
                "state": {},
            },
        ],
    }


def command_stream() -> dict:
    variants = [
        ("node-create", 2, {"parent_node_id": None, "prefab_id": "world/root", "transform_mode": "live", "visible": True, "state": {"created": True}}),
        ("node-set-transform-batch", 2, {"node_ids": [0]}),
        ("node-set-parent", 3, {"parent_node_id": 0}),
        ("node-set-visible", 4, {"visible": False}),
        ("node-set-state", 5, {"state": {"items": [1, 2]}}),
        ("node-replace-prefab", 6, {"prefab_id": "world/replacement", "state": {"mode": "other"}}),
        ("node-set-property", 6, {"property_name": "status.health", "value": [None, True, {"amount": 3}]}),
        ("node-unset-property", 6, {"property_name": "temporaryFlag"}),
        ("node-emit-event", 6, {"event_name": "combat.Exploded", "payload": {"coins": 4}}),
        ("node-remove", 7, {}),
    ]
    base = 10
    return {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": base,
        "last_command_seq": base + len(variants),
        "matrix_pool_size": 8,
        "dirty_node_ids": [0, 2],
        "dirty_matrices": [_tensor_row(POSE), _tensor_row(IDENTITY)],
        "commands": [
            ({
                "schema": DISPLAY_COMMAND_SCHEMA,
                "command_seq": base + index,
                "source_tick": 20,
                "kind": kind,
                **fields,
            } if kind == "node-set-transform-batch" else {
                "schema": DISPLAY_COMMAND_SCHEMA,
                "command_seq": base + index,
                "source_tick": 20,
                "kind": kind,
                "node_id": node_id,
                **fields,
            })
            for index, (kind, node_id, fields) in enumerate(variants, 1)
        ],
    }


def single_command_stream(kind: str, fields: dict) -> dict:
    return {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": 0,
        "last_command_seq": 1,
        "matrix_pool_size": 1,
        "dirty_node_ids": [],
        "dirty_matrices": [],
        "commands": [
            {
                "schema": DISPLAY_COMMAND_SCHEMA,
                "command_seq": 1,
                "source_tick": 20,
                "kind": kind,
                "node_id": 0,
                **fields,
            }
        ],
    }


def test_binary_checkpoint_round_trips_full_pool_and_sparse_node_records() -> None:
    encoded = encode_display_checkpoint_binary(checkpoint(), 7)

    assert encoded.kind == DISPLAY_CHECKPOINT_KIND
    assert encoded.last_command_seq == 7
    assert bytes(encoded) == encoded.bytes
    assert encoded.bytes[:4] == DISPLAY_BINARY_CHECKPOINT_MAGIC
    assert encoded.bytes[4] == DISPLAY_BINARY_VERSION == 5
    assert encoded.bytes[5] == DISPLAY_BINARY_SCALAR_FLOAT32
    assert struct.unpack_from("<QII", encoded.bytes, 8) == (7, 3, 2)
    assert struct.unpack_from("<16f", encoded.bytes, 24) == pytest.approx(POSE)

    decoded = decode_display_checkpoint_binary(encoded.bytes, 7)
    assert decoded["matrix_pool_size"] == 3
    _assert_immutable_c_array(
        decoded["matrix_pool"], dtype="<f4", shape=(3, 4, 4)
    )
    assert [node["node_id"] for node in decoded["nodes"]] == [0, 2]
    assert decoded["nodes"][1]["parent_node_id"] == 0
    assert "transform" not in decoded["nodes"][0]
    assert encode_display_checkpoint_binary(decoded, 7).bytes == encoded.bytes

    with pytest.raises(WireError, match="cursor"):
        decode_display_checkpoint_binary(encoded.bytes, 8)


def test_checkpoint_tensor_preserves_opaque_float32_bits() -> None:
    raw = struct.pack("<16I", *OPAQUE_MATRIX_BITS)
    pool = DisplayMatrixPool()
    node_id = pool.append(DisplayTransform(matrix_bytes=raw))
    seal = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(DisplayNode(node_id=node_id, parent_node_id=None, prefab_id="world/root", transform_mode="live", visible=True, state={}),),
    )

    encoded = encode_display_checkpoint_binary(seal, 0)
    assert encoded.bytes[24:88] == raw
    decoded = decode_display_checkpoint_binary(encoded.bytes, 0)
    matrix_pool = _assert_immutable_c_array(
        decoded["matrix_pool"], dtype="<f4", shape=(1, 4, 4)
    )
    assert matrix_pool.view("<u4").reshape(-1).tolist() == list(OPAQUE_MATRIX_BITS)
    assert matrix_pool.tobytes() == raw
    assert encode_display_checkpoint_binary(decoded, 0).bytes == encoded.bytes


def test_binary_command_stream_round_trips_batch_then_all_command_opcodes() -> None:
    value = command_stream()
    encoded = encode_display_command_stream_binary(value, 20, 20)

    assert encoded.kind == DISPLAY_COMMAND_STREAM_KIND
    assert encoded.base_command_seq == 10
    assert encoded.source_tick == 20
    assert encoded.bytes[:4] == DISPLAY_BINARY_COMMAND_STREAM_MAGIC
    assert struct.unpack_from("<QQIII", encoded.bytes, 8) == (10, 20, 10, 8, 2)
    assert struct.unpack_from("<2I", encoded.bytes, 36) == (0, 2)
    assert struct.unpack_from("<16f", encoded.bytes, 44) == pytest.approx(POSE)

    decoded = decode_display_command_stream_binary(encoded.bytes, 20, 20)
    dirty_node_ids = _assert_immutable_c_array(
        decoded["dirty_node_ids"], dtype="<u4", shape=(2,)
    )
    np.testing.assert_array_equal(dirty_node_ids, np.asarray([0, 2], dtype="<u4"))
    _assert_immutable_c_array(
        decoded["dirty_matrices"], dtype="<f4", shape=(2, 4, 4)
    )
    assert [record["kind"] for record in decoded["commands"]] == [
        "node-create", "node-set-transform-batch", "node-set-parent",
        "node-set-visible", "node-set-state", "node-replace-prefab",
        "node-set-property", "node-unset-property", "node-emit-event", "node-remove",
    ]
    assert decoded["commands"][6]["value"] == [None, True, {"amount": 3}]
    assert decoded["commands"][8]["payload"] == {"coins": 4}
    assert not any("transform" in record for record in decoded["commands"])
    assert encode_display_command_stream_binary(decoded, 20, 20).bytes == encoded.bytes

    with pytest.raises(WireError, match="source tick"):
        decode_display_command_stream_binary(encoded.bytes, 21, 20)
    with pytest.raises(WireError, match="cursor"):
        decode_display_command_stream_binary(encoded.bytes, 20, 21)


def test_property_and_event_opcodes_have_exact_v5_binary_layouts() -> None:
    property_name = b"status.health"
    property_json = b'{"a":1,"b":[true,null]}'
    property_encoded = encode_display_command_stream_binary(
        single_command_stream(
            "node-set-property",
            {
                "property_name": property_name.decode(),
                "value": {"b": [True, None], "a": 1},
            },
        ),
        20,
        1,
    )
    assert property_encoded.bytes[36:] == (
        struct.pack("<BIH", 8, 0, len(property_name))
        + property_name
        + struct.pack("<I", len(property_json))
        + property_json
    )

    unset_name = b"temporaryFlag"
    unset_encoded = encode_display_command_stream_binary(
        single_command_stream(
            "node-unset-property", {"property_name": unset_name.decode()}
        ),
        20,
        1,
    )
    assert unset_encoded.bytes[36:] == (
        struct.pack("<BIH", 9, 0, len(unset_name)) + unset_name
    )

    event_name = b"combat.Exploded"
    event_json = b'{"coins":4,"critical":true}'
    event_encoded = encode_display_command_stream_binary(
        single_command_stream(
            "node-emit-event",
            {
                "event_name": event_name.decode(),
                "payload": {"critical": True, "coins": 4},
            },
        ),
        20,
        1,
    )
    assert event_encoded.bytes[36:] == (
        struct.pack("<BIH", 10, 0, len(event_name))
        + event_name
        + struct.pack("<I", len(event_json))
        + event_json
    )
    decoded = decode_display_command_stream_binary(event_encoded.bytes, 20, 1)
    assert decoded["commands"] == [
        {
            "schema": DISPLAY_COMMAND_SCHEMA,
            "command_seq": 1,
            "source_tick": 20,
            "kind": "node-emit-event",
            "node_id": 0,
            "event_name": "combat.Exploded",
            "payload": {"coins": 4, "critical": True},
        }
    ]


@pytest.mark.parametrize(
    "value",
    [None, False, "ready", 9007199254740991, -12.5, [1, "two"], {"ok": True}],
)
def test_binary_set_property_round_trips_any_json_value(value: object) -> None:
    encoded = encode_display_command_stream_binary(
        single_command_stream(
            "node-set-property", {"property_name": "value", "value": value}
        ),
        20,
        1,
    )
    decoded = decode_display_command_stream_binary(encoded.bytes, 20, 1)

    assert decoded["commands"][0]["value"] == value
    assert encode_display_command_stream_binary(decoded, 20, 1).bytes == encoded.bytes


def test_binary_property_json_and_event_object_fail_closed() -> None:
    property_encoded = encode_display_command_stream_binary(
        single_command_stream(
            "node-set-property", {"property_name": "value", "value": {"x": 1}}
        ),
        20,
        1,
    ).bytes
    for replacement, match in (
        (b'{"x":1,"x":2}', "duplicate"),
        (b"\xef\xbb\xbf{}", "BOM"),
        (b"9007199254740992", "unsafe integer"),
        (b"NaN", "non-finite"),
        (b'{"__proto__":1}', "property value JSON"),
        (b'"\xff"', "not valid UTF-8"),
    ):
        malformed = _replace_single_command_json(property_encoded, replacement)
        with pytest.raises(WireError, match=match):
            decode_display_command_stream_binary(malformed, 20, 1)

    deep = encode_display_command_stream_binary(
        single_command_stream(
            "node-set-property",
            {"property_name": "value", "value": {"outer": {"inner": 1}}},
        ),
        20,
        1,
    )
    with pytest.raises(WireError, match="property value JSON"):
        decode_display_command_stream_binary(
            deep.bytes, 20, 1, maximum_json_depth=1
        )
    with pytest.raises(ConfigurationError, match="property value.*canonical JSON"):
        encode_display_command_stream_binary(
            single_command_stream(
                "node-set-property",
                {"property_name": "value", "value": {"outer": {"inner": 1}}},
            ),
            20,
            1,
            maximum_json_depth=1,
        )

    event = encode_display_command_stream_binary(
        single_command_stream(
            "node-emit-event", {"event_name": "ready", "payload": {}}
        ),
        20,
        1,
    ).bytes
    primitive_payload = _replace_single_command_json(event, b"null")
    with pytest.raises(WireError, match="event payload must be a JSON object"):
        decode_display_command_stream_binary(primitive_payload, 20, 1)


def test_binary_message_names_share_the_semantic_unicode_contract() -> None:
    boundary_name = "界" * 64
    encoded = encode_display_command_stream_binary(
        single_command_stream(
            "node-set-property",
            {"property_name": boundary_name, "value": None},
        ),
        20,
        1,
    )
    decoded = decode_display_command_stream_binary(encoded.bytes, 20, 1)
    assert decoded["commands"][0]["property_name"] == boundary_name

    malformed = bytearray(
        encode_display_command_stream_binary(
            single_command_stream(
                "node-unset-property", {"property_name": "ok"}
            ),
            20,
            1,
        ).bytes
    )
    malformed[-2:] = b"a "
    with pytest.raises(WireError, match="decoded Display command"):
        decode_display_command_stream_binary(malformed, 20, 1)

    with pytest.raises(WireError, match="truncated"):
        decode_display_command_stream_binary(encoded.bytes[:-1], 20, 1)


def test_command_stream_fixed_command_limit_precedes_command_traversal() -> None:
    over_limit_count = 65_537
    encoded = encode_display_command_stream_binary(command_stream(), 20, 20)
    malformed = bytearray(encoded.bytes)
    struct.pack_into("<I", malformed, 24, over_limit_count)

    with pytest.raises(WireError, match="fixed limit of 65536"):
        decode_display_command_stream_binary(
            malformed,
            20,
            10 + over_limit_count,
        )

    oversized = command_stream()
    oversized["commands"] = [None] * over_limit_count
    oversized["last_command_seq"] = 10 + over_limit_count
    with pytest.raises(ConfigurationError, match="fixed limit of 65536"):
        encode_display_command_stream_binary(
            oversized,
            20,
            10 + over_limit_count,
        )


def test_typed_stream_gathers_pool_rows_without_inline_matrix() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(DisplayTransform.from_matrix(IDENTITY))
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(DisplayNode(node_id=node_id, parent_node_id=None, prefab_id="world/root", transform_mode="live", visible=True, state={}),),
    )
    baseline.confirm_published()
    raw = struct.pack("<16I", *OPAQUE_MATRIX_BITS)
    pool.set(node_id, DisplayTransform(matrix_bytes=raw))
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.set_transform_batch((node_id,)),),
    )

    encoded = encode_display_command_stream_binary(stream, 1, cursor)
    assert encoded.bytes[40:104] == raw
    assert encoded.bytes[104:] == struct.pack("<BI", 2, 1)
    decoded = decode_display_command_stream_binary(encoded.bytes, 1, cursor)
    assert "transform" not in decoded["commands"][0]
    decoded_batch_ids = _assert_immutable_c_array(
        decoded["commands"][0]["node_ids"], dtype="<u4", shape=(1,)
    )
    assert np.shares_memory(decoded_batch_ids, decoded["dirty_node_ids"])
    dirty_matrices = _assert_immutable_c_array(
        decoded["dirty_matrices"], dtype="<f4", shape=(1, 4, 4)
    )
    assert dirty_matrices.view("<u4").reshape(-1).tolist() == list(
        OPAQUE_MATRIX_BITS
    )
    assert dirty_matrices.tobytes() == raw
    assert encode_display_command_stream_binary(decoded, 1, cursor).bytes == encoded.bytes

    for invalid_count in (0, 2):
        malformed = bytearray(encoded.bytes)
        struct.pack_into("<I", malformed, 105, invalid_count)
        with pytest.raises(WireError, match="transform batch count"):
            decode_display_command_stream_binary(malformed, 1, cursor)


def test_empty_command_batch_round_trips_validated_record_and_binary() -> None:
    pool = DisplayMatrixPool()
    stream, _ = encode_display_command_stream(
        base_command_seq=3, source_tick=4, matrix_pool=pool, commands=()
    )
    encoded = encode_display_command_stream_binary(stream.to_record(), 4, 3)
    decoded = decode_display_command_stream_binary(encoded.bytes, 4, 3)
    _assert_immutable_c_array(
        decoded["dirty_node_ids"], dtype="<u4", shape=(0,)
    )
    _assert_immutable_c_array(
        decoded["dirty_matrices"], dtype="<f4", shape=(0, 4, 4)
    )
    assert encode_display_command_stream_binary(decoded, 4, 3).bytes == encoded.bytes


def test_empty_checkpoint_pool_decodes_to_exact_read_only_tensor_shape() -> None:
    value = checkpoint()
    value["matrix_pool_size"] = 0
    value["matrix_pool"] = []
    value["nodes"] = []
    encoded = encode_display_checkpoint_binary(value, 7)

    decoded = decode_display_checkpoint_binary(encoded.bytes, 7)

    _assert_immutable_c_array(
        decoded["matrix_pool"], dtype="<f4", shape=(0, 4, 4)
    )
    assert encode_display_checkpoint_binary(decoded, 7).bytes == encoded.bytes


def test_raw_stream_rejects_out_of_pool_command_and_parent_ids() -> None:
    value = command_stream()
    value["matrix_pool_size"] = 7
    with pytest.raises(ConfigurationError, match="outside"):
        encode_display_command_stream_binary(value, 20, 20)

    value = command_stream()
    value["commands"][2]["parent_node_id"] = 8
    with pytest.raises(ConfigurationError, match="outside"):
        encode_display_command_stream_binary(value, 20, 20)


def test_dirty_ids_must_be_sorted_unique_and_exact_matrix_targets() -> None:
    for dirty_ids in ([2, 0], [0, 0], [0]):
        value = command_stream()
        value["dirty_node_ids"] = dirty_ids
        value["dirty_matrices"] = [_tensor_row(POSE) for _ in dirty_ids]
        with pytest.raises(ConfigurationError, match="dirty"):
            encode_display_command_stream_binary(value, 20, 20)


@pytest.mark.parametrize(
    ("offset", "replacement", "match"),
    [(0, b"NOPE", "magic"), (4, b"\x04", "version"), (5, b"\x02", "scalar"), (6, b"\x01\x00", "flags")],
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


def test_checkpoint_rejects_nonzero_inactive_tombstone_and_bad_parent() -> None:
    value = checkpoint()
    value["matrix_pool"][1][0][0] = 1.0
    with pytest.raises(ConfigurationError, match="tombstone"):
        encode_display_checkpoint_binary(value, 7)

    raw = bytearray(encode_display_checkpoint_binary(checkpoint(), 7).bytes)
    first_record = _first_checkpoint_record_offset(raw)
    struct.pack_into("<I", raw, first_record + 4, 0)
    with pytest.raises(WireError, match="earlier"):
        decode_display_checkpoint_binary(raw, 7)


def test_binary_state_json_depth_and_duplicate_keys_fail_closed() -> None:
    deeply_nested = checkpoint(state={"outer": {"inner": 1}})
    encoded = encode_display_checkpoint_binary(deeply_nested, 7)
    with pytest.raises(WireError, match="state JSON"):
        decode_display_checkpoint_binary(encoded.bytes, 7, maximum_json_depth=1)
    with pytest.raises(ConfigurationError, match="canonical JSON"):
        encode_display_checkpoint_binary(deeply_nested, 7, maximum_json_depth=1)

    duplicate = _replace_first_state(encoded.bytes, b'{"x":1,"x":2}')
    with pytest.raises(WireError, match="duplicate"):
        decode_display_checkpoint_binary(duplicate, 7)


def test_binary_encoder_accepts_only_current_semantic_schema_versions() -> None:
    old = checkpoint()
    old["schema"] = "scene-engine-display-checkpoint@5"
    with pytest.raises(ConfigurationError, match="schema"):
        encode_display_checkpoint_binary(old, 7)

    commands = command_stream()
    commands["commands"][0]["schema"] = "scene-engine-node-command@5"
    with pytest.raises(ConfigurationError, match="schema"):
        encode_display_command_stream_binary(commands, 20, 20)


def _first_checkpoint_record_offset(raw: bytes | bytearray) -> int:
    pool_size = struct.unpack_from("<I", raw, 16)[0]
    cursor = 24 + pool_size * 64
    scene_length = struct.unpack_from("<H", raw, cursor)[0]
    return cursor + 2 + scene_length + 32 * 3


def _replace_first_state(raw: bytes, replacement: bytes) -> bytes:
    cursor = _first_checkpoint_record_offset(raw) + 8
    prefab_length = struct.unpack_from("<H", raw, cursor)[0]
    cursor += 2 + prefab_length + 1
    original_length = struct.unpack_from("<I", raw, cursor)[0]
    state_offset = cursor + 4
    return raw[:cursor] + struct.pack("<I", len(replacement)) + replacement + raw[state_offset + original_length :]


def _replace_single_command_json(raw: bytes, replacement: bytes) -> bytes:
    cursor = 36 + 1 + 4
    name_length = struct.unpack_from("<H", raw, cursor)[0]
    cursor += 2 + name_length
    original_length = struct.unpack_from("<I", raw, cursor)[0]
    value_offset = cursor + 4
    return (
        raw[:cursor]
        + struct.pack("<I", len(replacement))
        + replacement
        + raw[value_offset + original_length :]
    )
