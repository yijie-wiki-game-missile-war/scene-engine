from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
import numpy as np

import scripts.benchmark_python_js_communication as benchmark_module
from scripts.benchmark_python_js_communication import (
    CommunicationProgram,
    CommunicationWorld,
    LengthFramedPeer,
    PROFILE_ROUNDTRIP,
    run_benchmark,
)


ROOT = Path(__file__).parents[1]


def test_length_framed_peer_owns_cross_platform_blocking_pipe_workers() -> None:
    peer = LengthFramedPeer()
    workers = (peer._stdin_thread, peer._stdout_thread, peer._stderr_thread)
    try:
        assert all(worker.is_alive() for worker in workers)
        assert all(worker.daemon for worker in workers)
    finally:
        peer.abort()
    assert all(not worker.is_alive() for worker in workers)


def test_32_roots_cross_python_js_wire_and_ack_with_final_display_state() -> None:
    report = run_benchmark(
        roots=32,
        commits=6,
        update_ratio=0.25,
        profile=PROFILE_ROUNDTRIP,
    )

    assert report["schema"] == "scene-engine-python-js-communication@3"
    assert report["status"] == "PASS"
    assert report["transformDigestEncoding"] == (
        "node-id-u32le-le-f32-matrix16"
    )
    assert report["parameters"] == {
        "roots": 32,
        "commits": 6,
        "updateRatio": 0.25,
        "updatesPerCommit": 8,
        "profile": "roundtrip",
        "ticksPerSecond": 60,
    }
    assert report["commits"]["logicalCommands"] == 6
    assert report["commits"]["totalTransformRows"] == 48
    assert report["commits"]["pythonTickToAck"]["samples"] == 6
    assert report["commits"]["pythonTickToTransport"]["samples"] == 6
    assert report["commits"]["lengthFrameToAck"]["samples"] == 6
    assert report["commits"]["pythonTickToTransport"]["p50Ms"] > 0
    assert report["commits"]["latencySemantics"]["pythonTickToTransport"] == (
        "runtime pump start through transport send entry; windowed profile includes "
        "Python flow-control queueing"
    )
    assert report["commits"]["engineBytes"] > 0
    assert report["commits"]["ackBytes"] > 0
    assert all(report["correctness"].values())
    assert report["flowControl"]["peak"]["inFlightCount"] == 1
    assert report["flowControl"]["peak"]["pendingCount"] == 0
    assert report["flowControl"]["final"]["inFlightCount"] == 0
    assert report["flowControl"]["final"]["pendingCount"] == 0
    peer = report["final"]["peer"]
    assert peer["schema"] == "scene-engine-python-js-communication-peer@3"
    assert peer["transformDigestEncoding"] == report["transformDigestEncoding"]
    assert peer["enginePacketCount"] == 7
    assert peer["transformDigest"]["rootCount"] == 32
    assert peer["finalCommit"]["commitSeq"] == 6
    assert peer["finalCommit"]["lastCommandSeq"] == 6
    assert peer["noRenderWork"] == {
        "catalogResourceCount": 0,
        "frameRequests": 7,
        "frameExecutions": 0,
        "pendingFrameCallbacks": 1,
        "fakeBackendDraws": 0,
        "fakeBackendBindings": 1,
    }
    assert peer["cleanup"] == {
        "nodeCount": 0,
        "schedulerHandlerCount": 0,
        "renderSystemEntryCount": 0,
        "animationPlayerCount": 0,
        "pendingFrameCallbacks": 0,
        "fakeBackendBindings": 0,
        "fakeBackendDisposed": True,
        "returnedToZero": True,
    }


def test_benchmark_cli_prints_one_json_report_to_stdout_only() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "benchmark_python_js_communication.py"),
            "--roots",
            "32",
            "--commits",
            "18",
            "--update-ratio",
            "0.125",
            "--profile",
            "windowed",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(completed.stdout)
    assert report["schema"] == "scene-engine-python-js-communication@3"
    assert report["status"] == "PASS"
    assert report["transformDigestEncoding"] == (
        "node-id-u32le-le-f32-matrix16"
    )
    assert report["parameters"]["roots"] == 32
    assert report["parameters"]["updatesPerCommit"] == 4
    assert report["parameters"]["profile"] == "windowed"
    assert report["flowControl"]["peak"]["inFlightCount"] == 8
    assert report["flowControl"]["peak"]["pendingCount"] == 8
    assert report["flowControl"]["final"]["inFlightCount"] == 0
    assert report["flowControl"]["final"]["pendingCount"] == 0
    timing_fields = {
        "samples",
        "p50Ms",
        "p95Ms",
        "p99Ms",
        "maxMs",
    }
    assert set(report["commits"]["pythonTickToAck"]) == timing_fields
    assert set(report["commits"]["pythonTickToTransport"]) == timing_fields
    assert report["commits"]["pythonTickToTransport"]["p50Ms"] > 0
    assert report["throughput"]["engineAndAckBytesPerSecond"] > 0
    assert report["throughput"]["logicalCommandsPerSecond"] > 0
    assert completed.stderr == ""


def test_benchmark_world_reuses_resident_matrix_pool_without_publication_rebuild(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world = CommunicationWorld(3)
    initial = world.matrix_pool.matrices.copy()
    program = CommunicationProgram(
        roots=3,
        updates_per_commit=1,
    )
    calls: list[tuple[float, float, float]] = []
    original = benchmark_module.display_transform

    def counted(position: tuple[float, float, float]):
        calls.append(position)
        return original(position)

    monkeypatch.setattr(benchmark_module, "display_transform", counted)

    checkpoint = program.build_checkpoint(world, None)
    assert calls == []
    assert checkpoint.display_matrix_pool is world.matrix_pool
    assert tuple(node.node_id for node in checkpoint.display_nodes) == (0, 1, 2)

    mutation = program.step(
        world,
        SimpleNamespace(commit=SimpleNamespace(source_tick=1)),
    )
    assert calls == []
    current = world.matrix_pool.matrices
    assert not np.array_equal(current[0].view("<u4"), initial[0].view("<u4"))
    assert np.array_equal(current[1:].view("<u4"), initial[1:].view("<u4"))

    commit = program.build_commit(world, mutation, None)
    assert calls == []
    assert commit.display_matrix_pool is world.matrix_pool
    assert commit.display_commands[0].node_id is None
    assert commit.display_commands[0].node_ids.tolist() == [0]
    assert "transform" not in commit.display_commands[0].fields


def test_benchmark_rejects_a_non_positive_timeout_before_starting_a_peer() -> None:
    with pytest.raises(ValueError, match="timeout_seconds"):
        run_benchmark(
            roots=1,
            commits=1,
            update_ratio=1,
            profile=PROFILE_ROUNDTRIP,
            timeout_seconds=0,
        )
