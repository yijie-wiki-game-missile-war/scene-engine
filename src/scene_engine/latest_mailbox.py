"""Thread-safe latest-only ownership for sealed display frames.

The mailbox deliberately does not queue display history.  A published frame is
either the current latest frame or is kept alive by an outstanding lease.  The
lease cap therefore bounds the number of replaced frames that consumers can
retain.
"""

from __future__ import annotations

from dataclasses import dataclass
from operator import index
from threading import Lock
from typing import Dict, Optional

from .errors import ConfigurationError, MailboxError


@dataclass(frozen=True)
class DisplayFrameLease:
    """A leased view of canonical display-frame bytes.

    ``data`` and all metadata are guaranteed to remain valid until the token is
    released.  Callers must not rely on the memory remaining usable afterwards.
    """

    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    data: memoryview
    lease_token: int
    ticks_per_second: Optional[int] = None
    entity_count: Optional[int] = None


# Compatibility with the early API draft.  Package-level exports should prefer
# ``DisplayFrameLease`` so it cannot be confused with the decoded binary view.
DisplayFrameView = DisplayFrameLease


@dataclass(frozen=True)
class _FrameSlot:
    owner: object
    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    data: memoryview
    ticks_per_second: Optional[int]
    entity_count: Optional[int]


class LatestFrameMailbox:
    """A bounded, latest-only mailbox for immutable sealed frames.

    Publishing never waits for a consumer.  Replacing the latest frame drops
    the mailbox's reference to the unacquired frame, while outstanding leases
    retain their exact frame independently.
    """

    def __init__(self, maximum_outstanding_leases: int = 1) -> None:
        maximum_outstanding_leases = _positive_integer(
            maximum_outstanding_leases,
            name="maximum_outstanding_leases",
        )
        self._maximum_outstanding_leases = maximum_outstanding_leases
        self._lock = Lock()
        self._latest: Optional[_FrameSlot] = None
        self._leases: Dict[int, _FrameSlot] = {}
        self._next_lease_token = 1

    @property
    def maximum_outstanding_leases(self) -> int:
        return self._maximum_outstanding_leases

    @property
    def outstanding_lease_count(self) -> int:
        with self._lock:
            return len(self._leases)

    @property
    def latest_frame_seq(self) -> Optional[int]:
        with self._lock:
            if self._latest is None:
                return None
            return self._latest.frame_seq

    def publish(self, frame: object) -> None:
        """Atomically replace the current unacquired latest frame.

        ``frame`` must be sealed: its ``data`` must be immutable ``bytes`` and
        its public header metadata must be present.
        Binary/profile validation remains the frame writer/parser's job.
        """

        slot = _slot_from_sealed_frame(frame)
        with self._lock:
            latest = self._latest
            if latest is not None:
                if (
                    latest.scene_epoch != slot.scene_epoch
                    or latest.bootstrap_id != slot.bootstrap_id
                ):
                    raise MailboxError(
                        "mailbox identity is fixed; create a new mailbox for "
                        "another scene bootstrap"
                    )
                if slot.frame_seq <= latest.frame_seq:
                    raise MailboxError(
                        "published frame_seq must increase within one bootstrap"
                    )
            self._latest = slot

    def acquire_latest(self, *, after_frame_seq: int) -> Optional[DisplayFrameLease]:
        """Lease the latest frame if its sequence is newer than the caller's.

        Reaching the configured lease cap is an ownership error rather than a
        reason to allocate another retained buffer or block the producer.
        """

        after_frame_seq = _non_negative_integer(
            after_frame_seq,
            name="after_frame_seq",
        )
        with self._lock:
            slot = self._latest
            if slot is None or slot.frame_seq <= after_frame_seq:
                return None
            if len(self._leases) >= self._maximum_outstanding_leases:
                raise MailboxError(
                    "maximum outstanding display-frame leases reached"
                )

            token = self._next_lease_token
            self._next_lease_token += 1
            self._leases[token] = slot
            return DisplayFrameLease(
                scene_epoch=slot.scene_epoch,
                bootstrap_id=slot.bootstrap_id,
                frame_seq=slot.frame_seq,
                source_tick=slot.source_tick,
                data=slot.data,
                lease_token=token,
                ticks_per_second=slot.ticks_per_second,
                entity_count=slot.entity_count,
            )

    def release(self, lease_token: int) -> None:
        """Release exactly one outstanding lease.

        Unknown tokens and repeated release attempts are rejected so ownership
        mistakes cannot silently corrupt the buffer-pool accounting.
        """

        lease_token = _lease_token(lease_token)
        with self._lock:
            try:
                del self._leases[lease_token]
            except KeyError:
                raise MailboxError(
                    "unknown or already released display-frame lease token: "
                    "{}".format(lease_token)
                )


def _slot_from_sealed_frame(frame: object) -> _FrameSlot:
    if frame is None:
        raise MailboxError("published display frame must not be None")

    try:
        raw_data = getattr(frame, "data")
    except AttributeError:
        raise MailboxError("published display frame has no canonical data")

    if not isinstance(raw_data, bytes):
        # memoryview(...).readonly is not an ownership guarantee: a read-only
        # view may still be backed by a mutable bytearray.  Requiring bytes
        # keeps acquired data stable without a hidden publish-time copy.
        raise MailboxError("published display-frame data must be immutable bytes")
    data = memoryview(raw_data)

    scene_epoch = _frame_integer(frame, "scene_epoch")
    bootstrap_id = _frame_integer(frame, "bootstrap_id")
    frame_seq = _frame_integer(frame, "frame_seq")
    source_tick = _frame_integer(frame, "source_tick")
    ticks_per_second = _optional_frame_integer(frame, "ticks_per_second")
    entity_count = _optional_frame_integer(frame, "entity_count")
    return _FrameSlot(
        owner=frame,
        scene_epoch=scene_epoch,
        bootstrap_id=bootstrap_id,
        frame_seq=frame_seq,
        source_tick=source_tick,
        data=data,
        ticks_per_second=ticks_per_second,
        entity_count=entity_count,
    )


def _frame_integer(frame: object, name: str) -> int:
    try:
        value = getattr(frame, name)
    except AttributeError:
        raise MailboxError("published display frame has no {}".format(name))
    try:
        value = index(value)
    except TypeError:
        raise MailboxError("published display-frame {} is not an integer".format(name))
    if value < 0:
        raise MailboxError("published display-frame {} must be non-negative".format(name))
    return value


def _optional_frame_integer(frame: object, name: str) -> Optional[int]:
    if not hasattr(frame, name):
        return None
    return _frame_integer(frame, name)


def _positive_integer(value: object, *, name: str) -> int:
    if isinstance(value, bool):
        raise ConfigurationError("{} must be an integer".format(name))
    try:
        result = index(value)
    except TypeError:
        raise ConfigurationError("{} must be an integer".format(name))
    if result <= 0:
        raise ConfigurationError("{} must be greater than zero".format(name))
    return result


def _non_negative_integer(value: object, *, name: str) -> int:
    if isinstance(value, bool):
        raise MailboxError("{} must be an integer".format(name))
    try:
        result = index(value)
    except TypeError:
        raise MailboxError("{} must be an integer".format(name))
    if result < 0:
        raise MailboxError("{} must be non-negative".format(name))
    return result


def _lease_token(value: object) -> int:
    if isinstance(value, bool):
        raise MailboxError("lease_token must be a positive integer")
    try:
        result = index(value)
    except TypeError:
        raise MailboxError("lease_token must be a positive integer")
    if result <= 0:
        raise MailboxError("unknown display-frame lease token: {}".format(result))
    return result


__all__ = [
    "DisplayFrameLease",
    "DisplayFrameView",
    "LatestFrameMailbox",
]
