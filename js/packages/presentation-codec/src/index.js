const PROTOCOL = 'scene-presentation-control-v2';
const SCHEMA_VERSION = 1;
const MAXIMUM_CONTROL_BYTES = 256 * 1024;
const MAXIMUM_CURSOR_BYTES = 16 * 1024;
const MAXIMUM_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAXIMUM_U64 = (1n << 64n) - 1n;
const DECIMAL_U64 = /^[1-9][0-9]*$/u;
const DECIMAL_U64_OR_ZERO = /^(?:0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CODEC_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

export { sha256HexBytes } from './hash.js';
export * from './binary.js';

export const PRESENTATION_CONTROL_CLIENT_TO_SERVER = 'client-to-server';
export const PRESENTATION_CONTROL_SERVER_TO_CLIENT = 'server-to-client';
export const SCENE_PRESENTATION_CONTROL_PROTOCOL = PROTOCOL;
export const SCENE_PRESENTATION_CONTROL_SCHEMA_VERSION = SCHEMA_VERSION;
export const PRESENTATION_CONTROL_MAXIMUM_BYTES = MAXIMUM_CONTROL_BYTES;

const TYPES_BY_DIRECTION = new Map([
  [PRESENTATION_CONTROL_CLIENT_TO_SERVER, new Set([
    'presentation.ready',
    'presentation.ack',
    'presentation.resync_request',
  ])],
  [PRESENTATION_CONTROL_SERVER_TO_CLIENT, new Set([
    'presentation.reset',
    'presentation.correlation',
  ])],
]);

export class PresentationCodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PresentationCodecError';
  }
}

export function createAuthorityCursorEnvelope(codecIdentity, canonicalBytes) {
  const identity = canonicalText(codecIdentity, 'cursor codec_identity', 160);
  if (!CODEC_IDENTITY.test(identity)) {
    throw new PresentationCodecError('cursor codec_identity is invalid');
  }
  const bytes = readonlyBytes(canonicalBytes, 'authority cursor canonical_bytes');
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_CURSOR_BYTES) {
    throw new PresentationCodecError('authority cursor canonical_bytes length is invalid');
  }
  return Object.freeze({ codecIdentity: identity, canonicalBytes: bytes });
}

export function envelopeCursor(cursor, codec) {
  if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function'
      || typeof codec.key !== 'function' || typeof codec.tick !== 'function') {
    throw new PresentationCodecError('authority cursor codec port is invalid');
  }
  const envelope = createAuthorityCursorEnvelope(codec.codecIdentity, codec.encode(cursor));
  const decoded = codec.decode(envelope.canonicalBytes);
  const encodedAgain = readonlyBytes(codec.encode(decoded), 'authority cursor canonical_bytes');
  if (!bytesEqual(encodedAgain, envelope.canonicalBytes)) {
    throw new PresentationCodecError('authority cursor codec is not canonical');
  }
  if (String(codec.key(decoded)) !== String(codec.key(cursor))) {
    throw new PresentationCodecError('authority cursor codec changed cursor identity');
  }
  const tick = codec.tick(decoded);
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new PresentationCodecError('authority cursor codec returned an invalid tick');
  }
  return envelope;
}

export function cursorEnvelopeToJSON(envelope) {
  const normalized = createAuthorityCursorEnvelope(
    envelope?.codecIdentity,
    envelope?.canonicalBytes,
  );
  return {
    canonical_bytes_base64: bytesToBase64(normalized.canonicalBytes),
    codec_identity: normalized.codecIdentity,
  };
}

export function cursorEnvelopeFromJSON(value) {
  exactObject(value, ['canonical_bytes_base64', 'codec_identity'], 'authority cursor envelope');
  if (typeof value.canonical_bytes_base64 !== 'string' || value.canonical_bytes_base64.length === 0) {
    throw new PresentationCodecError('authority cursor base64 is invalid');
  }
  const bytes = base64ToBytes(value.canonical_bytes_base64);
  if (bytesToBase64(bytes) !== value.canonical_bytes_base64) {
    throw new PresentationCodecError('authority cursor base64 is not canonical');
  }
  return createAuthorityCursorEnvelope(value.codec_identity, bytes);
}

export function encodePresentationControl(message, { direction } = {}) {
  const normalized = validatePresentationControl(message, { direction });
  return new TextEncoder().encode(canonicalJSON(normalized));
}

export function parsePresentationControl(data, { direction } = {}) {
  const bytes = readonlyBytes(data, 'control input');
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_CONTROL_BYTES) {
    throw new PresentationCodecError('control message byte length is invalid');
  }
  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PresentationCodecError('control message must be valid UTF-8 JSON', { cause: error });
  }
  const normalized = validatePresentationControl(parsed, { direction });
  if (canonicalJSON(normalized) !== text) {
    throw new PresentationCodecError('control JSON bytes are not canonical');
  }
  return normalized;
}

export function validatePresentationControl(message, { direction } = {}) {
  const allowedTypes = TYPES_BY_DIRECTION.get(direction);
  if (!allowedTypes) throw new PresentationCodecError('control direction is invalid');
  exactObject(message, [
    'bootstrap_id',
    'message_id',
    'payload',
    'protocol',
    'scene_epoch',
    'schema_version',
    'session_seq',
    'type',
    'viewer_scope',
  ], 'control envelope');
  if (message.protocol !== PROTOCOL) throw new PresentationCodecError('control protocol is invalid');
  if (message.schema_version !== SCHEMA_VERSION) {
    throw new PresentationCodecError('control schema_version is invalid');
  }
  if (!allowedTypes.has(message.type)) {
    throw new PresentationCodecError('control type is invalid for direction');
  }
  canonicalText(message.message_id, 'message_id', 160);
  safeInteger(message.session_seq, 'session_seq', 1);
  canonicalText(message.viewer_scope, 'viewer_scope', 160);
  decimalU64(message.scene_epoch, 'scene_epoch');
  decimalU64(message.bootstrap_id, 'bootstrap_id');
  const payload = normalizePayload(message.type, message.payload);
  return {
    bootstrap_id: message.bootstrap_id,
    message_id: message.message_id,
    payload,
    protocol: PROTOCOL,
    scene_epoch: message.scene_epoch,
    schema_version: SCHEMA_VERSION,
    session_seq: message.session_seq,
    type: message.type,
    viewer_scope: message.viewer_scope,
  };
}

export function canonicalJSON(value) {
  return JSON.stringify(sortJSON(value));
}

function normalizePayload(type, value) {
  if (type === 'presentation.ready') {
    exactObject(value, ['authority_baseline', 'profile_id'], 'ready payload');
    return {
      authority_baseline: cursorEnvelopeToJSON(cursorEnvelopeFromJSON(value.authority_baseline)),
      profile_id: canonicalText(value.profile_id, 'profile_id', 160),
    };
  }
  if (type === 'presentation.ack') {
    exactObject(value, ['authority_cursor', 'correlation_seq', 'frame_seq'], 'ack payload');
    return {
      authority_cursor: value.authority_cursor == null
        ? null
        : cursorEnvelopeToJSON(cursorEnvelopeFromJSON(value.authority_cursor)),
      correlation_seq: decimalU64(value.correlation_seq, 'correlation_seq'),
      frame_seq: decimalU64(value.frame_seq, 'frame_seq'),
    };
  }
  if (type === 'presentation.resync_request') {
    exactObject(value, ['last_frame_seq', 'reason'], 'resync payload');
    return {
      last_frame_seq: value.last_frame_seq == null
        ? null
        : decimalU64(value.last_frame_seq, 'last_frame_seq'),
      reason: canonicalText(value.reason, 'reason', 160),
    };
  }
  if (type === 'presentation.reset') {
    exactObject(value, ['next_bootstrap_id', 'next_scene_epoch', 'reason'], 'reset payload');
    return {
      next_bootstrap_id: decimalU64(value.next_bootstrap_id, 'next_bootstrap_id'),
      next_scene_epoch: decimalU64(value.next_scene_epoch, 'next_scene_epoch'),
      reason: canonicalText(value.reason, 'reason', 160),
    };
  }
  exactObject(value, [
    'authority_cursor',
    'correlation_seq',
    'frame_refs',
    'presentation_required',
    'projection_id',
    'source_tick',
  ], 'correlation payload');
  if (typeof value.presentation_required !== 'boolean') {
    throw new PresentationCodecError('presentation_required must be boolean');
  }
  if (!Array.isArray(value.frame_refs)) {
    throw new PresentationCodecError('frame_refs must be an array');
  }
  let previous = 0n;
  const frameRefs = value.frame_refs.map((item) => {
    exactObject(item, ['frame_seq', 'sha256'], 'frame ref');
    const sequence = decimalU64(item.frame_seq, 'frame_seq');
    const numeric = BigInt(sequence);
    if (numeric <= previous) {
      throw new PresentationCodecError('frame_refs must be strictly increasing');
    }
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw new PresentationCodecError('frame ref sha256 is invalid');
    }
    previous = numeric;
    return { frame_seq: sequence, sha256: item.sha256 };
  });
  if (value.presentation_required !== (frameRefs.length > 0)) {
    throw new PresentationCodecError('presentation_required and frame_refs disagree');
  }
  return {
    authority_cursor: cursorEnvelopeToJSON(cursorEnvelopeFromJSON(value.authority_cursor)),
    correlation_seq: decimalU64(value.correlation_seq, 'correlation_seq'),
    frame_refs: frameRefs,
    presentation_required: value.presentation_required,
    projection_id: decimalU64(value.projection_id, 'projection_id'),
    source_tick: decimalU64(value.source_tick, 'source_tick', { allowZero: true }),
  };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PresentationCodecError(`${label} has unknown or missing fields`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PresentationCodecError(`${label} has unknown or missing fields`);
  }
}

function canonicalText(value, field, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
      || value.includes('\0') || value.length > maximum || value.normalize('NFC') !== value) {
    throw new PresentationCodecError(`${field} is not a canonical string`);
  }
  return value;
}

function safeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAXIMUM_SAFE_INTEGER) {
    throw new PresentationCodecError(`${field} is not a safe integer`);
  }
  return value;
}

function decimalU64(value, field, { allowZero = false } = {}) {
  const pattern = allowZero ? DECIMAL_U64_OR_ZERO : DECIMAL_U64;
  if (typeof value !== 'string' || !pattern.test(value) || BigInt(value) > MAXIMUM_U64) {
    throw new PresentationCodecError(`${field} is not canonical decimal u64`);
  }
  return value;
}

function readonlyBytes(value, label) {
  let view;
  if (value instanceof Uint8Array) view = value;
  else if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new PresentationCodecError(`${label} must be bytes`);
  return new Uint8Array(view);
}

function bytesEqual(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  try {
    if (typeof Buffer !== 'undefined') {
      const buffer = Buffer.from(value, 'base64');
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
    }
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new PresentationCodecError('authority cursor base64 is invalid', { cause: error });
  }
}

function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJSON(value[key])]));
  }
  return value;
}
