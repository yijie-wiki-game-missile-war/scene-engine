from __future__ import annotations

import pytest

from scene_engine.authority_cursor import AuthorityCursorEnvelope
from scene_engine.errors import SceneBootstrapError
from scene_engine.scene_bootstrap_v2 import (
    EngineSessionIdentityV2,
    encode_scene_bootstrap_v2,
    parse_scene_bootstrap_v2,
)


def _bootstrap() -> bytes:
    return encode_scene_bootstrap_v2(
        scene_epoch=2,
        bootstrap_id=3,
        identity=EngineSessionIdentityV2(
            run_id="run:test",
            viewer_scope="viewer:test",
            profile_id="test-presentation@2",
        ),
        authority_baseline=AuthorityCursorEnvelope(
            "test-authority-cursor@1",
            b"opaque-cursor-bytes",
        ),
        maximum_dynamic_entities=100,
        maximum_frame_bytes=1024 * 1024,
    )


def _parse(value: bytes):
    return parse_scene_bootstrap_v2(
        value,
        maximum_bootstrap_bytes=1024 * 1024,
        maximum_static_nodes=100,
        maximum_topology_nodes=100,
        maximum_adjacencies=100,
        maximum_visual_types=100,
        maximum_animation_states=100,
    )


def test_bootstrap_v2_splits_engine_identity_from_opaque_authority_binding() -> None:
    encoded = _bootstrap()
    decoded = _parse(encoded)
    assert decoded.header.schema_version == 2
    assert decoded.identity == EngineSessionIdentityV2(
        "run:test",
        "viewer:test",
        "test-presentation@2",
    )
    assert decoded.authority_baseline == AuthorityCursorEnvelope(
        "test-authority-cursor@1",
        b"opaque-cursor-bytes",
    )
    assert not hasattr(decoded.identity, "state_stream_id")


def test_bootstrap_v2_rejects_trailing_and_corrupted_binding_bytes() -> None:
    encoded = _bootstrap()
    with pytest.raises(SceneBootstrapError, match="length"):
        _parse(encoded + b"\x00")
    corrupted = bytearray(encoded)
    corrupted[-1] ^= 1
    with pytest.raises(SceneBootstrapError, match="sha256"):
        _parse(bytes(corrupted))
