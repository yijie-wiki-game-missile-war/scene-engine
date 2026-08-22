"""Canonical generic presentation control V2 with opaque authority cursors."""

from __future__ import annotations

import base64
import binascii
import json
import re
import unicodedata
from typing import Any, Dict

from .authority_cursor import AuthorityCursorEnvelope
from .errors import PresentationControlError


SCENE_PRESENTATION_CONTROL_PROTOCOL = "scene-presentation-control-v2"
SCENE_PRESENTATION_CONTROL_SCHEMA_VERSION = 1
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
_DECIMAL_U64_OR_ZERO = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_U64 = (1 << 64) - 1
_MAX_SAFE_INTEGER = (1 << 53) - 1


def encode_presentation_control_v2(message: Any, *, direction: str) -> bytes:
    normalized = validate_presentation_control_v2(message, direction=direction)
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


def parse_presentation_control_v2(data: Any, *, direction: str) -> Dict[str, Any]:
    try:
        raw = bytes(memoryview(data).cast("B")) if not isinstance(data, bytes) else data
    except (TypeError, ValueError) as exc:
        raise PresentationControlError("control input must be bytes") from exc
    if not raw or len(raw) > PRESENTATION_CONTROL_MAXIMUM_BYTES:
        raise PresentationControlError("control message byte length is invalid")
    try:
        parsed = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PresentationControlError("control message must be valid UTF-8 JSON") from exc
    normalized = validate_presentation_control_v2(parsed, direction=direction)
    if encode_presentation_control_v2(normalized, direction=direction) != raw:
        raise PresentationControlError("control JSON bytes are not canonical")
    return normalized


def validate_presentation_control_v2(message: Any, *, direction: str) -> Dict[str, Any]:
    allowed_types = _TYPES_BY_DIRECTION.get(direction)
    if allowed_types is None:
        raise PresentationControlError("control direction is invalid")
    value = _plain_object(message, _COMMON_KEYS, "control envelope")
    if value["protocol"] != SCENE_PRESENTATION_CONTROL_PROTOCOL:
        raise PresentationControlError("control protocol is invalid")
    if value["schema_version"] != SCENE_PRESENTATION_CONTROL_SCHEMA_VERSION:
        raise PresentationControlError("control schema_version is invalid")
    message_type = value["type"]
    if message_type not in allowed_types:
        raise PresentationControlError("control type is invalid for direction")
    _text(value["message_id"], "message_id", maximum=160)
    _safe_integer(value["session_seq"], "session_seq", minimum=1)
    _text(value["viewer_scope"], "viewer_scope", maximum=160)
    _decimal_u64(value["scene_epoch"], "scene_epoch")
    _decimal_u64(value["bootstrap_id"], "bootstrap_id")
    if message_type == "presentation.ready":
        payload = _ready(value["payload"])
    elif message_type == "presentation.ack":
        payload = _ack(value["payload"])
    elif message_type == "presentation.resync_request":
        payload = _resync(value["payload"])
    elif message_type == "presentation.reset":
        payload = _reset(value["payload"])
    else:
        payload = _correlation(value["payload"])
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


def cursor_envelope_to_json(envelope: AuthorityCursorEnvelope) -> Dict[str, str]:
    if not isinstance(envelope, AuthorityCursorEnvelope):
        raise PresentationControlError("authority cursor must be an envelope")
    return {
        "canonical_bytes_base64": base64.b64encode(envelope.canonical_bytes).decode("ascii"),
        "codec_identity": envelope.codec_identity,
    }


def cursor_envelope_from_json(value: Any) -> AuthorityCursorEnvelope:
    value = _plain_object(
        value,
        frozenset(("canonical_bytes_base64", "codec_identity")),
        "authority cursor envelope",
    )
    encoded = value["canonical_bytes_base64"]
    if not isinstance(encoded, str) or not encoded:
        raise PresentationControlError("authority cursor base64 is invalid")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PresentationControlError("authority cursor base64 is invalid") from exc
    envelope = AuthorityCursorEnvelope(value["codec_identity"], raw)
    if base64.b64encode(envelope.canonical_bytes).decode("ascii") != encoded:
        raise PresentationControlError("authority cursor base64 is not canonical")
    return envelope


def _ready(value: Any) -> Dict[str, Any]:
    value = _plain_object(value, frozenset(("authority_baseline", "profile_id")), "ready payload")
    return {
        "authority_baseline": cursor_envelope_to_json(cursor_envelope_from_json(value["authority_baseline"])),
        "profile_id": _text(value["profile_id"], "profile_id", maximum=160),
    }


def _ack(value: Any) -> Dict[str, Any]:
    value = _plain_object(
        value,
        frozenset(("authority_cursor", "correlation_seq", "frame_seq")),
        "ack payload",
    )
    cursor = value["authority_cursor"]
    if cursor is not None:
        cursor = cursor_envelope_to_json(cursor_envelope_from_json(cursor))
    return {
        "authority_cursor": cursor,
        "correlation_seq": _decimal_u64(value["correlation_seq"], "correlation_seq"),
        "frame_seq": _decimal_u64(value["frame_seq"], "frame_seq"),
    }


def _resync(value: Any) -> Dict[str, Any]:
    value = _plain_object(value, frozenset(("last_frame_seq", "reason")), "resync payload")
    last = value["last_frame_seq"]
    if last is not None:
        last = _decimal_u64(last, "last_frame_seq")
    return {"last_frame_seq": last, "reason": _text(value["reason"], "reason", maximum=160)}


def _reset(value: Any) -> Dict[str, Any]:
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


def _correlation(value: Any) -> Dict[str, Any]:
    value = _plain_object(
        value,
        frozenset(
            (
                "authority_cursor",
                "correlation_seq",
                "frame_refs",
                "presentation_required",
                "projection_id",
                "source_tick",
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
        "authority_cursor": cursor_envelope_to_json(cursor_envelope_from_json(value["authority_cursor"])),
        "correlation_seq": _decimal_u64(value["correlation_seq"], "correlation_seq"),
        "frame_refs": normalized_refs,
        "presentation_required": required,
        "projection_id": _decimal_u64(value["projection_id"], "projection_id"),
        "source_tick": _decimal_u64(value["source_tick"], "source_tick", allow_zero=True),
    }


def _plain_object(value: Any, keys: frozenset[str], label: str) -> Dict[str, Any]:
    if not isinstance(value, dict) or frozenset(value) != keys:
        raise PresentationControlError("{} has unknown or missing fields".format(label))
    return value


def _text(value: Any, field: str, maximum: int) -> str:
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


def _safe_integer(value: Any, field: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= _MAX_SAFE_INTEGER:
        raise PresentationControlError("{} is not a safe integer".format(field))
    return value


def _decimal_u64(value: Any, field: str, *, allow_zero: bool = False) -> str:
    pattern = _DECIMAL_U64_OR_ZERO if allow_zero else _DECIMAL_U64
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise PresentationControlError("{} is not canonical decimal u64".format(field))
    if int(value) > _MAX_U64:
        raise PresentationControlError("{} exceeds u64".format(field))
    return value


__all__ = [
    "PRESENTATION_CONTROL_CLIENT_TO_SERVER",
    "PRESENTATION_CONTROL_MAXIMUM_BYTES",
    "PRESENTATION_CONTROL_SERVER_TO_CLIENT",
    "SCENE_PRESENTATION_CONTROL_PROTOCOL",
    "SCENE_PRESENTATION_CONTROL_SCHEMA_VERSION",
    "cursor_envelope_from_json",
    "cursor_envelope_to_json",
    "encode_presentation_control_v2",
    "parse_presentation_control_v2",
    "validate_presentation_control_v2",
]
