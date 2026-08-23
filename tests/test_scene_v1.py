from __future__ import annotations

from pathlib import Path

import pytest

from scene_engine.errors import SceneCodecError
from scene_engine.scene import (
    OpaquePayload,
    SceneNode,
    VisualType,
    encode_scene_bootstrap,
    encode_scene_frame,
    encode_scene_frame_against_bootstrap,
    parse_scene_bootstrap,
    parse_scene_frame,
    validate_scene_tree,
)


FIXTURES = Path(__file__).parents[1] / "fixtures" / "scene-v1"


def node(identity: int, parent: int = 0, *, x: float = 0.0) -> SceneNode:
    return SceneNode(
        identity,
        parent,
        1,
        1,
        (x, 0.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
        (1.0, 1.0, 1.0),
    )


def test_python_and_javascript_share_scene_body_layout() -> None:
    bootstrap = parse_scene_bootstrap((FIXTURES / "bootstrap.bin").read_bytes())
    frame = parse_scene_frame((FIXTURES / "frame-1.bin").read_bytes(), source_tick=1)
    assert bootstrap.visual_types == (VisualType(1),)
    assert frame.nodes[0].local_position == (1.5, 0.0, 0.0)
    assert frame.events[0].payload == b"tick"


def test_bootstrap_and_complete_frame_are_deterministic() -> None:
    bootstrap = encode_scene_bootstrap(
        maximum_dynamic_nodes=8,
        maximum_frame_bytes=4096,
        visual_types=(VisualType(1),),
    )
    frame = encode_scene_frame(source_tick=4, nodes=(node(1), node(2, 1, x=2.0)))
    assert parse_scene_bootstrap(bootstrap).header.ticks_per_second == 60
    parsed = parse_scene_frame(frame, source_tick=4)
    poses = validate_scene_tree(parsed.nodes)
    assert poses[2][0] == 2.0


def test_structured_publication_validates_against_cached_bootstrap_and_encodes_once() -> None:
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=2,
            maximum_frame_bytes=4096,
            visual_types=(VisualType(1),),
        )
    )
    records = (node(1), node(2, 1, x=2.0))
    assert encode_scene_frame_against_bootstrap(
        source_tick=4,
        nodes=records,
        bootstrap=bootstrap,
    ) == encode_scene_frame(source_tick=4, nodes=records)

    with pytest.raises(SceneCodecError, match="visual type"):
        encode_scene_frame_against_bootstrap(
            source_tick=4,
            nodes=(
                SceneNode(
                    1,
                    0,
                    2,
                    1,
                    (0.0, 0.0, 0.0),
                    (0.0, 0.0, 0.0, 1.0),
                    (1.0, 1.0, 1.0),
                ),
            ),
            bootstrap=bootstrap,
        )


def test_structured_publication_enforces_bootstrap_node_and_byte_limits() -> None:
    node_limited = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=4096,
            visual_types=(VisualType(1),),
        )
    )
    with pytest.raises(SceneCodecError, match="node limit"):
        encode_scene_frame_against_bootstrap(
            source_tick=0,
            nodes=(node(1), node(2)),
            bootstrap=node_limited,
        )

    with pytest.raises(SceneCodecError, match="byte limit"):
        encode_scene_frame_against_bootstrap(
            source_tick=0,
            nodes=(node(1),),
            bootstrap=node_limited,
            maximum_frame_bytes=1,
        )


@pytest.mark.parametrize(
    "nodes",
    [
        (node(1, 99),),
        (node(1, 2), node(2, 1)),
    ],
)
def test_dangling_parent_and_cycle_fail_closed(nodes) -> None:
    with pytest.raises(SceneCodecError):
        validate_scene_tree(nodes)


def test_registry_payload_type_is_enforced() -> None:
    bad = SceneNode(
        1,
        0,
        1,
        1,
        (0.0, 0.0, 0.0),
        (0.0, 0.0, 0.0, 1.0),
        (1.0, 1.0, 1.0),
        profile=OpaquePayload(2, b"x"),
    )
    with pytest.raises(SceneCodecError):
        encode_scene_bootstrap(
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=4096,
            static_nodes=(bad,),
            visual_types=(VisualType(1, profile_type_id=1),),
        )
