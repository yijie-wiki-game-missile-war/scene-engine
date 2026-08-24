"""Validation and reference application for ``scene-engine-json-tree@1``.

Production programs record changes while mutating their domain aggregate; this
module deliberately does not inspect arbitrary product objects or compute a
diff.  ``apply_json_patch`` is suitable for consumers and test oracles.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from copy import deepcopy
from functools import cmp_to_key
from typing import Any

from .errors import JsonTreeError
from .wire import MAXIMUM_SAFE_INTEGER, WORLD_TREE_SCHEMA


_FORBIDDEN_SEGMENTS = frozenset(("__proto__", "prototype", "constructor"))
_OPERATIONS = frozenset(("set", "unset", "append"))
DEFAULT_MAXIMUM_JSON_VALUES = 4_000_000


def validate_json_value(
    value: Any,
    *,
    maximum_depth: int = 256,
    maximum_values: int = DEFAULT_MAXIMUM_JSON_VALUES,
) -> Any:
    """Validate finite JSON numbers and return ``value``."""

    budget = [0]
    _validate_value(value, set(), 0, maximum_depth, maximum_values, budget)
    return value


def validate_json_patch(
    patch: Any,
    *,
    maximum_changes: int = 4096,
    maximum_path_segments: int = 32,
    maximum_json_depth: int = 256,
) -> dict[str, Any]:
    """Validate exact patch shape, canonical path order, and non-overlap."""

    if not _plain_mapping(patch) or set(patch) != {"schema", "changes"}:
        raise JsonTreeError("patch must have exact schema and changes fields")
    if patch["schema"] != WORLD_TREE_SCHEMA:
        raise JsonTreeError("patch schema is unsupported")
    changes = patch["changes"]
    if not isinstance(changes, list):
        raise JsonTreeError("patch changes must be an array")
    if len(changes) > maximum_changes:
        raise JsonTreeError("patch exceeds maximum_changes")

    normalized: list[dict[str, Any]] = []
    previous_key: tuple[Any, ...] | None = None
    paths: list[tuple[str | int, ...]] = []
    for raw in changes:
        if not _plain_mapping(raw):
            raise JsonTreeError("patch change must be a plain object")
        operation = raw.get("op")
        if operation not in _OPERATIONS:
            raise JsonTreeError("patch operation is unsupported")
        fields = {
            "set": {"op", "path", "value"},
            "unset": {"op", "path"},
            "append": {"op", "path", "values"},
        }[operation]
        if set(raw) != fields:
            raise JsonTreeError("patch change fields do not match its operation")
        path = _path(raw["path"], maximum_path_segments)
        key = _path_key(path)
        if previous_key is not None and key <= previous_key:
            raise JsonTreeError("patch changes are not in canonical path order")
        previous_key = key
        for prior in paths:
            if _is_prefix(prior, path) or _is_prefix(path, prior):
                raise JsonTreeError("patch paths overlap")
        paths.append(path)
        change: dict[str, Any] = {"op": operation, "path": list(path)}
        if operation == "set":
            validate_json_value(raw["value"], maximum_depth=maximum_json_depth)
            change["value"] = raw["value"]
        elif operation == "append":
            values = raw["values"]
            if not isinstance(values, list) or not values:
                raise JsonTreeError("append values must be a non-empty array")
            validate_json_value(values, maximum_depth=maximum_json_depth)
            change["values"] = values
        normalized.append(change)
    return {"schema": WORLD_TREE_SCHEMA, "changes": normalized}


def apply_json_patch(
    root: Any,
    patch: Any,
    *,
    maximum_changes: int = 4096,
    maximum_path_segments: int = 32,
    maximum_json_depth: int = 256,
) -> Any:
    """Validate all operations first, then apply them to an owned deep copy."""

    validate_json_value(root, maximum_depth=maximum_json_depth)
    normalized = validate_json_patch(
        patch,
        maximum_changes=maximum_changes,
        maximum_path_segments=maximum_path_segments,
        maximum_json_depth=maximum_json_depth,
    )
    prepared: list[tuple[dict[str, Any], Any]] = []
    for change in normalized["changes"]:
        parent, segment = _resolve_parent(root, change["path"])
        operation = change["op"]
        if operation == "unset" and not _contains(parent, segment):
            raise JsonTreeError("unset target does not exist")
        if operation == "append":
            target = _get(parent, segment)
            if not isinstance(target, list):
                raise JsonTreeError("append target is not an array")
        prepared.append((change, segment))

    candidate = deepcopy(root)
    ordered = sorted(
        (change for change, _ in prepared),
        key=cmp_to_key(lambda left, right: _application_path_order(left["path"], right["path"])),
    )
    for change in ordered:
        parent, segment = _resolve_parent(candidate, change["path"])
        if change["op"] == "set":
            _set(parent, segment, deepcopy(change["value"]))
        elif change["op"] == "unset":
            _unset(parent, segment)
        else:
            _get(parent, segment).extend(deepcopy(change["values"]))
    return candidate


def canonical_path_key(path: Sequence[str | int]) -> tuple[Any, ...]:
    """Return the public canonical comparator key used by both codecs."""

    return _path_key(_path(path, 32))


def _validate_value(
    value: Any,
    active: set[int],
    depth: int,
    maximum_depth: int,
    maximum_values: int,
    budget: list[int],
) -> None:
    budget[0] += 1
    if budget[0] > maximum_values:
        raise JsonTreeError("JSON value exceeds maximum_values")
    if depth > maximum_depth:
        raise JsonTreeError("JSON value exceeds maximum_depth")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAXIMUM_SAFE_INTEGER:
            raise JsonTreeError("JSON integer is outside the JavaScript safe range")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise JsonTreeError("JSON numbers must be finite")
        return
    if not isinstance(value, (Mapping, list)):
        raise JsonTreeError("value is not JSON")
    identity = id(value)
    if identity in active:
        raise JsonTreeError("JSON value contains a cycle")
    active.add(identity)
    try:
        if isinstance(value, Mapping):
            if not _plain_mapping(value):
                raise JsonTreeError("JSON objects must be plain mappings")
            for key, item in value.items():
                if not isinstance(key, str):
                    raise JsonTreeError("JSON object keys must be strings")
                if key in _FORBIDDEN_SEGMENTS:
                    raise JsonTreeError("JSON object key is forbidden")
                _validate_value(
                    item,
                    active,
                    depth + 1,
                    maximum_depth,
                    maximum_values,
                    budget,
                )
        else:
            for item in value:
                _validate_value(
                    item,
                    active,
                    depth + 1,
                    maximum_depth,
                    maximum_values,
                    budget,
                )
    finally:
        active.remove(identity)


def _path(value: Any, maximum: int) -> tuple[str | int, ...]:
    if not isinstance(value, (list, tuple)) or not value or len(value) > maximum:
        raise JsonTreeError("path must be a non-empty bounded array")
    result: list[str | int] = []
    for segment in value:
        if isinstance(segment, str):
            if not segment or segment in _FORBIDDEN_SEGMENTS:
                raise JsonTreeError("path contains a forbidden string segment")
            result.append(segment)
        elif (
            isinstance(segment, int)
            and not isinstance(segment, bool)
            and 0 <= segment <= MAXIMUM_SAFE_INTEGER
        ):
            result.append(segment)
        else:
            raise JsonTreeError("path segments must be strings or non-negative integers")
    return tuple(result)


def _path_key(path: Sequence[str | int]) -> tuple[Any, ...]:
    return tuple(
        (0, segment.encode("utf-8")) if isinstance(segment, str) else (1, segment)
        for segment in path
    )


def _application_path_order(
    left: Sequence[str | int], right: Sequence[str | int]
) -> int:
    """Order numeric siblings high-to-low so array edits are simultaneous."""

    for left_segment, right_segment in zip(left, right):
        if left_segment == right_segment:
            continue
        if isinstance(left_segment, str) and isinstance(right_segment, str):
            left_bytes = left_segment.encode("utf-8")
            right_bytes = right_segment.encode("utf-8")
            return -1 if left_bytes < right_bytes else 1
        if isinstance(left_segment, int) and isinstance(right_segment, int):
            return -1 if left_segment > right_segment else 1
        return -1 if isinstance(left_segment, str) else 1
    return len(left) - len(right)


def _is_prefix(left: Sequence[Any], right: Sequence[Any]) -> bool:
    return len(left) <= len(right) and tuple(left) == tuple(right[: len(left)])


def _resolve_parent(root: Any, path: Sequence[str | int]) -> tuple[Any, str | int]:
    cursor = root
    for segment in path[:-1]:
        cursor = _get(cursor, segment)
    return cursor, path[-1]


def _get(parent: Any, segment: str | int) -> Any:
    try:
        if isinstance(parent, Mapping) and isinstance(segment, str):
            return parent[segment]
        if isinstance(parent, list) and isinstance(segment, int):
            return parent[segment]
    except (KeyError, IndexError) as exc:
        raise JsonTreeError("patch path does not exist") from exc
    raise JsonTreeError("patch path segment does not match its container")


def _contains(parent: Any, segment: str | int) -> bool:
    if isinstance(parent, Mapping) and isinstance(segment, str):
        return segment in parent
    if isinstance(parent, list) and isinstance(segment, int):
        return 0 <= segment < len(parent)
    raise JsonTreeError("patch path segment does not match its container")


def _set(parent: Any, segment: str | int, value: Any) -> None:
    if isinstance(parent, dict) and isinstance(segment, str):
        parent[segment] = value
        return
    if isinstance(parent, list) and isinstance(segment, int) and 0 <= segment < len(parent):
        parent[segment] = value
        return
    raise JsonTreeError("set path does not match an existing container slot")


def _unset(parent: Any, segment: str | int) -> None:
    if isinstance(parent, dict) and isinstance(segment, str):
        del parent[segment]
        return
    if isinstance(parent, list) and isinstance(segment, int) and 0 <= segment < len(parent):
        del parent[segment]
        return
    raise JsonTreeError("unset path does not match an existing container slot")


def _plain_mapping(value: Any) -> bool:
    return isinstance(value, dict)


__all__ = [
    "apply_json_patch",
    "canonical_path_key",
    "validate_json_patch",
    "validate_json_value",
]
