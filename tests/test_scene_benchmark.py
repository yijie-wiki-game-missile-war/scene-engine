from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import scripts.benchmark_scene_500 as benchmark_module


ROOT = Path(__file__).parents[1]


def test_git_metadata_is_optional_in_a_source_package(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(benchmark_module, "ROOT", tmp_path)
    assert benchmark_module.git("rev-parse", "HEAD") is None
    assert benchmark_module.git("status", "--porcelain") is None


def test_quick_scene_publication_benchmark_is_strictly_500_nodes(tmp_path) -> None:
    output = tmp_path / "benchmark.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "benchmark_scene_500.py"),
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
    assert report["schema"] == "scene-engine-perf-500@1"
    assert report["parameters"] == {
        "node_count": 500,
        "churn_nodes": 25,
        "churn_ratio": 0.05,
        "memory_probe_samples": 2,
        "rounds": 1,
        "samples_per_round": 2,
        "scenario_order": ["steady", "motion", "churn-25"],
        "warmup_per_round": 0,
    }
    assert set(report["scenarios"]) == {"steady", "motion", "churn-25"}
    for scenario in report["scenarios"].values():
        assert scenario["aggregate"]["publication_total_ms"]["samples"] == 2
        assert scenario["frame_bytes"]["p50"] > 0
    stdout_lines = completed.stdout.splitlines()
    assert len(stdout_lines) == 1
    assert stdout_lines[0].startswith("scene-engine-perf-500@1 nodes=500 ")
    assert "steady[p50=" in stdout_lines[0]
    assert "motion[p50=" in stdout_lines[0]
    assert "churn-25[p50=" in stdout_lines[0]
    assert ",p95=" in stdout_lines[0]
    assert ",p99=" in stdout_lines[0]
    assert ",max=" in stdout_lines[0]
    assert f"output={output.resolve()}" in stdout_lines[0]
    assert " sha256=" in stdout_lines[0]
    assert completed.stderr == ""


def test_formal_scene_publication_benchmark_requires_output() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "benchmark_scene_500.py"),
            "--warmup",
            "0",
            "--samples",
            "1",
            "--rounds",
            "1",
        ],
        check=False,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "formal benchmark runs require --output" in completed.stderr


def test_quick_scene_publication_benchmark_without_output_prints_only_summary() -> None:
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
    assert completed.stdout.startswith("scene-engine-perf-500@1 nodes=500 ")
    assert " output=- sha256=" in completed.stdout
    assert '"scenarios"' not in completed.stdout
    assert completed.stderr == ""
