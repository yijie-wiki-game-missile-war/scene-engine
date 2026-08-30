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
    DisplayMatrixPool,
    DisplayNode,
    DisplayTransform,
    encode_display_checkpoint,
    encode_display_command_stream,
    validate_display_command_stream,
)
from scene_engine.display_binary import encode_display_command_stream_binary
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


def node(node_id: int, *, parent_node_id: int | None = None) -> DisplayNode:
    return DisplayNode(
        node_id=node_id,
        parent_node_id=parent_node_id,
        prefab_id="flight.aircraft/prefab@1",
        transform_mode="live",
        visible=True,
        state={"animation": {"state": "idle", "start_tick": 0}},
    )


def test_checkpoint_is_a_typed_parent_first_full_pool_snapshot() -> None:
    pool = DisplayMatrixPool()
    parent_id = pool.append(transform())
    child_id = pool.append(transform(4.0))
    parent = node(parent_id)
    child = node(child_id, parent_node_id=parent_id)
    result = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=41,
        matrix_pool=pool,
        nodes=(parent, child),
    )

    assert result.scene_name == "main"
    assert result.last_command_seq == 41
    assert result.matrix_pool_size == 2
    assert result.matrix_pool.shape == (2, 4, 4)
    assert result.matrix_pool.dtype == np.dtype("<f4")
    assert result.matrix_pool.flags.c_contiguous
    assert not result.matrix_pool.flags.writeable
    assert result.nodes == (parent, child)
    assert result.nodes[0] is parent
    record = result.to_record()
    assert record["schema"] == DISPLAY_CHECKPOINT_SCHEMA
    assert [item["node_id"] for item in record["nodes"]] == [0, 1]
    assert "transform" not in record["nodes"][0]
    assert np.asarray(record["matrix_pool"], dtype="<f4").shape == (2, 4, 4)


def test_checkpoint_rejects_duplicate_missing_parent_and_pool_mismatch() -> None:
    catalog = DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C)
    pool = DisplayMatrixPool()
    pool.append(transform())
    with pytest.raises(ConfigurationError, match="duplicate"):
        encode_display_checkpoint(
            scene_name="main",
            catalog=catalog,
            last_command_seq=0,
            matrix_pool=pool,
            nodes=(node(0), node(0)),
        )
    with pytest.raises(ConfigurationError, match="parent-before-child"):
        encode_display_checkpoint(
            scene_name="main",
            catalog=catalog,
            last_command_seq=0,
            matrix_pool=pool,
            nodes=(node(0, parent_node_id=1),),
        )
    pool.append(transform())
    with pytest.raises(ConfigurationError, match="exactly match"):
        encode_display_checkpoint(
            scene_name="main",
            catalog=catalog,
            last_command_seq=0,
            matrix_pool=pool,
            nodes=(node(0),),
        )


def test_matrix_pool_is_contiguous_monotonic_and_retirement_never_reuses_ids() -> None:
    pool = DisplayMatrixPool()
    first = pool.append(transform(1.0))
    second = pool.append(transform(2.0))

    assert (first, second) == (0, 1)
    assert len(pool) == pool.size == 2
    matrices = pool.matrices
    assert matrices.shape == (2, 4, 4)
    assert matrices.dtype == np.dtype("<f4")
    assert matrices.flags.c_contiguous
    assert not matrices.flags.writeable
    assert matrices[1].tobytes() == transform(2.0).matrix_bytes

    checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(node(first), node(second)),
    )
    checkpoint.confirm_published()
    pool.retire(first)
    assert np.array_equal(pool.matrices[first].view("<u4"), np.zeros((4, 4), "<u4"))
    with pytest.raises(ConfigurationError, match="retired"):
        pool.set(first, transform())
    with pytest.raises(ConfigurationError, match="retired"):
        pool.transform(first)
    third = pool.append(transform(3.0))
    assert third == 2
    with pytest.raises(ConfigurationError, match="published"):
        pool.retire(third)


def test_matrix_pool_public_snapshot_cannot_bypass_dirty_tracking() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(transform(1.0))
    checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(node(node_id),),
    )
    checkpoint.confirm_published()

    exposed = pool.matrices
    with pytest.raises(ValueError):
        exposed.flags.writeable = True
    assert pool.transform(node_id).matrix_bytes == transform(1.0).matrix_bytes
    stream, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(),
    )
    assert stream.dirty_node_ids.tolist() == []


def test_command_stream_assigns_sequences_and_gathers_sorted_dirty_rows() -> None:
    pool = DisplayMatrixPool()
    existing_id = pool.append(transform())
    checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=7,
        matrix_pool=pool,
        nodes=(node(existing_id),),
    )
    checkpoint.confirm_published()
    created_id = pool.append(transform(8.0))
    pool.set(existing_id, transform(9.0))
    commands = (
        DisplayCommand.create_node(node(created_id, parent_node_id=existing_id)),
        DisplayCommand.set_transform(existing_id),
        DisplayCommand.set_state(created_id, {"animation": {"state": "move"}}),
    )
    result, cursor = encode_display_command_stream(
        base_command_seq=7,
        source_tick=60,
        matrix_pool=pool,
        commands=commands,
    )

    assert result.last_command_seq == cursor == 10
    assert result.commands == commands
    assert result.dirty_node_ids.tolist() == [existing_id, created_id]
    assert result.dirty_matrices.shape == (2, 4, 4)
    assert result.dirty_matrices[0].tobytes() == transform(9.0).matrix_bytes
    assert result.dirty_matrices[1].tobytes() == transform(8.0).matrix_bytes
    records = result.to_record()["commands"]
    assert [item["command_seq"] for item in records] == [8, 9, 10]
    assert {item["source_tick"] for item in records} == {60}
    assert all(item["schema"] == DISPLAY_COMMAND_SCHEMA for item in records)
    assert [item["node_id"] for item in records] == [created_id, existing_id, created_id]
    assert not any("transform" in item for item in records)
    assert result.maximum_json_depth == 2
    encode_display_command_stream_binary(
        result,
        expected_source_tick=60,
        expected_last_command_seq=cursor,
        maximum_json_depth=2,
    )
    with pytest.raises(ConfigurationError, match="seal is invalid"):
        encode_display_command_stream_binary(
            result,
            expected_source_tick=60,
            expected_last_command_seq=cursor,
            maximum_json_depth=1,
        )


def test_command_lifecycle_rejects_uncreated_set_transform_and_duplicate_remove() -> None:
    pool = DisplayMatrixPool()
    existing_id = pool.append(transform())
    checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(node(existing_id),),
    )
    checkpoint.confirm_published()
    pending_id = pool.append(transform())
    with pytest.raises(ConfigurationError, match="not active"):
        encode_display_command_stream(
            base_command_seq=0,
            source_tick=1,
            matrix_pool=pool,
            commands=(DisplayCommand.set_transform(pending_id),),
        )

    pool.retire(existing_id)
    removed, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.create_node(node(pending_id)), DisplayCommand.remove(existing_id)),
    )
    removed.confirm_published()
    with pytest.raises(ConfigurationError, match="not active"):
        encode_display_command_stream(
            base_command_seq=2,
            source_tick=2,
            matrix_pool=pool,
            commands=(DisplayCommand.remove(existing_id),),
        )


def test_mutation_command_construction_uses_uint32_node_ids() -> None:
    target = 17
    commands = (
        DisplayCommand.set_transform(target),
        DisplayCommand.set_parent(target, None),
        DisplayCommand.set_visible(target, False),
        DisplayCommand.set_state(target, {}),
        DisplayCommand.replace_prefab(target, "world/replacement", {}),
        DisplayCommand.remove(target),
    )

    assert {command.node_id for command in commands} == {target}
    with pytest.raises(ConfigurationError, match="uint32"):
        DisplayCommand.remove([])  # type: ignore[arg-type]


def test_empty_command_stream_keeps_cursor_but_still_forms_a_commit_seal() -> None:
    pool = DisplayMatrixPool()
    result, cursor = encode_display_command_stream(
        base_command_seq=12,
        source_tick=90,
        matrix_pool=pool,
        commands=(),
    )
    assert result.to_record() == {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": 12,
        "last_command_seq": 12,
        "matrix_pool_size": 0,
        "dirty_node_ids": [],
        "dirty_matrices": [],
        "commands": [],
    }
    assert cursor == 12
    assert validate_display_command_stream(
        result.to_record(), expected_source_tick=90, expected_last_command_seq=12
    ) == ()


def test_encoded_command_stream_is_recursively_immutable() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(transform())
    result, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.create_node(node(node_id)),),
    )

    with pytest.raises((AttributeError, TypeError)):
        result.last_command_seq = 0
    with pytest.raises(AttributeError):
        result.commands.append({})
    with pytest.raises(TypeError):
        result.commands[0].fields["state"] = {}
    with pytest.raises(ValueError, match="read-only"):
        result.dirty_matrices[0, 0, 0] = 4.0


def test_command_shapes_state_and_transform_are_closed_and_owned() -> None:
    state = {"selected": False, "parts": [1, 2]}
    command = DisplayCommand.set_state(17, state)
    state["selected"] = True
    state["parts"].append(3)
    record = command.to_record(command_seq=1, source_tick=0)
    assert record["state"] == {"selected": False, "parts": [1, 2]}

    with pytest.raises(ConfigurationError, match="named constructor"):
        DisplayCommand(kind="node-remove", node_id=0, visible=True)
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
    command = DisplayCommand.set_state(0, {"mode": "ready"})
    record = command.to_record(command_seq=1, source_tick=2)
    assert set(record) == {
        "schema",
        "command_seq",
        "source_tick",
        "kind",
        "node_id",
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


def test_failed_binary_encode_does_not_clear_dirty_snapshot() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(transform())
    stream, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.create_node(node(node_id)),),
    )
    with pytest.raises(ConfigurationError, match="invalid"):
        encode_display_command_stream_binary(stream, 1, 2)
    retry, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.create_node(node(node_id)),),
    )
    assert retry.dirty_node_ids.tolist() == [node_id]
    retry.confirm_published()
    empty, _ = encode_display_command_stream(
        base_command_seq=1,
        source_tick=2,
        matrix_pool=pool,
        commands=(),
    )
    assert empty.dirty_node_ids.tolist() == []


def test_stale_publish_token_cannot_clear_a_newer_pool_mutation() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(transform())
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(node(node_id),),
    )
    baseline.confirm_published()
    pool.set(node_id, transform(1.0))
    stale, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.set_transform(node_id),),
    )
    pool.set(node_id, transform(2.0))

    with pytest.raises(ConfigurationError, match="changed after"):
        stale.confirm_published()
    retry, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.set_transform(node_id),),
    )
    assert retry.dirty_matrices[0].tobytes() == transform(2.0).matrix_bytes


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


def test_matrix_pool_transform_returns_an_exact_detached_readonly_snapshot() -> None:
    raw_bits = (
        0x7F801234,
        0x80000000,
        0x3F800000,
        0,
        0,
        0x3F800000,
        0,
        0,
        0,
        0,
        0x3F800000,
        0,
        0,
        0,
        0,
        0x3F800000,
    )
    pool = DisplayMatrixPool()
    node_id = pool.append(DisplayTransform(matrix_bytes=struct.pack("<16I", *raw_bits)))

    snapshot = pool.transform(node_id)
    pool.set(node_id, transform(9.0))

    assert struct.unpack("<16I", snapshot.matrix_bytes) == raw_bits
    assert snapshot.matrix_bytes != pool.transform(node_id).matrix_bytes
    assert snapshot._matrix.flags.f_contiguous
    assert snapshot._matrix.flags.owndata
    assert not snapshot._matrix.flags.writeable


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
