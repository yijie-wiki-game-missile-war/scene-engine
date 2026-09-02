"""Authority-node pointer events shared by browser Display and Python products."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from .display import MAXIMUM_NODE_ID
from .errors import ConfigurationError
from .json_tree import validate_json_value


POINTER_NODE_EVENT_INPUT_COMMAND = "display.pointer-event"
POINTER_NODE_EVENT_NAMES = (
    "click",
    "context-click",
    "double-click",
    "drag-grab",
    "drag-move",
    "drag-drop",
    "proximity-enter",
    "proximity-move",
    "proximity-leave",
)
_POINTER_NODE_EVENT_NAME_SET = frozenset(POINTER_NODE_EVENT_NAMES)


@dataclass(frozen=True, slots=True)
class PointerNodeEvent:
    """One pointer event addressed to a cross-language authority Node ID."""

    node_id: int
    event_name: str
    payload: Mapping[str, Any]

    def __post_init__(self) -> None:
        _validate_node_id_and_event_name(self.node_id, self.event_name)
        if not isinstance(self.payload, Mapping):
            raise ConfigurationError("pointer node event payload must be a JSON object")
        payload = _thaw_json(self.payload)
        validate_json_value(payload)
        if payload.get("phase") != self.event_name:
            raise ConfigurationError("pointer node event payload phase is invalid")
        start_interaction = payload.get("startInteraction")
        target = (
            start_interaction.get("target")
            if isinstance(start_interaction, Mapping)
            else None
        )
        if not isinstance(target, Mapping) or target.get("authorityNodeId") != self.node_id:
            raise ConfigurationError("pointer node event payload target is invalid")
        object.__setattr__(self, "payload", _freeze_json(payload))

    @classmethod
    def from_engine_input(cls, request: Any) -> "PointerNodeEvent | None":
        """Decode the reserved input command, or return ``None`` for another input."""

        if getattr(request, "command", None) != POINTER_NODE_EVENT_INPUT_COMMAND:
            return None
        args = getattr(request, "args", None)
        if not isinstance(args, Mapping) or set(args) != {
            "node_id",
            "event_name",
            "payload",
        }:
            raise ConfigurationError("pointer node event input is invalid")
        payload = args["payload"]
        if not isinstance(payload, Mapping):
            raise ConfigurationError("pointer node event input is invalid")
        return cls(
            node_id=args["node_id"],
            event_name=args["event_name"],
            payload=dict(payload),
        )

    def to_input_args(self) -> dict[str, Any]:
        """Return the canonical JSON args for ``SceneEngineClient.encodeInput``."""

        return {
            "node_id": self.node_id,
            "event_name": self.event_name,
            "payload": _thaw_json(self.payload),
        }


class PointerNodeEventHub:
    """Synchronous per-node listener registry usable inside ``handle_input``."""

    def __init__(self) -> None:
        self._listeners: dict[
            tuple[int, str], list[Callable[[PointerNodeEvent], Any]]
        ] = {}

    def add_event_listener(
        self,
        node_id: int,
        event_name: str,
        listener: Callable[[PointerNodeEvent], Any],
    ) -> Callable[[], None]:
        _validate_node_id_and_event_name(node_id, event_name)
        if not callable(listener):
            raise ConfigurationError("pointer node event listener is invalid")
        key = (node_id, event_name)
        listeners = self._listeners.setdefault(key, [])
        if not any(entry is listener for entry in listeners):
            listeners.append(listener)
        active = True

        def remove() -> None:
            nonlocal active
            if not active:
                return
            active = False
            current = self._listeners.get(key)
            if current is None:
                return
            self._listeners[key] = [entry for entry in current if entry is not listener]
            if not self._listeners[key]:
                del self._listeners[key]

        return remove

    def dispatch(self, event: PointerNodeEvent) -> None:
        if not isinstance(event, PointerNodeEvent):
            raise ConfigurationError("pointer node event is invalid")
        for listener in tuple(
            self._listeners.get((event.node_id, event.event_name), ())
        ):
            result = listener(event)
            if inspect.isawaitable(result):
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise ConfigurationError(
                    "pointer node event listener must complete synchronously"
                )

    def dispatch_engine_input(self, request: Any) -> PointerNodeEvent | None:
        """Decode and dispatch a pointer input from ``EngineProgram.handle_input``."""

        event = PointerNodeEvent.from_engine_input(request)
        if event is not None:
            self.dispatch(event)
        return event

    def clear(self) -> None:
        self._listeners.clear()


def _freeze_json(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(entry) for key, entry in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(entry) for entry in value)
    return value


def _validate_node_id_and_event_name(node_id: Any, event_name: Any) -> None:
    if (
        isinstance(node_id, bool)
        or not isinstance(node_id, int)
        or not 0 <= node_id <= MAXIMUM_NODE_ID
    ):
        raise ConfigurationError("pointer node event node_id is invalid")
    if event_name not in _POINTER_NODE_EVENT_NAME_SET:
        raise ConfigurationError("pointer node event name is invalid")


def _thaw_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw_json(entry) for key, entry in value.items()}
    if isinstance(value, tuple):
        return [_thaw_json(entry) for entry in value]
    return value
