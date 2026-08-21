"""Reliable ordered flow control for the Missile War presentation lane."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import hashlib
from typing import Any, Deque, Dict, Iterable, Mapping, Tuple

from .errors import PresentationBackpressureError, PresentationTransportError
from .packet_codec import decode_presentation_frame_packet, decode_scene_bootstrap_packet
from .presentation_control import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    encode_presentation_control,
    parse_presentation_control,
)


@dataclass(frozen=True)
class PresentationTransportLimits:
    maximum_in_flight_frames: int = 8
    maximum_queued_frames: int = 256
    maximum_queued_bytes: int = 32 * 1024 * 1024
    acknowledgement_timeout_ticks: int = 600
    maximum_packet_bytes: int = 8 * 1024 * 1024
    maximum_entities: int = 10_000
    maximum_events: int = 1_024

    def __post_init__(self) -> None:
        for field in self.__dataclass_fields__:
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise PresentationTransportError(
                    "{} must be a positive integer".format(field)
                )
        if self.maximum_in_flight_frames > self.maximum_queued_frames:
            raise PresentationTransportError(
                "maximum_in_flight_frames cannot exceed maximum_queued_frames"
            )


@dataclass(frozen=True)
class PresentationTransmission:
    kind: str
    data: bytes
    frame_seq: int | None = None
    correlation_seq: int | None = None


@dataclass(frozen=True)
class _FrameRecord:
    frame_seq: int
    source_tick: int
    projection_id: int
    packet: bytes


@dataclass(frozen=True)
class _Admission:
    correlation_seq: int
    cursor: Mapping[str, Any]
    frames: Tuple[_FrameRecord, ...]
    correlation: bytes
    byte_count: int
    cumulative_frame_seq: int

    @property
    def last_frame_seq(self) -> int:
        return self.cumulative_frame_seq


class OrderedPresentationSession:
    """One viewer-scoped reliable queue with cumulative ACK credit."""

    def __init__(
        self,
        *,
        bootstrap_packet: bytes,
        viewer_scope: str,
        profile_id: str,
        baseline: Mapping[str, Any],
        limits: PresentationTransportLimits | None = None,
        initial_tick: int = 0,
        initial_correlation_seq: int = 0,
    ) -> None:
        self.limits = limits or PresentationTransportLimits()
        self._bootstrap_packet = bytes(bootstrap_packet)
        bootstrap = decode_scene_bootstrap_packet(
            self._bootstrap_packet,
            maximum_stored_bytes=self.limits.maximum_packet_bytes,
            maximum_uncompressed_bytes=self.limits.maximum_packet_bytes,
            maximum_bootstrap_bytes=self.limits.maximum_packet_bytes,
            maximum_static_nodes=100_000,
            maximum_topology_nodes=100_000,
            maximum_adjacencies=200_000,
            maximum_visual_types=10_000,
            maximum_animation_states=10_000,
        )
        if bootstrap.identity.viewer_scope != viewer_scope:
            raise PresentationTransportError("bootstrap viewer_scope mismatch")
        if bootstrap.identity.profile_id != profile_id:
            raise PresentationTransportError("bootstrap profile_id mismatch")
        if _cursor(bootstrap.identity) != _cursor(baseline):
            raise PresentationTransportError("bootstrap baseline mismatch")
        self.viewer_scope = viewer_scope
        self.profile_id = profile_id
        self.scene_epoch = bootstrap.scene_epoch
        self.bootstrap_id = bootstrap.bootstrap_id
        self.baseline = dict(baseline)
        self._pending: Deque[_Admission] = deque()
        self._in_flight: Deque[_Admission] = deque()
        self._queued_frames = 0
        self._queued_bytes = 0
        self._last_admitted_frame_seq: int | None = None
        self._last_admitted_tick: int | None = None
        if (
            isinstance(initial_correlation_seq, bool)
            or not isinstance(initial_correlation_seq, int)
            or initial_correlation_seq < 0
        ):
            raise PresentationTransportError(
                "initial_correlation_seq must be a non-negative integer"
            )
        self._last_correlation_seq = initial_correlation_seq
        self._last_acked_frame_seq = 0
        self._last_acked_correlation_seq = initial_correlation_seq
        self._last_progress_tick = _tick(initial_tick)
        self._client_messages: Dict[int, bytes] = {}
        self._last_client_session_seq = 0
        self._server_session_seq = 0
        self._ready = False
        self._valid = True
        self._bootstrap_opened = False

    @property
    def ready(self) -> bool:
        return self._ready and self._valid

    @property
    def valid(self) -> bool:
        return self._valid

    @property
    def queued_frames(self) -> int:
        return self._queued_frames

    @property
    def queued_bytes(self) -> int:
        return self._queued_bytes

    def open_bootstrap(self) -> PresentationTransmission:
        self._require_valid()
        if self._bootstrap_opened:
            raise PresentationTransportError("bootstrap was already opened")
        self._bootstrap_opened = True
        return PresentationTransmission("bootstrap", self._bootstrap_packet)

    def admit(
        self,
        *,
        frame_packets: Iterable[bytes],
        correlation: bytes,
    ) -> None:
        """Atomically append one correlation and all of its complete frames."""

        self._require_valid()
        correlation_raw = bytes(correlation)
        message = parse_presentation_control(
            correlation_raw, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
        )
        self._assert_envelope(message)
        if message["type"] != "presentation.correlation":
            raise PresentationTransportError("admission requires a correlation")
        payload = message["payload"]
        correlation_seq = int(payload["record_seq"])
        if correlation_seq != self._last_correlation_seq + 1:
            raise PresentationTransportError("correlation sequence gap")
        records = []
        for packet_value in frame_packets:
            packet = bytes(packet_value)
            frame = decode_presentation_frame_packet(
                packet,
                maximum_stored_bytes=self.limits.maximum_packet_bytes,
                maximum_uncompressed_bytes=self.limits.maximum_packet_bytes,
                maximum_frame_entities=self.limits.maximum_entities,
                maximum_frame_events=self.limits.maximum_events,
                maximum_frame_bytes=self.limits.maximum_packet_bytes,
            )
            if frame.header.scene_epoch != self.scene_epoch:
                raise PresentationTransportError("frame scene_epoch mismatch")
            if frame.header.bootstrap_id != self.bootstrap_id:
                raise PresentationTransportError("frame bootstrap_id mismatch")
            expected_frame_seq = (
                None
                if self._last_admitted_frame_seq is None and not records
                else (
                    records[-1].frame_seq + 1
                    if records
                    else self._last_admitted_frame_seq + 1
                )
            )
            if expected_frame_seq is not None and frame.frame_seq != expected_frame_seq:
                raise PresentationTransportError("frame sequence gap")
            prior_tick = records[-1].source_tick if records else self._last_admitted_tick
            if prior_tick is not None and frame.source_tick not in (prior_tick, prior_tick + 1):
                raise PresentationTransportError("source tick gap")
            records.append(
                _FrameRecord(
                    frame.frame_seq,
                    frame.source_tick,
                    frame.projection_id,
                    packet,
                )
            )
        refs = payload["frame_refs"]
        if payload["presentation_required"] != bool(records):
            raise PresentationTransportError("presentation_required mismatch")
        if len(refs) != len(records):
            raise PresentationTransportError("correlation frame count mismatch")
        if records and any(
            record.projection_id != int(payload["projection_id"])
            for record in records
        ):
            raise PresentationTransportError("correlation projection_id mismatch")
        for ref, record in zip(refs, records):
            if int(ref["frame_seq"]) != record.frame_seq:
                raise PresentationTransportError("correlation frame sequence mismatch")
            if ref["sha256"] != hashlib.sha256(record.packet).hexdigest():
                raise PresentationTransportError("correlation frame hash mismatch")
        added_frames = len(records)
        added_bytes = len(correlation_raw) + sum(len(record.packet) for record in records)
        if (
            self._queued_frames + added_frames > self.limits.maximum_queued_frames
            or self._queued_bytes + added_bytes > self.limits.maximum_queued_bytes
        ):
            raise PresentationBackpressureError("viewer presentation queue is full")
        admission = _Admission(
            correlation_seq=correlation_seq,
            cursor=dict(payload["cursor"]),
            frames=tuple(records),
            correlation=correlation_raw,
            byte_count=added_bytes,
            cumulative_frame_seq=(
                records[-1].frame_seq
                if records
                else (self._last_admitted_frame_seq or 0)
            ),
        )
        if admission.cumulative_frame_seq == 0:
            raise PresentationTransportError(
                "first presentation correlation must contain a frame"
            )
        self._pending.append(admission)
        self._queued_frames += added_frames
        self._queued_bytes += added_bytes
        self._last_correlation_seq = correlation_seq
        if records:
            self._last_admitted_frame_seq = records[-1].frame_seq
            self._last_admitted_tick = records[-1].source_tick

    def handle_client_control(
        self, data: bytes, *, current_tick: int
    ) -> bytes | None:
        self._require_valid()
        tick = _tick(current_tick)
        raw = bytes(data)
        message = parse_presentation_control(
            raw, direction=PRESENTATION_CONTROL_CLIENT_TO_SERVER
        )
        self._assert_envelope(message)
        if self._is_duplicate(message, raw):
            return None
        message_type = message["type"]
        if message_type == "presentation.ready":
            if not self._bootstrap_opened:
                raise PresentationTransportError("ready arrived before bootstrap")
            if self._ready:
                raise PresentationTransportError("presentation is already ready")
            if message["payload"]["profile_id"] != self.profile_id:
                raise PresentationTransportError("ready profile mismatch")
            if _cursor(message["payload"]["baseline"]) != _cursor(self.baseline):
                raise PresentationTransportError("ready baseline mismatch")
            self._ready = True
            self._last_progress_tick = tick
            return None
        if message_type == "presentation.resync_request":
            return self._invalidate("client-resync")
        if not self._ready:
            raise PresentationTransportError("ack arrived before ready")
        self._ack(message, tick=tick)
        return None

    def drain_sendable(self, *, current_tick: int) -> Tuple[PresentationTransmission, ...]:
        self._require_valid()
        self.check_timeout(current_tick=current_tick)
        if not self._ready:
            return ()
        in_flight_frames = sum(len(item.frames) for item in self._in_flight)
        available = self.limits.maximum_in_flight_frames - in_flight_frames
        sent = []
        while self._pending:
            candidate = self._pending[0]
            if len(candidate.frames) > available:
                break
            self._pending.popleft()
            self._in_flight.append(candidate)
            for frame in candidate.frames:
                sent.append(
                    PresentationTransmission(
                        "frame", frame.packet, frame_seq=frame.frame_seq
                    )
                )
            sent.append(
                PresentationTransmission(
                    "correlation",
                    candidate.correlation,
                    correlation_seq=candidate.correlation_seq,
                )
            )
            available -= len(candidate.frames)
        return tuple(sent)

    def check_timeout(self, *, current_tick: int) -> None:
        tick = _tick(current_tick)
        if self._in_flight and (
            tick - self._last_progress_tick > self.limits.acknowledgement_timeout_ticks
        ):
            self._invalidate("ack-timeout")
            raise PresentationTransportError("presentation acknowledgement timed out")

    def _ack(self, message: Mapping[str, Any], *, tick: int) -> None:
        payload = message["payload"]
        frame_seq = int(payload["frame_seq"])
        correlation_seq = int(payload["correlation_seq"])
        if (
            frame_seq < self._last_acked_frame_seq
            or correlation_seq < self._last_acked_correlation_seq
        ):
            raise PresentationTransportError("cumulative ack moved backwards")
        target = None
        for admission in self._in_flight:
            if admission.correlation_seq == correlation_seq:
                target = admission
                break
        if target is None or target.last_frame_seq != frame_seq:
            raise PresentationTransportError("ack exceeds the sent window")
        if _cursor(payload["committed_cursor"]) != _cursor(target.cursor):
            raise PresentationTransportError("ack cursor mismatch")
        while self._in_flight and self._in_flight[0].correlation_seq <= correlation_seq:
            admission = self._in_flight.popleft()
            self._queued_frames -= len(admission.frames)
            self._queued_bytes -= admission.byte_count
        self._last_acked_frame_seq = frame_seq
        self._last_acked_correlation_seq = correlation_seq
        self._last_progress_tick = tick

    def _is_duplicate(self, message: Mapping[str, Any], raw: bytes) -> bool:
        sequence = int(message["session_seq"])
        existing = self._client_messages.get(sequence)
        if existing is not None:
            if existing != raw:
                raise PresentationTransportError("session sequence retry changed bytes")
            return True
        if sequence != self._last_client_session_seq + 1:
            raise PresentationTransportError("client session sequence gap")
        self._client_messages[sequence] = raw
        self._last_client_session_seq = sequence
        return False

    def _assert_envelope(self, message: Mapping[str, Any]) -> None:
        if message["viewer_scope"] != self.viewer_scope:
            raise PresentationTransportError("viewer_scope mismatch")
        if int(message["scene_epoch"]) != self.scene_epoch:
            raise PresentationTransportError("stale scene_epoch")
        if int(message["bootstrap_id"]) != self.bootstrap_id:
            raise PresentationTransportError("stale bootstrap_id")

    def _invalidate(self, reason: str) -> bytes:
        self._valid = False
        self._ready = False
        self._server_session_seq += 1
        return encode_presentation_control(
            {
                "bootstrap_id": str(self.bootstrap_id),
                "message_id": "presentation-reset-{}".format(self._server_session_seq),
                "payload": {
                    "next_bootstrap_id": str(self.bootstrap_id + 1),
                    "next_scene_epoch": str(self.scene_epoch + 1),
                    "reason": reason,
                },
                "protocol": "scene-display-control-v1",
                "scene_epoch": str(self.scene_epoch),
                "schema_version": 1,
                "session_seq": self._server_session_seq,
                "type": "presentation.reset",
                "viewer_scope": self.viewer_scope,
            },
            direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
        )

    def _require_valid(self) -> None:
        if not self._valid:
            raise PresentationTransportError("presentation session is invalid")


def _cursor(value: Any) -> Tuple[str, str, str, int, int]:
    if hasattr(value, "state_stream_id"):
        return (
            str(value.state_stream_id),
            str(value.state_epoch),
            str(value.snapshot_id),
            int(value.state_seq),
            int(value.world_revision),
        )
    return (
        str(value["state_stream_id"]),
        str(value["state_epoch"]),
        str(value["snapshot_id"]),
        int(value["state_seq"]),
        int(value["world_revision"]),
    )


def _tick(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PresentationTransportError("current_tick must be non-negative")
    return value
