"""Renderer-neutral reconciliation for complete dynamic display frames."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from operator import index
from threading import Lock
from types import MappingProxyType
from typing import Mapping, Optional, Tuple, Union

from .display_frame import (
    DisplayFrameLimits,
    DynamicEntityRecordV1,
    parse_display_frame,
)
from .errors import ConfigurationError, ConsumerError, DisplayFrameError


VISIBLE_FLAG = 1 << 0
_UINT16_MAX = (1 << 16) - 1
_UINT64_MAX = (1 << 64) - 1


class StaleFramePolicy(str, Enum):
    """How a consumer reports an old or duplicate frame sequence."""

    IGNORE = "ignore"
    REJECT = "reject"


@dataclass(frozen=True)
class InstalledDisplayEntity:
    """Consumer-owned copy of one complete absolute entity record."""

    display_id: int
    visual_type_id: int
    flags: int
    world_position: Tuple[float, float, float]
    world_rotation_xyzw: Tuple[float, float, float, float]
    world_scale: Tuple[float, float, float]
    animation_state_id: int
    animation_start_tick: int
    animation_flags: int

    @property
    def visible(self) -> bool:
        return bool(self.flags & VISIBLE_FLAG)

    @property
    def position(self) -> Tuple[float, float, float]:
        return self.world_position

    @property
    def rotation_xyzw(self) -> Tuple[float, float, float, float]:
        return self.world_rotation_xyzw

    @property
    def scale(self) -> Tuple[float, float, float]:
        return self.world_scale


@dataclass(frozen=True)
class ConsumeResult:
    """Outcome and reconciliation counts for one ``consume`` call."""

    installed: bool
    reason: str
    frame_seq: int
    source_tick: int
    created_count: int
    updated_count: int
    removed_count: int
    active_entity_count: int

    @property
    def ignored(self) -> bool:
        return not self.installed


class CompleteFrameConsumer:
    """Validate and atomically install complete dynamic entity sets.

    The consumer is bound to one installed bootstrap.  Frame sequence and
    source-tick gaps are legal latest-only behavior; only a non-increasing
    frame sequence is stale.  Presence, not the visible flag, determines
    membership, and removal retires an ID for the remainder of the epoch.
    """

    def __init__(
        self,
        scene_epoch: int,
        bootstrap_id: int,
        *,
        maximum_frame_entities: int,
        maximum_frame_bytes: int,
        ticks_per_second: Optional[int] = None,
        stale_frame_policy: Union[StaleFramePolicy, str] = StaleFramePolicy.IGNORE,
    ) -> None:
        self._scene_epoch = _configuration_uint(
            "scene_epoch", scene_epoch, maximum=_UINT64_MAX
        )
        self._bootstrap_id = _configuration_uint(
            "bootstrap_id", bootstrap_id, maximum=_UINT64_MAX
        )
        limits = DisplayFrameLimits(
            maximum_frame_entities=maximum_frame_entities,
            maximum_frame_bytes=maximum_frame_bytes,
        )
        self._maximum_frame_entities = limits.maximum_frame_entities
        self._maximum_frame_bytes = limits.maximum_frame_bytes
        self._configured_ticks_per_second = _optional_ticks_per_second(
            ticks_per_second
        )
        self._ticks_per_second = self._configured_ticks_per_second
        try:
            self._stale_frame_policy = StaleFramePolicy(stale_frame_policy)
        except (TypeError, ValueError):
            raise ConfigurationError(
                "stale_frame_policy must be 'ignore' or 'reject'"
            )

        self._lock = Lock()
        self._installed_frame_seq: Optional[int] = None
        self._installed_source_tick: Optional[int] = None
        self._entities = {}  # type: dict[int, InstalledDisplayEntity]
        self._max_seen_display_id = 0

    @property
    def scene_epoch(self) -> int:
        return self._scene_epoch

    @property
    def current_scene_epoch(self) -> int:
        return self._scene_epoch

    @property
    def bootstrap_id(self) -> int:
        return self._bootstrap_id

    @property
    def current_bootstrap_id(self) -> int:
        return self._bootstrap_id

    @property
    def ticks_per_second(self) -> Optional[int]:
        with self._lock:
            return self._ticks_per_second

    @property
    def installed_frame_seq(self) -> Optional[int]:
        with self._lock:
            return self._installed_frame_seq

    @property
    def installed_source_tick(self) -> Optional[int]:
        with self._lock:
            return self._installed_source_tick

    @property
    def entities_by_display_id(self) -> Mapping[int, InstalledDisplayEntity]:
        with self._lock:
            # Reconciliation never mutates an installed dictionary in place, so
            # a read-only snapshot remains stable after the lock is released.
            return MappingProxyType(self._entities)

    @property
    def entities(self) -> Mapping[int, InstalledDisplayEntity]:
        return self.entities_by_display_id

    @property
    def max_seen_display_id(self) -> int:
        with self._lock:
            return self._max_seen_display_id

    def consume(self, frame: object) -> ConsumeResult:
        """Fully parse and atomically reconcile a bytes-like or sealed frame.

        Parser errors propagate as ``DisplayFrameError``.  Consumer-stream
        violations (bootstrap identity, timing profile, stale rejection, or ID
        reuse) raise ``ConsumerError``.  In every failure case installed state
        is unchanged.
        """

        canonical = _immutable_frame_bytes(frame)
        decoded = parse_display_frame(
            canonical,
            maximum_frame_entities=self._maximum_frame_entities,
            maximum_frame_bytes=self._maximum_frame_bytes,
        )

        header = decoded.header
        if header.scene_epoch != self._scene_epoch:
            raise ConsumerError(
                "display frame scene_epoch {} does not match installed epoch {}".format(
                    header.scene_epoch, self._scene_epoch
                )
            )
        if header.bootstrap_id != self._bootstrap_id:
            raise ConsumerError(
                "display frame bootstrap_id {} does not match installed bootstrap {}".format(
                    header.bootstrap_id, self._bootstrap_id
                )
            )

        # Detach renderer state from the input buffer/lease before acquiring the
        # state lock.  The parser has already validated every record and count.
        incoming = {
            record.display_id: _copy_record(record) for record in decoded.records
        }

        with self._lock:
            installed_seq = self._installed_frame_seq
            if installed_seq is not None and header.frame_seq <= installed_seq:
                if self._stale_frame_policy is StaleFramePolicy.REJECT:
                    raise ConsumerError(
                        "stale display frame sequence {} is not newer than {}".format(
                            header.frame_seq, installed_seq
                        )
                    )
                return ConsumeResult(
                    installed=False,
                    reason="stale_frame_seq",
                    frame_seq=header.frame_seq,
                    source_tick=header.source_tick,
                    created_count=0,
                    updated_count=0,
                    removed_count=0,
                    active_entity_count=len(self._entities),
                )

            installed_source_tick = self._installed_source_tick
            if (
                installed_source_tick is not None
                and header.source_tick < installed_source_tick
            ):
                raise ConsumerError(
                    "display frame source_tick {} precedes installed tick {}".format(
                        header.source_tick, installed_source_tick
                    )
                )

            expected_ticks_per_second = self._ticks_per_second
            if (
                expected_ticks_per_second is not None
                and header.ticks_per_second != expected_ticks_per_second
            ):
                raise ConsumerError(
                    "display frame ticks_per_second {} does not match {}".format(
                        header.ticks_per_second, expected_ticks_per_second
                    )
                )

            previous = self._entities
            previous_ids = previous.keys()
            incoming_ids = incoming.keys()
            removed_ids = set(previous_ids).difference(incoming_ids)
            created_ids = set(incoming_ids).difference(previous_ids)
            updated_ids = set(incoming_ids).intersection(previous_ids)
            invalid_new_ids = [
                display_id
                for display_id in created_ids
                if display_id <= self._max_seen_display_id
            ]
            if invalid_new_ids:
                first_invalid = min(invalid_new_ids)
                raise ConsumerError(
                    "retired or non-monotonic display_id {} reappeared in "
                    "epoch {}".format(first_invalid, self._scene_epoch)
                )
            next_max_seen_display_id = max(
                self._max_seen_display_id,
                max(incoming_ids, default=0),
            )

            # This is the commit point.  No mutation of consumer state occurs
            # before every validation and reconciliation calculation succeeds.
            self._entities = incoming
            self._max_seen_display_id = next_max_seen_display_id
            self._installed_frame_seq = header.frame_seq
            self._installed_source_tick = header.source_tick
            if self._ticks_per_second is None:
                self._ticks_per_second = header.ticks_per_second

            return ConsumeResult(
                installed=True,
                reason="installed",
                frame_seq=header.frame_seq,
                source_tick=header.source_tick,
                created_count=len(created_ids),
                updated_count=len(updated_ids),
                removed_count=len(removed_ids),
                active_entity_count=len(incoming),
            )

    def apply(self, frame: object) -> ConsumeResult:
        """Readable alias for adapters which call reconciliation ``apply``."""

        return self.consume(frame)


def _copy_record(record: DynamicEntityRecordV1) -> InstalledDisplayEntity:
    return InstalledDisplayEntity(
        display_id=record.display_id,
        visual_type_id=record.visual_type_id,
        flags=record.flags,
        world_position=tuple(record.world_position),
        world_rotation_xyzw=tuple(record.world_rotation_xyzw),
        world_scale=tuple(record.world_scale),
        animation_state_id=record.animation_state_id,
        animation_start_tick=record.animation_start_tick,
        animation_flags=record.animation_flags,
    )


def _immutable_frame_bytes(frame: object) -> bytes:
    if isinstance(frame, bytes):
        return frame
    if isinstance(frame, (bytearray, memoryview)):
        raw = frame
    else:
        try:
            raw = getattr(frame, "data")
        except AttributeError:
            raise ConsumerError(
                "consume expects canonical bytes or a sealed frame with data"
            )
        if isinstance(raw, bytes):
            return raw

    try:
        view = memoryview(raw)
    except TypeError:
        raise DisplayFrameError("display frame data is not bytes-like")
    if not view.c_contiguous:
        raise DisplayFrameError("display frame data must be C-contiguous")
    try:
        byte_view = view.cast("B")
    except (TypeError, ValueError):
        raise DisplayFrameError("display frame data must be byte-addressable")
    return byte_view.tobytes()


def _configuration_uint(name: str, value: object, *, maximum: int) -> int:
    if isinstance(value, bool):
        raise ConfigurationError("{} must be an integer".format(name))
    try:
        result = index(value)
    except TypeError:
        raise ConfigurationError("{} must be an integer".format(name))
    if result < 0 or result > maximum:
        raise ConfigurationError(
            "{} must be in [0, {}]".format(name, maximum)
        )
    return result


def _optional_ticks_per_second(value: Optional[int]) -> Optional[int]:
    if value is None:
        return None
    result = _configuration_uint(
        "ticks_per_second",
        value,
        maximum=_UINT16_MAX,
    )
    if result == 0:
        raise ConfigurationError("ticks_per_second must be greater than zero")
    return result


__all__ = [
    "CompleteFrameConsumer",
    "ConsumeResult",
    "InstalledDisplayEntity",
    "StaleFramePolicy",
    "VISIBLE_FLAG",
]
