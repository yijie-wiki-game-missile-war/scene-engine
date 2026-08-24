#!/usr/bin/env python3
"""Benchmark the 500-Node Display checkpoint and single-target command path."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
import platform
import statistics
import subprocess
import sys
import time
import tracemalloc
from pathlib import Path

try:
    import resource
except ImportError:  # pragma: no cover - unavailable on Windows.
    resource = None  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import scene_engine  # noqa: E402
from scene_engine.display import (  # noqa: E402
    DISPLAY_CODEC,
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    encode_display_checkpoint,
    encode_display_command_stream,
)
from scene_engine.wire import WIRE_SCHEMA, encode_checkpoint, encode_commit  # noqa: E402


NODE_COUNT = 500
CHURN_NODE_COUNT = 25
SCENARIOS = ("transform-500", "state-500", "churn-25")
FORMAL_MINIMUM_WARMUP = 60
FORMAL_MINIMUM_SAMPLES = 600
FORMAL_MINIMUM_ROUNDS = 5
COMMAND_ENCODE_P95_MAXIMUM_MS = 8.0
COMMAND_ENCODE_P99_MAXIMUM_MS = 12.0
PUBLICATION_P95_MAXIMUM_MS = 16.0
CATALOG = DisplayCatalogIdentity("a" * 64, "b" * 64, "c" * 64)


def transform(value: float) -> DisplayTransform:
    return DisplayTransform(
        position=(value, 0.0, 0.0),
        rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
        scale=(1.0, 1.0, 1.0),
    )


def baseline_nodes() -> tuple[DisplayNode, ...]:
    return tuple(
        DisplayNode(
            name=f"py/node-{index:04d}",
            parent_name=None,
            prefab_type="benchmark.node",
            transform_mode="live",
            transform=transform(float(index)),
            visible=True,
            state={"index": index, "generation": 0},
        )
        for index in range(NODE_COUNT)
    )


def commands_for(scenario: str, variant: int) -> tuple[DisplayCommand, ...]:
    if scenario == "transform-500":
        return tuple(
            DisplayCommand.set_transform(
                f"py/node-{index:04d}",
                transform(float(index) + variant / 1_000),
            )
            for index in range(NODE_COUNT)
        )
    if scenario == "state-500":
        return tuple(
            DisplayCommand.set_state(
                f"py/node-{index:04d}",
                {"index": index, "generation": variant},
            )
            for index in range(NODE_COUNT)
        )
    if scenario == "churn-25":
        removed = tuple(
            DisplayCommand.remove(f"py/node-{index:04d}")
            for index in range(CHURN_NODE_COUNT)
        )
        created = tuple(
            DisplayCommand.create(
                DisplayNode(
                    name=f"py/churn-{variant:04d}-{index:02d}",
                    parent_name=None,
                    prefab_type="benchmark.node",
                    transform_mode="live",
                    transform=transform(float(index)),
                    visible=True,
                    state={"index": index, "generation": variant},
                )
            )
            for index in range(CHURN_NODE_COUNT)
        )
        return removed + created
    raise ValueError(f"unknown scenario: {scenario}")


def percentile(values: list[float], probability: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def summarize(values: list[float]) -> dict[str, float | int]:
    if not values:
        raise ValueError("benchmark summaries require at least one sample")
    return {
        "samples": len(values),
        "p50": round(percentile(values, 0.50), 6),
        "p95": round(percentile(values, 0.95), 6),
        "p99": round(percentile(values, 0.99), 6),
        "mean": round(statistics.fmean(values), 6),
        "maximum": round(max(values), 6),
    }


def performance_gates(
    scenario_reports: dict[str, object], *, enforce_time_gates: bool
) -> dict[str, object]:
    scenarios: dict[str, object] = {}
    observed_passed = True
    for scenario in SCENARIOS:
        report = scenario_reports[scenario]
        assert isinstance(report, dict)
        aggregate = report["aggregate"]
        assert isinstance(aggregate, dict)
        commands = aggregate["command_stream_encode_ms"]
        publication = aggregate["publication_total_ms"]
        assert isinstance(commands, dict) and isinstance(publication, dict)
        checks = {
            "command_stream_encode_p95": {
                "actual_ms": commands["p95"],
                "maximum_ms": COMMAND_ENCODE_P95_MAXIMUM_MS,
                "passed": commands["p95"] <= COMMAND_ENCODE_P95_MAXIMUM_MS,
            },
            "command_stream_encode_p99": {
                "actual_ms": commands["p99"],
                "maximum_ms": COMMAND_ENCODE_P99_MAXIMUM_MS,
                "passed": commands["p99"] <= COMMAND_ENCODE_P99_MAXIMUM_MS,
            },
            "publication_total_p95": {
                "actual_ms": publication["p95"],
                "maximum_ms": PUBLICATION_P95_MAXIMUM_MS,
                "passed": publication["p95"] <= PUBLICATION_P95_MAXIMUM_MS,
            },
        }
        passed = all(check["passed"] for check in checks.values())
        scenarios[scenario] = {"checks": checks, "observed_passed": passed}
        observed_passed = observed_passed and passed
    return {
        "mode": "formal" if enforce_time_gates else "quick",
        "structural_gates_enforced": True,
        "structural_gates_passed": True,
        "time_gates_enforced": enforce_time_gates,
        "time_gates_observed_passed": observed_passed,
        "overall_passed": observed_passed if enforce_time_gates else True,
        "scenarios": scenarios,
    }


def maximum_rss_bytes() -> int | None:
    if resource is None:
        return None
    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return value if sys.platform == "darwin" else value * 1024


def memory_probe(*, samples: int) -> dict[str, int | None]:
    gc.collect()
    rss_before = maximum_rss_bytes()
    tracemalloc.start()
    traced_before, _ = tracemalloc.get_traced_memory()
    for sequence in range(samples):
        commands = commands_for("transform-500", sequence)
        stream, cursor = encode_display_command_stream(
            base_command_seq=sequence * NODE_COUNT,
            source_tick=sequence + 1,
            commands=commands,
        )
        packet = encode_commit(
            stream_id="display-benchmark",
            commit_seq=sequence + 1,
            source_tick=sequence + 1,
            world_revision=sequence + 1,
            last_command_seq=cursor,
            cause="tick",
            causation_id=None,
            world_codec="benchmark-world@1",
            world_patch={"schema": "scene-engine-json-tree@1", "changes": []},
            display_commands=stream,
        )
    del commands, stream, packet
    traced_after, traced_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    gc.collect()
    rss_after = maximum_rss_bytes()
    return {
        "samples": samples,
        "traced_retained_delta_bytes": traced_after - traced_before,
        "traced_peak_delta_bytes": traced_peak - traced_before,
        "process_maximum_rss_before_bytes": rss_before,
        "process_maximum_rss_after_bytes": rss_after,
        "process_maximum_rss_delta_bytes": (
            None
            if rss_before is None or rss_after is None
            else max(0, rss_after - rss_before)
        ),
    }


def git(*arguments: str) -> str | None:
    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), *arguments],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def run_benchmark(
    *, warmup: int, samples: int, rounds: int, enforce_time_gates: bool
) -> dict[str, object]:
    if warmup < 0 or samples <= 0 or rounds <= 0:
        raise ValueError("warmup must be non-negative; samples and rounds must be positive")
    if enforce_time_gates and (
        warmup < FORMAL_MINIMUM_WARMUP
        or samples < FORMAL_MINIMUM_SAMPLES
        or rounds < FORMAL_MINIMUM_ROUNDS
    ):
        raise ValueError(
            "formal benchmark minimums are "
            f"warmup >= {FORMAL_MINIMUM_WARMUP}, "
            f"samples >= {FORMAL_MINIMUM_SAMPLES}, and "
            f"rounds >= {FORMAL_MINIMUM_ROUNDS}"
        )

    nodes = baseline_nodes()
    display_checkpoint = encode_display_checkpoint(
        scene_name="benchmark",
        catalog=CATALOG,
        last_command_seq=0,
        nodes=nodes,
    )
    checkpoint_packet = encode_checkpoint(
        stream_id="display-benchmark",
        commit_seq=0,
        source_tick=0,
        world_revision=0,
        last_command_seq=0,
        world_codec="benchmark-world@1",
        world_snapshot={"tick": 0},
        display_checkpoint=display_checkpoint,
    )
    patch = {"schema": "scene-engine-json-tree@1", "changes": []}
    report: dict[str, object] = {
        "schema": "scene-engine-display-perf-500@2",
        "repository": str(ROOT),
        "git": {
            "head": git("rev-parse", "HEAD"),
            "status_porcelain": git("status", "--porcelain"),
        },
        "runtime": {
            "scene_engine_version": scene_engine.__version__,
            "display_codec": DISPLAY_CODEC,
            "wire_schema": WIRE_SCHEMA,
            "python": sys.version,
            "python_implementation": platform.python_implementation(),
            "executable": sys.executable,
            "timer": "time.perf_counter_ns",
        },
        "hardware": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
        },
        "parameters": {
            "benchmark_mode": "formal" if enforce_time_gates else "quick",
            "node_count": NODE_COUNT,
            "churn_nodes": CHURN_NODE_COUNT,
            "churn_ratio": CHURN_NODE_COUNT / NODE_COUNT,
            "warmup_per_round": warmup,
            "samples_per_round": samples,
            "rounds": rounds,
            "memory_probe_samples": min(samples, 60),
            "scenario_order": list(SCENARIOS),
        },
        "measured_path": (
            "Engine assigns stream-global command_seq to independent Node commands "
            "and encodes one wire@2 commit seal"
        ),
        "checkpoint": {
            "node_count": len(nodes),
            "packet_bytes": len(checkpoint_packet),
        },
        "structural_counts": {
            "checkpoint_nodes": len(display_checkpoint["nodes"]),
            "authority_roots": sum(node.parent_name is None for node in nodes),
            "maximum_commands": NODE_COUNT,
            "bulk_nodes_fields": 0,
        },
        "scenarios": {},
    }
    if report["structural_counts"] != {
        "checkpoint_nodes": 500,
        "authority_roots": 500,
        "maximum_commands": 500,
        "bulk_nodes_fields": 0,
    }:
        raise RuntimeError("500-Node Display structural gate failed")

    scenario_reports = report["scenarios"]
    assert isinstance(scenario_reports, dict)
    for scenario in SCENARIOS:
        aggregate: dict[str, list[float]] = {
            "command_stream_encode_ms": [],
            "wire_commit_encode_ms": [],
            "publication_total_ms": [],
        }
        command_counts: list[float] = []
        stream_bytes: list[float] = []
        packet_bytes: list[float] = []
        round_reports = []
        for round_index in range(rounds):
            current = {name: [] for name in aggregate}

            def once(sequence: int, *, record: bool) -> None:
                commands = commands_for(scenario, sequence + 1)
                source_tick = sequence + 1
                base = sequence * len(commands)
                before = time.perf_counter_ns()
                stream, cursor = encode_display_command_stream(
                    base_command_seq=base,
                    source_tick=source_tick,
                    commands=commands,
                )
                after_stream = time.perf_counter_ns()
                packet = encode_commit(
                    stream_id="display-benchmark",
                    commit_seq=source_tick,
                    source_tick=source_tick,
                    world_revision=source_tick,
                    last_command_seq=cursor,
                    cause="tick",
                    causation_id=None,
                    world_codec="benchmark-world@1",
                    world_patch=patch,
                    display_commands=stream,
                )
                after_wire = time.perf_counter_ns()
                if not record:
                    return
                stream_ms = (after_stream - before) / 1_000_000
                wire_ms = (after_wire - after_stream) / 1_000_000
                current["command_stream_encode_ms"].append(stream_ms)
                current["wire_commit_encode_ms"].append(wire_ms)
                current["publication_total_ms"].append(stream_ms + wire_ms)
                command_counts.append(float(len(commands)))
                stream_bytes.append(float(len(json.dumps(stream, separators=(",", ":")))))
                packet_bytes.append(float(len(packet)))

            for sequence in range(warmup):
                once(sequence, record=False)
            gc_enabled = gc.isenabled()
            gc.disable()
            try:
                for sequence in range(samples):
                    once(sequence, record=True)
            finally:
                if gc_enabled:
                    gc.enable()
            for name, values in current.items():
                aggregate[name].extend(values)
            round_reports.append(
                {
                    "round": round_index + 1,
                    **{name: summarize(values) for name, values in current.items()},
                }
            )
        scenario_reports[scenario] = {
            "rounds": round_reports,
            "aggregate": {name: summarize(values) for name, values in aggregate.items()},
            "command_count": summarize(command_counts),
            "stream_bytes": summarize(stream_bytes),
            "packet_bytes": summarize(packet_bytes),
        }

    report["memory"] = memory_probe(samples=min(samples, 60))
    report["performance_gates"] = performance_gates(
        scenario_reports, enforce_time_gates=enforce_time_gates
    )
    return report


def _write_report(path: Path, report: dict[str, object]) -> str:
    body = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _summary(report: dict[str, object], output: str, sha256: str) -> str:
    scenarios = report["scenarios"]
    assert isinstance(scenarios, dict)
    values = []
    for name in SCENARIOS:
        scenario = scenarios[name]
        assert isinstance(scenario, dict)
        aggregate = scenario["aggregate"]
        assert isinstance(aggregate, dict)
        total = aggregate["publication_total_ms"]
        assert isinstance(total, dict)
        values.append(
            f"{name}[p50={total['p50']},p95={total['p95']},p99={total['p99']},max={total['maximum']}]"
        )
    return (
        f"scene-engine-display-perf-500@2 nodes=500 {' '.join(values)} "
        f"output={output} sha256={sha256}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--warmup", type=int, default=60)
    parser.add_argument("--samples", type=int, default=600)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.quick and args.output is None:
        parser.error("formal benchmark runs require --output")
    try:
        report = run_benchmark(
            warmup=args.warmup,
            samples=args.samples,
            rounds=args.rounds,
            enforce_time_gates=not args.quick,
        )
    except ValueError as exc:
        parser.error(str(exc))
    if args.output is None:
        encoded = json.dumps(report, separators=(",", ":"), sort_keys=True).encode("utf-8")
        digest = hashlib.sha256(encoded).hexdigest()
        output = "-"
    else:
        digest = _write_report(args.output, report)
        output = str(args.output.resolve())
    print(_summary(report, output, digest))
    gates = report["performance_gates"]
    assert isinstance(gates, dict)
    if not gates["overall_passed"]:
        print("formal performance gates failed; report saved", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
