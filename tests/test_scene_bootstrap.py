from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import hashlib
import struct

import pytest

from scene_engine.authority_cursor import AuthorityCursorEnvelope
from scene_engine.errors import (
    ConfigurationError,
    PresentationControlError,
    SceneBootstrapError,
)
from scene_engine.presentation_schema import (
    PRESENTATION_NODE_RECORD_BYTES,
    PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES,
    SCENE_BOOTSTRAP_HEADER_BYTES,
    SCENE_BOOTSTRAP_HEADER_V3,
)
from scene_engine.scene_bootstrap import (
    AnimationStateRecordV3,
    EngineSessionIdentityV3,
    OpaquePayloadV3,
    PresentationNodeV3,
    SceneMetadataV3,
    VisualTypeRecordV3,
    encode_scene_bootstrap_v3,
    parse_scene_bootstrap_v3,
)


FIXTURE = Path(__file__).parent / "fixtures" / "scene_bootstrap_v3.hex"


def node(
    display_id: int,
    parent_display_id: int,
    *,
    x: float,
    profile: bytes,
    interaction: bytes | None,
    visual_type_id: int = 1,
    profile_type_id: int = 101,
) -> PresentationNodeV3:
    return PresentationNodeV3(
        display_id=display_id,
        parent_display_id=parent_display_id,
        visual_type_id=visual_type_id,
        flags=1,
        local_position=(x, 0.0, 0.0),
        local_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        local_scale=(1.0, 1.0, 1.0),
        profile=OpaquePayloadV3(profile_type_id, profile),
        interaction=None if interaction is None else OpaquePayloadV3(201, interaction),
    )


def encoded_bootstrap() -> bytes:
    return encode_scene_bootstrap_v3(
        scene_epoch=7,
        bootstrap_id=9,
        identity=EngineSessionIdentityV3(
            "run:test", "viewer:test", "mw-presentation-v3@1"
        ),
        authority_baseline=AuthorityCursorEnvelope(
            "mw-v5-full-cursor@1", b"cursor-v3"
        ),
        maximum_dynamic_nodes=100,
        maximum_frame_bytes=1_048_576,
        static_nodes=(
            node(1, 0, x=10.0, profile=b"static-root", interaction=b"root-interaction"),
            node(
                2,
                1,
                x=2.0,
                profile=b"tile",
                interaction=None,
                visual_type_id=2,
                profile_type_id=102,
            ),
        ),
        scene_metadata=(SceneMetadataV3(301, b"hex-topology-v1"),),
        visual_types=(
            VisualTypeRecordV3(1, 3, 101, 201),
            VisualTypeRecordV3(2, 4, 102, 0),
        ),
        animation_states=(AnimationStateRecordV3(1, 1, 60),),
    )


def test_v3_packed_layout_and_python_golden_are_frozen() -> None:
    assert SCENE_BOOTSTRAP_HEADER_V3.size == SCENE_BOOTSTRAP_HEADER_BYTES == 96
    assert PRESENTATION_SECTION_DIRECTORY_ENTRY_BYTES == 20
    assert PRESENTATION_NODE_RECORD_BYTES == 80
    expected = bytes.fromhex(FIXTURE.read_text(encoding="ascii").strip())
    assert encoded_bootstrap() == expected


def test_v3_parser_round_trips_identity_registry_and_opaque_payloads() -> None:
    source = encoded_bootstrap()
    view = parse_scene_bootstrap_v3(source)
    assert view.data is source
    assert view.header.schema_version == 3
    assert view.header.section_count == 11
    assert view.identity.profile_id == "mw-presentation-v3@1"
    assert view.authority_baseline.canonical_bytes == b"cursor-v3"
    assert [item.display_id for item in view.static_nodes] == [1, 2]
    assert view.static_nodes[1].parent_display_id == 1
    assert view.static_nodes[0].profile.data == b"static-root"
    assert view.static_nodes[0].interaction.data == b"root-interaction"
    assert view.static_nodes[1].interaction is None
    assert view.scene_metadata[0].data == b"hex-topology-v1"


def test_bootstrap_rejects_dangling_static_parent_before_encoding() -> None:
    with pytest.raises(ConfigurationError, match="parent_display_id"):
        encode_scene_bootstrap_v3(
            scene_epoch=1,
            bootstrap_id=1,
            identity=EngineSessionIdentityV3("run", "viewer", "profile"),
            authority_baseline=AuthorityCursorEnvelope("cursor@1", b"cursor"),
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=1024,
            static_nodes=(
                node(2, 1, x=0.0, profile=b"state", interaction=b"interaction"),
            ),
            visual_types=(VisualTypeRecordV3(1, 0, 101, 201),),
        )


@pytest.mark.parametrize("missing", ("profile", "interaction"))
def test_bootstrap_writer_rejects_registry_required_payload_absence(missing: str) -> None:
    value = node(1, 0, x=0.0, profile=b"state", interaction=b"interaction")
    value = replace(value, **{missing: None})
    with pytest.raises(ConfigurationError, match=f"node {missing} type"):
        encode_scene_bootstrap_v3(
            scene_epoch=1,
            bootstrap_id=1,
            identity=EngineSessionIdentityV3("run", "viewer", "profile"),
            authority_baseline=AuthorityCursorEnvelope("cursor@1", b"cursor"),
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=1024,
            static_nodes=(value,),
            visual_types=(VisualTypeRecordV3(1, 0, 101, 201),),
        )


def test_bootstrap_writer_uses_identity_and_authority_envelope_limits() -> None:
    with pytest.raises(ConfigurationError, match="identity exceeds byte limit"):
        encode_scene_bootstrap_v3(
            scene_epoch=1,
            bootstrap_id=1,
            identity=EngineSessionIdentityV3("r" * 4095, "v", "p"),
            authority_baseline=AuthorityCursorEnvelope("cursor@1", b"cursor"),
            maximum_dynamic_nodes=1,
            maximum_frame_bytes=1024,
        )
    with pytest.raises(PresentationControlError, match="codec_identity"):
        AuthorityCursorEnvelope("a" * 161, b"cursor")
    with pytest.raises(PresentationControlError, match="canonical_bytes length"):
        AuthorityCursorEnvelope("cursor@1", b"x" * (16 * 1024 + 1))


def test_bootstrap_parser_rejects_noncanonical_hash_and_limits() -> None:
    raw = bytearray(encoded_bootstrap())
    raw[-1] ^= 1
    with pytest.raises(SceneBootstrapError, match="content_sha256"):
        parse_scene_bootstrap_v3(raw)
    with pytest.raises(SceneBootstrapError):
        parse_scene_bootstrap_v3(encoded_bootstrap(), maximum_static_nodes=1)


def test_bootstrap_parser_rejects_hash_valid_dangling_static_parent() -> None:
    raw = bytearray(encoded_bootstrap())
    # Static record 2 becomes ID 3 -> dangling parent 2. Keep the two parallel
    # payload ref tables canonical so rejection reaches explicit tree closure.
    struct.pack_into("<Q", raw, 488, 3)
    struct.pack_into("<Q", raw, 496, 2)
    struct.pack_into("<Q", raw, 592, 3)
    struct.pack_into("<Q", raw, 656, 3)
    raw[48:80] = hashlib.sha256(raw[96:]).digest()
    with pytest.raises(SceneBootstrapError, match="parent_display_id"):
        parse_scene_bootstrap_v3(raw)


def test_bootstrap_parser_rejects_v2_schema_without_fallback() -> None:
    raw = bytearray(encoded_bootstrap())
    struct.pack_into("<H", raw, 0, 2)
    with pytest.raises(SceneBootstrapError):
        parse_scene_bootstrap_v3(raw)
