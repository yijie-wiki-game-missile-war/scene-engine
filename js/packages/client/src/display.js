import { encodeJSON, parseCanonicalJSON } from './wire.js';

export const DISPLAY_CHECKPOINT_SCHEMA = 'scene-engine-display-checkpoint@5';
export const DISPLAY_COMMAND_STREAM_SCHEMA = 'scene-engine-display-command-stream@5';
export const NODE_COMMAND_SCHEMA = 'scene-engine-node-command@5';

const CHECKPOINT_MAGIC = 'SDCP';
const COMMAND_STREAM_MAGIC = 'SDCS';
const BINARY_VERSION = 2;
const FLOAT32_SCALAR = 1;
const NULL_PARENT_INDEX = 0xffffffff;
const NULL_STRING_LENGTH = 0xffff;
const COMMON_HEADER_BYTES = 8;
const MATRIX_LENGTH = 16;
const MATRIX_BYTES = MATRIX_LENGTH * 4;

const OPCODE_BY_KIND = Object.freeze({
  'node-create': 1,
  'node-set-transform': 2,
  'node-set-parent': 3,
  'node-set-visible': 4,
  'node-set-state': 5,
  'node-replace-prefab': 6,
  'node-remove': 7,
});
const KIND_BY_OPCODE = Object.freeze(Object.fromEntries(
  Object.entries(OPCODE_BY_KIND).map(([kind, opcode]) => [opcode, kind]),
));

const AUTHORITY_NAME = /^py\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const SCENE_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const PREFAB_ID = /^[a-z0-9][a-z0-9._@-]*(?:\/[a-z0-9][a-z0-9._@-]*)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });
const OWNED_MATRICES = new WeakSet();

const BASELINE_FIELDS = new Set([
  'name', 'parent_name', 'prefab_id', 'transform_mode',
  'transform', 'visible', 'state',
]);
const COMMAND_BASE_FIELDS = ['schema', 'command_seq', 'source_tick', 'kind', 'name'];
const COMMAND_FIELDS = Object.freeze({
  'node-create': new Set([
    ...COMMAND_BASE_FIELDS, 'parent_name', 'prefab_id', 'transform_mode',
    'transform', 'visible', 'state',
  ]),
  'node-set-transform': new Set([...COMMAND_BASE_FIELDS, 'transform']),
  'node-set-parent': new Set([...COMMAND_BASE_FIELDS, 'parent_name']),
  'node-set-visible': new Set([...COMMAND_BASE_FIELDS, 'visible']),
  'node-set-state': new Set([...COMMAND_BASE_FIELDS, 'state']),
  'node-replace-prefab': new Set([
    ...COMMAND_BASE_FIELDS, 'prefab_id', 'state',
  ]),
  'node-remove': new Set(COMMAND_BASE_FIELDS),
});

export class DisplayRecordError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DisplayRecordError';
    this.code = code;
  }
}

// Parsing creates the matrix buffer and this move operation transfers that unique
// value to the Authority port. Arbitrary typed arrays and legacy TRS objects fail closed.
export function takeOwnedDisplayMatrix(value) {
  if (!OWNED_MATRICES.delete(value)) fail('display-transform-ownership-invalid');
  return value;
}

export function parseDisplayCheckpoint(value, { header, maximumJsonDepth = 256 } = {}) {
  jsonDepth(maximumJsonDepth);
  const reader = new BinaryReader(value, 'display-checkpoint-binary-invalid');
  reader.commonHeader(CHECKPOINT_MAGIC, 'display-checkpoint');
  const encodedLastCommandSeq = reader.u64('display-last-command-seq-invalid');
  const lastCommandSeq = safeInteger(header?.last_command_seq,
    'display-last-command-seq-invalid');
  if (encodedLastCommandSeq !== lastCommandSeq) {
    fail('display-checkpoint-command-cursor-mismatch');
  }
  const sceneName = logicalName(reader.string('display-scene-name-invalid'),
    'display-scene-name-invalid');
  const sceneCatalogHash = reader.hash();
  const prefabCatalogHash = reader.hash();
  const stateSchemaHash = reader.hash();
  const count = reader.u32('display-checkpoint-nodes-invalid');
  const minimumNodeBytes = 2 + 4 + 2 + 1 + MATRIX_BYTES + 4;
  if (count > Math.floor(reader.remaining / minimumNodeBytes)) {
    fail('display-checkpoint-nodes-invalid');
  }
  const nodes = [];
  const seen = new Set();
  const depths = [];
  for (let index = 0; index < count; index += 1) {
    const name = authorityName(reader.string('display-node-name-invalid'),
      'display-node-name-invalid');
    if (seen.has(name)) fail('display-checkpoint-node-duplicate');
    const parentIndex = reader.u32('display-checkpoint-parent-order-invalid');
    if (parentIndex !== NULL_PARENT_INDEX && parentIndex >= index) {
      fail('display-checkpoint-parent-order-invalid');
    }
    const parentName = parentIndex === NULL_PARENT_INDEX ? null : nodes[parentIndex].name;
    const prefab = prefabId(reader.string('display-prefab-id-invalid'));
    const nodeFlags = reader.u8('display-checkpoint-node-flags-invalid');
    if ((nodeFlags & ~0x03) !== 0) fail('display-checkpoint-node-flags-invalid');
    const transform = reader.matrix();
    const state = reader.state(maximumJsonDepth);
    const depth = parentIndex === NULL_PARENT_INDEX ? 1 : depths[parentIndex] + 1;
    if (depth > 128) fail('display-checkpoint-node-depth-limit');
    const node = Object.freeze({
      name,
      parentName,
      prefabId: prefab,
      transformMode: (nodeFlags & 0x02) === 0 ? 'initial' : 'live',
      transform,
      visible: (nodeFlags & 0x01) !== 0,
      state,
    });
    nodes.push(node);
    seen.add(name);
    depths.push(depth);
  }
  reader.done('display-checkpoint-trailing-bytes');
  return Object.freeze({
    schema: DISPLAY_CHECKPOINT_SCHEMA,
    sceneName,
    sceneCatalogHash,
    prefabCatalogHash,
    stateSchemaHash,
    lastCommandSeq,
    nodes: Object.freeze(nodes),
  });
}

export function parseDisplayCommandStream(value, {
  header,
  baseCommandSeq,
  maximumJsonDepth = 256,
} = {}) {
  jsonDepth(maximumJsonDepth);
  const reader = new BinaryReader(value, 'display-command-stream-binary-invalid');
  reader.commonHeader(COMMAND_STREAM_MAGIC, 'display-command-stream');
  const base = reader.u64('display-command-base-invalid');
  const encodedSourceTick = reader.u64('display-command-source-tick-invalid');
  const count = reader.u32('display-command-list-invalid');
  if (count > Math.floor(reader.remaining / 3)) fail('display-command-list-invalid');
  if (base !== baseCommandSeq) fail('display-command-base-mismatch');
  if (base + count > Number.MAX_SAFE_INTEGER) fail('display-command-sequence-invalid');
  const last = base + count;
  if (last !== header?.last_command_seq) fail('display-command-cursor-mismatch');
  const sourceTick = safeInteger(header?.source_tick, 'display-command-source-tick-invalid');
  if (encodedSourceTick !== sourceTick) fail('display-command-source-tick-mismatch');
  const commands = [];
  for (let index = 0; index < count; index += 1) {
    commands.push(readCommand(reader, base + index + 1, sourceTick, maximumJsonDepth));
  }
  reader.done('display-command-stream-trailing-bytes');
  return Object.freeze({
    schema: DISPLAY_COMMAND_STREAM_SCHEMA,
    baseCommandSeq: base,
    lastCommandSeq: last,
    commands: Object.freeze(commands),
  });
}

export function encodeDisplayCheckpoint(value) {
  record(value, 'display-checkpoint-invalid');
  exact(value, new Set([
    'schema', 'scene_name', 'scene_catalog_hash', 'prefab_catalog_hash',
    'state_schema_hash', 'last_command_seq', 'nodes',
  ]), 'display-checkpoint-fields-invalid');
  if (value.schema !== DISPLAY_CHECKPOINT_SCHEMA) fail('display-checkpoint-schema-invalid');
  const sceneName = logicalName(value.scene_name, 'display-scene-name-invalid');
  const sceneCatalogHash = hash(value.scene_catalog_hash, 'display-scene-catalog-hash-invalid');
  const prefabCatalogHash = hash(value.prefab_catalog_hash, 'display-prefab-catalog-hash-invalid');
  const stateSchemaHash = hash(value.state_schema_hash, 'display-state-schema-hash-invalid');
  const lastCommandSeq = safeInteger(value.last_command_seq, 'display-last-command-seq-invalid');
  if (!Array.isArray(value.nodes)) fail('display-checkpoint-nodes-invalid');
  if (value.nodes.length > 0xffffffff) fail('display-checkpoint-nodes-invalid');

  const nodes = normalizeBaselineNodes(value.nodes);
  const indices = new Map(nodes.map((node, index) => [node.name, index]));
  const writer = new BinaryWriter();
  writer.commonHeader(CHECKPOINT_MAGIC);
  writer.u64(lastCommandSeq);
  writer.string(sceneName);
  writer.hash(sceneCatalogHash);
  writer.hash(prefabCatalogHash);
  writer.hash(stateSchemaHash);
  writer.u32(nodes.length);
  for (const node of nodes) {
    writer.string(node.name);
    writer.u32(node.parentName === null ? NULL_PARENT_INDEX : indices.get(node.parentName));
    writer.string(node.prefabId);
    writer.u8((node.visible ? 0x01 : 0) | (node.transformMode === 'live' ? 0x02 : 0));
    writer.matrix(node.transform);
    writer.state(node.state);
  }
  return writer.finish();
}

export function encodeDisplayCommandStream(value, { sourceTick: expectedSourceTick } = {}) {
  record(value, 'display-command-stream-invalid');
  exact(value, new Set([
    'schema', 'base_command_seq', 'last_command_seq', 'commands',
  ]), 'display-command-stream-fields-invalid');
  if (value.schema !== DISPLAY_COMMAND_STREAM_SCHEMA) {
    fail('display-command-stream-schema-invalid');
  }
  const base = safeInteger(value.base_command_seq, 'display-command-base-invalid');
  const last = safeInteger(value.last_command_seq, 'display-last-command-seq-invalid');
  if (!Array.isArray(value.commands)) fail('display-command-list-invalid');
  if (value.commands.length > 0xffffffff || base + value.commands.length > Number.MAX_SAFE_INTEGER
      || last !== base + value.commands.length) {
    fail('display-command-sequence-invalid');
  }
  let sourceTick = expectedSourceTick;
  if (sourceTick === undefined && value.commands.length !== 0) {
    record(value.commands[0], 'display-command-invalid');
    sourceTick = value.commands[0].source_tick;
  }
  sourceTick = safeInteger(sourceTick, 'display-command-source-tick-invalid');
  const commands = value.commands.map((command, index) => normalizeCommand(
    command,
    base + index + 1,
    sourceTick,
  ));
  const writer = new BinaryWriter();
  writer.commonHeader(COMMAND_STREAM_MAGIC);
  writer.u64(base);
  writer.u64(sourceTick);
  writer.u32(commands.length);
  for (const command of commands) writeCommand(writer, command);
  return writer.finish();
}

function normalizeBaselineNodes(values) {
  const seen = new Set();
  const depths = new Map();
  return values.map((node) => {
    const normalized = normalizeBaselineNode(node);
    if (seen.has(normalized.name)) fail('display-checkpoint-node-duplicate');
    if (normalized.parentName !== null && !seen.has(normalized.parentName)) {
      fail('display-checkpoint-parent-order-invalid');
    }
    const depth = normalized.parentName === null
      ? 1
      : depths.get(normalized.parentName) + 1;
    if (depth > 128) fail('display-checkpoint-node-depth-limit');
    seen.add(normalized.name);
    depths.set(normalized.name, depth);
    return normalized;
  });
}

function readCommand(reader, commandSeq, sourceTick, maximumJsonDepth) {
  const opcode = reader.u8('display-command-kind-invalid');
  const kind = KIND_BY_OPCODE[opcode];
  if (kind === undefined) fail('display-command-kind-invalid');
  const name = authorityName(reader.string('display-node-name-invalid'),
    'display-node-name-invalid');
  const common = {
    schema: NODE_COMMAND_SCHEMA,
    commandSeq,
    sourceTick,
    kind,
    name,
  };
  switch (kind) {
    case 'node-create': {
      const parentName = nullableAuthorityName(reader.nullableString('display-parent-name-invalid'));
      const prefab = prefabId(reader.string('display-prefab-id-invalid'));
      const flags = reader.u8('display-command-flags-invalid');
      if ((flags & ~0x03) !== 0) fail('display-command-flags-invalid');
      return Object.freeze({
        ...common,
        parentName,
        prefabId: prefab,
        transformMode: (flags & 0x02) === 0 ? 'initial' : 'live',
        transform: reader.matrix(),
        visible: (flags & 0x01) !== 0,
        state: reader.state(maximumJsonDepth),
      });
    }
    case 'node-set-transform':
      return Object.freeze({ ...common, transform: reader.matrix() });
    case 'node-set-parent':
      return Object.freeze({
        ...common,
        parentName: nullableAuthorityName(reader.nullableString('display-parent-name-invalid')),
      });
    case 'node-set-visible': {
      const visible = reader.u8('display-node-visible-invalid');
      if (visible > 1) fail('display-node-visible-invalid');
      return Object.freeze({ ...common, visible: visible === 1 });
    }
    case 'node-set-state':
      return Object.freeze({ ...common, state: reader.state(maximumJsonDepth) });
    case 'node-replace-prefab':
      return Object.freeze({
        ...common,
        prefabId: prefabId(reader.string('display-prefab-id-invalid')),
        state: reader.state(maximumJsonDepth),
      });
    case 'node-remove':
      return Object.freeze(common);
    default:
      fail('display-command-kind-invalid');
  }
}

function writeCommand(writer, command) {
  writer.u8(OPCODE_BY_KIND[command.kind]);
  writer.string(command.name);
  switch (command.kind) {
    case 'node-create':
      writer.nullableString(command.parentName);
      writer.string(command.prefabId);
      writer.u8((command.visible ? 0x01 : 0) | (command.transformMode === 'live' ? 0x02 : 0));
      writer.matrix(command.transform);
      writer.state(command.state);
      break;
    case 'node-set-transform':
      writer.matrix(command.transform);
      break;
    case 'node-set-parent':
      writer.nullableString(command.parentName);
      break;
    case 'node-set-visible':
      writer.u8(command.visible ? 1 : 0);
      break;
    case 'node-set-state':
      writer.state(command.state);
      break;
    case 'node-replace-prefab':
      writer.string(command.prefabId);
      writer.state(command.state);
      break;
    case 'node-remove':
      break;
    default:
      fail('display-command-kind-invalid');
  }
}

function normalizeBaselineNode(value) {
  record(value, 'display-checkpoint-node-invalid');
  exact(value, BASELINE_FIELDS, 'display-checkpoint-node-fields-invalid');
  return Object.freeze({
    name: authorityName(value.name, 'display-node-name-invalid'),
    parentName: nullableAuthorityName(value.parent_name),
    prefabId: prefabId(value.prefab_id),
    transformMode: transformMode(value.transform_mode),
    transform: normalizeMatrix(value.transform),
    visible: boolean(value.visible, 'display-node-visible-invalid'),
    state: normalizeState(value.state),
  });
}

function normalizeCommand(value, expectedSequence, sourceTick) {
  record(value, 'display-command-invalid');
  const fields = COMMAND_FIELDS[value.kind];
  if (!fields) fail('display-command-kind-invalid');
  exact(value, fields, 'display-command-fields-invalid');
  if (value.schema !== NODE_COMMAND_SCHEMA) fail('display-command-schema-invalid');
  if (safeInteger(value.command_seq, 'display-command-seq-invalid') !== expectedSequence) {
    fail('display-command-sequence-invalid');
  }
  if (safeInteger(value.source_tick, 'display-command-source-tick-invalid') !== sourceTick) {
    fail('display-command-source-tick-mismatch');
  }
  const common = {
    schema: NODE_COMMAND_SCHEMA,
    commandSeq: expectedSequence,
    sourceTick,
    kind: value.kind,
    name: authorityName(value.name, 'display-node-name-invalid'),
  };
  switch (value.kind) {
    case 'node-create':
      return Object.freeze({
        ...common,
        parentName: nullableAuthorityName(value.parent_name),
        prefabId: prefabId(value.prefab_id),
        transformMode: transformMode(value.transform_mode),
        transform: normalizeMatrix(value.transform),
        visible: boolean(value.visible, 'display-node-visible-invalid'),
        state: normalizeState(value.state),
      });
    case 'node-set-transform':
      return Object.freeze({ ...common, transform: normalizeMatrix(value.transform) });
    case 'node-set-parent':
      return Object.freeze({
        ...common,
        parentName: nullableAuthorityName(value.parent_name),
      });
    case 'node-set-visible':
      return Object.freeze({
        ...common,
        visible: boolean(value.visible, 'display-node-visible-invalid'),
      });
    case 'node-set-state':
      return Object.freeze({ ...common, state: normalizeState(value.state) });
    case 'node-replace-prefab':
      return Object.freeze({
        ...common,
        prefabId: prefabId(value.prefab_id),
        state: normalizeState(value.state),
      });
    case 'node-remove':
      return Object.freeze(common);
    default:
      fail('display-command-kind-invalid');
  }
}

function normalizeMatrix(value) {
  if (!(value instanceof Float32Array) || value.length !== MATRIX_LENGTH) {
    fail('display-transform-matrix-invalid');
  }
  for (let index = 0; index < MATRIX_LENGTH; index += 1) {
    if (!Number.isFinite(value[index])) fail('display-transform-matrix-invalid');
  }
  if (value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1) {
    fail('display-transform-matrix-invalid');
  }
  const determinant = value[0] * (value[5] * value[10] - value[9] * value[6])
    - value[4] * (value[1] * value[10] - value[9] * value[2])
    + value[8] * (value[1] * value[6] - value[5] * value[2]);
  if (!Number.isFinite(determinant) || determinant <= 0) {
    fail('display-transform-matrix-invalid');
  }
  return value;
}

function normalizeState(value) {
  record(value, 'display-node-state-invalid');
  return cloneAndFreeze(value);
}

function cloneAndFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = cloneAndFreeze(item);
  return Object.freeze(result);
}

function authorityName(value, code) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !AUTHORITY_NAME.test(value)) fail(code);
  return value;
}

function nullableAuthorityName(value) {
  return value === null ? null : authorityName(value, 'display-parent-name-invalid');
}

function logicalName(value, code) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 96
      || !SCENE_NAME.test(value)) fail(code);
  return value;
}

function prefabId(value) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !PREFAB_ID.test(value)) fail('display-prefab-id-invalid');
  return value;
}

function transformMode(value) {
  if (!['initial', 'live'].includes(value)) fail('display-transform-mode-invalid');
  return value;
}

function hash(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function boolean(value, code) {
  if (typeof value !== 'boolean') fail(code);
  return value;
}

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function jsonDepth(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('display-json-depth-invalid');
  return value;
}

class BinaryReader {
  constructor(value, code) {
    if (!(value instanceof Uint8Array)) fail(code);
    this.bytes = value;
    this.view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    this.offset = 0;
  }

  get remaining() { return this.bytes.byteLength - this.offset; }

  commonHeader(expectedMagic, prefix) {
    this.require(COMMON_HEADER_BYTES, `${prefix}-header-truncated`);
    let magic = '';
    for (let index = 0; index < 4; index += 1) magic += String.fromCharCode(this.view.getUint8(index));
    if (magic !== expectedMagic) fail(`${prefix}-magic-invalid`);
    this.offset = 4;
    if (this.u8(`${prefix}-version-invalid`) !== BINARY_VERSION) {
      fail(`${prefix}-version-invalid`);
    }
    if (this.u8(`${prefix}-scalar-invalid`) !== FLOAT32_SCALAR) {
      fail(`${prefix}-scalar-invalid`);
    }
    if (this.u16(`${prefix}-flags-invalid`) !== 0) fail(`${prefix}-flags-invalid`);
  }

  u8(code) {
    this.require(1, code);
    const result = this.view.getUint8(this.offset);
    this.offset += 1;
    return result;
  }

  u16(code) {
    this.require(2, code);
    const result = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return result;
  }

  u32(code) {
    this.require(4, code);
    const result = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return result;
  }

  u64(code) {
    this.require(8, code);
    const result = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
    return Number(result);
  }

  string(code) {
    const length = this.u16(code);
    if (length === NULL_STRING_LENGTH) fail(code);
    return this.stringBytes(length, code);
  }

  nullableString(code) {
    const length = this.u16(code);
    return length === NULL_STRING_LENGTH ? null : this.stringBytes(length, code);
  }

  stringBytes(length, code) {
    const bytes = this.take(length, code);
    try {
      return DECODER.decode(bytes);
    } catch {
      fail(code);
    }
  }

  hash() {
    const bytes = this.take(32, 'display-catalog-hash-truncated');
    let result = '';
    for (const value of bytes) result += value.toString(16).padStart(2, '0');
    return result;
  }

  matrix() {
    this.require(MATRIX_BYTES, 'display-transform-matrix-truncated');
    // Allocate a standalone buffer: Authority never observes a view into the packet bytes.
    const result = new Float32Array(MATRIX_LENGTH);
    for (let index = 0; index < MATRIX_LENGTH; index += 1) {
      const value = this.view.getFloat32(this.offset, true);
      this.offset += 4;
      if (!Number.isFinite(value)) fail('display-transform-matrix-invalid');
      result[index] = value === 0 ? 0 : value;
    }
    normalizeMatrix(result);
    OWNED_MATRICES.add(result);
    return result;
  }

  state(maximumJsonDepth) {
    const length = this.u32('display-state-length-invalid');
    const value = parseCanonicalJSON(this.take(length, 'display-state-truncated'), {
      maximumDepth: maximumJsonDepth,
    });
    return normalizeState(value);
  }

  take(length, code) {
    this.require(length, code);
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  require(length, code) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
      fail(code);
    }
  }

  done(code) {
    if (this.offset !== this.bytes.byteLength) fail(code);
  }
}

class BinaryWriter {
  constructor() {
    this.bytes = new Uint8Array(1024);
    this.view = new DataView(this.bytes.buffer);
    this.offset = 0;
  }

  commonHeader(magic) {
    this.raw(ENCODER.encode(magic));
    this.u8(BINARY_VERSION);
    this.u8(FLOAT32_SCALAR);
    this.u16(0);
  }

  u8(value) {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  u16(value) {
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value) {
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  u64(value) {
    this.ensure(8);
    this.view.setBigUint64(this.offset, BigInt(value), true);
    this.offset += 8;
  }

  string(value) {
    const bytes = ENCODER.encode(value);
    if (bytes.byteLength >= NULL_STRING_LENGTH) fail('display-string-byte-limit');
    this.u16(bytes.byteLength);
    this.raw(bytes);
  }

  nullableString(value) {
    if (value === null) {
      this.u16(NULL_STRING_LENGTH);
      return;
    }
    this.string(value);
  }

  hash(value) {
    const bytes = new Uint8Array(32);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    this.raw(bytes);
  }

  matrix(value) {
    normalizeMatrix(value);
    this.ensure(MATRIX_BYTES);
    for (let index = 0; index < MATRIX_LENGTH; index += 1) {
      const entry = value[index];
      this.view.setFloat32(this.offset, entry === 0 ? 0 : entry, true);
      this.offset += 4;
    }
  }

  state(value) {
    const bytes = encodeJSON(value, { sortKeys: true });
    if (bytes.byteLength > 0xffffffff) fail('display-state-length-invalid');
    this.u32(bytes.byteLength);
    this.raw(bytes);
  }

  raw(value) {
    this.ensure(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }

  ensure(length) {
    const required = this.offset + length;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  finish() {
    return this.bytes.slice(0, this.offset);
  }
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
}

function exact(value, fields, code) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size
      || keys.some((key) => typeof key !== 'string' || !fields.has(key))) fail(code);
}

function fail(code) { throw new DisplayRecordError(code); }
