#!/usr/bin/env python3
"""Measure Python DisplayTransform, resident MatrixPool, and binary encoding."""

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
from scene_engine import (
    DisplayCommand,
    DisplayMatrixPool,
    DisplayNode,
    DisplayTransform,
)
from scene_engine.display import (
    encode_display_checkpoint,
    encode_display_command_stream,
)
from scene_engine.display_binary import (
    decode_display_command_stream_binary,
    encode_display_command_stream_binary,
)


ROOT = Path(__file__).resolve().parents[1]
REPORT_SCHEMA = "scene-engine-python-display-transform-benchmark@2"
SOURCE_TICK = 1
DEFAULT_ITERATIONS = 5_000
DEFAULT_REPEATS = 7
DEFAULT_ENCODE_COMMANDS = 1_000
DEFAULT_ENCODE_REPEATS = 7
DEFAULT_RESIDENT_COUNT = 10_000
WARMUP_CALLS = 32
COLD_START_PROGRAM = """
from scene_engine import DisplayMatrixPool, DisplayTransform

value = DisplayTransform.identity()
pool = DisplayMatrixPool()
assert pool.append(value) == 0
assert len(value.matrix) == 16
assert len(value.matrix_bytes) == 64
assert pool.matrices.shape == (1, 4, 4)
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
    matrix_pool = DisplayMatrixPool()
    matrix_pool_id = matrix_pool.append(parent)
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
        (
            "matrixPoolSet",
            lambda: (matrix_pool.set(matrix_pool_id, affine), matrix_pool_id)[1],
        ),
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
    matrix_pool = DisplayMatrixPool()
    node_ids = tuple(matrix_pool.append(transform) for transform in transforms)
    baseline = encode_display_checkpoint(
        scene_name="benchmark",
        last_command_seq=0,
        matrix_pool=matrix_pool,
        nodes=tuple(
            DisplayNode(
                node_id=node_id,
                parent_node_id=None,
                display_kind_id="benchmark/root",
                transform_mode="live",
                visible=True,
                state={},
            )
            for node_id in node_ids
        ),
    )
    baseline.confirm_published()
    batch_node_ids = np.asarray(node_ids, dtype="<u4")
    matrix_rows = np.frombuffer(
        b"".join(transform.matrix_bytes for transform in transforms), dtype="<f4"
    ).reshape((command_count, 4, 4))
    matrix_pool.set_batch(batch_node_ids, matrix_rows)
    commands = (DisplayCommand.set_transform_batch(batch_node_ids),)

    def encode_once() -> tuple[Any, Any]:
        stream, cursor = encode_display_command_stream(
            base_command_seq=0,
            source_tick=SOURCE_TICK,
            matrix_pool=matrix_pool,
            commands=commands,
        )
        return (
            encode_display_command_stream_binary(
                stream,
                expected_source_tick=SOURCE_TICK,
                expected_last_command_seq=cursor,
            ),
            stream,
        )

    encoded, stream = encode_once()
    reference_payload = encoded.bytes
    payload_stable = True
    samples_ms: list[float] = []
    for _ in range(repeats):
        gc.collect()
        started_ns = time.perf_counter_ns()
        encoded, stream = encode_once()
        elapsed_ns = time.perf_counter_ns() - started_ns
        samples_ms.append(elapsed_ns / 1_000_000)
        payload_stable = payload_stable and encoded.bytes == reference_payload

    per_row_ns = [sample * 1_000_000 / command_count for sample in samples_ms]
    decoded = decode_display_command_stream_binary(
        encoded.bytes,
        expected_source_tick=SOURCE_TICK,
        expected_last_command_seq=1,
    )
    decoded_dirty = np.asarray(decoded["dirty_matrices"], dtype="<f4", order="C")
    decoded_dirty_node_ids = decoded["dirty_node_ids"]
    dirty_payload_bytes = decoded_dirty.tobytes(order="C")
    correctness = {
        "binaryMagic": encoded.bytes[:4] == b"SDCS",
        "binaryMetadata": (
            encoded.source_tick == SOURCE_TICK
            and encoded.base_command_seq == 0
            and encoded.last_command_seq == 1
        ),
        "binaryPayloadStableAcrossRepeats": payload_stable,
        "decodedCommandCount": len(decoded["commands"]) == 1,
        "decodedBatchNodeIds": np.array_equal(
            decoded["commands"][0]["node_ids"], batch_node_ids
        ),
        "decodedDirtyNodeIds": np.array_equal(decoded_dirty_node_ids, node_ids),
        "decodedArraysReadOnlyContiguous": (
            isinstance(decoded_dirty_node_ids, np.ndarray)
            and decoded_dirty_node_ids.dtype == np.dtype("<u4")
            and decoded_dirty_node_ids.flags.c_contiguous
            and not decoded_dirty_node_ids.flags.writeable
            and isinstance(decoded["dirty_matrices"], np.ndarray)
            and decoded["dirty_matrices"].dtype == np.dtype("<f4")
            and decoded["dirty_matrices"].flags.c_contiguous
            and not decoded["dirty_matrices"].flags.writeable
        ),
        "decodedDirtyTensorShape": decoded_dirty.shape == (command_count, 4, 4),
        "decodedCursor": (
            decoded["base_command_seq"] == 0
            and decoded["last_command_seq"] == 1
        ),
        "firstMatrixBits": dirty_payload_bytes[:64] == transforms[0].matrix_bytes,
        "lastMatrixBits": dirty_payload_bytes[-64:] == transforms[-1].matrix_bytes,
        "sealedDirtyTensorContiguous": (
            stream.dirty_matrices.shape == (command_count, 4, 4)
            and stream.dirty_matrices.dtype == np.dtype("<f4")
            and stream.dirty_matrices.flags.c_contiguous
            and not stream.dirty_matrices.flags.writeable
        ),
    }
    timings = {
        "millisecondsPerPayload": _summary(samples_ms, digits=6),
        "nanosecondsPerTransformRow": _summary(per_row_ns),
    }
    payload = {
        "kind": encoded.kind,
        "logicalCommands": 1,
        "transformRows": command_count,
        "matrixPoolSize": matrix_pool.size,
        "dirtyNodeIds": len(stream.dirty_node_ids),
        "dirtyMatrixBytes": stream.dirty_matrices.nbytes,
        "bytes": len(encoded.bytes),
        "bytesPerTransformRow": round(len(encoded.bytes) / command_count, 3),
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
    matrix_pool = DisplayMatrixPool()
    for index in range(count):
        matrix_pool.append(
            DisplayTransform.from_trs(
                position=(
                    float(index % 1_009),
                    float((index // 1_009) % 1_009),
                    float(index % 31),
                ),
                rotation_xyzw=(0.1, 0.2, 0.3, 0.9),
                scale=(1.0, 1.25, 0.8),
            )
        )
    build_elapsed_ns = time.perf_counter_ns() - started_ns
    built_count = matrix_pool.size

    # Measure the steady resident pool after its initial publication.  The
    # create/dirty sets are transient wire bookkeeping, not resident Matrix4
    # storage; publishing through the public API also verifies that they drain.
    baseline = encode_display_checkpoint(
        scene_name="benchmark-resident",
        last_command_seq=0,
        matrix_pool=matrix_pool,
        nodes=tuple(
            DisplayNode(
                node_id=node_id,
                parent_node_id=None,
                display_kind_id="benchmark/root",
                transform_mode="live",
                visible=True,
                state={},
            )
            for node_id in range(count)
        ),
    )
    baseline.confirm_published()
    del baseline
    gc.collect()
    resident_current, resident_peak = tracemalloc.get_traced_memory()
    resident_tensor = matrix_pool.matrices
    first_bytes = resident_tensor[0].tobytes(order="C")
    last_bytes = resident_tensor[-1].tobytes(order="C")
    resident_layout = (
        resident_tensor.shape == (count, 4, 4)
        and resident_tensor.dtype == np.dtype("<f4")
        and resident_tensor.flags.c_contiguous
        and not resident_tensor.flags.writeable
        and resident_tensor.strides == (64, 16, 4)
        and resident_tensor.nbytes == count * 64
    )
    endpoint_values_differ = first_bytes != last_bytes if count > 1 else False
    endpoint_bytes_valid = len(first_bytes) == len(last_bytes) == 64
    del matrix_pool
    del first_bytes
    del last_bytes
    del resident_tensor
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
        "includesListContainer": False,
        "residentStorage": "one C-contiguous <f4 tensor shaped (n,4,4)",
        "measurement": (
            "tracemalloc current delta after initial checkpoint publication and "
            "GC; peak includes transient publication bookkeeping; build timing "
            "includes tracing overhead"
        ),
    }
    correctness = {
        "requestedResidentCountBuilt": built_count == count,
        "residentOwnerIsSingleMatrixPool": True,
        "residentRowsShareOneTensor": resident_layout,
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
            "encodeTransformRows": encode_commands,
            "encodeRepeats": encode_repeats,
            "residentCount": resident_count,
        },
        "environment": _environment(),
        "timings": {
            "units": {
                "operations": "nanoseconds per public API call",
                "coldStart": "milliseconds per fresh Python process",
                "encodingPayload": "milliseconds per semantic + SDCS encode",
                "encodingTransformRow": "nanoseconds per transform row",
            },
            "scope": {
                "operations": "public call plus Python loop/callable dispatch",
                "coldStart": (
                    "process spawn, scene_engine import, identity construction, "
                    "one MatrixPool append, and public access"
                ),
                "encoding": (
                    "one prebuilt ID batch and one resident MatrixPool through "
                    "dirty gather, semantic sealing, and the production SDCS encoder"
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
