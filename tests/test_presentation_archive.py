from __future__ import annotations

import builtins
import hashlib
import json
from pathlib import Path
import struct
from typing import Any

import pytest

import scene_engine.presentation_archive as archive_module
from scene_engine.authority_cursor import AuthorityCursorEnvelope
from scene_engine.presentation_archive import (
    PRESENTATION_ARCHIVE_INDEX,
    PRESENTATION_ARCHIVE_MANIFEST,
    PRESENTATION_ARCHIVE_SEGMENTS,
    PresentationArchiveWriter,
    PresentationArchiveLimits,
)
from scene_engine.errors import PresentationArchiveError
from scene_engine.presentation_control_v2 import (
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
)
from scene_engine.packet_codec import encode_scene_bootstrap_v3_packet
from scene_engine.scene_bootstrap import (
    EngineSessionIdentityV3,
    encode_scene_bootstrap_v3,
)


class _FileProxy:
    def __init__(self, stream: Any) -> None:
        self.stream = stream

    @property
    def closed(self) -> bool:
        return self.stream.closed

    def __getattr__(self, name: str) -> Any:
        return getattr(self.stream, name)

    def __enter__(self) -> "_FileProxy":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def close(self) -> None:
        self.stream.close()


class _FailingWriteFile(_FileProxy):
    def write(self, raw: bytes) -> int:
        if raw:
            self.stream.write(raw[:1])
        raise OSError("injected-write-failure")


class _CloseAfterClosingFailureFile(_FileProxy):
    def close(self) -> None:
        self.stream.close()
        raise OSError("injected-close-failure")


def _writer(
    directory: Path,
    *,
    source_authority_sha256: str | None = "1" * 64,
    limits: PresentationArchiveLimits | None = None,
) -> PresentationArchiveWriter:
    return PresentationArchiveWriter(
        directory,
        profile_identity="test-presentation@1",
        source_authority_artifact_identity="test-tape@1",
        source_authority_sha256=source_authority_sha256,
        authority_cursor_codec_identity="test-authority-cursor@1",
        exporter_identity="test-exporter@1",
        scene_engine_identity="scene-engine@0.3.0",
        visual_manifest_identity="visual@test",
        resource_manifest_identity="resource@test",
        limits=limits,
    )


def _correlation(
    *,
    scene_epoch: int,
    bootstrap_id: int,
    sequence: int,
    tick: int,
    packet: bytes,
    cursor_bytes: bytes | None = None,
) -> bytes:
    cursor = AuthorityCursorEnvelope(
        "test-authority-cursor@1",
        cursor_bytes
        or json.dumps(
            {"seq": sequence, "tick": tick},
            separators=(",", ":"),
            sort_keys=True,
        ).encode(),
    )
    return encode_presentation_control_v2(
        {
            "bootstrap_id": str(bootstrap_id),
            "message_id": "correlation:{}".format(sequence),
            "payload": {
                "authority_cursor": cursor_envelope_to_json(cursor),
                "correlation_seq": str(sequence),
                "frame_refs": [
                    {
                        "frame_seq": str(sequence),
                        "sha256": hashlib.sha256(packet).hexdigest(),
                    }
                ],
                "presentation_required": True,
                "projection_id": str(sequence),
                "source_tick": str(tick),
            },
            "protocol": "scene-presentation-control-v2",
            "scene_epoch": str(scene_epoch),
            "schema_version": 1,
            "session_seq": sequence,
            "type": "presentation.correlation",
            "viewer_scope": "viewer:test",
        },
        direction=PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    )


def _bootstrap(
    *, scene_epoch: int = 1, bootstrap_id: int = 1, cursor: bytes = b"cursor"
) -> bytes:
    return encode_scene_bootstrap_v3_packet(
        encode_scene_bootstrap_v3(
            scene_epoch=scene_epoch,
            bootstrap_id=bootstrap_id,
            identity=EngineSessionIdentityV3(
                "run:test", "viewer:test", "test-presentation@1"
            ),
            authority_baseline=AuthorityCursorEnvelope(
                "test-authority-cursor@1", cursor
            ),
            maximum_dynamic_nodes=100,
            maximum_frame_bytes=1_048_576,
        )
    )


def _append_complete_segment(writer: PresentationArchiveWriter) -> None:
    writer.start_segment(
        checkpoint_id=1,
        scene_epoch=1,
        bootstrap_id=1,
        source_tick=0,
        bootstrap_packet=_bootstrap(),
    )
    frame = b"frame"
    writer.append_frame(
        frame_seq=1,
        source_tick=1,
        projection_id=1,
        packet=frame,
    )
    writer.append_correlation(
        _correlation(
            scene_epoch=1,
            bootstrap_id=1,
            sequence=1,
            tick=1,
            packet=frame,
        )
    )


def test_python_streaming_writer_emits_node_compatible_archive_v3(tmp_path: Path) -> None:
    writer = PresentationArchiveWriter(
        tmp_path,
        profile_identity="test-presentation@1",
        source_authority_artifact_identity="test-tape@1",
        source_authority_sha256="1" * 64,
        authority_cursor_codec_identity="test-authority-cursor@1",
        exporter_identity="test-exporter@1",
        scene_engine_identity="scene-engine@0.3.0",
        visual_manifest_identity="visual@test",
        resource_manifest_identity="resource@test",
    )
    for segment in (1, 2):
        writer.start_segment(
            checkpoint_id=segment,
            scene_epoch=segment,
            bootstrap_id=segment,
            source_tick=segment - 1,
            bootstrap_packet=_bootstrap(
                scene_epoch=segment,
                bootstrap_id=segment,
                cursor="cursor:{}".format(segment).encode(),
            ),
        )
        frame = "frame:{}".format(segment).encode()
        writer.append_frame(
            frame_seq=1,
            source_tick=segment,
            projection_id=1,
            packet=frame,
        )
        writer.append_correlation(
            _correlation(
                scene_epoch=segment,
                bootstrap_id=segment,
                sequence=1,
                tick=segment,
                packet=frame,
            )
        )
    manifest = writer.seal()

    assert writer.sealed
    assert writer.closed
    assert writer._index.closed
    assert writer._segments.closed
    assert manifest["segment_count"] == 2
    assert manifest["checkpoint_count"] == 2
    assert manifest["entry_count"] == "6"
    assert manifest["schema_identity"] == "scene-presentation-archive-v3@1"
    assert (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).read_text().endswith("\n")
    index = (tmp_path / PRESENTATION_ARCHIVE_INDEX).read_bytes()
    assert len(index) == 112 + 6 * 112 + 2 * 48
    assert index[:4] == b"SEIX"
    assert struct.unpack_from("<H", index, 4)[0] == 3
    assert struct.unpack_from("<H", index, 6)[0] == 112
    assert struct.unpack_from("<H", index, 10)[0] == 48
    assert struct.unpack_from("<Q", index, 12)[0] == 6
    assert struct.unpack_from("<Q", index, 20)[0] == 2
    checkpoint_directory_offset = struct.unpack_from("<Q", index, 28)[0]
    assert checkpoint_directory_offset == 112 + 6 * 112
    first_checkpoint = struct.unpack_from(
        "<QI4xQQQQ",
        index,
        checkpoint_directory_offset,
    )
    second_checkpoint = struct.unpack_from(
        "<QI4xQQQQ",
        index,
        checkpoint_directory_offset + 48,
    )
    assert first_checkpoint == (1, 1, 0, 1, 1, 0)
    assert second_checkpoint == (2, 2, 3, 2, 2, 1)
    segments = (tmp_path / PRESENTATION_ARCHIVE_SEGMENTS).read_bytes()
    assert segments[:4] == b"SEAB"
    assert struct.unpack_from("<H", segments, 4)[0] == 3
    assert hashlib.sha256(index[112:]).hexdigest() == manifest["index_payload_sha256"]
    assert (
        hashlib.sha256(index[112:checkpoint_directory_offset]).hexdigest()
        == manifest["index_entries_sha256"]
    )
    assert (
        hashlib.sha256(index[checkpoint_directory_offset:]).hexdigest()
        == manifest["checkpoint_directory_sha256"]
    )
    assert hashlib.sha256(segments).hexdigest() == manifest["segments_sha256"]


def test_python_streaming_writer_can_bind_source_hash_at_seal(tmp_path: Path) -> None:
    writer = PresentationArchiveWriter(
        tmp_path,
        profile_identity="test-presentation@1",
        source_authority_artifact_identity="test-tape@1",
        source_authority_sha256=None,
        authority_cursor_codec_identity="test-authority-cursor@1",
        exporter_identity="test-exporter@1",
        scene_engine_identity="scene-engine@0.3.0",
        visual_manifest_identity="visual@test",
        resource_manifest_identity="resource@test",
    )
    writer.start_segment(
        checkpoint_id=1,
        scene_epoch=1,
        bootstrap_id=1,
        source_tick=0,
        bootstrap_packet=_bootstrap(),
    )
    frame = b"frame"
    writer.append_frame(
        frame_seq=1,
        source_tick=1,
        projection_id=1,
        packet=frame,
    )
    writer.append_correlation(
        _correlation(
            scene_epoch=1,
            bootstrap_id=1,
            sequence=1,
            tick=1,
            packet=frame,
        )
    )

    manifest = writer.seal(source_authority_sha256="2" * 64)

    assert manifest["source_authority_sha256"] == "2" * 64


def test_python_writer_caps_uncorrelated_frame_window_at_eight(tmp_path: Path) -> None:
    writer = PresentationArchiveWriter(
        tmp_path,
        profile_identity="test-presentation@1",
        source_authority_artifact_identity="test-tape@1",
        source_authority_sha256="1" * 64,
        authority_cursor_codec_identity="test-authority-cursor@1",
        exporter_identity="test-exporter@1",
        scene_engine_identity="scene-engine@0.3.0",
        visual_manifest_identity="visual@test",
        resource_manifest_identity="resource@test",
    )
    writer.start_segment(
        checkpoint_id=1,
        scene_epoch=1,
        bootstrap_id=1,
        source_tick=0,
        bootstrap_packet=_bootstrap(),
    )
    try:
        for sequence in range(1, 9):
            writer.append_frame(
                frame_seq=sequence,
                source_tick=1,
                projection_id=1,
                packet="frame:{}".format(sequence).encode(),
            )
        with pytest.raises(
            PresentationArchiveError,
            match="uncorrelated frame window exceeds 8",
        ):
            writer.append_frame(
                frame_seq=9,
                source_tick=1,
                projection_id=1,
                packet=b"frame:9",
            )
    finally:
        writer.close_incomplete()


def test_constructor_closes_segments_when_index_open_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = []

    def controlled_open(path: Any, mode: str):
        if Path(path).name == PRESENTATION_ARCHIVE_INDEX:
            raise OSError("injected-index-open-failure")
        stream = builtins.open(path, mode)
        opened.append(stream)
        return stream

    monkeypatch.setattr(archive_module, "open", controlled_open, raising=False)

    with pytest.raises(OSError, match="injected-index-open-failure"):
        _writer(tmp_path)

    assert len(opened) == 1
    assert opened[0].closed
    assert not (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).exists()


def test_constructor_closes_both_streams_when_index_initialization_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened = []

    def controlled_open(path: Any, mode: str):
        stream = builtins.open(path, mode)
        opened.append(stream)
        if Path(path).name == PRESENTATION_ARCHIVE_INDEX:
            return _FailingWriteFile(stream)
        return stream

    monkeypatch.setattr(archive_module, "open", controlled_open, raising=False)

    with pytest.raises(OSError, match="injected-write-failure"):
        _writer(tmp_path)

    assert len(opened) == 2
    assert all(stream.closed for stream in opened)
    assert not (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).exists()


def test_seal_validation_failure_is_terminal_and_closes_owned_streams(
    tmp_path: Path,
) -> None:
    writer = _writer(tmp_path)

    with pytest.raises(PresentationArchiveError, match="archive has no segments"):
        writer.seal()

    assert writer.closed
    assert not writer.sealed
    assert writer._index.closed
    assert writer._segments.closed
    assert not (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).exists()
    writer.close_incomplete()
    with pytest.raises(PresentationArchiveError, match="writer is closed"):
        writer.seal()


def test_seal_fsync_failure_closes_both_streams_without_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    writer = _writer(tmp_path)
    _append_complete_segment(writer)

    def fail_fsync(_file_descriptor: int) -> None:
        raise OSError("injected-fsync-failure")

    monkeypatch.setattr(archive_module.os, "fsync", fail_fsync)

    with pytest.raises(OSError, match="injected-fsync-failure"):
        writer.seal()

    assert writer.closed
    assert not writer.sealed
    assert writer._index.closed
    assert writer._segments.closed
    assert not (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).exists()


def test_manifest_write_failure_removes_partial_success_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    writer = _writer(tmp_path)
    _append_complete_segment(writer)
    opened_manifest = []

    def controlled_open(path: Any, mode: str):
        stream = builtins.open(path, mode)
        if Path(path).name == PRESENTATION_ARCHIVE_MANIFEST:
            opened_manifest.append(stream)
            return _FailingWriteFile(stream)
        return stream

    monkeypatch.setattr(archive_module, "open", controlled_open, raising=False)

    with pytest.raises(OSError, match="injected-write-failure"):
        writer.seal()

    assert writer.closed
    assert not writer.sealed
    assert writer._index.closed
    assert writer._segments.closed
    assert len(opened_manifest) == 1
    assert opened_manifest[0].closed
    assert not (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).exists()


def test_close_incomplete_attempts_both_streams_and_is_idempotent(
    tmp_path: Path,
) -> None:
    writer = _writer(tmp_path)
    index = writer._index
    segments = writer._segments
    writer._index = _CloseAfterClosingFailureFile(index)

    with pytest.raises(OSError, match="injected-close-failure"):
        writer.close_incomplete()

    assert index.closed
    assert segments.closed
    assert writer.closed
    assert not writer.sealed
    assert not (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).exists()
    writer.close_incomplete()


def test_declared_cursor_limit_rejects_oversized_bootstrap_cursor(
    tmp_path: Path,
) -> None:
    writer = _writer(
        tmp_path,
        limits=PresentationArchiveLimits(maximum_cursor_bytes=4),
    )
    try:
        with pytest.raises(
            PresentationArchiveError,
            match="authority cursor exceeds maximum_cursor_bytes",
        ):
            writer.start_segment(
                checkpoint_id=1,
                scene_epoch=1,
                bootstrap_id=1,
                source_tick=0,
                bootstrap_packet=_bootstrap(cursor=b"12345"),
            )
    finally:
        writer.close_incomplete()


def test_declared_cursor_limit_rejects_oversized_correlation_cursor(
    tmp_path: Path,
) -> None:
    writer = _writer(
        tmp_path,
        limits=PresentationArchiveLimits(maximum_cursor_bytes=4),
    )
    writer.start_segment(
        checkpoint_id=1,
        scene_epoch=1,
        bootstrap_id=1,
        source_tick=0,
        bootstrap_packet=_bootstrap(cursor=b"1234"),
    )
    frame = b"frame"
    writer.append_frame(
        frame_seq=1,
        source_tick=1,
        projection_id=1,
        packet=frame,
    )
    try:
        with pytest.raises(
            PresentationArchiveError,
            match="authority cursor exceeds maximum_cursor_bytes",
        ):
            writer.append_correlation(
                _correlation(
                    scene_epoch=1,
                    bootstrap_id=1,
                    sequence=1,
                    tick=1,
                    packet=frame,
                    cursor_bytes=b"12345",
                )
            )
    finally:
        writer.close_incomplete()
