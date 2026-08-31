"""One cumulative-ACK session for the unified Engine state stream."""

from __future__ import annotations

from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Any, Callable

from .errors import SessionBackpressureError, SessionError
from .wire import DEFAULT_ENGINE_LIMITS, EngineLimits


@dataclass(frozen=True, slots=True)
class PacketRef:
    raw_bytes: bytes
    stream_id: str
    commit_seq: int
    source_tick: int
    world_revision: int
    last_command_seq: int
    checkpoint: bool = False

    @property
    def byte_length(self) -> int:
        return len(self.raw_bytes)


@dataclass(frozen=True, slots=True)
class InputOutcome:
    request_bytes: bytes
    response_bytes: bytes | None
    committed_seq: int | None


@dataclass(frozen=True, slots=True)
class SessionHealth:
    client_id: Any
    stream_id: str
    baseline_commit_seq: int
    baseline_command_seq: int
    last_sent_seq: int
    last_sent_command_seq: int
    last_acked_seq: int
    last_acked_command_seq: int
    in_flight_count: int
    in_flight_bytes: int
    pending_count: int
    pending_bytes: int
    pending_input_count: int
    closed: bool
    close_reason: str | None


class ClientSession:
    """Bounded per-client state; packet byte objects are shared immutable refs."""

    def __init__(
        self,
        *,
        client_id: Any,
        stream_id: str,
        baseline_commit_seq: int,
        baseline_command_seq: int,
        current_tick: int,
        send: Callable[[Any, bytes], Any],
        close: Callable[[Any, str], Any],
        limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
    ) -> None:
        if not isinstance(stream_id, str) or not stream_id:
            raise SessionError("stream_id must be non-empty")
        if (
            isinstance(baseline_commit_seq, bool)
            or not isinstance(baseline_commit_seq, int)
            or baseline_commit_seq < 0
        ):
            raise SessionError("baseline_commit_seq must be non-negative")
        if (
            isinstance(baseline_command_seq, bool)
            or not isinstance(baseline_command_seq, int)
            or baseline_command_seq < 0
        ):
            raise SessionError("baseline_command_seq must be non-negative")
        if not callable(send) or not callable(close):
            raise SessionError("session send and close ports must be callable")
        self.client_id = client_id
        self.stream_id = stream_id
        self.baseline_commit_seq = baseline_commit_seq
        self.baseline_command_seq = baseline_command_seq
        self.last_sent_seq = baseline_commit_seq - 1
        self.last_sent_command_seq = baseline_command_seq - 1
        self.last_acked_seq = baseline_commit_seq - 1
        self.last_acked_command_seq = baseline_command_seq - 1
        self.last_progress_tick = current_tick
        self._last_queued_seq = baseline_commit_seq - 1
        self._last_queued_command_seq = baseline_command_seq
        self._pending: deque[PacketRef] = deque()
        self._in_flight: deque[PacketRef] = deque()
        self._pending_bytes = 0
        self._in_flight_bytes = 0
        self._pending_input_count = 0
        self._input_ledger: OrderedDict[str, InputOutcome] = OrderedDict()
        self._send = send
        self._close = close
        self._limits = limits
        self._closed = False
        self._close_reason: str | None = None

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def health(self) -> SessionHealth:
        return SessionHealth(
            self.client_id,
            self.stream_id,
            self.baseline_commit_seq,
            self.baseline_command_seq,
            self.last_sent_seq,
            self.last_sent_command_seq,
            self.last_acked_seq,
            self.last_acked_command_seq,
            len(self._in_flight),
            self._in_flight_bytes,
            len(self._pending),
            self._pending_bytes,
            self._pending_input_count,
            self._closed,
            self._close_reason,
        )

    def enqueue(self, packet: PacketRef, *, current_tick: int) -> None:
        self._require_open()
        if not isinstance(packet, PacketRef) or packet.stream_id != self.stream_id:
            raise SessionError("packet does not belong to this session stream")
        expected = self._last_queued_seq + 1
        if packet.checkpoint:
            if (
                self._pending
                or self._in_flight
                or packet.commit_seq != self.baseline_commit_seq
                or packet.last_command_seq != self.baseline_command_seq
            ):
                raise SessionError("checkpoint is not the session baseline")
        elif packet.commit_seq != expected:
            raise SessionError("session packet sequence has a gap")
        elif packet.last_command_seq < self._last_queued_command_seq:
            raise SessionError("session command sequence regressed")
        total_bytes = self._pending_bytes + self._in_flight_bytes + packet.byte_length
        if total_bytes > self._limits.maximum_session_pending_bytes:
            raise SessionBackpressureError("session pending byte limit exceeded")
        self._pending.append(packet)
        self._pending_bytes += packet.byte_length
        self._last_queued_seq = packet.commit_seq
        self._last_queued_command_seq = packet.last_command_seq
        self.flush(current_tick=current_tick)

    def flush(self, *, current_tick: int) -> None:
        self._require_open()
        while self._pending and len(self._in_flight) < self._limits.maximum_in_flight_commits:
            packet = self._pending.popleft()
            self._pending_bytes -= packet.byte_length
            self._in_flight.append(packet)
            self._in_flight_bytes += packet.byte_length
            self.last_sent_seq = packet.commit_seq
            self.last_sent_command_seq = packet.last_command_seq
            if len(self._in_flight) == 1:
                self.last_progress_tick = current_tick
            try:
                accepted = self._send(self.client_id, packet.raw_bytes)
                if accepted is False:
                    raise SessionBackpressureError("transport rejected packet")
            except BaseException as exc:
                self.close("transport-send-failed")
                if not isinstance(exc, Exception):
                    raise
                raise SessionError("transport send failed") from exc

    def acknowledge(
        self,
        *,
        stream_id: str,
        commit_seq: int,
        last_command_seq: int,
        current_tick: int,
    ) -> None:
        self._require_open()
        if stream_id != self.stream_id:
            raise SessionError("ACK stream does not match session")
        if isinstance(commit_seq, bool) or not isinstance(commit_seq, int):
            raise SessionError("ACK commit_seq is invalid")
        if (
            isinstance(last_command_seq, bool)
            or not isinstance(last_command_seq, int)
            or last_command_seq < 0
        ):
            raise SessionError("ACK last_command_seq is invalid")
        if commit_seq < self.last_acked_seq:
            raise SessionError("ACK regressed")
        if commit_seq > self.last_sent_seq:
            raise SessionError("ACK is ahead of the sent cursor")
        if commit_seq == self.last_acked_seq:
            if last_command_seq != self.last_acked_command_seq:
                raise SessionError("duplicate ACK command cursor differs")
            return
        target = next(
            (
                packet
                for packet in self._in_flight
                if packet.commit_seq == commit_seq
            ),
            None,
        )
        if target is None:
            raise SessionError("ACK does not identify a sent state packet")
        if target.last_command_seq != last_command_seq:
            raise SessionError("ACK command cursor does not match state packet")
        while self._in_flight and self._in_flight[0].commit_seq <= commit_seq:
            packet = self._in_flight.popleft()
            self._in_flight_bytes -= packet.byte_length
        self.last_acked_seq = commit_seq
        self.last_acked_command_seq = last_command_seq
        self.last_progress_tick = current_tick
        self.flush(current_tick=current_tick)

    def check_timeout(self, *, current_tick: int) -> None:
        self._require_open()
        if self._in_flight and current_tick - self.last_progress_tick >= self._limits.ack_timeout_ticks:
            raise SessionError("session ACK progress timed out")

    def send_ephemeral(self, raw_bytes: bytes) -> None:
        self._require_open()
        raw = bytes(raw_bytes)
        if len(raw) > self._limits.maximum_packet_bytes:
            raise SessionError("ephemeral packet exceeds maximum_packet_bytes")
        try:
            accepted = self._send(self.client_id, raw)
            if accepted is False:
                raise SessionBackpressureError("transport rejected ephemeral packet")
        except BaseException as exc:
            self.close("transport-send-failed")
            if not isinstance(exc, Exception):
                raise
            raise SessionError("transport send failed") from exc

    def begin_input(self) -> None:
        self._require_open()
        if self._pending_input_count >= self._limits.maximum_pending_inputs_per_client:
            raise SessionBackpressureError("pending input limit exceeded")
        self._pending_input_count += 1

    def finish_input(self) -> None:
        if self._pending_input_count <= 0:
            raise SessionError("pending input accounting underflow")
        self._pending_input_count -= 1

    def previous_input(self, input_id: str, request_bytes: bytes) -> InputOutcome | None:
        outcome = self._input_ledger.get(input_id)
        if outcome is None:
            return None
        if outcome.request_bytes != bytes(request_bytes):
            raise SessionError("input-id-conflict")
        self._input_ledger.move_to_end(input_id)
        return outcome

    def references_packet(self, packet: PacketRef) -> bool:
        """Return whether eviction would leave this session owning the body."""

        return any(item is packet for item in self._pending) or any(
            item is packet for item in self._in_flight
        )

    def remember_input(self, input_id: str, outcome: InputOutcome) -> None:
        self._require_open()
        if input_id in self._input_ledger:
            raise SessionError("input outcome is already recorded")
        self._input_ledger[input_id] = outcome
        while len(self._input_ledger) > self._limits.maximum_pending_inputs_per_client:
            self._input_ledger.popitem(last=False)

    def close(self, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        self._close_reason = reason
        self._pending.clear()
        self._in_flight.clear()
        self._input_ledger.clear()
        self._pending_bytes = 0
        self._in_flight_bytes = 0
        self._pending_input_count = 0
        try:
            self._close(self.client_id, reason)
        except Exception:
            pass

    def _require_open(self) -> None:
        if self._closed:
            raise SessionError("session is closed")


__all__ = [
    "ClientSession",
    "InputOutcome",
    "PacketRef",
    "SessionHealth",
]
