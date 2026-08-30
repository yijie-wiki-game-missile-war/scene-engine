"""Streaming exact-byte Engine packet logs."""

from __future__ import annotations

import hashlib
import json
import os
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .errors import RecordingError
from .wire import (
    DEFAULT_ENGINE_LIMITS,
    MAXIMUM_SAFE_INTEGER,
    WIRE_SCHEMA,
    EngineLimits,
    PacketKind,
    read_engine_packet,
)


PACKET_LOG_SCHEMA = "scene-engine-packet-log@3"
PACKET_LOG_MANIFEST = "manifest.json"
PACKET_LOG_PACKETS = "packets.bin"
PACKET_LOG_INDEX = "index.json"
PACKET_LOG_INCOMPLETE = "INCOMPLETE"
_LENGTH = struct.Struct("<Q")


@dataclass(frozen=True, slots=True)
class _MatrixPoolState:
    pool_size: int
    active_node_ids: frozenset[int]


@dataclass(frozen=True, slots=True)
class PacketLogEntry:
    stream_id: str
    commit_seq: int
    source_tick: int
    world_revision: int
    last_command_seq: int
    offset: int
    packet_length: int
    checkpoint: bool

    def __post_init__(self) -> None:
        if not isinstance(self.stream_id, str) or not self.stream_id:
            raise RecordingError("packet log entry stream_id is invalid")
        for field in (
            "commit_seq",
            "source_tick",
            "world_revision",
            "last_command_seq",
            "offset",
            "packet_length",
        ):
            _index_integer(getattr(self, field), field)
        if self.packet_length == 0 or not isinstance(self.checkpoint, bool):
            raise RecordingError("packet log entry kind or length is invalid")

    def as_dict(self) -> dict[str, Any]:
        return {
            "stream_id": self.stream_id,
            "commit_seq": self.commit_seq,
            "source_tick": self.source_tick,
            "world_revision": self.world_revision,
            "last_command_seq": self.last_command_seq,
            "offset": self.offset,
            "packet_length": self.packet_length,
            "checkpoint": self.checkpoint,
        }


@dataclass(frozen=True, slots=True)
class PacketLog:
    manifest: dict[str, Any]
    entries: tuple[PacketLogEntry, ...]
    packets: bytes

    def packet_at(self, index: int) -> bytes:
        if (
            isinstance(index, bool)
            or not isinstance(index, int)
            or index < 0
            or index > MAXIMUM_SAFE_INTEGER
        ):
            raise RecordingError("packet index is invalid")
        try:
            entry = self.entries[index]
        except (IndexError, TypeError) as exc:
            raise RecordingError("packet index is out of range") from exc
        return bytes(self.packets[entry.offset : entry.offset + entry.packet_length])


class PacketLogWriter:
    """Append state packets without retaining packet bodies in memory."""

    def __init__(
        self,
        directory: str | os.PathLike[str],
        *,
        limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
        fsync: bool = True,
    ) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._paths = {
            name: self.directory / name
            for name in (
                PACKET_LOG_MANIFEST,
                PACKET_LOG_PACKETS,
                PACKET_LOG_INDEX,
                PACKET_LOG_INCOMPLETE,
            )
        }
        if any(path.exists() for path in self._paths.values()):
            raise RecordingError("packet log target is not empty")
        self._limits = limits
        self._fsync = bool(fsync)
        self._entries: list[PacketLogEntry] = []
        self._packets_hash = hashlib.sha256()
        self._packets_bytes = 0
        self._checkpoint_count = 0
        self._stream_id: str | None = None
        self._last_commit_seq: int | None = None
        self._last_tick: int | None = None
        self._last_revision: int | None = None
        self._last_command_seq: int | None = None
        self._matrix_pool_state: _MatrixPoolState | None = None
        self._sealed = False
        self._closed = False
        try:
            self._paths[PACKET_LOG_INCOMPLETE].write_bytes(
                b'{"schema":"scene-engine-packet-log-incomplete@1"}\n'
            )
            self._stream = self._paths[PACKET_LOG_PACKETS].open("xb")
        except OSError as exc:
            raise RecordingError("could not initialize packet log") from exc

    def append(self, packet_bytes: Any, *, checkpoint: bool) -> PacketLogEntry:
        self._require_open()
        raw = bytes(packet_bytes)
        packet = read_engine_packet(raw, limits=self._limits)
        expected_kind = PacketKind.CHECKPOINT if checkpoint else PacketKind.COMMIT
        if packet.kind is not expected_kind:
            raise RecordingError("recording packet kind does not match checkpoint flag")
        header = packet.header
        stream_id = header["stream_id"]
        sequence = header["commit_seq"]
        tick = header["source_tick"]
        revision = header["world_revision"]
        command_sequence = header["last_command_seq"]
        if not self._entries:
            if not checkpoint:
                raise RecordingError("packet log must begin with a checkpoint")
            self._stream_id = stream_id
        else:
            if stream_id != self._stream_id:
                raise RecordingError("packet log cannot cross streams")
            assert self._last_commit_seq is not None
            assert self._last_tick is not None
            assert self._last_revision is not None
            assert self._last_command_seq is not None
            if checkpoint:
                if (
                    sequence != self._last_commit_seq
                    or tick != self._last_tick
                    or revision != self._last_revision
                    or command_sequence != self._last_command_seq
                ):
                    raise RecordingError("periodic checkpoint cursor does not match log")
            elif (
                sequence != self._last_commit_seq + 1
                or revision != self._last_revision + 1
                or tick < self._last_tick
                or tick > self._last_tick + 1
                or command_sequence < self._last_command_seq
                or _display_command_base(packet) != self._last_command_seq
            ):
                raise RecordingError("packet log commit progression is invalid")
            elif not _cause_matches_tick(packet.header["cause"], tick - self._last_tick):
                raise RecordingError("packet log cause/tick progression is invalid")
        next_matrix_pool_state = _advance_matrix_pool_state(
            self._matrix_pool_state, packet
        )
        prefix = _LENGTH.pack(len(raw))
        try:
            prefix_offset = self._stream.tell()
            self._stream.write(prefix)
            self._stream.write(raw)
        except OSError as exc:
            self.close_incomplete()
            raise RecordingError("packet log append failed") from exc
        self._packets_hash.update(prefix)
        self._packets_hash.update(raw)
        self._packets_bytes += len(prefix) + len(raw)
        entry = PacketLogEntry(
            stream_id,
            sequence,
            tick,
            revision,
            command_sequence,
            prefix_offset + _LENGTH.size,
            len(raw),
            checkpoint,
        )
        self._entries.append(entry)
        if checkpoint:
            self._checkpoint_count += 1
        self._last_commit_seq = sequence
        self._last_tick = tick
        self._last_revision = revision
        self._last_command_seq = command_sequence
        self._matrix_pool_state = next_matrix_pool_state
        return entry

    def seal(self) -> dict[str, Any]:
        self._require_open()
        if not self._entries or not self._entries[0].checkpoint:
            raise RecordingError("packet log has no initial checkpoint")
        try:
            self._stream.flush()
            if self._fsync:
                os.fsync(self._stream.fileno())
            self._stream.close()
            self._closed = True
            index_bytes = _canonical_json(
                [entry.as_dict() for entry in self._entries]
            )
            _atomic_write(self._paths[PACKET_LOG_INDEX], index_bytes, fsync=self._fsync)
            first = self._entries[0]
            last = self._entries[-1]
            manifest = {
                "schema": PACKET_LOG_SCHEMA,
                "wire_schema": WIRE_SCHEMA,
                "complete": True,
                "packet_count": len(self._entries),
                "checkpoint_count": self._checkpoint_count,
                "packets_bytes": self._packets_bytes,
                "packets_sha256": self._packets_hash.hexdigest(),
                "index_sha256": hashlib.sha256(index_bytes).hexdigest(),
                "stream_id": first.stream_id,
                "first_commit_seq": first.commit_seq,
                "last_commit_seq": last.commit_seq,
                "first_source_tick": first.source_tick,
                "last_source_tick": last.source_tick,
                "first_command_seq": first.last_command_seq,
                "last_command_seq": last.last_command_seq,
            }
            _atomic_write(
                self._paths[PACKET_LOG_MANIFEST],
                _canonical_json(manifest),
                fsync=self._fsync,
            )
            self._paths[PACKET_LOG_INCOMPLETE].unlink()
            if self._fsync:
                directory_fd = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        except (OSError, ValueError) as exc:
            self.close_incomplete()
            raise RecordingError("packet log seal failed") from exc
        self._sealed = True
        return manifest

    def close_incomplete(self) -> None:
        if getattr(self, "_closed", True):
            return
        self._closed = True
        try:
            self._stream.close()
        except OSError:
            pass

    def _require_open(self) -> None:
        if self._sealed or self._closed:
            raise RecordingError("packet log writer is closed")


def read_packet_log(
    directory: str | os.PathLike[str],
    *,
    limits: EngineLimits = DEFAULT_ENGINE_LIMITS,
) -> PacketLog:
    root = Path(directory)
    if (root / PACKET_LOG_INCOMPLETE).exists():
        raise RecordingError("packet log is incomplete")
    try:
        manifest_bytes = (root / PACKET_LOG_MANIFEST).read_bytes()
        index_bytes = (root / PACKET_LOG_INDEX).read_bytes()
        packets = (root / PACKET_LOG_PACKETS).read_bytes()
    except OSError as exc:
        raise RecordingError("packet log files could not be read") from exc
    manifest = _json_object(manifest_bytes, "manifest")
    _validate_manifest(manifest)
    if len(packets) != manifest["packets_bytes"]:
        raise RecordingError("packets.bin byte count mismatch")
    if hashlib.sha256(packets).hexdigest() != manifest["packets_sha256"]:
        raise RecordingError("packets.bin hash mismatch")
    if hashlib.sha256(index_bytes).hexdigest() != manifest["index_sha256"]:
        raise RecordingError("index.json hash mismatch")
    rebuilt = rebuild_packet_index(packets, limits=limits)
    index_value = _json_value(index_bytes, "index")
    if not isinstance(index_value, list):
        raise RecordingError("index.json must be an array")
    declared = tuple(_entry_from_dict(value) for value in index_value)
    if declared != rebuilt:
        raise RecordingError("index.json does not match packets.bin")
    if (
        len(declared) != manifest["packet_count"]
        or sum(entry.checkpoint for entry in declared) != manifest["checkpoint_count"]
    ):
        raise RecordingError("packet log manifest counts mismatch")
    first = declared[0]
    last = declared[-1]
    if (
        manifest["stream_id"] != first.stream_id
        or manifest["first_commit_seq"] != first.commit_seq
        or manifest["last_commit_seq"] != last.commit_seq
        or manifest["first_source_tick"] != first.source_tick
        or manifest["last_source_tick"] != last.source_tick
        or manifest["first_command_seq"] != first.last_command_seq
        or manifest["last_command_seq"] != last.last_command_seq
    ):
        raise RecordingError("packet log manifest cursor fields mismatch")
    return PacketLog(manifest, declared, packets)


def rebuild_packet_index(
    packets: Any, *, limits: EngineLimits = DEFAULT_ENGINE_LIMITS
) -> tuple[PacketLogEntry, ...]:
    raw = bytes(packets)
    cursor = 0
    entries: list[PacketLogEntry] = []
    previous = None
    matrix_pool_state: _MatrixPoolState | None = None
    while cursor < len(raw):
        if cursor + _LENGTH.size > len(raw):
            raise RecordingError("packets.bin length prefix is truncated")
        packet_length = _LENGTH.unpack_from(raw, cursor)[0]
        packet_offset = cursor + _LENGTH.size
        end = packet_offset + packet_length
        if packet_length > limits.maximum_packet_bytes or end > len(raw):
            raise RecordingError("packets.bin packet is truncated or oversized")
        packet = read_engine_packet(raw[packet_offset:end], limits=limits)
        if packet.kind not in (PacketKind.CHECKPOINT, PacketKind.COMMIT):
            raise RecordingError("packet log contains a non-state packet")
        _validate_packet_progression(previous, packet)
        matrix_pool_state = _advance_matrix_pool_state(matrix_pool_state, packet)
        header = packet.header
        entries.append(
            PacketLogEntry(
                header["stream_id"],
                header["commit_seq"],
                header["source_tick"],
                header["world_revision"],
                header["last_command_seq"],
                packet_offset,
                packet_length,
                packet.kind is PacketKind.CHECKPOINT,
            )
        )
        previous = packet
        cursor = end
    if not entries or not entries[0].checkpoint:
        raise RecordingError("packets.bin does not begin with a checkpoint")
    return tuple(entries)


def _validate_manifest(value: dict[str, Any]) -> None:
    fields = {
        "schema",
        "wire_schema",
        "complete",
        "packet_count",
        "checkpoint_count",
        "packets_bytes",
        "packets_sha256",
        "index_sha256",
        "stream_id",
        "first_commit_seq",
        "last_commit_seq",
        "first_source_tick",
        "last_source_tick",
        "first_command_seq",
        "last_command_seq",
    }
    if set(value) != fields:
        raise RecordingError("packet log manifest fields are invalid")
    if (
        value["schema"] != PACKET_LOG_SCHEMA
        or value["wire_schema"] != WIRE_SCHEMA
        or value["complete"] is not True
        or not isinstance(value["stream_id"], str)
        or not value["stream_id"]
    ):
        raise RecordingError("packet log manifest identity is invalid")
    for field in fields - {
        "schema",
        "wire_schema",
        "complete",
        "packets_sha256",
        "index_sha256",
        "stream_id",
    }:
        item = value[field]
        if (
            isinstance(item, bool)
            or not isinstance(item, int)
            or item < 0
            or item > MAXIMUM_SAFE_INTEGER
        ):
            raise RecordingError(f"packet log manifest {field} is invalid")
    for field in ("packets_sha256", "index_sha256"):
        item = value[field]
        if not isinstance(item, str) or len(item) != 64 or any(c not in "0123456789abcdef" for c in item):
            raise RecordingError(f"packet log manifest {field} is invalid")


def _entry_from_dict(value: Any) -> PacketLogEntry:
    fields = {
        "stream_id",
        "commit_seq",
        "source_tick",
        "world_revision",
        "last_command_seq",
        "offset",
        "packet_length",
        "checkpoint",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise RecordingError("packet log index entry fields are invalid")
    try:
        return PacketLogEntry(**value)
    except (TypeError, RecordingError) as exc:
        raise RecordingError("packet log index entry is invalid") from exc


def _validate_packet_progression(previous, packet) -> None:
    if previous is None:
        if packet.kind is not PacketKind.CHECKPOINT:
            raise RecordingError("packet log must begin with a checkpoint")
        return
    before = previous.header
    current = packet.header
    if current["stream_id"] != before["stream_id"]:
        raise RecordingError("packet log cannot cross streams")
    if packet.kind is PacketKind.CHECKPOINT:
        if any(
            current[field] != before[field]
            for field in (
                "commit_seq",
                "source_tick",
                "world_revision",
                "last_command_seq",
            )
        ):
            raise RecordingError("periodic checkpoint cursor does not match log")
        return
    if (
        current["commit_seq"] != before["commit_seq"] + 1
        or current["world_revision"] != before["world_revision"] + 1
        or current["last_command_seq"] < before["last_command_seq"]
        or _display_command_base(packet) != before["last_command_seq"]
    ):
        raise RecordingError("packet log commit progression has a gap")
    delta = current["source_tick"] - before["source_tick"]
    if not _cause_matches_tick(current["cause"], delta):
        raise RecordingError("packet log cause/tick progression is invalid")


def _cause_matches_tick(cause: str, delta: int) -> bool:
    if cause == "tick":
        return delta == 1
    if cause == "input":
        return delta == 0
    return delta in (0, 1)


def _display_command_base(packet: Any) -> int:
    return _display_payload(packet)["base_command_seq"]


def _advance_matrix_pool_state(
    previous: _MatrixPoolState | None,
    packet: Any,
) -> _MatrixPoolState:
    payload = _display_payload(packet)
    pool_size = payload["matrix_pool_size"]
    if packet.kind is PacketKind.CHECKPOINT:
        active_node_ids = frozenset(node["node_id"] for node in payload["nodes"])
        if previous is None:
            # Every allocated ID outside this set is a historical zero tombstone.
            return _MatrixPoolState(pool_size, active_node_ids)
        if (
            pool_size != previous.pool_size
            or active_node_ids != previous.active_node_ids
        ):
            raise RecordingError(
                "periodic checkpoint matrix pool lifecycle does not match log"
            )
        return previous

    if previous is None:
        raise RecordingError("packet log matrix pool requires an initial checkpoint")
    if pool_size < previous.pool_size:
        raise RecordingError("packet log matrix pool cannot shrink within a stream")

    commands = payload["commands"]
    created_node_ids = tuple(
        sorted(
            command["node_id"]
            for command in commands
            if command["kind"] == "node-create"
        )
    )
    growth = pool_size - previous.pool_size
    if len(created_node_ids) != growth or any(
        node_id != previous.pool_size + offset
        for offset, node_id in enumerate(created_node_ids)
    ):
        raise RecordingError(
            "packet log matrix pool growth must create every new suffix ID"
        )
    if growth > len(payload["dirty_node_ids"]):
        raise RecordingError(
            "packet log matrix pool growth must transmit every new suffix row"
        )
    dirty_node_ids = {int(node_id) for node_id in payload["dirty_node_ids"]}
    if any(
        node_id not in dirty_node_ids for node_id in created_node_ids
    ):
        raise RecordingError(
            "packet log matrix pool growth must transmit every new suffix row"
        )

    active_node_ids = set(previous.active_node_ids)
    for command in commands:
        kind = command["kind"]
        node_id = command["node_id"]
        if kind == "node-create":
            if node_id < previous.pool_size or node_id in active_node_ids:
                raise RecordingError(
                    "packet log node-create cannot reclaim an allocated ID"
                )
            parent_node_id = command["parent_node_id"]
            if parent_node_id is not None and parent_node_id not in active_node_ids:
                raise RecordingError("packet log node-create parent is not active")
            active_node_ids.add(node_id)
            continue
        if node_id not in active_node_ids:
            raise RecordingError("packet log command target is not active")
        if kind == "node-set-parent":
            parent_node_id = command["parent_node_id"]
            if parent_node_id is not None and parent_node_id not in active_node_ids:
                raise RecordingError("packet log node-set-parent parent is not active")
        elif kind == "node-remove":
            active_node_ids.remove(node_id)
    return _MatrixPoolState(pool_size, frozenset(active_node_ids))


def _display_payload(packet: Any) -> Any:
    payload = packet._display_payload
    if not isinstance(payload, dict):
        raise RecordingError("packet log Display payload is unavailable")
    return payload


def _index_integer(value: Any, field: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > MAXIMUM_SAFE_INTEGER
    ):
        raise RecordingError(f"packet log entry {field} is invalid")
    return value


def _json_object(raw: bytes, label: str) -> dict[str, Any]:
    value = _json_value(raw, label)
    if not isinstance(value, dict):
        raise RecordingError(f"{label} must be a JSON object")
    return value


def _json_value(raw: bytes, label: str) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise RecordingError(f"{label} contains duplicate keys")
            result[key] = value
        return result

    try:
        return json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=pairs,
            parse_float=lambda _: (_ for _ in ()).throw(
                RecordingError(f"{label} contains a non-integer number")
            ),
            parse_constant=lambda _: (_ for _ in ()).throw(
                RecordingError(f"{label} contains an invalid number")
            ),
        )
    except RecordingError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecordingError(f"{label} is invalid JSON") from exc


def _canonical_json(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        + b"\n"
    )


def _atomic_write(path: Path, data: bytes, *, fsync: bool) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        if fsync:
            os.fsync(stream.fileno())
    os.replace(temporary, path)


__all__ = [
    "PACKET_LOG_INCOMPLETE",
    "PACKET_LOG_INDEX",
    "PACKET_LOG_MANIFEST",
    "PACKET_LOG_PACKETS",
    "PACKET_LOG_SCHEMA",
    "PacketLog",
    "PacketLogEntry",
    "PacketLogWriter",
    "read_packet_log",
    "rebuild_packet_index",
]
