from __future__ import annotations

import json
from pathlib import Path

import pytest

from scene_engine.errors import PresentationControlError
from scene_engine.presentation_control import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    encode_presentation_control,
    parse_presentation_control,
)


CURSOR = {
    "snapshot_id": "snapshot:demo1",
    "state_epoch": "epoch:demo1",
    "state_seq": 60,
    "state_stream_id": "stream:demo1",
    "world_revision": 61,
}
FIXTURE = Path(__file__).parent / "fixtures" / "presentation_control_v1.json"


def _envelope(message_type, payload):
    return {
        "bootstrap_id": "11",
        "message_id": "message:1",
        "payload": payload,
        "protocol": "scene-display-control-v1",
        "scene_epoch": "9",
        "schema_version": 1,
        "session_seq": 1,
        "type": message_type,
        "viewer_scope": "viewer:blue",
    }


def test_ready_and_ack_have_canonical_exact_envelopes() -> None:
    ready = _envelope("presentation.ready", {
        "baseline": CURSOR,
        "profile_id": "mw-presentation-v1",
    })
    encoded = encode_presentation_control(
        ready, direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER
    )
    assert encoded == FIXTURE.read_bytes().strip()
    assert b" " not in encoded
    assert parse_presentation_control(
        encoded, direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER
    ) == ready

    ack = _envelope("presentation.ack", {
        "committed_cursor": CURSOR,
        "correlation_seq": "60",
        "frame_seq": "61",
    })
    assert parse_presentation_control(
        encode_presentation_control(ack, direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER),
        direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    ) == ack


def test_correlation_mechanically_freezes_required_frame_combination() -> None:
    correlation = _envelope("presentation.correlation", {
        "cursor": CURSOR,
        "frame_refs": [{"frame_seq": "61", "sha256": "a" * 64}],
        "presentation_required": True,
        "projection_id": "61",
        "record_seq": "60",
    })
    encoded = encode_presentation_control(
        correlation, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
    )
    assert parse_presentation_control(
        encoded, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
    ) == correlation

    broken = _envelope("presentation.correlation", {
        **correlation["payload"],
        "frame_refs": [],
    })
    with pytest.raises(PresentationControlError, match="disagree"):
        encode_presentation_control(
            broken, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
        )


def test_control_rejects_direction_unknown_fields_noncanonical_json_and_u64() -> None:
    ready = _envelope("presentation.ready", {
        "baseline": CURSOR,
        "profile_id": "mw-presentation-v1",
    })
    with pytest.raises(PresentationControlError, match="direction"):
        encode_presentation_control(ready, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT)
    with pytest.raises(PresentationControlError, match="fields"):
        encode_presentation_control(
            {**ready, "unknown": True},
            direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
        )
    with pytest.raises(PresentationControlError, match="canonical"):
        parse_presentation_control(
            json.dumps(ready).encode("utf-8"),
            direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
        )
    with pytest.raises(PresentationControlError, match="u64"):
        encode_presentation_control(
            {**ready, "scene_epoch": "01"},
            direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
        )
