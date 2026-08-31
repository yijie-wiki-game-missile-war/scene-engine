from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
import threading
from typing import Any

import pytest

from scene_engine.transport_sender import (
    TransportRejectedError,
    TransportSender,
    TransportSenderError,
)


@dataclass(frozen=True)
class Call:
    kind: str
    client_id: Any
    value: Any
    thread_id: int


class ControlledTransport:
    def __init__(self) -> None:
        self.calls: list[Call] = []
        self.condition = threading.Condition()
        self.block_packet: bytes | None = None
        self.send_started = threading.Event()
        self.release_send = threading.Event()
        self.raise_packets: set[bytes] = set()
        self.reject_packets: set[bytes] = set()
        self.raise_close_reasons: set[str] = set()

    def send(self, client_id: Any, packet_bytes: bytes) -> bool:
        with self.condition:
            self.calls.append(
                Call("send", client_id, packet_bytes, threading.get_ident())
            )
            self.condition.notify_all()
        if packet_bytes is self.block_packet:
            self.send_started.set()
            if not self.release_send.wait(timeout=5.0):
                raise AssertionError("test did not release blocked transport send")
        if packet_bytes in self.raise_packets:
            raise ValueError("injected send failure")
        return packet_bytes not in self.reject_packets

    def close(self, client_id: Any, reason: str) -> None:
        with self.condition:
            self.calls.append(
                Call("close", client_id, reason, threading.get_ident())
            )
            self.condition.notify_all()
        if reason in self.raise_close_reasons:
            raise OSError("injected close failure")

    def wait_for_calls(self, count: int) -> None:
        with self.condition:
            assert self.condition.wait_for(
                lambda: len(self.calls) >= count,
                timeout=5.0,
            )


def sender(
    transport: ControlledTransport,
    *,
    count: int = 8,
    byte_count: int = 1024,
    control_count: int = 8,
    name: str,
) -> TransportSender:
    instance = TransportSender(
        transport,
        maximum_pending_count=count,
        maximum_pending_bytes=byte_count,
        maximum_pending_control_count=control_count,
        thread_name=name,
    )
    instance.start()
    return instance


def test_worker_preserves_fifo_identity_and_graceful_close() -> None:
    transport = ControlledTransport()
    dispatcher = sender(transport, name="test-transport-sender-fifo")
    epoch = dispatcher.open_epoch("client")
    first = bytes(bytearray(b"first"))
    second = bytes(bytearray(b"second"))

    assert dispatcher.submit_send("client", epoch, first, token="first")
    assert dispatcher.submit_send("client", epoch, second, token="second")
    assert dispatcher.submit_close("client", epoch, "finished", token="close")
    assert not dispatcher.submit_send("client", epoch, b"late", token="late")
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)

    assert [(call.kind, call.client_id, call.value) for call in transport.calls] == [
        ("send", "client", first),
        ("send", "client", second),
        ("close", "client", "finished"),
    ]
    assert transport.calls[0].value is first
    assert transport.calls[1].value is second
    worker_ids = {call.thread_id for call in transport.calls}
    assert len(worker_ids) == 1
    assert worker_ids != {threading.get_ident()}
    assert [
        (result.kind, result.status, result.token)
        for result in dispatcher.drain_results()
    ] == [
        ("send", "completed", "first"),
        ("send", "completed", "second"),
        ("close", "completed", "close"),
    ]


def test_blocked_send_keeps_count_and_byte_backpressure_bounded() -> None:
    transport = ControlledTransport()
    first = bytes(bytearray(b"aa"))
    transport.block_packet = first
    dispatcher = sender(
        transport,
        count=3,
        byte_count=4,
        name="test-transport-sender-bytes",
    )
    epoch = dispatcher.open_epoch("client")

    assert dispatcher.submit_send("client", epoch, first, token=1)
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.submit_send("client", epoch, b"bb", token=2)
    assert not dispatcher.submit_send("client", epoch, b"c", token=3)
    health = dispatcher.health
    assert health.pending_send_count == 2
    assert health.pending_send_bytes == 4

    # CLOSE has a reserved control path even when ordinary byte capacity is full.
    assert dispatcher.submit_close("client", epoch, "done", token="close")
    assert dispatcher.health.pending_control_count == 1
    transport.release_send.set()
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)
    assert [(call.kind, call.value) for call in transport.calls] == [
        ("send", first),
        ("send", b"bb"),
        ("close", "done"),
    ]

    count_transport = ControlledTransport()
    blocked = bytes(bytearray(b"blocked"))
    count_transport.block_packet = blocked
    count_dispatcher = sender(
        count_transport,
        count=2,
        byte_count=1024,
        name="test-transport-sender-count",
    )
    count_epoch = count_dispatcher.open_epoch("client")
    assert count_dispatcher.submit_send("client", count_epoch, blocked)
    assert count_transport.send_started.wait(timeout=5.0)
    assert count_dispatcher.submit_send("client", count_epoch, b"queued")
    assert not count_dispatcher.submit_send("client", count_epoch, b"overflow")
    count_transport.release_send.set()
    assert count_dispatcher.shutdown(drain=True, timeout_seconds=5.0)


def test_send_and_close_failures_are_reported_without_stopping_worker() -> None:
    transport = ControlledTransport()
    raised = b"raised"
    rejected = b"rejected"
    succeeded = b"succeeded"
    transport.raise_packets.add(raised)
    transport.reject_packets.add(rejected)
    transport.raise_close_reasons.add("close-failed")
    dispatcher = sender(transport, name="test-transport-sender-failures")
    raised_epoch = dispatcher.open_epoch("raised-client")
    rejected_epoch = dispatcher.open_epoch("rejected-client")
    succeeded_epoch = dispatcher.open_epoch("succeeded-client")
    close_epoch = dispatcher.open_epoch("close-client")

    assert dispatcher.submit_send(
        "raised-client", raised_epoch, raised, token="raised"
    )
    assert dispatcher.submit_send(
        "rejected-client", rejected_epoch, rejected, token="rejected"
    )
    assert dispatcher.submit_send(
        "succeeded-client", succeeded_epoch, succeeded, token="succeeded"
    )
    assert dispatcher.submit_close(
        "close-client", close_epoch, "close-failed", token="close-failed"
    )
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)

    results = dispatcher.drain_results()
    assert [result.status for result in results] == [
        "failed",
        "failed",
        "completed",
        "failed",
    ]
    assert isinstance(results[0].error, ValueError)
    assert isinstance(results[1].error, TransportRejectedError)
    assert results[2].error is None
    assert isinstance(results[3].error, OSError)
    assert [result.token for result in results] == [
        "raised",
        "rejected",
        "succeeded",
        "close-failed",
    ]
    assert len(transport.calls) == 4


def test_failure_cancels_only_the_failed_epoch_queue() -> None:
    transport = ControlledTransport()
    anchor = bytes(bytearray(b"anchor-failure"))
    failed = b"failed"
    transport.block_packet = anchor
    transport.raise_packets.add(failed)
    dispatcher = sender(transport, name="test-transport-sender-failure-epoch")
    anchor_epoch = dispatcher.open_epoch("anchor")
    failed_epoch = dispatcher.open_epoch("failed")
    healthy_epoch = dispatcher.open_epoch("healthy")

    assert dispatcher.submit_send("anchor", anchor_epoch, anchor, token="anchor")
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.submit_send("failed", failed_epoch, failed, token="failed")
    assert dispatcher.submit_send(
        "failed", failed_epoch, b"must-not-send", token="cancelled-after-failure"
    )
    assert dispatcher.submit_send(
        "healthy", healthy_epoch, b"healthy", token="healthy"
    )
    transport.release_send.set()
    assert dispatcher.wait_idle(timeout_seconds=5.0)

    assert dispatcher.cancel_epoch(
        "failed",
        failed_epoch,
        reason="transport-send-failed",
        token="failure-close",
    )
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)
    assert [(call.kind, call.client_id, call.value) for call in transport.calls] == [
        ("send", "anchor", anchor),
        ("send", "failed", failed),
        ("send", "healthy", b"healthy"),
        ("close", "failed", "transport-send-failed"),
    ]
    assert {
        (result.token, result.status)
        for result in dispatcher.drain_results()
    } == {
        ("anchor", "completed"),
        ("failed", "failed"),
        ("cancelled-after-failure", "cancelled"),
        ("healthy", "completed"),
        ("failure-close", "completed"),
    }


def test_send_failure_preserves_a_previously_accepted_graceful_close() -> None:
    transport = ControlledTransport()
    failed = bytes(bytearray(b"blocked-failure"))
    transport.block_packet = failed
    transport.raise_packets.add(failed)
    dispatcher = sender(
        transport,
        name="test-transport-sender-failure-close",
    )
    epoch = dispatcher.open_epoch("client")

    assert dispatcher.submit_send("client", epoch, failed, token="failed")
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.submit_send(
        "client", epoch, b"must-not-send", token="cancelled"
    )
    assert dispatcher.submit_close(
        "client", epoch, "runtime-stopped", token="close"
    )
    transport.release_send.set()
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)

    assert [(call.kind, call.value) for call in transport.calls] == [
        ("send", failed),
        ("close", "runtime-stopped"),
    ]
    assert {
        (result.token, result.status)
        for result in dispatcher.drain_results()
    } == {
        ("failed", "failed"),
        ("cancelled", "cancelled"),
        ("close", "completed"),
    }


def test_cancelled_epoch_cannot_send_stale_packets_before_a_later_epoch() -> None:
    transport = ControlledTransport()
    anchor = bytes(bytearray(b"anchor"))
    transport.block_packet = anchor
    dispatcher = sender(transport, name="test-transport-sender-epoch")
    anchor_epoch = dispatcher.open_epoch("anchor")
    old_epoch = dispatcher.open_epoch("same")

    assert dispatcher.submit_send("anchor", anchor_epoch, anchor, token="anchor")
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.submit_send("same", old_epoch, b"old-1", token="old-1")
    assert dispatcher.submit_send("same", old_epoch, b"old-2", token="old-2")
    assert dispatcher.cancel_epoch(
        "same",
        old_epoch,
        reason="client-replaced",
        token="old-close",
    )
    assert not dispatcher.submit_send("same", old_epoch, b"stale")

    new_epoch = dispatcher.open_epoch("same")
    assert new_epoch != old_epoch
    newest = bytes(bytearray(b"new"))
    assert dispatcher.submit_send("same", new_epoch, newest, token="new")
    transport.release_send.set()
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)

    assert [(call.kind, call.client_id, call.value) for call in transport.calls] == [
        ("send", "anchor", anchor),
        ("close", "same", "client-replaced"),
        ("send", "same", newest),
    ]
    results = dispatcher.drain_results()
    cancelled = {
        result.token
        for result in results
        if result.status == "cancelled"
    }
    assert cancelled == {"old-1", "old-2"}
    assert next(result for result in results if result.token == "old-close").status == (
        "completed"
    )
    assert next(result for result in results if result.token == "new").epoch == new_epoch


def test_forced_close_retains_fifo_with_other_clients() -> None:
    transport = ControlledTransport()
    anchor = bytes(bytearray(b"anchor"))
    transport.block_packet = anchor
    dispatcher = sender(transport, name="test-transport-sender-control-fifo")
    anchor_epoch = dispatcher.open_epoch("anchor")
    cancelled_epoch = dispatcher.open_epoch("cancelled")
    healthy_epoch = dispatcher.open_epoch("healthy")

    assert dispatcher.submit_send("anchor", anchor_epoch, anchor)
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.submit_send("cancelled", cancelled_epoch, b"stale")
    assert dispatcher.submit_send("healthy", healthy_epoch, b"healthy")
    assert dispatcher.cancel_epoch(
        "cancelled",
        cancelled_epoch,
        reason="disconnected",
    )
    transport.release_send.set()
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)

    assert [(call.kind, call.client_id, call.value) for call in transport.calls] == [
        ("send", "anchor", anchor),
        ("send", "healthy", b"healthy"),
        ("close", "cancelled", "disconnected"),
    ]


def test_control_capacity_is_independently_bounded() -> None:
    transport = ControlledTransport()
    anchor = bytes(bytearray(b"anchor"))
    transport.block_packet = anchor
    dispatcher = sender(
        transport,
        control_count=1,
        name="test-transport-sender-control-capacity",
    )
    anchor_epoch = dispatcher.open_epoch("anchor")
    first_epoch = dispatcher.open_epoch("first")
    second_epoch = dispatcher.open_epoch("second")

    assert dispatcher.submit_send("anchor", anchor_epoch, anchor)
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.cancel_epoch("first", first_epoch, reason="first-close")
    assert not dispatcher.cancel_epoch(
        "second", second_epoch, reason="second-close"
    )
    assert dispatcher.health.pending_control_count == 1

    transport.release_send.set()
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)
    assert [(call.kind, call.client_id, call.value) for call in transport.calls] == [
        ("send", "anchor", anchor),
        ("close", "first", "first-close"),
    ]


def test_cancelling_shutdown_is_finite_idempotent_and_leaves_no_worker() -> None:
    transport = ControlledTransport()
    active = bytes(bytearray(b"active"))
    transport.block_packet = active
    thread_name = "test-transport-sender-shutdown"
    dispatcher = sender(transport, name=thread_name)
    epoch = dispatcher.open_epoch("client")

    assert dispatcher.submit_send("client", epoch, active, token="active")
    assert transport.send_started.wait(timeout=5.0)
    assert dispatcher.submit_send("client", epoch, b"queued", token="queued")
    assert dispatcher.submit_close("client", epoch, "unused", token="close")

    assert not dispatcher.shutdown(drain=False, timeout_seconds=0.0)
    assert dispatcher.health.state == "cancelling"
    transport.release_send.set()
    assert dispatcher.shutdown(drain=False, timeout_seconds=5.0)
    assert dispatcher.shutdown(drain=False, timeout_seconds=0.0)

    assert [(call.kind, call.value) for call in transport.calls] == [
        ("send", active),
    ]
    results = dispatcher.drain_results()
    assert {
        (result.token, result.status)
        for result in results
    } == {
        ("active", "completed"),
        ("queued", "cancelled"),
        ("close", "cancelled"),
    }
    assert dispatcher.health.pending_send_count == 0
    assert dispatcher.health.pending_send_bytes == 0
    assert not dispatcher.health.worker_alive
    assert not any(
        thread.name == thread_name and thread.is_alive()
        for thread in threading.enumerate()
    )
    with pytest.raises(TransportSenderError, match="cannot be restarted"):
        dispatcher.start()


def test_lifecycle_and_input_validation_do_not_spawn_or_copy_work() -> None:
    transport = ControlledTransport()
    dispatcher = TransportSender(
        transport,
        maximum_pending_count=1,
        maximum_pending_bytes=1,
        maximum_pending_control_count=1,
        thread_name="test-transport-sender-validation",
    )
    with pytest.raises(TransportSenderError, match="not running"):
        dispatcher.open_epoch("client")
    assert dispatcher.shutdown(drain=True, timeout_seconds=0.0)
    assert dispatcher.shutdown(drain=False, timeout_seconds=0.0)
    assert transport.calls == []

    running = sender(transport, name="test-transport-sender-types")
    epoch = running.open_epoch("client")
    with pytest.raises(TypeError, match="immutable bytes"):
        running.submit_send("client", epoch, bytearray(b"x"))  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="hashable"):
        running.open_epoch([])  # type: ignore[arg-type]
    assert running.shutdown(drain=False, timeout_seconds=5.0)


def test_worker_start_failure_keeps_shutdown_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport = ControlledTransport()
    dispatcher = TransportSender(
        transport,
        maximum_pending_count=1,
        maximum_pending_bytes=1,
        maximum_pending_control_count=1,
        thread_name="test-transport-sender-start-failure",
    )

    def fail_start(_thread: threading.Thread) -> None:
        raise RuntimeError("synthetic thread start failure")

    monkeypatch.setattr(threading.Thread, "start", fail_start)
    with pytest.raises(RuntimeError, match="synthetic thread start failure"):
        dispatcher.start()
    assert dispatcher.health.state == "created"
    assert not dispatcher.health.worker_alive
    assert dispatcher.shutdown(drain=True, timeout_seconds=0.0)


def test_completed_and_cancelled_epochs_release_all_sender_metadata() -> None:
    transport = ControlledTransport()
    dispatcher = sender(transport, name="test-transport-sender-epoch-cleanup")

    for index in range(60):
        client_id = f"client-{index % 3}"
        epoch = dispatcher.open_epoch(client_id)
        mode = index % 3
        if mode == 0:
            assert dispatcher.submit_close(client_id, epoch, "graceful")
            assert dispatcher.wait_idle(timeout_seconds=5.0)
        elif mode == 1:
            assert dispatcher.cancel_epoch(client_id, epoch)
        else:
            assert dispatcher.cancel_epoch(
                client_id,
                epoch,
                reason="immediate",
            )
            assert dispatcher.wait_idle(timeout_seconds=5.0)
        dispatcher.drain_results()
        assert dispatcher.health.active_epoch_count == 0
        assert dispatcher._epoch_state == {}

    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)
    assert dispatcher.health.active_epoch_count == 0
    assert dispatcher._epoch_state == {}


def test_failed_close_releases_epoch_while_sender_keeps_running() -> None:
    transport = ControlledTransport()
    transport.raise_close_reasons.add("failed")
    dispatcher = sender(transport, name="test-transport-sender-close-cleanup")
    epoch = dispatcher.open_epoch("client")

    assert dispatcher.submit_close("client", epoch, "failed")
    assert dispatcher.wait_idle(timeout_seconds=5.0)
    assert dispatcher.health.active_epoch_count == 0
    assert dispatcher._epoch_state == {}
    assert dispatcher.drain_results()[0].status == "failed"

    next_epoch = dispatcher.open_epoch("client")
    assert next_epoch != epoch
    assert dispatcher.submit_close("client", next_epoch, "finished")
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)


def test_failed_forced_close_releases_epoch_and_control_capacity() -> None:
    transport = ControlledTransport()
    transport.raise_close_reasons.add("failed")
    dispatcher = sender(
        transport,
        control_count=1,
        name="test-transport-sender-forced-close-cleanup",
    )
    epoch = dispatcher.open_epoch("client")

    assert dispatcher.cancel_epoch("client", epoch, reason="failed")
    assert dispatcher.wait_idle(timeout_seconds=5.0)
    assert dispatcher.health.pending_control_count == 0
    assert dispatcher._epoch_state == {}
    assert dispatcher._active_epoch_by_client == {}
    result = dispatcher.drain_results()[0]
    assert result.kind == "close"
    assert result.status == "failed"

    next_epoch = dispatcher.open_epoch("next")
    assert dispatcher.submit_close("next", next_epoch, "finished")
    assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)


def test_worker_starts_with_an_empty_context_on_every_python_build() -> None:
    marker = ContextVar("transport-sender-test-marker", default="empty")

    class ContextTransport(ControlledTransport):
        def __init__(self) -> None:
            super().__init__()
            self.context_values: list[str] = []

        def send(self, client_id: Any, packet_bytes: bytes) -> bool:
            self.context_values.append(marker.get())
            return super().send(client_id, packet_bytes)

    token = marker.set("runtime-owner")
    transport = ContextTransport()
    dispatcher = sender(transport, name="test-transport-sender-context")
    try:
        epoch = dispatcher.open_epoch("client")
        assert dispatcher.submit_send("client", epoch, b"packet")
        assert dispatcher.shutdown(drain=True, timeout_seconds=5.0)
        assert transport.context_values == ["empty"]
    finally:
        dispatcher.shutdown(drain=False, timeout_seconds=5.0)
        marker.reset(token)
