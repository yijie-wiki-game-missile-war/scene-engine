"""Exact canonical JSON control and correlation schema for presentation flow."""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Dict

from .errors import PresentationControlError


SCENE_DISPLAY_CONTROL_PROTOCOL = "scene-display-control-v1"
SCENE_DISPLAY_CONTROL_SCHEMA_VERSION = 1
PRESENTATION_CONTROL_CLIENT_TO_SERVER = "client-to-server"
PRESENTATION_CONTROL_SERVER_TO_CLIENT = "server-to-client"
PRESENTATION_CONTROL_MAXIMUM_BYTES = 256 * 1024

_COMMON_KEYS = frozenset(
    (
        "bootstrap_id",
        "message_id",
        "payload",
        "protocol",
        "scene_epoch",
        "schema_version",
        "session_seq",
        "type",
        "viewer_scope",
    )
)
_TYPES_BY_DIRECTION = {
    PRESENTATION_CONTROL_CLIENT_TO_SERVER: frozenset(
        ("presentation.ready", "presentation.ack", "presentation.resync_request")
    ),
    PRESENTATION_CONTROL_SERVER_TO_CLIENT: frozenset(
        ("presentation.reset", "presentation.correlation")
    ),
}
_DECIMAL_U64 = re.compile(r"[1-9][0-9]*\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_U64 = (1 << 64) - 1
_MAX_SAFE_INTEGER = (1 << 53) - 1


def encode_presentation_control(message: Any, *, direction: str) -> bytes:
    normalized = validate_presentation_control(message, direction=direction)
    try:
        return json.dumps(
            normalized,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise PresentationControlError("control message is not canonical JSON") from exc


def parse_presentation_control(data: Any, *, direction: str) -> Dict[str, Any]:
    try:
        raw = bytes(memoryview(data).cast("B")) if not isinstance(data, bytes) else data
    except (TypeError, ValueError) as exc:
        raise PresentationControlError("control input must be bytes") from exc
    if not raw or len(raw) > PRESENTATION_CONTROL_MAXIMUM_BYTES:
        raise PresentationControlError("control message byte length is invalid")
    try:
        text = raw.decode("utf-8", errors="strict")
        parsed = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PresentationControlError("control message must be valid UTF-8 JSON") from exc
    normalized = validate_presentation_control(parsed, direction=direction)
    if encode_presentation_control(normalized, direction=direction) != raw:
        raise PresentationControlError("control JSON bytes are not canonical")
    return normalized


def validate_presentation_control(message: Any, *, direction: str) -> Dict[str, Any]:
    allowed_types = _TYPES_BY_DIRECTION.get(direction)
    if allowed_types is None:
        raise PresentationControlError("control direction is invalid")
    value = _plain_object(message, _COMMON_KEYS, "control envelope")
    if value["protocol"] != SCENE_DISPLAY_CONTROL_PROTOCOL:
        raise PresentationControlError("control protocol is invalid")
    if value["schema_version"] != SCENE_DISPLAY_CONTROL_SCHEMA_VERSION:
        raise PresentationControlError("control schema_version is invalid")
    message_type = value["type"]
    if message_type not in allowed_types:
        raise PresentationControlError("control type is invalid for direction")
    _text(value["message_id"], "message_id", maximum=160)
    _safe_integer(value["session_seq"], "session_seq", minimum=1)
    _text(value["viewer_scope"], "viewer_scope", maximum=160)
    _decimal_u64(value["scene_epoch"], "scene_epoch")
    _decimal_u64(value["bootstrap_id"], "bootstrap_id")
    payload = value["payload"]
    if message_type == "presentation.ready":
        payload = _ready(payload)
    elif message_type == "presentation.ack":
        payload = _ack(payload)
    elif message_type == "presentation.resync_request":
        payload = _resync(payload)
    elif message_type == "presentation.reset":
        payload = _reset(payload)
    else:
        payload = _correlation(payload, value)
    return {
        "bootstrap_id": value["bootstrap_id"],
        "message_id": value["message_id"],
        "payload": payload,
        "protocol": value["protocol"],
        "scene_epoch": value["scene_epoch"],
        "schema_version": value["schema_version"],
        "session_seq": value["session_seq"],
        "type": message_type,
        "viewer_scope": value["viewer_scope"],
    }


def _ready(value):
    value = _plain_object(value, frozenset(("baseline", "profile_id")), "ready payload")
    return {
        "baseline": _cursor(value["baseline"]),
        "profile_id": _text(value["profile_id"], "profile_id", maximum=160),
    }


def _ack(value):
    value = _plain_object(
        value,
        frozenset(("committed_cursor", "correlation_seq", "frame_seq")),
        "ack payload",
    )
    cursor = value["committed_cursor"]
    if cursor is not None:
        cursor = _cursor(cursor)
    return {
        "committed_cursor": cursor,
        "correlation_seq": _decimal_u64(value["correlation_seq"], "correlation_seq"),
        "frame_seq": _decimal_u64(value["frame_seq"], "frame_seq"),
    }


def _resync(value):
    value = _plain_object(value, frozenset(("last_frame_seq", "reason")), "resync payload")
    last = value["last_frame_seq"]
    if last is not None:
        last = _decimal_u64(last, "last_frame_seq")
    return {
        "last_frame_seq": last,
        "reason": _text(value["reason"], "reason", maximum=160),
    }


def _reset(value):
    value = _plain_object(
        value,
        frozenset(("next_bootstrap_id", "next_scene_epoch", "reason")),
        "reset payload",
    )
    return {
        "next_bootstrap_id": _decimal_u64(value["next_bootstrap_id"], "next_bootstrap_id"),
        "next_scene_epoch": _decimal_u64(value["next_scene_epoch"], "next_scene_epoch"),
        "reason": _text(value["reason"], "reason", maximum=160),
    }


def _correlation(value, envelope):
    value = _plain_object(
        value,
        frozenset(
            (
                "cursor",
                "frame_refs",
                "presentation_required",
                "projection_id",
                "record_seq",
            )
        ),
        "correlation payload",
    )
    required = value["presentation_required"]
    if not isinstance(required, bool):
        raise PresentationControlError("presentation_required must be boolean")
    refs = value["frame_refs"]
    if not isinstance(refs, list):
        raise PresentationControlError("frame_refs must be an array")
    normalized_refs = []
    previous = 0
    for item in refs:
        item = _plain_object(item, frozenset(("frame_seq", "sha256")), "frame ref")
        frame_seq = _decimal_u64(item["frame_seq"], "frame_seq")
        numeric = int(frame_seq)
        if numeric <= previous:
            raise PresentationControlError("frame_refs must be strictly increasing")
        sha256 = item["sha256"]
        if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
            raise PresentationControlError("frame ref sha256 is invalid")
        normalized_refs.append({"frame_seq": frame_seq, "sha256": sha256})
        previous = numeric
    if required != bool(normalized_refs):
        raise PresentationControlError("presentation_required and frame_refs disagree")
    return {
        "cursor": _cursor(value["cursor"]),
        "frame_refs": normalized_refs,
        "presentation_required": required,
        "projection_id": _decimal_u64(value["projection_id"], "projection_id"),
        "record_seq": _decimal_u64(value["record_seq"], "record_seq"),
    }


def _cursor(value):
    value = _plain_object(
        value,
        frozenset(
            (
                "snapshot_id",
                "state_epoch",
                "state_seq",
                "state_stream_id",
                "world_revision",
            )
        ),
        "v5 cursor",
    )
    return {
        "snapshot_id": _text(value["snapshot_id"], "snapshot_id", maximum=160),
        "state_epoch": _text(value["state_epoch"], "state_epoch", maximum=160),
        "state_seq": _safe_integer(value["state_seq"], "state_seq"),
        "state_stream_id": _text(value["state_stream_id"], "state_stream_id", maximum=160),
        "world_revision": _safe_integer(value["world_revision"], "world_revision"),
    }


def _plain_object(value, keys, label):
    if not isinstance(value, dict) or frozenset(value) != keys:
        raise PresentationControlError("{} has unknown or missing fields".format(label))
    return value


def _text(value, field, maximum):
    if (
        not isinstance(value, str)
        or not value
        or value.strip() != value
        or "\x00" in value
        or len(value) > maximum
        or unicodedata.normalize("NFC", value) != value
    ):
        raise PresentationControlError("{} is not a canonical string".format(field))
    return value


def _safe_integer(value, field, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= _MAX_SAFE_INTEGER:
        raise PresentationControlError("{} is not a safe integer".format(field))
    return value


def _decimal_u64(value, field):
    if not isinstance(value, str) or not _DECIMAL_U64.fullmatch(value):
        raise PresentationControlError("{} is not canonical decimal u64".format(field))
    if int(value) > _MAX_U64:
        raise PresentationControlError("{} exceeds u64".format(field))
    return value


__all__ = [
    "PRESENTATION_CONTROL_CLIENT_TO_SERVER",
    "PRESENTATION_CONTROL_MAXIMUM_BYTES",
    "PRESENTATION_CONTROL_SERVER_TO_CLIENT",
    "SCENE_DISPLAY_CONTROL_PROTOCOL",
    "SCENE_DISPLAY_CONTROL_SCHEMA_VERSION",
    "encode_presentation_control",
    "parse_presentation_control",
    "validate_presentation_control",
]
