from __future__ import annotations

import hashlib
import json
import struct

import pytest

from scene_engine.display import (
    DisplayCatalogIdentity,
    DisplayCommand,
    encode_display_checkpoint,
    encode_display_command_stream,
)
from scene_engine.errors import RecordingError
from scene_engine.recording import (
    PACKET_LOG_SCHEMA,
    PacketLogWriter,
    read_packet_log,
    rebuild_packet_index,
)
from scene_engine.wire import encode_checkpoint, encode_commit


CATALOG = DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64)


def checkpoint(
    *,
    stream_id: str = "stream-1",
    commit_seq: int = 0,
    source_tick: int = 0,
    world_revision: int = 0,
    last_command_seq: int = 0,
) -> bytes:
    display = encode_display_checkpoint(
        scene_name="main",
        catalog=CATALOG,
        last_command_seq=last_command_seq,
        nodes=(),
    )
    return encode_checkpoint(
        stream_id=stream_id,
        commit_seq=commit_seq,
        source_tick=source_tick,
        world_revision=world_revision,
        last_command_seq=last_command_seq,
        world_codec="world@1",
        world_snapshot={"schema": "world@1"},
        display_checkpoint=display,
    )


def commit(
    *,
    stream_id: str = "stream-1",
    commit_seq: int,
    source_tick: int,
    world_revision: int,
    base_command_seq: int,
    commands: tuple[DisplayCommand, ...] = (),
    cause: str = "tick",
) -> bytes:
    display, cursor = encode_display_command_stream(
        base_command_seq=base_command_seq,
        source_tick=source_tick,
        commands=commands,
    )
    return encode_commit(
        stream_id=stream_id,
        commit_seq=commit_seq,
        source_tick=source_tick,
        world_revision=world_revision,
        last_command_seq=cursor,
        cause=cause,
        causation_id="input-1" if cause == "input" else None,
        world_codec="world@1",
        world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
        display_commands=display,
    )


def physical(*values: bytes) -> bytes:
    return b"".join(struct.pack("<Q", len(value)) + value for value in values)


def test_writer_streams_exact_packets_and_indexes_command_cursor(tmp_path) -> None:
    initial = checkpoint()
    tick = commit(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        base_command_seq=0,
        commands=(DisplayCommand.set_visible("py/a", False),),
    )
    input_commit = commit(
        commit_seq=2,
        source_tick=1,
        world_revision=2,
        base_command_seq=1,
        cause="input",
    )
    writer = PacketLogWriter(tmp_path, fsync=False)
    writer.append(initial, checkpoint=True)
    writer.append(tick, checkpoint=False)
    writer.append(input_commit, checkpoint=False)
    manifest = writer.seal()
    log = read_packet_log(tmp_path)

    assert manifest["schema"] == PACKET_LOG_SCHEMA == "scene-engine-packet-log@2"
    assert manifest["first_command_seq"] == 0
    assert manifest["last_command_seq"] == 1
    assert [entry.last_command_seq for entry in log.entries] == [0, 1, 1]
    assert log.packet_at(0) == initial
    assert log.packet_at(2) == input_commit
    assert log.entries == rebuild_packet_index(log.packets)
    assert not (tmp_path / "INCOMPLETE").exists()
    for invalid in (-1, True, 1.5):
        with pytest.raises(RecordingError):
            log.packet_at(invalid)  # type: ignore[arg-type]


def test_writer_leaves_incomplete_marker_until_seal(tmp_path) -> None:
    writer = PacketLogWriter(tmp_path, fsync=False)
    assert (tmp_path / "INCOMPLETE").exists()
    writer.append(checkpoint(), checkpoint=True)
    writer.close_incomplete()
    with pytest.raises(RecordingError):
        read_packet_log(tmp_path)


def test_rebuild_rejects_progression_and_periodic_cursor_errors() -> None:
    initial = checkpoint()
    tick = commit(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        base_command_seq=0,
        commands=(DisplayCommand.set_visible("py/a", False),),
    )
    malformed = (
        commit(
            stream_id="other-stream",
            commit_seq=2,
            source_tick=1,
            world_revision=2,
            base_command_seq=1,
            cause="input",
        ),
        commit(
            commit_seq=3,
            source_tick=1,
            world_revision=2,
            base_command_seq=1,
            cause="input",
        ),
        commit(
            commit_seq=2,
            source_tick=1,
            world_revision=3,
            base_command_seq=1,
            cause="input",
        ),
        commit(
            commit_seq=2,
            source_tick=1,
            world_revision=2,
            base_command_seq=0,
            commands=(DisplayCommand.set_visible("py/a", True),),
            cause="input",
        ),
    )
    for value in malformed:
        with pytest.raises(RecordingError):
            rebuild_packet_index(physical(initial, tick, value))

    wrong_periodic = checkpoint(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        last_command_seq=0,
    )
    with pytest.raises(RecordingError):
        rebuild_packet_index(physical(initial, tick, wrong_periodic))


def test_reader_rejects_boolean_command_cursor_even_with_consistent_hash(tmp_path) -> None:
    writer = PacketLogWriter(tmp_path, fsync=False)
    writer.append(checkpoint(), checkpoint=True)
    writer.seal()
    index_path = tmp_path / "index.json"
    index = json.loads(index_path.read_text())
    index[0]["last_command_seq"] = False
    index_bytes = canonical(index)
    index_path.write_bytes(index_bytes)
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["index_sha256"] = hashlib.sha256(index_bytes).hexdigest()
    manifest_path.write_bytes(canonical(manifest))
    with pytest.raises(RecordingError):
        read_packet_log(tmp_path)


def canonical(value) -> bytes:
    return (
        json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
        + b"\n"
    )
