"""Canonical ``scene-engine-wire@2`` packet container and codecs.

The decoder validates an entire WebSocket binary message before exposing any
attachment. Product JSON remains opaque to the Engine, but every numeric value
must be finite and every object must be duplicate-free.
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import IntEnum
from types import MappingProxyType
from typing import Any

from .display import (
    ValidatedDisplayCommandStream,
    validate_display_checkpoint,
    validate_display_command_stream,
)
from .errors import ConfigurationError, WireError
from .json_tree import MAXIMUM_SAFE_INTEGER, WORLD_TREE_SCHEMA


WIRE_SCHEMA = "scene-engine-wire@2"
DISPLAY_CODEC = "scene-engine-display-node@3"
WIRE_MAGIC = b"SENG"
WIRE_MAJOR_VERSION = 2
_PACKET_HEADER = struct.Struct("<4sBBHIHH")
_ATTACHMENT_HEADER = struct.Struct("<BBHI")


class PacketKind(IntEnum):
    CHECKPOINT = 1
    COMMIT = 2
    INPUT = 3
    ACK = 4
    INPUT_RESULT = 5
    ERROR = 6


class AttachmentKind(IntEnum):
    WORLD_SNAPSHOT = 1
    WORLD_PATCH = 2
    DISPLAY_CHECKPOINT = 3
    DISPLAY_COMMAND_STREAM = 4
    INPUT_PAYLOAD = 6
    RESULT_PAYLOAD = 7


class AttachmentEncoding(IntEnum):
    RAW = 0
    JSON = 1


_TYPE_BY_KIND = {
    PacketKind.CHECKPOINT: "engine.checkpoint",
    PacketKind.COMMIT: "engine.commit",
    PacketKind.INPUT: "engine.input",
    PacketKind.ACK: "engine.ack",
    PacketKind.INPUT_RESULT: "engine.input_result",
    PacketKind.ERROR: "engine.error",
}
_KIND_BY_TYPE = {value: key for key, value in _TYPE_BY_KIND.items()}

_HEADER_FIELDS = {
    PacketKind.CHECKPOINT: (
        "schema",
        "type",
        "stream_id",
        "commit_seq",
        "source_tick",
        "world_revision",
        "last_command_seq",
        "world_codec",
        "display_codec",
    ),
    PacketKind.COMMIT: (
        "schema",
        "type",
        "stream_id",
        "commit_seq",
        "source_tick",
        "world_revision",
        "last_command_seq",
        "cause",
        "causation_id",
        "world_codec",
        "display_codec",
    ),
    PacketKind.INPUT: (
        "schema",
        "type",
        "input_id",
        "observed_stream_id",
        "observed_commit_seq",
        "command",
    ),
    PacketKind.ACK: (
        "schema",
        "type",
        "stream_id",
        "commit_seq",
        "last_command_seq",
    ),
    PacketKind.INPUT_RESULT: (
        "schema",
        "type",
        "input_id",
        "status",
        "reason_code",
    ),
    PacketKind.ERROR: ("schema", "type", "code", "fatal"),
}


@dataclass(frozen=True, slots=True)
class EngineLimits:
    maximum_packet_bytes: int = 64 * 1024 * 1024
    maximum_header_bytes: int = 64 * 1024
    maximum_attachment_count: int = 8
    maximum_attachment_bytes: int = 48 * 1024 * 1024
    maximum_world_patch_changes: int = 4096
    maximum_json_path_segments: int = 32
    maximum_json_depth: int = 256
    maximum_pending_inputs_per_client: int = 256
    maximum_in_flight_commits: int = 8
    maximum_session_pending_bytes: int = 64 * 1024 * 1024
    maximum_global_retained_packets: int = 4096
    maximum_global_retained_bytes: int = 256 * 1024 * 1024
    ack_timeout_ticks: int = 600

    def __post_init__(self) -> None:
        for field in self.__dataclass_fields__:
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise WireError(f"{field} must be a positive integer")
        if self.maximum_header_bytes > self.maximum_packet_bytes:
            raise WireError("maximum_header_bytes exceeds maximum_packet_bytes")
        if self.maximum_attachment_bytes > self.maximum_packet_bytes:
            raise WireError("maximum_attachment_bytes exceeds maximum_packet_bytes")
        if self.maximum_attachment_count > 0xFFFF:
            raise WireError("maximum_attachment_count exceeds uint16")


DEFAULT_ENGINE_LIMITS = EngineLimits()


@dataclass(frozen=True, slots=True)
class EngineAttachment:
    kind: AttachmentKind
    encoding: AttachmentEncoding
    value: Any
    bytes: bytes


@dataclass(frozen=True, slots=True)
class EnginePacket:
    kind: PacketKind
    header: Mapping[str, Any]
    attachments: tuple[EngineAttachment, ...]
    raw_bytes: bytes

    @property
    def type(self) -> str:
        return _TYPE_BY_KIND[self.kind]


def encode_engine_packet(
    kind: PacketKind | int | str,
    header: Mapping[str, Any],
    attachments: Iterable[EngineAttachment | tuple[Any, Any, Any]] = (),
    *,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> bytes:
    """Encode one canonical packet, reordering header keys by the contract."""

    packet_kind = _packet_kind(kind)
    normalized_header = _validate_header(packet_kind, header)
    header_bytes = _json_dumps(
        normalized_header,
        sort_keys=False,
        maximum_depth=limits.maximum_json_depth,
    )
    if len(header_bytes) > limits.maximum_header_bytes:
        raise WireError("header exceeds maximum_header_bytes")
    normalized_attachments = tuple(
        _normalize_attachment(value, limits=limits) for value in attachments
    )
    _validate_attachment_layout(
        packet_kind, normalized_header, normalized_attachments, limits
    )
    chunks = [
        _PACKET_HEADER.pack(
            WIRE_MAGIC,
            WIRE_MAJOR_VERSION,
            int(packet_kind),
            0,
            len(header_bytes),
            len(normalized_attachments),
            0,
        ),
        header_bytes,
    ]
    for attachment in normalized_attachments:
        chunks.append(
            _ATTACHMENT_HEADER.pack(
                int(attachment.kind),
                int(attachment.encoding),
                0,
                len(attachment.bytes),
            )
        )
        chunks.append(attachment.bytes)
    raw = b"".join(chunks)
    if len(raw) > limits.maximum_packet_bytes:
        raise WireError("packet exceeds maximum_packet_bytes")
    return raw


def read_engine_packet(
    data: Any, *, limits: EngineLimits = DEFAULT_ENGINE_LIMITS
) -> EnginePacket:
    """Decode and fully validate one complete Engine packet."""

    raw = _owned_bytes(data, "packet")
    if len(raw) > limits.maximum_packet_bytes:
        raise WireError("packet exceeds maximum_packet_bytes")
    if len(raw) < _PACKET_HEADER.size:
        raise WireError("packet header is truncated")
    magic, version, kind_value, flags, header_length, count, reserved = (
        _PACKET_HEADER.unpack_from(raw)
    )
    if magic != WIRE_MAGIC:
        raise WireError("packet magic is invalid")
    if version != WIRE_MAJOR_VERSION:
        raise WireError("packet major version is unsupported")
    if flags != 0 or reserved != 0:
        raise WireError("packet reserved fields must be zero")
    try:
        kind = PacketKind(kind_value)
    except ValueError as exc:
        raise WireError("packet kind is unknown") from exc
    if header_length > limits.maximum_header_bytes:
        raise WireError("header exceeds maximum_header_bytes")
    if count > limits.maximum_attachment_count:
        raise WireError("attachment count exceeds maximum_attachment_count")
    cursor = _PACKET_HEADER.size
    header_end = cursor + header_length
    if header_end > len(raw):
        raise WireError("packet header JSON is truncated")
    header_value = _json_loads(
        raw[cursor:header_end],
        label="packet header",
        maximum_depth=limits.maximum_json_depth,
    )
    header = _validate_header(kind, header_value)
    cursor = header_end
    attachments: list[EngineAttachment] = []
    for _ in range(count):
        if cursor + _ATTACHMENT_HEADER.size > len(raw):
            raise WireError("attachment header is truncated")
        kind_raw, encoding_raw, attachment_flags, payload_length = (
            _ATTACHMENT_HEADER.unpack_from(raw, cursor)
        )
        cursor += _ATTACHMENT_HEADER.size
        if attachment_flags != 0:
            raise WireError("attachment flags must be zero")
        try:
            attachment_kind = AttachmentKind(kind_raw)
            encoding = AttachmentEncoding(encoding_raw)
        except ValueError as exc:
            raise WireError("attachment kind or encoding is unknown") from exc
        if payload_length > limits.maximum_attachment_bytes:
            raise WireError("attachment exceeds maximum_attachment_bytes")
        end = cursor + payload_length
        if end > len(raw):
            raise WireError("attachment payload is truncated")
        payload = bytes(raw[cursor:end])
        cursor = end
        value = (
            _json_loads(
                payload,
                label=f"{attachment_kind.name} attachment",
                maximum_depth=limits.maximum_json_depth,
            )
            if encoding is AttachmentEncoding.JSON
            else payload
        )
        attachments.append(
            EngineAttachment(attachment_kind, encoding, value, payload)
        )
    if cursor != len(raw):
        raise WireError("packet has trailing bytes")
    frozen_attachments = tuple(attachments)
    _validate_attachment_layout(kind, header, frozen_attachments, limits)
    return EnginePacket(kind, MappingProxyType(header), frozen_attachments, raw)


def encode_checkpoint(
    *,
    stream_id: str,
    commit_seq: int,
    source_tick: int,
    world_revision: int,
    last_command_seq: int,
    world_codec: str,
    world_snapshot: Any,
    display_checkpoint: Any,
    display_codec: str = DISPLAY_CODEC,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> bytes:
    return encode_engine_packet(
        PacketKind.CHECKPOINT,
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.checkpoint",
            "stream_id": stream_id,
            "commit_seq": commit_seq,
            "source_tick": source_tick,
            "world_revision": world_revision,
            "last_command_seq": last_command_seq,
            "world_codec": world_codec,
            "display_codec": display_codec,
        },
        (
            (AttachmentKind.WORLD_SNAPSHOT, AttachmentEncoding.JSON, world_snapshot),
            (
                AttachmentKind.DISPLAY_CHECKPOINT,
                AttachmentEncoding.JSON,
                display_checkpoint,
            ),
        ),
        limits=limits,
    )


def encode_commit(
    *,
    stream_id: str,
    commit_seq: int,
    source_tick: int,
    world_revision: int,
    last_command_seq: int,
    cause: str,
    causation_id: str | None,
    world_codec: str,
    world_patch: Any,
    display_commands: Any,
    display_codec: str = DISPLAY_CODEC,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> bytes:
    attachments: list[tuple[Any, Any, Any]] = [
        (AttachmentKind.WORLD_PATCH, AttachmentEncoding.JSON, world_patch)
    ]
    attachments.append(
        (
            AttachmentKind.DISPLAY_COMMAND_STREAM,
            AttachmentEncoding.JSON,
            display_commands,
        )
    )
    return encode_engine_packet(
        PacketKind.COMMIT,
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.commit",
            "stream_id": stream_id,
            "commit_seq": commit_seq,
            "source_tick": source_tick,
            "world_revision": world_revision,
            "last_command_seq": last_command_seq,
            "cause": cause,
            "causation_id": causation_id,
            "world_codec": world_codec,
            "display_codec": display_codec,
        },
        attachments,
        limits=limits,
    )


def encode_input(
    *,
    input_id: str,
    observed_stream_id: str,
    observed_commit_seq: int,
    command: str,
    args: Any,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> bytes:
    return encode_engine_packet(
        PacketKind.INPUT,
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.input",
            "input_id": input_id,
            "observed_stream_id": observed_stream_id,
            "observed_commit_seq": observed_commit_seq,
            "command": command,
        },
        ((AttachmentKind.INPUT_PAYLOAD, AttachmentEncoding.JSON, args),),
        limits=limits,
    )


def encode_ack(
    *,
    stream_id: str,
    commit_seq: int,
    last_command_seq: int,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> bytes:
    return encode_engine_packet(
        PacketKind.ACK,
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.ack",
            "stream_id": stream_id,
            "commit_seq": commit_seq,
            "last_command_seq": last_command_seq,
        },
        limits=limits,
    )


def encode_input_result(
    *,
    input_id: str,
    status: str,
    reason_code: str | None,
    result: Any | None = None,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> bytes:
    attachments = (
        ()
        if result is None
        else ((AttachmentKind.RESULT_PAYLOAD, AttachmentEncoding.JSON, result),)
    )
    return encode_engine_packet(
        PacketKind.INPUT_RESULT,
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.input_result",
            "input_id": input_id,
            "status": status,
            "reason_code": reason_code,
        },
        attachments,
        limits=limits,
    )


def encode_error(
    *, code: str, fatal: bool = True, limits: EngineLimits = DEFAULT_ENGINE_LIMITS
) -> bytes:
    return encode_engine_packet(
        PacketKind.ERROR,
        {
            "schema": WIRE_SCHEMA,
            "type": "engine.error",
            "code": code,
            "fatal": fatal,
        },
        limits=limits,
    )


def canonical_json_bytes(value: Any) -> bytes:
    """Encode product JSON with deterministic recursive key ordering."""

    return _json_dumps(
        value,
        sort_keys=True,
        maximum_depth=DEFAULT_ENGINE_LIMITS.maximum_json_depth,
    )


def decode_json_bytes(data: Any) -> Any:
    """Decode the common finite/safe-integer JSON subset."""

    return _json_loads(
        _owned_bytes(data, "JSON"),
        label="JSON",
        maximum_depth=DEFAULT_ENGINE_LIMITS.maximum_json_depth,
    )


def _packet_kind(value: PacketKind | int | str) -> PacketKind:
    if isinstance(value, PacketKind):
        return value
    if isinstance(value, str):
        try:
            return _KIND_BY_TYPE[value]
        except KeyError as exc:
            raise WireError("packet type is unknown") from exc
    try:
        return PacketKind(value)
    except (TypeError, ValueError) as exc:
        raise WireError("packet kind is unknown") from exc


def _validate_header(kind: PacketKind, value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise WireError("packet header must be a plain object")
    fields = _HEADER_FIELDS[kind]
    if set(value) != set(fields) or any(not isinstance(key, str) for key in value):
        raise WireError("packet header fields do not match its kind")
    result = {field: value[field] for field in fields}
    if result["schema"] != WIRE_SCHEMA or result["type"] != _TYPE_BY_KIND[kind]:
        raise WireError("packet schema or type is invalid")

    if kind in (PacketKind.CHECKPOINT, PacketKind.COMMIT):
        _text(result["stream_id"], "stream_id")
        _safe_integer(result["commit_seq"], "commit_seq")
        _safe_integer(result["source_tick"], "source_tick")
        _safe_integer(result["world_revision"], "world_revision")
        _safe_integer(result["last_command_seq"], "last_command_seq")
        _identity(result["world_codec"], "world_codec")
        if result["display_codec"] != DISPLAY_CODEC:
            raise WireError("display_codec is unsupported")
    if kind is PacketKind.COMMIT:
        cause = result["cause"]
        if cause not in {"tick", "input", "system"}:
            raise WireError("commit cause is invalid")
        causation = result["causation_id"]
        if cause == "input":
            _text(causation, "causation_id")
        elif causation is not None:
            raise WireError("non-input commit causation_id must be null")
    elif kind is PacketKind.INPUT:
        _text(result["input_id"], "input_id")
        _text(result["observed_stream_id"], "observed_stream_id")
        _safe_integer(result["observed_commit_seq"], "observed_commit_seq")
        _text(result["command"], "command")
    elif kind is PacketKind.ACK:
        _text(result["stream_id"], "stream_id")
        _safe_integer(result["commit_seq"], "commit_seq")
        _safe_integer(result["last_command_seq"], "last_command_seq")
    elif kind is PacketKind.INPUT_RESULT:
        _text(result["input_id"], "input_id")
        if result["status"] not in {"rejected", "no-op"}:
            raise WireError("input result status is invalid")
        if result["reason_code"] is not None:
            _text(result["reason_code"], "reason_code")
    elif kind is PacketKind.ERROR:
        _text(result["code"], "code")
        if result["fatal"] is not True:
            raise WireError("engine.error fatal must be true")
    return result


def _normalize_attachment(
    value: EngineAttachment | tuple[Any, Any, Any], *, limits: EngineLimits
) -> EngineAttachment:
    if isinstance(value, EngineAttachment):
        kind = value.kind
        encoding = value.encoding
        source = value.value
    else:
        try:
            kind_raw, encoding_raw, source = value
            kind = AttachmentKind(kind_raw)
            encoding = AttachmentEncoding(encoding_raw)
        except (TypeError, ValueError) as exc:
            raise WireError("attachment tuple is invalid") from exc
    if encoding is AttachmentEncoding.JSON:
        prevalidated = _prevalidated_display_stream(source, kind=kind, limits=limits)
        payload = _json_dumps(
            source,
            sort_keys=True,
            maximum_depth=limits.maximum_json_depth,
            prevalidated=prevalidated,
        )
        decoded = source
    else:
        payload = _owned_bytes(source, "raw attachment")
        decoded = payload
    if len(payload) > limits.maximum_attachment_bytes:
        raise WireError("attachment exceeds maximum_attachment_bytes")
    return EngineAttachment(kind, encoding, decoded, payload)


def _validate_attachment_layout(
    kind: PacketKind,
    header: Mapping[str, Any],
    attachments: Sequence[EngineAttachment],
    limits: EngineLimits,
) -> None:
    if len(attachments) > limits.maximum_attachment_count:
        raise WireError("attachment count exceeds maximum_attachment_count")
    actual = tuple((item.kind, item.encoding) for item in attachments)
    json_encoding = AttachmentEncoding.JSON
    valid: bool
    if kind is PacketKind.CHECKPOINT:
        valid = actual == (
            (AttachmentKind.WORLD_SNAPSHOT, json_encoding),
            (AttachmentKind.DISPLAY_CHECKPOINT, json_encoding),
        )
    elif kind is PacketKind.COMMIT:
        valid = bool(actual) and actual[0] == (
            AttachmentKind.WORLD_PATCH,
            json_encoding,
        )
        valid = valid and len(actual) == 2 and actual[1] == (
            AttachmentKind.DISPLAY_COMMAND_STREAM,
            json_encoding,
        )
        if valid and attachments[0].value is not None:
            patch = attachments[0].value
            if isinstance(patch, Mapping):
                changes = patch.get("changes")
                if isinstance(changes, list) and len(changes) > limits.maximum_world_patch_changes:
                    raise WireError("world patch exceeds maximum_world_patch_changes")
    elif kind is PacketKind.INPUT:
        valid = actual == ((AttachmentKind.INPUT_PAYLOAD, json_encoding),)
    elif kind is PacketKind.INPUT_RESULT:
        valid = actual in (
            (),
            ((AttachmentKind.RESULT_PAYLOAD, json_encoding),),
        )
    else:
        valid = actual == ()
    if not valid:
        raise WireError("attachment order or encoding is invalid for packet kind")
    try:
        if kind is PacketKind.CHECKPOINT:
            validate_display_checkpoint(
                attachments[1].value,
                expected_last_command_seq=header["last_command_seq"],
            )
        elif kind is PacketKind.COMMIT:
            display_stream = attachments[1].value
            if isinstance(display_stream, ValidatedDisplayCommandStream):
                if (
                    display_stream.source_tick != header["source_tick"]
                    or display_stream["last_command_seq"]
                    != header["last_command_seq"]
                ):
                    raise ConfigurationError(
                        "display command stream seal does not match packet header"
                    )
            else:
                validate_display_command_stream(
                    display_stream,
                    expected_source_tick=header["source_tick"],
                    expected_last_command_seq=header["last_command_seq"],
                )
    except ConfigurationError as exc:
        raise WireError("display attachment is invalid") from exc


def _json_dumps(
    value: Any,
    *,
    sort_keys: bool,
    maximum_depth: int,
    prevalidated: bool = False,
) -> bytes:
    if not prevalidated:
        _validate_json_value(
            value,
            active=set(),
            depth=0,
            maximum_depth=maximum_depth,
        )
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=sort_keys,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise WireError("value is not canonical JSON") from exc


def _prevalidated_display_stream(
    value: Any, *, kind: AttachmentKind, limits: EngineLimits
) -> bool:
    if kind is not AttachmentKind.DISPLAY_COMMAND_STREAM:
        return False
    return (
        isinstance(value, ValidatedDisplayCommandStream)
        and value.maximum_json_depth <= limits.maximum_json_depth
    )


def _json_loads(data: bytes, *, label: str, maximum_depth: int) -> Any:
    if data.startswith(b"\xef\xbb\xbf"):
        raise WireError(f"{label} must not contain a BOM")

    def pairs(values: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in values:
            if key in result:
                raise WireError(f"{label} contains a duplicate key")
            result[key] = value
        return result

    def integer(token: str) -> int:
        value = int(token)
        if abs(value) > MAXIMUM_SAFE_INTEGER:
            raise WireError(f"{label} contains an unsafe integer")
        return value

    def finite_number(token: str) -> float:
        value = float(token)
        if not math.isfinite(value):
            raise WireError(f"{label} contains a non-finite number")
        return value

    try:
        text = data.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=finite_number,
            parse_constant=lambda _: (_ for _ in ()).throw(
                WireError(f"{label} contains a non-finite number")
            ),
        )
    except WireError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise WireError(f"{label} is invalid UTF-8 JSON") from exc
    _validate_json_value(
        value,
        active=set(),
        depth=0,
        maximum_depth=maximum_depth,
    )
    return value


def _validate_json_value(
    value: Any,
    *,
    active: set[int],
    depth: int,
    maximum_depth: int,
) -> None:
    if depth > maximum_depth:
        raise WireError("JSON exceeds maximum_json_depth")
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAXIMUM_SAFE_INTEGER:
            raise WireError("JSON integer is outside the JavaScript safe range")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise WireError("JSON numbers must be finite")
        return
    if not isinstance(value, (Mapping, list, tuple)):
        raise WireError("value is not JSON")
    identity = id(value)
    if identity in active:
        raise WireError("JSON value contains a cycle")
    active.add(identity)
    try:
        if isinstance(value, Mapping):
            for key, item in value.items():
                if not isinstance(key, str):
                    raise WireError("JSON object keys must be strings")
                if key in {"__proto__", "prototype", "constructor"}:
                    raise WireError("JSON object key is forbidden")
                _validate_json_value(
                    item,
                    active=active,
                    depth=depth + 1,
                    maximum_depth=maximum_depth,
                )
        else:
            for item in value:
                _validate_json_value(
                    item,
                    active=active,
                    depth=depth + 1,
                    maximum_depth=maximum_depth,
                )
    finally:
        active.remove(identity)


def _owned_bytes(value: Any, field: str) -> bytes:
    try:
        return bytes(value)
    except (TypeError, ValueError) as exc:
        raise WireError(f"{field} must be bytes-like") from exc


def _safe_integer(value: Any, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAXIMUM_SAFE_INTEGER
    ):
        raise WireError(f"{field} must be a non-negative JavaScript-safe integer")
    return value


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise WireError(f"{field} must be a non-empty canonical string")
    return value


_IDENTITY_HEAD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_IDENTITY_EXTRA = "._:@/-"


def _identity(value: Any, field: str) -> str:
    result = _text(value, field)
    if len(result.encode("utf-8")) > 160:
        raise WireError(f"{field} exceeds 160 UTF-8 bytes")
    allowed = _IDENTITY_HEAD + _IDENTITY_EXTRA
    if result[0] not in _IDENTITY_HEAD or any(character not in allowed for character in result):
        raise WireError(f"{field} is not a canonical identity")
    return result


__all__ = [
    "AttachmentEncoding",
    "AttachmentKind",
    "DEFAULT_ENGINE_LIMITS",
    "EngineAttachment",
    "EngineLimits",
    "EnginePacket",
    "MAXIMUM_SAFE_INTEGER",
    "PacketKind",
    "DISPLAY_CODEC",
    "WIRE_MAJOR_VERSION",
    "WIRE_MAGIC",
    "WIRE_SCHEMA",
    "WORLD_TREE_SCHEMA",
    "canonical_json_bytes",
    "decode_json_bytes",
    "encode_ack",
    "encode_checkpoint",
    "encode_commit",
    "encode_engine_packet",
    "encode_error",
    "encode_input",
    "encode_input_result",
    "read_engine_packet",
]
