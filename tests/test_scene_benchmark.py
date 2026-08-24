from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

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
    assert report["schema"] == "scene-engine-perf-500@1"
    assert report["parameters"] == {
        "benchmark_mode": "quick",
        "static_node_count": 632,
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
    assert report["bootstrap_bytes"] > 0
    assert set(report["structural_counts"]) == {
        "steady",
        "motion",
        "churn-25",
    }
    for counts in report["structural_counts"].values():
        assert counts["frames"] == 1
        assert counts["static_node_iterations_per_frame"] == 0
        assert counts["static_pose_compositions_per_frame"] == 0
        assert counts["static_registry_rebuilds_per_frame"] == 0
        assert counts["visual_registry_source_iterations_per_frame"] == 0
        assert counts["animation_registry_source_iterations_per_frame"] == 0
        assert counts["cached_index_iterations_per_frame"] == 0
        assert counts["cached_index_lookups_per_frame"] > 0
    gates = report["performance_gates"]
    assert gates["mode"] == "quick"
    assert gates["structural_gates_enforced"] is True
    assert gates["structural_gates_passed"] is True
    assert gates["time_gates_enforced"] is False
    assert gates["overall_passed"] is True
    assert set(gates["scenarios"]) == {"steady", "motion", "churn-25"}
    for scenario_gates in gates["scenarios"].values():
        assert set(scenario_gates["checks"]) == {
            "structured_validate_encode_p95",
            "structured_validate_encode_p99",
            "publication_total_p95",
        }
    for scenario in report["scenarios"].values():
        assert scenario["aggregate"]["publication_total_ms"]["samples"] == 2
        assert scenario["frame_bytes"]["p50"] > 0
    stdout_lines = completed.stdout.splitlines()
    assert len(stdout_lines) == 1
    assert stdout_lines[0].startswith(
        "scene-engine-perf-500@1 static=632 dynamic=500 "
    )
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


@pytest.mark.parametrize(
    ("argument", "value"),
    (("--warmup", "59"), ("--samples", "599"), ("--rounds", "4")),
)
def test_formal_scene_publication_benchmark_rejects_undersized_runs(
    tmp_path: Path,
    argument: str,
    value: str,
) -> None:
    values = {"--warmup": "60", "--samples": "600", "--rounds": "5"}
    values[argument] = value
    output = tmp_path / "must-not-run.json"
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "benchmark_scene_500.py"),
            "--output",
            str(output),
            "--warmup",
            values["--warmup"],
            "--samples",
            values["--samples"],
            "--rounds",
            values["--rounds"],
        ],
        check=False,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 2
    assert completed.stdout == ""
    assert "formal benchmark minimums are warmup >= 60" in completed.stderr
    assert not output.exists()


def test_formal_run_benchmark_api_cannot_bypass_minimums() -> None:
    with pytest.raises(ValueError, match="formal benchmark minimums"):
        benchmark_module.run_benchmark(
            warmup=59,
            samples=600,
            rounds=5,
            enforce_time_gates=True,
        )


def test_formal_performance_gate_failure_saves_report_then_exits_nonzero(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    aggregate = {
        "structured_validate_encode_ms": {"p95": 4.001, "p99": 5.0},
        "publication_total_ms": {
            "p50": 4.1,
            "p95": 4.2,
            "p99": 4.3,
            "maximum": 4.4,
        },
    }
    scenarios = {
        scenario: {"aggregate": aggregate} for scenario in benchmark_module.SCENARIOS
    }
    gates = benchmark_module.performance_gates(
        scenarios,
        enforce_time_gates=True,
    )
    assert gates["time_gates_enforced"] is True
    assert gates["time_gates_observed_passed"] is False
    assert gates["overall_passed"] is False

    report = {
        "schema": "scene-engine-perf-500@1",
        "scenarios": scenarios,
        "performance_gates": gates,
    }

    def fake_run_benchmark(**kwargs):
        assert kwargs == {
            "warmup": 60,
            "samples": 600,
            "rounds": 5,
            "enforce_time_gates": True,
        }
        return report

    output = tmp_path / "failed-formal.json"
    monkeypatch.setattr(benchmark_module, "run_benchmark", fake_run_benchmark)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "benchmark_scene_500.py",
            "--output",
            str(output),
            "--warmup",
            "60",
            "--samples",
            "600",
            "--rounds",
            "5",
        ],
    )

    with pytest.raises(SystemExit) as error:
        benchmark_module.main()
    assert error.value.code == 1
    assert json.loads(output.read_text(encoding="utf-8")) == report
    captured = capsys.readouterr()
    assert "formal performance gates failed; report saved" in captured.err


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
    assert completed.stdout.startswith(
        "scene-engine-perf-500@1 static=632 dynamic=500 "
    )
    assert " output=- sha256=" in completed.stdout
    assert '"scenarios"' not in completed.stdout
    assert completed.stderr == ""
