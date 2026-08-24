from __future__ import annotations

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
)
from scene_engine.errors import ConfigurationError


HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64


def transform(x: float = 0.0) -> DisplayTransform:
    return DisplayTransform(
        position=(x, 2.0, 3.0),
        rotation_xyzw=(0.0, 0.0, 0.0, 2.0),
        scale=(1.0, 1.0, 1.0),
    )


def node(name: str, *, parent_name: str | None = None) -> DisplayNode:
    return DisplayNode(
        name=name,
        parent_name=parent_name,
        prefab_type="flight.aircraft",
        transform_mode="live",
        transform=transform(),
        visible=True,
        state={"animation": {"state": "idle", "start_tick": 0}},
    )


def test_checkpoint_is_parent_first_plain_data_and_carries_catalog_identity() -> None:
    result = encode_display_checkpoint(
        scene_name="main",
        catalog=DisplayCatalogIdentity(HASH_A, HASH_B, HASH_C),
        last_command_seq=41,
        nodes=(node("py/carrier-3"), node("py/aircraft-17", parent_name="py/carrier-3")),
    )

    assert result["schema"] == DISPLAY_CHECKPOINT_SCHEMA
    assert result["scene_name"] == "main"
    assert result["last_command_seq"] == 41
    assert [item["name"] for item in result["nodes"]] == [
        "py/carrier-3",
        "py/aircraft-17",
    ]
    assert result["nodes"][0]["transform"]["rotationXyzw"] == [0.0, 0.0, 0.0, 1.0]


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
        DisplayCommand.create(node("py/aircraft-17")),
        DisplayCommand.set_transform("py/aircraft-17", transform(9.0)),
        DisplayCommand.set_state("py/aircraft-17", {"animation": {"state": "move"}}),
        DisplayCommand.remove("py/aircraft-17"),
    )
    result, cursor = encode_display_command_stream(
        base_command_seq=7,
        source_tick=60,
        commands=commands,
    )

    assert result["schema"] == DISPLAY_COMMAND_STREAM_SCHEMA
    assert result["base_command_seq"] == 7
    assert result["last_command_seq"] == cursor == 11
    assert [item["command_seq"] for item in result["commands"]] == [8, 9, 10, 11]
    assert {item["source_tick"] for item in result["commands"]} == {60}
    assert all(item["schema"] == DISPLAY_COMMAND_SCHEMA for item in result["commands"])
    assert all(isinstance(item["name"], str) for item in result["commands"])
    assert not any("nodes" in item for item in result["commands"])


def test_empty_command_stream_keeps_cursor_but_still_forms_a_commit_seal() -> None:
    result, cursor = encode_display_command_stream(
        base_command_seq=12,
        source_tick=90,
        commands=(),
    )
    assert result == {
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

    with pytest.raises(TypeError, match="immutable"):
        result["last_command_seq"] = 0
    with pytest.raises(TypeError, match="immutable"):
        result["commands"].append({})
    with pytest.raises(TypeError, match="immutable"):
        result["commands"][0]["name"] = "py/b"
    with pytest.raises(TypeError, match="immutable"):
        result["commands"][0]["transform"]["position"].append(4.0)


def test_command_shapes_state_and_transform_are_closed_and_owned() -> None:
    state = {"selected": False, "parts": [1, 2]}
    command = DisplayCommand.set_state("py/aircraft-17", state)
    state["selected"] = True
    state["parts"].append(3)
    record = command.to_record(command_seq=1, source_tick=0)
    assert record["state"] == {"selected": False, "parts": [1, 2]}

    with pytest.raises(ConfigurationError, match="fields"):
        DisplayCommand(kind="node-remove", name="py/a", visible=True)
    with pytest.raises(ConfigurationError, match="scale"):
        DisplayTransform(
            position=(0, 0, 0),
            rotation_xyzw=(0, 0, 0, 1),
            scale=(-1, 1, 1),
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
