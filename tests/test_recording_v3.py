from __future__ import annotations

import hashlib
import json
import struct

import numpy as np
import pytest
import scene_engine.wire as wire_module

from scene_engine.display import (
    DisplayCommand,
    DisplayMatrixPool,
    DisplayNode,
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


def test_default_durable_writer_seals_and_reopens_on_host_platform(tmp_path):
    directory = tmp_path / "durable-log"
    writer = PacketLogWriter(directory)
    raw = checkpoint()
    writer.append(raw, checkpoint=True)
    manifest = writer.seal()
    assert manifest["complete"] is True
    assert not (directory / "INCOMPLETE").exists()
    reopened = read_packet_log(directory)
    assert reopened.manifest == manifest
    assert reopened.entries[0].commit_seq == 0


def checkpoint(
    *,
    stream_id: str = "stream-1",
    commit_seq: int = 0,
    source_tick: int = 0,
    world_revision: int = 0,
    last_command_seq: int = 0,
    matrix_pool_size: int = 1,
    active_node_ids: tuple[int, ...] = (0,),
) -> bytes:
    pool = DisplayMatrixPool()
    for _ in range(matrix_pool_size):
        pool.append()
    if matrix_pool_size:
        published = encode_display_checkpoint(
            scene_name="main",
            last_command_seq=last_command_seq,
            matrix_pool=pool,
            nodes=tuple(
                DisplayNode(
                    node_id=node_id,
                    parent_node_id=None,
                    display_kind_id="world/node",
                    transform_mode="live",
                    visible=True,
                    state={},
                )
                for node_id in range(matrix_pool_size)
            ),
        )
        published.confirm_published()
        for node_id in set(range(matrix_pool_size)) - set(active_node_ids):
            pool.retire(node_id)
    display = encode_display_checkpoint(
        scene_name="main",
        last_command_seq=last_command_seq,
        matrix_pool=pool,
        nodes=tuple(
            DisplayNode(
                node_id=node_id,
                parent_node_id=None,
                display_kind_id="world/node",
                transform_mode="live",
                visible=True,
                state={},
            )
            for node_id in active_node_ids
        ),
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
    pool = DisplayMatrixPool()
    targeted_node_ids = [
        node_id
        for command in commands
        for node_id in (
            tuple(int(value) for value in command.node_ids)
            if command.node_ids is not None
            else (command.node_id,)
        )
        if node_id is not None
    ]
    maximum_node_id = max(targeted_node_ids, default=0)
    created_node_ids = {
        command.node_id for command in commands if command.kind == "node-create"
    }
    previous_pool_size = min(created_node_ids, default=maximum_node_id + 1)
    for _ in range(previous_pool_size):
        pool.append()
    if previous_pool_size:
        baseline = encode_display_checkpoint(
            scene_name="main",
            last_command_seq=base_command_seq,
            matrix_pool=pool,
            nodes=tuple(
                DisplayNode(
                    node_id=node_id,
                    parent_node_id=None,
                    display_kind_id="world/node",
                    transform_mode="live",
                    visible=True,
                    state={},
                )
                for node_id in range(previous_pool_size)
            ),
        )
        baseline.confirm_published()
    for _ in range(previous_pool_size, maximum_node_id + 1):
        pool.append()
    for command in commands:
        if command.kind == "node-remove":
            pool.retire(command.node_id)
        elif command.kind == "node-set-transform-batch":
            assert command.node_ids is not None
            rows = np.ascontiguousarray(pool.matrices[command.node_ids], dtype="<f4")
            pool.set_batch(command.node_ids, rows)
    display, cursor = encode_display_command_stream(
        base_command_seq=base_command_seq,
        source_tick=source_tick,
        matrix_pool=pool,
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
        commands=(DisplayCommand.set_visible(0, False),),
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

    assert manifest["schema"] == PACKET_LOG_SCHEMA == "scene-engine-packet-log@3"
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


def test_recording_reuses_each_packet_display_decode_for_index_and_lifecycle(
    tmp_path, monkeypatch
) -> None:
    initial = checkpoint()
    tick = commit(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        base_command_seq=0,
        commands=(DisplayCommand.set_visible(0, False),),
    )
    decode_calls = 0
    checkpoint_decode = wire_module.decode_display_checkpoint_binary
    command_decode = wire_module.decode_display_command_stream_binary

    def counting_checkpoint_decode(*args, **kwargs):
        nonlocal decode_calls
        decode_calls += 1
        return checkpoint_decode(*args, **kwargs)

    def counting_command_decode(*args, **kwargs):
        nonlocal decode_calls
        decode_calls += 1
        return command_decode(*args, **kwargs)

    monkeypatch.setattr(
        wire_module, "decode_display_checkpoint_binary", counting_checkpoint_decode
    )
    monkeypatch.setattr(
        wire_module, "decode_display_command_stream_binary", counting_command_decode
    )

    writer = PacketLogWriter(tmp_path, fsync=False)
    writer.append(initial, checkpoint=True)
    writer.append(tick, checkpoint=False)
    assert decode_calls == 2
    writer.seal()

    decode_calls = 0
    assert len(rebuild_packet_index(physical(initial, tick))) == 2
    assert decode_calls == 2


def test_recording_tracks_every_transform_batch_target_as_active() -> None:
    initial = checkpoint(matrix_pool_size=2, active_node_ids=(0, 1))
    update = commit(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        base_command_seq=0,
        commands=(DisplayCommand.set_transform_batch((1, 0)),),
    )

    entries = rebuild_packet_index(physical(initial, update))
    assert entries[-1].last_command_seq == 1

    tombstoned_initial = checkpoint(matrix_pool_size=2, active_node_ids=(0,))
    with pytest.raises(RecordingError, match="transform batch target is not active"):
        rebuild_packet_index(physical(tombstoned_initial, update))


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
        commands=(DisplayCommand.set_visible(0, False),),
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
            commands=(DisplayCommand.set_visible(0, True),),
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


@pytest.mark.parametrize(
    ("matrix_pool_size", "active_node_ids"),
    ((1, (0,)), (2, (0, 1))),
    ids=("shrink", "resurrect-retired-id"),
)
def test_packet_log_rejects_periodic_checkpoint_matrix_pool_lifecycle_forks(
    tmp_path,
    matrix_pool_size: int,
    active_node_ids: tuple[int, ...],
) -> None:
    initial = checkpoint(matrix_pool_size=2, active_node_ids=(0, 1))
    removed = commit(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        base_command_seq=0,
        commands=(DisplayCommand.remove(1),),
    )
    malicious_checkpoint = checkpoint(
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        last_command_seq=1,
        matrix_pool_size=matrix_pool_size,
        active_node_ids=active_node_ids,
    )

    with pytest.raises(RecordingError):
        rebuild_packet_index(physical(initial, removed, malicious_checkpoint))

    writer = PacketLogWriter(tmp_path, fsync=False)
    writer.append(initial, checkpoint=True)
    writer.append(removed, checkpoint=False)
    with pytest.raises(RecordingError):
        writer.append(malicious_checkpoint, checkpoint=True)
    writer.close_incomplete()


def test_packet_log_rejects_sparse_uint32_pool_growth_without_suffix_allocation() -> None:
    initial = checkpoint(matrix_pool_size=0, active_node_ids=())
    sparse_growth = encode_commit(
        stream_id="stream-1",
        commit_seq=1,
        source_tick=1,
        world_revision=1,
        last_command_seq=0,
        cause="tick",
        causation_id=None,
        world_codec="world@1",
        world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
        display_commands={
            "schema": "scene-engine-display-command-stream@9",
            "base_command_seq": 0,
            "last_command_seq": 0,
            "matrix_pool_size": 0xFFFFFFFF,
            "dirty_node_ids": [],
            "dirty_matrices": [],
            "commands": [],
        },
    )

    with pytest.raises(RecordingError):
        rebuild_packet_index(physical(initial, sparse_growth))


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
