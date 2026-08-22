from __future__ import annotations

import hashlib
import json

import pytest

from scene_engine.authority_cursor import envelope_cursor
from scene_engine.binary_schema import PACKET_HEADER_BYTES
from scene_engine.errors import PresentationBackpressureError, PresentationTransportError
from scene_engine.presentation_control_v2 import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
)
from scene_engine.presentation_session import (
    OrderedPresentationSession,
    PresentationFramePacket,
    PresentationResetRequired,
    PresentationResetRequiredError,
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


def test_default_packet_limit_includes_the_sedf_header() -> None:
    maximum_wire_bytes = 8 * 1024 * 1024 + PACKET_HEADER_BYTES
    limits = PresentationSessionLimits()
    assert limits.maximum_packet_bytes == maximum_wire_bytes
    OrderedPresentationSession(
        bootstrap_packet=b"x" * maximum_wire_bytes,
        scene_epoch=1,
        bootstrap_id=2,
        viewer_scope="viewer:test",
        profile_id="test-profile@1",
        authority_baseline=BASELINE,
        limits=limits,
    )
    with pytest.raises(PresentationTransportError, match="bootstrap packet"):
        OrderedPresentationSession(
            bootstrap_packet=b"x" * (maximum_wire_bytes + 1),
            scene_epoch=1,
            bootstrap_id=2,
            viewer_scope="viewer:test",
            profile_id="test-profile@1",
            authority_baseline=BASELINE,
            limits=limits,
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


def _resync(*, sequence, last_frame_seq):
    return _control(
        "presentation.resync_request",
        {
            "last_frame_seq": (
                None if last_frame_seq is None else str(last_frame_seq)
            ),
            "reason": "client-state-invalid",
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
    with pytest.raises(
        PresentationResetRequiredError,
        match="ready timed out",
    ) as captured:
        session.check_timeout(current_tick=13)
    assert captured.value.reset_required.last_acknowledged_cursor is None
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
    session.drain_sendable(current_tick=100)
    session.check_timeout(current_tick=102)
    with pytest.raises(
        PresentationResetRequiredError,
        match="acknowledgement timed out",
    ) as captured:
        session.check_timeout(current_tick=103)
    assert captured.value.reset_required.reason == "ack-timeout"
    assert session.queued_frames == 0
    assert session.queued_bytes == 0


def test_retry_cache_retains_only_last_byte_identical_client_message() -> None:
    session = _session(maximum_in_flight_frames=1)
    session.open_bootstrap(current_tick=0)
    session.handle_client_control(_ready(), current_tick=1)
    last_ack = None
    last_cursor = None
    for sequence in range(1, 101):
        last_cursor = envelope_cursor({"seq": sequence, "tick": sequence}, CODEC)
        _admit(
            session,
            correlation_seq=sequence,
            frame_seq=sequence,
            source_tick=sequence,
            cursor=last_cursor,
        )
        session.drain_sendable(current_tick=sequence)
        last_ack = _ack(
            sequence=sequence + 1,
            correlation_seq=sequence,
            frame_seq=sequence,
            cursor=last_cursor,
        )
        session.handle_client_control(last_ack, current_tick=sequence)

    assert not hasattr(session, "_client_messages")
    assert session._last_client_message_bytes == last_ack
    assert session.handle_client_control(last_ack, current_tick=101) is None
    with pytest.raises(PresentationTransportError, match="sequence gap"):
        session.handle_client_control(_ready(), current_tick=101)
    changed_retry = _ack(
        sequence=101,
        correlation_seq=100,
        frame_seq=100,
        cursor=BASELINE,
    )
    with pytest.raises(PresentationTransportError, match="changed bytes"):
        session.handle_client_control(changed_retry, current_tick=101)


def test_reset_requirement_reports_cursor_without_allocating_next_identity() -> None:
    session = _session(maximum_in_flight_frames=1)
    session.open_bootstrap(current_tick=0)
    session.handle_client_control(_ready(), current_tick=1)
    cursor = envelope_cursor({"seq": 1, "tick": 1}, CODEC)
    _admit(session, correlation_seq=1, frame_seq=1, source_tick=1, cursor=cursor)
    session.drain_sendable(current_tick=1)
    session.handle_client_control(
        _ack(sequence=2, correlation_seq=1, frame_seq=1, cursor=cursor),
        current_tick=2,
    )

    required = session.handle_client_control(
        _resync(sequence=3, last_frame_seq=1),
        current_tick=2,
    )

    assert isinstance(required, PresentationResetRequired)
    assert required.required is True
    assert required.reason == "client-resync"
    assert required.scene_epoch == 1
    assert required.bootstrap_id == 2
    assert required.last_acknowledged_cursor == cursor
    assert required.last_acknowledged_frame_seq == 1
    assert required.last_acknowledged_correlation_seq == 1
    assert not hasattr(required, "next_scene_epoch")
    assert not hasattr(required, "next_bootstrap_id")
    assert not session.valid


def test_queue_retention_has_an_explicit_tick_span_limit() -> None:
    session = _session(maximum_queued_tick_span=1)
    for sequence in (1, 2):
        _admit(
            session,
            correlation_seq=sequence,
            frame_seq=sequence,
            source_tick=sequence,
            cursor=envelope_cursor({"seq": sequence, "tick": sequence}, CODEC),
        )
    with pytest.raises(PresentationTransportError, match="tick-span"):
        _admit(
            session,
            correlation_seq=3,
            frame_seq=3,
            source_tick=3,
            cursor=envelope_cursor({"seq": 3, "tick": 3}, CODEC),
        )


def test_one_correlation_cannot_exceed_the_in_flight_credit_window() -> None:
    session = _session(maximum_in_flight_frames=1)
    packets = (b"frame:1", b"frame:2")
    frames = tuple(
        PresentationFramePacket(sequence, 1, 1, packet)
        for sequence, packet in enumerate(packets, start=1)
    )
    correlation = _control(
        "presentation.correlation",
        {
            "authority_cursor": cursor_envelope_to_json(
                envelope_cursor({"seq": 1, "tick": 1}, CODEC)
            ),
            "correlation_seq": "1",
            "frame_refs": [
                {
                    "frame_seq": str(sequence),
                    "sha256": hashlib.sha256(packet).hexdigest(),
                }
                for sequence, packet in enumerate(packets, start=1)
            ],
            "presentation_required": True,
            "projection_id": "1",
            "source_tick": "1",
        },
        sequence=1,
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    )

    with pytest.raises(PresentationBackpressureError, match="credit window"):
        session.admit(frames=frames, correlation=correlation)
    assert session.queued_frames == 0
    assert session.queued_correlations == 0
