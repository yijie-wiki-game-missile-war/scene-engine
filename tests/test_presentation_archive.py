from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct

from scene_engine.authority_cursor import AuthorityCursorEnvelope
from scene_engine.presentation_archive import (
    PRESENTATION_ARCHIVE_INDEX,
    PRESENTATION_ARCHIVE_MANIFEST,
    PRESENTATION_ARCHIVE_SEGMENTS,
    PresentationArchiveWriter,
)
from scene_engine.presentation_control_v2 import (
    PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    cursor_envelope_to_json,
    encode_presentation_control_v2,
)


def _correlation(
    *, scene_epoch: int, bootstrap_id: int, sequence: int, tick: int, packet: bytes
) -> bytes:
    cursor = AuthorityCursorEnvelope(
        "test-authority-cursor@1",
        json.dumps(
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


def test_python_streaming_writer_emits_node_compatible_archive_v2(tmp_path: Path) -> None:
    writer = PresentationArchiveWriter(
        tmp_path,
        profile_identity="test-presentation@1",
        source_authority_artifact_identity="test-tape@1",
        source_authority_sha256="1" * 64,
        authority_cursor_codec_identity="test-authority-cursor@1",
        exporter_identity="test-exporter@1",
        scene_engine_identity="scene-engine@0.2.0",
        visual_manifest_identity="visual@test",
        resource_manifest_identity="resource@test",
    )
    for segment in (1, 2):
        writer.start_segment(
            checkpoint_id=segment,
            scene_epoch=segment,
            bootstrap_id=segment,
            source_tick=segment - 1,
            bootstrap_packet="bootstrap:{}".format(segment).encode(),
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

    assert manifest["segment_count"] == 2
    assert manifest["checkpoint_count"] == 2
    assert manifest["entry_count"] == "6"
    assert (tmp_path / PRESENTATION_ARCHIVE_MANIFEST).read_text().endswith("\n")
    index = (tmp_path / PRESENTATION_ARCHIVE_INDEX).read_bytes()
    assert len(index) == 64 + 6 * 112
    assert index[:4] == b"SEIX"
    assert struct.unpack_from("<H", index, 4)[0] == 2
    segments = (tmp_path / PRESENTATION_ARCHIVE_SEGMENTS).read_bytes()
    assert segments[:4] == b"SEAB"
    assert hashlib.sha256(index[64:]).hexdigest() == manifest["index_payload_sha256"]
    assert hashlib.sha256(segments).hexdigest() == manifest["segments_sha256"]


def test_python_streaming_writer_can_bind_source_hash_at_seal(tmp_path: Path) -> None:
    writer = PresentationArchiveWriter(
        tmp_path,
        profile_identity="test-presentation@1",
        source_authority_artifact_identity="test-tape@1",
        source_authority_sha256=None,
        authority_cursor_codec_identity="test-authority-cursor@1",
        exporter_identity="test-exporter@1",
        scene_engine_identity="scene-engine@0.2.0",
        visual_manifest_identity="visual@test",
        resource_manifest_identity="resource@test",
    )
    writer.start_segment(
        checkpoint_id=1,
        scene_epoch=1,
        bootstrap_id=1,
        source_tick=0,
        bootstrap_packet=b"bootstrap",
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
