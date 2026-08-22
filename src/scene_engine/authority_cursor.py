"""Transport-neutral authority cursor envelopes and codec ports."""

from __future__ import annotations

from dataclasses import dataclass
import re
import unicodedata
from typing import Any, Hashable, Protocol, TypeVar, runtime_checkable

from .errors import PresentationControlError


MAXIMUM_AUTHORITY_CURSOR_BYTES = 16 * 1024
MAXIMUM_CURSOR_CODEC_IDENTITY_CHARS = 160
_IDENTITY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:@/-]*\Z")

TCursor = TypeVar("TCursor")


@dataclass(frozen=True)
class AuthorityCursorEnvelope:
    """Canonical opaque cursor bytes identified by a versioned profile codec."""

    codec_identity: str
    canonical_bytes: bytes

    def __post_init__(self) -> None:
        identity = _codec_identity(self.codec_identity)
        try:
            raw = bytes(memoryview(self.canonical_bytes).cast("B"))
        except (TypeError, ValueError) as exc:
            raise PresentationControlError(
                "authority cursor canonical_bytes must be bytes"
            ) from exc
        if not raw or len(raw) > MAXIMUM_AUTHORITY_CURSOR_BYTES:
            raise PresentationControlError(
                "authority cursor canonical_bytes length is invalid"
            )
        object.__setattr__(self, "codec_identity", identity)
        object.__setattr__(self, "canonical_bytes", raw)


@runtime_checkable
class AuthorityCursorCodec(Protocol[TCursor]):
    """Domain profile port used by Engine without exposing domain fields."""

    @property
    def codec_identity(self) -> str: ...

    def encode(self, cursor: TCursor) -> bytes: ...

    def decode(self, canonical_bytes: bytes) -> TCursor: ...

    def key(self, cursor: TCursor) -> Hashable: ...

    def tick(self, cursor: TCursor) -> int: ...


def envelope_cursor(
    cursor: TCursor, codec: AuthorityCursorCodec[TCursor]
) -> AuthorityCursorEnvelope:
    """Encode and round-trip a cursor before it enters an Engine session."""

    identity = _codec_identity(codec.codec_identity)
    encoded = bytes(codec.encode(cursor))
    envelope = AuthorityCursorEnvelope(identity, encoded)
    decoded = codec.decode(envelope.canonical_bytes)
    if bytes(codec.encode(decoded)) != envelope.canonical_bytes:
        raise PresentationControlError("authority cursor codec is not canonical")
    if codec.key(decoded) != codec.key(cursor):
        raise PresentationControlError("authority cursor codec changed cursor identity")
    tick = codec.tick(decoded)
    if isinstance(tick, bool) or not isinstance(tick, int) or tick < 0:
        raise PresentationControlError(
            "authority cursor codec returned an invalid tick"
        )
    return envelope


def validate_envelope_with_codec(
    envelope: AuthorityCursorEnvelope,
    codec: AuthorityCursorCodec[TCursor],
) -> TCursor:
    if envelope.codec_identity != _codec_identity(codec.codec_identity):
        raise PresentationControlError("authority cursor codec identity mismatch")
    cursor = codec.decode(envelope.canonical_bytes)
    if bytes(codec.encode(cursor)) != envelope.canonical_bytes:
        raise PresentationControlError("authority cursor bytes are not canonical")
    return cursor


def _codec_identity(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value.strip() != value
        or len(value) > MAXIMUM_CURSOR_CODEC_IDENTITY_CHARS
        or unicodedata.normalize("NFC", value) != value
        or not _IDENTITY.fullmatch(value)
    ):
        raise PresentationControlError("cursor codec_identity is invalid")
    return value


__all__ = [
    "AuthorityCursorCodec",
    "AuthorityCursorEnvelope",
    "MAXIMUM_AUTHORITY_CURSOR_BYTES",
    "envelope_cursor",
    "validate_envelope_with_codec",
]
