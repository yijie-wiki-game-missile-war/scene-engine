import { sha256HexBytes } from './hash.js';
import { parseDisplayCheckpoint, parseDisplayCommandStream } from './display.js';
import {
  DEFAULT_ENGINE_LIMITS,
  ENGINE_WIRE_SCHEMA,
  deepFreeze,
  parseCanonicalJSON,
  readEnginePacket,
} from './wire.js';

const LOG_SCHEMA = 'scene-engine-packet-log@2';
const PREFIX_BYTES = 8;
const MANIFEST_FIELDS = Object.freeze([
  'schema', 'wire_schema', 'complete', 'packet_count', 'checkpoint_count',
  'packets_bytes', 'packets_sha256', 'index_sha256', 'stream_id',
  'first_commit_seq', 'last_commit_seq', 'first_source_tick', 'last_source_tick',
  'first_command_seq', 'last_command_seq',
]);
const ENTRY_FIELDS = Object.freeze([
  'stream_id', 'commit_seq', 'source_tick', 'world_revision', 'offset',
  'packet_length', 'checkpoint', 'last_command_seq',
]);

export class PacketLogClientError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PacketLogClientError';
    this.code = code;
  }
}

/** Validate a complete sealed packet log supplied as UTF-8/binary bytes. */
export function readPacketLog({ manifest, index, packets } = {}, limits = DEFAULT_ENGINE_LIMITS) {
  const manifestBytes = ownedBytes(manifest, 'packet-log-manifest-bytes-invalid');
  const indexBytes = ownedBytes(index, 'packet-log-index-bytes-invalid');
  const packetBytes = ownedBytes(packets, 'packet-log-packets-bytes-invalid');
  const manifestValue = parseCanonicalJSON(manifestBytes, {
    maximumDepth: limits.maximumJsonDepth,
  });
  const indexValue = parseCanonicalJSON(indexBytes, {
    maximumDepth: limits.maximumJsonDepth,
  });
  validateManifest(manifestValue);
  if (!Array.isArray(indexValue)) fail('packet-log-index-array-required');
  if (manifestValue.packets_bytes !== packetBytes.byteLength
      || manifestValue.packets_sha256 !== sha256HexBytes(packetBytes)
      || manifestValue.index_sha256 !== sha256HexBytes(indexBytes)) {
    fail('packet-log-hash-or-length-mismatch');
  }

  const records = rebuildRecords(packetBytes, limits);
  const entries = Object.freeze(indexValue.map((value) => validateEntry(value)));
  if (entries.length !== records.length) fail('packet-log-index-count-mismatch');
  for (let cursor = 0; cursor < entries.length; cursor += 1) {
    if (!entryEquals(entries[cursor], records[cursor].entry)) {
      fail('packet-log-index-content-mismatch');
    }
  }
  const first = entries[0]; const last = entries.at(-1);
  const checkpointCount = entries.reduce((count, entry) => count + Number(entry.checkpoint), 0);
  if (manifestValue.packet_count !== entries.length
      || manifestValue.checkpoint_count !== checkpointCount
      || manifestValue.stream_id !== first.stream_id
      || manifestValue.first_commit_seq !== first.commit_seq
      || manifestValue.last_commit_seq !== last.commit_seq
      || manifestValue.first_source_tick !== first.source_tick
      || manifestValue.last_source_tick !== last.source_tick
      || manifestValue.first_command_seq !== first.last_command_seq
      || manifestValue.last_command_seq !== last.last_command_seq) {
    fail('packet-log-manifest-content-mismatch');
  }

  const frozenManifest = deepFreeze(manifestValue);
  const frozenRecords = Object.freeze(records);
  return Object.freeze({
    manifest: frozenManifest,
    entries,
    records: frozenRecords,
    packetAt(recordIndex) {
      if (!Number.isSafeInteger(recordIndex) || recordIndex < 0 || recordIndex >= records.length) {
        fail('packet-log-record-index-invalid');
      }
      return records[recordIndex].rawBytes.slice();
    },
  });
}

function rebuildRecords(bytes, limits) {
  const records = [];
  let cursor = 0;
  let previous = null;
  while (cursor < bytes.byteLength) {
    if (cursor + PREFIX_BYTES > bytes.byteLength) fail('packet-log-prefix-truncated');
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, PREFIX_BYTES);
    const lengthBig = view.getBigUint64(0, true);
    if (lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) fail('packet-log-packet-length-unsafe');
    const packetLength = Number(lengthBig);
    const offset = cursor + PREFIX_BYTES;
    const end = offset + packetLength;
    if (packetLength > limits.maximumPacketBytes || end > bytes.byteLength) {
      fail('packet-log-packet-truncated-or-oversized');
    }
    const rawBytes = bytes.slice(offset, end);
    const packet = readEnginePacket(rawBytes, limits);
    if (!['engine.checkpoint', 'engine.commit'].includes(packet.kind)) {
      fail('packet-log-state-packet-required');
    }
    validateProgression(previous, packet);
    const header = packet.header;
    if (packet.kind === 'engine.checkpoint') {
      parseDisplayCheckpoint(attachment(packet, 'display_checkpoint').value, {
        header,
      });
    } else {
      parseDisplayCommandStream(attachment(packet, 'display_command_stream').value, {
        header,
        baseCommandSeq: previous.header.last_command_seq,
      });
    }
    const entry = Object.freeze({
      stream_id: header.stream_id,
      commit_seq: header.commit_seq,
      source_tick: header.source_tick,
      world_revision: header.world_revision,
      offset,
      packet_length: packetLength,
      checkpoint: packet.kind === 'engine.checkpoint',
      last_command_seq: header.last_command_seq,
    });
    records.push(Object.freeze({ entry, rawBytes, packet }));
    previous = packet;
    cursor = end;
  }
  if (records.length === 0 || !records[0].entry.checkpoint) {
    fail('packet-log-initial-checkpoint-required');
  }
  return records;
}

function validateProgression(previous, packet) {
  if (previous === null) {
    if (packet.kind !== 'engine.checkpoint') fail('packet-log-initial-checkpoint-required');
    return;
  }
  const before = previous.header; const next = packet.header;
  if (next.stream_id !== before.stream_id) fail('packet-log-stream-changed');
  if (packet.kind === 'engine.checkpoint') {
    if (next.commit_seq !== before.commit_seq || next.source_tick !== before.source_tick
        || next.world_revision !== before.world_revision
        || next.last_command_seq !== before.last_command_seq) {
      fail('packet-log-periodic-checkpoint-cursor-mismatch');
    }
    return;
  }
  if (next.commit_seq !== before.commit_seq + 1
      || next.world_revision !== before.world_revision + 1
      || next.last_command_seq < before.last_command_seq) {
    fail('packet-log-commit-gap');
  }
  const tickDelta = next.source_tick - before.source_tick;
  if (next.cause === 'tick' ? tickDelta !== 1
    : next.cause === 'input' ? tickDelta !== 0
      : ![0, 1].includes(tickDelta)) fail('packet-log-tick-progression-invalid');
}

function validateManifest(value) {
  if (!isRecord(value) || !exactKeys(value, MANIFEST_FIELDS)
      || value.schema !== LOG_SCHEMA || value.wire_schema !== ENGINE_WIRE_SCHEMA
      || value.complete !== true || typeof value.stream_id !== 'string' || !value.stream_id) {
    fail('packet-log-manifest-invalid');
  }
  for (const field of [
    'packet_count', 'checkpoint_count', 'packets_bytes', 'first_commit_seq',
    'last_commit_seq', 'first_source_tick', 'last_source_tick',
    'first_command_seq', 'last_command_seq',
  ]) safeInteger(value[field], 'packet-log-manifest-integer-invalid');
  for (const field of ['packets_sha256', 'index_sha256']) {
    if (typeof value[field] !== 'string' || !/^[0-9a-f]{64}$/u.test(value[field])) {
      fail('packet-log-manifest-hash-invalid');
    }
  }
}

function validateEntry(value) {
  if (!isRecord(value) || !exactKeys(value, ENTRY_FIELDS)
      || typeof value.stream_id !== 'string' || !value.stream_id
      || typeof value.checkpoint !== 'boolean') fail('packet-log-index-entry-invalid');
  for (const field of [
    'commit_seq', 'source_tick', 'world_revision', 'offset', 'packet_length',
    'last_command_seq',
  ]) safeInteger(value[field], 'packet-log-index-entry-integer-invalid');
  if (value.packet_length === 0) fail('packet-log-index-entry-length-invalid');
  return Object.freeze({ ...value });
}

function entryEquals(left, right) {
  return ENTRY_FIELDS.every((field) => left[field] === right[field]);
}
function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
}
function exactKeys(value, fields) {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === 'string' && fields.includes(key));
}
function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function attachment(packet, kind) {
  const value = packet.attachments.find((item) => item.kind === kind);
  if (!value) fail(`packet-log-${kind}-missing`);
  return value;
}
function ownedBytes(value, code) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  fail(code);
}
function fail(code) { throw new PacketLogClientError(code); }

export const PACKET_LOG_SCHEMA = LOG_SCHEMA;
