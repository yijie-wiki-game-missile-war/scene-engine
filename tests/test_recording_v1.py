from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest

from scene_engine.errors import RecordingError
from scene_engine.recording import PacketLogWriter, read_packet_log, rebuild_packet_index
from scene_engine.wire import read_engine_packet


WIRE = Path(__file__).parents[1] / "fixtures" / "wire-v1"


def packet(name: str) -> bytes:
    return (WIRE / name).read_bytes()


def physical(*values: bytes) -> bytes:
    return b"".join(struct.pack("<Q", len(value)) + value for value in values)


def test_writer_streams_exact_packet_bytes_and_seals_rebuildable_index(tmp_path) -> None:
    writer = PacketLogWriter(tmp_path, fsync=False)
    writer.append(packet("checkpoint.bin"), checkpoint=True)
    writer.append(packet("commit-tick.bin"), checkpoint=False)
    writer.append(packet("commit-input.bin"), checkpoint=False)
    manifest = writer.seal()
    log = read_packet_log(tmp_path)
    assert manifest["packet_count"] == 3
    assert log.packet_at(0) == packet("checkpoint.bin")
    assert log.packet_at(2) == packet("commit-input.bin")
    assert log.entries == rebuild_packet_index(log.packets)
    assert not (tmp_path / "INCOMPLETE").exists()
    for invalid in (-1, True, 1.5):
        with pytest.raises(RecordingError):
            log.packet_at(invalid)  # type: ignore[arg-type]


def test_writer_leaves_incomplete_marker_until_seal(tmp_path) -> None:
    writer = PacketLogWriter(tmp_path, fsync=False)
    assert (tmp_path / "INCOMPLETE").exists()
    writer.append(packet("checkpoint.bin"), checkpoint=True)
    writer.close_incomplete()
    with pytest.raises(RecordingError):
        read_packet_log(tmp_path)


def test_rebuild_rejects_wrong_stream_gap_revision_tick_and_periodic_cursor() -> None:
    checkpoint = packet("checkpoint.bin")
    tick = packet("commit-tick.bin")
    input_commit = packet("commit-input.bin")
    header = dict(read_engine_packet(input_commit).header)
    cases = []

    wrong_stream = dict(header, stream_id="other-stream")
    cases.append(reencode(input_commit, wrong_stream))
    gap = dict(header, commit_seq=3)
    cases.append(reencode(input_commit, gap))
    revision = dict(header, world_revision=3)
    cases.append(reencode(input_commit, revision))
    wrong_tick = dict(header, source_tick=2)
    cases.append(reencode(input_commit, wrong_tick))
    checkpoint_header = dict(read_engine_packet(checkpoint).header, commit_seq=1)
    periodic = reencode(checkpoint, checkpoint_header)

    for malformed in cases:
        with pytest.raises(RecordingError):
            rebuild_packet_index(physical(checkpoint, tick, malformed))
    with pytest.raises(RecordingError):
        rebuild_packet_index(physical(checkpoint, periodic))


def test_reader_rejects_boolean_index_integer_even_with_self_consistent_hash(tmp_path) -> None:
    writer = PacketLogWriter(tmp_path, fsync=False)
    writer.append(packet("checkpoint.bin"), checkpoint=True)
    writer.seal()
    index_path = tmp_path / "index.json"
    index = json.loads(index_path.read_text())
    index[0]["commit_seq"] = False
    index_bytes = canonical(index)
    index_path.write_bytes(index_bytes)
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["index_sha256"] = hashlib.sha256(index_bytes).hexdigest()
    manifest_path.write_bytes(canonical(manifest))
    with pytest.raises(RecordingError):
        read_packet_log(tmp_path)


def reencode(raw: bytes, header: dict) -> bytes:
    decoded = read_engine_packet(raw)
    from scene_engine.wire import encode_engine_packet

    return encode_engine_packet(decoded.kind, header, decoded.attachments)


def canonical(value) -> bytes:
    return (
        json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
        + b"\n"
    )
