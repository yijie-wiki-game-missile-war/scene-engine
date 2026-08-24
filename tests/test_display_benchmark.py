from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

import scripts.benchmark_scene_500 as benchmark_module


ROOT = Path(__file__).parents[1]


def test_git_metadata_is_optional_in_a_source_package(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(benchmark_module, "ROOT", tmp_path)
    assert benchmark_module.git("rev-parse", "HEAD") is None


def test_quick_display_benchmark_is_strictly_500_nodes(tmp_path) -> None:
    output = tmp_path / "benchmark.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "benchmark_scene_500.py"),
            "--quick",
            "--warmup",
            "0",
            "--samples",
            "2",
            "--rounds",
            "1",
            "--output",
            str(output),
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "scene-engine-display-perf-500@2"
    assert report["parameters"]["node_count"] == 500
    assert report["checkpoint"]["node_count"] == 500
    assert report["checkpoint"]["packet_bytes"] > 0
    assert report["structural_counts"] == {
        "authority_roots": 500,
        "bulk_nodes_fields": 0,
        "checkpoint_nodes": 500,
        "maximum_commands": 500,
    }
    assert set(report["scenarios"]) == set(benchmark_module.SCENARIOS)
    for scenario in report["scenarios"].values():
        assert scenario["aggregate"]["publication_total_ms"]["samples"] == 2
        assert scenario["packet_bytes"]["p50"] > 0
    gates = report["performance_gates"]
    assert gates["mode"] == "quick"
    assert gates["structural_gates_passed"] is True
    assert gates["time_gates_enforced"] is False
    assert gates["overall_passed"] is True
    assert completed.stdout.startswith("scene-engine-display-perf-500@2 nodes=500 ")
    assert f"output={output.resolve()}" in completed.stdout
    assert completed.stderr == ""


def test_formal_display_benchmark_requires_output() -> None:
    completed = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "benchmark_scene_500.py"), "--samples", "1"],
        check=False,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 2
    assert "formal benchmark runs require --output" in completed.stderr


def test_formal_run_benchmark_api_cannot_bypass_minimums() -> None:
    with pytest.raises(ValueError, match="formal benchmark minimums"):
        benchmark_module.run_benchmark(
            warmup=59,
            samples=600,
            rounds=5,
            enforce_time_gates=True,
        )


def test_performance_gate_failure_is_reported() -> None:
    aggregate = {
        "command_stream_encode_ms": {"p95": 8.001, "p99": 9.0},
        "publication_total_ms": {"p95": 9.0},
    }
    scenarios = {
        scenario: {"aggregate": aggregate} for scenario in benchmark_module.SCENARIOS
    }
    gates = benchmark_module.performance_gates(scenarios, enforce_time_gates=True)
    assert gates["time_gates_observed_passed"] is False
    assert gates["overall_passed"] is False


def test_quick_display_benchmark_without_output_prints_only_summary() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "benchmark_scene_500.py"),
            "--quick",
            "--warmup",
            "0",
            "--samples",
            "1",
            "--rounds",
            "1",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.count("\n") == 1
    assert completed.stdout.startswith("scene-engine-display-perf-500@2 nodes=500 ")
    assert " output=- sha256=" in completed.stdout
    assert completed.stderr == ""
