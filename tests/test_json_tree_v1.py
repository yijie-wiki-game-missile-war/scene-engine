from __future__ import annotations

import math

import pytest

from scene_engine.errors import JsonTreeError
from scene_engine.json_tree import (
    DEFAULT_MAXIMUM_JSON_VALUES,
    apply_json_patch,
    validate_json_patch,
    validate_json_value,
)
from scene_engine.wire import MAXIMUM_SAFE_INTEGER


def patch(*changes):
    return {"schema": "scene-engine-json-tree@1", "changes": list(changes)}


def test_set_unset_append_apply_after_full_validation() -> None:
    root = {"array": [1], "object": {"drop": True, "keep": {"value": 1.5}}}
    result = apply_json_patch(
        root,
        patch(
            {"op": "append", "path": ["array"], "values": [2.5, -0.0]},
            {"op": "unset", "path": ["object", "drop"]},
            {"op": "set", "path": ["object", "keep", "value"], "value": 1e20},
        ),
    )
    assert result["array"][:2] == [1, 2.5]
    assert math.copysign(1.0, result["array"][2]) == -1.0
    assert result["object"] == {"keep": {"value": 1e20}}
    assert root == {"array": [1], "object": {"drop": True, "keep": {"value": 1.5}}}


@pytest.mark.parametrize(
    "bad",
    [
        patch(
            {"op": "set", "path": ["a"], "value": 1},
            {"op": "set", "path": ["a", "b"], "value": 2},
        ),
        patch({"op": "set", "path": ["__proto__"], "value": {}}),
        patch({"op": "append", "path": ["value"], "values": []}),
        patch({"op": "unset", "path": ["missing"]}),
    ],
)
def test_invalid_or_overlapping_patch_is_rejected_without_mutation(bad) -> None:
    root = {"a": {"b": 0}, "value": []}
    before = {"a": {"b": 0}, "value": []}
    with pytest.raises(JsonTreeError):
        apply_json_patch(root, bad)
    assert root == before


def test_canonical_path_order_is_utf8_strings_then_integer_segments() -> None:
    validate_json_patch(
        patch(
            {"op": "set", "path": ["a", "x"], "value": 1},
            {"op": "set", "path": ["a", 0], "value": 2},
        )
    )
    with pytest.raises(JsonTreeError):
        validate_json_patch(
            patch(
                {"op": "set", "path": ["a", 0], "value": 2},
                {"op": "set", "path": ["a", "x"], "value": 1},
            )
        )


def test_json_tree_rejects_nonfinite_and_unsafe_integer_values() -> None:
    for value in (math.nan, math.inf, -math.inf, MAXIMUM_SAFE_INTEGER + 1):
        with pytest.raises(JsonTreeError):
            validate_json_value({"value": value})


def test_default_snapshot_budget_covers_the_500_node_product_checkpoint() -> None:
    assert DEFAULT_MAXIMUM_JSON_VALUES == 4_000_000
    validate_json_value([None] * 1_000_001)
    with pytest.raises(JsonTreeError, match="maximum_values"):
        validate_json_value([None, None, None], maximum_values=3)


@pytest.mark.parametrize("key", ["__proto__", "prototype", "constructor"])
def test_json_tree_rejects_forbidden_keys_in_snapshot_and_set_values(key) -> None:
    with pytest.raises(JsonTreeError):
        validate_json_value({key: 1})
    with pytest.raises(JsonTreeError):
        validate_json_patch(patch({"op": "set", "path": ["safe"], "value": {key: 1}}))


def test_array_sibling_changes_use_simultaneous_original_indices() -> None:
    root = {"items": [0, 1, 2, 3]}
    removed = apply_json_patch(
        root,
        patch(
            {"op": "unset", "path": ["items", 0]},
            {"op": "unset", "path": ["items", 2]},
        ),
    )
    assert removed == {"items": [1, 3]}
    mixed = apply_json_patch(
        root,
        patch(
            {"op": "set", "path": ["items", 0], "value": 9},
            {"op": "unset", "path": ["items", 2]},
        ),
    )
    assert mixed == {"items": [9, 1, 3]}
