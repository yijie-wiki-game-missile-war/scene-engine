"""Display Node/Component publication records for the matrix-native contract.

The product publishes a complete checkpoint baseline and, after that, only
single-target logical commands.  Engine owns the command sequence and source
tick fields that are added at wire-encoding time.
"""

from __future__ import annotations

import math
import re
import struct
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import numpy as np

from .errors import ConfigurationError
from .json_tree import validate_json_value


DISPLAY_CODEC = "scene-engine-display-node@5"
DISPLAY_CHECKPOINT_SCHEMA = "scene-engine-display-checkpoint@5"
DISPLAY_COMMAND_STREAM_SCHEMA = "scene-engine-display-command-stream@5"
DISPLAY_COMMAND_SCHEMA = "scene-engine-node-command@5"
MAXIMUM_NODE_NAME_BYTES = 192
MAXIMUM_PREFAB_ID_BYTES = 192
MAXIMUM_SCENE_NAME_BYTES = 96
MAXIMUM_NODE_DEPTH = 128

_NODE_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_PREFAB_ID = re.compile(r"^[a-z0-9][a-z0-9._@-]*(?:/[a-z0-9][a-z0-9._@-]*)*$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_MATRIX4_F32 = struct.Struct("<16f")
_IDENTITY_MATRIX4_F32 = np.eye(4, dtype="<f4", order="F")
_IDENTITY_MATRIX4_F32.flags.writeable = False
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


@dataclass(frozen=True, slots=True)
class DisplayCatalogIdentity:
    """Exact Arts catalog identities loaded from the Display build artifact."""

    scene_catalog_hash: str
    prefab_catalog_hash: str
    state_schema_hash: str

    def __post_init__(self) -> None:
        for field in self.__dataclass_fields__:
            value = getattr(self, field)
            if not isinstance(value, str) or _HASH.fullmatch(value) is None:
                raise ConfigurationError(f"{field} must be a lowercase SHA-256")

    @classmethod
    def from_record(cls, value: Mapping[str, Any]) -> "DisplayCatalogIdentity":
        if not isinstance(value, Mapping) or set(value) != {
            "scene_catalog_hash",
            "prefab_catalog_hash",
            "state_schema_hash",
        }:
            raise ConfigurationError("display catalog identity fields are invalid")
        return cls(
            scene_catalog_hash=value["scene_catalog_hash"],
            prefab_catalog_hash=value["prefab_catalog_hash"],
            state_schema_hash=value["state_schema_hash"],
        )

    def to_record(self) -> dict[str, str]:
        return {
            "scene_catalog_hash": self.scene_catalog_hash,
            "prefab_catalog_hash": self.prefab_catalog_hash,
            "state_schema_hash": self.state_schema_hash,
        }


@dataclass(frozen=True, slots=True, init=False, eq=False)
class DisplayTransform:
    """One immutable NumPy-owned column-major binary32 local matrix."""

    _matrix: np.ndarray

    def __init__(
        self,
        *,
        matrix_bytes: bytes,
    ) -> None:
        if not isinstance(matrix_bytes, bytes) or len(matrix_bytes) != _MATRIX4_F32.size:
            raise ConfigurationError(
                "transform matrix_bytes must contain exactly 64 bytes"
            )
        matrix = (
            np.frombuffer(matrix_bytes, dtype="<f4")
            .reshape((4, 4), order="F")
            .copy(order="F")
        )
        matrix.flags.writeable = False
        object.__setattr__(self, "_matrix", matrix)

    @classmethod
    def from_matrix(cls, matrix: Sequence[float]) -> "DisplayTransform":
        """Pack exactly sixteen values once as opaque little-endian binary32 bits."""

        return cls(matrix_bytes=_pack_matrix_bytes(matrix))

    @classmethod
    def identity(cls) -> "DisplayTransform":
        matrix = _IDENTITY_MATRIX4_F32.copy(order="F")
        matrix.flags.writeable = False
        instance = object.__new__(cls)
        object.__setattr__(instance, "_matrix", matrix)
        return instance

    @classmethod
    def from_trs(
        cls,
        position: Sequence[float] = (0, 0, 0),
        rotation_xyzw: Sequence[float] = (0, 0, 0, 1),
        scale: Sequence[float] = (1, 1, 1),
    ) -> "DisplayTransform":
        """Build one binary32 matrix from a transient TRS description."""

        px, py, pz = _finite_vector(position, 3, "position")
        x, y, z, w = _normalized_vector(
            rotation_xyzw,
            4,
            "rotation_xyzw",
            "rotation_xyzw must not be the zero quaternion",
        )
        sx, sy, sz = _positive_vector(scale, "scale")
        x2 = x + x
        y2 = y + y
        z2 = z + z
        xx = x * x2
        xy = x * y2
        xz = x * z2
        yy = y * y2
        yz = y * z2
        zz = z * z2
        wx = w * x2
        wy = w * y2
        wz = w * z2
        return cls.from_matrix(
            (
                (1 - (yy + zz)) * sx,
                (xy + wz) * sx,
                (xz - wy) * sx,
                0,
                (xy - wz) * sy,
                (1 - (xx + zz)) * sy,
                (yz + wx) * sy,
                0,
                (xz + wy) * sz,
                (yz - wx) * sz,
                (1 - (xx + yy)) * sz,
                0,
                px,
                py,
                pz,
                1,
            )
        )

    @classmethod
    def from_record(cls, value: Any) -> "DisplayTransform":
        return cls.from_matrix(value)

    @property
    def matrix(self) -> tuple[float, ...]:
        return _MATRIX4_F32.unpack(self._matrix_buffer())

    @property
    def matrix_bytes(self) -> bytes:
        return self._matrix_buffer().tobytes()

    def _matrix_buffer(self) -> np.ndarray:
        """Return a read-only C-contiguous view of the column-major bytes."""

        return self._matrix.T

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, DisplayTransform):
            return NotImplemented
        return bool(
            np.array_equal(
                self._matrix.view("<u4"),
                other._matrix.view("<u4"),
            )
        )

    def __hash__(self) -> int:
        return hash(self.matrix_bytes)

    def __copy__(self) -> "DisplayTransform":
        return self

    def __deepcopy__(self, _memo: dict[int, Any]) -> "DisplayTransform":
        return self

    def __reduce__(self) -> tuple[Any, tuple[bytes]]:
        return (_restore_display_transform, (self.matrix_bytes,))

    def to_record(self) -> list[float]:
        return list(self.matrix)

    def composed(self, local: "DisplayTransform") -> "DisplayTransform":
        """Return ``self * local`` for column-vector hierarchy composition."""

        if not isinstance(local, DisplayTransform):
            raise ConfigurationError("local must be DisplayTransform")
        with np.errstate(over="ignore", invalid="ignore"):
            result = self._matrix.astype(np.float64) @ local._matrix.astype(
                np.float64
            )
        return DisplayTransform._from_float64_matrix(result)

    def with_translation(self, position: Sequence[float]) -> "DisplayTransform":
        """Return a copy with its parent-space translation replaced."""

        px, py, pz = _finite_vector(position, 3, "position")
        matrix = list(self.matrix)
        matrix[12:15] = (px, py, pz)
        return DisplayTransform.from_matrix(matrix)

    def with_scale(self, scale: Sequence[float]) -> "DisplayTransform":
        """Set positive basis-column lengths while retaining their directions."""

        targets = _positive_vector(scale, "scale")
        matrix = list(self.matrix)
        for column, target in enumerate(targets):
            offset = column * 4
            length = math.hypot(*matrix[offset : offset + 3])
            if not math.isfinite(length) or length == 0:
                raise ConfigurationError("transform basis column must be nonzero")
            for row in range(3):
                matrix[offset + row] = matrix[offset + row] / length * target
        return DisplayTransform.from_matrix(matrix)

    def translated_self(self, offset: Sequence[float]) -> "DisplayTransform":
        """Translate along this matrix's own basis (``basis * offset``)."""

        x, y, z = _finite_vector(offset, 3, "offset")
        matrix = list(self.matrix)
        matrix[12] += matrix[0] * x + matrix[4] * y + matrix[8] * z
        matrix[13] += matrix[1] * x + matrix[5] * y + matrix[9] * z
        matrix[14] += matrix[2] * x + matrix[6] * y + matrix[10] * z
        return DisplayTransform.from_matrix(matrix)

    def translated_parent(self, offset: Sequence[float]) -> "DisplayTransform":
        """Translate directly in the matrix's parent coordinate space."""

        x, y, z = _finite_vector(offset, 3, "offset")
        matrix = list(self.matrix)
        matrix[12] += x
        matrix[13] += y
        matrix[14] += z
        return DisplayTransform.from_matrix(matrix)

    def rotated_self(
        self, axis: Sequence[float], radians: float
    ) -> "DisplayTransform":
        """Right-multiply the basis by an axis-angle rotation."""

        rotation = np.asarray(
            _axis_angle_basis(axis, radians),
            dtype=np.float64,
        ).reshape((3, 3), order="F")
        matrix = self._matrix.astype(np.float64, order="F")
        with np.errstate(over="ignore", invalid="ignore"):
            matrix[:3, :3] = matrix[:3, :3] @ rotation
        return DisplayTransform._from_float64_matrix(matrix)

    def rotated_parent(
        self, axis: Sequence[float], radians: float
    ) -> "DisplayTransform":
        """Left-multiply the basis by an axis-angle rotation."""

        rotation = np.asarray(
            _axis_angle_basis(axis, radians),
            dtype=np.float64,
        ).reshape((3, 3), order="F")
        matrix = self._matrix.astype(np.float64, order="F")
        with np.errstate(over="ignore", invalid="ignore"):
            matrix[:3, :3] = rotation @ matrix[:3, :3]
        return DisplayTransform._from_float64_matrix(matrix)

    def scaled_self(self, scale: Sequence[float]) -> "DisplayTransform":
        """Right-multiply the basis by a positive diagonal scale."""

        sx, sy, sz = _positive_vector(scale, "scale")
        matrix = list(self.matrix)
        for column, factor in enumerate((sx, sy, sz)):
            offset = column * 4
            for row in range(3):
                matrix[offset + row] *= factor
        return DisplayTransform.from_matrix(matrix)

    def scaled_parent(self, scale: Sequence[float]) -> "DisplayTransform":
        """Left-multiply the basis by a positive diagonal scale."""

        sx, sy, sz = _positive_vector(scale, "scale")
        matrix = list(self.matrix)
        for column in range(3):
            offset = column * 4
            matrix[offset] *= sx
            matrix[offset + 1] *= sy
            matrix[offset + 2] *= sz
        return DisplayTransform.from_matrix(matrix)

    def transform_point(self, point: Sequence[float]) -> tuple[float, float, float]:
        """Transform a point with homogeneous ``w=1``."""

        x, y, z = _finite_vector(point, 3, "point")
        matrix = self.matrix
        return _finite_tuple3(
            matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
            matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
            matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
        )

    def inverse_transform_point(
        self, point: Sequence[float]
    ) -> tuple[float, float, float]:
        """Transform a parent-space point into this matrix's local space."""

        x, y, z = _finite_vector(point, 3, "point")
        matrix = self.matrix
        return _inverse_transform_vector(
            matrix,
            (x - matrix[12], y - matrix[13], z - matrix[14]),
        )

    def transform_vector(
        self, vector: Sequence[float]
    ) -> tuple[float, float, float]:
        """Transform a vector with homogeneous ``w=0``."""

        x, y, z = _finite_vector(vector, 3, "vector")
        matrix = self.matrix
        return _finite_tuple3(
            matrix[0] * x + matrix[4] * y + matrix[8] * z,
            matrix[1] * x + matrix[5] * y + matrix[9] * z,
            matrix[2] * x + matrix[6] * y + matrix[10] * z,
        )

    def inverse_transform_vector(
        self, vector: Sequence[float]
    ) -> tuple[float, float, float]:
        """Apply the inverse linear basis to a parent-space vector."""

        return _inverse_transform_vector(
            self.matrix,
            _finite_vector(vector, 3, "vector"),
        )

    @classmethod
    def _from_float64_matrix(cls, value: np.ndarray) -> "DisplayTransform":
        matrix64 = np.asarray(value, dtype=np.float64)
        if matrix64.shape != (4, 4):
            raise AssertionError("internal transform matrix must have shape (4, 4)")
        with np.errstate(over="ignore", invalid="ignore"):
            matrix32 = matrix64.astype("<f4", order="F")
        if np.isinf(matrix32).any() and np.any(
            np.isfinite(matrix64) & np.isinf(matrix32)
        ):
            raise ConfigurationError(
                "transform must contain sixteen float32-packable values"
            )
        matrix32.flags.writeable = False
        instance = object.__new__(cls)
        object.__setattr__(instance, "_matrix", matrix32)
        return instance


def _restore_display_transform(matrix_bytes: bytes) -> DisplayTransform:
    return DisplayTransform(matrix_bytes=matrix_bytes)


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
        transform: DisplayTransform | Sequence[float],
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
    """One closed logical mutation with exactly one product-owned target.

    Commands are closed records. Product code must use the named constructors so
    an invalid kind/field combination cannot be assembled dynamically. Mutation
    target names are trusted on this Python hot path and validated at decoded
    command boundaries and by the browser Client before Display mutation.
    """

    kind: str
    name: str
    fields: Mapping[str, Any]

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise ConfigurationError(
            "DisplayCommand must be created with a named constructor"
        )

    @classmethod
    def create_node(cls, node: DisplayNode) -> "DisplayCommand":
        if not isinstance(node, DisplayNode):
            raise ConfigurationError("node-create requires DisplayNode")
        return _new_display_command(
            kind="node-create",
            name=node.name,
            parent_name=node.parent_name,
            prefab_id=node.prefab_id,
            transform_mode=node.transform_mode,
            transform=node.transform,
            visible=node.visible,
            state=node.state,
        )

    @classmethod
    def set_transform(
        cls, name: str, transform: DisplayTransform | Sequence[float]
    ) -> "DisplayCommand":
        return _new_display_command(
            kind="node-set-transform", name=name, transform=transform
        )

    @classmethod
    def set_parent(cls, name: str, parent_name: str | None) -> "DisplayCommand":
        return _new_display_command(
            kind="node-set-parent", name=name, parent_name=parent_name
        )

    @classmethod
    def set_visible(cls, name: str, visible: bool) -> "DisplayCommand":
        return _new_display_command(
            kind="node-set-visible", name=name, visible=visible
        )

    @classmethod
    def set_state(cls, name: str, state: Mapping[str, Any]) -> "DisplayCommand":
        return _new_display_command(kind="node-set-state", name=name, state=state)

    @classmethod
    def replace_prefab(
        cls, name: str, prefab_id: str, state: Mapping[str, Any]
    ) -> "DisplayCommand":
        return _new_display_command(
            kind="node-replace-prefab",
            name=name,
            prefab_id=prefab_id,
            state=state,
        )

    @classmethod
    def remove(cls, name: str) -> "DisplayCommand":
        return _new_display_command(kind="node-remove", name=name)

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


@dataclass(frozen=True, slots=True)
class ValidatedDisplayCheckpoint:
    """Typed seal for a parent-first Display checkpoint."""

    scene_name: str
    catalog: DisplayCatalogIdentity
    last_command_seq: int
    nodes: tuple[DisplayNode, ...]
    maximum_json_depth: int

    def __post_init__(self) -> None:
        _scene_name(self.scene_name)
        if not isinstance(self.catalog, DisplayCatalogIdentity):
            raise ConfigurationError("catalog must be DisplayCatalogIdentity")
        _safe_integer(self.last_command_seq, "last_command_seq")
        if (
            not isinstance(self.nodes, tuple)
            or _ordered_baseline(self.nodes) != self.nodes
        ):
            raise ConfigurationError("validated display checkpoint nodes are invalid")
        expected_depth = max(
            (_maximum_json_depth(node.state) for node in self.nodes),
            default=0,
        )
        if (
            isinstance(self.maximum_json_depth, bool)
            or not isinstance(self.maximum_json_depth, int)
            or self.maximum_json_depth != expected_depth
        ):
            raise ConfigurationError("validated display checkpoint depth is invalid")

    def to_record(self) -> dict[str, Any]:
        return {
            "schema": DISPLAY_CHECKPOINT_SCHEMA,
            "scene_name": self.scene_name,
            **self.catalog.to_record(),
            "last_command_seq": self.last_command_seq,
            "nodes": [node.to_record() for node in self.nodes],
        }


@dataclass(frozen=True, slots=True)
class ValidatedDisplayCommandStream:
    """Typed seal retaining validated commands and their matrix owners."""

    base_command_seq: int
    source_tick: int
    last_command_seq: int
    commands: tuple[DisplayCommand, ...]
    maximum_json_depth: int

    def __post_init__(self) -> None:
        _safe_integer(self.base_command_seq, "base_command_seq")
        _safe_integer(self.source_tick, "source_tick")
        _safe_integer(self.last_command_seq, "last_command_seq")
        normalized = _logical_commands(self.commands)
        if normalized != self.commands:
            raise ConfigurationError("validated display command stream is invalid")
        if self.last_command_seq != self.base_command_seq + len(self.commands):
            raise ConfigurationError("validated display command stream cursor is invalid")
        expected_depth = max(
            (_command_json_depth(command) for command in self.commands),
            default=0,
        )
        if (
            isinstance(self.maximum_json_depth, bool)
            or not isinstance(self.maximum_json_depth, int)
            or self.maximum_json_depth != expected_depth
        ):
            raise ConfigurationError("validated display command stream depth is invalid")

    def to_record(self) -> dict[str, Any]:
        return {
            "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
            "base_command_seq": self.base_command_seq,
            "last_command_seq": self.last_command_seq,
            "commands": [
                command.to_record(
                    command_seq=self.base_command_seq + ordinal,
                    source_tick=self.source_tick,
                )
                for ordinal, command in enumerate(self.commands, 1)
            ],
        }


def _new_display_command(*, kind: str, name: str, **fields: Any) -> DisplayCommand:
    if kind not in _COMMAND_KINDS:
        raise ConfigurationError("display command kind is invalid")
    if not isinstance(name, str):
        raise ConfigurationError("display command target name must be a string")
    normalized = _normalize_command_fields(kind, name, fields)
    command = object.__new__(DisplayCommand)
    object.__setattr__(command, "kind", kind)
    object.__setattr__(command, "name", name)
    object.__setattr__(command, "fields", _freeze(normalized))
    return command


def encode_display_checkpoint(
    *,
    scene_name: str,
    catalog: DisplayCatalogIdentity,
    last_command_seq: int,
    nodes: Sequence[DisplayNode],
) -> ValidatedDisplayCheckpoint:
    """Build the typed baseline consumed by the binary Wire codec."""

    _scene_name(scene_name)
    if not isinstance(catalog, DisplayCatalogIdentity):
        raise ConfigurationError("catalog must be DisplayCatalogIdentity")
    _safe_integer(last_command_seq, "last_command_seq")
    normalized_nodes = _ordered_baseline(nodes)
    return ValidatedDisplayCheckpoint(
        scene_name=scene_name,
        catalog=catalog,
        last_command_seq=last_command_seq,
        nodes=normalized_nodes,
        maximum_json_depth=max(
            (_maximum_json_depth(node.state) for node in normalized_nodes),
            default=0,
        ),
    )


def validate_display_nodes(nodes: Sequence[DisplayNode]) -> tuple[DisplayNode, ...]:
    """Validate and own a parent-before-child authority checkpoint baseline."""

    return _ordered_baseline(nodes)


def encode_display_command_stream(
    *,
    base_command_seq: int,
    source_tick: int,
    commands: Sequence[DisplayCommand],
) -> tuple[ValidatedDisplayCommandStream, int]:
    """Assign strict stream-global sequence numbers to logical commands."""

    _safe_integer(base_command_seq, "base_command_seq")
    _safe_integer(source_tick, "source_tick")
    normalized = _logical_commands(commands)
    cursor = base_command_seq + len(normalized)
    if cursor > (1 << 53) - 1:
        raise ConfigurationError("last_command_seq must be a non-negative safe integer")
    maximum_json_depth = max(
        (_command_json_depth(command) for command in normalized),
        default=0,
    )
    return (
        ValidatedDisplayCommandStream(
            base_command_seq=base_command_seq,
            source_tick=source_tick,
            last_command_seq=cursor,
            commands=normalized,
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
    _authority_name(value["name"], "name")
    return _new_display_command(
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
        return {
            "parent_name": node.parent_name,
            "prefab_id": node.prefab_id,
            "transform_mode": node.transform_mode,
            "transform": node.transform,
            "visible": node.visible,
            "state": node.state,
        }
    if kind == "node-set-transform":
        if actual != {"transform"}:
            raise ConfigurationError("node-set-transform fields are invalid")
        value = fields["transform"]
        transform = (
            value
            if isinstance(value, DisplayTransform)
            else DisplayTransform.from_record(value)
        )
        return {"transform": transform}
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


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigurationError(f"{field} must be a finite number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ConfigurationError(f"{field} must be a finite number") from exc
    if not math.isfinite(number):
        raise ConfigurationError(f"{field} must be a finite number")
    return number


def _finite_vector(value: Any, length: int, field: str) -> tuple[float, ...]:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes, bytearray, memoryview))
        or len(value) != length
    ):
        raise ConfigurationError(
            f"{field} must contain exactly {length} finite numbers"
        )
    try:
        return tuple(_finite_number(item, field) for item in value)
    except ConfigurationError as exc:
        raise ConfigurationError(
            f"{field} must contain exactly {length} finite numbers"
        ) from exc


def _positive_vector(value: Any, field: str) -> tuple[float, float, float]:
    x, y, z = _finite_vector(value, 3, field)
    if x <= 0 or y <= 0 or z <= 0:
        raise ConfigurationError(f"{field} components must be greater than zero")
    return x, y, z


def _normalized_vector(
    value: Any,
    length: int,
    field: str,
    zero_message: str,
) -> tuple[float, ...]:
    vector = _finite_vector(value, length, field)
    maximum = max(abs(item) for item in vector)
    if maximum == 0:
        raise ConfigurationError(zero_message)
    scaled = tuple(item / maximum for item in vector)
    magnitude = math.sqrt(sum(item * item for item in scaled))
    return tuple(item / magnitude for item in scaled)


def _axis_angle_basis(
    axis: Sequence[float], radians: float
) -> tuple[float, ...]:
    x, y, z = _normalized_vector(
        axis,
        3,
        "axis",
        "axis must not be the zero vector",
    )
    angle = _finite_number(radians, "radians")
    cosine = math.cos(angle)
    sine = math.sin(angle)
    remainder = 1 - cosine
    return (
        remainder * x * x + cosine,
        remainder * x * y + sine * z,
        remainder * x * z - sine * y,
        remainder * x * y - sine * z,
        remainder * y * y + cosine,
        remainder * y * z + sine * x,
        remainder * x * z + sine * y,
        remainder * y * z - sine * x,
        remainder * z * z + cosine,
    )


def _finite_tuple3(x: float, y: float, z: float) -> tuple[float, float, float]:
    if not all(math.isfinite(value) for value in (x, y, z)):
        raise ConfigurationError("transform result must contain finite numbers")
    return tuple(0.0 if value == 0 else value for value in (x, y, z))


def _inverse_transform_vector(
    matrix: Sequence[float], vector: Sequence[float]
) -> tuple[float, float, float]:
    a00 = matrix[0]
    a01 = matrix[4]
    a02 = matrix[8]
    a10 = matrix[1]
    a11 = matrix[5]
    a12 = matrix[9]
    a20 = matrix[2]
    a21 = matrix[6]
    a22 = matrix[10]
    inverse00 = a11 * a22 - a12 * a21
    inverse01 = a02 * a21 - a01 * a22
    inverse02 = a01 * a12 - a02 * a11
    inverse10 = a12 * a20 - a10 * a22
    inverse11 = a00 * a22 - a02 * a20
    inverse12 = a02 * a10 - a00 * a12
    inverse20 = a10 * a21 - a11 * a20
    inverse21 = a01 * a20 - a00 * a21
    inverse22 = a00 * a11 - a01 * a10
    determinant = a00 * inverse00 + a01 * inverse10 + a02 * inverse20
    if not math.isfinite(determinant) or determinant <= 0:
        raise ConfigurationError("transform matrix determinant must be greater than zero")
    reciprocal = 1 / determinant
    x, y, z = vector
    return _finite_tuple3(
        (inverse00 * x + inverse01 * y + inverse02 * z) * reciprocal,
        (inverse10 * x + inverse11 * y + inverse12 * z) * reciprocal,
        (inverse20 * x + inverse21 * y + inverse22 * z) * reciprocal,
    )


def _pack_matrix_bytes(value: Any) -> bytes:
    if (
        not isinstance(value, Sequence)
        or isinstance(value, (str, bytes, bytearray, memoryview))
        or len(value) != 16
    ):
        raise ConfigurationError("transform must be a sixteen-value matrix")
    try:
        return _MATRIX4_F32.pack(*value)
    except (OverflowError, struct.error, TypeError) as exc:
        raise ConfigurationError(
            "transform must contain sixteen float32-packable values"
        ) from exc


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
    if isinstance(value, DisplayTransform):
        return value.to_record()
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


def _command_json_depth(command: DisplayCommand) -> int:
    if command.kind in {"node-create", "node-set-state", "node-replace-prefab"}:
        return _maximum_json_depth(command.fields["state"])
    return 0


def _maximum_json_depth(value: Any) -> int:
    if isinstance(value, Mapping):
        return max((_maximum_json_depth(item) + 1 for item in value.values()), default=0)
    if isinstance(value, tuple):
        return max((_maximum_json_depth(item) + 1 for item in value), default=0)
    return 0


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
    "ValidatedDisplayCheckpoint",
    "ValidatedDisplayCommandStream",
    "encode_display_checkpoint",
    "encode_display_command_stream",
    "validate_display_checkpoint",
    "validate_display_command_stream",
    "validate_display_nodes",
]
