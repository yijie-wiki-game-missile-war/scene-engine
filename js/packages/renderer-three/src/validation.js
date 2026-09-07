import {
  COMPONENT_TYPES,
  COMPOSED_COMPONENT_TYPES,
  RENDER_COMPOSITION_SCHEMA,
} from './constants.js';
import { fail } from './errors.js';

const OPTION_KEYS = Object.freeze(new Set([
  'hostElement', 'canvas', 'rendererProfile', 'compositionPlan', 'resourceRegistry', 'onHealth',
  'signal', 'generatedTextureSource',
]));
const PROFILE_KEYS = Object.freeze(new Set([
  'drawMode', 'maximumPixelRatio', 'clearRgba', 'antialias', 'alpha', 'shadows', 'toneMapping',
]));
const CREATE_KEYS = Object.freeze(new Set([
  'nodeName', 'componentKey', 'componentType', 'properties', 'batchable', 'compositionGroup',
  'resourceRegistry', 'signal',
]));

const COMPOSITION_PASS_KINDS = Object.freeze(['protected-base', 'ordinary', 'foreground']);
const MAXIMUM_COMPOSITION_GROUPS = 30;

export const MAX_PROXIMITY_RADIUS_PIXELS = 256;

export function normalizeOptions(value) {
  const record = exactRecord(value, OPTION_KEYS, 'three-backend-options-invalid');
  for (const key of ['hostElement', 'canvas', 'rendererProfile', 'compositionPlan',
    'resourceRegistry']) {
    if (!Object.hasOwn(record, key)) fail('three-backend-options-invalid');
  }
  const hostElement = record.hostElement;
  const canvas = record.canvas;
  if (!hostElement || typeof hostElement.getBoundingClientRect !== 'function') {
    fail('three-backend-host-invalid');
  }
  if (!canvas || typeof canvas.getContext !== 'function') fail('three-backend-canvas-invalid');
  if (!isResourceRegistry(record.resourceRegistry)) fail('three-backend-resource-registry-invalid');
  if (record.onHealth !== undefined && record.onHealth !== null
      && typeof record.onHealth !== 'function') fail('three-backend-health-listener-invalid');
  if (record.signal !== undefined) assertAbortSignal(record.signal);
  return Object.freeze({
    hostElement,
    canvas,
    rendererProfile: normalizeRendererProfile(record.rendererProfile),
    compositionPlan: normalizeCompositionPlan(record.compositionPlan),
    resourceRegistry: record.resourceRegistry,
    generatedTextureSource: record.generatedTextureSource ?? null,
    onHealth: record.onHealth ?? null,
    signal: record.signal ?? null,
  });
}

export function normalizeRendererProfile(value) {
  const record = exactRecord(value, PROFILE_KEYS, 'three-backend-renderer-profile-invalid');
  if (Object.keys(record).length !== PROFILE_KEYS.size) fail('three-backend-renderer-profile-invalid');
  if (!['requested', 'continuous'].includes(record.drawMode)
      || !positiveFinite(record.maximumPixelRatio)
      || !Number.isSafeInteger(record.clearRgba) || record.clearRgba < 0
      || record.clearRgba > 0xffff_ffff
      || typeof record.antialias !== 'boolean' || typeof record.alpha !== 'boolean'
      || typeof record.shadows !== 'boolean'
      || !['none', 'aces-filmic'].includes(record.toneMapping)) {
    fail('three-backend-renderer-profile-invalid');
  }
  return Object.freeze({ ...record });
}

export function normalizeCreateDescriptor(value, expectedRegistry) {
  const record = exactRecord(value, CREATE_KEYS, 'three-backend-binding-descriptor-invalid');
  for (const key of ['nodeName', 'componentKey', 'componentType', 'properties', 'compositionGroup',
    'resourceRegistry']) {
    if (!Object.hasOwn(record, key)) fail('three-backend-binding-descriptor-invalid');
  }
  const nodeName = nonemptyString(record.nodeName, 'three-backend-node-name-invalid');
  const componentKey = nonemptyString(record.componentKey, 'three-backend-component-key-invalid');
  if (!COMPONENT_TYPES.has(record.componentType)) fail('three-backend-component-type-invalid');
  if (typeof record.batchable !== 'boolean') fail('three-backend-batchable-invalid');
  if (record.resourceRegistry !== expectedRegistry || !isResourceRegistry(record.resourceRegistry)) {
    fail('three-backend-resource-registry-mismatch');
  }
  if (record.signal !== undefined) assertAbortSignal(record.signal);
  const properties = clonePlainData(record.properties, 'three-backend-component-properties-invalid');
  if (!isPlainRecord(properties)) fail('three-backend-component-properties-invalid');
  const compositionGroup = normalizeCompositionGroup(record.componentType, record.compositionGroup);
  return Object.freeze({
    nodeName,
    componentKey,
    componentType: record.componentType,
    properties,
    batchable: record.batchable,
    compositionGroup,
    resourceRegistry: record.resourceRegistry,
    signal: record.signal ?? null,
  });
}

export function normalizeUpdatePatch(value, identity, componentType) {
  const record = exactRecord(value, new Set(['identity', 'worldMatrix', 'panelAnchorWorld',
    'visible', 'batchable', 'compositionGroup', 'properties']),
  'three-backend-binding-patch-invalid');
  if (Object.keys(record).length !== 7) fail('three-backend-binding-patch-invalid');
  const nextIdentity = exactRecord(record.identity, new Set(['nodeName', 'componentKey']),
    'three-backend-binding-identity-invalid');
  if (Object.keys(nextIdentity).length !== 2 || nextIdentity.nodeName !== identity.nodeName
      || nextIdentity.componentKey !== identity.componentKey) {
    fail('three-backend-binding-identity-mismatch');
  }
  if (typeof record.visible !== 'boolean') fail('three-backend-binding-visibility-invalid');
  if (typeof record.batchable !== 'boolean') fail('three-backend-batchable-invalid');
  const properties = clonePlainData(record.properties, 'three-backend-component-properties-invalid');
  if (!isPlainRecord(properties)) fail('three-backend-component-properties-invalid');
  return Object.freeze({
    identity,
    worldMatrix: Object.freeze(finiteTuple(record.worldMatrix, 16,
      'three-backend-world-matrix-invalid')),
    panelAnchorWorld: record.panelAnchorWorld === null ? null
      : Object.freeze(finiteTuple(record.panelAnchorWorld, 3, 'three-backend-panel-anchor-invalid')),
    visible: record.visible,
    batchable: record.batchable,
    compositionGroup: normalizeCompositionGroup(componentType, record.compositionGroup),
    properties,
  });
}

export function normalizeCompositionPlan(value) {
  if (value === null) return null;
  const record = exactRecord(value, new Set([
    'schema', 'id', 'revision', 'defaultGroup', 'groups', 'passes',
  ]), 'three-backend-composition-plan-invalid');
  if (Object.keys(record).length !== 6 || record.schema !== RENDER_COMPOSITION_SCHEMA
      || typeof record.id !== 'string' || record.id.length === 0 || record.id.trim() !== record.id
      || !Number.isSafeInteger(record.revision) || record.revision < 0
      || !Array.isArray(record.groups) || record.groups.length === 0
      || record.groups.length > MAXIMUM_COMPOSITION_GROUPS
      || !Array.isArray(record.passes) || record.passes.length !== COMPOSITION_PASS_KINDS.length) {
    fail('three-backend-composition-plan-invalid');
  }
  const groups = record.groups.map((value) => {
    const entry = exactRecord(value, new Set(['id']), 'three-backend-composition-group-invalid');
    if (Object.keys(entry).length !== 1) fail('three-backend-composition-group-invalid');
    return Object.freeze({ id: nonemptyString(entry.id, 'three-backend-composition-group-invalid') });
  });
  const groupIds = new Set(groups.map((entry) => entry.id));
  if (groupIds.size !== groups.length) fail('three-backend-composition-group-duplicate');
  const assigned = new Set();
  const passIds = new Set();
  const passes = record.passes.map((value, index) => {
    const entry = exactRecord(value, new Set(['id', 'kind', 'groups']),
      'three-backend-composition-pass-invalid');
    if (Object.keys(entry).length !== 3 || typeof entry.id !== 'string' || entry.id.length === 0
        || entry.id.trim() !== entry.id || passIds.has(entry.id)
        || entry.kind !== COMPOSITION_PASS_KINDS[index]
        || !Array.isArray(entry.groups) || entry.groups.length === 0) {
      fail('three-backend-composition-pass-invalid');
    }
    passIds.add(entry.id);
    const passGroups = entry.groups.map((group) => nonemptyString(
      group, 'three-backend-composition-group-invalid',
    ));
    if (new Set(passGroups).size !== passGroups.length) {
      fail('three-backend-composition-group-duplicate');
    }
    for (const group of passGroups) {
      if (!groupIds.has(group)) fail('three-backend-composition-group-missing');
      if (assigned.has(group)) fail('three-backend-composition-group-duplicate');
      assigned.add(group);
    }
    return Object.freeze({ id: entry.id, kind: entry.kind, groups: Object.freeze(passGroups) });
  });
  if (assigned.size !== groupIds.size) fail('three-backend-composition-group-unassigned');
  const defaultGroup = nonemptyString(record.defaultGroup,
    'three-backend-composition-default-group-invalid');
  if (!groupIds.has(defaultGroup)) fail('three-backend-composition-default-group-invalid');
  return Object.freeze({
    schema: RENDER_COMPOSITION_SCHEMA,
    id: record.id,
    revision: record.revision,
    defaultGroup,
    groups: Object.freeze(groups),
    passes: Object.freeze(passes),
  });
}

function normalizeCompositionGroup(componentType, value) {
  if (COMPOSED_COMPONENT_TYPES.has(componentType)) {
    if (value === null) return null;
    return nonemptyString(value, 'three-backend-composition-group-invalid');
  }
  if (value !== null) fail('three-backend-composition-group-invalid');
  return null;
}

export function normalizeFrame(value) {
  const record = exactRecord(value,
    new Set(['sourceTick', 'visualSeconds', 'visualTimes', 'dirtyBindings', 'activeCameraBinding']),
    'three-backend-frame-invalid');
  if (Object.keys(record).length !== (record.visualTimes ? 5 : 4) || !Number.isSafeInteger(record.sourceTick)
      || record.sourceTick < 0 || !nonnegativeFinite(record.visualSeconds)
      || !Array.isArray(record.dirtyBindings) || !record.activeCameraBinding
      || typeof record.activeCameraBinding !== 'object') fail('three-backend-frame-invalid');
  if (record.visualTimes !== undefined) {
    if (!isPlainRecord(record.visualTimes)) fail('three-backend-frame-invalid');
    for (const time of Object.values(record.visualTimes)) {
      if (!isPlainRecord(time) || Object.keys(time).length !== 2 || !nonnegativeFinite(time.seconds) || typeof time.running !== 'boolean') fail('three-backend-frame-invalid');
    }
  }
  return Object.freeze({
    sourceTick: record.sourceTick,
    ...(record.visualTimes ? { visualTimes: record.visualTimes } : {}),
    visualSeconds: record.visualSeconds,
    dirtyBindings: record.dirtyBindings,
    activeCameraBinding: record.activeCameraBinding,
  });
}

export function normalizePoint(value, code = 'three-backend-point-invalid') {
  const record = exactRecord(value, new Set(['position']), code);
  if (Object.keys(record).length !== 1) fail(code);
  return Object.freeze({ position: Object.freeze(finiteTuple(record.position, 3, code)) });
}

export function normalizeFocus(value) {
  const code = 'three-backend-focus-invalid';
  const record = exactRecord(value, new Set(['position', 'radius', 'halfExtents']), code);
  if (!Object.hasOwn(record, 'position') || Object.hasOwn(record, 'radius') === Object.hasOwn(record, 'halfExtents')) fail(code);
  if (Object.hasOwn(record, 'halfExtents')) {
    const halfExtents = finiteTuple(record.halfExtents, 3, code);
    if (halfExtents.some((extent) => extent < 0)) fail(code);
    return Object.freeze({ position: Object.freeze(finiteTuple(record.position, 3, code)),
      halfExtents: Object.freeze(halfExtents) });
  }
  if (!nonnegativeFinite(record.radius)) fail(code);
  return Object.freeze({
    position: Object.freeze(finiteTuple(record.position, 3, 'three-backend-focus-invalid')),
    radius: record.radius,
  });
}

export function normalizePick(value) {
  const record = exactRecord(value, new Set(['clientX', 'clientY']), 'three-backend-pick-invalid');
  if (Object.keys(record).length !== 2 || !finite(record.clientX) || !finite(record.clientY)) {
    fail('three-backend-pick-invalid');
  }
  return Object.freeze({ clientX: record.clientX, clientY: record.clientY });
}

export function normalizeScreenPoint(value) {
  const record = exactRecord(value, new Set(['clientX', 'clientY']),
    'three-backend-screen-point-invalid');
  if (Object.keys(record).length !== 2 || !finite(record.clientX) || !finite(record.clientY)) {
    fail('three-backend-screen-point-invalid');
  }
  return Object.freeze({ clientX: record.clientX, clientY: record.clientY });
}

export function normalizeProximity(value) {
  const record = exactRecord(value, new Set(['clientX', 'clientY', 'radiusPixels']),
    'three-backend-proximity-invalid');
  if (Object.keys(record).length !== 3 || !finite(record.clientX) || !finite(record.clientY)
      || !nonnegativeFinite(record.radiusPixels)
      || record.radiusPixels > MAX_PROXIMITY_RADIUS_PIXELS) {
    fail('three-backend-proximity-invalid');
  }
  return Object.freeze({
    clientX: record.clientX,
    clientY: record.clientY,
    radiusPixels: record.radiusPixels === 0 ? 0 : record.radiusPixels,
  });
}

export function clonePlainData(value, code, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (typeof value === 'bigint') return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Object.freeze(Array.from(value, (entry) => clonePlainData(entry, code, seen)));
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(code);
    seen.add(value);
    const result = Object.freeze(value.map((entry) => clonePlainData(entry, code, seen)));
    seen.delete(value);
    return result;
  }
  if (!isPlainRecord(value) || seen.has(value)) fail(code);
  seen.add(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) result[key] = clonePlainData(entry, code, seen);
  seen.delete(value);
  return Object.freeze(result);
}

export function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactRecord(value, keys, code) {
  if (!isPlainRecord(value)) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.has(key)) fail(code);
  }
  return value;
}

export function finiteTuple(value, length, code) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== length) fail(code);
  const result = Array.from(value);
  if (!result.every(finite)) fail(code);
  return result;
}

export function nonemptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

export function assertAbortSignal(value) {
  if (!value || typeof value !== 'object' || typeof value.aborted !== 'boolean'
      || typeof value.addEventListener !== 'function'
      || typeof value.removeEventListener !== 'function') fail('three-backend-abort-signal-invalid');
  return value;
}

export function stableData(value) {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? `${entry}n` : entry);
}

function isResourceRegistry(value) {
  return value && typeof value.require === 'function' && typeof value.get === 'function';
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function positiveFinite(value) { return finite(value) && value > 0; }
function nonnegativeFinite(value) { return finite(value) && value >= 0; }
