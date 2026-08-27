"""Display Node/Component publication records for the breaking 0.7 contract.

The product publishes a complete checkpoint baseline and, after that, only
single-target logical commands.  Engine owns the command sequence and source
tick fields that are added at wire-encoding time.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from .errors import ConfigurationError
from .json_tree import validate_json_value


DISPLAY_CODEC = "scene-engine-display-node@3"
DISPLAY_CHECKPOINT_SCHEMA = "scene-engine-display-checkpoint@3"
DISPLAY_COMMAND_STREAM_SCHEMA = "scene-engine-display-command-stream@3"
DISPLAY_COMMAND_SCHEMA = "scene-engine-node-command@3"

MAXIMUM_NODE_NAME_BYTES = 192
MAXIMUM_PREFAB_ID_BYTES = 192
MAXIMUM_SCENE_NAME_BYTES = 96
MAXIMUM_NODE_DEPTH = 128

_NODE_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_PREFAB_ID = re.compile(r"^[a-z0-9][a-z0-9._@-]*(?:/[a-z0-9][a-z0-9._@-]*)*$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_COMMAND_KINDS = frozenset(
    {
        "node-create",
        "node-set-transform",
        "node-set-parent",
        "node-set-visible",
        "node-set-state",
        "node-replace-prefab",
        "node-remove",
    }
)


class _ImmutableDict(dict[str, Any]):
    """JSON-compatible mapping that cannot be changed after construction."""

    @staticmethod
    def _immutable(*_args: Any, **_kwargs: Any) -> None:
        raise TypeError("validated display command streams are immutable")

    __setitem__ = _immutable
    __delitem__ = _immutable
    __ior__ = _immutable
    clear = _immutable
    pop = _immutable
    popitem = _immutable
    setdefault = _immutable
    update = _immutable


class _ImmutableList(list[Any]):
    """JSON-compatible sequence that cannot be changed after construction."""

    @staticmethod
    def _immutable(*_args: Any, **_kwargs: Any) -> None:
        raise TypeError("validated display command streams are immutable")

    __setitem__ = _immutable
    __delitem__ = _immutable
    __iadd__ = _immutable
    __imul__ = _immutable
    append = _immutable
    clear = _immutable
    extend = _immutable
    insert = _immutable
    pop = _immutable
    remove = _immutable
    reverse = _immutable
    sort = _immutable


class _ValidatedDisplayCommandStream(_ImmutableDict):
    """Private seal proving a command stream was built from validated records."""

    def __init__(
        self, value: Mapping[str, Any], *, source_tick: int, maximum_json_depth: int
    ) -> None:
        dict.__init__(self, value)
        object.__setattr__(self, "source_tick", source_tick)
        object.__setattr__(self, "maximum_json_depth", maximum_json_depth)

    def __setattr__(self, _name: str, _value: Any) -> None:
        raise TypeError("validated display command streams are immutable")


@dataclass(frozen=True, slots=True)
class DisplayCatalogIdentity:
    """Exact Arts catalog identities required by one display session."""

    scene_catalog_hash: str
    prefab_catalog_hash: str
    state_schema_hash: str

    def __post_init__(self) -> None:
        for field in self.__dataclass_fields__:
            value = getattr(self, field)
            if not isinstance(value, str) or _HASH.fullmatch(value) is None:
                raise ConfigurationError(f"{field} must be a lowercase SHA-256")

    def to_record(self) -> dict[str, str]:
        return {
            "scene_catalog_hash": self.scene_catalog_hash,
            "prefab_catalog_hash": self.prefab_catalog_hash,
            "state_schema_hash": self.state_schema_hash,
        }


@dataclass(frozen=True, slots=True, init=False)
class DisplayTransform:
    """The sole local TRS stored by one display Node."""

    position: tuple[float, float, float]
    rotation_xyzw: tuple[float, float, float, float]
    scale: tuple[float, float, float]

    def __init__(
        self,
        *,
        position: Sequence[float],
        rotation_xyzw: Sequence[float],
        scale: Sequence[float],
    ) -> None:
        normalized_position = _finite_vector(position, 3, "position")
        normalized_rotation = _finite_vector(rotation_xyzw, 4, "rotation_xyzw")
        magnitude = math.sqrt(sum(value * value for value in normalized_rotation))
        if magnitude == 0:
            raise ConfigurationError("rotation_xyzw must not be the zero quaternion")
        normalized_scale = _finite_vector(scale, 3, "scale")
        if any(value <= 0 for value in normalized_scale):
            raise ConfigurationError("scale components must be greater than zero")
        object.__setattr__(self, "position", normalized_position)
        object.__setattr__(
            self,
            "rotation_xyzw",
            tuple(value / magnitude for value in normalized_rotation),
        )
        object.__setattr__(self, "scale", normalized_scale)

    @classmethod
    def identity(cls) -> "DisplayTransform":
        return cls(
            position=(0.0, 0.0, 0.0),
            rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
            scale=(1.0, 1.0, 1.0),
        )

    @classmethod
    def from_record(cls, value: Any) -> "DisplayTransform":
        if not isinstance(value, Mapping) or set(value) != {
            "position",
            "rotationXyzw",
            "scale",
        }:
            raise ConfigurationError("transform fields are invalid")
        return cls(
            position=value["position"],
            rotation_xyzw=value["rotationXyzw"],
            scale=value["scale"],
        )

    def to_record(self) -> dict[str, list[float]]:
        return {
            "position": list(self.position),
            "rotationXyzw": list(self.rotation_xyzw),
            "scale": list(self.scale),
        }


@dataclass(frozen=True, slots=True, init=False)
class DisplayNode:
    """One Python-owned authority root in a checkpoint baseline."""

    name: str
    parent_name: str | None
    prefab_id: str
    transform_mode: str
    transform: DisplayTransform
    visible: bool
    state: Mapping[str, Any]

    def __init__(
        self,
        *,
        name: str,
        parent_name: str | None,
        prefab_id: str,
        transform_mode: str,
        transform: DisplayTransform | Mapping[str, Any],
        visible: bool,
        state: Mapping[str, Any],
    ) -> None:
        _authority_name(name, "name")
        if parent_name is not None:
            _authority_name(parent_name, "parent_name")
            if parent_name == name:
                raise ConfigurationError("authority Node cannot parent itself")
        _prefab_id(prefab_id)
        if transform_mode not in {"initial", "live"}:
            raise ConfigurationError("transform_mode must be initial or live")
        normalized_transform = (
            transform
            if isinstance(transform, DisplayTransform)
            else DisplayTransform.from_record(transform)
        )
        if not isinstance(visible, bool):
            raise ConfigurationError("visible must be boolean")
        normalized_state = _plain_state(state)
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "parent_name", parent_name)
        object.__setattr__(self, "prefab_id", prefab_id)
        object.__setattr__(self, "transform_mode", transform_mode)
        object.__setattr__(self, "transform", normalized_transform)
        object.__setattr__(self, "visible", visible)
        object.__setattr__(self, "state", normalized_state)

    def to_record(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "parent_name": self.parent_name,
            "prefab_id": self.prefab_id,
            "transform_mode": self.transform_mode,
            "transform": self.transform.to_record(),
            "visible": self.visible,
            "state": _thaw(self.state),
        }


@dataclass(frozen=True, slots=True, init=False)
class DisplayCommand:
    """One independently validated logical mutation with exactly one target."""

    kind: str
    name: str
    fields: Mapping[str, Any]

    def __init__(self, *, kind: str, name: str, **fields: Any) -> None:
        if kind not in _COMMAND_KINDS:
            raise ConfigurationError("display command kind is invalid")
        _authority_name(name, "name")
        normalized = _normalize_command_fields(kind, name, fields)
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "name", name)
        object.__setattr__(self, "fields", _freeze(normalized))

    @classmethod
    def create(cls, node: DisplayNode) -> "DisplayCommand":
        if not isinstance(node, DisplayNode):
            raise ConfigurationError("node-create requires DisplayNode")
        record = node.to_record()
        name = record.pop("name")
        return cls(kind="node-create", name=name, **record)

    @classmethod
    def set_transform(
        cls, name: str, transform: DisplayTransform | Mapping[str, Any]
    ) -> "DisplayCommand":
        return cls(kind="node-set-transform", name=name, transform=transform)

    @classmethod
    def set_parent(cls, name: str, parent_name: str | None) -> "DisplayCommand":
        return cls(kind="node-set-parent", name=name, parent_name=parent_name)

    @classmethod
    def set_visible(cls, name: str, visible: bool) -> "DisplayCommand":
        return cls(kind="node-set-visible", name=name, visible=visible)

    @classmethod
    def set_state(cls, name: str, state: Mapping[str, Any]) -> "DisplayCommand":
        return cls(kind="node-set-state", name=name, state=state)

    @classmethod
    def replace_prefab(
        cls, name: str, prefab_id: str, state: Mapping[str, Any]
    ) -> "DisplayCommand":
        return cls(
            kind="node-replace-prefab",
            name=name,
            prefab_id=prefab_id,
            state=state,
        )

    @classmethod
    def remove(cls, name: str) -> "DisplayCommand":
        return cls(kind="node-remove", name=name)

    def to_record(self, *, command_seq: int, source_tick: int) -> dict[str, Any]:
        _safe_integer(command_seq, "command_seq")
        _safe_integer(source_tick, "source_tick")
        return {
            "schema": DISPLAY_COMMAND_SCHEMA,
            "command_seq": command_seq,
            "source_tick": source_tick,
            "kind": self.kind,
            "name": self.name,
            **_thaw(self.fields),
        }


def encode_display_checkpoint(
    *,
    scene_name: str,
    catalog: DisplayCatalogIdentity,
    last_command_seq: int,
    nodes: Sequence[DisplayNode],
) -> dict[str, Any]:
    """Build the JSON attachment used to construct a fresh DisplayRuntime."""

    _scene_name(scene_name)
    if not isinstance(catalog, DisplayCatalogIdentity):
        raise ConfigurationError("catalog must be DisplayCatalogIdentity")
    _safe_integer(last_command_seq, "last_command_seq")
    normalized_nodes = _ordered_baseline(nodes)
    return {
        "schema": DISPLAY_CHECKPOINT_SCHEMA,
        "scene_name": scene_name,
        **catalog.to_record(),
        "last_command_seq": last_command_seq,
        "nodes": [node.to_record() for node in normalized_nodes],
    }


def validate_display_nodes(nodes: Sequence[DisplayNode]) -> tuple[DisplayNode, ...]:
    """Validate and own a parent-before-child authority checkpoint baseline."""

    return _ordered_baseline(nodes)


def encode_display_command_stream(
    *,
    base_command_seq: int,
    source_tick: int,
    commands: Sequence[DisplayCommand],
) -> tuple[dict[str, Any], int]:
    """Assign strict stream-global sequence numbers to logical commands."""

    _safe_integer(base_command_seq, "base_command_seq")
    _safe_integer(source_tick, "source_tick")
    normalized = _logical_commands(commands)
    records: list[_ImmutableDict] = []
    maximum_record_depth = -1
    cursor = base_command_seq
    for command in normalized:
        cursor += 1
        record, record_depth = _sealed_command_record(
            command,
            command_seq=cursor,
            source_tick=source_tick,
        )
        records.append(record)
        maximum_record_depth = max(maximum_record_depth, record_depth)
    maximum_json_depth = max(
        1,
        maximum_record_depth + 2 if records else 1,
    )
    return (
        _ValidatedDisplayCommandStream(
            {
                "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
                "base_command_seq": base_command_seq,
                "last_command_seq": cursor,
                "commands": _ImmutableList(records),
            },
            source_tick=source_tick,
            maximum_json_depth=maximum_json_depth,
        ),
        cursor,
    )


def validate_display_checkpoint(
    value: Any, *, expected_last_command_seq: int | None = None
) -> tuple[DisplayNode, ...]:
    """Validate one decoded checkpoint attachment and return its Node baseline."""

    fields = {
        "schema",
        "scene_name",
        "scene_catalog_hash",
        "prefab_catalog_hash",
        "state_schema_hash",
        "last_command_seq",
        "nodes",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise ConfigurationError("display checkpoint fields are invalid")
    if value["schema"] != DISPLAY_CHECKPOINT_SCHEMA:
        raise ConfigurationError("display checkpoint schema is invalid")
    _scene_name(value["scene_name"])
    DisplayCatalogIdentity(
        scene_catalog_hash=value["scene_catalog_hash"],
        prefab_catalog_hash=value["prefab_catalog_hash"],
        state_schema_hash=value["state_schema_hash"],
    )
    cursor = _safe_integer(value["last_command_seq"], "last_command_seq")
    if expected_last_command_seq is not None and cursor != expected_last_command_seq:
        raise ConfigurationError("display checkpoint command cursor is invalid")
    nodes_value = value["nodes"]
    if not isinstance(nodes_value, list):
        raise ConfigurationError("display checkpoint nodes must be an array")
    nodes: list[DisplayNode] = []
    node_fields = {
        "name",
        "parent_name",
        "prefab_id",
        "transform_mode",
        "transform",
        "visible",
        "state",
    }
    for record in nodes_value:
        if not isinstance(record, dict) or set(record) != node_fields:
            raise ConfigurationError("display checkpoint Node fields are invalid")
        nodes.append(DisplayNode(**record))
    return _ordered_baseline(nodes)


def validate_display_command_stream(
    value: Any,
    *,
    expected_source_tick: int,
    expected_last_command_seq: int,
) -> tuple[DisplayCommand, ...]:
    """Validate a decoded stream envelope, record sequence, and every command."""

    fields = {"schema", "base_command_seq", "last_command_seq", "commands"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ConfigurationError("display command stream fields are invalid")
    if value["schema"] != DISPLAY_COMMAND_STREAM_SCHEMA:
        raise ConfigurationError("display command stream schema is invalid")
    base = _safe_integer(value["base_command_seq"], "base_command_seq")
    last = _safe_integer(value["last_command_seq"], "last_command_seq")
    _safe_integer(expected_source_tick, "expected_source_tick")
    _safe_integer(expected_last_command_seq, "expected_last_command_seq")
    if last != expected_last_command_seq or last < base:
        raise ConfigurationError("display command stream cursor is invalid")
    records = value["commands"]
    if not isinstance(records, list) or len(records) != last - base:
        raise ConfigurationError("display command stream length is invalid")
    commands: list[DisplayCommand] = []
    cursor = base
    for record in records:
        command = _command_from_record(record)
        cursor += 1
        if record["command_seq"] != cursor:
            raise ConfigurationError("display command sequence is invalid")
        if record["source_tick"] != expected_source_tick:
            raise ConfigurationError("display command source_tick is invalid")
        commands.append(command)
    return tuple(commands)


def _command_from_record(value: Any) -> DisplayCommand:
    common = {"schema", "command_seq", "source_tick", "kind", "name"}
    if not isinstance(value, dict) or not common.issubset(value):
        raise ConfigurationError("display command record fields are invalid")
    if value["schema"] != DISPLAY_COMMAND_SCHEMA:
        raise ConfigurationError("display command schema is invalid")
    _safe_integer(value["command_seq"], "command_seq")
    _safe_integer(value["source_tick"], "source_tick")
    kind = value["kind"]
    expected_by_kind = {
        "node-create": {
            "parent_name",
            "prefab_id",
            "transform_mode",
            "transform",
            "visible",
            "state",
        },
        "node-set-transform": {"transform"},
        "node-set-parent": {"parent_name"},
        "node-set-visible": {"visible"},
        "node-set-state": {"state"},
        "node-replace-prefab": {"prefab_id", "state"},
        "node-remove": set(),
    }
    if kind not in expected_by_kind or set(value) != common | expected_by_kind[kind]:
        raise ConfigurationError("display command record fields are invalid")
    return DisplayCommand(
        kind=kind,
        name=value["name"],
        **{field: value[field] for field in expected_by_kind[kind]},
    )


def _ordered_baseline(nodes: Sequence[DisplayNode]) -> tuple[DisplayNode, ...]:
    if not isinstance(nodes, (tuple, list)):
        raise ConfigurationError("display checkpoint nodes must be a sequence")
    result = tuple(nodes)
    by_name: dict[str, DisplayNode] = {}
    for node in result:
        if not isinstance(node, DisplayNode):
            raise ConfigurationError("display checkpoint contains a non-DisplayNode")
        if node.name in by_name:
            raise ConfigurationError("display checkpoint contains duplicate names")
        if node.parent_name is not None and node.parent_name not in by_name:
            raise ConfigurationError("display checkpoint must be parent-before-child")
        by_name[node.name] = node
    depths: dict[str, int] = {}
    for node in result:
        depth = 1 if node.parent_name is None else depths[node.parent_name] + 1
        if depth > MAXIMUM_NODE_DEPTH:
            raise ConfigurationError("display checkpoint exceeds maximum Node depth")
        depths[node.name] = depth
    return result


def _logical_commands(commands: Sequence[DisplayCommand]) -> tuple[DisplayCommand, ...]:
    if not isinstance(commands, (tuple, list)):
        raise ConfigurationError("display commands must be a sequence")
    result = tuple(commands)
    if any(not isinstance(command, DisplayCommand) for command in result):
        raise ConfigurationError("display commands contain an invalid record")
    return result


def _normalize_command_fields(
    kind: str, name: str, fields: Mapping[str, Any]
) -> dict[str, Any]:
    actual = set(fields)
    if kind == "node-create":
        required = {
            "parent_name",
            "prefab_id",
            "transform_mode",
            "transform",
            "visible",
            "state",
        }
        if actual != required:
            raise ConfigurationError("node-create fields are invalid")
        node = DisplayNode(name=name, **fields)
        record = node.to_record()
        record.pop("name")
        return record
    if kind == "node-set-transform":
        if actual != {"transform"}:
            raise ConfigurationError("node-set-transform fields are invalid")
        value = fields["transform"]
        transform = value if isinstance(value, DisplayTransform) else DisplayTransform.from_record(value)
        return {"transform": transform.to_record()}
    if kind == "node-set-parent":
        if actual != {"parent_name"}:
            raise ConfigurationError("node-set-parent fields are invalid")
        parent_name = fields["parent_name"]
        if parent_name is not None:
            _authority_name(parent_name, "parent_name")
            if parent_name == name:
                raise ConfigurationError("authority Node cannot parent itself")
        return {"parent_name": parent_name}
    if kind == "node-set-visible":
        if actual != {"visible"} or not isinstance(fields["visible"], bool):
            raise ConfigurationError("node-set-visible fields are invalid")
        return {"visible": fields["visible"]}
    if kind == "node-set-state":
        if actual != {"state"}:
            raise ConfigurationError("node-set-state fields are invalid")
        return {"state": _plain_state(fields["state"])}
    if kind == "node-replace-prefab":
        if actual != {"prefab_id", "state"}:
            raise ConfigurationError("node-replace-prefab fields are invalid")
        _prefab_id(fields["prefab_id"])
        return {
            "prefab_id": fields["prefab_id"],
            "state": _plain_state(fields["state"]),
        }
    if actual:
        raise ConfigurationError("node-remove fields are invalid")
    return {}


def _authority_name(value: Any, field: str) -> str:
    name = _node_name(value, field)
    if not name.startswith("py/"):
        raise ConfigurationError(f"{field} must use the py/ authority prefix")
    return name


def _node_name(value: Any, field: str) -> str:
    if not isinstance(value, str) or len(value.encode("utf-8")) > MAXIMUM_NODE_NAME_BYTES:
        raise ConfigurationError(f"{field} is not a valid Node name")
    segments = value.split("/")
    if len(segments) < 2 or segments[0] not in {
        "sys",
        "scene",
        "py",
        "prefab",
        "editor",
    }:
        raise ConfigurationError(f"{field} has an invalid Node prefix")
    if any(_NODE_SEGMENT.fullmatch(segment) is None for segment in segments):
        raise ConfigurationError(f"{field} has an invalid Node segment")
    return value


def _prefab_id(value: Any) -> str:
    if (
        not isinstance(value, str)
        or len(value.encode("utf-8")) > MAXIMUM_PREFAB_ID_BYTES
        or _PREFAB_ID.fullmatch(value) is None
    ):
        raise ConfigurationError("prefab_id is invalid")
    return value


def _scene_name(value: Any) -> str:
    if (
        not isinstance(value, str)
        or len(value.encode("utf-8")) > MAXIMUM_SCENE_NAME_BYTES
        or _NODE_SEGMENT.fullmatch(value) is None
    ):
        raise ConfigurationError("scene_name is invalid")
    return value


def _plain_state(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ConfigurationError("authority state must be a plain JSON object")
    owned = _thaw(value)
    validate_json_value(owned)
    return _freeze(owned)


def _finite_vector(value: Any, length: int, field: str) -> tuple[float, ...]:
    if not isinstance(value, (tuple, list)) or len(value) != length:
        raise ConfigurationError(f"{field} must have {length} components")
    result: list[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise ConfigurationError(f"{field} components must be finite numbers")
        number = float(item)
        if not math.isfinite(number):
            raise ConfigurationError(f"{field} components must be finite numbers")
        result.append(number)
    return tuple(result)


def _safe_integer(value: Any, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > (1 << 53) - 1
    ):
        raise ConfigurationError(f"{field} must be a non-negative safe integer")
    return value


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, tuple):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


def _sealed_command_record(
    command: DisplayCommand, *, command_seq: int, source_tick: int
) -> tuple[_ImmutableDict, int]:
    frozen_fields, fields_depth = _seal_json(command.fields)
    if not isinstance(frozen_fields, _ImmutableDict):  # pragma: no cover - invariant.
        raise AssertionError("display command fields must form an object")
    return (
        _ImmutableDict(
            {
                "schema": DISPLAY_COMMAND_SCHEMA,
                "command_seq": command_seq,
                "source_tick": source_tick,
                "kind": command.kind,
                "name": command.name,
                **frozen_fields,
            }
        ),
        max(1, fields_depth),
    )


def _seal_json(value: Any) -> tuple[Any, int]:
    """Own an already validated JSON value and retain its maximum wire depth."""

    if value is None or isinstance(value, (str, bool, int, float)):
        return value, 0
    if isinstance(value, Mapping):
        items: dict[str, Any] = {}
        maximum_child_depth = -1
        for key, item in value.items():
            sealed, child_depth = _seal_json(item)
            items[key] = sealed
            maximum_child_depth = max(maximum_child_depth, child_depth)
        return _ImmutableDict(items), maximum_child_depth + 1
    if isinstance(value, (list, tuple)):
        items = []
        maximum_child_depth = -1
        for item in value:
            sealed, child_depth = _seal_json(item)
            items.append(sealed)
            maximum_child_depth = max(maximum_child_depth, child_depth)
        return _ImmutableList(items), maximum_child_depth + 1
    raise AssertionError("validated display command contains a non-JSON value")


__all__ = [
    "DISPLAY_CHECKPOINT_SCHEMA",
    "DISPLAY_CODEC",
    "DISPLAY_COMMAND_SCHEMA",
    "DISPLAY_COMMAND_STREAM_SCHEMA",
    "DisplayCatalogIdentity",
    "DisplayCommand",
    "DisplayNode",
    "DisplayTransform",
    "MAXIMUM_NODE_DEPTH",
    "MAXIMUM_NODE_NAME_BYTES",
    "encode_display_checkpoint",
    "encode_display_command_stream",
    "validate_display_checkpoint",
    "validate_display_command_stream",
    "validate_display_nodes",
]
