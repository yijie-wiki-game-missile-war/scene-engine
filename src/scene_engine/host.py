"""Convenience composition of runtime, canonical writer, and latest mailbox."""

from __future__ import annotations

from threading import Lock
from typing import Optional

from .binary_schema import UINT16_MAX, UINT64_MAX
from .clock import MonotonicClock
from .display_frame import DisplayFrameLimits, DisplayFrameWriter
from .errors import ConfigurationError
from .identity import DisplayIdentityTracker
from .latest_mailbox import DisplayFrameLease, LatestFrameMailbox
from .runtime import PumpResult, RuntimeConfig, RuntimeHealth, SceneEngineRuntime
from .types import GameSimulation, Tick


class SceneEngine:
    """Batteries-connected host for the first Python vertical slice.

    The lower-level :class:`SceneEngineRuntime` remains binary-neutral.  This
    host wires its display samples to the canonical v1 writer and a bounded
    latest-only mailbox, then exposes the polling API from the architecture
    draft.  Bootstrap, WebSocket, Replay, and renderer work remain outside this
    class.
    """

    def __init__(
        self,
        simulation: GameSimulation,
        *,
        config: Optional[RuntimeConfig] = None,
        clock: Optional[MonotonicClock] = None,
        scene_epoch: int = 1,
        bootstrap_id: int = 1,
        initial_tick: Tick = 0,
    ) -> None:
        resolved_config = config if config is not None else RuntimeConfig()
        if not isinstance(resolved_config, RuntimeConfig):
            raise ConfigurationError("config must be a RuntimeConfig")
        DisplayFrameLimits(
            maximum_frame_entities=resolved_config.maximum_frame_entities,
            maximum_frame_bytes=resolved_config.maximum_frame_bytes,
        )
        if resolved_config.ticks_per_second > UINT16_MAX:
            raise ConfigurationError(
                "ticks_per_second cannot be represented by DisplayFrameHeaderV1"
            )
        _require_host_uint("scene_epoch", scene_epoch, maximum=UINT64_MAX)
        _require_host_uint("bootstrap_id", bootstrap_id, maximum=UINT64_MAX)
        _require_host_uint(
            "initial_tick",
            initial_tick,
            minimum=0,
            maximum=UINT64_MAX - 1,
        )
        self._mailbox = LatestFrameMailbox(
            maximum_outstanding_leases=(
                resolved_config.maximum_outstanding_leases
            )
        )
        self._identity_tracker = DisplayIdentityTracker(
            scene_epoch=scene_epoch,
            bootstrap_id=bootstrap_id,
            maximum_frame_entities=resolved_config.maximum_frame_entities,
            maximum_frame_bytes=resolved_config.maximum_frame_bytes,
        )
        self._publish_lock = Lock()
        self._runtime = SceneEngineRuntime(
            simulation,
            config=resolved_config,
            clock=clock,
            writer_factory=DisplayFrameWriter,
            frame_sink=self._publish_frame,
            scene_epoch=scene_epoch,
            bootstrap_id=bootstrap_id,
            initial_tick=initial_tick,
        )

    @property
    def runtime(self) -> SceneEngineRuntime:
        return self._runtime

    @property
    def latest_display_frame_seq(self) -> Optional[int]:
        return self._mailbox.latest_frame_seq

    @property
    def max_seen_display_id(self) -> int:
        return self._identity_tracker.max_seen_display_id

    @property
    def active_display_ids(self) -> frozenset[int]:
        return self._identity_tracker.active_display_ids

    @property
    def current_tick(self) -> Tick:
        return self._runtime.current_tick

    @property
    def scene_epoch(self) -> int:
        return self._runtime.scene_epoch

    @property
    def bootstrap_id(self) -> int:
        return self._runtime.bootstrap_id

    @property
    def health(self) -> RuntimeHealth:
        return self._runtime.health

    def enqueue_command(self, command: object) -> Tick:
        return self._runtime.enqueue_command(command)

    def pump(self) -> PumpResult:
        return self._runtime.pump()

    def acquire_latest_display_frame(
        self,
        after_frame_seq: int,
    ) -> Optional[DisplayFrameLease]:
        return self._mailbox.acquire_latest(after_frame_seq=after_frame_seq)

    def release_display_frame(self, lease_token: int) -> None:
        self._mailbox.release(lease_token)

    def stop(self) -> None:
        self._runtime.stop()

    def _publish_frame(self, frame: object) -> None:
        with self._publish_lock:
            identity_update = self._identity_tracker.prepare(frame)
            self._mailbox.publish(frame)
            self._identity_tracker.commit(identity_update)


def _require_host_uint(
    name: str,
    value: object,
    *,
    minimum: int = 1,
    maximum: int,
) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigurationError("{} must be an integer".format(name))
    if value < minimum or value > maximum:
        raise ConfigurationError(
            "{} must be in [{}, {}]".format(name, minimum, maximum)
        )


__all__ = ["SceneEngine"]
