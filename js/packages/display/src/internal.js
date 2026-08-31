import { fail } from './runtime/health.js';

const PROTOCOL_NAME_ENCODER = new TextEncoder();
const DANGEROUS_PROTOCOL_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const MAXIMUM_PROTOCOL_NAME_BYTES = 192;
// Protocol-fixed Unicode 16.0 White_Space + Cc/Cf/Cs/Co ranges. Cn stays
// allowed so host Unicode database upgrades cannot change catalog identity.
const FORBIDDEN_PROTOCOL_NAME_CODE_POINT_RANGES = Object.freeze([
  [0x000000, 0x000020], [0x00007f, 0x0000a0], [0x0000ad, 0x0000ad],
  [0x000600, 0x000605], [0x00061c, 0x00061c], [0x0006dd, 0x0006dd],
  [0x00070f, 0x00070f], [0x000890, 0x000891], [0x0008e2, 0x0008e2],
  [0x001680, 0x001680], [0x00180e, 0x00180e], [0x002000, 0x00200f],
  [0x002028, 0x00202f], [0x00205f, 0x002064], [0x002066, 0x00206f],
  [0x003000, 0x003000], [0x00d800, 0x00f8ff], [0x00feff, 0x00feff],
  [0x00fff9, 0x00fffb], [0x0110bd, 0x0110bd], [0x0110cd, 0x0110cd],
  [0x013430, 0x01343f], [0x01bca0, 0x01bca3], [0x01d173, 0x01d17a],
  [0x0e0001, 0x0e0001], [0x0e0020, 0x0e007f], [0x0f0000, 0x0ffffd],
  [0x100000, 0x10fffd],
]);
const MAXIMUM_JSON_DEPTH = 256;

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

/** Closed wire-level property/event name shared by Definitions and Authority. */
export function protocolName(value, code) {
  if (typeof value !== 'string' || value.length === 0
      || PROTOCOL_NAME_ENCODER.encode(value).byteLength > MAXIMUM_PROTOCOL_NAME_BYTES
      || containsForbiddenProtocolNameCodePoint(value)
      || DANGEROUS_PROTOCOL_NAMES.has(value)) {
    fail(code);
  }
  return value;
}

function containsForbiddenProtocolNameCodePoint(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0xfdd0 && codePoint <= 0xfdef)
        || (codePoint & 0xffff) === 0xfffe || (codePoint & 0xffff) === 0xffff
        || FORBIDDEN_PROTOCOL_NAME_CODE_POINT_RANGES.some(
          ([start, end]) => codePoint >= start && codePoint <= end,
        )) return true;
  }
  return false;
}

export function compareUtf8Strings(left, right) {
  const a = PROTOCOL_NAME_ENCODER.encode(left);
  const b = PROTOCOL_NAME_ENCODER.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function protocolNameSet(value, code) {
  if (!Array.isArray(value)) fail(code);
  const names = value.map((entry) => protocolName(entry, code)).sort(compareUtf8Strings);
  for (let index = 1; index < names.length; index += 1) {
    if (names[index - 1] === names[index]) fail(code);
  }
  return Object.freeze(names);
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

function containsLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Strict canonical JSON clone for the direct Authority boundary. */
export function cloneAndFreezeJson(
  value,
  code = 'display-json-invalid',
  maximumDepth = MAXIMUM_JSON_DEPTH,
) {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 0) fail(code);
  return cloneJsonValue(value, new Set(), 0, maximumDepth, code);
}

function cloneJsonValue(value, active, depth, maximumDepth, code) {
  if (depth > maximumDepth) fail(code);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (containsLoneSurrogate(value)) fail(code);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(code);
    return value;
  }
  if (!value || typeof value !== 'object' || active.has(value)) fail(code);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(code);
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        result.push(cloneJsonValue(
          descriptor.value, active, depth + 1, maximumDepth, code,
        ));
      }
      return Object.freeze(result);
    }
    if (!isPlainRecord(value)) fail(code);
    const result = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || DANGEROUS_PROTOCOL_NAMES.has(key)
          || containsLoneSurrogate(key)) fail(code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(
          descriptor.value, active, depth + 1, maximumDepth, code,
        ),
        writable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

export function objectHasOwnMethod(prototype, names) {
  return names.find((name) => Object.hasOwn(prototype, name));
}

export function hasPrefix(name, prefix) {
  return name.startsWith(`${prefix}/`);
}
