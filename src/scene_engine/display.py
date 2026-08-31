"""Display Node/Component publication records for the matrix-native contract.

The product publishes a complete checkpoint baseline and, after that, closed
logical commands.  Engine owns the command sequence and source tick fields
that are added at wire-encoding time.
"""

from __future__ import annotations

import math
import re
import struct
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

import numpy as np

from .errors import ConfigurationError
from .json_tree import validate_json_value


DISPLAY_CODEC = "scene-engine-display-node@8"
DISPLAY_CHECKPOINT_SCHEMA = "scene-engine-display-checkpoint@8"
DISPLAY_COMMAND_STREAM_SCHEMA = "scene-engine-display-command-stream@8"
DISPLAY_COMMAND_SCHEMA = "scene-engine-node-command@8"
MAXIMUM_NODE_ID = 0xFFFFFFFE
NULL_NODE_ID = 0xFFFFFFFF
MAXIMUM_PREFAB_ID_BYTES = 192
MAXIMUM_SCENE_NAME_BYTES = 96
MAXIMUM_PROPERTY_NAME_BYTES = 192
MAXIMUM_EVENT_NAME_BYTES = 192
MAXIMUM_NODE_DEPTH = 128

_NODE_SEGMENT = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_PREFAB_ID = re.compile(r"^[a-z0-9][a-z0-9._@-]*(?:/[a-z0-9][a-z0-9._@-]*)*$")
_HASH = re.compile(r"^[0-9a-f]{64}$")
_MATRIX4_F32 = struct.Struct("<16f")
_IDENTITY_MATRIX4_F32 = np.eye(4, dtype="<f4", order="F")
_IDENTITY_MATRIX4_F32.flags.writeable = False
_EMPTY_EVENT_PAYLOAD: Mapping[str, Any] = MappingProxyType({})
_FORBIDDEN_MESSAGE_NAMES = frozenset(
    {"__proto__", "prototype", "constructor"}
)
_COMMAND_KINDS = frozenset(
    {
        "node-create",
        "node-set-transform-batch",
        "node-set-parent",
        "node-set-visible",
        "node-set-state",
        "node-set-property",
        "node-unset-property",
        "node-emit-event",
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
    def _from_matrix_buffer(cls, value: np.ndarray) -> "DisplayTransform":
        """Copy one trusted pool row without a bytes/frombuffer round trip."""

        matrix = value.T.copy(order="F")
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


@dataclass(slots=True)
class _MatrixPoolPublishToken:
    pool: "DisplayMatrixPool"
    generation: int
    dirty_node_ids: np.ndarray
    dirty_versions: np.ndarray
    publication_node_ids: np.ndarray
    publication_values: np.ndarray
    publication_versions: np.ndarray
    confirmed: bool = False

    def confirm(self) -> None:
        if self.confirmed:
            return
        self.pool._confirm_snapshot(
            self.generation,
            self.dirty_node_ids,
            self.dirty_versions,
            self.publication_node_ids,
            self.publication_values,
            self.publication_versions,
        )
        self.confirmed = True


class DisplayMatrixPool:
    """The sole persistent owner for one stream's authority Matrix4 rows.

    Logical storage has shape ``(n, 4, 4)`` and C order.  Its axes are
    ``[node, column, row]``, so each 64-byte row is the established
    column-major Matrix4 byte sequence.  Node IDs are monotonically appended
    uint32 values; retiring a row zeros it permanently and never reuses it.
    """

    __slots__ = (
        "_capacity",
        "_dirty_ids",
        "_matrices",
        "_pending_created_ids",
        "_pending_retired_ids",
        "_published",
        "_retired",
        "_size",
        "_version",
        "_versions",
    )

    def __init__(self) -> None:
        self._capacity = 0
        self._size = 0
        self._version = 0
        self._matrices = np.empty((0, 4, 4), dtype="<f4", order="C")
        self._dirty_ids: set[int] = set()
        self._pending_created_ids: set[int] = set()
        self._pending_retired_ids: set[int] = set()
        self._published = np.empty(0, dtype=np.bool_)
        self._retired = np.empty(0, dtype=np.bool_)
        self._versions = np.empty(0, dtype=np.uint64)

    def __len__(self) -> int:
        return self._size

    @property
    def size(self) -> int:
        return self._size

    @property
    def _mutation_generation(self) -> int:
        return self._version

    @property
    def matrices(self) -> np.ndarray:
        """Return an isolated read-only logical ``(n, 4, 4)`` snapshot."""

        payload = self._matrices[: self._size].tobytes(order="C")
        return np.frombuffer(payload, dtype="<f4").reshape((self._size, 4, 4))

    def append(
        self,
        transform: DisplayTransform | Sequence[float] | None = None,
    ) -> int:
        """Append one live row and return its never-reused uint32 Node ID."""

        if self._size > MAXIMUM_NODE_ID:
            raise ConfigurationError("display matrix pool exhausted uint32 Node IDs")
        normalized = (
            DisplayTransform.identity()
            if transform is None
            else _display_transform(transform)
        )
        node_id = self._size
        self._ensure_capacity(node_id + 1)
        np.copyto(self._matrices[node_id], normalized._matrix_buffer())
        self._published[node_id] = False
        self._retired[node_id] = False
        self._pending_created_ids.add(node_id)
        self._touch(node_id)
        self._size += 1
        return node_id

    def set(
        self,
        node_id: int,
        transform: DisplayTransform | Sequence[float],
    ) -> None:
        """Replace one live row and mark that Node ID dirty."""

        index = self._require_live(node_id)
        normalized = _display_transform(transform)
        np.copyto(self._matrices[index], normalized._matrix_buffer())
        self._touch(index)

    def set_batch(self, node_ids: Any, matrices: Any) -> None:
        """Replace multiple live rows atomically after validating the full batch."""

        ids = _ordered_batch_node_ids(node_ids, sort=False)
        if (
            not isinstance(matrices, np.ndarray)
            or matrices.shape != (len(ids), 4, 4)
            or matrices.dtype != np.dtype("<f4")
            or not matrices.flags.c_contiguous
        ):
            raise ConfigurationError(
                "matrices must be a contiguous <f4 tensor with shape "
                f"({len(ids)}, 4, 4)"
            )
        indices = ids.astype(np.intp, copy=False)
        if len(ids) and int(ids.max()) >= self._size:
            raise ConfigurationError("node_id is not allocated in the matrix pool")
        if len(ids) and np.any(self._retired[indices]):
            raise ConfigurationError("node_id is retired")

        dirty = {int(node_id) for node_id in ids}
        next_dirty = self._dirty_ids | dirty
        next_version = self._version + 1
        self._matrices.view("<u4")[indices] = matrices.view("<u4")
        self._versions[indices] = next_version
        self._version = next_version
        self._dirty_ids = next_dirty

    def retire(self, node_id: int) -> None:
        """Permanently retire one row, writing an exact all-zero tombstone."""

        index = self._require_live(node_id)
        if not self._published[index]:
            raise ConfigurationError(
                "node_id must be published before its matrix row can be retired"
            )
        self._matrices[index].fill(0.0)
        self._retired[index] = True
        self._pending_retired_ids.add(index)
        self._dirty_ids.discard(index)
        self._version += 1
        self._versions[index] = self._version

    def transform(self, node_id: int) -> DisplayTransform:
        """Return an immutable value snapshot for one live pool row."""

        index = self._require_live(node_id)
        return DisplayTransform._from_matrix_buffer(self._matrices[index])

    def _ensure_capacity(self, required: int) -> None:
        if required <= self._capacity:
            return
        capacity = max(4, required, self._capacity * 2)
        matrices = np.zeros((capacity, 4, 4), dtype="<f4", order="C")
        retired = np.zeros(capacity, dtype=np.bool_)
        published = np.zeros(capacity, dtype=np.bool_)
        versions = np.zeros(capacity, dtype=np.uint64)
        if self._size:
            matrices[: self._size] = self._matrices[: self._size]
            retired[: self._size] = self._retired[: self._size]
            published[: self._size] = self._published[: self._size]
            versions[: self._size] = self._versions[: self._size]
        self._capacity = capacity
        self._matrices = matrices
        self._retired = retired
        self._published = published
        self._versions = versions

    def _touch(self, node_id: int) -> None:
        self._version += 1
        self._versions[node_id] = self._version
        self._dirty_ids.add(node_id)

    def _require_allocated(self, node_id: Any, field: str = "node_id") -> int:
        index = _node_id(node_id, field)
        if index >= self._size:
            raise ConfigurationError(f"{field} is not allocated in the matrix pool")
        return index

    def _require_live(self, node_id: Any, field: str = "node_id") -> int:
        index = self._require_allocated(node_id, field)
        if self._retired[index]:
            raise ConfigurationError(f"{field} is retired in the matrix pool")
        return index

    def _active_node_ids(self) -> tuple[int, ...]:
        return tuple(
            int(index)
            for index in np.flatnonzero(~self._retired[: self._size])
        )

    def _has_pending_changes(self) -> bool:
        return bool(
            self._dirty_ids
            or self._pending_created_ids
            or self._pending_retired_ids
        )

    def _snapshot_full(self) -> tuple[np.ndarray, _MatrixPoolPublishToken]:
        matrix_bytes = self._matrices[: self._size].tobytes(order="C")
        matrices = np.frombuffer(matrix_bytes, dtype="<f4").reshape(
            (self._size, 4, 4)
        )
        node_ids = np.frombuffer(
            np.arange(self._size, dtype="<u4").tobytes(), dtype="<u4"
        )
        versions = self._versions[: self._size].copy()
        versions.flags.writeable = False
        publication_values = (~self._retired[: self._size]).copy()
        publication_values.flags.writeable = False
        return matrices, _MatrixPoolPublishToken(
            self,
            self._version,
            node_ids,
            versions,
            node_ids,
            publication_values,
            versions,
        )

    def _snapshot_dirty(
        self,
        expected_node_ids: Sequence[int],
        publication_updates: Sequence[tuple[int, bool]],
    ) -> tuple[np.ndarray, np.ndarray, _MatrixPoolPublishToken]:
        expected = np.asarray(expected_node_ids, dtype="<u4", order="C")
        if len(self._dirty_ids) != len(expected) or any(
            int(node_id) not in self._dirty_ids for node_id in expected
        ):
            raise ConfigurationError(
                "dirty matrix Node IDs must exactly match create/transform batch targets"
            )
        matrices_bytes = self._matrices[expected].tobytes(order="C")
        node_ids = np.frombuffer(expected.tobytes(), dtype="<u4")
        matrices = np.frombuffer(matrices_bytes, dtype="<f4").reshape(
            (len(expected), 4, 4)
        )
        versions = self._versions[node_ids].copy()
        versions.flags.writeable = False
        mutable_publication_node_ids = np.asarray(
            [node_id for node_id, _value in publication_updates], dtype="<u4"
        )
        publication_node_ids = np.frombuffer(
            mutable_publication_node_ids.tobytes(), dtype="<u4"
        )
        publication_values = np.frombuffer(
            np.asarray(
                [value for _node_id, value in publication_updates], dtype=np.bool_
            ).tobytes(),
            dtype=np.bool_,
        )
        publication_versions = self._versions[publication_node_ids].copy()
        publication_versions.flags.writeable = False
        return (
            node_ids,
            matrices,
            _MatrixPoolPublishToken(
                self,
                self._version,
                node_ids,
                versions,
                publication_node_ids,
                publication_values,
                publication_versions,
            ),
        )

    def _confirm_snapshot(
        self,
        generation: int,
        dirty_node_ids: np.ndarray,
        dirty_versions: np.ndarray,
        publication_node_ids: np.ndarray,
        publication_values: np.ndarray,
        publication_versions: np.ndarray,
    ) -> None:
        if self._version != generation:
            raise ConfigurationError(
                "display matrix pool changed after its packet snapshot was sealed"
            )
        # A seal snapshots the complete dirty/create/remove sets.  The global
        # generation check above proves that none of those rows changed after
        # sealing, so confirmation can drain the batch without per-ID version
        # checks or hash-table discards.
        self._dirty_ids.clear()
        if len(publication_node_ids):
            self._published[publication_node_ids] = publication_values
        self._pending_created_ids.clear()
        self._pending_retired_ids.clear()

    def _validate_command_lifecycle(
        self, commands: Sequence["DisplayCommand"]
    ) -> tuple[tuple[tuple[int, bool], ...], np.ndarray, int]:
        active: dict[int, bool] = {}
        updates: list[tuple[int, bool]] = []
        create_targets: set[int] = set()
        remove_targets: set[int] = set()
        transform_batch_ids: np.ndarray | None = None
        maximum_json_depth = 0

        def is_active(node_id: int) -> bool:
            return active.get(node_id, bool(self._published[node_id]))

        transform_batch_seen = False
        for command in commands:
            if command.kind == "node-set-transform-batch":
                if transform_batch_seen:
                    raise ConfigurationError(
                        "display command stream may contain at most one transform batch"
                    )
                transform_batch_seen = True
                assert command.node_ids is not None
                transform_batch_ids = command.node_ids
                if int(transform_batch_ids[-1]) >= self._size:
                    raise ConfigurationError(
                        "node_id is not allocated in the matrix pool"
                    )
                indices = transform_batch_ids.astype(np.intp, copy=False)
                if bool(
                    np.any(~self._published[indices])
                    or np.any(self._retired[indices])
                ):
                    raise ConfigurationError(
                        "node-set-transform-batch targets a Node ID that is not active"
                    )
                continue
            assert command.node_id is not None
            node_id = self._require_allocated(command.node_id)
            if command.kind == "node-create":
                if node_id not in self._pending_created_ids or is_active(node_id):
                    raise ConfigurationError(
                        "node-create must target a newly appended unpublished Node ID"
                    )
                parent = command.fields["parent_node_id"]
                if parent is not None:
                    parent = self._require_allocated(parent, "parent_node_id")
                    if not is_active(parent) or self._retired[parent]:
                        raise ConfigurationError("node-create parent is not active")
                active[node_id] = True
                create_targets.add(node_id)
                maximum_json_depth = max(
                    maximum_json_depth,
                    _maximum_json_depth(command.fields["state"]),
                )
                updates.append((node_id, True))
                continue
            if not is_active(node_id):
                raise ConfigurationError(
                    f"{command.kind} targets a Node ID that is not active"
                )
            if command.kind == "node-remove":
                if node_id not in self._pending_retired_ids:
                    raise ConfigurationError(
                        "node-remove must target a just-retired active Node ID"
                    )
                active[node_id] = False
                remove_targets.add(node_id)
                updates.append((node_id, False))
                continue
            if self._retired[node_id]:
                raise ConfigurationError(
                    f"{command.kind} targets a retired Node ID"
                )
            if command.kind == "node-set-parent":
                parent = command.fields["parent_node_id"]
                if parent is not None:
                    parent = self._require_allocated(parent, "parent_node_id")
                    if not is_active(parent) or self._retired[parent]:
                        raise ConfigurationError("node-set-parent parent is not active")
            elif command.kind in {"node-set-state", "node-replace-prefab"}:
                maximum_json_depth = max(
                    maximum_json_depth,
                    _maximum_json_depth(command.fields["state"]),
                )
            elif command.kind == "node-set-property":
                maximum_json_depth = max(
                    maximum_json_depth,
                    _maximum_json_depth(command.fields["value"]),
                )
            elif command.kind == "node-emit-event":
                maximum_json_depth = max(
                    maximum_json_depth,
                    _maximum_json_depth(command.fields["payload"]),
                )
        if create_targets != self._pending_created_ids:
            raise ConfigurationError(
                "node-create commands must exactly match newly appended Node IDs"
            )
        if remove_targets != self._pending_retired_ids:
            raise ConfigurationError(
                "node-remove commands must exactly match just-retired Node IDs"
            )
        created = np.asarray(sorted(create_targets), dtype="<u4")
        if transform_batch_ids is None:
            expected_dirty = created
        elif len(created):
            expected_dirty = np.concatenate((transform_batch_ids, created))
        else:
            expected_dirty = transform_batch_ids
        return tuple(updates), expected_dirty, maximum_json_depth


def _display_transform(
    value: DisplayTransform | Sequence[float],
) -> DisplayTransform:
    return (
        value if isinstance(value, DisplayTransform) else DisplayTransform.from_record(value)
    )


@dataclass(frozen=True, slots=True, init=False)
class DisplayNode:
    """One Python-owned authority root in a checkpoint baseline."""

    node_id: int
    parent_node_id: int | None
    prefab_id: str
    transform_mode: str
    visible: bool
    state: Mapping[str, Any]

    def __init__(
        self,
        *,
        node_id: int,
        parent_node_id: int | None,
        prefab_id: str,
        transform_mode: str,
        visible: bool,
        state: Mapping[str, Any],
    ) -> None:
        normalized_node_id = _node_id(node_id, "node_id")
        normalized_parent_id = _nullable_node_id(parent_node_id, "parent_node_id")
        if normalized_parent_id is not None:
            if normalized_parent_id == normalized_node_id:
                raise ConfigurationError("authority Node cannot parent itself")
        _prefab_id(prefab_id)
        if transform_mode not in {"initial", "live"}:
            raise ConfigurationError("transform_mode must be initial or live")
        if not isinstance(visible, bool):
            raise ConfigurationError("visible must be boolean")
        normalized_state = _plain_state(state)
        object.__setattr__(self, "node_id", normalized_node_id)
        object.__setattr__(self, "parent_node_id", normalized_parent_id)
        object.__setattr__(self, "prefab_id", prefab_id)
        object.__setattr__(self, "transform_mode", transform_mode)
        object.__setattr__(self, "visible", visible)
        object.__setattr__(self, "state", normalized_state)

    def to_record(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "parent_node_id": self.parent_node_id,
            "prefab_id": self.prefab_id,
            "transform_mode": self.transform_mode,
            "visible": self.visible,
            "state": _thaw(self.state),
        }


@dataclass(frozen=True, slots=True, init=False, eq=False)
class DisplayCommand:
    """One closed logical mutation targeting stream-stable uint32 Node IDs."""

    kind: str
    node_id: int | None
    node_ids: np.ndarray | None
    fields: Mapping[str, Any]

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise ConfigurationError(
            "DisplayCommand must be created with a named constructor"
        )

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, DisplayCommand):
            return NotImplemented
        if self.node_ids is None or other.node_ids is None:
            node_ids_equal = self.node_ids is other.node_ids
        else:
            node_ids_equal = bool(np.array_equal(self.node_ids, other.node_ids))
        return (
            self.kind == other.kind
            and self.node_id == other.node_id
            and node_ids_equal
            and self.fields == other.fields
        )

    @classmethod
    def create_node(cls, node: DisplayNode) -> "DisplayCommand":
        if not isinstance(node, DisplayNode):
            raise ConfigurationError("node-create requires DisplayNode")
        return _new_display_command(
            kind="node-create",
            node_id=node.node_id,
            parent_node_id=node.parent_node_id,
            prefab_id=node.prefab_id,
            transform_mode=node.transform_mode,
            visible=node.visible,
            state=node.state,
        )

    @classmethod
    def set_transform_batch(cls, node_ids: Any) -> "DisplayCommand":
        return _new_display_transform_batch_command(node_ids)

    @classmethod
    def set_parent(
        cls, node_id: int, parent_node_id: int | None
    ) -> "DisplayCommand":
        return _new_display_command(
            kind="node-set-parent",
            node_id=node_id,
            parent_node_id=parent_node_id,
        )

    @classmethod
    def set_visible(cls, node_id: int, visible: bool) -> "DisplayCommand":
        return _new_display_command(
            kind="node-set-visible", node_id=node_id, visible=visible
        )

    @classmethod
    def set_state(cls, node_id: int, state: Mapping[str, Any]) -> "DisplayCommand":
        return _new_display_command(
            kind="node-set-state", node_id=node_id, state=state
        )

    @classmethod
    def set_property(
        cls, node_id: int, property_name: str, value: Any
    ) -> "DisplayCommand":
        """Replace one top-level authority-state property with a JSON value."""

        return _new_display_command(
            kind="node-set-property",
            node_id=node_id,
            property_name=property_name,
            value=value,
        )

    @classmethod
    def unset_property(cls, node_id: int, property_name: str) -> "DisplayCommand":
        """Remove one top-level authority-state property."""

        return _new_display_command(
            kind="node-unset-property",
            node_id=node_id,
            property_name=property_name,
        )

    @classmethod
    def emit_event(
        cls,
        node_id: int,
        event_name: str,
        payload: Mapping[str, Any] = _EMPTY_EVENT_PAYLOAD,
    ) -> "DisplayCommand":
        """Publish one transient, ordered event for an authority Node."""

        return _new_display_command(
            kind="node-emit-event",
            node_id=node_id,
            event_name=event_name,
            payload=payload,
        )

    @classmethod
    def replace_prefab(
        cls, node_id: int, prefab_id: str, state: Mapping[str, Any]
    ) -> "DisplayCommand":
        return _new_display_command(
            kind="node-replace-prefab",
            node_id=node_id,
            prefab_id=prefab_id,
            state=state,
        )

    @classmethod
    def remove(cls, node_id: int) -> "DisplayCommand":
        return _new_display_command(kind="node-remove", node_id=node_id)

    def to_record(self, *, command_seq: int, source_tick: int) -> dict[str, Any]:
        _safe_integer(command_seq, "command_seq")
        _safe_integer(source_tick, "source_tick")
        common = {
            "schema": DISPLAY_COMMAND_SCHEMA,
            "command_seq": command_seq,
            "source_tick": source_tick,
            "kind": self.kind,
        }
        if self.kind == "node-set-transform-batch":
            assert self.node_ids is not None
            return {**common, "node_ids": self.node_ids.tolist()}
        assert self.node_id is not None
        return {**common, "node_id": self.node_id, **_thaw(self.fields)}


@dataclass(frozen=True, slots=True, eq=False)
class ValidatedDisplayCheckpoint:
    """Typed seal owning one full, immutable MatrixPool snapshot."""

    scene_name: str
    catalog: DisplayCatalogIdentity
    last_command_seq: int
    matrix_pool_size: int
    matrix_pool: np.ndarray
    nodes: tuple[DisplayNode, ...]
    maximum_json_depth: int
    _publish_token: _MatrixPoolPublishToken

    def __post_init__(self) -> None:
        _scene_name(self.scene_name)
        if not isinstance(self.catalog, DisplayCatalogIdentity):
            raise ConfigurationError("catalog must be DisplayCatalogIdentity")
        _safe_integer(self.last_command_seq, "last_command_seq")
        _validate_matrix_tensor(
            self.matrix_pool, self.matrix_pool_size, "matrix_pool"
        )
        normalized = _ordered_baseline(self.nodes)
        if normalized != self.nodes:
            raise ConfigurationError("validated display checkpoint nodes are invalid")
        _validate_baseline_pool(self.nodes, self.matrix_pool, self.matrix_pool_size)
        _validate_maximum_depth(self.maximum_json_depth, self.nodes)

    def confirm_published(self) -> None:
        self._publish_token.confirm()

    def to_record(self) -> dict[str, Any]:
        return {
            "schema": DISPLAY_CHECKPOINT_SCHEMA,
            "scene_name": self.scene_name,
            **self.catalog.to_record(),
            "last_command_seq": self.last_command_seq,
            "matrix_pool_size": self.matrix_pool_size,
            "matrix_pool": self.matrix_pool.tolist(),
            "nodes": [node.to_record() for node in self.nodes],
        }


@dataclass(frozen=True, slots=True, eq=False)
class ValidatedDisplayCommandStream:
    """Typed seal owning one immutable dirty MatrixPool gather."""

    base_command_seq: int
    source_tick: int
    last_command_seq: int
    matrix_pool_size: int
    dirty_node_ids: np.ndarray
    dirty_matrices: np.ndarray
    commands: tuple[DisplayCommand, ...]
    maximum_json_depth: int
    _publish_token: _MatrixPoolPublishToken

    def __post_init__(self) -> None:
        _safe_integer(self.base_command_seq, "base_command_seq")
        _safe_integer(self.source_tick, "source_tick")
        _safe_integer(self.last_command_seq, "last_command_seq")
        _pool_size(self.matrix_pool_size)
        normalized = _logical_commands(self.commands)
        if normalized != self.commands:
            raise ConfigurationError("validated display command stream is invalid")
        if self.last_command_seq != self.base_command_seq + len(self.commands):
            raise ConfigurationError("validated display command stream cursor is invalid")
        _validate_dirty_batch(
            self.dirty_node_ids,
            self.dirty_matrices,
            self.matrix_pool_size,
            self.commands,
        )
        _validate_maximum_depth(self.maximum_json_depth, self.commands)

    def confirm_published(self) -> None:
        self._publish_token.confirm()

    @property
    def transform_batch_matrices(self) -> np.ndarray | None:
        """Return the batch's aligned read-only matrix view without another copy."""

        for command in self.commands:
            if command.kind == "node-set-transform-batch":
                assert command.node_ids is not None
                return self.dirty_matrices[: len(command.node_ids)]
        return None

    def to_record(self) -> dict[str, Any]:
        return {
            "schema": DISPLAY_COMMAND_STREAM_SCHEMA,
            "base_command_seq": self.base_command_seq,
            "last_command_seq": self.last_command_seq,
            "matrix_pool_size": self.matrix_pool_size,
            "dirty_node_ids": self.dirty_node_ids.tolist(),
            "dirty_matrices": self.dirty_matrices.tolist(),
            "commands": [
                command.to_record(
                    command_seq=self.base_command_seq + ordinal,
                    source_tick=self.source_tick,
                )
                for ordinal, command in enumerate(self.commands, 1)
            ],
        }


def _new_validated_display_command_stream(
    *,
    base_command_seq: int,
    source_tick: int,
    last_command_seq: int,
    matrix_pool_size: int,
    dirty_node_ids: np.ndarray,
    dirty_matrices: np.ndarray,
    commands: tuple[DisplayCommand, ...],
    maximum_json_depth: int,
    publish_token: _MatrixPoolPublishToken,
) -> ValidatedDisplayCommandStream:
    """Build a seal from parts already validated by the publication factory."""

    result = object.__new__(ValidatedDisplayCommandStream)
    object.__setattr__(result, "base_command_seq", base_command_seq)
    object.__setattr__(result, "source_tick", source_tick)
    object.__setattr__(result, "last_command_seq", last_command_seq)
    object.__setattr__(result, "matrix_pool_size", matrix_pool_size)
    object.__setattr__(result, "dirty_node_ids", dirty_node_ids)
    object.__setattr__(result, "dirty_matrices", dirty_matrices)
    object.__setattr__(result, "commands", commands)
    object.__setattr__(result, "maximum_json_depth", maximum_json_depth)
    object.__setattr__(result, "_publish_token", publish_token)
    return result


def _new_display_command(
    *, kind: str, node_id: int, **fields: Any
) -> DisplayCommand:
    if kind not in _COMMAND_KINDS:
        raise ConfigurationError("display command kind is invalid")
    normalized_node_id = _node_id(node_id, "node_id")
    normalized = _normalize_command_fields(kind, normalized_node_id, fields)
    command = object.__new__(DisplayCommand)
    object.__setattr__(command, "kind", kind)
    object.__setattr__(command, "node_id", normalized_node_id)
    object.__setattr__(command, "node_ids", None)
    object.__setattr__(command, "fields", _freeze(normalized))
    return command


def _new_display_transform_batch_command(node_ids: Any) -> DisplayCommand:
    normalized = _ordered_batch_node_ids(node_ids, sort=True)
    command = object.__new__(DisplayCommand)
    object.__setattr__(command, "kind", "node-set-transform-batch")
    object.__setattr__(command, "node_id", None)
    object.__setattr__(command, "node_ids", normalized)
    object.__setattr__(command, "fields", MappingProxyType({}))
    return command


def encode_display_checkpoint(
    *,
    scene_name: str,
    catalog: DisplayCatalogIdentity,
    last_command_seq: int,
    matrix_pool: DisplayMatrixPool,
    nodes: Sequence[DisplayNode],
) -> ValidatedDisplayCheckpoint:
    """Seal one parent-first baseline and a full MatrixPool tensor."""

    _scene_name(scene_name)
    if not isinstance(catalog, DisplayCatalogIdentity):
        raise ConfigurationError("catalog must be DisplayCatalogIdentity")
    _safe_integer(last_command_seq, "last_command_seq")
    if not isinstance(matrix_pool, DisplayMatrixPool):
        raise ConfigurationError("matrix_pool must be DisplayMatrixPool")
    normalized_nodes = validate_display_nodes(nodes, matrix_pool=matrix_pool)
    snapshot, token = matrix_pool._snapshot_full()
    return ValidatedDisplayCheckpoint(
        scene_name=scene_name,
        catalog=catalog,
        last_command_seq=last_command_seq,
        matrix_pool_size=len(matrix_pool),
        matrix_pool=snapshot,
        nodes=normalized_nodes,
        maximum_json_depth=max(
            (_maximum_json_depth(node.state) for node in normalized_nodes),
            default=0,
        ),
        _publish_token=token,
    )


def validate_display_nodes(
    nodes: Sequence[DisplayNode], *, matrix_pool: DisplayMatrixPool | None = None
) -> tuple[DisplayNode, ...]:
    """Validate a parent-before-child authority baseline and its pool IDs."""

    result = _ordered_baseline(nodes)
    if matrix_pool is not None:
        if not isinstance(matrix_pool, DisplayMatrixPool):
            raise ConfigurationError("matrix_pool must be DisplayMatrixPool")
        expected = matrix_pool._active_node_ids()
        actual = tuple(sorted(node.node_id for node in result))
        if actual != expected:
            raise ConfigurationError(
                "display checkpoint Nodes must exactly match live matrix pool IDs"
            )
    return result


def encode_display_command_stream(
    *,
    base_command_seq: int,
    source_tick: int,
    matrix_pool: DisplayMatrixPool,
    commands: Sequence[DisplayCommand],
) -> tuple[ValidatedDisplayCommandStream, int]:
    """Seal commands plus one sorted dirty-ID / contiguous-matrix gather."""

    _safe_integer(base_command_seq, "base_command_seq")
    _safe_integer(source_tick, "source_tick")
    if not isinstance(matrix_pool, DisplayMatrixPool):
        raise ConfigurationError("matrix_pool must be DisplayMatrixPool")
    normalized = _logical_commands(commands)
    publication_updates, expected_dirty, maximum_json_depth = (
        matrix_pool._validate_command_lifecycle(normalized)
    )
    dirty_ids, dirty_matrices, token = matrix_pool._snapshot_dirty(
        expected_dirty, publication_updates
    )
    cursor = base_command_seq + len(normalized)
    if cursor > (1 << 53) - 1:
        raise ConfigurationError("last_command_seq must be a non-negative safe integer")
    return (
        _new_validated_display_command_stream(
            base_command_seq=base_command_seq,
            source_tick=source_tick,
            last_command_seq=cursor,
            matrix_pool_size=len(matrix_pool),
            dirty_node_ids=dirty_ids,
            dirty_matrices=dirty_matrices,
            commands=normalized,
            maximum_json_depth=maximum_json_depth,
            publish_token=token,
        ),
        cursor,
    )


def validate_display_checkpoint(
    value: Any, *, expected_last_command_seq: int | None = None
) -> tuple[DisplayNode, ...]:
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
    size = _pool_size(value["matrix_pool_size"])
    matrices = _matrix_tensor_from_record(value["matrix_pool"], size, "matrix_pool")
    nodes_value = value["nodes"]
    if not isinstance(nodes_value, list):
        raise ConfigurationError("display checkpoint nodes must be an array")
    fields = {
        "node_id", "parent_node_id", "prefab_id", "transform_mode", "visible", "state"
    }
    nodes = []
    for record in nodes_value:
        if not isinstance(record, dict) or set(record) != fields:
            raise ConfigurationError("display checkpoint Node fields are invalid")
        nodes.append(DisplayNode(**record))
    result = _ordered_baseline(nodes)
    _validate_baseline_pool(result, matrices, size)
    return result


def validate_display_command_stream(
    value: Any,
    *,
    expected_source_tick: int,
    expected_last_command_seq: int,
) -> tuple[DisplayCommand, ...]:
    fields = {
        "schema", "base_command_seq", "last_command_seq", "matrix_pool_size",
        "dirty_node_ids", "dirty_matrices", "commands",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise ConfigurationError("display command stream fields are invalid")
    if value["schema"] != DISPLAY_COMMAND_STREAM_SCHEMA:
        raise ConfigurationError("display command stream schema is invalid")
    base = _safe_integer(value["base_command_seq"], "base_command_seq")
    last = _safe_integer(value["last_command_seq"], "last_command_seq")
    _safe_integer(expected_source_tick, "expected_source_tick")
    if last != _safe_integer(expected_last_command_seq, "expected_last_command_seq") or last < base:
        raise ConfigurationError("display command stream cursor is invalid")
    records = value["commands"]
    if not isinstance(records, list) or len(records) != last - base:
        raise ConfigurationError("display command stream length is invalid")
    commands = []
    for ordinal, record in enumerate(records, 1):
        command = _command_from_record(record)
        if record["command_seq"] != base + ordinal:
            raise ConfigurationError("display command sequence is invalid")
        if record["source_tick"] != expected_source_tick:
            raise ConfigurationError("display command source_tick is invalid")
        commands.append(command)
    size = _pool_size(value["matrix_pool_size"])
    dirty_ids = _dirty_ids_from_record(value["dirty_node_ids"], size)
    dirty_matrices = _matrix_tensor_from_record(
        value["dirty_matrices"], len(dirty_ids), "dirty_matrices"
    )
    _validate_command_pool_ids(tuple(commands), size)
    _validate_dirty_batch(dirty_ids, dirty_matrices, size, tuple(commands))
    return tuple(commands)


def _command_from_record(value: Any) -> DisplayCommand:
    metadata = {"schema", "command_seq", "source_tick", "kind"}
    if not isinstance(value, dict) or not metadata.issubset(value):
        raise ConfigurationError("display command record fields are invalid")
    if value["schema"] != DISPLAY_COMMAND_SCHEMA:
        raise ConfigurationError("display command schema is invalid")
    _safe_integer(value["command_seq"], "command_seq")
    _safe_integer(value["source_tick"], "source_tick")
    kind = value["kind"]
    if kind == "node-set-transform-batch":
        if set(value) != metadata | {"node_ids"}:
            raise ConfigurationError("display command record fields are invalid")
        return _new_display_transform_batch_command(value["node_ids"])
    common = metadata | {"node_id"}
    expected_by_kind = {
        "node-create": {"parent_node_id", "prefab_id", "transform_mode", "visible", "state"},
        "node-set-parent": {"parent_node_id"},
        "node-set-visible": {"visible"},
        "node-set-state": {"state"},
        "node-set-property": {"property_name", "value"},
        "node-unset-property": {"property_name"},
        "node-emit-event": {"event_name", "payload"},
        "node-replace-prefab": {"prefab_id", "state"},
        "node-remove": set(),
    }
    if kind not in expected_by_kind or set(value) != common | expected_by_kind[kind]:
        raise ConfigurationError("display command record fields are invalid")
    return _new_display_command(
        kind=kind,
        node_id=value["node_id"],
        **{field: value[field] for field in expected_by_kind[kind]},
    )


def _ordered_baseline(nodes: Sequence[DisplayNode]) -> tuple[DisplayNode, ...]:
    if not isinstance(nodes, (tuple, list)):
        raise ConfigurationError("display checkpoint nodes must be a sequence")
    result = tuple(nodes)
    by_id: dict[int, DisplayNode] = {}
    depths: dict[int, int] = {}
    for node in result:
        if not isinstance(node, DisplayNode):
            raise ConfigurationError("display checkpoint contains a non-DisplayNode")
        if node.node_id in by_id:
            raise ConfigurationError("display checkpoint contains duplicate Node IDs")
        if node.parent_node_id is not None and node.parent_node_id not in by_id:
            raise ConfigurationError("display checkpoint must be parent-before-child")
        depth = 1 if node.parent_node_id is None else depths[node.parent_node_id] + 1
        if depth > MAXIMUM_NODE_DEPTH:
            raise ConfigurationError("display checkpoint exceeds maximum Node depth")
        by_id[node.node_id] = node
        depths[node.node_id] = depth
    return result


def _logical_commands(commands: Sequence[DisplayCommand]) -> tuple[DisplayCommand, ...]:
    if not isinstance(commands, (tuple, list)):
        raise ConfigurationError("display commands must be a sequence")
    result = tuple(commands)
    if any(not isinstance(command, DisplayCommand) for command in result):
        raise ConfigurationError("display commands contain an invalid record")
    return result


def _normalize_command_fields(
    kind: str, node_id: int, fields: Mapping[str, Any]
) -> dict[str, Any]:
    actual = set(fields)
    if kind == "node-create":
        required = {"parent_node_id", "prefab_id", "transform_mode", "visible", "state"}
        if actual != required:
            raise ConfigurationError("node-create fields are invalid")
        node = DisplayNode(node_id=node_id, **fields)
        return {
            "parent_node_id": node.parent_node_id,
            "prefab_id": node.prefab_id,
            "transform_mode": node.transform_mode,
            "visible": node.visible,
            "state": node.state,
        }
    if kind == "node-set-parent":
        if actual != {"parent_node_id"}:
            raise ConfigurationError("node-set-parent fields are invalid")
        parent = _nullable_node_id(fields["parent_node_id"], "parent_node_id")
        if parent == node_id:
            raise ConfigurationError("authority Node cannot parent itself")
        return {"parent_node_id": parent}
    if kind == "node-set-visible":
        if actual != {"visible"} or not isinstance(fields["visible"], bool):
            raise ConfigurationError("node-set-visible fields are invalid")
        return {"visible": fields["visible"]}
    if kind == "node-set-state":
        if actual != {"state"}:
            raise ConfigurationError("node-set-state fields are invalid")
        return {"state": _plain_state(fields["state"])}
    if kind == "node-set-property":
        if actual != {"property_name", "value"}:
            raise ConfigurationError("node-set-property fields are invalid")
        return {
            "property_name": _property_name(fields["property_name"]),
            "value": _plain_json_value(fields["value"]),
        }
    if kind == "node-unset-property":
        if actual != {"property_name"}:
            raise ConfigurationError("node-unset-property fields are invalid")
        return {"property_name": _property_name(fields["property_name"])}
    if kind == "node-emit-event":
        if actual != {"event_name", "payload"}:
            raise ConfigurationError("node-emit-event fields are invalid")
        return {
            "event_name": _event_name(fields["event_name"]),
            "payload": _plain_state(fields["payload"], label="event payload"),
        }
    if kind == "node-replace-prefab":
        if actual != {"prefab_id", "state"}:
            raise ConfigurationError("node-replace-prefab fields are invalid")
        _prefab_id(fields["prefab_id"])
        return {"prefab_id": fields["prefab_id"], "state": _plain_state(fields["state"])}
    if actual:
        raise ConfigurationError("node-remove fields are invalid")
    return {}


def _node_id(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAXIMUM_NODE_ID:
        raise ConfigurationError(f"{field} must be a uint32 Node ID")
    return value


def _nullable_node_id(value: Any, field: str) -> int | None:
    return None if value is None else _node_id(value, field)


def _pool_size(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > NULL_NODE_ID
    ):
        raise ConfigurationError("matrix_pool_size must fit uint32")
    return value


def _validate_matrix_tensor(value: Any, count: int, field: str) -> np.ndarray:
    _pool_size(count)
    if (
        not isinstance(value, np.ndarray)
        or value.shape != (count, 4, 4)
        or value.dtype != np.dtype("<f4")
        or not value.flags.c_contiguous
        or value.flags.writeable
    ):
        raise ConfigurationError(
            f"{field} must be a read-only contiguous <f4 tensor with shape ({count}, 4, 4)"
        )
    return value


def _matrix_tensor_from_record(value: Any, count: int, field: str) -> np.ndarray:
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


def _dirty_ids_from_record(value: Any, pool_size: int) -> np.ndarray:
    if isinstance(value, np.ndarray):
        if (
            value.ndim != 1
            or value.dtype != np.dtype("<u4")
            or not value.flags.c_contiguous
        ):
            raise ConfigurationError(
                "dirty_node_ids must be a one-dimensional contiguous <u4 array"
            )
        result = value
        if result.flags.writeable:
            result = result.copy(order="C")
            result.flags.writeable = False
        if len(result) > 1 and not np.all(result[1:] > result[:-1]):
            raise ConfigurationError(
                "dirty_node_ids must be unique and strictly sorted"
            )
        if len(result) and int(result[-1]) >= pool_size:
            raise ConfigurationError("dirty_node_id is outside matrix_pool_size")
        return result
    elif isinstance(value, list):
        normalized = tuple(_node_id(item, "dirty_node_id") for item in value)
        result = np.asarray(normalized, dtype="<u4")
        result.flags.writeable = False
    else:
        raise ConfigurationError("dirty_node_ids must be an array")
    if tuple(sorted(set(normalized))) != normalized:
        raise ConfigurationError("dirty_node_ids must be unique and strictly sorted")
    if normalized and normalized[-1] >= pool_size:
        raise ConfigurationError("dirty_node_id is outside matrix_pool_size")
    return result


def _validate_baseline_pool(
    nodes: Sequence[DisplayNode], matrices: np.ndarray, pool_size: int
) -> None:
    _validate_matrix_tensor(matrices, pool_size, "matrix_pool")
    active_ids = {node.node_id for node in nodes}
    if any(node_id >= pool_size for node_id in active_ids):
        raise ConfigurationError("checkpoint Node ID is outside matrix_pool_size")
    bits = matrices.view("<u4")
    for node_id in range(pool_size):
        if node_id not in active_ids and np.any(bits[node_id] != 0):
            raise ConfigurationError("inactive matrix pool rows must be zero tombstones")


def _matrix_command_targets(commands: Sequence[DisplayCommand]) -> tuple[int, ...]:
    mutable: list[int] = []
    for command in commands:
        if command.kind == "node-set-transform-batch":
            assert command.node_ids is not None
            mutable.extend(int(node_id) for node_id in command.node_ids)
        elif command.kind == "node-create":
            assert command.node_id is not None
            mutable.append(command.node_id)
    targets = tuple(mutable)
    if len(set(targets)) != len(targets):
        raise ConfigurationError(
            "create/transform batch targets must be unique"
        )
    return tuple(sorted(targets))


def _validate_command_pool_ids(
    commands: Sequence[DisplayCommand], pool_size: int
) -> None:
    _pool_size(pool_size)
    for command in commands:
        if command.kind == "node-set-transform-batch":
            assert command.node_ids is not None
            if len(command.node_ids) and int(command.node_ids[-1]) >= pool_size:
                raise ConfigurationError(
                    "display transform batch Node ID is outside matrix_pool_size"
                )
            continue
        assert command.node_id is not None
        if command.node_id >= pool_size:
            raise ConfigurationError("display command Node ID is outside matrix_pool_size")
        if command.kind in {"node-create", "node-set-parent"}:
            parent = command.fields["parent_node_id"]
            if parent is not None and parent >= pool_size:
                raise ConfigurationError(
                    "display command parent Node ID is outside matrix_pool_size"
                )


def _validate_dirty_batch(
    node_ids: Any,
    matrices: Any,
    pool_size: int,
    commands: Sequence[DisplayCommand],
) -> None:
    _pool_size(pool_size)
    _validate_command_pool_ids(commands, pool_size)
    if (
        not isinstance(node_ids, np.ndarray)
        or node_ids.ndim != 1
        or node_ids.dtype != np.dtype("<u4")
        or not node_ids.flags.c_contiguous
        or node_ids.flags.writeable
    ):
        raise ConfigurationError("dirty_node_ids must be a read-only contiguous <u4 array")
    if len(node_ids) > 1 and not np.all(node_ids[1:] > node_ids[:-1]):
        raise ConfigurationError("dirty_node_ids must be unique and strictly sorted")
    if len(node_ids) and int(node_ids[-1]) >= pool_size:
        raise ConfigurationError("dirty_node_id is outside matrix_pool_size")
    _validate_matrix_tensor(matrices, len(node_ids), "dirty_matrices")
    batches = [
        command for command in commands if command.kind == "node-set-transform-batch"
    ]
    if len(batches) > 1:
        raise ConfigurationError(
            "display command stream may contain at most one transform batch"
        )
    batch_count = 0
    if batches:
        batch_ids = batches[0].node_ids
        assert batch_ids is not None
        batch_count = len(batch_ids)
        if batch_count > len(node_ids) or not np.array_equal(
            batch_ids, node_ids[:batch_count]
        ):
            raise ConfigurationError(
                "transform batch Node IDs must equal the dirty Node ID prefix"
            )
    create_targets = tuple(
        sorted(
            command.node_id
            for command in commands
            if command.kind == "node-create" and command.node_id is not None
        )
    )
    if len(create_targets) != len(node_ids) - batch_count or any(
        target != int(node_id)
        for target, node_id in zip(
            create_targets, node_ids[batch_count:], strict=True
        )
    ):
        raise ConfigurationError(
            "dirty Node IDs after the transform batch must exactly match create commands"
        )
    targets = _matrix_command_targets(commands)
    if len(targets) != len(node_ids) or any(
        target != int(node_id)
        for target, node_id in zip(targets, node_ids, strict=True)
    ):
        raise ConfigurationError(
            "dirty matrix Node IDs must exactly match create/transform batch targets"
        )


def _validate_maximum_depth(maximum_json_depth: Any, values: Sequence[Any]) -> None:
    expected = max(
        (
            _maximum_json_depth(value.state)
            if isinstance(value, DisplayNode)
            else _command_json_depth(value)
            for value in values
        ),
        default=0,
    )
    if (
        isinstance(maximum_json_depth, bool)
        or not isinstance(maximum_json_depth, int)
        or maximum_json_depth != expected
    ):
        raise ConfigurationError("validated Display JSON depth is invalid")


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


def _plain_state(
    value: Any, *, label: str = "authority state"
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ConfigurationError(f"{label} must be a plain JSON object")
    normalized = _plain_json_value(value)
    assert isinstance(normalized, Mapping)
    return normalized


def _plain_json_value(value: Any) -> Any:
    owned = _thaw(value)
    validate_json_value(owned)
    return _freeze(owned)


def _message_name(value: Any, field: str, maximum_bytes: int) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"{field} must be a non-empty string")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ConfigurationError(f"{field} must be valid Unicode") from exc
    if len(encoded) > maximum_bytes:
        raise ConfigurationError(
            f"{field} exceeds {maximum_bytes} UTF-8 bytes"
        )
    if value in _FORBIDDEN_MESSAGE_NAMES:
        raise ConfigurationError(f"{field} is forbidden")
    if any(
        character.isspace()
        or unicodedata.category(character).startswith("C")
        for character in value
    ):
        raise ConfigurationError(
            f"{field} must not contain whitespace or Unicode category C characters"
        )
    return value


def _property_name(value: Any) -> str:
    return _message_name(value, "property_name", MAXIMUM_PROPERTY_NAME_BYTES)


def _event_name(value: Any) -> str:
    return _message_name(value, "event_name", MAXIMUM_EVENT_NAME_BYTES)


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
    if command.kind == "node-set-property":
        return _maximum_json_depth(command.fields["value"])
    if command.kind == "node-emit-event":
        return _maximum_json_depth(command.fields["payload"])
    return 0


def _ordered_batch_node_ids(value: Any, *, sort: bool) -> np.ndarray:
    if isinstance(value, np.ndarray):
        if value.ndim != 1 or value.dtype.kind not in {"i", "u"}:
            raise ConfigurationError(
                "transform batch node_ids must be a one-dimensional integer array"
            )
        if not len(value):
            raise ConfigurationError("transform batch node_ids must not be empty")
        if value.dtype.kind == "i" and bool(np.any(value < 0)):
            raise ConfigurationError("node_id must be a uint32 Node ID")
        if int(value.max()) > MAXIMUM_NODE_ID:
            raise ConfigurationError("node_id must be a uint32 Node ID")
        mutable = np.array(value, dtype="<u4", order="C", copy=True)
    elif isinstance(value, Sequence) and not isinstance(
        value, (str, bytes, bytearray, memoryview)
    ):
        raw = list(value)
        if not raw:
            raise ConfigurationError("transform batch node_ids must not be empty")
        mutable = np.asarray(
            [_node_id(item, "node_id") for item in raw], dtype="<u4"
        )
    else:
        raise ConfigurationError("transform batch node_ids must be a sequence")
    if sort:
        mutable.sort()
        ordered = mutable
    else:
        ordered = np.sort(mutable)
    if len(ordered) > 1 and bool(np.any(ordered[1:] == ordered[:-1])):
        raise ConfigurationError("transform batch node_ids must be unique")
    return np.frombuffer(mutable.tobytes(), dtype="<u4")


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
    "DisplayMatrixPool",
    "DisplayNode",
    "DisplayTransform",
    "MAXIMUM_NODE_DEPTH",
    "MAXIMUM_NODE_ID",
    "NULL_NODE_ID",
    "ValidatedDisplayCheckpoint",
    "ValidatedDisplayCommandStream",
    "encode_display_checkpoint",
    "encode_display_command_stream",
    "validate_display_checkpoint",
    "validate_display_command_stream",
    "validate_display_nodes",
]
