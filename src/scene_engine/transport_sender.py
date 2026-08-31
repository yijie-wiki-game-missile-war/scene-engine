"""Private bounded worker for serialized Engine transport calls.

The runtime owner submits immutable packet bodies and later drains outcomes.  The
worker never receives a Runtime or ClientSession reference, and it is the only
thread that invokes the transport port.
"""

from __future__ import annotations

from collections import deque
from contextvars import Context
from dataclasses import dataclass
import math
from queue import Empty, SimpleQueue
import threading
from typing import Any, Literal, Protocol


TransportOperationKind = Literal["send", "close"]
TransportResultStatus = Literal["completed", "failed", "cancelled"]


class _TransportPort(Protocol):
    def send(self, client_id: Any, packet_bytes: bytes) -> Any: ...

    def close(self, client_id: Any, reason: str) -> Any: ...


class TransportSenderError(RuntimeError):
    """The private transport worker was used in an invalid state."""


class TransportRejectedError(TransportSenderError):
    """The transport explicitly rejected an accepted send operation."""


@dataclass(frozen=True, slots=True)
class TransportResult:
    """One terminal outcome copied into the owner-drained inbox."""

    client_id: Any
    epoch: int
    token: Any
    kind: TransportOperationKind
    status: TransportResultStatus
    error: BaseException | None = None


@dataclass(frozen=True, slots=True)
class TransportSenderHealth:
    """Immutable diagnostic snapshot of worker-owned accounting."""

    state: str
    pending_send_count: int
    pending_send_bytes: int
    pending_control_count: int
    active_epoch_count: int
    worker_alive: bool


@dataclass(frozen=True, slots=True)
class _Operation:
    client_id: Any
    epoch: int
    token: Any
    kind: TransportOperationKind
    packet_bytes: bytes | None = None
    reason: str | None = None
    forced: bool = False


_CREATED = "created"
_RUNNING = "running"
_DRAINING = "draining"
_CANCELLING = "cancelling"
_STOPPED = "stopped"

_OPEN = "open"
_CLOSING = "closing"
_CANCELLED = "cancelled"
_CLOSED = "closed"
_FAILED = "failed"


class TransportSender:
    """Serialize bounded, non-blocking submissions onto one transport worker.

    ``maximum_pending_count`` and ``maximum_pending_bytes`` account for SEND
    operations from admission through terminal completion, including a SEND
    currently blocked inside the transport. CLOSE operations use an independent
    reserved ``maximum_pending_control_count`` capacity.

    Epoch cancellation prevents queued work from crossing a session-retirement
    boundary. A transport call that has already begun cannot be
    pre-empted; its forced close retains global FIFO behind work accepted first.
    """

    def __init__(
        self,
        transport: _TransportPort,
        *,
        maximum_pending_count: int,
        maximum_pending_bytes: int,
        maximum_pending_control_count: int,
        thread_name: str = "scene-engine-transport-sender",
    ) -> None:
        if (
            not callable(getattr(transport, "send", None))
            or not callable(getattr(transport, "close", None))
        ):
            raise TypeError("transport must provide send() and close()")
        _positive_integer(maximum_pending_count, "maximum_pending_count")
        _positive_integer(maximum_pending_bytes, "maximum_pending_bytes")
        _positive_integer(
            maximum_pending_control_count,
            "maximum_pending_control_count",
        )
        if not isinstance(thread_name, str) or not thread_name:
            raise ValueError("thread_name must be a non-empty string")

        self._transport = transport
        self._maximum_pending_count = maximum_pending_count
        self._maximum_pending_bytes = maximum_pending_bytes
        self._maximum_pending_control_count = maximum_pending_control_count
        self._thread_name = thread_name
        self._condition = threading.Condition()
        self._queue: deque[_Operation] = deque()
        self._results: SimpleQueue[TransportResult] = SimpleQueue()
        self._epoch_state: dict[tuple[Any, int], str] = {}
        self._active_epoch_by_client: dict[Any, int] = {}
        self._next_epoch = 1
        self._pending_send_count = 0
        self._pending_send_bytes = 0
        self._pending_control_count = 0
        self._active_operation: _Operation | None = None
        self._state = _CREATED
        self._worker: threading.Thread | None = None

    @property
    def health(self) -> TransportSenderHealth:
        with self._condition:
            worker = self._worker
            return TransportSenderHealth(
                state=self._state,
                pending_send_count=self._pending_send_count,
                pending_send_bytes=self._pending_send_bytes,
                pending_control_count=self._pending_control_count,
                active_epoch_count=sum(
                    state in {_OPEN, _CLOSING}
                    for state in self._epoch_state.values()
                ),
                worker_alive=worker is not None and worker.is_alive(),
            )

    def start(self) -> None:
        """Start the sole transport worker; repeated starts while running are safe."""

        with self._condition:
            if self._state == _RUNNING:
                return
            if self._state != _CREATED:
                raise TransportSenderError("transport sender cannot be restarted")
            worker = threading.Thread(
                target=Context().run,
                args=(self._run,),
                name=self._thread_name,
                daemon=True,
            )
            self._worker = worker
            try:
                worker.start()
            except BaseException:
                self._worker = None
                raise
            self._state = _RUNNING

    def open_epoch(self, client_id: Any) -> int:
        """Create the next submission epoch for one client identifier.

        A still-open predecessor is cancelled defensively. A gracefully
        closing predecessor remains ahead of any later epoch in worker FIFO.
        Runtime connection keys are nevertheless connection-lifetime unique;
        epochs are not a substitute for a transport endpoint handle.
        """

        _require_hashable(client_id)
        with self._condition:
            self._require_running_locked()
            previous = self._active_epoch_by_client.get(client_id)
            if previous is not None:
                previous_key = (client_id, previous)
                if self._epoch_state.get(previous_key) == _OPEN:
                    self._cancel_epoch_locked(
                        client_id,
                        previous,
                        reason=None,
                        token=None,
                    )
            epoch = self._next_epoch
            self._next_epoch += 1
            self._epoch_state[(client_id, epoch)] = _OPEN
            self._active_epoch_by_client[client_id] = epoch
            return epoch

    def submit_send(
        self,
        client_id: Any,
        epoch: int,
        packet_bytes: bytes,
        *,
        token: Any = None,
    ) -> bool:
        """Attempt a zero-copy SEND submission without waiting for the worker."""

        _require_hashable(client_id)
        _epoch(epoch)
        if not isinstance(packet_bytes, bytes):
            raise TypeError("packet_bytes must be immutable bytes")
        byte_length = len(packet_bytes)
        with self._condition:
            if self._state != _RUNNING or not self._epoch_is_open_locked(
                client_id, epoch
            ):
                return False
            if (
                self._pending_send_count >= self._maximum_pending_count
                or self._pending_send_bytes + byte_length
                > self._maximum_pending_bytes
            ):
                return False
            self._queue.append(
                _Operation(
                    client_id=client_id,
                    epoch=epoch,
                    token=token,
                    kind="send",
                    packet_bytes=packet_bytes,
                )
            )
            self._pending_send_count += 1
            self._pending_send_bytes += byte_length
            self._condition.notify()
            return True

    def submit_close(
        self,
        client_id: Any,
        epoch: int,
        reason: str,
        *,
        token: Any = None,
    ) -> bool:
        """Append a graceful CLOSE after earlier SENDs and seal the epoch."""

        _require_hashable(client_id)
        _epoch(epoch)
        _reason(reason)
        with self._condition:
            if self._state != _RUNNING or not self._epoch_is_open_locked(
                client_id, epoch
            ):
                return False
            if (
                self._pending_control_count
                >= self._maximum_pending_control_count
            ):
                return False
            self._epoch_state[(client_id, epoch)] = _CLOSING
            self._queue.append(
                _Operation(
                    client_id=client_id,
                    epoch=epoch,
                    token=token,
                    kind="close",
                    reason=reason,
                )
            )
            self._pending_control_count += 1
            self._condition.notify()
            return True

    def cancel_epoch(
        self,
        client_id: Any,
        epoch: int,
        *,
        reason: str | None = None,
        token: Any = None,
    ) -> bool:
        """Cancel queued epoch work and optionally schedule an immediate close.

        The optional forced CLOSE uses the control path, so a full SEND outbox
        cannot reject it. It retains global admission order and cannot
        interrupt a transport method that the worker has already entered.
        """

        _require_hashable(client_id)
        _epoch(epoch)
        if reason is not None:
            _reason(reason)
        with self._condition:
            if self._state != _RUNNING:
                return False
            changed = self._cancel_epoch_locked(
                client_id,
                epoch,
                reason=reason,
                token=token,
            )
            if changed:
                self._condition.notify_all()
            return changed

    def drain_results(self) -> tuple[TransportResult, ...]:
        """Return every currently available terminal result without waiting."""

        results: list[TransportResult] = []
        while True:
            try:
                results.append(self._results.get_nowait())
            except Empty:
                return tuple(results)

    def wait_idle(self, *, timeout_seconds: float) -> bool:
        """Wait a finite interval for all accepted work to become terminal."""

        timeout = _finite_timeout(timeout_seconds)
        with self._condition:
            return self._condition.wait_for(self._is_idle_locked, timeout=timeout)

    def shutdown(self, *, drain: bool, timeout_seconds: float) -> bool:
        """Stop accepting work and attempt a finite, idempotent worker join.

        With ``drain=False``, queued operations become cancelled immediately;
        an active transport call is never forcefully interrupted.  A ``False``
        return means that call remained active through the join deadline.  A
        later shutdown call may join it again or escalate a draining shutdown
        to cancellation.
        """

        timeout = _finite_timeout(timeout_seconds)
        with self._condition:
            if self._state == _CREATED:
                self._state = _STOPPED
                return True
            if self._state == _STOPPED:
                return True
            if self._state == _RUNNING:
                self._state = _DRAINING if drain else _CANCELLING
            elif not drain and self._state == _DRAINING:
                self._state = _CANCELLING
            if self._state == _CANCELLING:
                self._cancel_all_queued_locked()
            worker = self._worker
            self._condition.notify_all()

        if worker is None:
            return True
        if worker is threading.current_thread():
            return False
        worker.join(timeout)
        return not worker.is_alive()

    def _run(self) -> None:
        while True:
            with self._condition:
                self._condition.wait_for(
                    lambda: bool(self._queue)
                    or self._state in {_DRAINING, _CANCELLING}
                )
                if not self._queue:
                    self._epoch_state.clear()
                    self._active_epoch_by_client.clear()
                    self._state = _STOPPED
                    self._condition.notify_all()
                    return
                operation = self._queue.popleft()
                self._active_operation = operation
                live = self._operation_is_live_locked(operation)

            status: TransportResultStatus
            error: BaseException | None = None
            if not live:
                status = "cancelled"
            else:
                try:
                    if operation.kind == "send":
                        assert operation.packet_bytes is not None
                        accepted = self._transport.send(
                            operation.client_id,
                            operation.packet_bytes,
                        )
                        if accepted is False:
                            raise TransportRejectedError(
                                "transport rejected accepted send"
                            )
                    else:
                        self._transport.close(
                            operation.client_id,
                            operation.reason,
                        )
                    status = "completed"
                except BaseException as exc:
                    status = "failed"
                    error = exc

            result = TransportResult(
                client_id=operation.client_id,
                epoch=operation.epoch,
                token=operation.token,
                kind=operation.kind,
                status=status,
                error=error,
            )
            with self._condition:
                self._finish_operation_locked(operation)
                self._results.put(result)
                if status == "failed":
                    self._fail_epoch_locked(operation)
                self._active_operation = None
                self._prune_epoch_locked(operation.client_id, operation.epoch)
                self._condition.notify_all()

    def _require_running_locked(self) -> None:
        if self._state != _RUNNING:
            raise TransportSenderError("transport sender is not running")

    def _epoch_is_open_locked(self, client_id: Any, epoch: int) -> bool:
        return (
            self._active_epoch_by_client.get(client_id) == epoch
            and self._epoch_state.get((client_id, epoch)) == _OPEN
        )

    def _operation_is_live_locked(self, operation: _Operation) -> bool:
        state = self._epoch_state.get((operation.client_id, operation.epoch))
        if operation.kind == "send":
            return state in {_OPEN, _CLOSING}
        if operation.forced:
            return state == _CANCELLED
        return state == _CLOSING

    def _finish_operation_locked(
        self,
        operation: _Operation,
    ) -> None:
        if operation.kind == "send":
            assert operation.packet_bytes is not None
            self._pending_send_count -= 1
            self._pending_send_bytes -= len(operation.packet_bytes)
            return
        self._pending_control_count -= 1
        key = (operation.client_id, operation.epoch)
        self._epoch_state[key] = _CLOSED
        if self._active_epoch_by_client.get(operation.client_id) == operation.epoch:
            self._active_epoch_by_client.pop(operation.client_id, None)

    def _cancel_epoch_locked(
        self,
        client_id: Any,
        epoch: int,
        *,
        reason: str | None,
        token: Any,
    ) -> bool:
        key = (client_id, epoch)
        state = self._epoch_state.get(key)
        if state not in {_OPEN, _CLOSING, _FAILED}:
            return False

        retained: deque[_Operation] = deque()
        for operation in self._queue:
            if (operation.client_id, operation.epoch) != key:
                retained.append(operation)
                continue
            self._cancel_queued_operation_locked(operation)
        self._queue = retained
        self._epoch_state[key] = _CANCELLED
        close_accepted = True
        if reason is not None:
            if (
                self._pending_control_count
                < self._maximum_pending_control_count
            ):
                self._queue.append(
                    _Operation(
                        client_id=client_id,
                        epoch=epoch,
                        token=token,
                        kind="close",
                        reason=reason,
                        forced=True,
                    )
                )
                self._pending_control_count += 1
                self._active_epoch_by_client[client_id] = epoch
            else:
                close_accepted = False
        if reason is None or not close_accepted:
            if self._active_epoch_by_client.get(client_id) == epoch:
                self._active_epoch_by_client.pop(client_id, None)
        self._prune_epoch_locked(client_id, epoch)
        return close_accepted

    def _fail_epoch_locked(self, failed: _Operation) -> None:
        key = (failed.client_id, failed.epoch)
        state = self._epoch_state.get(key)
        if state in {None, _CANCELLED, _CLOSED}:
            return
        retained: deque[_Operation] = deque()
        retained_close = False
        for operation in self._queue:
            if (operation.client_id, operation.epoch) != key:
                retained.append(operation)
                continue
            if failed.kind == "send" and operation.kind == "close":
                retained.append(operation)
                retained_close = True
            else:
                self._cancel_queued_operation_locked(operation)
        self._queue = retained
        if failed.kind == "send" and retained_close:
            self._epoch_state[key] = _CLOSING
        else:
            self._epoch_state[key] = (
                _FAILED if failed.kind == "send" else _CLOSED
            )
        if (
            not retained_close
            and self._active_epoch_by_client.get(failed.client_id)
            == failed.epoch
        ):
            self._active_epoch_by_client.pop(failed.client_id, None)

    def _cancel_all_queued_locked(self) -> None:
        while self._queue:
            self._cancel_queued_operation_locked(self._queue.popleft())
        for key, state in tuple(self._epoch_state.items()):
            if state in {_OPEN, _CLOSING}:
                self._epoch_state[key] = _CANCELLED
        self._active_epoch_by_client.clear()
        active = self._active_operation
        for client_id, epoch in tuple(self._epoch_state):
            if active is None or (active.client_id, active.epoch) != (
                client_id,
                epoch,
            ):
                self._epoch_state.pop((client_id, epoch), None)
        self._condition.notify_all()

    def _cancel_queued_operation_locked(self, operation: _Operation) -> None:
        if operation.kind == "send":
            assert operation.packet_bytes is not None
            self._pending_send_count -= 1
            self._pending_send_bytes -= len(operation.packet_bytes)
        else:
            self._pending_control_count -= 1
        self._results.put(
            TransportResult(
                client_id=operation.client_id,
                epoch=operation.epoch,
                token=operation.token,
                kind=operation.kind,
                status="cancelled",
            )
        )

    def _prune_epoch_locked(self, client_id: Any, epoch: int) -> None:
        key = (client_id, epoch)
        if self._epoch_state.get(key) not in {_CANCELLED, _CLOSED}:
            return
        active = self._active_operation
        if active is not None and (active.client_id, active.epoch) == key:
            return
        if any(
            (operation.client_id, operation.epoch) == key
            for operation in self._queue
        ):
            return
        self._epoch_state.pop(key, None)

    def _is_idle_locked(self) -> bool:
        return not self._queue and self._active_operation is None


def _positive_integer(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")


def _epoch(value: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("epoch must be a positive integer")


def _reason(value: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError("reason must be a non-empty string")


def _require_hashable(value: Any) -> None:
    try:
        hash(value)
    except TypeError as exc:
        raise TypeError("client_id must be hashable") from exc


def _finite_timeout(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("timeout_seconds must be a real number")
    timeout = float(value)
    if not math.isfinite(timeout) or timeout < 0.0:
        raise ValueError("timeout_seconds must be finite and non-negative")
    return timeout


__all__ = [
    "TransportRejectedError",
    "TransportResult",
    "TransportSender",
    "TransportSenderError",
    "TransportSenderHealth",
]
