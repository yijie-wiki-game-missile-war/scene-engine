import { COMPONENT_TYPES } from './constants.js';
import { fail } from './errors.js';

const OPTION_KEYS = Object.freeze(new Set([
  'hostElement', 'canvas', 'rendererProfile', 'resourceRegistry', 'onHealth', 'signal',
]));
const PROFILE_KEYS = Object.freeze(new Set([
  'drawMode', 'maximumPixelRatio', 'clearRgba', 'antialias', 'alpha', 'shadows', 'toneMapping',
]));
const CREATE_KEYS = Object.freeze(new Set([
  'nodeName', 'componentKey', 'componentType', 'properties', 'resourceRegistry', 'signal',
]));

export function normalizeOptions(value) {
  const record = exactRecord(value, OPTION_KEYS, 'three-backend-options-invalid');
  for (const key of ['hostElement', 'canvas', 'rendererProfile', 'resourceRegistry']) {
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
    resourceRegistry: record.resourceRegistry,
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
  for (const key of ['nodeName', 'componentKey', 'componentType', 'properties', 'resourceRegistry']) {
    if (!Object.hasOwn(record, key)) fail('three-backend-binding-descriptor-invalid');
  }
  const nodeName = nonemptyString(record.nodeName, 'three-backend-node-name-invalid');
  const componentKey = nonemptyString(record.componentKey, 'three-backend-component-key-invalid');
  if (!COMPONENT_TYPES.has(record.componentType)) fail('three-backend-component-type-invalid');
  if (record.resourceRegistry !== expectedRegistry || !isResourceRegistry(record.resourceRegistry)) {
    fail('three-backend-resource-registry-mismatch');
  }
  if (record.signal !== undefined) assertAbortSignal(record.signal);
  const properties = clonePlainData(record.properties, 'three-backend-component-properties-invalid');
  if (!isPlainRecord(properties)) fail('three-backend-component-properties-invalid');
  return Object.freeze({
    nodeName,
    componentKey,
    componentType: record.componentType,
    properties,
    resourceRegistry: record.resourceRegistry,
    signal: record.signal ?? null,
  });
}

export function normalizeUpdatePatch(value, identity) {
  const record = exactRecord(value, new Set(['identity', 'worldMatrix', 'visible', 'properties']),
    'three-backend-binding-patch-invalid');
  if (Object.keys(record).length !== 4) fail('three-backend-binding-patch-invalid');
  const nextIdentity = exactRecord(record.identity, new Set(['nodeName', 'componentKey']),
    'three-backend-binding-identity-invalid');
  if (Object.keys(nextIdentity).length !== 2 || nextIdentity.nodeName !== identity.nodeName
      || nextIdentity.componentKey !== identity.componentKey) {
    fail('three-backend-binding-identity-mismatch');
  }
  if (typeof record.visible !== 'boolean') fail('three-backend-binding-visibility-invalid');
  const properties = clonePlainData(record.properties, 'three-backend-component-properties-invalid');
  if (!isPlainRecord(properties)) fail('three-backend-component-properties-invalid');
  return Object.freeze({
    identity,
    worldMatrix: Object.freeze(finiteTuple(record.worldMatrix, 16,
      'three-backend-world-matrix-invalid')),
    visible: record.visible,
    properties,
  });
}

export function normalizeFrame(value) {
  const record = exactRecord(value,
    new Set(['sourceTick', 'visualSeconds', 'dirtyBindings', 'activeCameraBinding']),
    'three-backend-frame-invalid');
  if (Object.keys(record).length !== 4 || !Number.isSafeInteger(record.sourceTick)
      || record.sourceTick < 0 || !nonnegativeFinite(record.visualSeconds)
      || !Array.isArray(record.dirtyBindings) || !record.activeCameraBinding
      || typeof record.activeCameraBinding !== 'object') fail('three-backend-frame-invalid');
  return Object.freeze({
    sourceTick: record.sourceTick,
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
  const record = exactRecord(value, new Set(['position', 'radius']), 'three-backend-focus-invalid');
  if (!Object.hasOwn(record, 'position') || !Object.hasOwn(record, 'radius')
      || !nonnegativeFinite(record.radius)) fail('three-backend-focus-invalid');
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
