from __future__ import annotations

import hashlib
from pathlib import Path
import struct

import pytest

from scene_engine.errors import (
    PresentationBackpressureError,
    PresentationTransportError,
)
from scene_engine.packet_codec import (
    encode_display_frame_packet,
    encode_scene_bootstrap_packet,
)
from scene_engine.presentation_control import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    encode_presentation_control,
)
from scene_engine.presentation_transport import (
    OrderedPresentationSession,
    PresentationTransportLimits,
)


FIXTURES = Path(__file__).parent / "fixtures"
BASELINE = {
    "state_stream_id": "stream:demo1",
    "state_epoch": "epoch:demo1",
    "snapshot_id": "snapshot:demo1",
    "state_seq": 0,
    "world_revision": 7,
}


def _inner(name: str) -> bytes:
    return bytes.fromhex((FIXTURES / name).read_text().strip())


def _frame_packet(frame_seq: int, source_tick: int, projection_id: int) -> bytes:
    frame = bytearray(_inner("presentation_frame_v2.hex"))
    struct.pack_into("<Q", frame, 24, frame_seq)
    struct.pack_into("<Q", frame, 32, source_tick)
    struct.pack_into("<Q", frame, 40, projection_id)
    return encode_display_frame_packet(bytes(frame))


def _session(
    *, initial_correlation_seq: int = 0, **limit_changes: int
) -> OrderedPresentationSession:
    limits = PresentationTransportLimits(**limit_changes)
    return OrderedPresentationSession(
        bootstrap_packet=encode_scene_bootstrap_packet(
            _inner("scene_bootstrap_v1.hex")
        ),
        viewer_scope="viewer:blue",
        profile_id="mw-presentation-v1",
        baseline=BASELINE,
        limits=limits,
        initial_correlation_seq=initial_correlation_seq,
    )


def _control(
    message_type: str,
    payload: dict,
    *,
    session_seq: int,
    direction: str,
) -> bytes:
    return encode_presentation_control(
        {
            "bootstrap_id": "11",
            "message_id": f"{message_type}:{session_seq}",
            "payload": payload,
            "protocol": "scene-display-control-v1",
            "scene_epoch": "9",
            "schema_version": 1,
            "session_seq": session_seq,
            "type": message_type,
            "viewer_scope": "viewer:blue",
        },
        direction=direction,
    )


def _ready(session_seq: int = 1) -> bytes:
    return _control(
        "presentation.ready",
        {"baseline": BASELINE, "profile_id": "mw-presentation-v1"},
        session_seq=session_seq,
        direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    )


def _correlation(packet: bytes, *, record_seq: int, cursor: dict) -> bytes:
    frame_seq = struct.unpack_from("<Q", packet, 24 + 24)[0]
    projection_id = struct.unpack_from("<Q", packet, 24 + 40)[0]
    return _control(
        "presentation.correlation",
        {
            "cursor": cursor,
            "frame_refs": [
                {
                    "frame_seq": str(frame_seq),
                    "sha256": hashlib.sha256(packet).hexdigest(),
                }
            ],
            "presentation_required": True,
            "projection_id": str(projection_id),
            "record_seq": str(record_seq),
        },
        session_seq=record_seq,
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    )


def _business_correlation(
    *, record_seq: int, cursor: dict, projection_id: int
) -> bytes:
    return _control(
        "presentation.correlation",
        {
            "cursor": cursor,
            "frame_refs": [],
            "presentation_required": False,
            "projection_id": str(projection_id),
            "record_seq": str(record_seq),
        },
        session_seq=record_seq,
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    )


def _ack(
    *, frame_seq: int, correlation_seq: int, cursor: dict, session_seq: int
) -> bytes:
    return _control(
        "presentation.ack",
        {
            "committed_cursor": cursor,
            "correlation_seq": str(correlation_seq),
            "frame_seq": str(frame_seq),
        },
        session_seq=session_seq,
        direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    )


def test_ready_barrier_credit_and_cumulative_commit_ack() -> None:
    session = _session(maximum_in_flight_frames=1)
    bootstrap = session.open_bootstrap()
    assert bootstrap.kind == "bootstrap"
    cursor1 = {**BASELINE, "state_seq": 1, "world_revision": 8}
    cursor2 = {**BASELINE, "state_seq": 2, "world_revision": 9}
    frame1 = _frame_packet(60, 60, 61)
    frame2 = _frame_packet(61, 61, 62)
    session.admit(
        frame_packets=(frame1,),
        correlation=_correlation(frame1, record_seq=1, cursor=cursor1),
    )
    session.admit(
        frame_packets=(frame2,),
        correlation=_correlation(frame2, record_seq=2, cursor=cursor2),
    )
    assert session.drain_sendable(current_tick=1) == ()

    session.handle_client_control(_ready(), current_tick=1)
    first = session.drain_sendable(current_tick=1)
    assert [item.kind for item in first] == ["frame", "correlation"]
    assert session.drain_sendable(current_tick=1) == ()

    session.handle_client_control(
        _ack(frame_seq=60, correlation_seq=1, cursor=cursor1, session_seq=2),
        current_tick=2,
    )
    second = session.drain_sendable(current_tick=2)
    assert [item.frame_seq for item in second if item.kind == "frame"] == [61]


def test_business_only_correlation_ack_uses_cumulative_frame_sequence() -> None:
    session = _session(maximum_in_flight_frames=1)
    session.open_bootstrap()
    frame_cursor = {**BASELINE, "state_seq": 1, "world_revision": 8}
    business_cursor = {**BASELINE, "state_seq": 2, "world_revision": 8}
    frame = _frame_packet(60, 60, 61)
    session.admit(
        frame_packets=(frame,),
        correlation=_correlation(frame, record_seq=1, cursor=frame_cursor),
    )
    session.admit(
        frame_packets=(),
        correlation=_business_correlation(
            record_seq=2,
            cursor=business_cursor,
            projection_id=61,
        ),
    )
    session.handle_client_control(_ready(), current_tick=1)
    sent = session.drain_sendable(current_tick=1)
    assert [item.kind for item in sent] == ["frame", "correlation", "correlation"]
    session.handle_client_control(
        _ack(
            frame_seq=60,
            correlation_seq=1,
            cursor=frame_cursor,
            session_seq=2,
        ),
        current_tick=2,
    )
    session.handle_client_control(
        _ack(
            frame_seq=60,
            correlation_seq=2,
            cursor=business_cursor,
            session_seq=3,
        ),
        current_tick=3,
    )
    assert session.queued_frames == 0


def test_checkpoint_session_can_start_at_a_later_correlation_sequence() -> None:
    session = _session(initial_correlation_seq=40)
    session.open_bootstrap()
    session.handle_client_control(_ready(), current_tick=1)
    frame = _frame_packet(frame_seq=90, source_tick=90, projection_id=90)
    session.admit(
        frame_packets=(frame,),
        correlation=_correlation(
            frame,
            record_seq=41,
            cursor={**BASELINE, "state_seq": 41, "world_revision": 41},
        ),
    )

    sent = session.drain_sendable(current_tick=1)
    assert [item.kind for item in sent] == ["frame", "correlation"]


def test_queue_hard_limit_never_overwrites_and_is_viewer_local() -> None:
    slow = _session(maximum_queued_frames=1, maximum_in_flight_frames=1)
    healthy = _session(maximum_queued_frames=2, maximum_in_flight_frames=1)
    packet1 = _frame_packet(60, 60, 61)
    packet2 = _frame_packet(61, 61, 62)
    cursor = {**BASELINE, "state_seq": 1, "world_revision": 8}
    for session in (slow, healthy):
        session.open_bootstrap()
        session.admit(
            frame_packets=(packet1,),
            correlation=_correlation(packet1, record_seq=1, cursor=cursor),
        )
    with pytest.raises(PresentationBackpressureError, match="queue is full"):
        slow.admit(
            frame_packets=(packet2,),
            correlation=_correlation(packet2, record_seq=2, cursor=cursor),
        )
    healthy.admit(
        frame_packets=(packet2,),
        correlation=_correlation(packet2, record_seq=2, cursor=cursor),
    )
    assert slow.queued_frames == 1
    assert healthy.queued_frames == 2


def test_timeout_invalidates_epoch_and_stale_control_is_rejected() -> None:
    session = _session(acknowledgement_timeout_ticks=2)
    session.open_bootstrap()
    packet = _frame_packet(60, 60, 61)
    cursor = {**BASELINE, "state_seq": 1, "world_revision": 8}
    session.admit(
        frame_packets=(packet,),
        correlation=_correlation(packet, record_seq=1, cursor=cursor),
    )
    session.handle_client_control(_ready(), current_tick=1)
    session.drain_sendable(current_tick=1)
    with pytest.raises(PresentationTransportError, match="timed out"):
        session.check_timeout(current_tick=4)
    assert not session.valid
    with pytest.raises(PresentationTransportError, match="invalid"):
        session.handle_client_control(_ready(session_seq=2), current_tick=4)


def test_ack_must_match_sent_correlation_and_store_cursor() -> None:
    session = _session()
    session.open_bootstrap()
    packet = _frame_packet(60, 60, 61)
    cursor = {**BASELINE, "state_seq": 1, "world_revision": 8}
    session.admit(
        frame_packets=(packet,),
        correlation=_correlation(packet, record_seq=1, cursor=cursor),
    )
    session.handle_client_control(_ready(), current_tick=1)
    session.drain_sendable(current_tick=1)
    with pytest.raises(PresentationTransportError, match="cursor mismatch"):
        session.handle_client_control(
            _ack(
                frame_seq=60,
                correlation_seq=1,
                cursor={**cursor, "world_revision": 99},
                session_seq=2,
            ),
            current_tick=2,
        )
