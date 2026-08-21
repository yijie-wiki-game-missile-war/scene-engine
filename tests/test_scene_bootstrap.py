from __future__ import annotations

from pathlib import Path
import struct

import pytest

from scene_engine.errors import SceneBootstrapError
from scene_engine.presentation_schema import (
    PRESENTATION_SECTION_DIRECTORY_ENTRY_V1,
    STATIC_NODE_RECORD_BYTES,
)
from scene_engine.scene_bootstrap import (
    AdjacencyRecordV1,
    AnimationRegistryRecordV1,
    BootstrapIdentityV1,
    StaticNodeRecordV1,
    TopologyNodeRecordV1,
    VisualRegistryRecordV1,
    encode_scene_bootstrap,
    parse_scene_bootstrap,
)


FIXTURE = Path(__file__).parent / "fixtures" / "scene_bootstrap_v1.hex"


def _identity():
    return BootstrapIdentityV1(
        run_id="run:demo1",
        viewer_scope="viewer:blue",
        profile_id="mw-presentation-v1",
        state_stream_id="stream:demo1",
        state_epoch="epoch:demo1",
        snapshot_id="snapshot:demo1",
        state_seq=0,
        world_revision=7,
    )


def _static(display_id, parent=0, x=0.0):
    return StaticNodeRecordV1(
        display_id=display_id,
        parent_display_id=parent,
        visual_type_id=1,
        owner_type_id=10,
        flags=1,
        world_position=(x, 0.0, 0.0),
        world_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        world_scale=(1.0, 1.0, 1.0),
        variant_id=0,
        content_id=100,
    )


def _golden():
    return encode_scene_bootstrap(
        scene_epoch=9,
        bootstrap_id=11,
        identity=_identity(),
        static_nodes=(
            _static(1),
            _static(2, parent=1, x=1.5),
            _static(3, parent=1, x=3.0),
        ),
        topology_nodes=(
            TopologyNodeRecordV1(2, 1, 1, 1, 0, 2),
            TopologyNodeRecordV1(3, 1, 1, 2, 0, 1),
        ),
        adjacencies=(AdjacencyRecordV1(2, 3),),
        visual_registry=(VisualRegistryRecordV1(1, 10, 0, 1, 100, 200, 0, 1),),
        animation_registry=(AnimationRegistryRecordV1(1, 1, 60),),
        maximum_dynamic_entities=5000,
        maximum_frame_bytes=4 * 1024 * 1024,
    )


def _parse(value):
    return parse_scene_bootstrap(
        value,
        maximum_bootstrap_bytes=1024 * 1024,
        maximum_static_nodes=100,
        maximum_topology_nodes=100,
        maximum_adjacencies=200,
        maximum_visual_types=100,
        maximum_animation_states=100,
    )


def test_bootstrap_is_byte_identical_to_cross_language_fixture() -> None:
    expected = bytes.fromhex(FIXTURE.read_text(encoding="ascii"))
    assert _golden() == expected


def test_bootstrap_round_trip_installs_static_topology_and_identity() -> None:
    decoded = _parse(_golden())
    assert decoded.scene_epoch == 9
    assert decoded.bootstrap_id == 11
    assert decoded.header.ticks_per_second == 60
    assert decoded.identity == _identity()
    assert [item.display_id for item in decoded.static_nodes] == [1, 2, 3]
    assert decoded.static_nodes[1].parent_display_id == 1
    assert decoded.topology_nodes[1].axial_q == 2
    assert decoded.topology_nodes[1].flags == 0
    assert decoded.adjacencies == (AdjacencyRecordV1(2, 3),)
    assert decoded.visual_registry[0].animation_registry_count == 1


def test_bootstrap_rejects_corrupt_hash_truncation_and_trailing_bytes() -> None:
    value = bytearray(_golden())
    value[-1] ^= 1
    with pytest.raises(SceneBootstrapError, match="sha256"):
        _parse(value)
    with pytest.raises(SceneBootstrapError):
        _parse(_golden()[:-1])
    with pytest.raises(SceneBootstrapError):
        _parse(_golden() + b"\x00")


def test_bootstrap_rejects_duplicate_static_id_before_cross_reference_commit() -> None:
    value = bytearray(_golden())
    static_offset = PRESENTATION_SECTION_DIRECTORY_ENTRY_V1.unpack_from(value, 116)[3]
    struct.pack_into("<Q", value, static_offset + STATIC_NODE_RECORD_BYTES, 1)
    # Recompute content hash so the structural validator reaches the ID rule.
    import hashlib

    value[48:80] = hashlib.sha256(value[96:]).digest()
    with pytest.raises(SceneBootstrapError, match="static node identity"):
        _parse(value)


def test_bootstrap_writer_rejects_noncanonical_identity_and_order() -> None:
    with pytest.raises(SceneBootstrapError):
        encode_scene_bootstrap(
            scene_epoch=1,
            bootstrap_id=1,
            identity=BootstrapIdentityV1(" run", "v", "p", "s", "e", "x", 0, 0),
            maximum_dynamic_entities=1,
            maximum_frame_bytes=1024,
        )
    with pytest.raises(SceneBootstrapError, match="strictly increasing"):
        encode_scene_bootstrap(
            scene_epoch=1,
            bootstrap_id=1,
            identity=_identity(),
            static_nodes=(_static(2), _static(1)),
            visual_registry=(VisualRegistryRecordV1(1, 10, 0, 0, 100, 200, 0, 0),),
            maximum_dynamic_entities=1,
            maximum_frame_bytes=1024,
        )
