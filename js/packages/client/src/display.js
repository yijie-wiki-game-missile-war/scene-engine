export const DISPLAY_CHECKPOINT_SCHEMA = 'scene-engine-display-checkpoint@3';
export const DISPLAY_COMMAND_STREAM_SCHEMA = 'scene-engine-display-command-stream@3';
export const NODE_COMMAND_SCHEMA = 'scene-engine-node-command@3';

const AUTHORITY_NAME = /^py\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const SCENE_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const PREFAB_ID = /^[a-z0-9][a-z0-9._@-]*(?:\/[a-z0-9][a-z0-9._@-]*)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ENCODER = new TextEncoder();

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

export function parseDisplayCheckpoint(value, { header } = {}) {
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
  const lastCommandSeq = safeInteger(
    value.last_command_seq,
    'display-last-command-seq-invalid',
  );
  if (lastCommandSeq !== header?.last_command_seq) {
    fail('display-checkpoint-command-cursor-mismatch');
  }
  if (!Array.isArray(value.nodes)) fail('display-checkpoint-nodes-invalid');
  const seen = new Set();
  const depths = new Map();
  const nodes = value.nodes.map((node) => {
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
} = {}) {
  record(value, 'display-command-stream-invalid');
  exact(value, new Set([
    'schema', 'base_command_seq', 'last_command_seq', 'commands',
  ]), 'display-command-stream-fields-invalid');
  if (value.schema !== DISPLAY_COMMAND_STREAM_SCHEMA) {
    fail('display-command-stream-schema-invalid');
  }
  const base = safeInteger(value.base_command_seq, 'display-command-base-invalid');
  const last = safeInteger(value.last_command_seq, 'display-last-command-seq-invalid');
  if (base !== baseCommandSeq) fail('display-command-base-mismatch');
  if (last !== header?.last_command_seq) fail('display-command-cursor-mismatch');
  if (!Array.isArray(value.commands)) fail('display-command-list-invalid');
  if (base + value.commands.length > Number.MAX_SAFE_INTEGER
      || last !== base + value.commands.length) {
    fail('display-command-sequence-invalid');
  }
  const commands = value.commands.map((command, index) => normalizeCommand(
    command,
    base + index + 1,
    header.source_tick,
  ));
  return Object.freeze({
    schema: DISPLAY_COMMAND_STREAM_SCHEMA,
    baseCommandSeq: base,
    lastCommandSeq: last,
    commands: Object.freeze(commands),
  });
}

function normalizeBaselineNode(value) {
  record(value, 'display-checkpoint-node-invalid');
  exact(value, BASELINE_FIELDS, 'display-checkpoint-node-fields-invalid');
  return Object.freeze({
    name: authorityName(value.name, 'display-node-name-invalid'),
    parentName: nullableAuthorityName(value.parent_name),
    prefabId: prefabId(value.prefab_id),
    transformMode: transformMode(value.transform_mode),
    transform: normalizeTransform(value.transform),
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
        transform: normalizeTransform(value.transform),
        visible: boolean(value.visible, 'display-node-visible-invalid'),
        state: normalizeState(value.state),
      });
    case 'node-set-transform':
      return Object.freeze({ ...common, transform: normalizeTransform(value.transform) });
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

function normalizeTransform(value) {
  record(value, 'display-transform-invalid');
  exact(value, new Set(['position', 'rotationXyzw', 'scale']), 'display-transform-fields-invalid');
  const position = vector(value.position, 3, 'display-position-invalid');
  const rotation = vector(value.rotationXyzw, 4, 'display-rotation-invalid');
  const scale = vector(value.scale, 3, 'display-scale-invalid');
  if (scale.some((item) => item <= 0)) fail('display-scale-invalid');
  const magnitude = Math.hypot(...rotation);
  if (!Number.isFinite(magnitude) || magnitude === 0) fail('display-rotation-invalid');
  return Object.freeze({
    position,
    rotationXyzw: Object.freeze(rotation.map((item) => item / magnitude)),
    scale,
  });
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

function vector(value, length, code) {
  if (!Array.isArray(value) || value.length !== length
      || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    fail(code);
  }
  return Object.freeze([...value]);
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
