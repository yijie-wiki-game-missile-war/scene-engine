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
    MAXIMUM_EVENT_NAME_BYTES,
    MAXIMUM_NODE_ID,
    MAXIMUM_PROPERTY_NAME_BYTES,
    NULL_NODE_ID,
    ValidatedDisplayCheckpoint,
    ValidatedDisplayCommandStream,
)
from .errors import ConfigurationError, JsonTreeError, WireError
from .json_tree import MAXIMUM_SAFE_INTEGER, validate_json_value


DISPLAY_BINARY_CHECKPOINT_MAGIC = b"SDCP"
DISPLAY_BINARY_COMMAND_STREAM_MAGIC = b"SDCS"
DISPLAY_BINARY_VERSION = 5
DISPLAY_BINARY_SCALAR_FLOAT32 = 1

DISPLAY_CHECKPOINT_KIND = "display_checkpoint"
DISPLAY_COMMAND_STREAM_KIND = "display_command_stream"

_COMMON_HEADER = struct.Struct("<4sBBH")
_U8 = struct.Struct("<B")
_U16 = struct.Struct("<H")
_U32 = struct.Struct("<I")
_U64 = struct.Struct("<Q")
_MATRIX4_F32 = struct.Struct("<16f")

_NULL_NODE_ID = NULL_NODE_ID
_MAXIMUM_U16_STRING_BYTES = 0xFFFE
_MAXIMUM_U32 = 0xFFFFFFFF
_MAXIMUM_COMMANDS_PER_PAYLOAD = 65_536

_NODE_FLAG_VISIBLE = 1 << 0
_NODE_FLAG_LIVE = 1 << 1
_NODE_FLAGS = _NODE_FLAG_VISIBLE | _NODE_FLAG_LIVE

_OPCODE_BY_KIND = {
    "node-create": 1,
    "node-set-transform-batch": 2,
    "node-set-parent": 3,
    "node-set-visible": 4,
    "node-set-state": 5,
    "node-replace-prefab": 6,
    "node-remove": 7,
    "node-set-property": 8,
    "node-unset-property": 9,
    "node-emit-event": 10,
}
_KIND_BY_OPCODE = {value: key for key, value in _OPCODE_BY_KIND.items()}

_SCENE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_PREFAB_ID = re.compile(
    r"^[a-z0-9][a-z0-9._@-]*(?:/[a-z0-9][a-z0-9._@-]*)*$"
)

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
    node_id: int
    parent_node_id: int | None
    prefab_id: str
    flags: int
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
    scene_name, catalog, matrix_pool, nodes = _checkpoint_semantics(
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
        _U32.pack(len(matrix_pool)),
        _U32.pack(len(nodes)),
        matrix_pool,
        _encode_string(
            scene_name,
            "scene_name",
            maximum_bytes=_MAXIMUM_SCENE_NAME_BYTES,
        ),
        bytes.fromhex(catalog.scene_catalog_hash),
        bytes.fromhex(catalog.prefab_catalog_hash),
        bytes.fromhex(catalog.state_schema_hash),
    ]
    for node in nodes:
        chunks.append(_U32.pack(node.node_id))
        chunks.append(
            _U32.pack(
                _NULL_NODE_ID
                if node.parent_node_id is None
                else node.parent_node_id
            )
        )
        chunks.append(
            _encode_string(
                node.prefab_id,
                "prefab_id",
                maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES,
            )
        )
        chunks.append(_U8.pack(node.flags))
        chunks.append(node.state)

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
    matrix_pool_size = reader.u32("matrix pool size")
    node_count = reader.u32("active Node count")
    if node_count > matrix_pool_size:
        reader.fail("active Node count exceeds matrix pool size")
    matrix_pool = reader.matrix_tensor(matrix_pool_size, "matrix pool")
    scene_name = reader.string(
        "scene_name", maximum_bytes=_MAXIMUM_SCENE_NAME_BYTES
    )
    _validate_scene_name(scene_name, WireError)
    catalog = DisplayCatalogIdentity(
        scene_catalog_hash=reader.take(32, "scene catalog hash").hex(),
        prefab_catalog_hash=reader.take(32, "prefab catalog hash").hex(),
        state_schema_hash=reader.take(32, "state schema hash").hex(),
    )
    minimum_node_bytes = 4 + 4 + 2 + 1 + 4
    if node_count > reader.remaining // minimum_node_bytes:
        reader.fail("Node count exceeds the remaining payload")

    nodes: list[DisplayNode] = []
    seen_ids: set[int] = set()
    depths: dict[int, int] = {}
    for _index in range(node_count):
        node_id = reader.node_id("node ID")
        if node_id >= matrix_pool_size:
            reader.fail("Node ID is outside matrix pool size")
        if node_id in seen_ids:
            reader.fail("Node ID is duplicated")
        parent_raw = reader.u32("parent Node ID")
        if parent_raw == _NULL_NODE_ID:
            parent_node_id = None
            depth = 1
        else:
            parent_node_id = reader.validate_node_id(parent_raw, "parent Node ID")
            if parent_node_id not in seen_ids:
                reader.fail("parent Node ID must refer to an earlier Node")
            depth = depths[parent_node_id] + 1
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
        state = reader.state(maximum_json_depth=maximum_json_depth)
        try:
            nodes.append(
                DisplayNode(
                    node_id=node_id,
                    parent_node_id=parent_node_id,
                    prefab_id=prefab_id,
                    transform_mode=transform_mode,
                    visible=visible,
                    state=state,
                )
            )
        except ConfigurationError as exc:
            raise WireError("Display checkpoint Node is invalid") from exc
        seen_ids.add(node_id)
        depths[node_id] = depth
    bits = matrix_pool.view("<u4")
    for node_id in range(matrix_pool_size):
        if node_id not in seen_ids and np.any(bits[node_id] != 0):
            reader.fail("inactive matrix pool row is not a zero tombstone")
    reader.finish()

    return {
        "schema": DISPLAY_CHECKPOINT_SCHEMA,
        "scene_name": scene_name,
        "scene_catalog_hash": catalog.scene_catalog_hash,
        "prefab_catalog_hash": catalog.prefab_catalog_hash,
        "state_schema_hash": catalog.state_schema_hash,
        "last_command_seq": last_command_seq,
        "matrix_pool_size": matrix_pool_size,
        "matrix_pool": matrix_pool,
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
    raw_commands: Any = None
    if isinstance(value, ValidatedDisplayCommandStream):
        raw_commands = value.commands
    elif isinstance(value, Mapping):
        raw_commands = value.get("commands")
    if (
        isinstance(raw_commands, (list, tuple))
        and len(raw_commands) > _MAXIMUM_COMMANDS_PER_PAYLOAD
    ):
        raise ConfigurationError("display command count exceeds fixed limit of 65536")
    (
        base_command_seq,
        matrix_pool_size,
        dirty_node_ids,
        dirty_matrices,
        commands,
    ) = _command_stream_semantics(
        value,
        expected_source_tick=source_tick,
        expected_last_command_seq=last_command_seq,
        maximum_json_depth=maximum_json_depth,
    )
    if len(commands) > _MAXIMUM_COMMANDS_PER_PAYLOAD:
        raise ConfigurationError("display command count exceeds fixed limit of 65536")

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
        _U32.pack(matrix_pool_size),
        _U32.pack(len(dirty_node_ids)),
        dirty_node_ids,
        dirty_matrices,
    ]
    for command in commands:
        kind = command.kind
        chunks.append(_U8.pack(_OPCODE_BY_KIND[kind]))
        if kind == "node-set-transform-batch":
            assert command.node_ids is not None
            chunks.append(_U32.pack(len(command.node_ids)))
            continue
        assert command.node_id is not None
        chunks.append(_U32.pack(command.node_id))
        fields = command.fields
        if kind == "node-create":
            chunks.append(
                _U32.pack(
                    _NULL_NODE_ID
                    if fields["parent_node_id"] is None
                    else fields["parent_node_id"]
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
            chunks.append(
                _encode_state(fields["state"], maximum_json_depth=maximum_json_depth)
            )
        elif kind == "node-set-parent":
            chunks.append(
                _U32.pack(
                    _NULL_NODE_ID
                    if fields["parent_node_id"] is None
                    else fields["parent_node_id"]
                )
            )
        elif kind == "node-set-visible":
            chunks.append(_U8.pack(int(fields["visible"])))
        elif kind == "node-set-state":
            chunks.append(
                _encode_state(fields["state"], maximum_json_depth=maximum_json_depth)
            )
        elif kind == "node-set-property":
            chunks.append(
                _encode_string(
                    fields["property_name"],
                    "property_name",
                    maximum_bytes=MAXIMUM_PROPERTY_NAME_BYTES,
                )
            )
            chunks.append(
                _encode_json_value(
                    fields["value"],
                    field="property value",
                    maximum_json_depth=maximum_json_depth - 1,
                )
            )
        elif kind == "node-unset-property":
            chunks.append(
                _encode_string(
                    fields["property_name"],
                    "property_name",
                    maximum_bytes=MAXIMUM_PROPERTY_NAME_BYTES,
                )
            )
        elif kind == "node-emit-event":
            chunks.append(
                _encode_string(
                    fields["event_name"],
                    "event_name",
                    maximum_bytes=MAXIMUM_EVENT_NAME_BYTES,
                )
            )
            chunks.append(
                _encode_json_object(
                    fields["payload"],
                    field="event payload",
                    maximum_json_depth=maximum_json_depth,
                )
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
    if command_count > _MAXIMUM_COMMANDS_PER_PAYLOAD:
        reader.fail("command count exceeds fixed limit of 65536")
    if base_command_seq + command_count > MAXIMUM_SAFE_INTEGER:
        reader.fail("command sequence exceeds the JavaScript safe integer range")
    if base_command_seq + command_count != last_command_seq:
        reader.fail("command stream cursor does not match the packet header")
    matrix_pool_size = reader.u32("matrix pool size")
    dirty_count = reader.u32("dirty matrix count")
    if dirty_count > matrix_pool_size:
        reader.fail("dirty matrix count exceeds matrix pool size")
    dirty_node_ids = reader.uint32_vector(dirty_count, "dirty Node IDs")
    if dirty_count and int(dirty_node_ids[-1]) > MAXIMUM_NODE_ID:
        reader.fail("dirty Node ID is invalid")
    if dirty_count > 1 and not np.all(dirty_node_ids[1:] > dirty_node_ids[:-1]):
        reader.fail("dirty Node IDs must be unique and strictly sorted")
    if dirty_count and int(dirty_node_ids[-1]) >= matrix_pool_size:
        reader.fail("dirty Node ID is outside matrix pool size")
    dirty_matrices = reader.matrix_tensor(dirty_count, "dirty matrices")
    if command_count > reader.remaining // 5:
        reader.fail("command count exceeds the remaining payload")

    records: list[dict[str, Any]] = []
    transform_count = 0
    transform_batch_seen = False
    for ordinal in range(command_count):
        opcode = reader.u8("command opcode")
        kind = _KIND_BY_OPCODE.get(opcode)
        if kind is None:
            reader.fail("command opcode is unknown")
        sequence = base_command_seq + ordinal + 1
        metadata = {
            "schema": DISPLAY_COMMAND_SCHEMA,
            "command_seq": sequence,
            "source_tick": source_tick,
            "kind": kind,
        }
        if kind == "node-set-transform-batch":
            if transform_batch_seen:
                reader.fail("command stream contains more than one transform batch")
            transform_batch_seen = True
            transform_count = reader.u32("transform batch count")
            if transform_count == 0 or transform_count > dirty_count:
                reader.fail("transform batch count is invalid")
            node_ids = dirty_node_ids[:transform_count]
            records.append({**metadata, "node_ids": node_ids})
            continue
        node_id = reader.node_id("command Node ID")
        if node_id >= matrix_pool_size:
            reader.fail("command Node ID is outside matrix pool size")
        common = {**metadata, "node_id": node_id}
        if kind == "node-create":
            parent_raw = reader.u32("parent Node ID")
            parent_node_id = (
                None
                if parent_raw == _NULL_NODE_ID
                else reader.validate_node_id(parent_raw, "parent Node ID")
            )
            if parent_node_id is not None and parent_node_id >= matrix_pool_size:
                reader.fail("parent Node ID is outside matrix pool size")
            prefab_id = reader.string(
                "prefab_id", maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES
            )
            flags = reader.u8("Node flags")
            if flags & ~_NODE_FLAGS:
                reader.fail("Node flags contain reserved bits")
            visible = bool(flags & _NODE_FLAG_VISIBLE)
            transform_mode = "live" if flags & _NODE_FLAG_LIVE else "initial"
            state = reader.state(maximum_json_depth=maximum_json_depth)
            try:
                node = DisplayNode(
                    node_id=node_id,
                    parent_node_id=parent_node_id,
                    prefab_id=prefab_id,
                    transform_mode=transform_mode,
                    visible=visible,
                    state=state,
                )
            except ConfigurationError as exc:
                raise WireError("node-create command is invalid") from exc
            node_record = node.to_record()
            node_record.pop("node_id")
            records.append({**common, **node_record})
        elif kind == "node-set-parent":
            parent_raw = reader.u32("parent Node ID")
            parent_node_id = (
                None
                if parent_raw == _NULL_NODE_ID
                else reader.validate_node_id(parent_raw, "parent Node ID")
            )
            if parent_node_id is not None and parent_node_id >= matrix_pool_size:
                reader.fail("parent Node ID is outside matrix pool size")
            _validated_command_call(DisplayCommand.set_parent, node_id, parent_node_id)
            records.append({**common, "parent_node_id": parent_node_id})
        elif kind == "node-set-visible":
            visible_raw = reader.u8("visibility")
            if visible_raw not in (0, 1):
                reader.fail("visibility must be zero or one")
            visible = bool(visible_raw)
            _validated_command_call(DisplayCommand.set_visible, node_id, visible)
            records.append({**common, "visible": visible})
        elif kind == "node-set-state":
            state = reader.state(maximum_json_depth=maximum_json_depth)
            command = _validated_command_call(DisplayCommand.set_state, node_id, state)
            records.append({**common, "state": _thaw(command.fields["state"])})
        elif kind == "node-set-property":
            property_name = reader.string(
                "property_name", maximum_bytes=MAXIMUM_PROPERTY_NAME_BYTES
            )
            property_value = reader.json_value(
                "property value", maximum_json_depth=maximum_json_depth - 1
            )
            command = _validated_command_call(
                DisplayCommand.set_property,
                node_id,
                property_name,
                property_value,
            )
            records.append(
                {
                    **common,
                    "property_name": command.fields["property_name"],
                    "value": _thaw(command.fields["value"]),
                }
            )
        elif kind == "node-unset-property":
            property_name = reader.string(
                "property_name", maximum_bytes=MAXIMUM_PROPERTY_NAME_BYTES
            )
            command = _validated_command_call(
                DisplayCommand.unset_property, node_id, property_name
            )
            records.append(
                {**common, "property_name": command.fields["property_name"]}
            )
        elif kind == "node-emit-event":
            event_name = reader.string(
                "event_name", maximum_bytes=MAXIMUM_EVENT_NAME_BYTES
            )
            payload = reader.json_object(
                "event payload", maximum_json_depth=maximum_json_depth
            )
            command = _validated_command_call(
                DisplayCommand.emit_event, node_id, event_name, payload
            )
            records.append(
                {
                    **common,
                    "event_name": command.fields["event_name"],
                    "payload": _thaw(command.fields["payload"]),
                }
            )
        elif kind == "node-replace-prefab":
            prefab_id = reader.string(
                "prefab_id", maximum_bytes=_MAXIMUM_PREFAB_ID_BYTES
            )
            state = reader.state(maximum_json_depth=maximum_json_depth)
            command = _validated_command_call(
                DisplayCommand.replace_prefab, node_id, prefab_id, state
            )
            records.append(
                {
                    **common,
                    "prefab_id": command.fields["prefab_id"],
                    "state": _thaw(command.fields["state"]),
                }
            )
        elif kind == "node-remove":
            _validated_command_call(DisplayCommand.remove, node_id)
            records.append(common)
        else:
            reader.fail("command opcode is unsupported")
    create_targets = sorted(
        record["node_id"]
        for record in records
        if record["kind"] == "node-create"
    )
    if (
        len(create_targets) != len(set(create_targets))
        or transform_count + len(create_targets) != dirty_count
        or any(
            target != int(dirty_node_id)
            for target, dirty_node_id in zip(
                create_targets, dirty_node_ids[transform_count:], strict=True
            )
        )
    ):
        reader.fail(
            "dirty Node IDs do not exactly match transform batch/create commands"
        )
    reader.finish()

    return {
        "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
        "base_command_seq": base_command_seq,
        "last_command_seq": last_command_seq,
        "matrix_pool_size": matrix_pool_size,
        "dirty_node_ids": dirty_node_ids,
        "dirty_matrices": dirty_matrices,
        "commands": records,
    }


def _checkpoint_semantics(
    value: Any, *, expected_last_command_seq: int, maximum_json_depth: int
) -> tuple[str, DisplayCatalogIdentity, np.ndarray, tuple[_EncodedCheckpointNode, ...]]:
    if isinstance(value, ValidatedDisplayCheckpoint):
        if (
            value.last_command_seq != expected_last_command_seq
            or value.maximum_json_depth > maximum_json_depth
        ):
            raise ConfigurationError("validated display checkpoint seal is invalid")
        return (
            value.scene_name,
            value.catalog,
            value.matrix_pool,
            tuple(
                _EncodedCheckpointNode(
                    node_id=node.node_id,
                    parent_node_id=node.parent_node_id,
                    prefab_id=node.prefab_id,
                    flags=_node_flags(node.visible, node.transform_mode),
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
        "matrix_pool_size",
        "matrix_pool",
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
    from .display import validate_display_checkpoint

    semantic_nodes = validate_display_checkpoint(
        dict(value), expected_last_command_seq=expected_last_command_seq
    )
    matrix_pool_size = _uint32(
        value["matrix_pool_size"], "matrix_pool_size", ConfigurationError
    )
    matrix_pool = _semantic_matrix_tensor(
        value["matrix_pool"], matrix_pool_size, "matrix_pool"
    )
    nodes = tuple(
        _EncodedCheckpointNode(
            node_id=node.node_id,
            parent_node_id=node.parent_node_id,
            prefab_id=_validate_prefab_id(node.prefab_id, ConfigurationError),
            flags=_node_flags(node.visible, node.transform_mode),
            state=_encode_state(
                node.state, maximum_json_depth=maximum_json_depth
            ),
        )
        for node in semantic_nodes
    )
    return scene_name, catalog, matrix_pool, nodes


def _command_stream_semantics(
    value: Any,
    *,
    expected_source_tick: int,
    expected_last_command_seq: int,
    maximum_json_depth: int,
) -> tuple[int, int, np.ndarray, np.ndarray, tuple[DisplayCommand, ...]]:
    if isinstance(value, ValidatedDisplayCommandStream):
        if (
            value.source_tick != expected_source_tick
            or value.last_command_seq != expected_last_command_seq
            or value.last_command_seq
            != value.base_command_seq + len(value.commands)
            or value.maximum_json_depth > maximum_json_depth
        ):
            raise ConfigurationError("validated display command stream seal is invalid")
        return (
            value.base_command_seq,
            value.matrix_pool_size,
            value.dirty_node_ids,
            value.dirty_matrices,
            value.commands,
        )

    fields = {
        "schema",
        "base_command_seq",
        "last_command_seq",
        "matrix_pool_size",
        "dirty_node_ids",
        "dirty_matrices",
        "commands",
    }
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ConfigurationError("display command stream fields are invalid")
    if value["schema"] != DISPLAY_COMMAND_STREAM_SCHEMA:
        raise ConfigurationError("display command stream schema is invalid")
    base = _safe_integer(value["base_command_seq"], "base_command_seq", ConfigurationError)
    last = _safe_integer(value["last_command_seq"], "last_command_seq", ConfigurationError)
    if last != expected_last_command_seq or last < base:
        raise ConfigurationError("display command stream cursor is invalid")
    from .display import validate_display_command_stream

    commands = validate_display_command_stream(
        dict(value),
        expected_source_tick=expected_source_tick,
        expected_last_command_seq=expected_last_command_seq,
    )
    matrix_pool_size = _uint32(
        value["matrix_pool_size"], "matrix_pool_size", ConfigurationError
    )
    dirty_node_ids = _semantic_uint32_vector(
        value["dirty_node_ids"], "dirty_node_ids"
    )
    dirty_matrices = _semantic_matrix_tensor(
        value["dirty_matrices"], len(dirty_node_ids), "dirty_matrices"
    )
    return base, matrix_pool_size, dirty_node_ids, dirty_matrices, commands


def _node_flags(visible: Any, transform_mode: Any) -> int:
    if not isinstance(visible, bool):
        raise ConfigurationError("visible must be boolean")
    if transform_mode not in {"initial", "live"}:
        raise ConfigurationError("transform_mode must be initial or live")
    return int(visible) | (_NODE_FLAG_LIVE if transform_mode == "live" else 0)


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


def _encode_state(value: Any, *, maximum_json_depth: int) -> bytes:
    return _encode_json_object(
        value,
        field="authority state",
        maximum_json_depth=maximum_json_depth,
    )


def _encode_json_object(
    value: Any, *, field: str, maximum_json_depth: int
) -> bytes:
    owned = _thaw(value)
    if not isinstance(owned, dict):
        raise ConfigurationError(f"{field} must be a JSON object")
    return _encode_json_value(
        owned,
        field=field,
        maximum_json_depth=maximum_json_depth,
    )


def _encode_json_value(
    value: Any, *, field: str, maximum_json_depth: int
) -> bytes:
    owned = _thaw(value)
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
        raise ConfigurationError(f"{field} is not canonical JSON") from exc
    if len(payload) > _MAXIMUM_U32:
        raise ConfigurationError(f"{field} exceeds uint32 bytes")
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
        return self.json_object("state", maximum_json_depth=maximum_json_depth)

    def json_object(
        self, field: str, *, maximum_json_depth: int
    ) -> dict[str, Any]:
        value = self.json_value(field, maximum_json_depth=maximum_json_depth)
        if not isinstance(value, dict):
            self.fail(f"{field} must be a JSON object")
        return value

    def json_value(self, field: str, *, maximum_json_depth: int) -> Any:
        length = self.u32(f"{field} length")
        raw = self.take(length, field)
        return _decode_json_value(
            raw,
            maximum_json_depth=maximum_json_depth,
            label=self.label,
            field=field,
        )

    def validate_node_id(self, value: int, field: str) -> int:
        if value > MAXIMUM_NODE_ID:
            self.fail(f"{field} is invalid")
        return value

    def node_id(self, field: str) -> int:
        return self.validate_node_id(self.u32(field), field)

    def matrix_tensor(self, count: int, field: str) -> np.ndarray:
        if count > self.remaining // _MATRIX4_F32.size:
            self.fail(f"{field} is truncated")
        start = self.cursor
        self.cursor += count * _MATRIX4_F32.size
        result = np.frombuffer(
            self.data,
            dtype="<f4",
            count=count * 16,
            offset=start,
        ).reshape((count, 4, 4))
        result.flags.writeable = False
        return result

    def uint32_vector(self, count: int, field: str) -> np.ndarray:
        if count > self.remaining // _U32.size:
            self.fail(f"{field} is truncated")
        start = self.cursor
        self.cursor += count * _U32.size
        result = np.frombuffer(
            self.data,
            dtype="<u4",
            count=count,
            offset=start,
        )
        result.flags.writeable = False
        return result

    def finish(self) -> None:
        if self.remaining != 0:
            self.fail("payload has trailing bytes")


def _decode_json_value(
    raw: bytes, *, maximum_json_depth: int, label: str, field: str
) -> Any:
    if raw.startswith(b"\xef\xbb\xbf"):
        raise WireError(f"{label}: {field} JSON must not contain a BOM")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WireError(f"{label}: {field} is not valid UTF-8") from exc

    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in items:
            if key in result:
                raise WireError(f"{label}: {field} contains a duplicate key")
            result[key] = item
        return result

    def integer(token: str) -> int:
        value = int(token)
        if abs(value) > MAXIMUM_SAFE_INTEGER:
            raise WireError(f"{label}: {field} contains an unsafe integer")
        return value

    def finite(token: str) -> float:
        value = float(token)
        if not math.isfinite(value):
            raise WireError(f"{label}: {field} contains a non-finite number")
        return value

    try:
        value = json.loads(
            text,
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=finite,
            parse_constant=lambda _token: _raise(
                WireError, f"{label}: {field} contains a non-finite number"
            ),
        )
        validate_json_value(value, maximum_depth=maximum_json_depth)
    except WireError:
        raise
    except (json.JSONDecodeError, JsonTreeError, ValueError) as exc:
        raise WireError(f"{label}: {field} JSON is invalid") from exc
    if _contains_lone_surrogate(value):
        raise WireError(f"{label}: {field} contains a lone surrogate")
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


def _uint32(
    value: Any,
    field: str,
    error_type: type[ConfigurationError] | type[WireError],
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= _MAXIMUM_U32:
        _raise(error_type, f"{field} must fit uint32")
    return value


def _node_id(
    value: Any,
    field: str,
    error_type: type[ConfigurationError] | type[WireError],
) -> int:
    result = _uint32(value, field, error_type)
    if result == _NULL_NODE_ID:
        _raise(error_type, f"{field} is reserved")
    return result


def _semantic_matrix_tensor(value: Any, count: int, field: str) -> np.ndarray:
    if (
        isinstance(value, np.ndarray)
        and value.shape == (count, 4, 4)
        and value.dtype == np.dtype("<f4")
        and value.flags.c_contiguous
        and not value.flags.writeable
    ):
        return value
    try:
        result = np.asarray(value, dtype="<f4", order="C")
    except (TypeError, ValueError, OverflowError) as exc:
        raise ConfigurationError(f"{field} is invalid") from exc
    if count == 0 and result.shape == (0,):
        result = result.reshape((0, 4, 4))
    if result.shape != (count, 4, 4):
        raise ConfigurationError(f"{field} must have shape ({count}, 4, 4)")
    result = result.copy(order="C")
    result.flags.writeable = False
    return result


def _semantic_uint32_vector(value: Any, field: str) -> np.ndarray:
    if isinstance(value, np.ndarray):
        if (
            value.ndim != 1
            or value.dtype != np.dtype("<u4")
            or not value.flags.c_contiguous
        ):
            raise ConfigurationError(
                f"{field} must be a one-dimensional contiguous <u4 array"
            )
        if not value.flags.writeable:
            return value
        result = value.copy(order="C")
        result.flags.writeable = False
        return result
    if not isinstance(value, list):
        raise ConfigurationError(f"{field} must be an array")
    result = np.asarray(
        tuple(
            _node_id(item, "dirty_node_id", ConfigurationError)
            for item in value
        ),
        dtype="<u4",
    )
    result.flags.writeable = False
    return result


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
