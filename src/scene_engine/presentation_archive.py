"""Streaming writer for Scene Engine Presentation Archive V3."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import unicodedata
from typing import Any, BinaryIO, Dict

from .errors import PresentationArchiveError
from .packet_codec import decode_scene_bootstrap_v3_packet
from .presentation_control_v2 import (
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_from_json,
    parse_presentation_control_v2,
)


PRESENTATION_ARCHIVE_SCHEMA_IDENTITY = "scene-presentation-archive-v3@1"
PRESENTATION_ARCHIVE_MANIFEST = "presentation-manifest.json"
PRESENTATION_ARCHIVE_INDEX = "presentation-index.bin"
PRESENTATION_ARCHIVE_SEGMENTS = "presentation-segments.bin"

_INDEX_MAGIC = b"SEIX"
_INDEX_VERSION = 3
_INDEX_HEADER = struct.Struct("<4sHHHHQQQ32s32s12s")
_INDEX_ENTRY = struct.Struct("<HHIQQQQQQQQII32s")
_CHECKPOINT_DIRECTORY_ENTRY = struct.Struct("<QI4xQQQQ")
_BLOCK_MAGIC = b"SEAB"
_BLOCK_VERSION = 3
_BLOCK_HEADER = struct.Struct("<4sHHIIQII32s")
_BLOCK_KIND_CHECKPOINT = 1
_BLOCK_KIND_FRAME = 2
_BLOCK_KIND_CORRELATION = 3
_COMPRESSION_NONE = 0
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_U64 = (1 << 64) - 1
_MAXIMUM_PENDING_FRAMES = 8


@dataclass(frozen=True)
class PresentationArchiveLimits:
    maximum_block_bytes: int = 64 * 1024 * 1024
    maximum_cursor_bytes: int = 16 * 1024
    maximum_entries: int = 100_000_000
    maximum_segments: int = 1_000_000

    def __post_init__(self) -> None:
        for field in self.__dataclass_fields__:
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise PresentationArchiveError(
                    "{} must be a positive integer".format(field)
                )


@dataclass(frozen=True)
class _Segment:
    segment_id: int
    checkpoint_id: int
    scene_epoch: int
    bootstrap_id: int
    source_tick: int


@dataclass(frozen=True)
class _CheckpointDirectoryEntry:
    checkpoint_id: int
    segment_id: int
    index_entry_number: int
    scene_epoch: int
    bootstrap_id: int
    source_tick: int


class PresentationArchiveWriter:
    """Append exact packets/correlations without retaining archive payload bytes."""

    def __init__(
        self,
        directory: str | os.PathLike[str],
        *,
        profile_identity: str,
        source_authority_artifact_identity: str,
        source_authority_sha256: str | None,
        authority_cursor_codec_identity: str,
        exporter_identity: str,
        scene_engine_identity: str,
        visual_manifest_identity: str,
        resource_manifest_identity: str,
        limits: PresentationArchiveLimits | None = None,
    ) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        manifest_path = self.directory / PRESENTATION_ARCHIVE_MANIFEST
        if manifest_path.exists():
            raise PresentationArchiveError("archive manifest already exists")
        self.limits = limits or PresentationArchiveLimits()
        self.identities = {
            "profile_identity": _identity(profile_identity, "profile_identity"),
            "source_authority_artifact_identity": _identity(
                source_authority_artifact_identity,
                "source_authority_artifact_identity",
            ),
            "authority_cursor_codec_identity": _identity(
                authority_cursor_codec_identity,
                "authority_cursor_codec_identity",
            ),
            "exporter_identity": _identity(exporter_identity, "exporter_identity"),
            "scene_engine_identity": _identity(
                scene_engine_identity, "scene_engine_identity"
            ),
            "visual_manifest_identity": _identity(
                visual_manifest_identity, "visual_manifest_identity"
            ),
            "resource_manifest_identity": _identity(
                resource_manifest_identity, "resource_manifest_identity"
            ),
        }
        self._source_authority_sha256 = (
            None
            if source_authority_sha256 is None
            else _sha256_identity(
                source_authority_sha256, "source_authority_sha256"
            )
        )
        self._index_hash = hashlib.sha256()
        self._segments_hash = hashlib.sha256()
        self._entry_count = 0
        self._segment_count = 0
        self._checkpoint_count = 0
        self._checkpoint_directory: list[_CheckpointDirectoryEntry] = []
        self._frame_count = 0
        self._correlation_count = 0
        self._current: _Segment | None = None
        self._checkpoint_ids: set[int] = set()
        self._last_scene_epoch = 0
        self._last_bootstrap_id = 0
        self._current_frame_count = 0
        self._current_correlation_count = 0
        self._last_frame_seq = 0
        self._last_correlation_seq = 0
        self._pending_frames: Dict[int, tuple[int, int, str]] = {}
        self._start_tick: int | None = None
        self._end_tick: int | None = None
        self._sealed = False
        self._closed = False
        segments: BinaryIO | None = None
        index: BinaryIO | None = None
        try:
            segments = open(
                self.directory / PRESENTATION_ARCHIVE_SEGMENTS, "x+b"
            )
            index = open(
                self.directory / PRESENTATION_ARCHIVE_INDEX, "x+b"
            )
            index.write(b"\x00" * _INDEX_HEADER.size)
        except BaseException:
            # Construction owns each stream as soon as open() returns.  In
            # particular, a failure opening/initialising the second file must
            # not strand the first descriptor.
            _close_streams(index, segments)
            raise
        self._segments = segments
        self._index = index

    @property
    def sealed(self) -> bool:
        """Whether the success manifest was durably published."""

        return self._sealed

    @property
    def closed(self) -> bool:
        """Whether both owned archive streams are closed."""

        return self._closed

    def start_segment(
        self,
        *,
        checkpoint_id: int,
        scene_epoch: int,
        bootstrap_id: int,
        source_tick: int,
        bootstrap_packet: bytes,
    ) -> None:
        self._require_writable()
        if self._current is not None:
            self.seal_segment()
        checkpoint = _uint64(checkpoint_id, "checkpoint_id", minimum=1)
        epoch = _uint64(scene_epoch, "scene_epoch", minimum=1)
        bootstrap = _uint64(bootstrap_id, "bootstrap_id", minimum=1)
        tick = _uint64(source_tick, "source_tick")
        bootstrap_raw = _bytes(bootstrap_packet, "bootstrap_packet")
        try:
            bootstrap_view = decode_scene_bootstrap_v3_packet(
                bootstrap_raw,
                maximum_stored_bytes=self.limits.maximum_block_bytes,
                maximum_uncompressed_bytes=self.limits.maximum_block_bytes,
                maximum_bootstrap_bytes=self.limits.maximum_block_bytes,
                maximum_static_nodes=self.limits.maximum_entries,
                maximum_scene_metadata=self.limits.maximum_entries,
                maximum_visual_types=self.limits.maximum_entries,
                maximum_animation_states=self.limits.maximum_entries,
            )
        except Exception as exc:
            raise PresentationArchiveError(
                "archive Bootstrap packet is invalid"
            ) from exc
        self._validate_authority_cursor(bootstrap_view.authority_baseline)
        if checkpoint in self._checkpoint_ids:
            raise PresentationArchiveError("checkpoint ID is duplicated")
        if epoch <= self._last_scene_epoch or bootstrap <= self._last_bootstrap_id:
            raise PresentationArchiveError(
                "new archive segment requires increasing scene epoch and Bootstrap identity"
            )
        self._segment_count += 1
        if self._segment_count > self.limits.maximum_segments:
            raise PresentationArchiveError("archive exceeds maximum_segments")
        self._current = _Segment(
            self._segment_count, checkpoint, epoch, bootstrap, tick
        )
        self._checkpoint_count += 1
        self._checkpoint_ids.add(checkpoint)
        self._last_scene_epoch = epoch
        self._last_bootstrap_id = bootstrap
        self._current_frame_count = 0
        self._current_correlation_count = 0
        self._pending_frames.clear()
        self._last_frame_seq = 0
        self._last_correlation_seq = 0
        if self._start_tick is None:
            self._start_tick = tick
        self._end_tick = tick
        self._checkpoint_directory.append(
            _CheckpointDirectoryEntry(
                checkpoint_id=checkpoint,
                segment_id=self._current.segment_id,
                index_entry_number=self._entry_count,
                scene_epoch=epoch,
                bootstrap_id=bootstrap,
                source_tick=tick,
            )
        )
        self._append_block(
            kind=_BLOCK_KIND_CHECKPOINT,
            record_seq=checkpoint,
            source_tick=tick,
            payload=bootstrap_raw,
            correlation_seq=0,
            frame_seq=0,
            projection_id=0,
        )

    def append_frame(
        self,
        *,
        frame_seq: int,
        source_tick: int,
        projection_id: int,
        packet: bytes,
    ) -> None:
        self._require_segment()
        if len(self._pending_frames) >= _MAXIMUM_PENDING_FRAMES:
            raise PresentationArchiveError(
                "uncorrelated frame window exceeds {}".format(
                    _MAXIMUM_PENDING_FRAMES
                )
            )
        sequence = _uint64(frame_seq, "frame_seq", minimum=1)
        if sequence != self._last_frame_seq + 1:
            raise PresentationArchiveError("frame sequence gap")
        tick = _uint64(source_tick, "source_tick")
        if self._end_tick is not None and tick not in (self._end_tick, self._end_tick + 1):
            raise PresentationArchiveError("frame source tick gap")
        projection = _uint64(projection_id, "projection_id", minimum=1)
        digest = self._append_block(
            kind=_BLOCK_KIND_FRAME,
            record_seq=sequence,
            source_tick=tick,
            payload=packet,
            correlation_seq=0,
            frame_seq=sequence,
            projection_id=projection,
        )
        self._pending_frames[sequence] = (tick, projection, digest)
        self._last_frame_seq = sequence
        self._frame_count += 1
        self._current_frame_count += 1
        self._end_tick = tick

    def append_correlation(self, correlation: bytes) -> None:
        self._require_segment()
        raw = _bytes(correlation, "correlation")
        message = parse_presentation_control_v2(
            raw, direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT
        )
        if message["type"] != "presentation.correlation":
            raise PresentationArchiveError(
                "archive correlation record has wrong control type"
            )
        if (
            int(message["scene_epoch"]) != self._current.scene_epoch
            or int(message["bootstrap_id"]) != self._current.bootstrap_id
        ):
            raise PresentationArchiveError("correlation checkpoint identity mismatch")
        payload = message["payload"]
        self._validate_authority_cursor(
            cursor_envelope_from_json(payload["authority_cursor"])
        )
        sequence = int(payload["correlation_seq"])
        if sequence != self._last_correlation_seq + 1:
            raise PresentationArchiveError("correlation sequence gap")
        if message["session_seq"] != sequence:
            raise PresentationArchiveError("correlation session sequence mismatch")
        tick = int(payload["source_tick"])
        if self._end_tick is not None and tick not in (
            self._end_tick,
            self._end_tick + 1,
        ):
            raise PresentationArchiveError("correlation source tick gap")
        projection = int(payload["projection_id"])
        expected_frame_sequences = list(self._pending_frames)
        referenced_frame_sequences = [
            int(ref["frame_seq"]) for ref in payload["frame_refs"]
        ]
        if referenced_frame_sequences != expected_frame_sequences:
            raise PresentationArchiveError(
                "correlation frame batch is not exact and ordered"
            )
        for ref in payload["frame_refs"]:
            frame_seq = int(ref["frame_seq"])
            frame = self._pending_frames.get(frame_seq)
            if frame is None or frame[2] != ref["sha256"]:
                raise PresentationArchiveError(
                    "correlation references an unknown frame"
                )
            if frame[0] != tick or frame[1] != projection:
                raise PresentationArchiveError("correlation frame identity mismatch")
            del self._pending_frames[frame_seq]
        if payload["presentation_required"] != bool(payload["frame_refs"]):
            raise PresentationArchiveError(
                "correlation presentation_required mismatch"
            )
        self._append_block(
            kind=_BLOCK_KIND_CORRELATION,
            record_seq=sequence,
            source_tick=tick,
            payload=raw,
            correlation_seq=sequence,
            frame_seq=(
                int(payload["frame_refs"][-1]["frame_seq"])
                if payload["frame_refs"]
                else self._last_frame_seq
            ),
            projection_id=projection,
        )
        self._last_correlation_seq = sequence
        self._correlation_count += 1
        self._current_correlation_count += 1
        self._end_tick = tick

    def seal_segment(self) -> None:
        self._require_segment()
        if self._pending_frames:
            raise PresentationArchiveError("segment contains uncorrelated frames")
        if self._current_frame_count == 0 or self._current_correlation_count == 0:
            raise PresentationArchiveError(
                "segment checkpoint requires a complete frame and correlation"
            )
        self._current = None

    def seal(
        self, *, source_authority_sha256: str | None = None
    ) -> Dict[str, Any]:
        self._require_writable()
        manifest_path = self.directory / PRESENTATION_ARCHIVE_MANIFEST
        manifest_created = False
        try:
            supplied_source_sha256 = (
                None
                if source_authority_sha256 is None
                else _sha256_identity(
                    source_authority_sha256, "source_authority_sha256"
                )
            )
            if (
                self._source_authority_sha256 is not None
                and supplied_source_sha256 is not None
                and self._source_authority_sha256 != supplied_source_sha256
            ):
                raise PresentationArchiveError(
                    "source_authority_sha256 changed before seal"
                )
            resolved_source_sha256 = (
                supplied_source_sha256 or self._source_authority_sha256
            )
            if resolved_source_sha256 is None:
                raise PresentationArchiveError(
                    "source_authority_sha256 is required before seal"
                )
            if self._current is not None:
                self.seal_segment()
            if self._segment_count == 0:
                raise PresentationArchiveError("archive has no segments")
            index_entries_digest = self._index_hash.copy().digest()
            checkpoint_directory_hash = hashlib.sha256()
            for checkpoint in sorted(
                self._checkpoint_directory,
                key=lambda item: item.checkpoint_id,
            ):
                encoded = _CHECKPOINT_DIRECTORY_ENTRY.pack(
                    checkpoint.checkpoint_id,
                    checkpoint.segment_id,
                    checkpoint.index_entry_number,
                    checkpoint.scene_epoch,
                    checkpoint.bootstrap_id,
                    checkpoint.source_tick,
                )
                self._index.write(encoded)
                self._index_hash.update(encoded)
                checkpoint_directory_hash.update(encoded)
            checkpoint_directory_digest = checkpoint_directory_hash.digest()
            index_digest = self._index_hash.digest()
            checkpoint_directory_offset = (
                _INDEX_HEADER.size + self._entry_count * _INDEX_ENTRY.size
            )
            index_header = _INDEX_HEADER.pack(
                _INDEX_MAGIC,
                _INDEX_VERSION,
                _INDEX_HEADER.size,
                _INDEX_ENTRY.size,
                _CHECKPOINT_DIRECTORY_ENTRY.size,
                self._entry_count,
                self._checkpoint_count,
                checkpoint_directory_offset,
                index_entries_digest,
                checkpoint_directory_digest,
                b"\x00" * 12,
            )
            self._index.seek(0)
            self._index.write(index_header)
            segments_digest = self._segments_hash.digest()
            root_digest = hashlib.sha256(
                index_digest + segments_digest
            ).hexdigest()
            for file in (self._index, self._segments):
                file.flush()
                os.fsync(file.fileno())
            manifest = {
                "archive_root_sha256": root_digest,
                "checkpoint_directory_sha256": (
                    checkpoint_directory_digest.hex()
                ),
                "checkpoint_count": self._checkpoint_count,
                "compression_codecs": ["none"],
                "correlation_count": str(self._correlation_count),
                "end_tick": str(self._end_tick),
                "entry_count": str(self._entry_count),
                "frame_count": str(self._frame_count),
                "hard_limits": {
                    "maximum_block_bytes": self.limits.maximum_block_bytes,
                    "maximum_cursor_bytes": self.limits.maximum_cursor_bytes,
                    "maximum_entries": self.limits.maximum_entries,
                    "maximum_segments": self.limits.maximum_segments,
                },
                "index_payload_sha256": index_digest.hex(),
                "index_entries_sha256": index_entries_digest.hex(),
                "schema_identity": PRESENTATION_ARCHIVE_SCHEMA_IDENTITY,
                "segment_count": self._segment_count,
                "segments_sha256": segments_digest.hex(),
                "source_authority_sha256": resolved_source_sha256,
                "start_tick": str(self._start_tick),
                **self.identities,
            }
            manifest_bytes = (
                json.dumps(
                    manifest,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                    allow_nan=False,
                )
                + "\n"
            ).encode("utf-8")

            # Close the data files before publishing the success marker.  A
            # close failure therefore cannot leave a manifest that advertises
            # an archive whose owned data handles did not finish cleanly.
            self._close_owned_streams()
            manifest_file = open(manifest_path, "xb")
            manifest_created = True
            with manifest_file:
                manifest_file.write(manifest_bytes)
                manifest_file.flush()
                os.fsync(manifest_file.fileno())
        except BaseException:
            if manifest_created:
                try:
                    manifest_path.unlink(missing_ok=True)
                except OSError:
                    # Preserve the original seal failure.  The writer still
                    # attempts every owned close below; callers will not get a
                    # successful return or a sealed state.
                    pass
            try:
                self._close_owned_streams()
            except BaseException:
                pass
            raise
        self._sealed = True
        return manifest

    def close_incomplete(self) -> None:
        """Close an incomplete archive without publishing a manifest."""

        if self._sealed:
            return
        self._close_owned_streams()

    def _close_owned_streams(self) -> None:
        failure = _close_streams(self._index, self._segments)
        self._closed = self._index.closed and self._segments.closed
        if failure is not None:
            raise failure

    def _validate_authority_cursor(self, cursor: Any) -> None:
        if (
            cursor.codec_identity
            != self.identities["authority_cursor_codec_identity"]
        ):
            raise PresentationArchiveError(
                "archive authority cursor codec identity mismatch"
            )
        if len(cursor.canonical_bytes) > self.limits.maximum_cursor_bytes:
            raise PresentationArchiveError(
                "archive authority cursor exceeds maximum_cursor_bytes"
            )

    def _append_block(
        self,
        *,
        kind: int,
        record_seq: int,
        source_tick: int,
        payload: bytes,
        correlation_seq: int,
        frame_seq: int,
        projection_id: int,
    ) -> str:
        raw = _bytes(payload, "archive block")
        if len(raw) > self.limits.maximum_block_bytes:
            raise PresentationArchiveError("archive block byte length is invalid")
        if self._entry_count >= self.limits.maximum_entries:
            raise PresentationArchiveError("archive exceeds maximum_entries")
        digest = hashlib.sha256(raw).digest()
        header = _BLOCK_HEADER.pack(
            _BLOCK_MAGIC,
            _BLOCK_VERSION,
            kind,
            _COMPRESSION_NONE,
            self._current.segment_id,
            record_seq,
            len(raw),
            len(raw),
            digest,
        )
        offset = self._segments.tell()
        block = header + raw
        self._segments.write(block)
        self._segments_hash.update(block)
        entry = _INDEX_ENTRY.pack(
            kind,
            0,
            self._current.segment_id,
            record_seq,
            self._current.scene_epoch,
            self._current.bootstrap_id,
            correlation_seq,
            frame_seq,
            source_tick,
            projection_id,
            offset,
            len(block),
            len(raw),
            digest,
        )
        self._index.write(entry)
        self._index_hash.update(entry)
        self._entry_count += 1
        return digest.hex()

    def _require_segment(self) -> None:
        self._require_writable()
        if self._current is None:
            raise PresentationArchiveError("archive segment is not open")

    def _require_writable(self) -> None:
        if self._sealed:
            raise PresentationArchiveError("archive writer is sealed")
        if self._closed:
            raise PresentationArchiveError("archive writer is closed")


def _close_streams(*streams: BinaryIO | None) -> BaseException | None:
    """Attempt every close and return the first failure, if any."""

    failure: BaseException | None = None
    for stream in streams:
        if stream is None or stream.closed:
            continue
        try:
            stream.close()
        except BaseException as error:
            if failure is None:
                failure = error
    return failure


def _identity(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value.strip() != value
        or len(value) > 240
        or unicodedata.normalize("NFC", value) != value
    ):
        raise PresentationArchiveError("{} is invalid".format(field))
    return value


def _sha256_identity(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _SHA256.fullmatch(value):
        raise PresentationArchiveError("{} must be lowercase SHA-256".format(field))
    return value


def _bytes(value: Any, field: str) -> bytes:
    try:
        raw = bytes(memoryview(value).cast("B"))
    except (TypeError, ValueError) as exc:
        raise PresentationArchiveError("{} must be bytes".format(field)) from exc
    if not raw:
        raise PresentationArchiveError("{} must not be empty".format(field))
    return raw


def _uint64(value: Any, field: str, minimum: int = 0) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= _MAX_U64
    ):
        raise PresentationArchiveError("{} must be uint64".format(field))
    return value


__all__ = [
    "PRESENTATION_ARCHIVE_INDEX",
    "PRESENTATION_ARCHIVE_MANIFEST",
    "PRESENTATION_ARCHIVE_SCHEMA_IDENTITY",
    "PRESENTATION_ARCHIVE_SEGMENTS",
    "PresentationArchiveLimits",
    "PresentationArchiveWriter",
]
