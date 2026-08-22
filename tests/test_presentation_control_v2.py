from __future__ import annotations

import json

import pytest

from scene_engine.authority_cursor import (
    AuthorityCursorEnvelope,
    envelope_cursor,
    validate_envelope_with_codec,
)
from scene_engine.errors import PresentationControlError
from scene_engine.presentation_control_v2 import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
    parse_presentation_control_v2,
)


class CursorCodec:
    codec_identity = "test-authority-cursor@1"

    def encode(self, cursor):
        return json.dumps(cursor, separators=(",", ":"), sort_keys=True).encode()

    def decode(self, canonical_bytes):
        return json.loads(canonical_bytes)

    def key(self, cursor):
        return cursor["sequence"]

    def tick(self, cursor):
        return cursor["tick"]


CODEC = CursorCodec()
CURSOR = envelope_cursor({"sequence": 7, "tick": 6}, CODEC)


def _envelope(message_type, payload, *, session_seq=1):
    return {
        "bootstrap_id": "11",
        "message_id": "message:{}".format(session_seq),
        "payload": payload,
        "protocol": "scene-presentation-control-v2",
        "scene_epoch": "9",
        "schema_version": 1,
        "session_seq": session_seq,
        "type": message_type,
        "viewer_scope": "viewer:blue",
    }


def test_cursor_envelope_round_trips_without_exposing_domain_fields() -> None:
    assert CURSOR.codec_identity == "test-authority-cursor@1"
    assert validate_envelope_with_codec(CURSOR, CODEC) == {"sequence": 7, "tick": 6}
    with pytest.raises(PresentationControlError, match="identity mismatch"):
        validate_envelope_with_codec(
            CURSOR,
            type("Other", (), {**CursorCodec.__dict__, "codec_identity": "other@1"})(),
        )


def test_control_v2_uses_opaque_cursor_and_canonical_bytes() -> None:
    ready = _envelope(
        "presentation.ready",
        {
            "authority_baseline": cursor_envelope_to_json(CURSOR),
            "profile_id": "test-profile@1",
        },
    )
    encoded = encode_presentation_control_v2(
        ready, direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER
    )
    assert b"state_stream_id" not in encoded
    assert parse_presentation_control_v2(
        encoded, direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER
    ) == ready

    correlation = _envelope(
        "presentation.correlation",
        {
            "authority_cursor": cursor_envelope_to_json(CURSOR),
            "correlation_seq": "1",
            "frame_refs": [{"frame_seq": "1", "sha256": "a" * 64}],
            "presentation_required": True,
            "projection_id": "7",
            "source_tick": "6",
        },
    )
    assert parse_presentation_control_v2(
        encode_presentation_control_v2(
            correlation, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
        ),
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    ) == correlation


def test_control_v2_rejects_noncanonical_cursor_base64_and_unknown_fields() -> None:
    cursor = cursor_envelope_to_json(CURSOR)
    ready = _envelope(
        "presentation.ready",
        {"authority_baseline": cursor, "profile_id": "test-profile@1"},
    )
    with pytest.raises(PresentationControlError, match="base64"):
        encode_presentation_control_v2(
            {
                **ready,
                "payload": {
                    **ready["payload"],
                    "authority_baseline": {
                        **cursor,
                        "canonical_bytes_base64": cursor["canonical_bytes_base64"] + "=",
                    },
                },
            },
            direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
        )
    with pytest.raises(PresentationControlError, match="fields"):
        encode_presentation_control_v2(
            {**ready, "legacy_cursor": {}},
            direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
        )
