"""Producer-side display identity validation across every exported frame."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Optional

from .display_frame import DisplayFrameView, parse_display_frame
from .errors import DisplayExportError


@dataclass(frozen=True)
class DisplayIdentityUpdate:
    """Prepared identity state that has not yet mutated the tracker."""

    decoded: DisplayFrameView
    expected_frame_seq: Optional[int]
    expected_max_seen_display_id: int
    active_display_ids: frozenset[int]
    max_seen_display_id: int


class DisplayIdentityTracker:
    """Enforce monotonic, never-reused display IDs for one scene bootstrap.

    A latest-only consumer cannot observe removals in frames it skipped.  This
    producer-side tracker sees every exported frame before mailbox replacement,
    so an ID that disappeared can never silently return.  It stores only the
    bounded current active set and a scalar maximum ID, not an unbounded
    tombstone history.
    """

    def __init__(
        self,
        *,
        scene_epoch: int,
        bootstrap_id: int,
        maximum_frame_entities: int,
        maximum_frame_bytes: int,
    ) -> None:
        self._scene_epoch = scene_epoch
        self._bootstrap_id = bootstrap_id
        self._maximum_frame_entities = maximum_frame_entities
        self._maximum_frame_bytes = maximum_frame_bytes
        self._lock = Lock()
        self._active_display_ids = frozenset()  # type: frozenset[int]
        self._max_seen_display_id = 0
        self._last_frame_seq: Optional[int] = None
        self._last_source_tick: Optional[int] = None

    @property
    def max_seen_display_id(self) -> int:
        with self._lock:
            return self._max_seen_display_id

    @property
    def active_display_ids(self) -> frozenset[int]:
        with self._lock:
            return self._active_display_ids

    def prepare(self, frame: object) -> DisplayIdentityUpdate:
        """Validate a candidate without mutating tracker state."""

        data = getattr(frame, "data", frame)
        decoded = parse_display_frame(
            data,
            maximum_frame_entities=self._maximum_frame_entities,
            maximum_frame_bytes=self._maximum_frame_bytes,
        )
        header = decoded.header
        if header.scene_epoch != self._scene_epoch:
            raise DisplayExportError(
                "exported frame scene_epoch does not match the host"
            )
        if header.bootstrap_id != self._bootstrap_id:
            raise DisplayExportError(
                "exported frame bootstrap_id does not match the host"
            )
        incoming_ids = frozenset(record.display_id for record in decoded.records)

        with self._lock:
            if (
                self._last_frame_seq is not None
                and header.frame_seq <= self._last_frame_seq
            ):
                raise DisplayExportError(
                    "exported frame_seq must increase within a bootstrap"
                )
            if (
                self._last_source_tick is not None
                and header.source_tick < self._last_source_tick
            ):
                raise DisplayExportError(
                    "exported source_tick cannot move backwards"
                )
            new_ids = incoming_ids.difference(self._active_display_ids)
            invalid_ids = [
                display_id
                for display_id in new_ids
                if display_id <= self._max_seen_display_id
            ]
            if invalid_ids:
                raise DisplayExportError(
                    "display_id {} was retired or violates the monotonic "
                    "epoch allocator".format(min(invalid_ids))
                )
            next_max_seen = max(
                self._max_seen_display_id,
                max(incoming_ids, default=0),
            )
            return DisplayIdentityUpdate(
                decoded=decoded,
                expected_frame_seq=self._last_frame_seq,
                expected_max_seen_display_id=self._max_seen_display_id,
                active_display_ids=incoming_ids,
                max_seen_display_id=next_max_seen,
            )

    def commit(self, update: DisplayIdentityUpdate) -> None:
        """Commit a prepared update after the downstream publish succeeds."""

        if not isinstance(update, DisplayIdentityUpdate):
            raise DisplayExportError("identity update token is invalid")
        with self._lock:
            if (
                self._last_frame_seq != update.expected_frame_seq
                or self._max_seen_display_id
                != update.expected_max_seen_display_id
            ):
                raise DisplayExportError(
                    "identity tracker changed after the update was prepared"
                )
            self._active_display_ids = update.active_display_ids
            self._max_seen_display_id = update.max_seen_display_id
            self._last_frame_seq = update.decoded.header.frame_seq
            self._last_source_tick = update.decoded.header.source_tick

    def validate_and_commit(self, frame: object) -> DisplayFrameView:
        """Standalone one-step validation for callers with no downstream sink."""

        update = self.prepare(frame)
        self.commit(update)
        return update.decoded


__all__ = ["DisplayIdentityTracker", "DisplayIdentityUpdate"]
