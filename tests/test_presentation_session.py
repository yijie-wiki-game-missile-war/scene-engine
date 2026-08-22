from __future__ import annotations

import hashlib
import json

import pytest

from scene_engine.authority_cursor import envelope_cursor
from scene_engine.errors import PresentationTransportError
from scene_engine.presentation_control_v2 import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
)
from scene_engine.presentation_session import (
    OrderedPresentationSession,
    PresentationFramePacket,
    PresentationSessionLimits,
)


class CursorCodec:
    codec_identity = "test-authority-cursor@1"

    def encode(self, cursor):
        return json.dumps(cursor, separators=(",", ":"), sort_keys=True).encode()

    def decode(self, value):
        return json.loads(value)

    def key(self, cursor):
        return cursor["seq"]

    def tick(self, cursor):
        return cursor["tick"]


CODEC = CursorCodec()
BASELINE = envelope_cursor({"seq": 0, "tick": 0}, CODEC)


def _control(message_type, payload, *, sequence, direction):
    return encode_presentation_control_v2(
        {
            "bootstrap_id": "2",
            "message_id": "{}:{}".format(message_type, sequence),
            "payload": payload,
            "protocol": "scene-presentation-control-v2",
            "scene_epoch": "1",
            "schema_version": 1,
            "session_seq": sequence,
            "type": message_type,
            "viewer_scope": "viewer:test",
        },
        direction=direction,
    )


def _session(**limits):
    return OrderedPresentationSession(
        bootstrap_packet=b"bootstrap-v2",
        scene_epoch=1,
        bootstrap_id=2,
        viewer_scope="viewer:test",
        profile_id="test-profile@1",
        authority_baseline=BASELINE,
        limits=PresentationSessionLimits(**limits),
    )


def _ready(sequence=1):
    return _control(
        "presentation.ready",
        {
            "authority_baseline": cursor_envelope_to_json(BASELINE),
            "profile_id": "test-profile@1",
        },
        sequence=sequence,
        direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    )


def _admit(session, *, correlation_seq, frame_seq, source_tick, cursor):
    packet = "frame:{}".format(frame_seq).encode()
    frame = PresentationFramePacket(frame_seq, source_tick, correlation_seq, packet)
    correlation = _control(
        "presentation.correlation",
        {
            "authority_cursor": cursor_envelope_to_json(cursor),
            "correlation_seq": str(correlation_seq),
            "frame_refs": [
                {
                    "frame_seq": str(frame_seq),
                    "sha256": hashlib.sha256(packet).hexdigest(),
                }
            ],
            "presentation_required": True,
            "projection_id": str(correlation_seq),
            "source_tick": str(source_tick),
        },
        sequence=correlation_seq,
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    )
    session.admit(frames=(frame,), correlation=correlation)
    return packet


def _ack(*, sequence, correlation_seq, frame_seq, cursor):
    return _control(
        "presentation.ack",
        {
            "authority_cursor": cursor_envelope_to_json(cursor),
            "correlation_seq": str(correlation_seq),
            "frame_seq": str(frame_seq),
        },
        sequence=sequence,
        direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    )


def test_generic_session_enforces_ready_credit_and_exact_cursor_ack() -> None:
    session = _session(maximum_in_flight_frames=1)
    assert session.open_bootstrap(current_tick=0).data == b"bootstrap-v2"
    cursor1 = envelope_cursor({"seq": 1, "tick": 1}, CODEC)
    cursor2 = envelope_cursor({"seq": 2, "tick": 2}, CODEC)
    _admit(session, correlation_seq=1, frame_seq=1, source_tick=1, cursor=cursor1)
    _admit(session, correlation_seq=2, frame_seq=2, source_tick=2, cursor=cursor2)
    assert session.drain_sendable(current_tick=0) == ()
    session.handle_client_control(_ready(), current_tick=1)
    assert [item.kind for item in session.drain_sendable(current_tick=1)] == [
        "frame",
        "correlation",
    ]
    session.handle_client_control(
        _ack(
            sequence=2,
            correlation_seq=1,
            frame_seq=1,
            cursor=cursor1,
        ),
        current_tick=2,
    )
    assert [item.frame_seq for item in session.drain_sendable(current_tick=2) if item.kind == "frame"] == [2]


def test_ready_timeout_is_independent_from_ack_timeout() -> None:
    session = _session(
        baseline_ready_timeout_ticks=2,
        acknowledgement_timeout_ticks=50,
    )
    session.open_bootstrap(current_tick=10)
    with pytest.raises(PresentationTransportError, match="ready timed out"):
        session.check_timeout(current_tick=13)
    assert not session.valid


def test_ack_timeout_starts_only_after_frames_are_in_flight() -> None:
    session = _session(
        baseline_ready_timeout_ticks=50,
        acknowledgement_timeout_ticks=2,
    )
    session.open_bootstrap(current_tick=0)
    session.handle_client_control(_ready(), current_tick=1)
    cursor = envelope_cursor({"seq": 1, "tick": 1}, CODEC)
    _admit(session, correlation_seq=1, frame_seq=1, source_tick=1, cursor=cursor)
    session.drain_sendable(current_tick=1)
    with pytest.raises(PresentationTransportError, match="acknowledgement timed out"):
        session.check_timeout(current_tick=4)
