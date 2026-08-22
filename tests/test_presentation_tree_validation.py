from __future__ import annotations

import math

import pytest

from scene_engine.errors import PresentationTreeError
from scene_engine.presentation_frame import (
    PresentationNodeV3,
    validate_presentation_frame_tree,
)
from scene_engine.presentation_identity import PresentationIdAllocator
from scene_engine.scene_bootstrap import validate_presentation_node_tree


def node(
    display_id: int,
    parent_display_id: int,
    *,
    position=(0.0, 0.0, 0.0),
    rotation=(0.0, 0.0, 0.0, 1.0),
    scale=(1.0, 1.0, 1.0),
) -> PresentationNodeV3:
    return PresentationNodeV3(
        display_id,
        parent_display_id,
        1,
        1,
        position,
        rotation,
        scale,
    )


def test_frame_tree_validates_static_parent_closure_and_derives_world_pose() -> None:
    half = math.sqrt(0.5)
    static = (node(
        1, 0, position=(10.0, 0.0, 0.0), rotation=(0.0, 0.0, half, half),
        scale=(2.0, 2.0, 2.0),
    ),)
    dynamic = (
        node(2, 1, position=(1.0, 0.0, 0.0)),
        node(3, 2, position=(0.0, 1.0, 0.0)),
    )
    validation = validate_presentation_frame_tree(dynamic, static_nodes=static)
    assert validation.depth_by_id == {1: 1, 2: 2, 3: 3}
    assert validation.get_world_pose(2).position == pytest.approx((10.0, 2.0, 0.0))
    assert validation.get_world_pose(3).position == pytest.approx((8.0, 2.0, 0.0))


def test_tree_helper_rejects_dangling_parent_cycle_depth_and_invalid_pose() -> None:
    with pytest.raises(PresentationTreeError, match="does not reference"):
        validate_presentation_node_tree((node(2, 1),))
    with pytest.raises(PresentationTreeError, match="cycle"):
        validate_presentation_node_tree((node(1, 2), node(2, 1)))
    with pytest.raises(PresentationTreeError, match="maximum_depth"):
        validate_presentation_node_tree((node(1, 0), node(2, 1)), maximum_depth=1)
    with pytest.raises(PresentationTreeError, match="finite"):
        validate_presentation_node_tree((node(1, 0, position=(math.nan, 0.0, 0.0)),))


def test_id_allocator_keeps_only_scalar_high_water_mark() -> None:
    allocator = PresentationIdAllocator(maximum_static_display_id=10)
    assert allocator.allocate() == 11
    assert allocator.allocate_many(3) == (12, 13, 14)
    assert allocator.max_seen_display_id == 14
    assert not hasattr(allocator, "retired_ids")
