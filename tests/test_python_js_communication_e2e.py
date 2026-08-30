from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys

import pytest

from scripts.benchmark_python_js_communication import (
    PROFILE_ROUNDTRIP,
    run_benchmark,
)


ROOT = Path(__file__).parents[1]


def test_32_roots_cross_python_js_wire_and_ack_with_final_display_state() -> None:
    report = run_benchmark(
        roots=32,
        commits=6,
        update_ratio=0.25,
        profile=PROFILE_ROUNDTRIP,
    )

    assert report["status"] == "PASS"
    assert report["parameters"] == {
        "roots": 32,
        "commits": 6,
        "updateRatio": 0.25,
        "updatesPerCommit": 8,
        "profile": "roundtrip",
        "ticksPerSecond": 60,
    }
    assert report["commits"]["totalCommands"] == 48
    assert report["commits"]["pythonTickToAck"]["samples"] == 6
    assert report["commits"]["lengthFrameToAck"]["samples"] == 6
    assert report["commits"]["engineBytes"] > 0
    assert report["commits"]["ackBytes"] > 0
    assert all(report["correctness"].values())
    assert report["flowControl"]["peak"]["inFlightCount"] == 1
    assert report["flowControl"]["peak"]["pendingCount"] == 0
    assert report["flowControl"]["final"]["inFlightCount"] == 0
    assert report["flowControl"]["final"]["pendingCount"] == 0
    peer = report["final"]["peer"]
    assert peer["enginePacketCount"] == 7
    assert peer["transformDigest"]["rootCount"] == 32
    assert peer["finalCommit"]["commitSeq"] == 6
    assert peer["finalCommit"]["lastCommandSeq"] == 48
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
    assert report["status"] == "PASS"
    assert report["parameters"]["roots"] == 32
    assert report["parameters"]["updatesPerCommit"] == 4
    assert report["parameters"]["profile"] == "windowed"
    assert report["flowControl"]["peak"]["inFlightCount"] == 8
    assert report["flowControl"]["peak"]["pendingCount"] == 8
    assert report["flowControl"]["final"]["inFlightCount"] == 0
    assert report["flowControl"]["final"]["pendingCount"] == 0
    assert set(report["commits"]["pythonTickToAck"]) == {
        "samples",
        "p50Ms",
        "p95Ms",
        "p99Ms",
        "maxMs",
    }
    assert report["throughput"]["engineAndAckBytesPerSecond"] > 0
    assert report["throughput"]["displayCommandsPerSecond"] > 0
    assert completed.stderr == ""


def test_benchmark_rejects_a_non_positive_timeout_before_starting_a_peer() -> None:
    with pytest.raises(ValueError, match="timeout_seconds"):
        run_benchmark(
            roots=1,
            commits=1,
            update_ratio=1,
            profile=PROFILE_ROUNDTRIP,
            timeout_seconds=0,
        )
