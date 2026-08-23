const MAGIC = 'SENG';
const VERSION = 1;
const FIXED_HEADER_BYTES = 16;
const ATTACHMENT_HEADER_BYTES = 8;
const WIRE_SCHEMA = 'scene-engine-wire@1';
export const SCENE_CODEC = 'scene-engine-scene@1';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const PACKET_KIND = Object.freeze({
  'engine.checkpoint': 1,
  'engine.commit': 2,
  'engine.input': 3,
  'engine.ack': 4,
  'engine.input_result': 5,
  'engine.error': 6,
});
const TYPE_BY_KIND = Object.freeze(Object.fromEntries(
  Object.entries(PACKET_KIND).map(([name, value]) => [value, name]),
));
const ATTACHMENT_KIND = Object.freeze({
  world_snapshot: 1,
  world_patch: 2,
  scene_bootstrap: 3,
  scene_frame: 4,
  input_payload: 6,
  result_payload: 7,
});
const ATTACHMENT_NAME = Object.freeze(Object.fromEntries(
  Object.entries(ATTACHMENT_KIND).map(([name, value]) => [value, name]),
));
const HEADER_FIELDS = Object.freeze({
  'engine.checkpoint': Object.freeze([
    'schema', 'type', 'stream_id', 'commit_seq', 'source_tick', 'world_revision',
    'world_codec', 'scene_codec',
  ]),
  'engine.commit': Object.freeze([
    'schema', 'type', 'stream_id', 'commit_seq', 'source_tick', 'world_revision',
    'cause', 'causation_id', 'world_codec', 'scene_codec',
  ]),
  'engine.input': Object.freeze([
    'schema', 'type', 'input_id', 'observed_stream_id', 'observed_commit_seq', 'command',
  ]),
  'engine.ack': Object.freeze(['schema', 'type', 'stream_id', 'commit_seq']),
  'engine.input_result': Object.freeze([
    'schema', 'type', 'input_id', 'status', 'reason_code',
  ]),
  'engine.error': Object.freeze(['schema', 'type', 'code', 'fatal']),
});

export const DEFAULT_ENGINE_LIMITS = Object.freeze({
  maximumPacketBytes: 64 * 1024 * 1024,
  maximumHeaderBytes: 64 * 1024,
  maximumAttachmentCount: 8,
  maximumAttachmentBytes: 48 * 1024 * 1024,
  maximumWorldPatchChanges: 4096,
  maximumJsonPathSegments: 32,
  maximumJsonDepth: 256,
  maximumPendingInputsPerClient: 256,
  maximumInFlightCommits: 8,
  maximumSessionPendingBytes: 64 * 1024 * 1024,
  maximumGlobalRetainedPackets: 4096,
  maximumGlobalRetainedBytes: 256 * 1024 * 1024,
  ackTimeoutTicks: 600,
});

export class EngineWireError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'EngineWireError';
    this.code = code;
  }
}

export function readEnginePacket(value, limits = DEFAULT_ENGINE_LIMITS) {
  const normalizedLimits = normalizeLimits(limits);
  const raw = ownedBytes(value, 'packet-bytes-invalid');
  if (raw.byteLength > normalizedLimits.maximumPacketBytes) fail('packet-byte-limit');
  if (raw.byteLength < FIXED_HEADER_BYTES) fail('packet-header-truncated');
  const view = dataView(raw);
  if (ascii(raw.subarray(0, 4)) !== MAGIC) fail('packet-magic-invalid');
  if (view.getUint8(4) !== VERSION) fail('packet-version-invalid');
  const kindCode = view.getUint8(5);
  const kind = TYPE_BY_KIND[kindCode];
  if (!kind) fail('packet-kind-unknown');
  if (view.getUint16(6, true) !== 0 || view.getUint16(14, true) !== 0) {
    fail('packet-reserved-nonzero');
  }
  const headerLength = view.getUint32(8, true);
  const attachmentCount = view.getUint16(12, true);
  if (headerLength > normalizedLimits.maximumHeaderBytes) fail('packet-header-byte-limit');
  if (attachmentCount > normalizedLimits.maximumAttachmentCount) {
    fail('packet-attachment-count-limit');
  }
  let cursor = FIXED_HEADER_BYTES;
  const headerEnd = cursor + headerLength;
  if (headerEnd > raw.byteLength) fail('packet-header-truncated');
  const header = validateHeader(kind, parseCanonicalJSON(raw.subarray(cursor, headerEnd), {
    maximumDepth: normalizedLimits.maximumJsonDepth,
  }));
  cursor = headerEnd;
  const attachments = [];
  for (let index = 0; index < attachmentCount; index += 1) {
    if (cursor + ATTACHMENT_HEADER_BYTES > raw.byteLength) {
      fail('attachment-header-truncated');
    }
    const attachmentKindCode = view.getUint8(cursor);
    const attachmentKind = ATTACHMENT_NAME[attachmentKindCode];
    const encodingCode = view.getUint8(cursor + 1);
    if (!attachmentKind || (encodingCode !== 0 && encodingCode !== 1)) {
      fail('attachment-kind-or-encoding-unknown');
    }
    if (view.getUint16(cursor + 2, true) !== 0) fail('attachment-flags-nonzero');
    const payloadLength = view.getUint32(cursor + 4, true);
    cursor += ATTACHMENT_HEADER_BYTES;
    if (payloadLength > normalizedLimits.maximumAttachmentBytes) {
      fail('attachment-byte-limit');
    }
    const end = cursor + payloadLength;
    if (end > raw.byteLength) fail('attachment-payload-truncated');
    const bytes = raw.slice(cursor, end);
    cursor = end;
    const encoding = encodingCode === 0 ? 'raw' : 'json';
    const decoded = encoding === 'json'
      ? parseCanonicalJSON(bytes, { maximumDepth: normalizedLimits.maximumJsonDepth })
      : bytes;
    attachments.push(Object.freeze({
      kind: attachmentKind,
      encoding,
      value: decoded,
      bytes,
    }));
  }
  if (cursor !== raw.byteLength) fail('packet-trailing-bytes');
  validateAttachmentLayout(kind, attachments, normalizedLimits);
  return Object.freeze({
    kind,
    header: deepFreeze(header),
    attachments: Object.freeze(attachments),
    rawBytes: raw,
  });
}

export function encodeEngineInput({
  inputId,
  observedStreamId,
  observedCommitSeq,
  command,
  args = {},
} = {}, limits = DEFAULT_ENGINE_LIMITS) {
  return encodePacket('engine.input', {
    schema: WIRE_SCHEMA,
    type: 'engine.input',
    input_id: inputId,
    observed_stream_id: observedStreamId,
    observed_commit_seq: observedCommitSeq,
    command,
  }, [{ kind: 'input_payload', encoding: 'json', value: args }], limits);
}

export function encodeEngineAck({ streamId, commitSeq } = {}, limits = DEFAULT_ENGINE_LIMITS) {
  return encodePacket('engine.ack', {
    schema: WIRE_SCHEMA,
    type: 'engine.ack',
    stream_id: streamId,
    commit_seq: commitSeq,
  }, [], limits);
}

export function encodePacket(kind, header, attachments = [], limits = DEFAULT_ENGINE_LIMITS) {
  const normalizedLimits = normalizeLimits(limits);
  const kindCode = PACKET_KIND[kind];
  if (!kindCode) fail('packet-kind-unknown');
  const normalizedHeader = validateHeader(kind, header);
  const headerBytes = encodeJSON(normalizedHeader, { sortKeys: false });
  if (headerBytes.byteLength > normalizedLimits.maximumHeaderBytes) {
    fail('packet-header-byte-limit');
  }
  const normalizedAttachments = attachments.map((attachment) => {
    if (!attachment || !ATTACHMENT_KIND[attachment.kind]
        || !['raw', 'json'].includes(attachment.encoding)) {
      fail('attachment-invalid');
    }
    const bytes = attachment.encoding === 'json'
      ? encodeJSON(attachment.value, { sortKeys: true })
      : ownedBytes(attachment.value, 'attachment-bytes-invalid');
    if (bytes.byteLength > normalizedLimits.maximumAttachmentBytes) {
      fail('attachment-byte-limit');
    }
    return Object.freeze({
      kind: attachment.kind,
      encoding: attachment.encoding,
      value: attachment.value,
      bytes,
    });
  });
  validateAttachmentLayout(kind, normalizedAttachments, normalizedLimits);
  let length = FIXED_HEADER_BYTES + headerBytes.byteLength;
  for (const attachment of normalizedAttachments) {
    length += ATTACHMENT_HEADER_BYTES + attachment.bytes.byteLength;
  }
  if (length > normalizedLimits.maximumPacketBytes) fail('packet-byte-limit');
  const output = new Uint8Array(length);
  const view = dataView(output);
  output.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, kindCode);
  view.setUint16(6, 0, true);
  view.setUint32(8, headerBytes.byteLength, true);
  view.setUint16(12, normalizedAttachments.length, true);
  view.setUint16(14, 0, true);
  let cursor = FIXED_HEADER_BYTES;
  output.set(headerBytes, cursor);
  cursor += headerBytes.byteLength;
  for (const attachment of normalizedAttachments) {
    view.setUint8(cursor, ATTACHMENT_KIND[attachment.kind]);
    view.setUint8(cursor + 1, attachment.encoding === 'raw' ? 0 : 1);
    view.setUint16(cursor + 2, 0, true);
    view.setUint32(cursor + 4, attachment.bytes.byteLength, true);
    cursor += ATTACHMENT_HEADER_BYTES;
    output.set(attachment.bytes, cursor);
    cursor += attachment.bytes.byteLength;
  }
  return output;
}

function validateHeader(kind, value) {
  requireRecord(value, 'packet-header-invalid');
  const fields = HEADER_FIELDS[kind];
  if (!fields) fail('packet-kind-unknown');
  assertExactKeys(value, new Set(fields), 'packet-header-fields-invalid');
  if (value.schema !== WIRE_SCHEMA || value.type !== kind) fail('packet-schema-invalid');
  const result = {};
  for (const field of fields) result[field] = value[field];
  if (kind === 'engine.checkpoint' || kind === 'engine.commit') {
    text(result.stream_id, 'stream-id-invalid');
    safeInteger(result.commit_seq, 'commit-seq-invalid');
    safeInteger(result.source_tick, 'source-tick-invalid');
    safeInteger(result.world_revision, 'world-revision-invalid');
    identity(result.world_codec, 'world-codec-invalid');
    if (result.scene_codec !== SCENE_CODEC) fail('scene-codec-unsupported');
  }
  if (kind === 'engine.commit') {
    if (!['tick', 'input', 'system'].includes(result.cause)) fail('commit-cause-invalid');
    if (result.cause === 'input') text(result.causation_id, 'causation-id-invalid');
    else if (result.causation_id !== null) fail('causation-id-invalid');
  } else if (kind === 'engine.input') {
    text(result.input_id, 'input-id-invalid');
    text(result.observed_stream_id, 'observed-stream-id-invalid');
    safeInteger(result.observed_commit_seq, 'observed-commit-seq-invalid');
    text(result.command, 'input-command-invalid');
  } else if (kind === 'engine.ack') {
    text(result.stream_id, 'stream-id-invalid');
    safeInteger(result.commit_seq, 'commit-seq-invalid');
  } else if (kind === 'engine.input_result') {
    text(result.input_id, 'input-id-invalid');
    if (!['rejected', 'no-op'].includes(result.status)) fail('input-result-status-invalid');
    if (result.reason_code !== null) text(result.reason_code, 'reason-code-invalid');
  } else if (kind === 'engine.error') {
    text(result.code, 'engine-error-code-invalid');
    if (result.fatal !== true) fail('engine-error-fatal-invalid');
  }
  return result;
}

function validateAttachmentLayout(kind, attachments, limits) {
  if (attachments.length > limits.maximumAttachmentCount) fail('packet-attachment-count-limit');
  const actual = attachments.map((item) => `${item.kind}:${item.encoding}`).join(',');
  let valid = false;
  if (kind === 'engine.checkpoint') {
    valid = actual === 'world_snapshot:json,scene_bootstrap:raw,scene_frame:raw';
  } else if (kind === 'engine.commit') {
    valid = [
      'world_patch:json',
      'world_patch:json,scene_frame:raw',
    ].includes(actual);
    if (valid) {
      const changes = attachments[0].value?.changes;
      if (Array.isArray(changes) && changes.length > limits.maximumWorldPatchChanges) {
        fail('world-patch-change-limit');
      }
    }
  } else if (kind === 'engine.input') {
    valid = actual === 'input_payload:json';
  } else if (kind === 'engine.input_result') {
    valid = actual === '' || actual === 'result_payload:json';
  } else {
    valid = actual === '';
  }
  if (!valid) fail('packet-attachment-layout-invalid');
}

export function parseCanonicalJSON(value, { maximumDepth = 256 } = {}) {
  const bytes = borrowedBytes(value, 'json-bytes-invalid');
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('json-bom-forbidden');
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('json-utf8-invalid');
  }
  let cursor = 0;
  const whitespace = () => {
    while (cursor < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[cursor])) cursor += 1;
  };
  const parseValue = (depth) => {
    if (depth > maximumDepth) fail('json-depth-limit');
    whitespace();
    const character = source[cursor];
    if (character === '{') return parseObject(depth);
    if (character === '[') return parseArray(depth);
    if (character === '"') return parseString();
    if (source.startsWith('true', cursor)) { cursor += 4; return true; }
    if (source.startsWith('false', cursor)) { cursor += 5; return false; }
    if (source.startsWith('null', cursor)) { cursor += 4; return null; }
    return parseNumber();
  };
  const parseString = () => {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (!escaped && code === 0x22) {
        cursor += 1;
        let result;
        try { result = JSON.parse(source.slice(start, cursor)); } catch { fail('json-string-invalid'); }
        if (containsLoneSurrogate(result)) fail('json-string-surrogate-invalid');
        return result;
      }
      if (!escaped && code < 0x20) fail('json-string-control-invalid');
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      cursor += 1;
    }
    fail('json-string-truncated');
  };
  const parseNumber = () => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(cursor));
    if (!match) fail('json-value-invalid');
    cursor += match[0].length;
    if (/[.eE0-9]/u.test(source[cursor] ?? '')) fail('json-number-invalid');
    const result = Number(match[0]);
    if (!Number.isFinite(result)) fail('json-number-nonfinite');
    if (!/[.eE]/u.test(match[0]) && !Number.isSafeInteger(result)) {
      fail('json-number-unsafe-integer');
    }
    return result;
  };
  const parseObject = (depth) => {
    cursor += 1;
    whitespace();
    const result = {};
    const keys = new Set();
    if (source[cursor] === '}') { cursor += 1; return result; }
    while (true) {
      whitespace();
      if (source[cursor] !== '"') fail('json-object-key-invalid');
      const key = parseString();
      if (keys.has(key)) fail('json-duplicate-key');
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('json-dangerous-key');
      keys.add(key);
      whitespace();
      if (source[cursor] !== ':') fail('json-object-colon-missing');
      cursor += 1;
      const item = parseValue(depth + 1);
      Object.defineProperty(result, key, {
        value: item, enumerable: true, configurable: true, writable: true,
      });
      whitespace();
      if (source[cursor] === '}') { cursor += 1; return result; }
      if (source[cursor] !== ',') fail('json-object-separator-invalid');
      cursor += 1;
    }
  };
  const parseArray = (depth) => {
    cursor += 1;
    whitespace();
    const result = [];
    if (source[cursor] === ']') { cursor += 1; return result; }
    while (true) {
      result.push(parseValue(depth + 1));
      whitespace();
      if (source[cursor] === ']') { cursor += 1; return result; }
      if (source[cursor] !== ',') fail('json-array-separator-invalid');
      cursor += 1;
    }
  };
  const result = parseValue(0);
  whitespace();
  if (cursor !== source.length) fail('json-trailing-data');
  return result;
}

export function encodeJSON(value, { sortKeys = true } = {}) {
  validateJSONValue(value, new WeakSet(), 0);
  const encode = (item) => {
    if (item === null || typeof item === 'boolean') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (Object.is(item, -0)) return '0';
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) {
        return item.toExponential().replace(/e\+?(-?)0*(\d+)/u, 'e$1$2');
      }
      return JSON.stringify(item);
    }
    if (typeof item === 'string') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    const keys = Object.keys(item);
    if (sortKeys) keys.sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
  };
  return new TextEncoder().encode(encode(value));
}

function validateJSONValue(value, active, depth) {
  if (depth > DEFAULT_ENGINE_LIMITS.maximumJsonDepth) fail('json-depth-limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('json-number-nonfinite');
    return;
  }
  if (!value || typeof value !== 'object') fail('json-value-invalid');
  if (active.has(value)) fail('json-cycle');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('json-value-invalid');
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('json-array-sparse');
        validateJSONValue(value[index], active, depth + 1);
      }
    } else {
      requireRecord(value, 'json-object-invalid');
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) {
          fail('json-object-key-invalid');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('json-property-invalid');
        validateJSONValue(descriptor.value, active, depth + 1);
      }
    }
  } finally {
    active.delete(value);
  }
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function normalizeLimits(value) {
  requireRecord(value, 'engine-limits-invalid');
  const known = new Set(Object.keys(DEFAULT_ENGINE_LIMITS));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !known.has(key)) fail('engine-limit-unknown');
  }
  const result = { ...DEFAULT_ENGINE_LIMITS, ...value };
  for (const [key, item] of Object.entries(result)) {
    if (!Number.isSafeInteger(item) || item <= 0) fail(`${key}-invalid`);
  }
  return Object.freeze(result);
}

function requireRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
}

function assertExactKeys(value, allowed, code) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.size) fail(code);
  for (const key of keys) if (typeof key !== 'string' || !allowed.has(key)) fail(code);
}

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE) fail(code);
  return value;
}

function text(value, code) {
  if (typeof value !== 'string' || !value || value.trim() !== value) fail(code);
  return value;
}

function identity(value, code) {
  text(value, code);
  if (new TextEncoder().encode(value).byteLength > 160
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) fail(code);
  return value;
}

function ownedBytes(value, code) { return borrowedBytes(value, code).slice(); }
function borrowedBytes(value, code) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail(code);
}
function dataView(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function ascii(bytes) { return String.fromCharCode(...bytes); }
function containsLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function compareUtf8(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left); const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
function fail(code) { throw new EngineWireError(code); }

export const ENGINE_WIRE_SCHEMA = WIRE_SCHEMA;
