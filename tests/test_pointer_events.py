from __future__ import annotations

import pytest

from scene_engine import (
    ConfigurationError,
    EngineInput,
    POINTER_NODE_EVENT_INPUT_COMMAND,
    POINTER_NODE_EVENT_NAMES,
    PointerNodeEvent,
    PointerNodeEventHub,
)
from scene_engine.wire import encode_input, read_engine_packet


def pointer_payload(node_id: int, event_name: str) -> dict[str, object]:
    return {
        "phase": event_name,
        "startInteraction": {"target": {"authorityNodeId": node_id}},
    }


@pytest.mark.parametrize("event_name", POINTER_NODE_EVENT_NAMES)
def test_pointer_node_event_uses_existing_input_with_the_same_node_and_name(
    event_name: str,
) -> None:
    source = PointerNodeEvent(
        node_id=17,
        event_name=event_name,
        payload={**pointer_payload(17, event_name), "pointerId": 3, "worldRay": None},
    )
    raw = encode_input(
        input_id=f"pointer:{event_name}",
        observed_stream_id="stream",
        observed_commit_seq=4,
        command=POINTER_NODE_EVENT_INPUT_COMMAND,
        args=source.to_input_args(),
    )
    packet = read_engine_packet(raw)
    request = EngineInput(
        packet.header["input_id"],
        packet.header["observed_stream_id"],
        packet.header["observed_commit_seq"],
        packet.header["command"],
        packet.attachments[0].value,
    )

    decoded = PointerNodeEvent.from_engine_input(request)
    assert decoded == source
    assert decoded is not None
    assert decoded.node_id == 17
    assert decoded.event_name == event_name
    assert decoded.payload["phase"] == event_name
    assert PointerNodeEvent(decoded.node_id, decoded.event_name, decoded.payload) == decoded
    with pytest.raises(TypeError):
        decoded.payload["phase"] = "changed"  # type: ignore[index]


def test_pointer_node_event_decoder_ignores_other_inputs_and_rejects_malformed() -> None:
    other = EngineInput("other", "stream", 0, "game.command", {})
    assert PointerNodeEvent.from_engine_input(other) is None

    for args in (
        {},
        {"node_id": 1, "event_name": "click", "payload": pointer_payload(1, "drag-drop")},
        {"node_id": -1, "event_name": "click", "payload": pointer_payload(-1, "click")},
        {"node_id": 1, "event_name": "unknown", "payload": pointer_payload(1, "unknown")},
        {
            "node_id": 1,
            "event_name": "click",
            "payload": pointer_payload(1, "click"),
            "extra": True,
        },
    ):
        request = EngineInput(
            "bad",
            "stream",
            0,
            POINTER_NODE_EVENT_INPUT_COMMAND,
            args,
        )
        with pytest.raises(ConfigurationError):
            PointerNodeEvent.from_engine_input(request)


def test_python_pointer_node_listeners_are_synchronous_scoped_and_removable() -> None:
    hub = PointerNodeEventHub()
    event = PointerNodeEvent(4, "click", pointer_payload(4, "click"))
    received: list[PointerNodeEvent] = []

    def listener(value: PointerNodeEvent) -> None:
        received.append(value)

    remove = hub.add_event_listener(4, "click", listener)
    hub.add_event_listener(4, "click", listener)
    hub.add_event_listener(5, "click", lambda value: received.extend((value, value)))
    hub.dispatch(event)
    assert received == [event]
    remove()
    hub.dispatch(event)
    assert received == [event]

    async def asynchronous(_event: PointerNodeEvent) -> None:
        pass

    hub.add_event_listener(4, "click", asynchronous)
    with pytest.raises(ConfigurationError, match="synchronously"):
        hub.dispatch(event)


def test_python_hub_decodes_and_dispatches_inside_product_handle_input() -> None:
    hub = PointerNodeEventHub()
    received: list[PointerNodeEvent] = []
    hub.add_event_listener(9, "drag-drop", received.append)
    request = EngineInput(
        "drop:1",
        "stream",
        2,
        POINTER_NODE_EVENT_INPUT_COMMAND,
        {
            "node_id": 9,
            "event_name": "drag-drop",
            "payload": {
                **pointer_payload(9, "drag-drop"),
                "currentInteraction": None,
            },
        },
    )

    event = hub.dispatch_engine_input(request)
    assert event is not None
    assert received == [event]
