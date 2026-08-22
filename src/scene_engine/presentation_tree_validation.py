"""Generic validation and world-pose derivation for V3 presentation nodes."""

from __future__ import annotations

from dataclasses import dataclass
import math
from types import MappingProxyType
from typing import Iterable, Mapping, TYPE_CHECKING

from .errors import PresentationTreeError

if TYPE_CHECKING:
    from .presentation_v3 import PresentationNodeV3


_QUATERNION_TOLERANCE = 1e-3


@dataclass(frozen=True)
class PresentationWorldPoseV3:
    position: tuple[float, float, float]
    rotation_xyzw: tuple[float, float, float, float]
    scale: tuple[float, float, float]


@dataclass(frozen=True)
class PresentationTreeValidationV3:
    """Validated nodes and derived values, keyed by stable display ID."""

    nodes_by_id: Mapping[int, "PresentationNodeV3"]
    depth_by_id: Mapping[int, int]
    world_pose_by_id: Mapping[int, PresentationWorldPoseV3]

    def get_world_pose(self, display_id: int) -> PresentationWorldPoseV3 | None:
        return self.world_pose_by_id.get(display_id)


def validate_presentation_node_tree(
    nodes: Iterable["PresentationNodeV3"],
    *,
    static_nodes: Iterable["PresentationNodeV3"] = (),
    maximum_depth: int = 64,
) -> PresentationTreeValidationV3:
    """Validate one complete static+dynamic V3 tree and derive world poses.

    ``static_nodes`` is useful when validating a frame: every dynamic parent must
    be either one of those static IDs or another node in the same complete frame.
    The function deliberately validates the graph instead of assuming the wire
    ordering rule (``parent_display_id < display_id``) proves tree validity.
    """

    if isinstance(maximum_depth, bool) or not isinstance(maximum_depth, int):
        raise PresentationTreeError("maximum_depth must be a positive integer")
    if maximum_depth <= 0 or maximum_depth > 65_535:
        raise PresentationTreeError("maximum_depth must be in [1, 65535]")

    static_values = tuple(static_nodes)
    dynamic_values = tuple(nodes)
    values = static_values + dynamic_values
    node_type = _presentation_node_type()
    by_id: dict[int, PresentationNodeV3] = {}
    for node in values:
        if not isinstance(node, node_type):
            raise PresentationTreeError("tree nodes must contain PresentationNodeV3")
        if (
            isinstance(node.display_id, bool)
            or not isinstance(node.display_id, int)
            or not 1 <= node.display_id < 1 << 64
        ):
            raise PresentationTreeError("display_id is out of range")
        if node.display_id in by_id:
            raise PresentationTreeError("display_id is duplicated across the tree")
        if (
            isinstance(node.parent_display_id, bool)
            or not isinstance(node.parent_display_id, int)
            or not 0 <= node.parent_display_id < 1 << 64
        ):
            raise PresentationTreeError("parent_display_id is out of range")
        _validate_local_pose(node)
        by_id[node.display_id] = node

    for node in values:
        if node.parent_display_id and node.parent_display_id not in by_id:
            raise PresentationTreeError(
                "parent_display_id does not reference the static set or complete frame"
            )

    depths: dict[int, int] = {}
    world_poses: dict[int, PresentationWorldPoseV3] = {}
    for display_id in by_id:
        if display_id in depths:
            continue
        chain: list[int] = []
        chain_ids: set[int] = set()
        cursor = display_id
        while cursor not in depths:
            if cursor in chain_ids:
                raise PresentationTreeError("presentation parent graph contains a cycle")
            chain.append(cursor)
            chain_ids.add(cursor)
            parent = by_id[cursor].parent_display_id
            if parent == 0:
                break
            cursor = parent
        for current in reversed(chain):
            node = by_id[current]
            if node.parent_display_id == 0:
                depth = 1
                world = _local_pose(node)
            else:
                depth = depths[node.parent_display_id] + 1
                world = _compose_pose(world_poses[node.parent_display_id], node)
            if depth > maximum_depth:
                raise PresentationTreeError("presentation tree exceeds maximum_depth")
            depths[current] = depth
            world_poses[current] = world

    return PresentationTreeValidationV3(
        MappingProxyType(by_id),
        MappingProxyType(depths),
        MappingProxyType(world_poses),
    )


def validate_presentation_frame_tree(
    nodes: Iterable["PresentationNodeV3"],
    *,
    static_nodes: Iterable["PresentationNodeV3"],
    maximum_depth: int = 64,
) -> PresentationTreeValidationV3:
    """Named convenience entry point for complete-frame validation."""

    return validate_presentation_node_tree(
        nodes,
        static_nodes=static_nodes,
        maximum_depth=maximum_depth,
    )


def _presentation_node_type():
    # Kept lazy so the codec can call this helper without an import cycle.
    from .presentation_v3 import PresentationNodeV3

    return PresentationNodeV3


def _validate_local_pose(node: "PresentationNodeV3") -> None:
    position = _finite_tuple(node.local_position, 3, "local_position")
    rotation = _finite_tuple(node.local_rotation_xyzw, 4, "local_rotation_xyzw")
    scale = _finite_tuple(node.local_scale, 3, "local_scale")
    if any(value <= 0.0 for value in scale):
        raise PresentationTreeError("local_scale must be positive")
    norm = math.sqrt(sum(value * value for value in rotation))
    if abs(norm - 1.0) > _QUATERNION_TOLERANCE:
        raise PresentationTreeError("local_rotation_xyzw must be normalized")
    del position


def _finite_tuple(value, length: int, field: str) -> tuple[float, ...]:
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError) as exc:
        raise PresentationTreeError(f"{field} must contain finite floats") from exc
    if len(result) != length or not all(math.isfinite(item) for item in result):
        raise PresentationTreeError(f"{field} must contain finite floats")
    return result


def _local_pose(node: "PresentationNodeV3") -> PresentationWorldPoseV3:
    return PresentationWorldPoseV3(
        tuple(float(value) for value in node.local_position),
        tuple(float(value) for value in node.local_rotation_xyzw),
        tuple(float(value) for value in node.local_scale),
    )


def _compose_pose(
    parent: PresentationWorldPoseV3,
    child: "PresentationNodeV3",
) -> PresentationWorldPoseV3:
    child_position = tuple(float(value) for value in child.local_position)
    child_rotation = tuple(float(value) for value in child.local_rotation_xyzw)
    child_scale = tuple(float(value) for value in child.local_scale)
    scaled = tuple(
        parent.scale[index] * child_position[index] for index in range(3)
    )
    rotated = _rotate_vector(parent.rotation_xyzw, scaled)
    return PresentationWorldPoseV3(
        tuple(parent.position[index] + rotated[index] for index in range(3)),
        _multiply_quaternion(parent.rotation_xyzw, child_rotation),
        tuple(parent.scale[index] * child_scale[index] for index in range(3)),
    )


def _multiply_quaternion(left, right) -> tuple[float, float, float, float]:
    lx, ly, lz, lw = left
    rx, ry, rz, rw = right
    return (
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    )


def _rotate_vector(rotation, vector) -> tuple[float, float, float]:
    x, y, z, w = rotation
    vx, vy, vz = vector
    tx = 2.0 * (y * vz - z * vy)
    ty = 2.0 * (z * vx - x * vz)
    tz = 2.0 * (x * vy - y * vx)
    return (
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx),
    )


__all__ = [
    "PresentationTreeValidationV3",
    "PresentationWorldPoseV3",
    "validate_presentation_frame_tree",
    "validate_presentation_node_tree",
]
