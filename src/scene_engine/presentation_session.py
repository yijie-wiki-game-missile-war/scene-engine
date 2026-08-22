"""Generic reliable ordered presentation session for live and Replay."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import hashlib
from typing import Any, Deque, Dict, Iterable, Tuple

from .authority_cursor import AuthorityCursorEnvelope
from .binary_schema import PACKET_HEADER_BYTES
from .errors import PresentationBackpressureError, PresentationTransportError
from .presentation_control_v2 import (
    PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_from_json,
    parse_presentation_control_v2,
)


DEFAULT_MAXIMUM_PRESENTATION_PAYLOAD_BYTES = 8 * 1024 * 1024
DEFAULT_MAXIMUM_PRESENTATION_PACKET_BYTES = (
    DEFAULT_MAXIMUM_PRESENTATION_PAYLOAD_BYTES + PACKET_HEADER_BYTES
)


@dataclass(frozen=True)
class PresentationSessionLimits:
    maximum_in_flight_frames: int = 8
    maximum_queued_correlations: int = 256
    maximum_queued_frames: int = 256
    maximum_queued_bytes: int = 32 * 1024 * 1024
    maximum_queued_tick_span: int = 600
    baseline_ready_timeout_ticks: int = 300
    acknowledgement_timeout_ticks: int = 600
    maximum_packet_bytes: int = DEFAULT_MAXIMUM_PRESENTATION_PACKET_BYTES

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
class PresentationFramePacket:
    frame_seq: int
    source_tick: int
    projection_id: int
    packet: bytes

    def __post_init__(self) -> None:
        for field in ("frame_seq", "source_tick", "projection_id"):
            value = getattr(self, field)
            minimum = 0 if field == "source_tick" else 1
            if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
                raise PresentationTransportError("{} is invalid".format(field))
        try:
            packet = bytes(memoryview(self.packet).cast("B"))
        except (TypeError, ValueError) as exc:
            raise PresentationTransportError("frame packet must be bytes") from exc
        if not packet:
            raise PresentationTransportError("frame packet must not be empty")
        object.__setattr__(self, "packet", packet)


@dataclass(frozen=True)
class PresentationTransmission:
    kind: str
    data: bytes
    frame_seq: int | None = None
    correlation_seq: int | None = None


@dataclass(frozen=True)
class PresentationResetRequired:
    """Product-neutral description of a required presentation reset.

    The generic session deliberately does not allocate the next scene epoch or
    Bootstrap identity.  A product coordinator uses this cursor to choose and
    inject the next identities when it creates the replacement session and
    encodes any product-facing reset control.
    """

    reason: str
    scene_epoch: int
    bootstrap_id: int
    viewer_scope: str
    last_acknowledged_cursor: AuthorityCursorEnvelope | None
    last_acknowledged_frame_seq: int
    last_acknowledged_correlation_seq: int
    required: bool = field(default=True, init=False)


class PresentationResetRequiredError(PresentationTransportError):
    """A timeout invalidated one session and produced reset metadata."""

    def __init__(
        self,
        message: str,
        reset_required: PresentationResetRequired,
    ) -> None:
        super().__init__(message)
        self.reset_required = reset_required


@dataclass(frozen=True)
class _Admission:
    correlation_seq: int
    authority_cursor: AuthorityCursorEnvelope
    frames: Tuple[PresentationFramePacket, ...]
    correlation: bytes
    byte_count: int
    cumulative_frame_seq: int
    source_tick: int


class OrderedPresentationSession:
    """Transport-neutral viewer session with separate ready and ACK deadlines."""

    def __init__(
        self,
        *,
        bootstrap_packet: bytes,
        scene_epoch: int,
        bootstrap_id: int,
        viewer_scope: str,
        profile_id: str,
        authority_baseline: AuthorityCursorEnvelope,
        limits: PresentationSessionLimits | None = None,
        initial_tick: int = 0,
        initial_correlation_seq: int = 0,
        initial_frame_seq: int = 0,
    ) -> None:
        self.limits = limits or PresentationSessionLimits()
        self._bootstrap_packet = _bytes(bootstrap_packet, "bootstrap packet")
        if len(self._bootstrap_packet) > self.limits.maximum_packet_bytes:
            raise PresentationTransportError("bootstrap packet exceeds byte limit")
        self.scene_epoch = _positive(scene_epoch, "scene_epoch")
        self.bootstrap_id = _positive(bootstrap_id, "bootstrap_id")
        self.viewer_scope = _text(viewer_scope, "viewer_scope")
        self.profile_id = _text(profile_id, "profile_id")
        if not isinstance(authority_baseline, AuthorityCursorEnvelope):
            raise PresentationTransportError(
                "authority_baseline must be AuthorityCursorEnvelope"
            )
        self.authority_baseline = authority_baseline
        self._pending: Deque[_Admission] = deque()
        self._in_flight: Deque[_Admission] = deque()
        self._queued_frames = 0
        self._queued_bytes = 0
        self._last_admitted_frame_seq = _non_negative(initial_frame_seq, "initial_frame_seq")
        self._last_admitted_tick: int | None = None
        self._last_correlation_seq = _non_negative(
            initial_correlation_seq, "initial_correlation_seq"
        )
        self._last_acked_frame_seq = initial_frame_seq
        self._last_acked_correlation_seq = initial_correlation_seq
        self._last_acked_authority_cursor: AuthorityCursorEnvelope | None = None
        tick = _non_negative(initial_tick, "initial_tick")
        self._opened_tick: int | None = None
        self._last_progress_tick = tick
        self._last_client_session_seq = 0
        self._last_client_message_bytes: bytes | None = None
        self._reset_required: PresentationResetRequired | None = None
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
    def queued_correlations(self) -> int:
        return len(self._pending) + len(self._in_flight)

    @property
    def queued_frames(self) -> int:
        return self._queued_frames

    @property
    def queued_bytes(self) -> int:
        return self._queued_bytes

    @property
    def reset_required(self) -> PresentationResetRequired | None:
        return self._reset_required

    def open_bootstrap(self, *, current_tick: int) -> PresentationTransmission:
        self._require_valid()
        if self._bootstrap_opened:
            raise PresentationTransportError("bootstrap was already opened")
        tick = _non_negative(current_tick, "current_tick")
        self._bootstrap_opened = True
        self._opened_tick = tick
        self._last_progress_tick = tick
        return PresentationTransmission("bootstrap", self._bootstrap_packet)

    def admit(
        self,
        *,
        frames: Iterable[PresentationFramePacket],
        correlation: bytes,
    ) -> None:
        """Atomically append one canonical correlation and its exact frame bytes."""

        self._require_valid()
        raw = _bytes(correlation, "correlation")
        message = parse_presentation_control_v2(
            raw, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
        )
        self._assert_envelope(message)
        if message["type"] != "presentation.correlation":
            raise PresentationTransportError("admission requires a correlation")
        payload = message["payload"]
        correlation_seq = int(payload["correlation_seq"])
        if correlation_seq != self._last_correlation_seq + 1:
            raise PresentationTransportError("correlation sequence gap")
        records = tuple(frames)
        if len(records) > self.limits.maximum_in_flight_frames:
            raise PresentationBackpressureError(
                "correlation frame batch exceeds in-flight credit window"
            )
        for record in records:
            if not isinstance(record, PresentationFramePacket):
                raise PresentationTransportError(
                    "frames must contain PresentationFramePacket values"
                )
            if len(record.packet) > self.limits.maximum_packet_bytes:
                raise PresentationTransportError("frame packet exceeds byte limit")
        source_tick = int(payload["source_tick"])
        if self._last_admitted_tick is not None and source_tick not in (
            self._last_admitted_tick,
            self._last_admitted_tick + 1,
        ):
            raise PresentationTransportError("source tick gap")
        previous_frame = self._last_admitted_frame_seq
        for record in records:
            if record.frame_seq != previous_frame + 1:
                raise PresentationTransportError("frame sequence gap")
            if record.source_tick != source_tick:
                raise PresentationTransportError("correlation source_tick mismatch")
            if record.projection_id != int(payload["projection_id"]):
                raise PresentationTransportError("correlation projection_id mismatch")
            previous_frame = record.frame_seq
        refs = payload["frame_refs"]
        if payload["presentation_required"] != bool(records):
            raise PresentationTransportError("presentation_required mismatch")
        if len(refs) != len(records):
            raise PresentationTransportError("correlation frame count mismatch")
        for ref, record in zip(refs, records):
            if int(ref["frame_seq"]) != record.frame_seq:
                raise PresentationTransportError("correlation frame sequence mismatch")
            if ref["sha256"] != hashlib.sha256(record.packet).hexdigest():
                raise PresentationTransportError("correlation frame hash mismatch")
        added_bytes = len(raw) + sum(len(record.packet) for record in records)
        if (
            self.queued_correlations + 1 > self.limits.maximum_queued_correlations
            or self._queued_frames + len(records) > self.limits.maximum_queued_frames
            or self._queued_bytes + added_bytes > self.limits.maximum_queued_bytes
        ):
            raise PresentationBackpressureError("viewer presentation queue is full")
        oldest_tick = self._oldest_queued_tick()
        if (
            oldest_tick is not None
            and source_tick - oldest_tick > self.limits.maximum_queued_tick_span
        ):
            raise PresentationBackpressureError(
                "viewer presentation queue exceeds tick-span limit"
            )
        cursor = cursor_envelope_from_json(payload["authority_cursor"])
        admission = _Admission(
            correlation_seq,
            cursor,
            records,
            raw,
            added_bytes,
            previous_frame,
            source_tick,
        )
        if admission.cumulative_frame_seq == 0:
            raise PresentationTransportError(
                "first presentation correlation must contain a frame"
            )
        self._pending.append(admission)
        self._queued_frames += len(records)
        self._queued_bytes += added_bytes
        self._last_correlation_seq = correlation_seq
        if records:
            self._last_admitted_frame_seq = records[-1].frame_seq
        self._last_admitted_tick = source_tick

    def handle_client_control(
        self, data: bytes, *, current_tick: int
    ) -> PresentationResetRequired | None:
        self._require_valid()
        tick = _non_negative(current_tick, "current_tick")
        raw = _bytes(data, "control")
        message = parse_presentation_control_v2(
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
            baseline = cursor_envelope_from_json(
                message["payload"]["authority_baseline"]
            )
            if baseline != self.authority_baseline:
                raise PresentationTransportError("ready authority baseline mismatch")
            self._ready = True
            self._last_acked_authority_cursor = self.authority_baseline
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
        started_ack_window = not self._in_flight
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
        if started_ack_window and self._in_flight:
            self._last_progress_tick = _non_negative(current_tick, "current_tick")
        return tuple(sent)

    def check_timeout(self, *, current_tick: int) -> None:
        tick = _non_negative(current_tick, "current_tick")
        if (
            self._bootstrap_opened
            and not self._ready
            and self._opened_tick is not None
            and tick - self._opened_tick > self.limits.baseline_ready_timeout_ticks
        ):
            reset_required = self._invalidate("ready-timeout")
            raise PresentationResetRequiredError(
                "presentation ready timed out", reset_required
            )
        if self._in_flight and (
            tick - self._last_progress_tick
            > self.limits.acknowledgement_timeout_ticks
        ):
            reset_required = self._invalidate("ack-timeout")
            raise PresentationResetRequiredError(
                "presentation acknowledgement timed out", reset_required
            )

    def _ack(self, message: Dict[str, Any], *, tick: int) -> None:
        payload = message["payload"]
        frame_seq = int(payload["frame_seq"])
        correlation_seq = int(payload["correlation_seq"])
        if (
            frame_seq < self._last_acked_frame_seq
            or correlation_seq < self._last_acked_correlation_seq
        ):
            raise PresentationTransportError("cumulative ack moved backwards")
        target = next(
            (
                admission
                for admission in self._in_flight
                if admission.correlation_seq == correlation_seq
            ),
            None,
        )
        if target is None or target.cumulative_frame_seq != frame_seq:
            raise PresentationTransportError("ack exceeds the sent window")
        cursor_value = payload["authority_cursor"]
        cursor = None if cursor_value is None else cursor_envelope_from_json(cursor_value)
        if cursor != target.authority_cursor:
            raise PresentationTransportError("ack authority cursor mismatch")
        while self._in_flight and self._in_flight[0].correlation_seq <= correlation_seq:
            admission = self._in_flight.popleft()
            self._queued_frames -= len(admission.frames)
            self._queued_bytes -= admission.byte_count
        self._last_acked_frame_seq = frame_seq
        self._last_acked_correlation_seq = correlation_seq
        self._last_acked_authority_cursor = target.authority_cursor
        self._last_progress_tick = tick

    def _is_duplicate(self, message: Dict[str, Any], raw: bytes) -> bool:
        sequence = int(message["session_seq"])
        if sequence == self._last_client_session_seq:
            if self._last_client_message_bytes != raw:
                raise PresentationTransportError(
                    "session sequence retry changed bytes"
                )
            return True
        if sequence != self._last_client_session_seq + 1:
            raise PresentationTransportError("client session sequence gap")
        self._last_client_session_seq = sequence
        self._last_client_message_bytes = raw
        return False

    def _assert_envelope(self, message: Dict[str, Any]) -> None:
        if message["viewer_scope"] != self.viewer_scope:
            raise PresentationTransportError("viewer_scope mismatch")
        if int(message["scene_epoch"]) != self.scene_epoch:
            raise PresentationTransportError("stale scene_epoch")
        if int(message["bootstrap_id"]) != self.bootstrap_id:
            raise PresentationTransportError("stale bootstrap_id")

    def _invalidate(self, reason: str) -> PresentationResetRequired:
        if self._reset_required is not None:
            return self._reset_required
        self._valid = False
        self._ready = False
        self._pending.clear()
        self._in_flight.clear()
        self._queued_frames = 0
        self._queued_bytes = 0
        self._reset_required = PresentationResetRequired(
            reason=_text(reason, "reset reason"),
            scene_epoch=self.scene_epoch,
            bootstrap_id=self.bootstrap_id,
            viewer_scope=self.viewer_scope,
            last_acknowledged_cursor=self._last_acked_authority_cursor,
            last_acknowledged_frame_seq=self._last_acked_frame_seq,
            last_acknowledged_correlation_seq=self._last_acked_correlation_seq,
        )
        return self._reset_required

    def _oldest_queued_tick(self) -> int | None:
        if self._in_flight:
            return self._in_flight[0].source_tick
        if self._pending:
            return self._pending[0].source_tick
        return None

    def _require_valid(self) -> None:
        if not self._valid:
            raise PresentationTransportError("presentation session is invalid")


def _bytes(value: Any, label: str) -> bytes:
    try:
        raw = bytes(memoryview(value).cast("B"))
    except (TypeError, ValueError) as exc:
        raise PresentationTransportError("{} must be bytes".format(label)) from exc
    if not raw:
        raise PresentationTransportError("{} must not be empty".format(label))
    return raw


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise PresentationTransportError("{} is invalid".format(label))
    return value


def _positive(value: Any, label: str) -> int:
    result = _non_negative(value, label)
    if result == 0:
        raise PresentationTransportError("{} must be positive".format(label))
    return result


def _non_negative(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PresentationTransportError("{} must be non-negative".format(label))
    return value


__all__ = [
    "DEFAULT_MAXIMUM_PRESENTATION_PACKET_BYTES",
    "DEFAULT_MAXIMUM_PRESENTATION_PAYLOAD_BYTES",
    "OrderedPresentationSession",
    "PresentationFramePacket",
    "PresentationResetRequired",
    "PresentationResetRequiredError",
    "PresentationSessionLimits",
    "PresentationTransmission",
]
