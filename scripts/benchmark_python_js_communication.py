#!/usr/bin/env python3
"""Measure the exact Python Runtime -> JavaScript Client -> ACK communication path."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import select
import shutil
import struct
import subprocess
import sys
import time
from typing import Any, Iterable

from scene_engine import (
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayNode,
    DisplayTransform,
    ManualClock,
    MutationResult,
    ProductCheckpoint,
    ProductCommit,
    RuntimeConfig,
    SceneEngineRuntime,
    TICKS_PER_SECOND,
    WorldCounters,
)
from scene_engine.wire import PacketKind, encode_ack, read_engine_packet


ROOT = Path(__file__).resolve().parents[1]
CATALOG_SCRIPT = ROOT / "scripts" / "support" / "communication_catalog.mjs"
PEER_SCRIPT = ROOT / "scripts" / "support" / "python_js_communication_peer.mjs"
SCENE_NAME = "communication"
PREFAB_ID = "communication/root"
WORLD_CODEC = "communication-world@1"
CLIENT_ID = "python-js-communication"
FRAME_HEADER = struct.Struct("<I")
MATRIX4_F32 = struct.Struct("<16f")
FLOAT32 = struct.Struct("<f")
TRANSLATION_X_OFFSET = 12 * FLOAT32.size
MAXIMUM_FRAME_BYTES = 64 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 30.0
PROFILE_ROUNDTRIP = "roundtrip"
PROFILE_WINDOWED = "windowed"
PROFILES = (PROFILE_ROUNDTRIP, PROFILE_WINDOWED)
REPORT_SCHEMA = "scene-engine-python-js-communication@2"
PEER_REPORT_SCHEMA = "scene-engine-python-js-communication-peer@2"
TRANSFORM_DIGEST_ENCODING = "node-name-nul-le-f32-matrix16-nul"


@dataclass
class CommunicationWorld:
    roots: int
    source_tick: int = 0
    world_revision: int = 0
    total_updates: int = 0

    def __post_init__(self) -> None:
        self.transforms = [
            display_transform(initial_position(index)) for index in range(self.roots)
        ]
        self.position_checksum = 0


class CommunicationProgram:
    def __init__(
        self,
        *,
        roots: int,
        updates_per_commit: int,
        catalog: DisplayCatalogIdentity,
    ) -> None:
        self.roots = roots
        self.updates_per_commit = updates_per_commit
        self.catalog = catalog

    def read_counters(self, world: CommunicationWorld) -> WorldCounters:
        return WorldCounters(world.source_tick, world.world_revision)

    def write_counters(
        self, world: CommunicationWorld, counters: WorldCounters
    ) -> None:
        world.source_tick = counters.source_tick
        world.world_revision = counters.world_revision

    def step(self, world: CommunicationWorld, context: Any) -> MutationResult:
        start = ((context.commit.source_tick - 1) * self.updates_per_commit) % self.roots
        indices = tuple(
            (start + ordinal) % self.roots
            for ordinal in range(self.updates_per_commit)
        )
        for index in indices:
            old_x = int(
                FLOAT32.unpack_from(
                    world.transforms[index].matrix_bytes,
                    TRANSLATION_X_OFFSET,
                )[0]
            )
            position = updated_position(index, context.commit.source_tick)
            world.transforms[index] = display_transform(position)
            world.position_checksum += int(position[0]) - old_x
        world.total_updates += len(indices)
        return MutationResult.changed(indices)

    def handle_input(self, world: CommunicationWorld, request: Any, context: Any) -> MutationResult:
        return MutationResult.rejected("communication-input-disabled")

    def build_checkpoint(
        self, world: CommunicationWorld, context: Any
    ) -> ProductCheckpoint:
        return ProductCheckpoint(
            WORLD_CODEC,
            world_snapshot(world),
            SCENE_NAME,
            self.catalog,
            tuple(
                DisplayNode(
                    name=root_name(index),
                    parent_name=None,
                    prefab_id=PREFAB_ID,
                    transform_mode="live",
                    transform=world.transforms[index],
                    visible=True,
                    state={"index": index},
                )
                for index in range(self.roots)
            ),
        )

    def build_commit(
        self, world: CommunicationWorld, mutation: MutationResult, context: Any
    ) -> ProductCommit:
        indices = tuple(mutation.commit_context)
        return ProductCommit(
            WORLD_CODEC,
            {
                "schema": "scene-engine-json-tree@1",
                "changes": [
                    {
                        "op": "set",
                        "path": ["position_checksum"],
                        "value": world.position_checksum,
                    },
                    {"op": "set", "path": ["tick"], "value": world.source_tick},
                    {
                        "op": "set",
                        "path": ["total_updates"],
                        "value": world.total_updates,
                    },
                    {
                        "op": "set",
                        "path": ["world_revision"],
                        "value": world.world_revision,
                    },
                ],
            },
            tuple(
                DisplayCommand.set_transform(
                    root_name(index), world.transforms[index]
                )
                for index in indices
            ),
        )


class LengthFramedPeer:
    """A local child whose frame payloads are untouched Engine/ACK packet bytes."""

    def __init__(self, *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("node executable is required")
        self.timeout_seconds = timeout_seconds
        self.process = subprocess.Popen(
            [node, str(PEER_SCRIPT)],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        if self.process.stdin is None or self.process.stdout is None or self.process.stderr is None:
            self.abort()
            raise RuntimeError("failed to create communication peer pipes")
        os.set_blocking(self.process.stdin.fileno(), False)
        self._finished = False

    def send_packet(self, raw: bytes) -> None:
        payload = bytes(raw)
        if not payload or len(payload) > MAXIMUM_FRAME_BYTES:
            raise ValueError("Engine packet frame length is invalid")
        self._write_all(FRAME_HEADER.pack(len(payload)) + payload)

    def read_packet(self) -> bytes:
        header = self._read_exact(FRAME_HEADER.size)
        length = FRAME_HEADER.unpack(header)[0]
        if length <= 0 or length > MAXIMUM_FRAME_BYTES:
            raise RuntimeError(f"peer returned invalid frame length {length}")
        return self._read_exact(length)

    def finish(self) -> dict[str, Any]:
        if self._finished:
            raise RuntimeError("communication peer already finished")
        self._finished = True
        self._write_all(FRAME_HEADER.pack(0))
        report = json.loads(self.read_packet().decode("utf-8"))
        self.process.stdin.close()
        try:
            return_code = self.process.wait(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            self.abort()
            raise RuntimeError("communication peer did not exit") from exc
        stderr = self.process.stderr.read().decode("utf-8", errors="replace")
        if return_code != 0 or stderr:
            raise RuntimeError(
                f"communication peer failed with status {return_code}: {stderr.strip()}"
            )
        return report

    def abort(self) -> None:
        if getattr(self, "process", None) is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)

    def _write_all(self, value: bytes) -> None:
        descriptor = self.process.stdin.fileno()
        deadline = time.monotonic() + self.timeout_seconds
        offset = 0
        while offset < len(value):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.abort()
                raise RuntimeError("timed out writing to communication peer")
            _, ready, _ = select.select([], [descriptor], [], remaining)
            if not ready:
                continue
            try:
                written = os.write(descriptor, value[offset:])
            except BlockingIOError:
                continue
            if written <= 0:
                raise RuntimeError("communication peer stdin closed")
            offset += written

    def _read_exact(self, length: int) -> bytes:
        descriptor = self.process.stdout.fileno()
        deadline = time.monotonic() + self.timeout_seconds
        result = bytearray()
        while len(result) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.abort()
                raise RuntimeError("timed out waiting for communication peer")
            ready, _, _ = select.select([descriptor], [], [], remaining)
            if not ready:
                continue
            chunk = os.read(descriptor, length - len(result))
            if not chunk:
                stderr = self.process.stderr.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"communication peer closed stdout early: {stderr.strip()}"
                )
            result.extend(chunk)
        return bytes(result)


class FramedRuntimeTransport:
    def __init__(self, peer: LengthFramedPeer) -> None:
        self.peer = peer
        self.sent_at_ns: dict[int, int] = {}
        self.packet_lengths: list[int] = []
        self.first_packet: bytes | None = None
        self.last_packet: bytes | None = None
        self.closed: list[tuple[Any, str]] = []
        self.framed_hash = hashlib.sha256()

    def send(self, client_id: Any, raw: bytes) -> bool:
        if client_id != CLIENT_ID:
            raise RuntimeError("unexpected communication client id")
        payload = bytes(raw)
        sequence = len(self.packet_lengths)
        self.sent_at_ns[sequence] = time.perf_counter_ns()
        self.peer.send_packet(payload)
        self.packet_lengths.append(len(payload))
        self.first_packet = payload if self.first_packet is None else self.first_packet
        self.last_packet = payload
        update_framed_hash(self.framed_hash, payload)
        return True

    def close(self, client_id: Any, reason: str) -> None:
        self.closed.append((client_id, reason))


def load_catalog_identity(
    *, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
) -> DisplayCatalogIdentity:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node executable is required")
    completed = subprocess.run(
        [node, str(CATALOG_SCRIPT)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    if completed.stderr:
        raise RuntimeError(f"catalog builder wrote stderr: {completed.stderr.strip()}")
    return DisplayCatalogIdentity.from_record(json.loads(completed.stdout))


def run_benchmark(
    *,
    roots: int,
    commits: int,
    update_ratio: float,
    profile: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    roots, commits, update_ratio, profile = validate_parameters(
        roots, commits, update_ratio, profile
    )
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not math.isfinite(float(timeout_seconds))
        or timeout_seconds <= 0
    ):
        raise ValueError("timeout_seconds must be a finite positive number")
    timeout_seconds = float(timeout_seconds)
    updates_per_commit = max(1, min(roots, math.ceil(roots * update_ratio)))
    catalog = load_catalog_identity(timeout_seconds=timeout_seconds)
    world = CommunicationWorld(roots)
    program = CommunicationProgram(
        roots=roots,
        updates_per_commit=updates_per_commit,
        catalog=catalog,
    )
    clock = ManualClock()
    peer = LengthFramedPeer(timeout_seconds=timeout_seconds)
    transport = FramedRuntimeTransport(peer)
    runtime = SceneEngineRuntime(
        world=world,
        program=program,
        transport=transport,
        config=RuntimeConfig(),
        clock=clock,
        stream_id="python-js-communication-stream",
    )
    commit_started_ns: dict[int, int] = {}
    python_tick_to_transport_ns = [0] * commits
    commit_e2e_ns = [0] * commits
    wire_round_trip_ns = [0] * commits
    ack_lengths: list[int] = []
    ack_hash = hashlib.sha256()
    exact_ack_bytes = True
    flow_peaks = {
        "inFlightCount": 0,
        "inFlightBytes": 0,
        "pendingCount": 0,
        "pendingBytes": 0,
    }
    peer_report: dict[str, Any] | None = None
    runtime_started = False
    try:
        runtime.start()
        runtime_started = True
        checkpoint_started = time.perf_counter_ns()
        runtime.client_connected(CLIENT_ID)
        sample_flow(runtime, flow_peaks)
        checkpoint_ack, checkpoint_ack_end = receive_ack(
            peer=peer,
            runtime=runtime,
            expected_commit_seq=0,
            expected_last_command_seq=0,
            ack_hash=ack_hash,
        )
        checkpoint_round_trip_ns = checkpoint_ack_end - checkpoint_started
        ack_lengths.append(len(checkpoint_ack))
        sample_flow(runtime, flow_peaks)

        communication_started = time.perf_counter_ns()
        produced = 0
        acknowledged = 0
        burst_size = (
            1
            if profile == PROFILE_ROUNDTRIP
            else 2 * runtime.config.maximum_in_flight_commits
        )
        while produced < commits:
            target = min(commits, produced + burst_size)
            while produced < target:
                commit_seq = produced + 1
                clock.advance(1 / TICKS_PER_SECOND)
                commit_started_ns[commit_seq] = time.perf_counter_ns()
                result = runtime.pump()
                if result.ticks_committed != 1 or result.commit_seq != commit_seq:
                    raise RuntimeError(f"runtime did not publish commit {commit_seq}")
                produced += 1
                sample_flow(runtime, flow_peaks)
            while acknowledged < target:
                commit_seq = acknowledged + 1
                last_command_seq = commit_seq * updates_per_commit
                ack, ack_end = receive_ack(
                    peer=peer,
                    runtime=runtime,
                    expected_commit_seq=commit_seq,
                    expected_last_command_seq=last_command_seq,
                    ack_hash=ack_hash,
                )
                ack_lengths.append(len(ack))
                python_tick_to_transport_ns[commit_seq - 1] = (
                    transport.sent_at_ns[commit_seq] - commit_started_ns[commit_seq]
                )
                commit_e2e_ns[commit_seq - 1] = ack_end - commit_started_ns[commit_seq]
                wire_round_trip_ns[commit_seq - 1] = (
                    ack_end - transport.sent_at_ns[commit_seq]
                )
                acknowledged += 1
                sample_flow(runtime, flow_peaks)
        communication_finished = time.perf_counter_ns()
        final_session = runtime.health.sessions[0]
        final_runtime_health = runtime.health
        peer_report = peer.finish()

        first_packet = read_engine_packet(transport.first_packet)
        last_packet = read_engine_packet(transport.last_packet)
        engine_packet_envelope = (
            first_packet.kind is PacketKind.CHECKPOINT
            and last_packet.kind is PacketKind.COMMIT
            and last_packet.header["commit_seq"] == commits
        )
        exact_ack_bytes = len(ack_lengths) == commits + 1
        expected_digest = transform_digest(world.transforms)
        elapsed_seconds = max(
            (communication_finished - communication_started) / 1_000_000_000,
            1e-12,
        )
        engine_commit_bytes = sum(transport.packet_lengths[1:])
        ack_commit_bytes = sum(ack_lengths[1:])
        total_commands = commits * updates_per_commit
        correctness = {
            "peerReportContract": (
                peer_report["schema"] == PEER_REPORT_SCHEMA
                and peer_report["transformDigestEncoding"]
                == TRANSFORM_DIGEST_ENCODING
            ),
            "canonicalCatalogAccepted": peer_report["sessionCount"] == 1,
            "exactAckBytes": exact_ack_bytes,
            "enginePacketEnvelope": engine_packet_envelope,
            "allPacketsCrossedLengthFrames": (
                peer_report["enginePacketCount"] == commits + 1
                and peer_report["engineBytes"] == sum(transport.packet_lengths)
                and peer_report["engineFramedSha256"] == transport.framed_hash.hexdigest()
                and peer_report["ackBytes"] == sum(ack_lengths)
                and peer_report["ackFramedSha256"] == ack_hash.hexdigest()
            ),
            "pythonSessionAckCursor": (
                final_session.last_acked_seq == commits
                and final_session.last_acked_command_seq == total_commands
                and final_session.in_flight_count == 0
                and final_session.pending_count == 0
            ),
            "javascriptClientCursor": (
                peer_report["finalCommit"]["commitSeq"] == commits
                and peer_report["finalCommit"]["sourceTick"] == commits
                and peer_report["finalCommit"]["lastCommandSeq"] == total_commands
            ),
            "finalWorldState": peer_report["finalWorldState"] == world_snapshot(world),
            "finalDisplayTransforms": (
                peer_report["transformDigest"]["rootCount"] == roots
                and peer_report["transformDigest"]["sha256"] == expected_digest
            ),
            "displaySummary": (
                peer_report["displaySummary"]["cursor"]["commitSeq"] == commits
                and peer_report["displaySummary"]["cursor"]["sourceTick"] == commits
                and peer_report["displaySummary"]["cursor"]["lastCommandSeq"]
                == total_commands
                and peer_report["displaySummary"]["nodeCount"] == roots + 3
                and peer_report["displaySummary"]["health"] == "ready"
            ),
            "rendererExcluded": (
                peer_report["noRenderWork"]["catalogResourceCount"] == 0
                and peer_report["noRenderWork"]["frameExecutions"] == 0
                and peer_report["noRenderWork"]["fakeBackendDraws"] == 0
                and peer_report["noRenderWork"]["fakeBackendBindings"] == 1
            ),
            "displayDisposed": peer_report["cleanup"]["returnedToZero"],
            "runtimeHealthy": (
                final_runtime_health.state == "running"
                and final_runtime_health.fatal_cause is None
                and transport.closed == []
            ),
        }
        passed = all(correctness.values())
        report = {
            "schema": REPORT_SCHEMA,
            "status": "PASS" if passed else "FAIL",
            "transformDigestEncoding": TRANSFORM_DIGEST_ENCODING,
            "parameters": {
                "roots": roots,
                "commits": commits,
                "updateRatio": update_ratio,
                "updatesPerCommit": updates_per_commit,
                "profile": profile,
                "ticksPerSecond": TICKS_PER_SECOND,
            },
            "catalogIdentity": catalog.to_record(),
            "checkpoint": {
                "engineBytes": transport.packet_lengths[0],
                "ackBytes": ack_lengths[0],
                "roundTripMs": round(checkpoint_round_trip_ns / 1_000_000, 6),
            },
            "commits": {
                "totalCommands": total_commands,
                "engineBytes": engine_commit_bytes,
                "ackBytes": ack_commit_bytes,
                "pythonTickToTransport": timing_summary(
                    python_tick_to_transport_ns
                ),
                "pythonTickToAck": timing_summary(commit_e2e_ns),
                "lengthFrameToAck": timing_summary(wire_round_trip_ns),
                "latencySemantics": {
                    "pythonTickToTransport": (
                        "runtime pump start through transport send entry; windowed "
                        "profile includes Python flow-control queueing"
                    ),
                    "pythonTickToAck": (
                        "runtime pump start through ACK read; includes flow-control queueing"
                    ),
                    "lengthFrameToAck": (
                        "transport send through ACK read; windowed profile includes receiver queueing"
                    ),
                },
            },
            "throughput": {
                "elapsedSeconds": round(elapsed_seconds, 6),
                "engineAndAckBytesPerSecond": round(
                    (engine_commit_bytes + ack_commit_bytes) / elapsed_seconds, 3
                ),
                "displayCommandsPerSecond": round(total_commands / elapsed_seconds, 3),
                "commitsPerSecond": round(commits / elapsed_seconds, 3),
            },
            "flowControl": {
                "peak": flow_peaks,
                "final": {
                    "inFlightCount": final_session.in_flight_count,
                    "inFlightBytes": final_session.in_flight_bytes,
                    "pendingCount": final_session.pending_count,
                    "pendingBytes": final_session.pending_bytes,
                },
            },
            "final": {
                "runtime": dataclass_json(final_runtime_health),
                "session": asdict(final_session),
                "world": world_snapshot(world),
                "transformSha256": expected_digest,
                "peer": peer_report,
            },
            "correctness": correctness,
        }
        return report
    finally:
        if runtime_started:
            try:
                runtime.stop()
            except Exception:
                pass
        if peer_report is None:
            peer.abort()


def receive_ack(
    *,
    peer: LengthFramedPeer,
    runtime: SceneEngineRuntime,
    expected_commit_seq: int,
    expected_last_command_seq: int,
    ack_hash: Any,
) -> tuple[bytes, int]:
    raw = peer.read_packet()
    ack_received_ns = time.perf_counter_ns()
    decoded = read_engine_packet(raw)
    if decoded.kind is not PacketKind.ACK:
        raise RuntimeError("JavaScript peer returned a non-ACK packet")
    if (
        decoded.header["stream_id"] != runtime.stream_id
        or decoded.header["commit_seq"] != expected_commit_seq
        or decoded.header["last_command_seq"] != expected_last_command_seq
    ):
        raise RuntimeError(
            f"ACK cursor mismatch for commit {expected_commit_seq}: {dict(decoded.header)}"
        )
    expected = encode_ack(
        stream_id=runtime.stream_id,
        commit_seq=expected_commit_seq,
        last_command_seq=expected_last_command_seq,
    )
    if raw != expected:
        raise RuntimeError(f"JavaScript ACK bytes differ at commit {expected_commit_seq}")
    update_framed_hash(ack_hash, raw)
    runtime.receive_client_packet(CLIENT_ID, raw)
    return raw, ack_received_ns


def sample_flow(runtime: SceneEngineRuntime, peaks: dict[str, int]) -> None:
    sessions = runtime.health.sessions
    if not sessions:
        return
    health = sessions[0]
    peaks["inFlightCount"] = max(peaks["inFlightCount"], health.in_flight_count)
    peaks["inFlightBytes"] = max(peaks["inFlightBytes"], health.in_flight_bytes)
    peaks["pendingCount"] = max(peaks["pendingCount"], health.pending_count)
    peaks["pendingBytes"] = max(peaks["pendingBytes"], health.pending_bytes)


def timing_summary(nanoseconds: Iterable[int]) -> dict[str, Any]:
    samples = sorted(value / 1_000_000 for value in nanoseconds)
    return {
        "samples": len(samples),
        "p50Ms": round(percentile(samples, 0.50), 6),
        "p95Ms": round(percentile(samples, 0.95), 6),
        "p99Ms": round(percentile(samples, 0.99), 6),
        "maxMs": round(percentile(samples, 1.0), 6),
    }


def percentile(sorted_values: list[float], quantile: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(
        0,
        min(len(sorted_values) - 1, math.ceil(len(sorted_values) * quantile) - 1),
    )
    return sorted_values[index]


def validate_parameters(
    roots: int, commits: int, update_ratio: float, profile: str
) -> tuple[int, int, float, str]:
    if isinstance(roots, bool) or not isinstance(roots, int) or roots <= 0:
        raise ValueError("roots must be a positive integer")
    if isinstance(commits, bool) or not isinstance(commits, int) or commits <= 0:
        raise ValueError("commits must be a positive integer")
    if isinstance(update_ratio, bool) or not isinstance(update_ratio, (int, float)):
        raise ValueError("update_ratio must be a finite number in (0, 1]")
    ratio = float(update_ratio)
    if not math.isfinite(ratio) or ratio <= 0 or ratio > 1:
        raise ValueError("update_ratio must be a finite number in (0, 1]")
    if profile not in PROFILES:
        raise ValueError(f"profile must be one of {', '.join(PROFILES)}")
    return roots, commits, ratio, profile


def initial_position(index: int) -> tuple[float, float, float]:
    return (0.0, float(index), 0.0)


def updated_position(index: int, source_tick: int) -> tuple[float, float, float]:
    return (float(source_tick), float(index), float((source_tick + index) % 17))


def display_transform(position: tuple[float, float, float]) -> DisplayTransform:
    return DisplayTransform(
        matrix_bytes=MATRIX4_F32.pack(
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            position[0],
            position[1],
            position[2],
            1.0,
        )
    )


def root_name(index: int) -> str:
    return f"py/communication-{index:06d}"


def world_snapshot(world: CommunicationWorld) -> dict[str, int]:
    return {
        "tick": world.source_tick,
        "world_revision": world.world_revision,
        "roots": world.roots,
        "total_updates": world.total_updates,
        "position_checksum": world.position_checksum,
    }


def transform_digest(transforms: list[DisplayTransform]) -> str:
    digest = hashlib.sha256()
    for index, transform in enumerate(transforms):
        digest.update(root_name(index).encode("utf-8"))
        digest.update(b"\0")
        digest.update(transform.matrix_bytes)
        digest.update(b"\0")
    return digest.hexdigest()


def update_framed_hash(digest: Any, payload: bytes) -> None:
    digest.update(FRAME_HEADER.pack(len(payload)))
    digest.update(payload)


def dataclass_json(value: Any) -> dict[str, Any]:
    result = asdict(value)
    if result.get("fatal_cause") is not None:
        result["fatal_cause"] = repr(result["fatal_cause"])
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--roots", type=int, default=500)
    parser.add_argument("--commits", type=int, default=200)
    parser.add_argument("--update-ratio", type=float, default=0.02)
    parser.add_argument("--profile", choices=PROFILES, default=PROFILE_ROUNDTRIP)
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = parse_args(argv)
    try:
        report = run_benchmark(
            roots=arguments.roots,
            commits=arguments.commits,
            update_ratio=arguments.update_ratio,
            profile=arguments.profile,
            timeout_seconds=arguments.timeout_seconds,
        )
    except Exception as error:
        report = {
            "schema": REPORT_SCHEMA,
            "status": "ERROR",
            "transformDigestEncoding": TRANSFORM_DIGEST_ENCODING,
            "error": {"type": type(error).__name__, "message": str(error)},
        }
    process_output = json.dumps(report, indent=2, sort_keys=True)
    sys.stdout.write(f"{process_output}\n")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
