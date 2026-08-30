from __future__ import annotations

import copy
import math
import pickle
import struct

import numpy as np
import pytest

from scene_engine.display import (
    DISPLAY_CHECKPOINT_SCHEMA,
    DISPLAY_COMMAND_SCHEMA,
    DISPLAY_COMMAND_STREAM_SCHEMA,
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    encode_display_checkpoint,
    encode_display_command_stream,
    validate_display_command_stream,
)
from scene_engine.errors import ConfigurationError


HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64


def transform(x: float = 0.0) -> DisplayTransform:
    return DisplayTransform.from_matrix(
        (
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            x,
            2.0,
            3.0,
            1.0,
        )
    )


def node(name: str, *, parent_name: str | None = None) -> DisplayNode:
    return DisplayNode(
        name=name,
        parent_name=parent_name,
        prefab_id="flight.aircraft/prefab@1",
        transform_mode="live",
        transform=transform(),
        visible=True,
        state={"animation": {"state": "idle", "start_tick": 0}},
    )


def test_checkpoint_is_a_typed_parent_first_seal_and_retains_nodes() -> None:
    parent = node("py/carrier-3")
    child = node("py/aircraft-17", parent_name="py/carrier-3")
    result = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=41,
        nodes=(parent, child),
    )

    assert result.scene_name == "main"
    assert result.last_command_seq == 41
    assert result.nodes == (parent, child)
    assert result.nodes[0] is parent
    record = result.to_record()
    assert record["schema"] == DISPLAY_CHECKPOINT_SCHEMA
    assert [item["name"] for item in record["nodes"]] == [
        "py/carrier-3",
        "py/aircraft-17",
    ]
    assert record["nodes"][0]["transform"][12:15] == [0.0, 2.0, 3.0]


def test_checkpoint_rejects_duplicate_missing_parent_and_invalid_authority_names() -> None:
    catalog = DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C)
    with pytest.raises(ConfigurationError, match="duplicate"):
        encode_display_checkpoint(
            scene_name="main",
            catalog=catalog,
            last_command_seq=0,
            nodes=(node("py/a"), node("py/a")),
        )
    with pytest.raises(ConfigurationError, match="parent-before-child"):
        encode_display_checkpoint(
            scene_name="main",
            catalog=catalog,
            last_command_seq=0,
            nodes=(node("py/a", parent_name="py/missing"),),
        )
    with pytest.raises(ConfigurationError, match="py/"):
        node("scene/main/a")


def test_command_stream_assigns_one_strict_sequence_per_single_target_record() -> None:
    commands = (
        DisplayCommand.create_node(node("py/aircraft-17")),
        DisplayCommand.set_transform("py/aircraft-17", transform(9.0)),
        DisplayCommand.set_state("py/aircraft-17", {"animation": {"state": "move"}}),
        DisplayCommand.remove("py/aircraft-17"),
    )
    result, cursor = encode_display_command_stream(
        base_command_seq=7,
        source_tick=60,
        commands=commands,
    )

    assert result.base_command_seq == 7
    assert result.last_command_seq == cursor == 11
    assert result.commands == commands
    assert result.commands[1] is commands[1]
    records = result.to_record()["commands"]
    assert [item["command_seq"] for item in records] == [8, 9, 10, 11]
    assert {item["source_tick"] for item in records} == {60}
    assert all(item["schema"] == DISPLAY_COMMAND_SCHEMA for item in records)
    assert all(isinstance(item["name"], str) for item in records)
    assert not any("nodes" in item for item in records)


def test_mutation_command_construction_trusts_target_but_decoded_records_validate_it() -> None:
    target = "product-owned-target"
    commands = (
        DisplayCommand.set_transform(target, DisplayTransform.identity()),
        DisplayCommand.set_parent(target, None),
        DisplayCommand.set_visible(target, False),
        DisplayCommand.set_state(target, {}),
        DisplayCommand.replace_prefab(target, "world/replacement", {}),
        DisplayCommand.remove(target),
    )

    assert {command.name for command in commands} == {target}
    with pytest.raises(ConfigurationError, match="target name must be a string"):
        DisplayCommand.remove([])  # type: ignore[arg-type]
    record = commands[0].to_record(command_seq=1, source_tick=1)
    with pytest.raises(ConfigurationError, match="Node prefix"):
        validate_display_command_stream(
            {
                "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
                "base_command_seq": 0,
                "last_command_seq": 1,
                "commands": [record],
            },
            expected_source_tick=1,
            expected_last_command_seq=1,
        )


def test_empty_command_stream_keeps_cursor_but_still_forms_a_commit_seal() -> None:
    result, cursor = encode_display_command_stream(
        base_command_seq=12,
        source_tick=90,
        commands=(),
    )
    assert result.to_record() == {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": 12,
        "last_command_seq": 12,
        "commands": [],
    }
    assert cursor == 12


def test_encoded_command_stream_is_recursively_immutable() -> None:
    result, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(DisplayCommand.set_transform("py/a", transform()),),
    )

    with pytest.raises((AttributeError, TypeError)):
        result.last_command_seq = 0
    with pytest.raises(AttributeError):
        result.commands.append({})
    with pytest.raises(TypeError):
        result.commands[0].fields["name"] = "py/b"
    with pytest.raises(AttributeError):
        result.commands[0].fields["transform"].matrix.append(4.0)


def test_command_shapes_state_and_transform_are_closed_and_owned() -> None:
    state = {"selected": False, "parts": [1, 2]}
    command = DisplayCommand.set_state("py/aircraft-17", state)
    state["selected"] = True
    state["parts"].append(3)
    record = command.to_record(command_seq=1, source_tick=0)
    assert record["state"] == {"selected": False, "parts": [1, 2]}

    with pytest.raises(ConfigurationError, match="named constructor"):
        DisplayCommand(kind="node-remove", name="py/a", visible=True)
    with pytest.raises(TypeError):
        DisplayTransform(
            position=(0, 0, 0),
            rotation_xyzw=(0, 0, 0, 1),
            scale=(1, 1, 1),
        )
    with pytest.raises(ConfigurationError, match="sixteen-value matrix"):
        DisplayTransform.from_record(
            {
                "position": [0, 0, 0],
                "rotationXyzw": [0, 0, 0, 1],
                "scale": [1, 1, 1],
            }
        )


def test_state_update_is_complete_replacement_not_a_merge_patch() -> None:
    command = DisplayCommand.set_state("py/a", {"mode": "ready"})
    record = command.to_record(command_seq=1, source_tick=2)
    assert set(record) == {
        "schema",
        "command_seq",
        "source_tick",
        "kind",
        "name",
        "state",
    }
    assert record["state"] == {"mode": "ready"}


def test_matrix_pack_owns_binary32_bits_without_semantic_normalization() -> None:
    matrix = [
        1.0,
        -0.0,
        0.0,
        -0.0,
        0.25,
        1.0,
        -0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        -0.0,
        1.25,
        -2.5,
        3.75,
        1.0,
    ]
    value = DisplayTransform.from_matrix(matrix)
    matrix[12] = 99.0

    assert value.matrix[4] == 0.25
    assert value.matrix[12] == 1.25
    bits = struct.unpack("<16I", value.matrix_bytes)
    assert all(bits[index] == 0x80000000 for index in (1, 3, 6, 11))
    assert all(bits[index] == 0 for index in (2, 7, 8, 9))
    assert value.to_record() == list(value.matrix)
    command = DisplayCommand.set_transform("py/a", value)
    stream, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        commands=(command,),
    )
    assert command.fields["transform"] is value
    assert stream.commands[0] is command
    assert stream.commands[0].fields["transform"] is value


def test_matrix_bytes_are_retained_exactly_without_semantic_validation() -> None:
    raw_bits = (
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
    raw = struct.pack("<16I", *raw_bits)
    value = DisplayTransform(matrix_bytes=raw)

    assert value.matrix_bytes == raw
    assert struct.unpack("<16I", value.matrix_bytes) == raw_bits
    assert math.isnan(value.matrix[0])
    assert value.matrix[1] == 0.0
    assert math.copysign(1.0, value.matrix[1]) == -1.0
    assert math.isinf(value.matrix[2])


def test_matrix_has_one_owned_readonly_fortran_float32_representation() -> None:
    source = [float(index) for index in range(16)]
    value = DisplayTransform.from_matrix(source)
    source[0] = 99.0

    assert DisplayTransform.__slots__ == ("_matrix",)
    assert isinstance(value._matrix, np.ndarray)
    assert value._matrix.shape == (4, 4)
    assert value._matrix.dtype == np.dtype("<f4")
    assert value._matrix.flags.f_contiguous
    assert not value._matrix.flags.c_contiguous
    assert value._matrix.flags.owndata
    assert not value._matrix.flags.writeable
    assert value._matrix.base is None
    assert value.matrix[0] == 0.0

    with pytest.raises(ValueError, match="read-only"):
        value._matrix[0, 0] = 1.0

    buffer = value._matrix_buffer()
    assert isinstance(buffer, np.ndarray)
    assert buffer.shape == (4, 4)
    assert buffer.flags.c_contiguous
    assert not buffer.flags.writeable
    assert np.shares_memory(buffer, value._matrix)
    assert buffer.nbytes == 64
    assert buffer.tobytes() == value.matrix_bytes
    with pytest.raises(ValueError, match="read-only"):
        buffer[0, 0] = 0


def test_transform_equality_and_hash_compare_all_float32_bits() -> None:
    nan_a = struct.pack(
        "<16I",
        0x7FC01234,
        0x80000000,
        *([0] * 14),
    )
    same_nan_a = bytes(bytearray(nan_a))
    nan_b = struct.pack(
        "<16I",
        0x7FC05678,
        0x80000000,
        *([0] * 14),
    )
    positive_zero = struct.pack(
        "<16I",
        0x7FC01234,
        0x00000000,
        *([0] * 14),
    )
    first = DisplayTransform(matrix_bytes=nan_a)
    same = DisplayTransform(matrix_bytes=same_nan_a)
    different_nan = DisplayTransform(matrix_bytes=nan_b)
    different_zero = DisplayTransform(matrix_bytes=positive_zero)

    assert first == same
    assert hash(first) == hash(same)
    assert len({first, same}) == 1
    assert first != different_nan
    assert first != different_zero
    assert first != nan_a


def test_transform_copy_and_pickle_preserve_readonly_owned_storage() -> None:
    raw = struct.pack("<16I", 0x7FC01234, 0x80000000, *range(14))
    value = DisplayTransform(matrix_bytes=raw)

    assert copy.copy(value) is value
    assert copy.deepcopy(value) is value

    restored = pickle.loads(pickle.dumps(value))
    assert restored == value
    assert restored.matrix_bytes == raw
    assert restored._matrix.shape == (4, 4)
    assert restored._matrix.flags.f_contiguous
    assert restored._matrix.flags.owndata
    assert not restored._matrix.flags.writeable
    assert restored._matrix.base is None


def test_matrix_only_rejects_invalid_storage_shape_or_unrepresentable_values() -> None:
    identity = list(DisplayTransform.identity().matrix)
    non_affine = identity.copy()
    non_affine[3] = 1.0
    assert DisplayTransform.from_matrix(non_affine).matrix[3] == 1.0

    reflection = identity.copy()
    reflection[0] = -1.0
    assert DisplayTransform.from_matrix(reflection).matrix[0] == -1.0

    nonfinite = identity.copy()
    nonfinite[0] = math.nan
    nonfinite[1] = math.inf
    packed_nonfinite = DisplayTransform.from_matrix(nonfinite)
    assert math.isnan(packed_nonfinite.matrix[0])
    assert math.isinf(packed_nonfinite.matrix[1])

    with pytest.raises(ConfigurationError, match="exactly 64 bytes"):
        DisplayTransform(matrix_bytes=b"\0" * 63)
    with pytest.raises(ConfigurationError, match="exactly 64 bytes"):
        DisplayTransform(matrix_bytes=bytearray(64))  # type: ignore[arg-type]

    outside_float32 = identity.copy()
    outside_float32[0] = 1.0e100
    with pytest.raises(ConfigurationError, match="float32"):
        DisplayTransform.from_matrix(outside_float32)

    conversion_overflow = identity.copy()
    conversion_overflow[0] = 10**10_000
    with pytest.raises(ConfigurationError, match="float32"):
        DisplayTransform.from_matrix(conversion_overflow)


def test_numpy_error_policy_does_not_change_opaque_matrix_operation_semantics() -> None:
    nonfinite = list(DisplayTransform.identity().matrix)
    nonfinite[0] = math.inf
    value = DisplayTransform.from_matrix(nonfinite)

    with np.errstate(all="raise"):
        composed = value.composed(DisplayTransform.identity())
        rotated = value.rotated_self((0.0, 1.0, 0.0), 0.25)

    assert isinstance(composed, DisplayTransform)
    assert isinstance(rotated, DisplayTransform)


def test_transform_from_trs_builds_a_literal_binary32_matrix() -> None:
    assert DisplayTransform.from_trs() == DisplayTransform.identity()

    value = DisplayTransform.from_trs(
        position=(1, 2, 3),
        rotation_xyzw=(0, 0, 2, 0),
        scale=(2, 3, 4),
    )

    assert value.matrix == (
        -2.0,
        0.0,
        0.0,
        0.0,
        0.0,
        -3.0,
        0.0,
        0.0,
        0.0,
        0.0,
        4.0,
        0.0,
        1.0,
        2.0,
        3.0,
        1.0,
    )
    assert isinstance(value.matrix, tuple)


def test_transform_composition_is_parent_times_local_and_leaves_inputs_unchanged() -> None:
    parent = DisplayTransform.from_trs(position=(10, 20, 30), scale=(2, 3, 4))
    local = DisplayTransform.from_trs(position=(1, 2, 3))
    parent_before = parent.matrix
    local_before = local.matrix

    result = parent.composed(local)

    assert result is not parent
    assert result is not local
    assert result.matrix == (
        2.0,
        0.0,
        0.0,
        0.0,
        0.0,
        3.0,
        0.0,
        0.0,
        0.0,
        0.0,
        4.0,
        0.0,
        12.0,
        26.0,
        42.0,
        1.0,
    )
    assert parent.matrix == parent_before
    assert local.matrix == local_before


def test_with_translation_and_scale_preserve_basis_directions_shear_and_translation() -> None:
    value = DisplayTransform.from_matrix(
        (
            1,
            0,
            0,
            0,
            0.5,
            1,
            0,
            0,
            0.25,
            -0.5,
            2,
            0,
            7,
            8,
            9,
            1,
        )
    )
    before = value.matrix

    moved = value.with_translation((11, 12, 13))
    assert moved.matrix[:12] == before[:12]
    assert moved.matrix[12:15] == (11.0, 12.0, 13.0)

    resized = value.with_scale((2, 3, 5))
    for column, target in enumerate((2, 3, 5)):
        offset = column * 4
        original = before[offset : offset + 3]
        changed = resized.matrix[offset : offset + 3]
        original_length = math.hypot(*original)
        assert math.hypot(*changed) == pytest.approx(target, abs=1e-6)
        assert tuple(item / target for item in changed) == pytest.approx(
            tuple(item / original_length for item in original), abs=1e-6
        )
    assert resized.matrix[12:15] == before[12:15]

    def normalized_dot(matrix: tuple[float, ...], left: int, right: int) -> float:
        left_column = matrix[left * 4 : left * 4 + 3]
        right_column = matrix[right * 4 : right * 4 + 3]
        return sum(a * b for a, b in zip(left_column, right_column, strict=True)) / (
            math.hypot(*left_column) * math.hypot(*right_column)
        )

    for pair in ((0, 1), (0, 2), (1, 2)):
        assert normalized_dot(resized.matrix, *pair) == pytest.approx(
            normalized_dot(before, *pair), abs=1e-6
        )
    assert value.matrix == before


def test_self_and_parent_translation_use_distinct_spaces() -> None:
    value = DisplayTransform.from_matrix(
        (
            0,
            1,
            0,
            0,
            -1,
            0,
            0,
            0,
            0,
            0,
            1,
            0,
            10,
            20,
            30,
            1,
        )
    )
    before = value.matrix

    translated_self = value.translated_self((2, 3, 4))
    translated_parent = value.translated_parent((2, 3, 4))

    assert translated_self.matrix[:12] == before[:12]
    assert translated_self.matrix[12:15] == (7.0, 22.0, 34.0)
    assert translated_parent.matrix[:12] == before[:12]
    assert translated_parent.matrix[12:15] == (12.0, 23.0, 34.0)
    assert value.matrix == before


def test_self_and_parent_rotation_multiply_the_basis_on_opposite_sides() -> None:
    value = DisplayTransform.from_trs(position=(5, 6, 7), scale=(2, 3, 4))
    before = value.matrix

    rotated_self = value.rotated_self((0, 0, 5), math.pi / 2)
    rotated_parent = value.rotated_parent((0, 0, 5), math.pi / 2)

    assert rotated_self.matrix[:12] == pytest.approx(
        (0, 3, 0, 0, -2, 0, 0, 0, 0, 0, 4, 0), abs=1e-6
    )
    assert rotated_parent.matrix[:12] == pytest.approx(
        (0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0), abs=1e-6
    )
    assert rotated_self.matrix[12:15] == before[12:15]
    assert rotated_parent.matrix[12:15] == before[12:15]
    assert value.matrix == before


def test_self_and_parent_scale_multiply_columns_and_rows_without_moving() -> None:
    value = DisplayTransform.from_matrix(
        (
            1,
            1,
            0,
            0,
            0,
            2,
            1,
            0,
            1,
            0,
            3,
            0,
            5,
            6,
            7,
            1,
        )
    )
    before = value.matrix

    scaled_self = value.scaled_self((2, 3, 4))
    scaled_parent = value.scaled_parent((2, 3, 4))

    assert scaled_self.matrix[:12] == (
        2.0,
        2.0,
        0.0,
        0.0,
        0.0,
        6.0,
        3.0,
        0.0,
        4.0,
        0.0,
        12.0,
        0.0,
    )
    assert scaled_parent.matrix[:12] == (
        2.0,
        3.0,
        0.0,
        0.0,
        0.0,
        6.0,
        4.0,
        0.0,
        2.0,
        0.0,
        12.0,
        0.0,
    )
    assert scaled_self.matrix[12:15] == before[12:15]
    assert scaled_parent.matrix[12:15] == before[12:15]
    assert value.matrix == before


def test_point_and_vector_transform_differ_by_translation_and_inverse_round_trip() -> None:
    value = DisplayTransform.from_matrix(
        (
            1,
            1,
            0,
            0,
            0,
            2,
            1,
            0,
            1,
            0,
            3,
            0,
            5,
            6,
            7,
            1,
        )
    )
    point = (2, -1, 4)
    vector = (2, -1, 4)

    transformed_point = value.transform_point(point)
    transformed_vector = value.transform_vector(vector)

    assert transformed_point == pytest.approx((11, 6, 18))
    assert transformed_vector == pytest.approx((6, 0, 11))
    assert tuple(
        transformed_point[index] - transformed_vector[index] for index in range(3)
    ) == value.matrix[12:15]
    assert value.inverse_transform_point(transformed_point) == pytest.approx(point)
    assert value.inverse_transform_vector(transformed_vector) == pytest.approx(vector)
    assert isinstance(transformed_point, tuple)
    assert isinstance(transformed_vector, tuple)


def test_transform_conveniences_reject_invalid_inputs_without_mutating_source() -> None:
    value = DisplayTransform.from_trs(position=(1, 2, 3), scale=(2, 3, 4))
    before = value.matrix
    invalid_operations = (
        lambda: DisplayTransform.from_trs(position=(1, 2)),
        lambda: DisplayTransform.from_trs(rotation_xyzw=(0, 0, 0, 0)),
        lambda: DisplayTransform.from_trs(rotation_xyzw=(0, 0, math.nan, 1)),
        lambda: DisplayTransform.from_trs(scale=(1, 0, 1)),
        lambda: value.composed(value.matrix),
        lambda: value.with_translation((1, 2, math.inf)),
        lambda: value.with_scale((1, -1, 1)),
        lambda: value.translated_self((1, 2)),
        lambda: value.translated_parent((1.0e100, 0, 0)),
        lambda: value.rotated_self((0, 0, 0), 1),
        lambda: value.rotated_parent((0, 1, 0), math.nan),
        lambda: value.scaled_self((1, 0, 1)),
        lambda: value.scaled_parent((1, 1, math.inf)),
        lambda: value.transform_point((1, 2)),
        lambda: value.inverse_transform_point((1, math.nan, 2)),
        lambda: value.transform_vector((1, True, 2)),
        lambda: value.inverse_transform_vector((1, 2, 3, 4)),
    )

    for operation in invalid_operations:
        with pytest.raises(ConfigurationError):
            operation()
        assert value.matrix == before
