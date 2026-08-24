import { fail } from './runtime/health.js';

export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function plainRecord(value, code) {
  if (!isPlainRecord(value)) fail(code);
  return value;
}

export function exactKeys(value, required, optional, code) {
  const record = plainRecord(value, code);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(code);
  for (const key of required) if (!Object.hasOwn(record, key)) fail(code);
  return record;
}

export function nonemptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

export function finiteNumber(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code);
  return value;
}

export function safeInteger(value, code, { minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export function booleanValue(value, code) {
  if (typeof value !== 'boolean') fail(code);
  return value;
}

export function enumValue(value, allowed, code) {
  if (!allowed.includes(value)) fail(code);
  return value;
}

export function tuple(value, length, code) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) fail(code);
  if (value.length !== length) fail(code);
  return Array.from(value, (entry) => finiteNumber(entry, code));
}

export function assertSynchronous(result, code) {
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
      && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    fail(code);
  }
  return result;
}

export function clonePlainData(value, code = 'display-data-invalid', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteNumber(value, code);
  if (typeof value === 'bigint') return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value, (entry) => clonePlainData(entry, code, seen));
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(code);
    seen.add(value);
    const result = value.map((entry) => clonePlainData(entry, code, seen));
    seen.delete(value);
    return result;
  }
  if (!isPlainRecord(value) || seen.has(value)) fail(code);
  seen.add(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = clonePlainData(entry, code, seen);
  }
  seen.delete(value);
  return result;
}

export function deepFreeze(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

export function cloneAndFreeze(value, code = 'display-data-invalid') {
  return deepFreeze(clonePlainData(value, code));
}

export function objectHasOwnMethod(prototype, names) {
  return names.find((name) => Object.hasOwn(prototype, name));
}

export function hasPrefix(name, prefix) {
  return name.startsWith(`${prefix}/`);
}
