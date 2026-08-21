from __future__ import annotations

from pathlib import Path
import struct

import pytest

from scene_engine.errors import PresentationFrameError
from scene_engine.presentation_frame import (
    InteractionMappingV1,
    OwnerStateV1,
    PresentationEntityV2,
    PresentationEventV1,
    encode_presentation_frame,
    parse_presentation_frame,
)
from scene_engine.presentation_schema import (
    INTERACTION_DOMAIN_ENTITY_ID,
    PRESENTATION_ENTITY_FLAG_INTERACTIVE,
    PRESENTATION_ENTITY_FLAG_VISIBLE,
)
from scene_engine.types import DisplayPose


FIXTURE = Path(__file__).parent / "fixtures" / "presentation_frame_v2.hex"


def _pose(x):
    return DisplayPose(
        position=(x, 2.0, -3.0),
        rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        scale=(1.0, 1.0, 1.0),
    )


def _entity(display_id, *, interactive=False):
    return PresentationEntityV2(
        display_id=display_id,
        visual_type_id=100 + display_id,
        flags=PRESENTATION_ENTITY_FLAG_VISIBLE | (
            PRESENTATION_ENTITY_FLAG_INTERACTIVE if interactive else 0
        ),
        pose=_pose(float(display_id)),
        animation_state_id=3,
        animation_start_tick=59,
        animation_flags=1,
        owner_state=OwnerStateV1(
            variant_id=2,
            damage_state_id=1,
            construction_state_id=2,
            assignment_state_id=3,
            side_id=1,
            color_rgba=0x11223344,
            scalar0=0.5,
        ),
        interaction=InteractionMappingV1(
            domain_kind=INTERACTION_DOMAIN_ENTITY_ID,
            capability_flags=1,
            domain_value="entity:alpha",
        ) if interactive else None,
    )


def _golden():
    return encode_presentation_frame(
        scene_epoch=9,
        bootstrap_id=11,
        frame_seq=60,
        source_tick=60,
        projection_id=61,
        entities=(_entity(1, interactive=True), _entity(2)),
        events=(PresentationEventV1(1, 7, 1, 1, 2, 60),),
        maximum_frame_entities=100,
        maximum_frame_events=100,
        maximum_frame_bytes=1024 * 1024,
    )


def _parse(value):
    return parse_presentation_frame(
        value,
        maximum_frame_entities=100,
        maximum_frame_events=100,
        maximum_frame_bytes=1024 * 1024,
    )


def test_presentation_frame_is_byte_identical_to_cross_language_fixture() -> None:
    assert _golden().data == bytes.fromhex(FIXTURE.read_text(encoding="ascii"))


def test_presentation_frame_round_trip_covers_typed_sections() -> None:
    decoded = _parse(_golden().data)
    assert decoded.frame_seq == 60
    assert decoded.source_tick == 60
    assert decoded.projection_id == 61
    assert [item.display_id for item in decoded.entities] == [1, 2]
    assert decoded.owner_states[0].color_rgba == 0x11223344
    assert decoded.interactions[0].domain_value == "entity:alpha"
    assert decoded.events[0].start_tick == 60


def test_presentation_frame_rejects_interactive_flag_mapping_disagreement() -> None:
    with pytest.raises(PresentationFrameError, match="interactive"):
        encode_presentation_frame(
            scene_epoch=1,
            bootstrap_id=1,
            frame_seq=1,
            source_tick=1,
            projection_id=1,
            entities=(PresentationEntityV2(1, 1, PRESENTATION_ENTITY_FLAG_INTERACTIVE, _pose(0)),),
            maximum_frame_entities=1,
            maximum_frame_events=0,
            maximum_frame_bytes=4096,
        )


def test_presentation_frame_rejects_gap_shaping_and_malformed_sections() -> None:
    value = bytearray(_golden().data)
    struct.pack_into("<H", value, 80, 99)
    with pytest.raises(PresentationFrameError, match="directory"):
        _parse(value)
    with pytest.raises(PresentationFrameError):
        _parse(_golden().data[:-1])
    with pytest.raises(PresentationFrameError):
        _parse(_golden().data + b"\x00")


def test_presentation_frame_rejects_duplicate_entities_and_events() -> None:
    with pytest.raises(PresentationFrameError, match="entity display IDs"):
        encode_presentation_frame(
            scene_epoch=1,
            bootstrap_id=1,
            frame_seq=1,
            source_tick=60,
            projection_id=1,
            entities=(_entity(2), _entity(1)),
            maximum_frame_entities=2,
            maximum_frame_events=0,
            maximum_frame_bytes=4096,
        )
    with pytest.raises(PresentationFrameError, match="event IDs"):
        encode_presentation_frame(
            scene_epoch=1,
            bootstrap_id=1,
            frame_seq=1,
            source_tick=60,
            projection_id=1,
            entities=(),
            events=(
                PresentationEventV1(1, 1, 1, 0, 0, 60),
                PresentationEventV1(1, 1, 1, 0, 0, 60),
            ),
            maximum_frame_entities=0,
            maximum_frame_events=2,
            maximum_frame_bytes=4096,
        )
