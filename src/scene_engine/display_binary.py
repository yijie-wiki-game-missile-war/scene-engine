"""Binary Display checkpoint and command-stream matrix codec."""

from __future__ import annotations

import json
import math
import re
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, NoReturn

import numpy as np

from .display import (
    DISPLAY_CHECKPOINT_SCHEMA,
    DISPLAY_COMMAND_SCHEMA,
    DISPLAY_COMMAND_STREAM_SCHEMA,
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    ValidatedDisplayCheckpoint,
    ValidatedDisplayCommandStream,
)
from .errors import ConfigurationError, JsonTreeError, WireError
from .json_tree import MAXIMUM_SAFE_INTEGER, validate_json_value


DISPLAY_BINARY_CHECKPOINT_MAGIC = b"SDCP"
DISPLAY_BINARY_COMMAND_STREAM_MAGIC = b"SDCS"
DISPLAY_BINARY_VERSION = 2
DISPLAY_BINARY_SCALAR_FLOAT32 = 1

DISPLAY_CHECKPOINT_KIND = "display_checkpoint"
DISPLAY_COMMAND_STREAM_KIND = "display_command_stream"

_COMMON_HEADER = struct.Struct("<4sBBH")
_U8 = struct.Struct("<B")
_U16 = struct.Struct("<H")
_U32 = struct.Struct("<I")
_U64 = struct.Struct("<Q")
_MATRIX4_F32 = struct.Struct("<16f")

_NULL_PARENT_INDEX = 0xFFFFFFFF
_NULL_STRING_LENGTH = 0xFFFF
_MAXIMUM_U16_STRING_BYTES = _NULL_STRING_LENGTH - 1
_MAXIMUM_U32 = 0xFFFFFFFF

_NODE_FLAG_VISIBLE = 1 << 0
_NODE_FLAG_LIVE = 1 << 1
_NODE_FLAGS = _NODE_FLAG_VISIBLE | _NODE_FLAG_LIVE

_OPCODE_BY_KIND = {
    "node-create": 1,
    "node-set-transform": 2,
    "node-set-parent": 3,
    "node-set-visible": 4,
    "node-set-state": 5,
    "node-replace-prefab": 6,
    "node-remove": 7,
}
_KIND_BY_OPCODE = {value: key for key, value in _OPCODE_BY_KIND.items()}

_AUTHORITY_NAME = re.compile(
    r"^py/[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*$"
)
_SCENE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_PREFAB_ID = re.compile(
    r"^[a-z0-9][a-z0-9._@-]*(?:/[a-z0-9][a-z0-9._@-]*)*$"
)

_MAXIMUM_NODE_NAME_BYTES = 192
_MAXIMUM_PREFAB_ID_BYTES = 192
_MAXIMUM_SCENE_NAME_BYTES = 96

@dataclass(frozen=True, slots=True)
class EncodedDisplayPayload:
    """One validated raw Display attachment ready for the Wire container."""

    bytes: bytes
    kind: str
    last_command_seq: int
    source_tick: int | None
    base_command_seq: int | None
    maximum_json_depth: int

    def __post_init__(self) -> None:
        if not isinstance(self.bytes, bytes):
            raise TypeError("encoded Display payload bytes must be bytes")
        if self.kind not in {DISPLAY_CHECKPOINT_KIND, DISPLAY_COMMAND_STREAM_KIND}:
            raise TypeError("encoded Display payload kind is invalid")
        _safe_integer(self.last_command_seq, "last_command_seq", ConfigurationError)
        _validate_depth(self.maximum_json_depth, ConfigurationError)
        if self.kind == DISPLAY_CHECKPOINT_KIND:
            if self.source_tick is not None or self.base_command_seq is not None:
                raise TypeError("checkpoint payload cannot carry command metadata")
        else:
            _safe_integer(self.source_tick, "source_tick", ConfigurationError)
            _safe_integer(
                self.base_command_seq, "base_command_seq", ConfigurationError
            )

    def __bytes__(self) -> bytes:
        return self.bytes


@dataclass(frozen=True, slots=True)
class _EncodedCheckpointNode:
    name: str
    parent_name: str | None
    prefab_id: str
    flags: int
    matrix: np.ndarray
    state: bytes


def encode_display_checkpoint_binary(
    value: Any,
    expected_last_command_seq: int,
    *,
    maximum_json_depth: int = 256,
) -> EncodedDisplayPayload:
    """Validate and encode one semantic Display checkpoint as ``SDCP`` bytes."""

    _validate_depth(maximum_json_depth, ConfigurationError)
    last_command_seq = _safe_integer(
        expected_last_command_seq, "expected_last_command_seq", ConfigurationError
    )
    scene_name, catalog, nodes = _checkpoint_semantics(
        value,
        expected_last_command_seq=last_command_seq,
        maximum_json_depth=maximum_json_depth,
    )

    chunks: list[bytes | np.ndarray] = [
        _COMMON_HEADER.pack(
            DISPLAY_BINARY_CHECKPOINT_MAGIC,
            DISPLAY_BINARY_VERSION,
            DISPLAY_BINARY_SCALAR_FLOAT32,
            0,
        ),
        _U64.pack(last_command_seq),
        _encode_string(
            scene_name,
            "scene_name",
            maximum_bytes=_MAXIMUM_SCENE_NAME_BYTES,
        ),
        bytes.fromhex(catalog.scene_catalog_hash),
        bytes.fromhex(catalog.prefab_catalog_hash),
        bytes.fromhex(catalog.state_schema_hash),
    ]
    if len(nodes) > _MAXIMUM_U32:
        raise ConfigurationError("display checkpoint Node count exceeds uint32")
    chunks.append(_U32.pack(len(nodes)))

    indices: dict[str, int] = {}
    for index, node in enumerate(nodes):
        chunks.append(
            _encode_string(
                node.name,
                "name",
                maximum_bytes=_MAXIMUM_NODE_NAME_BYTES,
            )
        )
        parent_index = (
            _NULL_PARENT_INDEX
            if node.parent_name is None
            else indices[node.parent_name]
        )
        chunks.append(_U32.pack(parent_index))
        chunks.append(
            _encode_string(
                node.prefab_id,
                "prefab_id",
                maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES,
            )
        )
        chunks.append(_U8.pack(node.flags))
        chunks.append(node.matrix)
        chunks.append(node.state)
        indices[node.name] = index

    return EncodedDisplayPayload(
        bytes=b"".join(chunks),
        kind=DISPLAY_CHECKPOINT_KIND,
        last_command_seq=last_command_seq,
        source_tick=None,
        base_command_seq=None,
        maximum_json_depth=maximum_json_depth,
    )


def decode_display_checkpoint_binary(
    data: Any,
    expected_last_command_seq: int,
    *,
    maximum_json_depth: int = 256,
) -> dict[str, Any]:
    """Decode one structurally valid ``SDCP`` while retaining opaque matrix bits."""

    _validate_depth(maximum_json_depth, WireError)
    last_command_seq = _safe_integer(
        expected_last_command_seq, "expected_last_command_seq", WireError
    )
    reader = _Reader(data, "Display checkpoint")
    reader.header(DISPLAY_BINARY_CHECKPOINT_MAGIC)
    encoded_last_command_seq = reader.u64("last command sequence")
    _safe_integer(encoded_last_command_seq, "last_command_seq", WireError)
    if encoded_last_command_seq != last_command_seq:
        reader.fail("command cursor does not match the packet header")
    scene_name = reader.string(
        "scene_name", maximum_bytes=_MAXIMUM_SCENE_NAME_BYTES
    )
    _validate_scene_name(scene_name, WireError)
    catalog = DisplayCatalogIdentity(
        scene_catalog_hash=reader.take(32, "scene catalog hash").hex(),
        prefab_catalog_hash=reader.take(32, "prefab catalog hash").hex(),
        state_schema_hash=reader.take(32, "state schema hash").hex(),
    )
    node_count = reader.u32("node count")
    minimum_node_bytes = 2 + 4 + 2 + 1 + _MATRIX4_F32.size + 4
    if node_count > reader.remaining // minimum_node_bytes:
        reader.fail("Node count exceeds the remaining payload")

    nodes: list[DisplayNode] = []
    seen_names: set[str] = set()
    depths: list[int] = []
    for index in range(node_count):
        name = reader.string("name", maximum_bytes=_MAXIMUM_NODE_NAME_BYTES)
        if name in seen_names:
            reader.fail("Node name is duplicated")
        parent_index = reader.u32("parent index")
        if parent_index == _NULL_PARENT_INDEX:
            parent_name = None
            depth = 1
        elif parent_index >= index:
            reader.fail("parent index must refer to an earlier Node")
        else:
            parent_name = nodes[parent_index].name
            depth = depths[parent_index] + 1
        if depth > 128:
            reader.fail("Node depth exceeds 128")
        prefab_id = reader.string(
            "prefab_id", maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES
        )
        flags = reader.u8("Node flags")
        if flags & ~_NODE_FLAGS:
            reader.fail("Node flags contain reserved bits")
        visible = bool(flags & _NODE_FLAG_VISIBLE)
        transform_mode = "live" if flags & _NODE_FLAG_LIVE else "initial"
        transform = reader.matrix_transform()
        state = reader.state(maximum_json_depth=maximum_json_depth)
        try:
            nodes.append(
                DisplayNode(
                    name=name,
                    parent_name=parent_name,
                    prefab_id=prefab_id,
                    transform_mode=transform_mode,
                    transform=transform,
                    visible=visible,
                    state=state,
                )
            )
        except ConfigurationError as exc:
            raise WireError("Display checkpoint Node is invalid") from exc
        seen_names.add(name)
        depths.append(depth)
    reader.finish()

    return {
        "schema": DISPLAY_CHECKPOINT_SCHEMA,
        "scene_name": scene_name,
        "scene_catalog_hash": catalog.scene_catalog_hash,
        "prefab_catalog_hash": catalog.prefab_catalog_hash,
        "state_schema_hash": catalog.state_schema_hash,
        "last_command_seq": last_command_seq,
        "nodes": [node.to_record() for node in nodes],
    }


def encode_display_command_stream_binary(
    value: Any,
    expected_source_tick: int,
    expected_last_command_seq: int,
    *,
    maximum_json_depth: int = 256,
) -> EncodedDisplayPayload:
    """Validate and encode one semantic Display command stream as ``SDCS``."""

    _validate_depth(maximum_json_depth, ConfigurationError)
    source_tick = _safe_integer(
        expected_source_tick, "expected_source_tick", ConfigurationError
    )
    last_command_seq = _safe_integer(
        expected_last_command_seq,
        "expected_last_command_seq",
        ConfigurationError,
    )
    base_command_seq, commands = _command_stream_semantics(
        value,
        expected_source_tick=source_tick,
        expected_last_command_seq=last_command_seq,
        maximum_json_depth=maximum_json_depth,
    )
    if len(commands) > _MAXIMUM_U32:
        raise ConfigurationError("display command count exceeds uint32")

    chunks: list[bytes | np.ndarray] = [
        _COMMON_HEADER.pack(
            DISPLAY_BINARY_COMMAND_STREAM_MAGIC,
            DISPLAY_BINARY_VERSION,
            DISPLAY_BINARY_SCALAR_FLOAT32,
            0,
        ),
        _U64.pack(base_command_seq),
        _U64.pack(source_tick),
        _U32.pack(len(commands)),
    ]
    for command in commands:
        kind = command.kind
        name = command.name
        chunks.append(_U8.pack(_OPCODE_BY_KIND[kind]))
        chunks.append(
            _encode_string(
                name,
                "name",
                maximum_bytes=_MAXIMUM_NODE_NAME_BYTES,
            )
        )
        fields = command.fields
        if kind == "node-create":
            chunks.append(
                _encode_nullable_string(
                    fields["parent_name"],
                    "parent_name",
                    maximum_bytes=_MAXIMUM_NODE_NAME_BYTES,
                )
            )
            chunks.append(
                _encode_string(
                    fields["prefab_id"],
                    "prefab_id",
                    maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES,
                )
            )
            chunks.append(
                _U8.pack(
                    _node_flags(fields["visible"], fields["transform_mode"])
                )
            )
            chunks.append(_encode_matrix(fields["transform"]))
            chunks.append(
                _encode_state(fields["state"], maximum_json_depth=maximum_json_depth)
            )
        elif kind == "node-set-transform":
            chunks.append(_encode_matrix(fields["transform"]))
        elif kind == "node-set-parent":
            chunks.append(
                _encode_nullable_string(
                    fields["parent_name"],
                    "parent_name",
                    maximum_bytes=_MAXIMUM_NODE_NAME_BYTES,
                )
            )
        elif kind == "node-set-visible":
            chunks.append(_U8.pack(int(fields["visible"])))
        elif kind == "node-set-state":
            chunks.append(
                _encode_state(fields["state"], maximum_json_depth=maximum_json_depth)
            )
        elif kind == "node-replace-prefab":
            chunks.append(
                _encode_string(
                    fields["prefab_id"],
                    "prefab_id",
                    maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES,
                )
            )
            chunks.append(
                _encode_state(fields["state"], maximum_json_depth=maximum_json_depth)
            )

    return EncodedDisplayPayload(
        bytes=b"".join(chunks),
        kind=DISPLAY_COMMAND_STREAM_KIND,
        last_command_seq=last_command_seq,
        source_tick=source_tick,
        base_command_seq=base_command_seq,
        maximum_json_depth=maximum_json_depth,
    )


def decode_display_command_stream_binary(
    data: Any,
    expected_source_tick: int,
    expected_last_command_seq: int,
    *,
    maximum_json_depth: int = 256,
) -> dict[str, Any]:
    """Decode one structurally valid ``SDCS`` while retaining opaque matrix bits."""

    _validate_depth(maximum_json_depth, WireError)
    source_tick = _safe_integer(
        expected_source_tick, "expected_source_tick", WireError
    )
    last_command_seq = _safe_integer(
        expected_last_command_seq, "expected_last_command_seq", WireError
    )
    reader = _Reader(data, "Display command stream")
    reader.header(DISPLAY_BINARY_COMMAND_STREAM_MAGIC)
    base_command_seq = reader.u64("base command sequence")
    _safe_integer(base_command_seq, "base_command_seq", WireError)
    encoded_source_tick = reader.u64("source tick")
    _safe_integer(encoded_source_tick, "source_tick", WireError)
    if encoded_source_tick != source_tick:
        reader.fail("source tick does not match the packet header")
    command_count = reader.u32("command count")
    if base_command_seq + command_count > MAXIMUM_SAFE_INTEGER:
        reader.fail("command sequence exceeds the JavaScript safe integer range")
    if base_command_seq + command_count != last_command_seq:
        reader.fail("command stream cursor does not match the packet header")
    if command_count > reader.remaining // 3:
        reader.fail("command count exceeds the remaining payload")

    records: list[dict[str, Any]] = []
    for ordinal in range(command_count):
        opcode = reader.u8("command opcode")
        kind = _KIND_BY_OPCODE.get(opcode)
        if kind is None:
            reader.fail("command opcode is unknown")
        name = reader.string("name", maximum_bytes=_MAXIMUM_NODE_NAME_BYTES)
        _validate_authority_name(name, "name", WireError)
        sequence = base_command_seq + ordinal + 1
        common = {
            "schema": DISPLAY_COMMAND_SCHEMA,
            "command_seq": sequence,
            "source_tick": source_tick,
            "kind": kind,
            "name": name,
        }
        if kind == "node-create":
            parent_name = reader.nullable_string(
                "parent_name", maximum_bytes=_MAXIMUM_NODE_NAME_BYTES
            )
            prefab_id = reader.string(
                "prefab_id", maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES
            )
            flags = reader.u8("Node flags")
            if flags & ~_NODE_FLAGS:
                reader.fail("Node flags contain reserved bits")
            visible = bool(flags & _NODE_FLAG_VISIBLE)
            transform_mode = "live" if flags & _NODE_FLAG_LIVE else "initial"
            transform = reader.matrix_transform()
            state = reader.state(maximum_json_depth=maximum_json_depth)
            try:
                node = DisplayNode(
                    name=name,
                    parent_name=parent_name,
                    prefab_id=prefab_id,
                    transform_mode=transform_mode,
                    transform=transform,
                    visible=visible,
                    state=state,
                )
            except ConfigurationError as exc:
                raise WireError("node-create command is invalid") from exc
            node_record = node.to_record()
            node_record.pop("name")
            records.append({**common, **node_record})
        elif kind == "node-set-transform":
            transform = reader.matrix_transform()
            _validated_command_call(DisplayCommand.set_transform, name, transform)
            records.append({**common, "transform": transform.to_record()})
        elif kind == "node-set-parent":
            parent_name = reader.nullable_string(
                "parent_name", maximum_bytes=_MAXIMUM_NODE_NAME_BYTES
            )
            _validated_command_call(DisplayCommand.set_parent, name, parent_name)
            records.append({**common, "parent_name": parent_name})
        elif kind == "node-set-visible":
            visible_raw = reader.u8("visibility")
            if visible_raw not in (0, 1):
                reader.fail("visibility must be zero or one")
            visible = bool(visible_raw)
            _validated_command_call(DisplayCommand.set_visible, name, visible)
            records.append({**common, "visible": visible})
        elif kind == "node-set-state":
            state = reader.state(maximum_json_depth=maximum_json_depth)
            command = _validated_command_call(DisplayCommand.set_state, name, state)
            records.append({**common, "state": _thaw(command.fields["state"])})
        elif kind == "node-replace-prefab":
            prefab_id = reader.string(
                "prefab_id", maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES
            )
            state = reader.state(maximum_json_depth=maximum_json_depth)
            command = _validated_command_call(
                DisplayCommand.replace_prefab, name, prefab_id, state
            )
            records.append(
                {
                    **common,
                    "prefab_id": command.fields["prefab_id"],
                    "state": _thaw(command.fields["state"]),
                }
            )
        else:
            _validated_command_call(DisplayCommand.remove, name)
            records.append(common)
    reader.finish()

    return {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": base_command_seq,
        "last_command_seq": last_command_seq,
        "commands": records,
    }


def _checkpoint_semantics(
    value: Any, *, expected_last_command_seq: int, maximum_json_depth: int
) -> tuple[str, DisplayCatalogIdentity, tuple[_EncodedCheckpointNode, ...]]:
    if isinstance(value, ValidatedDisplayCheckpoint):
        if (
            value.last_command_seq != expected_last_command_seq
            or value.maximum_json_depth > maximum_json_depth
        ):
            raise ConfigurationError("validated display checkpoint seal is invalid")
        return (
            value.scene_name,
            value.catalog,
            tuple(
                _EncodedCheckpointNode(
                    name=node.name,
                    parent_name=node.parent_name,
                    prefab_id=node.prefab_id,
                    flags=_node_flags(node.visible, node.transform_mode),
                    matrix=_encode_matrix(node.transform),
                    state=_encode_state(
                        node.state, maximum_json_depth=maximum_json_depth
                    ),
                )
                for node in value.nodes
            ),
        )
    fields = {
        "schema",
        "scene_name",
        "scene_catalog_hash",
        "prefab_catalog_hash",
        "state_schema_hash",
        "last_command_seq",
        "nodes",
    }
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ConfigurationError("display checkpoint fields are invalid")
    if value["schema"] != DISPLAY_CHECKPOINT_SCHEMA:
        raise ConfigurationError("display checkpoint schema is invalid")
    scene_name = _validate_scene_name(value["scene_name"], ConfigurationError)
    catalog = DisplayCatalogIdentity(
        scene_catalog_hash=value["scene_catalog_hash"],
        prefab_catalog_hash=value["prefab_catalog_hash"],
        state_schema_hash=value["state_schema_hash"],
    )
    last = _safe_integer(value["last_command_seq"], "last_command_seq", ConfigurationError)
    if last != expected_last_command_seq:
        raise ConfigurationError("display checkpoint command cursor is invalid")
    records = value["nodes"]
    if not isinstance(records, list):
        raise ConfigurationError("display checkpoint nodes must be an array")
    nodes: list[_EncodedCheckpointNode] = []
    seen: set[str] = set()
    depths: dict[str, int] = {}
    node_fields = {
        "name",
        "parent_name",
        "prefab_id",
        "transform_mode",
        "transform",
        "visible",
        "state",
    }
    for record in records:
        if not isinstance(record, Mapping) or set(record) != node_fields:
            raise ConfigurationError("display checkpoint Node fields are invalid")
        name = _validate_authority_name(record["name"], "name", ConfigurationError)
        parent_name = record["parent_name"]
        if parent_name is not None:
            parent_name = _validate_authority_name(
                parent_name, "parent_name", ConfigurationError
            )
        prefab_id = _validate_prefab_id(record["prefab_id"], ConfigurationError)
        if name in seen:
            raise ConfigurationError("display checkpoint contains duplicate names")
        if parent_name is not None and parent_name not in seen:
            raise ConfigurationError("display checkpoint must be parent-before-child")
        depth = 1 if parent_name is None else depths[parent_name] + 1
        if depth > 128:
            raise ConfigurationError("display checkpoint exceeds maximum Node depth")
        flags = _node_flags(record["visible"], record["transform_mode"])
        transform = DisplayTransform.from_record(record["transform"])
        state = _encode_state(
            record["state"], maximum_json_depth=maximum_json_depth
        )
        nodes.append(
            _EncodedCheckpointNode(
                name=name,
                parent_name=parent_name,
                prefab_id=prefab_id,
                flags=flags,
                matrix=_encode_matrix(transform),
                state=state,
            )
        )
        seen.add(name)
        depths[name] = depth
    return scene_name, catalog, tuple(nodes)


def _command_stream_semantics(
    value: Any,
    *,
    expected_source_tick: int,
    expected_last_command_seq: int,
    maximum_json_depth: int,
) -> tuple[int, tuple[DisplayCommand, ...]]:
    if isinstance(value, ValidatedDisplayCommandStream):
        if (
            value.source_tick != expected_source_tick
            or value.last_command_seq != expected_last_command_seq
            or value.last_command_seq
            != value.base_command_seq + len(value.commands)
            or value.maximum_json_depth > maximum_json_depth
        ):
            raise ConfigurationError("validated display command stream seal is invalid")
        return value.base_command_seq, value.commands

    fields = {"schema", "base_command_seq", "last_command_seq", "commands"}
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ConfigurationError("display command stream fields are invalid")
    if value["schema"] != DISPLAY_COMMAND_STREAM_SCHEMA:
        raise ConfigurationError("display command stream schema is invalid")
    base = _safe_integer(value["base_command_seq"], "base_command_seq", ConfigurationError)
    last = _safe_integer(value["last_command_seq"], "last_command_seq", ConfigurationError)
    if last != expected_last_command_seq or last < base:
        raise ConfigurationError("display command stream cursor is invalid")
    records = value["commands"]
    if not isinstance(records, (list, tuple)) or len(records) != last - base:
        raise ConfigurationError("display command stream length is invalid")

    commands: list[DisplayCommand] = []
    for ordinal, record in enumerate(records):
        command_seq = base + ordinal + 1
        command = _command_from_semantic_record(
            record,
            expected_command_seq=command_seq,
            expected_source_tick=expected_source_tick,
        )
        commands.append(command)
    return base, tuple(commands)


def _command_from_semantic_record(
    value: Any, *, expected_command_seq: int, expected_source_tick: int
) -> DisplayCommand:
    common = {"schema", "command_seq", "source_tick", "kind", "name"}
    fields_by_kind = {
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
    if not isinstance(value, Mapping) or not common.issubset(value):
        raise ConfigurationError("display command record fields are invalid")
    kind = value["kind"]
    extra = fields_by_kind.get(kind)
    if (
        extra is None
        or set(value) != common | extra
        or value["schema"] != DISPLAY_COMMAND_SCHEMA
    ):
        raise ConfigurationError("display command record fields are invalid")
    if (
        _safe_integer(value["command_seq"], "command_seq", ConfigurationError)
        != expected_command_seq
    ):
        raise ConfigurationError("display command sequence is invalid")
    if (
        _safe_integer(value["source_tick"], "source_tick", ConfigurationError)
        != expected_source_tick
    ):
        raise ConfigurationError("display command source_tick is invalid")
    name = _validate_authority_name(value["name"], "name", ConfigurationError)
    if kind == "node-create":
        return DisplayCommand.create_node(
            DisplayNode(
                name=name,
                parent_name=value["parent_name"],
                prefab_id=value["prefab_id"],
                transform_mode=value["transform_mode"],
                transform=value["transform"],
                visible=value["visible"],
                state=value["state"],
            )
        )
    if kind == "node-set-transform":
        return DisplayCommand.set_transform(name, value["transform"])
    if kind == "node-set-parent":
        return DisplayCommand.set_parent(name, value["parent_name"])
    if kind == "node-set-visible":
        return DisplayCommand.set_visible(name, value["visible"])
    if kind == "node-set-state":
        return DisplayCommand.set_state(name, value["state"])
    if kind == "node-replace-prefab":
        return DisplayCommand.replace_prefab(
            name, value["prefab_id"], value["state"]
        )
    return DisplayCommand.remove(name)


def _node_flags(visible: Any, transform_mode: Any) -> int:
    if not isinstance(visible, bool):
        raise ConfigurationError("visible must be boolean")
    if transform_mode not in {"initial", "live"}:
        raise ConfigurationError("transform_mode must be initial or live")
    return int(visible) | (_NODE_FLAG_LIVE if transform_mode == "live" else 0)


def _encode_matrix(transform: DisplayTransform) -> np.ndarray:
    if not isinstance(transform, DisplayTransform):
        raise ConfigurationError("Display transform must be DisplayTransform")
    return transform._matrix_buffer()


def _encode_string(value: Any, field: str, *, maximum_bytes: int) -> bytes:
    if not isinstance(value, str):
        raise ConfigurationError(f"{field} must be a string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ConfigurationError(f"{field} is not valid Unicode") from exc
    if len(encoded) > maximum_bytes or len(encoded) > _MAXIMUM_U16_STRING_BYTES:
        raise ConfigurationError(f"{field} exceeds its UTF-8 byte limit")
    return _U16.pack(len(encoded)) + encoded


def _encode_nullable_string(
    value: Any, field: str, *, maximum_bytes: int
) -> bytes:
    if value is None:
        return _U16.pack(_NULL_STRING_LENGTH)
    return _encode_string(value, field, maximum_bytes=maximum_bytes)


def _encode_state(value: Any, *, maximum_json_depth: int) -> bytes:
    owned = _thaw(value)
    if not isinstance(owned, dict):
        raise ConfigurationError("authority state must be a JSON object")
    try:
        validate_json_value(owned, maximum_depth=maximum_json_depth)
        payload = json.dumps(
            owned,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (JsonTreeError, TypeError, ValueError, UnicodeError) as exc:
        raise ConfigurationError("authority state is not canonical JSON") from exc
    if len(payload) > _MAXIMUM_U32:
        raise ConfigurationError("authority state exceeds uint32 bytes")
    return _U32.pack(len(payload)) + payload


class _Reader:
    def __init__(self, data: Any, label: str) -> None:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise WireError(f"{label} must be bytes-like")
        self.data = bytes(data)
        self.label = label
        self.cursor = 0

    @property
    def remaining(self) -> int:
        return len(self.data) - self.cursor

    def fail(self, message: str) -> NoReturn:
        raise WireError(f"{self.label}: {message}")

    def take(self, length: int, field: str) -> bytes:
        if length < 0 or length > self.remaining:
            self.fail(f"{field} is truncated")
        start = self.cursor
        self.cursor += length
        return self.data[start : self.cursor]

    def header(self, expected_magic: bytes) -> None:
        raw = self.take(_COMMON_HEADER.size, "header")
        magic, version, scalar, flags = _COMMON_HEADER.unpack(raw)
        if magic != expected_magic:
            self.fail("magic is invalid")
        if version != DISPLAY_BINARY_VERSION:
            self.fail("version is unsupported")
        if scalar != DISPLAY_BINARY_SCALAR_FLOAT32:
            self.fail("scalar encoding is unsupported")
        if flags != 0:
            self.fail("header flags must be zero")

    def u8(self, field: str) -> int:
        return _U8.unpack(self.take(_U8.size, field))[0]

    def u16(self, field: str) -> int:
        return _U16.unpack(self.take(_U16.size, field))[0]

    def u32(self, field: str) -> int:
        return _U32.unpack(self.take(_U32.size, field))[0]

    def u64(self, field: str) -> int:
        return _U64.unpack(self.take(_U64.size, field))[0]

    def string(self, field: str, *, maximum_bytes: int) -> str:
        length = self.u16(f"{field} length")
        if length == _NULL_STRING_LENGTH or length > maximum_bytes:
            self.fail(f"{field} length is invalid")
        return self._decode_string(self.take(length, field), field)

    def nullable_string(self, field: str, *, maximum_bytes: int) -> str | None:
        length = self.u16(f"{field} length")
        if length == _NULL_STRING_LENGTH:
            return None
        if length > maximum_bytes:
            self.fail(f"{field} length is invalid")
        return self._decode_string(self.take(length, field), field)

    def _decode_string(self, raw: bytes, field: str) -> str:
        try:
            value = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WireError(f"{self.label}: {field} is not valid UTF-8") from exc
        if _contains_lone_surrogate(value):
            self.fail(f"{field} contains a lone surrogate")
        return value

    def state(self, *, maximum_json_depth: int) -> dict[str, Any]:
        length = self.u32("state length")
        raw = self.take(length, "state")
        return _decode_state(raw, maximum_json_depth=maximum_json_depth, label=self.label)

    def matrix_transform(self) -> DisplayTransform:
        raw = self.take(_MATRIX4_F32.size, "matrix")
        try:
            return DisplayTransform(matrix_bytes=raw)
        except ConfigurationError as exc:
            raise WireError(f"{self.label}: {exc}") from exc

    def finish(self) -> None:
        if self.remaining != 0:
            self.fail("payload has trailing bytes")


def _decode_state(
    raw: bytes, *, maximum_json_depth: int, label: str
) -> dict[str, Any]:
    if raw.startswith(b"\xef\xbb\xbf"):
        raise WireError(f"{label}: state JSON must not contain a BOM")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WireError(f"{label}: state is not valid UTF-8") from exc

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in items:
            if key in result:
                raise WireError(f"{label}: state contains a duplicate key")
            result[key] = item
        return result

    def integer(token: str) -> int:
        value = int(token)
        if abs(value) > MAXIMUM_SAFE_INTEGER:
            raise WireError(f"{label}: state contains an unsafe integer")
        return value

    def finite(token: str) -> float:
        value = float(token)
        if not math.isfinite(value):
            raise WireError(f"{label}: state contains a non-finite number")
        return value

    try:
        value = json.loads(
            text,
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=finite,
            parse_constant=lambda _token: _raise(
                WireError, f"{label}: state contains a non-finite number"
            ),
        )
        validate_json_value(value, maximum_depth=maximum_json_depth)
    except WireError:
        raise
    except (json.JSONDecodeError, JsonTreeError, ValueError) as exc:
        raise WireError(f"{label}: state JSON is invalid") from exc
    if not isinstance(value, dict):
        raise WireError(f"{label}: state must be a JSON object")
    if _contains_lone_surrogate(value):
        raise WireError(f"{label}: state contains a lone surrogate")
    return value


def _validate_scene_name(
    value: Any,
    error_type: type[ConfigurationError] | type[WireError],
) -> str:
    try:
        encoded_length = len(value.encode("utf-8")) if isinstance(value, str) else -1
    except UnicodeEncodeError as exc:
        _raise(error_type, "scene_name is invalid", exc)
    if (
        not isinstance(value, str)
        or encoded_length > _MAXIMUM_SCENE_NAME_BYTES
        or _SCENE_NAME.fullmatch(value) is None
    ):
        _raise(error_type, "scene_name is invalid")
    return value


def _validate_authority_name(
    value: Any,
    field: str,
    error_type: type[ConfigurationError] | type[WireError],
) -> str:
    encoded_length = _utf8_length(value, field, error_type)
    if (
        encoded_length > _MAXIMUM_NODE_NAME_BYTES
        or _AUTHORITY_NAME.fullmatch(value) is None
    ):
        _raise(error_type, f"{field} is not a valid authority Node name")
    return value


def _validate_prefab_id(
    value: Any,
    error_type: type[ConfigurationError] | type[WireError],
) -> str:
    encoded_length = _utf8_length(value, "prefab_id", error_type)
    if (
        encoded_length > _MAXIMUM_PREFAB_ID_BYTES
        or _PREFAB_ID.fullmatch(value) is None
    ):
        _raise(error_type, "prefab_id is invalid")
    return value


def _utf8_length(
    value: Any,
    field: str,
    error_type: type[ConfigurationError] | type[WireError],
) -> int:
    if not isinstance(value, str):
        _raise(error_type, f"{field} must be a string")
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        _raise(error_type, f"{field} is invalid Unicode", exc)


def _validated_command_call(method: Any, *args: Any) -> DisplayCommand:
    try:
        return method(*args)
    except ConfigurationError as exc:
        raise WireError("decoded Display command is invalid") from exc


def _safe_integer(
    value: Any,
    field: str,
    error_type: type[ConfigurationError] | type[WireError],
) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAXIMUM_SAFE_INTEGER
    ):
        _raise(error_type, f"{field} must be a non-negative safe integer")
    return value


def _validate_depth(
    value: Any, error_type: type[ConfigurationError] | type[WireError]
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _raise(error_type, "maximum_json_depth must be a positive integer")
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_thaw(item) for item in value]
    return value


def _contains_lone_surrogate(value: Any) -> bool:
    if isinstance(value, str):
        return any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    if isinstance(value, Mapping):
        return any(
            _contains_lone_surrogate(key) or _contains_lone_surrogate(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_lone_surrogate(item) for item in value)
    return False


def _raise(
    error_type: type[ConfigurationError] | type[WireError],
    message: str,
    cause: BaseException | None = None,
) -> NoReturn:
    if cause is None:
        raise error_type(message)
    raise error_type(message) from cause


__all__ = [
    "DISPLAY_BINARY_CHECKPOINT_MAGIC",
    "DISPLAY_BINARY_COMMAND_STREAM_MAGIC",
    "DISPLAY_BINARY_SCALAR_FLOAT32",
    "DISPLAY_BINARY_VERSION",
    "DISPLAY_CHECKPOINT_KIND",
    "DISPLAY_CHECKPOINT_SCHEMA",
    "DISPLAY_COMMAND_SCHEMA",
    "DISPLAY_COMMAND_STREAM_KIND",
    "DISPLAY_COMMAND_STREAM_SCHEMA",
    "EncodedDisplayPayload",
    "decode_display_checkpoint_binary",
    "decode_display_command_stream_binary",
    "encode_display_checkpoint_binary",
    "encode_display_command_stream_binary",
]
