#!/usr/bin/env python3
"""Benchmark 632 frozen static nodes plus the 500-node frame hot path."""

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
import scene_engine.scene as scene_module  # noqa: E402
from scene_engine.scene import (  # noqa: E402
    AnimationState,
    SCENE_CODEC,
    SceneNode,
    VisualType,
    encode_scene_bootstrap,
    encode_scene_frame_against_bootstrap,
    parse_scene_bootstrap,
)
from scene_engine.wire import WIRE_SCHEMA, encode_commit  # noqa: E402


STATIC_NODE_COUNT = 632
STATIC_ROOT_COUNT = 8
STATIC_ID_BASE = 10_000_000
NODE_COUNT = 500
CHURN_NODE_COUNT = 25
SCENARIOS = ("steady", "motion", "churn-25")
FORMAL_MINIMUM_WARMUP = 60
FORMAL_MINIMUM_SAMPLES = 600
FORMAL_MINIMUM_ROUNDS = 5
STRUCTURED_P95_MAXIMUM_MS = 4.0
STRUCTURED_P99_MAXIMUM_MS = 6.0
PUBLICATION_P95_MAXIMUM_MS = 8.0
CHURN_OFFSETS = tuple(
    offset for offset in range(1, NODE_COUNT + 1) if offset % 10 != 0
)[:CHURN_NODE_COUNT]
CHURN_INDEX = {offset: index for index, offset in enumerate(CHURN_OFFSETS, 1)}


def static_nodes() -> tuple[SceneNode, ...]:
    records = []
    for offset in range(1, STATIC_NODE_COUNT + 1):
        parent_display_id = (
            0
            if offset <= STATIC_ROOT_COUNT
            else STATIC_ID_BASE + ((offset - STATIC_ROOT_COUNT - 1) % STATIC_ROOT_COUNT) + 1
        )
        records.append(
            SceneNode(
                display_id=STATIC_ID_BASE + offset,
                parent_display_id=parent_display_id,
                visual_type_id=1,
                flags=1,
                local_position=(float(offset), 0.0, 0.0),
                local_rotation_xyzw=(0.0, 0.0, 0.0, 1.0),
                local_scale=(1.0, 1.0, 1.0),
            )
        )
    return tuple(records)


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
    scenario_reports: dict[str, object],
    *,
    enforce_time_gates: bool,
) -> dict[str, object]:
    scenarios: dict[str, object] = {}
    observed_passed = True
    for scenario in SCENARIOS:
        scenario_report = scenario_reports[scenario]
        assert isinstance(scenario_report, dict)
        aggregate = scenario_report["aggregate"]
        assert isinstance(aggregate, dict)
        structured = aggregate["structured_validate_encode_ms"]
        publication = aggregate["publication_total_ms"]
        assert isinstance(structured, dict)
        assert isinstance(publication, dict)
        checks = {
            "structured_validate_encode_p95": {
                "actual_ms": structured["p95"],
                "maximum_ms": STRUCTURED_P95_MAXIMUM_MS,
                "passed": structured["p95"] <= STRUCTURED_P95_MAXIMUM_MS,
            },
            "structured_validate_encode_p99": {
                "actual_ms": structured["p99"],
                "maximum_ms": STRUCTURED_P99_MAXIMUM_MS,
                "passed": structured["p99"] <= STRUCTURED_P99_MAXIMUM_MS,
            },
            "publication_total_p95": {
                "actual_ms": publication["p95"],
                "maximum_ms": PUBLICATION_P95_MAXIMUM_MS,
                "passed": publication["p95"] <= PUBLICATION_P95_MAXIMUM_MS,
            },
        }
        scenario_passed = all(check["passed"] for check in checks.values())
        observed_passed = observed_passed and scenario_passed
        scenarios[scenario] = {
            "checks": checks,
            "observed_passed": scenario_passed,
        }
    return {
        "mode": "formal" if enforce_time_gates else "quick",
        "structural_gates_enforced": True,
        "structural_gates_passed": True,
        "time_gates_enforced": enforce_time_gates,
        "time_gates_observed_passed": observed_passed,
        "overall_passed": observed_passed if enforce_time_gates else True,
        "scenarios": scenarios,
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
            STATIC_ID_BASE + ((offset // 10 - 1) % STATIC_NODE_COUNT) + 1
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
                animation_state_id=1,
            )
        )
    return tuple(sorted(records, key=lambda item: item.display_id))


class IterationProbe:
    def __init__(self, values) -> None:
        self.values = values
        self.iterations = 0

    def __iter__(self):
        self.iterations += 1
        return iter(self.values)


class MappingProbe(IterationProbe):
    def __init__(self, values) -> None:
        super().__init__(values)
        self.lookups = 0

    def __len__(self) -> int:
        return len(self.values)

    def __contains__(self, key) -> bool:
        self.lookups += 1
        return key in self.values

    def __getitem__(self, key):
        self.lookups += 1
        return self.values[key]

    def get(self, key, default=None):
        self.lookups += 1
        return self.values.get(key, default)


class SetProbe(IterationProbe):
    def __init__(self, values) -> None:
        super().__init__(values)
        self.lookups = 0

    def __contains__(self, key) -> bool:
        self.lookups += 1
        return key in self.values


def structural_probe(*, bootstrap, nodes: tuple[SceneNode, ...]) -> dict[str, int]:
    """Instrument one frame without adding telemetry to production code."""

    original_values = {
        name: getattr(bootstrap, name)
        for name in (
            "static_nodes",
            "visual_types",
            "animation_states",
            "_visual_by_id",
            "_animation_ids",
            "_static_by_id",
            "_static_depth_by_id",
        )
    }
    static_source = IterationProbe(original_values["static_nodes"])
    visual_source = IterationProbe(original_values["visual_types"])
    animation_source = IterationProbe(original_values["animation_states"])
    visual_index = MappingProbe(original_values["_visual_by_id"])
    animation_index = SetProbe(original_values["_animation_ids"])
    static_index = MappingProbe(original_values["_static_by_id"])
    static_depth_index = MappingProbe(original_values["_static_depth_by_id"])
    probes = {
        "static_nodes": static_source,
        "visual_types": visual_source,
        "animation_states": animation_source,
        "_visual_by_id": visual_index,
        "_animation_ids": animation_index,
        "_static_by_id": static_index,
        "_static_depth_by_id": static_depth_index,
    }
    pose_compositions = 0
    original_compose_pose = scene_module._compose_pose

    def counted_compose_pose(*args, **kwargs):
        nonlocal pose_compositions
        pose_compositions += 1
        return original_compose_pose(*args, **kwargs)

    try:
        for name, probe in probes.items():
            object.__setattr__(bootstrap, name, probe)
        scene_module._compose_pose = counted_compose_pose
        encode_scene_frame_against_bootstrap(
            source_tick=1,
            nodes=nodes,
            bootstrap=bootstrap,
        )
    finally:
        scene_module._compose_pose = original_compose_pose
        for name, value in original_values.items():
            object.__setattr__(bootstrap, name, value)

    result = {
        "frames": 1,
        "static_node_iterations_per_frame": static_source.iterations,
        "static_pose_compositions_per_frame": pose_compositions,
        "static_registry_rebuilds_per_frame": (
            visual_source.iterations + animation_source.iterations
        ),
        "visual_registry_source_iterations_per_frame": visual_source.iterations,
        "animation_registry_source_iterations_per_frame": animation_source.iterations,
        "cached_index_iterations_per_frame": (
            visual_index.iterations
            + animation_index.iterations
            + static_index.iterations
            + static_depth_index.iterations
        ),
        "cached_index_lookups_per_frame": (
            visual_index.lookups
            + animation_index.lookups
            + static_index.lookups
            + static_depth_index.lookups
        ),
    }
    hard_gates = (
        "static_node_iterations_per_frame",
        "static_pose_compositions_per_frame",
        "static_registry_rebuilds_per_frame",
        "cached_index_iterations_per_frame",
    )
    if any(result[name] != 0 for name in hard_gates):
        raise RuntimeError(f"frame hot-path structural gate failed: {result}")
    if result["cached_index_lookups_per_frame"] == 0:
        raise RuntimeError("frame hot path did not use cached bootstrap indexes")
    return result


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


def git(*arguments: str) -> str | None:
    """Read optional worktree metadata without requiring Git in source packages."""

    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), *arguments],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def run_benchmark(
    *,
    warmup: int,
    samples: int,
    rounds: int,
    enforce_time_gates: bool,
) -> dict[str, object]:
    if warmup < 0 or samples <= 0 or rounds <= 0:
        raise ValueError(
            "warmup must be non-negative; samples and rounds must be positive"
        )
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
    bootstrap = parse_scene_bootstrap(
        encode_scene_bootstrap(
            maximum_dynamic_nodes=NODE_COUNT,
            maximum_frame_bytes=1024 * 1024,
            static_nodes=static_nodes(),
            visual_types=(VisualType(1),),
            animation_states=(AnimationState(1, 0, 60),),
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
            "benchmark_mode": "formal" if enforce_time_gates else "quick",
            "static_node_count": STATIC_NODE_COUNT,
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
            "Engine validate 500 dynamic SceneNode records against cached indexes "
            "from a 632-static-node bootstrap + single scene-frame encode -> "
            "wire encode_commit"
        ),
        "projection_cost_included": False,
        "bootstrap_bytes": len(bootstrap.data),
        "scenario_contracts": {
            "steady": "632 cached static + 500 unchanged dynamic node records",
            "motion": "632 cached static + 500 stable dynamic identities with changed local positions",
            "churn-25": "632 cached static + 25 of 500 dynamic leaf identities replaced per frame (5%)",
        },
        "structural_counts": {
            scenario: structural_probe(
                bootstrap=bootstrap,
                nodes=scenario_variants[0],
            )
            for scenario, scenario_variants in variants.items()
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
    report["performance_gates"] = performance_gates(
        scenario_reports,
        enforce_time_gates=enforce_time_gates,
    )
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
    if not args.quick and (
        warmup < FORMAL_MINIMUM_WARMUP
        or samples < FORMAL_MINIMUM_SAMPLES
        or rounds < FORMAL_MINIMUM_ROUNDS
    ):
        parser.error(
            "formal benchmark minimums are "
            f"warmup >= {FORMAL_MINIMUM_WARMUP}, "
            f"samples >= {FORMAL_MINIMUM_SAMPLES}, and "
            f"rounds >= {FORMAL_MINIMUM_ROUNDS}; received "
            f"warmup={warmup}, samples={samples}, rounds={rounds}"
        )
    report = run_benchmark(
        warmup=warmup,
        samples=samples,
        rounds=rounds,
        enforce_time_gates=not args.quick,
    )
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
        "scene-engine-perf-500@1 static=632 dynamic=500 "
        + " ".join(scenario_fields)
        + f" output={output_label} sha256={digest}"
    )
    gates = report["performance_gates"]
    assert isinstance(gates, dict)
    if gates["overall_passed"] is not True:
        print(
            f"formal performance gates failed; report saved to {output_label}",
            file=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
