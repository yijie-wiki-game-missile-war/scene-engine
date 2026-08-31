#!/usr/bin/env python3
"""Measure the exact Python Runtime -> JavaScript Client -> ACK communication path."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
import hashlib
import json
import math
from pathlib import Path
import queue
import shutil
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Iterable

import numpy as np

from scene_engine import (
    DisplayCatalogIdentity,
    DisplayCommand,
    DisplayMatrixPool,
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
MAXIMUM_FRAME_BYTES = 64 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 30.0
PROFILE_ROUNDTRIP = "roundtrip"
PROFILE_WINDOWED = "windowed"
PROFILES = (PROFILE_ROUNDTRIP, PROFILE_WINDOWED)
REPORT_SCHEMA = "scene-engine-python-js-communication@3"
PEER_REPORT_SCHEMA = "scene-engine-python-js-communication-peer@3"
TRANSFORM_DIGEST_ENCODING = "node-id-u32le-le-f32-matrix16"
PIPE_CHUNK_BYTES = 64 * 1024
_PIPE_EOF = object()
_PIPE_WRITE_STOP = object()


@dataclass
class CommunicationWorld:
    roots: int
    source_tick: int = 0
    world_revision: int = 0
    total_updates: int = 0

    def __post_init__(self) -> None:
        self.matrix_pool = DisplayMatrixPool()
        node_ids = tuple(
            self.matrix_pool.append(display_transform(initial_position(index)))
            for index in range(self.roots)
        )
        if node_ids != tuple(range(self.roots)):
            raise RuntimeError("communication MatrixPool allocated unexpected Node IDs")
        self.position_checksum = 0
        self.x_positions = np.zeros(self.roots, dtype=np.int64)


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
        indices = (
            start + np.arange(self.updates_per_commit, dtype=np.uint64)
        ) % self.roots
        node_ids = np.asarray(indices, dtype="<u4")
        matrix_rows = np.zeros((len(node_ids), 4, 4), dtype="<f4")
        matrix_rows[:, 0, 0] = 1.0
        matrix_rows[:, 1, 1] = 1.0
        matrix_rows[:, 2, 2] = 1.0
        matrix_rows[:, 3, 3] = 1.0
        matrix_rows[:, 3, 0] = float(context.commit.source_tick)
        matrix_rows[:, 3, 1] = node_ids
        matrix_rows[:, 3, 2] = (
            node_ids.astype(np.uint64) + context.commit.source_tick
        ) % 17
        integer_ids = node_ids.astype(np.intp, copy=False)
        world.position_checksum += int(
            np.sum(context.commit.source_tick - world.x_positions[integer_ids])
        )
        world.x_positions[integer_ids] = context.commit.source_tick
        world.matrix_pool.set_batch(node_ids, matrix_rows)
        world.total_updates += len(indices)
        return MutationResult.changed(node_ids)

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
            world.matrix_pool,
            tuple(
                DisplayNode(
                    node_id=index,
                    parent_node_id=None,
                    prefab_id=PREFAB_ID,
                    transform_mode="live",
                    visible=True,
                    state={"index": index},
                )
                for index in range(self.roots)
            ),
        )

    def build_commit(
        self, world: CommunicationWorld, mutation: MutationResult, context: Any
    ) -> ProductCommit:
        node_ids = mutation.commit_context
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
            world.matrix_pool,
            (DisplayCommand.set_transform_batch(node_ids),),
        )


@dataclass(slots=True)
class _PipeWriteRequest:
    value: bytes
    completed: threading.Event = field(default_factory=threading.Event)
    error: BaseException | None = None


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
        self._stdin_requests: queue.Queue[_PipeWriteRequest | object] = queue.Queue()
        self._stdout_chunks: queue.Queue[bytes | BaseException | object] = queue.Queue()
        self._stdout_buffer = bytearray()
        self._stderr_chunks: list[bytes] = []
        self._stderr_lock = threading.Lock()
        self._stdout_failure: BaseException | None = None
        self._stderr_failure: BaseException | None = None
        self._stdin_stopping = False
        self._finished = False
        self._stdin_thread = threading.Thread(
            target=self._write_stdin,
            name="scene-engine-communication-stdin",
            daemon=True,
        )
        self._stdout_thread = threading.Thread(
            target=self._read_stdout,
            name="scene-engine-communication-stdout",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr,
            name="scene-engine-communication-stderr",
            daemon=True,
        )
        try:
            self._stdin_thread.start()
            self._stdout_thread.start()
            self._stderr_thread.start()
        except BaseException:
            self.abort()
            raise

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
        self._stop_stdin_writer()
        try:
            return_code = self.process.wait(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired as exc:
            self.abort()
            raise RuntimeError("communication peer did not exit") from exc
        self._join_reader_threads()
        stderr = self._stderr_text()
        if self._stdout_failure is not None:
            raise RuntimeError("communication peer stdout reader failed") from self._stdout_failure
        if self._stderr_failure is not None:
            raise RuntimeError("communication peer stderr reader failed") from self._stderr_failure
        if return_code != 0 or stderr:
            raise RuntimeError(
                f"communication peer failed with status {return_code}: {stderr.strip()}"
            )
        return report

    def abort(self) -> None:
        process = getattr(self, "process", None)
        if process is None:
            return
        if process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except OSError:
                    pass
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self._signal_stdin_stop()
        workers = []
        for thread_name in ("_stdin_thread", "_stdout_thread", "_stderr_thread"):
            thread = getattr(self, thread_name, None)
            if thread is not None and thread is not threading.current_thread():
                workers.append(thread)
                thread.join(timeout=2)
        for stream_name in ("stdin", "stdout", "stderr"):
            stream = getattr(process, stream_name, None)
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        for thread in workers:
            if thread.is_alive():
                thread.join(timeout=2)

    def _write_all(self, value: bytes) -> None:
        if self._stdin_stopping:
            raise RuntimeError("communication peer stdin is closed")
        request = _PipeWriteRequest(bytes(value))
        self._stdin_requests.put_nowait(request)
        if not request.completed.wait(timeout=self.timeout_seconds):
            self.abort()
            raise RuntimeError("timed out writing to communication peer")
        if request.error is not None:
            self.abort()
            raise RuntimeError("communication peer stdin write failed") from request.error

    def _read_exact(self, length: int) -> bytes:
        deadline = time.monotonic() + self.timeout_seconds
        while len(self._stdout_buffer) < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.abort()
                raise RuntimeError("timed out waiting for communication peer")
            try:
                chunk = self._stdout_chunks.get(timeout=remaining)
            except queue.Empty:
                self.abort()
                raise RuntimeError("timed out waiting for communication peer") from None
            if chunk is _PIPE_EOF:
                self.abort()
                raise RuntimeError(
                    f"communication peer closed stdout early: {self._stderr_text().strip()}"
                )
            if isinstance(chunk, BaseException):
                self.abort()
                raise RuntimeError("communication peer stdout reader failed") from chunk
            if not isinstance(chunk, bytes):
                self.abort()
                raise RuntimeError("communication peer stdout reader returned invalid data")
            self._stdout_buffer.extend(chunk)
        result = bytes(self._stdout_buffer[:length])
        del self._stdout_buffer[:length]
        return result

    def _write_stdin(self) -> None:
        stream = self.process.stdin
        try:
            while True:
                request = self._stdin_requests.get()
                if request is _PIPE_WRITE_STOP:
                    return
                if not isinstance(request, _PipeWriteRequest):
                    continue
                try:
                    remaining = memoryview(request.value)
                    while remaining:
                        written = stream.write(remaining)
                        if written is None or written <= 0:
                            raise BrokenPipeError("communication peer stdin closed")
                        remaining = remaining[written:]
                    stream.flush()
                except BaseException as exc:
                    request.error = exc
                finally:
                    request.completed.set()
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def _read_stdout(self) -> None:
        stream = self.process.stdout
        try:
            while True:
                chunk = stream.read(PIPE_CHUNK_BYTES)
                if not chunk:
                    self._stdout_chunks.put(_PIPE_EOF)
                    return
                self._stdout_chunks.put(bytes(chunk))
        except BaseException as exc:
            self._stdout_failure = exc
            self._stdout_chunks.put(exc)

    def _read_stderr(self) -> None:
        stream = self.process.stderr
        try:
            while True:
                chunk = stream.read(PIPE_CHUNK_BYTES)
                if not chunk:
                    return
                with self._stderr_lock:
                    self._stderr_chunks.append(bytes(chunk))
        except BaseException as exc:
            self._stderr_failure = exc

    def _signal_stdin_stop(self) -> None:
        if not getattr(self, "_stdin_stopping", True):
            self._stdin_stopping = True
            self._stdin_requests.put_nowait(_PIPE_WRITE_STOP)

    def _stop_stdin_writer(self) -> None:
        self._signal_stdin_stop()
        self._stdin_thread.join(timeout=self.timeout_seconds)
        if self._stdin_thread.is_alive():
            self.abort()
            raise RuntimeError("timed out closing communication peer stdin")

    def _join_reader_threads(self) -> None:
        for thread, label in (
            (self._stdout_thread, "stdout"),
            (self._stderr_thread, "stderr"),
        ):
            thread.join(timeout=self.timeout_seconds)
            if thread.is_alive():
                self.abort()
                raise RuntimeError(f"timed out closing communication peer {label}")

    def _stderr_text(self) -> str:
        with self._stderr_lock:
            raw = b"".join(self._stderr_chunks)
        return raw.decode("utf-8", errors="replace")


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
                last_command_seq = commit_seq
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
        expected_digest = transform_digest(world.matrix_pool)
        elapsed_seconds = max(
            (communication_finished - communication_started) / 1_000_000_000,
            1e-12,
        )
        engine_commit_bytes = sum(transport.packet_lengths[1:])
        ack_commit_bytes = sum(ack_lengths[1:])
        total_logical_commands = commits
        total_transform_rows = commits * updates_per_commit
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
                and final_session.last_acked_command_seq == total_logical_commands
                and final_session.in_flight_count == 0
                and final_session.pending_count == 0
            ),
            "javascriptClientCursor": (
                peer_report["finalCommit"]["commitSeq"] == commits
                and peer_report["finalCommit"]["sourceTick"] == commits
                and peer_report["finalCommit"]["lastCommandSeq"]
                == total_logical_commands
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
                == total_logical_commands
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
                "logicalCommands": total_logical_commands,
                "totalTransformRows": total_transform_rows,
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
                "logicalCommandsPerSecond": round(
                    total_logical_commands / elapsed_seconds, 3
                ),
                "transformRowsPerSecond": round(
                    total_transform_rows / elapsed_seconds, 3
                ),
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


def world_snapshot(world: CommunicationWorld) -> dict[str, int]:
    return {
        "tick": world.source_tick,
        "world_revision": world.world_revision,
        "roots": world.roots,
        "total_updates": world.total_updates,
        "position_checksum": world.position_checksum,
    }


def transform_digest(matrix_pool: DisplayMatrixPool) -> str:
    digest = hashlib.sha256()
    matrices = matrix_pool.matrices
    for node_id in range(matrix_pool.size):
        digest.update(struct.pack("<I", node_id))
        digest.update(matrices[node_id].tobytes(order="C"))
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
