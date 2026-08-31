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
from scene_engine.errors import ConfigurationError, JsonTreeError


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


def nested_json_value(depth: int) -> object:
    value: object = 0
    for _ in range(depth):
        value = {"next": value}
    return value


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


def test_matrix_pool_set_batch_preserves_id_row_alignment_and_exact_bits() -> None:
    pool = DisplayMatrixPool()
    node_ids = tuple(pool.append(transform(float(index))) for index in range(3))
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=tuple(node(node_id) for node_id in node_ids),
    )
    baseline.confirm_published()

    source_ids = np.asarray([2, 0], dtype="<u4")
    bits = np.arange(32, dtype="<u4").reshape((2, 4, 4))
    bits[0, 0, 0] = 0x7F801234
    bits[1, 0, 0] = 0x80000000
    matrices = bits.view("<f4")
    expected_for_two = matrices[0].tobytes()
    expected_for_zero = matrices[1].tobytes()
    generation = pool._mutation_generation

    pool.set_batch(source_ids, matrices)

    assert pool._mutation_generation == generation + 1
    assert pool._versions[0] == pool._versions[2] == generation + 1
    matrices.view("<u4").fill(0)
    assert pool.transform(2).matrix_bytes == expected_for_two
    assert pool.transform(0).matrix_bytes == expected_for_zero

    command = DisplayCommand.set_transform_batch(source_ids)
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(command,),
    )
    assert cursor == 1
    assert command.node_ids.tolist() == [0, 2]
    assert stream.dirty_node_ids.tolist() == [0, 2]
    assert stream.dirty_matrices[0].tobytes() == expected_for_zero
    assert stream.dirty_matrices[1].tobytes() == expected_for_two
    assert stream.transform_batch_matrices is not None
    assert np.shares_memory(stream.transform_batch_matrices, stream.dirty_matrices)


def test_matrix_pool_set_batch_validates_everything_before_mutation() -> None:
    pool = DisplayMatrixPool()
    node_ids = tuple(pool.append(transform(float(index))) for index in range(2))
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=tuple(node(node_id) for node_id in node_ids),
    )
    baseline.confirm_published()
    matrices = np.zeros((2, 4, 4), dtype="<f4")

    before = pool.matrices
    generation = pool._mutation_generation
    versions = pool._versions.copy()
    dirty = set(pool._dirty_ids)
    for invalid_ids, invalid_matrices in (
        ([0, 2], matrices),
        ([0, 0], matrices),
        ([0, 1], matrices.astype("<f8")),
        ([0, 1], matrices[:, :, ::-1]),
        ([], np.empty((0, 4, 4), dtype="<f4")),
    ):
        with pytest.raises(ConfigurationError):
            pool.set_batch(invalid_ids, invalid_matrices)
        assert np.array_equal(pool.matrices.view("<u4"), before.view("<u4"))
        assert pool._mutation_generation == generation
        assert np.array_equal(pool._versions, versions)
        assert pool._dirty_ids == dirty

    pool.retire(0)
    before = pool.matrices
    generation = pool._mutation_generation
    versions = pool._versions.copy()
    dirty = set(pool._dirty_ids)
    with pytest.raises(ConfigurationError, match="retired"):
        pool.set_batch([1, 0], matrices)
    assert np.array_equal(pool.matrices.view("<u4"), before.view("<u4"))
    assert pool._mutation_generation == generation
    assert np.array_equal(pool._versions, versions)
    assert pool._dirty_ids == dirty


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
        DisplayCommand.set_transform_batch((existing_id,)),
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
    assert records[0]["node_id"] == created_id
    assert records[1]["node_ids"] == [existing_id]
    assert records[2]["node_id"] == created_id
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

    malformed_prefix = result.to_record()
    malformed_prefix["commands"][1]["node_ids"] = [created_id]
    with pytest.raises(ConfigurationError, match="dirty Node ID prefix"):
        validate_display_command_stream(
            malformed_prefix,
            expected_source_tick=60,
            expected_last_command_seq=cursor,
        )

    malformed_suffix = result.to_record()
    malformed_suffix["commands"][1]["node_ids"] = [existing_id, created_id]
    with pytest.raises(ConfigurationError, match="exactly match create commands"):
        validate_display_command_stream(
            malformed_suffix,
            expected_source_tick=60,
            expected_last_command_seq=cursor,
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
            commands=(DisplayCommand.set_transform_batch((pending_id,)),),
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


def test_command_stream_rejects_more_than_one_transform_batch() -> None:
    pool = DisplayMatrixPool()
    node_ids = tuple(pool.append(transform(float(index))) for index in range(2))
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=tuple(node(node_id) for node_id in node_ids),
    )
    baseline.confirm_published()
    matrices = np.repeat(np.eye(4, dtype="<f4")[None, :, :], 2, axis=0)
    pool.set_batch(
        np.asarray(node_ids, dtype="<u4"),
        matrices,
    )

    with pytest.raises(ConfigurationError, match="at most one"):
        encode_display_command_stream(
            base_command_seq=0,
            source_tick=1,
            matrix_pool=pool,
            commands=(
                DisplayCommand.set_transform_batch((0,)),
                DisplayCommand.set_transform_batch((1,)),
            ),
        )


def test_mutation_command_construction_uses_uint32_node_ids() -> None:
    target = 17
    commands = (
        DisplayCommand.set_transform_batch((target,)),
        DisplayCommand.set_parent(target, None),
        DisplayCommand.set_visible(target, False),
        DisplayCommand.set_state(target, {}),
        DisplayCommand.set_property(target, "status.health", None),
        DisplayCommand.unset_property(target, "status.health"),
        DisplayCommand.emit_event(target, "combat.Exploded", {}),
        DisplayCommand.replace_prefab(target, "world/replacement", {}),
        DisplayCommand.remove(target),
    )

    assert commands[0].node_id is None
    assert commands[0].node_ids.tolist() == [target]
    assert {command.node_id for command in commands[1:]} == {target}
    with pytest.raises(ConfigurationError, match="uint32"):
        DisplayCommand.remove([])  # type: ignore[arg-type]


def test_transform_batch_constructor_sorts_copies_and_freezes_node_ids() -> None:
    source = np.asarray([5, 1, 3], dtype=">u4")
    command = DisplayCommand.set_transform_batch(source)
    source.fill(0)

    assert command.node_id is None
    assert command.node_ids is not None
    assert command.node_ids.tolist() == [1, 3, 5]
    assert command.node_ids.dtype == np.dtype("<u4")
    assert command.node_ids.flags.c_contiguous
    assert not command.node_ids.flags.writeable
    assert not np.shares_memory(command.node_ids, source)
    assert command == DisplayCommand.set_transform_batch([3, 5, 1])
    assert command.to_record(command_seq=7, source_tick=9)["node_ids"] == [1, 3, 5]
    with pytest.raises(ValueError, match="read-only"):
        command.node_ids[0] = 0
    for invalid in ([], [1, 1], [-1], [0xFFFFFFFF], [1.5]):
        with pytest.raises(ConfigurationError):
            DisplayCommand.set_transform_batch(invalid)
    with pytest.raises(ConfigurationError, match="one-dimensional integer"):
        DisplayCommand.set_transform_batch(np.asarray([1.0], dtype="<f4"))
    assert not hasattr(DisplayCommand, "set_transform")


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


def test_property_and_event_commands_are_owned_closed_and_ordered() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(transform())
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=4,
        matrix_pool=pool,
        nodes=(node(node_id),),
    )
    baseline.confirm_published()
    property_value = {"parts": ["wing", {"health": 4}]}
    event_payload = {"damage": {"amount": 12}, "critical": True}
    commands = (
        DisplayCommand.set_property(node_id, "status.health", property_value),
        DisplayCommand.unset_property(node_id, "temporaryFlag"),
        DisplayCommand.emit_event(node_id, "combat.Exploded", event_payload),
    )
    property_value["parts"].append("mutated")
    event_payload["damage"]["amount"] = 99

    stream, cursor = encode_display_command_stream(
        base_command_seq=4,
        source_tick=60,
        matrix_pool=pool,
        commands=commands,
    )
    records = stream.to_record()["commands"]

    assert cursor == 7
    assert [record["command_seq"] for record in records] == [5, 6, 7]
    assert {record["source_tick"] for record in records} == {60}
    assert records[0] == {
        "schema": DISPLAY_COMMAND_SCHEMA,
        "command_seq": 5,
        "source_tick": 60,
        "kind": "node-set-property",
        "node_id": node_id,
        "property_name": "status.health",
        "value": {"parts": ["wing", {"health": 4}]},
    }
    assert records[1]["property_name"] == "temporaryFlag"
    assert records[2]["payload"] == {
        "damage": {"amount": 12},
        "critical": True,
    }
    assert stream.maximum_json_depth == 4
    assert validate_display_command_stream(
        stream.to_record(),
        expected_source_tick=60,
        expected_last_command_seq=7,
    ) == commands

    with pytest.raises(TypeError):
        commands[0].fields["value"] = None
    with pytest.raises(TypeError):
        commands[2].fields["payload"]["critical"] = False


@pytest.mark.parametrize(
    "value",
    [None, True, "ready", 9007199254740991, -12.5, [1, "two"], {"ok": False}],
)
def test_set_property_accepts_every_json_value_shape(value: object) -> None:
    record = DisplayCommand.set_property(0, "value", value).to_record(
        command_seq=1, source_tick=2
    )
    assert record["value"] == value


def test_set_property_null_is_distinct_from_unset_and_event_payload_is_object() -> None:
    set_record = DisplayCommand.set_property(0, "optional", None).to_record(
        command_seq=1, source_tick=2
    )
    unset_record = DisplayCommand.unset_property(0, "optional").to_record(
        command_seq=2, source_tick=2
    )
    event_record = DisplayCommand.emit_event(0, "ready").to_record(
        command_seq=3, source_tick=2
    )

    assert "value" in set_record and set_record["value"] is None
    assert "value" not in unset_record
    assert event_record["payload"] == {}
    for invalid in (None, [], "payload", 1):
        with pytest.raises(ConfigurationError, match="event payload"):
            DisplayCommand.emit_event(0, "ready", invalid)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "name",
    [
        "status.health",
        "Health",
        "生命值",
        "combat/impact",
        "🔥",
        "界" * 64,
        "unassigned\u0378",
        "unicode-version-boundary\u088f",
    ],
)
def test_property_and_event_names_accept_unicode_without_path_semantics(
    name: str,
) -> None:
    assert DisplayCommand.set_property(0, name, 1).fields["property_name"] == name
    assert DisplayCommand.unset_property(0, name).fields["property_name"] == name
    assert DisplayCommand.emit_event(0, name, {}).fields["event_name"] == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        " ",
        "a b",
        "a\tb",
        "a\nb",
        "zero\x00byte",
        "format\u200bmark",
        "private\ue000use",
        "lone\ud800surrogate",
        "noncharacter\ufdd0",
        "plane-noncharacter\U0001ffff",
        "__proto__",
        "prototype",
        "constructor",
        "界" * 65,
    ],
)
def test_property_and_event_names_reject_ambiguous_or_unsafe_unicode(
    name: str,
) -> None:
    with pytest.raises(ConfigurationError):
        DisplayCommand.set_property(0, name, 1)
    with pytest.raises(ConfigurationError):
        DisplayCommand.unset_property(0, name)
    with pytest.raises(ConfigurationError):
        DisplayCommand.emit_event(0, name, {})


@pytest.mark.parametrize(
    "value",
    [b"bytes", 9007199254740992, math.nan, math.inf, {1: "bad"}, {"__proto__": 1}],
)
def test_set_property_rejects_values_outside_json(value: object) -> None:
    with pytest.raises(JsonTreeError):
        DisplayCommand.set_property(0, "value", value)


@pytest.mark.parametrize(
    "value",
    ["lone\ud800", {"value": "lone\ud800"}, {"lone\ud800": "key"}],
)
def test_property_and_event_payloads_require_unicode_scalar_strings(
    value: object,
) -> None:
    with pytest.raises(JsonTreeError, match="Unicode scalar"):
        DisplayCommand.set_property(0, "value", value)
    with pytest.raises(JsonTreeError, match="Unicode scalar"):
        DisplayCommand.emit_event(0, "event", {"value": value})


def test_property_value_depth_reserves_one_level_for_complete_state() -> None:
    pool = DisplayMatrixPool()
    node_id = pool.append(transform())
    checkpoint = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(node(node_id),),
    )
    checkpoint.confirm_published()

    command = DisplayCommand.set_property(
        node_id, "deep", nested_json_value(255)
    )
    stream, cursor = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(command,),
    )
    assert stream.maximum_json_depth == 256
    encode_display_command_stream_binary(stream, 1, cursor)

    with pytest.raises(JsonTreeError, match="maximum_depth"):
        DisplayCommand.set_property(node_id, "tooDeep", nested_json_value(256))


def test_property_and_event_commands_require_an_active_node() -> None:
    pool = DisplayMatrixPool()
    active_id = pool.append(transform())
    baseline = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=0,
        matrix_pool=pool,
        nodes=(node(active_id),),
    )
    baseline.confirm_published()
    pending_id = pool.append(transform())

    for command in (
        DisplayCommand.set_property(pending_id, "health", 1),
        DisplayCommand.unset_property(pending_id, "health"),
        DisplayCommand.emit_event(pending_id, "hit", {}),
    ):
        with pytest.raises(ConfigurationError, match="not active"):
            encode_display_command_stream(
                base_command_seq=0,
                source_tick=1,
                matrix_pool=pool,
                commands=(command,),
            )


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
        commands=(DisplayCommand.set_transform_batch((node_id,)),),
    )
    pool.set(node_id, transform(2.0))

    with pytest.raises(ConfigurationError, match="changed after"):
        stale.confirm_published()
    retry, _ = encode_display_command_stream(
        base_command_seq=0,
        source_tick=1,
        matrix_pool=pool,
        commands=(DisplayCommand.set_transform_batch((node_id,)),),
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
