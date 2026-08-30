#!/usr/bin/env python3
"""Measure the public Python DisplayTransform and production binary encoder path."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import tracemalloc
from collections.abc import Callable, Sequence
from typing import Any

import numpy as np

import scene_engine
from scene_engine import DisplayCommand, DisplayTransform
from scene_engine.display import encode_display_command_stream
from scene_engine.display_binary import (
    decode_display_command_stream_binary,
    encode_display_command_stream_binary,
)


ROOT = Path(__file__).resolve().parents[1]
REPORT_SCHEMA = "scene-engine-python-display-transform-benchmark@1"
SOURCE_TICK = 1
DEFAULT_ITERATIONS = 5_000
DEFAULT_REPEATS = 7
DEFAULT_ENCODE_COMMANDS = 1_000
DEFAULT_ENCODE_REPEATS = 7
DEFAULT_RESIDENT_COUNT = 10_000
WARMUP_CALLS = 32
COLD_START_PROGRAM = """
from scene_engine import DisplayTransform

value = DisplayTransform.identity()
assert len(value.matrix) == 16
assert len(value.matrix_bytes) == 64
"""


def _percentile(sorted_values: Sequence[float], quantile: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(
        0,
        min(len(sorted_values) - 1, math.ceil(len(sorted_values) * quantile) - 1),
    )
    return float(sorted_values[index])


def _summary(values: Sequence[float], *, digits: int = 3) -> dict[str, Any]:
    samples = sorted(float(value) for value in values)
    return {
        "samples": len(samples),
        "best": round(samples[0], digits),
        "p50": round(_percentile(samples, 0.50), digits),
        "p95": round(_percentile(samples, 0.95), digits),
    }


def _measure_calls(
    operation: Callable[[], Any], *, iterations: int, repeats: int
) -> dict[str, Any]:
    sink: Any = None
    for _ in range(min(WARMUP_CALLS, iterations)):
        sink = operation()

    samples: list[float] = []
    for _ in range(repeats):
        gc.collect()
        started_ns = time.perf_counter_ns()
        for _ordinal in range(iterations):
            sink = operation()
        elapsed_ns = time.perf_counter_ns() - started_ns
        samples.append(elapsed_ns / iterations)

    if sink is None:
        raise RuntimeError("operation produced no benchmark result")
    return _summary(samples)


def _operation_benchmarks(
    *, iterations: int, repeats: int
) -> tuple[dict[str, Any], dict[str, DisplayTransform]]:
    parent = DisplayTransform.from_trs(
        position=(10.0, -3.0, 5.0),
        rotation_xyzw=(0.15, -0.2, 0.3, 0.9),
        scale=(1.25, 0.75, 1.5),
    )
    local = DisplayTransform.from_trs(
        position=(-2.0, 4.0, 0.5),
        rotation_xyzw=(-0.25, 0.1, 0.05, 0.95),
        scale=(0.8, 1.1, 1.4),
    )
    affine = parent.composed(local)
    point = (1.25, -2.5, 0.75)
    vector = (-0.5, 1.75, 3.0)

    operations: tuple[tuple[str, Callable[[], Any]], ...] = (
        ("loopBaseline", lambda: parent),
        ("identity", DisplayTransform.identity),
        (
            "fromTrs",
            lambda: DisplayTransform.from_trs(
                position=(1.0, 2.0, 3.0),
                rotation_xyzw=(0.1, 0.2, 0.3, 0.9),
                scale=(1.25, 0.75, 2.0),
            ),
        ),
        ("composed", lambda: parent.composed(local)),
        ("withTranslation", lambda: affine.with_translation((4.0, -2.0, 7.0))),
        ("translatedSelf", lambda: affine.translated_self((0.5, -1.0, 2.0))),
        ("translatedParent", lambda: affine.translated_parent((0.5, -1.0, 2.0))),
        ("rotatedSelf", lambda: affine.rotated_self((0.25, 1.0, -0.5), 0.35)),
        ("rotatedParent", lambda: affine.rotated_parent((0.25, 1.0, -0.5), 0.35)),
        ("withScale", lambda: affine.with_scale((1.5, 0.8, 2.25))),
        ("scaledSelf", lambda: affine.scaled_self((1.5, 0.8, 2.25))),
        ("scaledParent", lambda: affine.scaled_parent((1.5, 0.8, 2.25))),
        ("transformPoint", lambda: affine.transform_point(point)),
        ("transformVector", lambda: affine.transform_vector(vector)),
        ("inverseTransformPoint", lambda: affine.inverse_transform_point(point)),
        ("inverseTransformVector", lambda: affine.inverse_transform_vector(vector)),
        ("matrix", lambda: affine.matrix),
        ("matrixBytes", lambda: affine.matrix_bytes),
    )

    timings = {
        name: _measure_calls(operation, iterations=iterations, repeats=repeats)
        for name, operation in operations
    }
    fixtures = {"parent": parent, "local": local, "affine": affine}
    return timings, fixtures


def _cold_start_benchmark(*, repeats: int) -> dict[str, Any]:
    samples_ms: list[float] = []
    for _ in range(repeats):
        started_ns = time.perf_counter_ns()
        completed = subprocess.run(
            [sys.executable, "-c", COLD_START_PROGRAM],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        elapsed_ns = time.perf_counter_ns() - started_ns
        if completed.returncode != 0:
            stderr = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"cold-start child exited with {completed.returncode}: {stderr}"
            )
        if completed.stdout:
            raise RuntimeError("cold-start child unexpectedly wrote to stdout")
        samples_ms.append(elapsed_ns / 1_000_000)
    return _summary(samples_ms, digits=6)


def _encoding_benchmark(
    *, command_count: int, repeats: int
) -> tuple[dict[str, Any], dict[str, Any], dict[str, bool]]:
    transforms = tuple(
        DisplayTransform.from_trs(
            position=(
                float(index % 257),
                float((index // 257) % 257),
                float(index % 17),
            ),
            rotation_xyzw=(0.1, 0.2, 0.3, 0.9),
            scale=(1.0 + (index % 5) * 0.05, 0.75, 1.25),
        )
        for index in range(command_count)
    )
    commands = tuple(
        DisplayCommand.set_transform(f"py/benchmark-{index:06d}", transform)
        for index, transform in enumerate(transforms)
    )

    def encode_once() -> Any:
        stream, cursor = encode_display_command_stream(
            base_command_seq=0,
            source_tick=SOURCE_TICK,
            commands=commands,
        )
        return encode_display_command_stream_binary(
            stream,
            expected_source_tick=SOURCE_TICK,
            expected_last_command_seq=cursor,
        )

    encoded = encode_once()
    reference_payload = encoded.bytes
    payload_stable = True
    samples_ms: list[float] = []
    for _ in range(repeats):
        gc.collect()
        started_ns = time.perf_counter_ns()
        encoded = encode_once()
        elapsed_ns = time.perf_counter_ns() - started_ns
        samples_ms.append(elapsed_ns / 1_000_000)
        payload_stable = payload_stable and encoded.bytes == reference_payload

    per_command_ns = [sample * 1_000_000 / command_count for sample in samples_ms]
    decoded = decode_display_command_stream_binary(
        encoded.bytes,
        expected_source_tick=SOURCE_TICK,
        expected_last_command_seq=command_count,
    )
    first_decoded = DisplayTransform.from_matrix(
        decoded["commands"][0]["transform"]
    )
    last_decoded = DisplayTransform.from_matrix(
        decoded["commands"][-1]["transform"]
    )
    correctness = {
        "binaryMagic": encoded.bytes[:4] == b"SDCS",
        "binaryMetadata": (
            encoded.source_tick == SOURCE_TICK
            and encoded.base_command_seq == 0
            and encoded.last_command_seq == command_count
        ),
        "binaryPayloadStableAcrossRepeats": payload_stable,
        "decodedCommandCount": len(decoded["commands"]) == command_count,
        "decodedCursor": (
            decoded["base_command_seq"] == 0
            and decoded["last_command_seq"] == command_count
        ),
        "firstMatrixBits": first_decoded.matrix_bytes == transforms[0].matrix_bytes,
        "lastMatrixBits": last_decoded.matrix_bytes == transforms[-1].matrix_bytes,
        "lastResidentBufferAtPayloadTail": encoded.bytes.endswith(
            transforms[-1].matrix_bytes
        ),
    }
    timings = {
        "millisecondsPerPayload": _summary(samples_ms, digits=6),
        "nanosecondsPerCommand": _summary(per_command_ns),
    }
    payload = {
        "kind": encoded.kind,
        "commands": command_count,
        "bytes": len(encoded.bytes),
        "bytesPerCommand": round(len(encoded.bytes) / command_count, 3),
        "baseCommandSeq": encoded.base_command_seq,
        "lastCommandSeq": encoded.last_command_seq,
        "sourceTick": encoded.source_tick,
        "sha256": hashlib.sha256(encoded.bytes).hexdigest(),
    }
    return timings, payload, correctness


def _resident_memory(*, count: int) -> tuple[dict[str, Any], dict[str, bool]]:
    DisplayTransform.from_trs(position=(0.0, 0.0, 0.0))
    gc.collect()
    tracemalloc.start()
    baseline_current, _ = tracemalloc.get_traced_memory()
    tracemalloc.reset_peak()
    started_ns = time.perf_counter_ns()
    residents = [
        DisplayTransform.from_trs(
            position=(
                float(index % 1_009),
                float((index // 1_009) % 1_009),
                float(index % 31),
            ),
            rotation_xyzw=(0.1, 0.2, 0.3, 0.9),
            scale=(1.0, 1.25, 0.8),
        )
        for index in range(count)
    ]
    build_elapsed_ns = time.perf_counter_ns() - started_ns
    resident_current, resident_peak = tracemalloc.get_traced_memory()
    built_count = len(residents)
    first_bytes = residents[0].matrix_bytes
    last_bytes = residents[-1].matrix_bytes
    distinct_owners = residents[0] is not residents[-1] if count > 1 else True
    distinct_buffers = (
        not np.shares_memory(residents[0]._matrix, residents[-1]._matrix)
        if count > 1
        else residents[0]._matrix.flags.owndata
    )
    first_matrix = residents[0]._matrix
    resident_layout = (
        first_matrix.shape == (4, 4)
        and first_matrix.dtype == np.dtype("<f4")
        and first_matrix.flags.f_contiguous
        and first_matrix.flags.owndata
        and not first_matrix.flags.writeable
        and first_matrix.base is None
    )
    endpoint_values_differ = first_bytes != last_bytes if count > 1 else False
    endpoint_bytes_valid = len(first_bytes) == len(last_bytes) == 64
    del residents
    del first_bytes
    del last_bytes
    del first_matrix
    gc.collect()
    released_current, _ = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    current_delta = resident_current - baseline_current
    peak_delta = resident_peak - baseline_current
    released_delta = released_current - baseline_current
    memory = {
        "residentCount": count,
        "matrixPayloadBytes": count * 64,
        "tracedCurrentDeltaBytes": current_delta,
        "tracedPeakDeltaBytes": peak_delta,
        "tracedBytesPerResident": round(current_delta / count, 3),
        "tracedDeltaAfterReleaseBytes": released_delta,
        "buildMilliseconds": round(build_elapsed_ns / 1_000_000, 6),
        "endpointValuesDiffer": endpoint_values_differ,
        "includesListContainer": True,
        "measurement": (
            "tracemalloc current/peak deltas after a GC'd warm-process baseline; "
            "build timing includes tracing overhead"
        ),
    }
    correctness = {
        "requestedResidentCountBuilt": built_count == count,
        "residentOwnersDistinct": distinct_owners,
        "residentBuffersDistinct": distinct_buffers,
        "residentMatrixLayout": resident_layout,
        "residentMatrixBytesLength": endpoint_bytes_valid,
    }
    return memory, correctness


def _close_vector(
    left: Sequence[float], right: Sequence[float], *, tolerance: float = 2e-5
) -> bool:
    return len(left) == len(right) and all(
        math.isclose(float(a), float(b), rel_tol=tolerance, abs_tol=tolerance)
        for a, b in zip(left, right)
    )


def _transform_correctness(
    fixtures: dict[str, DisplayTransform]
) -> dict[str, bool]:
    parent = fixtures["parent"]
    local = fixtures["local"]
    affine = fixtures["affine"]
    point = (1.25, -2.5, 0.75)
    vector = (-0.5, 1.75, 3.0)
    affine_bits = affine.matrix_bytes
    expected_composed_point = parent.transform_point(local.transform_point(point))
    point_round_trip = affine.inverse_transform_point(affine.transform_point(point))
    vector_round_trip = affine.inverse_transform_vector(
        affine.transform_vector(vector)
    )

    affine.translated_self((0.5, -1.0, 2.0))
    affine.rotated_parent((0.25, 1.0, -0.5), 0.35)
    affine.scaled_self((1.5, 0.8, 2.25))

    return {
        "identity": DisplayTransform.identity().matrix
        == (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0),
        "publicMatrixTuple": (
            isinstance(affine.matrix, tuple) and len(affine.matrix) == 16
        ),
        "publicMatrixBytes": (
            isinstance(affine.matrix_bytes, bytes)
            and len(affine.matrix_bytes) == 64
        ),
        "matrixBytesStable": affine.matrix_bytes == affine.matrix_bytes,
        "sourceImmutable": affine.matrix_bytes == affine_bits,
        "compositionOrder": _close_vector(
            affine.transform_point(point), expected_composed_point
        ),
        "pointInverseRoundTrip": _close_vector(point_round_trip, point),
        "vectorInverseRoundTrip": _close_vector(vector_round_trip, vector),
    }


def _environment() -> dict[str, Any]:
    clock = time.get_clock_info("perf_counter")
    thread_variables = {
        name: os.environ[name]
        for name in (
            "OMP_NUM_THREADS",
            "OPENBLAS_NUM_THREADS",
            "MKL_NUM_THREADS",
            "VECLIB_MAXIMUM_THREADS",
            "NUMEXPR_NUM_THREADS",
        )
        if name in os.environ
    }
    return {
        "pythonVersion": platform.python_version(),
        "pythonImplementation": platform.python_implementation(),
        "sceneEngineVersion": scene_engine.__version__,
        "numpyVersion": np.__version__,
        "numpyFloat32Dtype": np.dtype("<f4").str,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpuCount": os.cpu_count(),
        "executable": sys.executable,
        "byteOrder": sys.byteorder,
        "perfCounter": {
            "implementation": clock.implementation,
            "resolutionNanoseconds": round(clock.resolution * 1_000_000_000, 3),
        },
        "threadEnvironment": thread_variables,
    }


def _positive_integer(value: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def run_benchmark(
    *,
    iterations: int,
    repeats: int,
    encode_commands: int,
    encode_repeats: int,
    resident_count: int,
) -> dict[str, Any]:
    iterations = _positive_integer(iterations, "iterations")
    repeats = _positive_integer(repeats, "repeats")
    encode_commands = _positive_integer(encode_commands, "encode_commands")
    encode_repeats = _positive_integer(encode_repeats, "encode_repeats")
    resident_count = _positive_integer(resident_count, "resident_count")

    cold_start = _cold_start_benchmark(repeats=repeats)
    operation_timings, fixtures = _operation_benchmarks(
        iterations=iterations,
        repeats=repeats,
    )
    encoding_timings, payload, encoding_correctness = _encoding_benchmark(
        command_count=encode_commands,
        repeats=encode_repeats,
    )
    resident_memory, resident_correctness = _resident_memory(count=resident_count)
    correctness = {
        **_transform_correctness(fixtures),
        **encoding_correctness,
        **resident_correctness,
    }
    passed = all(correctness.values())
    return {
        "schema": REPORT_SCHEMA,
        "status": "PASS" if passed else "FAIL",
        "parameters": {
            "iterations": iterations,
            "repeats": repeats,
            "encodeCommands": encode_commands,
            "encodeRepeats": encode_repeats,
            "residentCount": resident_count,
        },
        "environment": _environment(),
        "timings": {
            "units": {
                "operations": "nanoseconds per public API call",
                "coldStart": "milliseconds per fresh Python process",
                "encodingPayload": "milliseconds per semantic + SDCS encode",
                "encodingCommand": "nanoseconds per encoded command",
            },
            "scope": {
                "operations": "public call plus Python loop/callable dispatch",
                "coldStart": (
                    "process spawn, scene_engine import, identity construction, "
                    "and public access"
                ),
                "encoding": (
                    "prebuilt commands and resident transforms through semantic "
                    "stream sealing and the production binary encoder"
                ),
            },
            "coldStart": cold_start,
            "operations": operation_timings,
            "encoding": encoding_timings,
        },
        "payload": payload,
        "memory": resident_memory,
        "correctness": {**correctness, "allPassed": passed},
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    parser.add_argument("--repeats", type=int, default=DEFAULT_REPEATS)
    parser.add_argument(
        "--encode-commands", type=int, default=DEFAULT_ENCODE_COMMANDS
    )
    parser.add_argument(
        "--encode-repeats", type=int, default=DEFAULT_ENCODE_REPEATS
    )
    parser.add_argument(
        "--resident-count", type=int, default=DEFAULT_RESIDENT_COUNT
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = parse_args(argv)
    try:
        report = run_benchmark(
            iterations=arguments.iterations,
            repeats=arguments.repeats,
            encode_commands=arguments.encode_commands,
            encode_repeats=arguments.encode_repeats,
            resident_count=arguments.resident_count,
        )
    except Exception as error:
        report = {
            "schema": REPORT_SCHEMA,
            "status": "ERROR",
            "error": {"type": type(error).__name__, "message": str(error)},
        }
    sys.stdout.write(f"{json.dumps(report, indent=2, sort_keys=True)}\n")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
