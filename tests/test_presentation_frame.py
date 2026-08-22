from __future__ import annotations

from pathlib import Path
import struct

import pytest

from scene_engine.errors import ConfigurationError, PresentationFrameError
from scene_engine.presentation_frame import (
    OpaquePayloadV3,
    PresentationEventV3,
    PresentationNodeV3,
    encode_presentation_frame_v3,
    parse_presentation_frame_v3,
)
from scene_engine.presentation_schema import (
    PRESENTATION_FRAME_HEADER_BYTES,
    PRESENTATION_FRAME_HEADER_V3,
    PRESENTATION_NODE_RECORD_BYTES,
)


FIXTURE = Path(__file__).parent / "fixtures" / "presentation_frame_v3.hex"


def node(
    display_id: int,
    parent_display_id: int,
    *,
    visual_type_id: int,
    position: tuple[float, float, float],
    profile_type_id: int,
    profile: bytes,
    interaction: bytes | None = None,
    animation_state_id: int = 0,
    animation_start_tick: int = 0,
    animation_flags: int = 0,
) -> PresentationNodeV3:
    return PresentationNodeV3(
        display_id=display_id,
        parent_display_id=parent_display_id,
        visual_type_id=visual_type_id,
        flags=1,
        local_position=position,
        local_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        local_scale=(1.0, 1.0, 1.0),
        animation_state_id=animation_state_id,
        animation_start_tick=animation_start_tick,
        animation_flags=animation_flags,
        profile=OpaquePayloadV3(profile_type_id, profile),
        interaction=None if interaction is None else OpaquePayloadV3(201, interaction),
    )


def encoded_frame() -> bytes:
    return encode_presentation_frame_v3(
        scene_epoch=7,
        bootstrap_id=9,
        frame_seq=60,
        source_tick=60,
        projection_id=77,
        nodes=(
            node(
                3,
                2,
                visual_type_id=1,
                position=(1.0, 0.0, 0.0),
                profile_type_id=101,
                profile=b"dynamic-person",
                interaction=b"person:alpha",
                animation_state_id=1,
                animation_start_tick=60,
                animation_flags=1,
            ),
            node(
                4,
                3,
                visual_type_id=2,
                position=(0.0, 2.0, 0.0),
                profile_type_id=102,
                profile=b"projectile",
            ),
        ),
        events=(PresentationEventV3(1, 501, 1, 3, 4, 60, b"impact"),),
    )


def test_v3_packed_layout_and_python_golden_are_frozen() -> None:
    assert PRESENTATION_FRAME_HEADER_V3.size == PRESENTATION_FRAME_HEADER_BYTES == 80
    assert PRESENTATION_NODE_RECORD_BYTES == 80
    expected = bytes.fromhex(FIXTURE.read_text(encoding="ascii").strip())
    assert encoded_frame() == expected


def test_frame_parser_exposes_complete_local_nodes_and_opaque_sections() -> None:
    source = encoded_frame()
    view = parse_presentation_frame_v3(source)
    assert view.data is source
    assert view.header.schema_version == 3
    assert view.header.section_count == 7
    assert view.header.node_count == 2
    assert view.header.profile_count == 2
    assert view.header.interaction_count == 1
    assert [item.display_id for item in view.nodes] == [3, 4]
    assert view.nodes[0].parent_display_id == 2
    assert view.nodes[1].local_position == (0.0, 2.0, 0.0)
    assert view.nodes[0].profile.data == b"dynamic-person"
    assert view.nodes[1].interaction is None
    assert view.events[0].payload == b"impact"


def test_frame_writer_rejects_noncanonical_order_and_future_animation() -> None:
    values = (
        node(4, 0, visual_type_id=2, position=(0.0, 0.0, 0.0), profile_type_id=102, profile=b"a"),
        node(3, 0, visual_type_id=2, position=(0.0, 0.0, 0.0), profile_type_id=102, profile=b"b"),
    )
    with pytest.raises(ConfigurationError, match="order"):
        encode_presentation_frame_v3(
            scene_epoch=1, bootstrap_id=1, frame_seq=1, source_tick=1,
            projection_id=1, nodes=values,
        )
    future = node(
        3, 0, visual_type_id=1, position=(0.0, 0.0, 0.0),
        profile_type_id=101, profile=b"a", animation_start_tick=2,
    )
    with pytest.raises(ConfigurationError, match="source_tick"):
        encode_presentation_frame_v3(
            scene_epoch=1, bootstrap_id=1, frame_seq=1, source_tick=1,
            projection_id=1, nodes=(future,),
        )


def test_frame_parser_rejects_v2_and_resource_limit_without_fallback() -> None:
    with pytest.raises(PresentationFrameError):
        parse_presentation_frame_v3(encoded_frame(), maximum_frame_nodes=1)
    raw = bytearray(encoded_frame())
    struct.pack_into("<H", raw, 0, 2)
    with pytest.raises(PresentationFrameError):
        parse_presentation_frame_v3(raw)
