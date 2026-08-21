from dataclasses import dataclass
from threading import Barrier, Thread

import pytest

from scene_engine.errors import ConfigurationError, MailboxError
from scene_engine.latest_mailbox import LatestFrameMailbox


@dataclass(frozen=True)
class _SealedFrame:
    scene_epoch: int
    bootstrap_id: int
    frame_seq: int
    source_tick: int
    ticks_per_second: int
    entity_count: int
    data: bytes


def _frame(frame_seq: int, payload: bytes) -> _SealedFrame:
    return _SealedFrame(
        scene_epoch=7,
        bootstrap_id=11,
        frame_seq=frame_seq,
        source_tick=frame_seq * 2,
        ticks_per_second=60,
        entity_count=1,
        data=payload,
    )


def test_latest_replacement_does_not_invalidate_an_acquired_frame() -> None:
    mailbox = LatestFrameMailbox(maximum_outstanding_leases=2)
    mailbox.publish(_frame(1, b"frame-one"))
    first = mailbox.acquire_latest(after_frame_seq=0)
    assert first is not None

    mailbox.publish(_frame(4, b"frame-four"))
    second = mailbox.acquire_latest(after_frame_seq=1)
    assert second is not None

    assert first.frame_seq == 1
    assert bytes(first.data) == b"frame-one"
    assert second.frame_seq == 4
    assert bytes(second.data) == b"frame-four"
    assert mailbox.outstanding_lease_count == 2

    with pytest.raises(MailboxError, match="maximum outstanding"):
        mailbox.acquire_latest(after_frame_seq=0)

    mailbox.release(first.lease_token)
    mailbox.release(second.lease_token)
    assert mailbox.outstanding_lease_count == 0


def test_unacquired_frames_are_replaced_and_stale_query_returns_none() -> None:
    mailbox = LatestFrameMailbox(1)
    mailbox.publish(_frame(1, b"one"))
    mailbox.publish(_frame(9, b"nine"))

    assert mailbox.acquire_latest(after_frame_seq=9) is None
    leased = mailbox.acquire_latest(after_frame_seq=1)
    assert leased is not None
    assert leased.frame_seq == 9
    assert bytes(leased.data) == b"nine"
    mailbox.release(leased.lease_token)


def test_publish_rejects_sequence_regression_within_one_bootstrap() -> None:
    mailbox = LatestFrameMailbox(1)
    mailbox.publish(_frame(9, b"nine"))

    with pytest.raises(MailboxError, match="frame_seq must increase"):
        mailbox.publish(_frame(9, b"duplicate"))
    with pytest.raises(MailboxError, match="frame_seq must increase"):
        mailbox.publish(_frame(4, b"older"))

    leased = mailbox.acquire_latest(after_frame_seq=0)
    assert leased is not None
    assert leased.frame_seq == 9
    assert bytes(leased.data) == b"nine"
    mailbox.release(leased.lease_token)


def test_mailbox_identity_is_fixed_after_its_first_frame() -> None:
    mailbox = LatestFrameMailbox(1)
    mailbox.publish(_frame(1, b"epoch-seven"))
    changed_epoch = _SealedFrame(
        scene_epoch=8,
        bootstrap_id=11,
        frame_seq=1,
        source_tick=1,
        ticks_per_second=60,
        entity_count=0,
        data=b"epoch-eight",
    )

    with pytest.raises(MailboxError, match="identity is fixed"):
        mailbox.publish(changed_epoch)

    leased = mailbox.acquire_latest(after_frame_seq=0)
    assert leased is not None
    assert leased.scene_epoch == 7
    assert bytes(leased.data) == b"epoch-seven"
    mailbox.release(leased.lease_token)


def test_unknown_and_double_release_are_rejected() -> None:
    mailbox = LatestFrameMailbox(1)
    mailbox.publish(_frame(1, b"one"))
    leased = mailbox.acquire_latest(after_frame_seq=0)
    assert leased is not None

    mailbox.release(leased.lease_token)
    with pytest.raises(MailboxError, match="already released"):
        mailbox.release(leased.lease_token)
    with pytest.raises(MailboxError, match="unknown"):
        mailbox.release(999_999)


def test_configuration_and_mutable_publish_data_are_rejected() -> None:
    with pytest.raises(ConfigurationError):
        LatestFrameMailbox(0)

    mutable = _SealedFrame(
        scene_epoch=1,
        bootstrap_id=1,
        frame_seq=1,
        source_tick=1,
        ticks_per_second=60,
        entity_count=0,
        data=bytearray(b"not-sealed"),  # type: ignore[arg-type]
    )
    with pytest.raises(MailboxError, match="immutable bytes"):
        LatestFrameMailbox().publish(mutable)

    read_only_view = _SealedFrame(
        scene_epoch=1,
        bootstrap_id=1,
        frame_seq=1,
        source_tick=1,
        ticks_per_second=60,
        entity_count=0,
        data=memoryview(bytearray(b"mutable-owner")).toreadonly(),  # type: ignore[arg-type]
    )
    with pytest.raises(MailboxError, match="immutable bytes"):
        LatestFrameMailbox().publish(read_only_view)


def test_concurrent_acquires_never_exceed_the_lease_cap() -> None:
    mailbox = LatestFrameMailbox(maximum_outstanding_leases=3)
    mailbox.publish(_frame(1, b"one"))
    barrier = Barrier(9)
    tokens = []
    failures = []

    def acquire() -> None:
        barrier.wait()
        try:
            leased = mailbox.acquire_latest(after_frame_seq=0)
            assert leased is not None
            tokens.append(leased.lease_token)
        except MailboxError:
            failures.append(True)

    threads = [Thread(target=acquire) for _ in range(8)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()

    assert len(tokens) == 3
    assert len(failures) == 5
    assert len(set(tokens)) == 3
    assert mailbox.outstanding_lease_count == 3
    for token in tokens:
        mailbox.release(token)
