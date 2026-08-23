#!/usr/bin/env python3
"""Benchmark the frozen 0.6 structured scene publication path at 500 nodes."""

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
except ImportError:  # pragma: no cover - resource is unavailable on Windows.
    resource = None  # type: ignore[assignment]


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import scene_engine  # noqa: E402
from scene_engine.scene import (  # noqa: E402
    SCENE_CODEC,
    SceneNode,
    VisualType,
    encode_scene_bootstrap,
    encode_scene_frame_against_bootstrap,
    parse_scene_bootstrap,
)
from scene_engine.wire import WIRE_SCHEMA, encode_commit  # noqa: E402


NODE_COUNT = 500
CHURN_NODE_COUNT = 25
SCENARIOS = ("steady", "motion", "churn-25")
CHURN_OFFSETS = tuple(
    offset for offset in range(1, NODE_COUNT + 1) if offset % 10 != 0
)[:CHURN_NODE_COUNT]
CHURN_INDEX = {offset: index for index, offset in enumerate(CHURN_OFFSETS, 1)}


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


def nodes_for(scenario: str, variant: int) -> tuple[SceneNode, ...]:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario: {scenario}")
    motion = variant / 1_000 if scenario == "motion" else 0.0
    records = []
    for offset in range(1, NODE_COUNT + 1):
        if scenario == "churn-25" and offset in CHURN_INDEX:
            display_id = 1_000_000 + variant * 1_000 + CHURN_INDEX[offset]
        else:
            display_id = offset
        group_offset = offset % 10
        parent_display_id = (
            0
            if group_offset == 0
            else ((offset - 1) // 10 + 1) * 10
        )
        records.append(
            SceneNode(
                display_id=display_id,
                parent_display_id=parent_display_id,
                visual_type_id=1,
                flags=1,
                local_position=(
                    float(group_offset) + motion,
                    float(offset),
                    0.0,
                ),
                local_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
                local_scale=(1.0, 1.0, 1.0),
            )
        )
    return tuple(sorted(records, key=lambda item: item.display_id))


def physical_memory_bytes() -> int | None:
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        return None


def hardware_value(key: str) -> str | None:
    if sys.platform != "darwin":
        return None
    try:
        return subprocess.check_output(
            ["sysctl", "-n", key], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def maximum_rss_bytes() -> int | None:
    if resource is None:
        return None
    value = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return value if sys.platform == "darwin" else value * 1024


def memory_probe(
    *,
    scenario_variants: tuple[tuple[SceneNode, ...], ...],
    bootstrap,
    patch: dict[str, object],
    samples: int,
) -> dict[str, int | None]:
    gc.collect()
    rss_before = maximum_rss_bytes()
    tracemalloc.start()
    traced_before, _ = tracemalloc.get_traced_memory()
    for sequence in range(samples):
        source_tick = sequence + 1
        frame = encode_scene_frame_against_bootstrap(
            source_tick=source_tick,
            nodes=scenario_variants[sequence % len(scenario_variants)],
            bootstrap=bootstrap,
        )
        packet = encode_commit(
            stream_id="w0-structured-500-nodes-memory",
            commit_seq=source_tick,
            source_tick=source_tick,
            world_revision=source_tick,
            cause="tick",
            causation_id=None,
            world_codec="w0-benchmark-world@1",
            world_patch=patch,
            scene_frame=frame,
        )
    del frame, packet
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


def git(*arguments: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(ROOT), *arguments], text=True
    ).strip()


def run_benchmark(
    *, warmup: int, samples: int, rounds: int
) -> dict[str, object]:
    if warmup < 0 or samples <= 0 or rounds <= 0:
        raise ValueError(
            "warmup must be non-negative; samples and rounds must be positive"
        )
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=NODE_COUNT,
            maximum_frame_bytes=1024 * 1024,
            visual_types=(VisualType(1),),
        )
    )
    variants = {
        "steady": (nodes_for("steady", 0),),
        "motion": tuple(nodes_for("motion", value) for value in range(1, 61)),
        "churn-25": tuple(
            nodes_for("churn-25", value) for value in range(1, 61)
        ),
    }
    if any(
        len(records) != NODE_COUNT
        for values in variants.values()
        for records in values
    ):
        raise RuntimeError("every benchmark frame must contain exactly 500 nodes")
    previous_ids = {item.display_id for item in nodes_for("steady", 0)}
    for records in variants["churn-25"]:
        current_ids = {item.display_id for item in records}
        if (
            len(previous_ids - current_ids) != CHURN_NODE_COUNT
            or len(current_ids - previous_ids) != CHURN_NODE_COUNT
        ):
            raise RuntimeError("churn-25 must replace exactly 25 node identities")
        previous_ids = current_ids
    patch = {
        "schema": "scene-engine-json-tree@1",
        "changes": [{"op": "set", "path": ["tick"], "value": 1}],
    }
    report: dict[str, object] = {
        "schema": "scene-engine-perf-500@1",
        "repository": str(ROOT),
        "git": {
            "head": git("rev-parse", "HEAD"),
            "status_porcelain": git("status", "--porcelain"),
        },
        "runtime": {
            "scene_engine_version": scene_engine.__version__,
            "scene_codec": SCENE_CODEC,
            "wire_schema": WIRE_SCHEMA,
            "python": sys.version,
            "python_implementation": platform.python_implementation(),
            "executable": sys.executable,
            "timer": "time.perf_counter_ns",
            "garbage_collection_during_latency_samples": False,
        },
        "hardware": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_brand": hardware_value("machdep.cpu.brand_string"),
            "hardware_model": hardware_value("hw.model"),
            "logical_cpu_count": os.cpu_count(),
            "physical_memory_bytes": physical_memory_bytes(),
        },
        "parameters": {
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
            "Engine validate structured SceneNode records against cached bootstrap + "
            "single scene-frame encode -> wire encode_commit"
        ),
        "projection_cost_included": False,
        "scenario_contracts": {
            "steady": "500 unchanged structured node records",
            "motion": "500 stable identities with changed local positions",
            "churn-25": "25 of 500 leaf identities replaced per frame (5%)",
        },
        "scenarios": {},
    }

    scenario_reports = report["scenarios"]
    assert isinstance(scenario_reports, dict)
    for scenario, scenario_variants in variants.items():
        round_reports = []
        aggregate: dict[str, list[float]] = {
            "structured_validate_encode_ms": [],
            "wire_commit_encode_ms": [],
            "publication_total_ms": [],
        }
        frame_bytes: list[float] = []
        packet_bytes: list[float] = []
        for round_index in range(rounds):
            current = {name: [] for name in aggregate}

            def once(sequence: int, *, record: bool) -> None:
                records = scenario_variants[sequence % len(scenario_variants)]
                source_tick = sequence + 1
                before = time.perf_counter_ns()
                frame = encode_scene_frame_against_bootstrap(
                    source_tick=source_tick,
                    nodes=records,
                    bootstrap=bootstrap,
                )
                after_frame = time.perf_counter_ns()
                packet = encode_commit(
                    stream_id="w0-structured-500-nodes",
                    commit_seq=source_tick,
                    source_tick=source_tick,
                    world_revision=source_tick,
                    cause="tick",
                    causation_id=None,
                    world_codec="w0-benchmark-world@1",
                    world_patch=patch,
                    scene_frame=frame,
                )
                after_wire = time.perf_counter_ns()
                if not record:
                    return
                frame_ms = (after_frame - before) / 1_000_000
                wire_ms = (after_wire - after_frame) / 1_000_000
                current["structured_validate_encode_ms"].append(frame_ms)
                current["wire_commit_encode_ms"].append(wire_ms)
                current["publication_total_ms"].append(frame_ms + wire_ms)
                frame_bytes.append(float(len(frame)))
                packet_bytes.append(float(len(packet)))

            previous_gc = gc.isenabled()
            gc.disable()
            try:
                for sequence in range(warmup):
                    once(sequence + round_index * warmup, record=False)
                for sequence in range(samples):
                    once(sequence + round_index * samples, record=True)
            finally:
                if previous_gc:
                    gc.enable()
                gc.collect()
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
            "aggregate": {
                name: summarize(values) for name, values in aggregate.items()
            },
            "frame_bytes": summarize(frame_bytes),
            "packet_bytes": summarize(packet_bytes),
            "memory": memory_probe(
                scenario_variants=scenario_variants,
                bootstrap=bootstrap,
                patch=patch,
                samples=min(samples, 60),
            ),
        }
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    parser.add_argument("--warmup", type=int)
    parser.add_argument("--samples", type=int)
    parser.add_argument("--rounds", type=int)
    parser.add_argument(
        "--quick",
        action="store_true",
        help="default to 5 warmups, 30 samples, and one round",
    )
    args = parser.parse_args()
    if not args.quick and args.output is None:
        parser.error("formal benchmark runs require --output")
    warmup = args.warmup if args.warmup is not None else (5 if args.quick else 60)
    samples = args.samples if args.samples is not None else (30 if args.quick else 600)
    rounds = args.rounds if args.rounds is not None else (1 if args.quick else 5)
    report = run_benchmark(warmup=warmup, samples=samples, rounds=rounds)
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    scenario_fields = []
    scenarios = report["scenarios"]
    assert isinstance(scenarios, dict)
    for scenario in SCENARIOS:
        scenario_report = scenarios[scenario]
        assert isinstance(scenario_report, dict)
        aggregate = scenario_report["aggregate"]
        assert isinstance(aggregate, dict)
        total = aggregate["publication_total_ms"]
        assert isinstance(total, dict)
        scenario_fields.append(
            "{}[p50={:.6f},p95={:.6f},p99={:.6f},max={:.6f}]ms".format(
                scenario,
                total["p50"],
                total["p95"],
                total["p99"],
                total["maximum"],
            )
        )
    output_label = "-" if args.output is None else str(args.output.resolve())
    print(
        "scene-engine-perf-500@1 nodes=500 "
        + " ".join(scenario_fields)
        + f" output={output_label} sha256={digest}"
    )


if __name__ == "__main__":
    main()
