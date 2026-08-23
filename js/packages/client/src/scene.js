import { sha256HexBytes } from './hash.js';

const BOOTSTRAP_HEADER_BYTES = 80;
const FRAME_HEADER_BYTES = 40;
const DIRECTORY_ENTRY_BYTES = 20;
const NODE_BYTES = 80;
const PAYLOAD_REF_BYTES = 24;
const METADATA_REF_BYTES = 16;
const VISUAL_BYTES = 16;
const ANIMATION_BYTES = 16;
const EVENT_BYTES = 48;
const BOOTSTRAP_TYPES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const BOOTSTRAP_STRIDES = Object.freeze([
  NODE_BYTES, PAYLOAD_REF_BYTES, 1, PAYLOAD_REF_BYTES, 1,
  METADATA_REF_BYTES, 1, VISUAL_BYTES, ANIMATION_BYTES,
]);
const FRAME_TYPES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const FRAME_STRIDES = Object.freeze([
  NODE_BYTES, PAYLOAD_REF_BYTES, 1, PAYLOAD_REF_BYTES, 1, EVENT_BYTES, 1,
]);

export class SceneBodyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SceneBodyError';
    this.code = code;
  }
}

export function parseSceneBootstrap(value, limits = {}) {
  const bytes = ownedBytes(value);
  const maximumBytes = uintLimit(limits.maximumBootstrapBytes ?? 64 * 1024 * 1024);
  if (bytes.byteLength > maximumBytes) fail('scene-bootstrap-byte-limit');
  if (bytes.byteLength < BOOTSTRAP_HEADER_BYTES) fail('scene-bootstrap-header-truncated');
  const view = dataView(bytes);
  const header = Object.freeze({
    schemaVersion: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    headerBytes: view.getUint16(4, true),
    sectionCount: view.getUint16(6, true),
    ticksPerSecond: view.getUint16(8, true),
    coordinateProfile: view.getUint16(10, true),
    worldUnitsPerMeter: view.getFloat32(12, true),
    maximumDynamicNodes: view.getUint32(16, true),
    maximumFrameBytes: view.getUint32(20, true),
    directoryBytes: view.getUint32(24, true),
    payloadBytes: view.getUint32(28, true),
    contentSha256: hex(bytes.subarray(32, 64)),
  });
  if (header.schemaVersion !== 1 || header.flags !== 1
      || header.headerBytes !== BOOTSTRAP_HEADER_BYTES
      || header.sectionCount !== BOOTSTRAP_TYPES.length
      || header.ticksPerSecond !== 60 || header.coordinateProfile !== 1
      || !Number.isFinite(header.worldUnitsPerMeter) || header.worldUnitsPerMeter <= 0
      || header.maximumFrameBytes === 0
      || header.directoryBytes !== BOOTSTRAP_TYPES.length * DIRECTORY_ENTRY_BYTES
      || header.headerBytes + header.directoryBytes + header.payloadBytes !== bytes.byteLength
      || !allZero(bytes.subarray(64, 80))) fail('scene-bootstrap-header-invalid');
  if (sha256HexBytes(bytes.subarray(BOOTSTRAP_HEADER_BYTES)) !== header.contentSha256) {
    fail('scene-bootstrap-hash-mismatch');
  }
  const maximumStaticNodes = uintLimit(limits.maximumStaticNodes ?? 1_000_000);
  const entries = parseDirectory(bytes, {
    headerBytes: BOOTSTRAP_HEADER_BYTES,
    types: BOOTSTRAP_TYPES,
    strides: BOOTSTRAP_STRIDES,
    limits: [
      maximumStaticNodes, maximumStaticNodes, 0xffffffff, maximumStaticNodes,
      0xffffffff, uintLimit(limits.maximumSceneMetadata ?? 65_536), 0xffffffff,
      uintLimit(limits.maximumVisualTypes ?? 65_536),
      uintLimit(limits.maximumAnimationStates ?? 65_536),
    ],
    variable: new Set([2, 4, 6]),
  });
  const visualTypes = parseVisualTypes(bytes, entries[7]);
  const animationStates = parseAnimationStates(bytes, entries[8]);
  const bareNodes = parseNodes(bytes, entries[0]);
  const profiles = parseNodePayloads(bytes, entries[1], entries[2], bareNodes);
  const interactions = parseNodePayloads(bytes, entries[3], entries[4], bareNodes);
  const staticNodes = attachPayloads(bareNodes, profiles, interactions);
  const sceneMetadata = parseMetadata(bytes, entries[5], entries[6]);
  validateRegistries(visualTypes, animationStates);
  validateMetadata(sceneMetadata);
  validateNodes(staticNodes, { visualTypes, animationStates, sourceTick: null });
  validateTree(staticNodes, [], uintLimit(limits.maximumTreeDepth ?? 64));
  return createBootstrapView({
    header, staticNodes, sceneMetadata, visualTypes, animationStates, bytes,
  });
}

export function parseSceneFrame(value, { sourceTick, limits = {} } = {}) {
  const tick = safeInteger(sourceTick, 'scene-source-tick-invalid');
  const bytes = ownedBytes(value);
  const maximumBytes = uintLimit(limits.maximumFrameBytes ?? 64 * 1024 * 1024);
  if (bytes.byteLength > maximumBytes) fail('scene-frame-byte-limit');
  if (bytes.byteLength < FRAME_HEADER_BYTES) fail('scene-frame-header-truncated');
  const view = dataView(bytes);
  const header = Object.freeze({
    schemaVersion: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    headerBytes: view.getUint16(4, true),
    sectionCount: view.getUint16(6, true),
    nodeCount: view.getUint32(8, true),
    profileCount: view.getUint32(12, true),
    interactionCount: view.getUint32(16, true),
    payloadBytes: view.getUint32(20, true),
    directoryBytes: view.getUint32(24, true),
    eventCount: view.getUint32(28, true),
  });
  if (header.schemaVersion !== 1 || header.flags !== 1
      || header.headerBytes !== FRAME_HEADER_BYTES
      || header.sectionCount !== FRAME_TYPES.length
      || header.profileCount > header.nodeCount || header.interactionCount > header.nodeCount
      || header.nodeCount > uintLimit(limits.maximumFrameNodes ?? 1_000_000)
      || header.eventCount > uintLimit(limits.maximumFrameEvents ?? 1_000_000)
      || header.directoryBytes !== FRAME_TYPES.length * DIRECTORY_ENTRY_BYTES
      || header.headerBytes + header.directoryBytes + header.payloadBytes !== bytes.byteLength
      || !allZero(bytes.subarray(32, 40))) fail('scene-frame-header-invalid');
  const entries = parseDirectory(bytes, {
    headerBytes: FRAME_HEADER_BYTES,
    types: FRAME_TYPES,
    strides: FRAME_STRIDES,
    limits: [
      header.nodeCount, header.nodeCount, 0xffffffff, header.nodeCount,
      0xffffffff, header.eventCount, 0xffffffff,
    ],
    exact: new Map([
      [0, header.nodeCount], [1, header.nodeCount], [3, header.nodeCount],
      [5, header.eventCount],
    ]),
    variable: new Set([2, 4, 6]),
  });
  const bareNodes = parseNodes(bytes, entries[0]);
  const profiles = parseNodePayloads(bytes, entries[1], entries[2], bareNodes);
  const interactions = parseNodePayloads(bytes, entries[3], entries[4], bareNodes);
  const nodes = attachPayloads(bareNodes, profiles, interactions);
  const events = parseEvents(bytes, entries[5], entries[6]);
  if (profiles.filter(Boolean).length !== header.profileCount
      || interactions.filter(Boolean).length !== header.interactionCount) {
    fail('scene-frame-payload-count-mismatch');
  }
  validateNodes(nodes, { sourceTick: tick });
  validateEvents(events, tick);
  return createFrameView({ header, sourceTick: tick, nodes, events, bytes });
}

function createBootstrapView({
  header, staticNodes, sceneMetadata, visualTypes, animationStates, bytes,
}) {
  const metadataById = new Map(sceneMetadata.map((item) => [item.metadataTypeId, item]));
  return Object.freeze({
    header,
    nodeCount: staticNodes.length,
    sceneMetadataCount: sceneMetadata.length,
    visualTypeCount: visualTypes.length,
    animationStateCount: animationStates.length,
    nodeAt: (index) => at(staticNodes, index, 'scene-node-index-invalid'),
    sceneMetadataAt: (index) => at(sceneMetadata, index, 'scene-metadata-index-invalid'),
    getSceneMetadata: (typeId) => metadataById.get(uint32(typeId, 'metadata-type-invalid')) ?? null,
    visualTypeAt: (index) => at(visualTypes, index, 'visual-type-index-invalid'),
    animationStateAt: (index) => at(animationStates, index, 'animation-state-index-invalid'),
    staticNodes,
    sceneMetadata,
    visualTypes,
    animationStates,
    bytes,
  });
}

function createFrameView({ header, sourceTick, nodes, events, bytes }) {
  return Object.freeze({
    header,
    sourceTick,
    nodeCount: nodes.length,
    eventCount: events.length,
    nodeAt: (index) => at(nodes, index, 'scene-node-index-invalid'),
    eventAt: (index) => at(events, index, 'scene-event-index-invalid'),
    nodes,
    events,
    bytes,
  });
}

function parseDirectory(bytes, {
  headerBytes, types, strides, limits, exact = new Map(), variable = new Set(),
}) {
  const view = dataView(bytes);
  let expectedOffset = headerBytes + types.length * DIRECTORY_ENTRY_BYTES;
  const result = [];
  for (let index = 0; index < types.length; index += 1) {
    const offset = headerBytes + index * DIRECTORY_ENTRY_BYTES;
    const entry = Object.freeze({
      type: view.getUint16(offset, true),
      flags: view.getUint16(offset + 2, true),
      recordCount: view.getUint32(offset + 4, true),
      byteOffset: view.getUint32(offset + 8, true),
      byteLength: view.getUint32(offset + 12, true),
      recordStride: view.getUint16(offset + 16, true),
      reserved: view.getUint16(offset + 18, true),
    });
    const logical = variable.has(index)
      ? entry.recordCount : entry.recordCount * entry.recordStride;
    if (entry.type !== types[index] || entry.flags !== 1
        || entry.recordStride !== strides[index] || entry.reserved !== 0
        || entry.recordCount > limits[index] || entry.byteOffset !== expectedOffset
        || entry.byteOffset % 4 !== 0 || entry.byteLength % 4 !== 0
        || entry.byteLength !== align4(logical)
        || entry.byteOffset + entry.byteLength > bytes.byteLength
        || (exact.has(index) && entry.recordCount !== exact.get(index))
        || !allZero(bytes.subarray(entry.byteOffset + logical, entry.byteOffset + entry.byteLength))) {
      fail('scene-directory-invalid');
    }
    expectedOffset += entry.byteLength;
    result.push(entry);
  }
  if (expectedOffset !== bytes.byteLength) fail('scene-body-trailing-bytes');
  return Object.freeze(result);
}

function parseNodes(bytes, entry) {
  const view = dataView(bytes);
  const result = [];
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * NODE_BYTES;
    const localPosition = Object.freeze([
      view.getFloat32(offset + 24, true), view.getFloat32(offset + 28, true),
      view.getFloat32(offset + 32, true),
    ]);
    const localRotationXyzw = Object.freeze([
      view.getFloat32(offset + 36, true), view.getFloat32(offset + 40, true),
      view.getFloat32(offset + 44, true), view.getFloat32(offset + 48, true),
    ]);
    const localScale = Object.freeze([
      view.getFloat32(offset + 52, true), view.getFloat32(offset + 56, true),
      view.getFloat32(offset + 60, true),
    ]);
    result.push(Object.freeze({
      displayId: view.getBigUint64(offset, true),
      parentDisplayId: view.getBigUint64(offset + 8, true),
      visualTypeId: view.getUint32(offset + 16, true),
      flags: view.getUint32(offset + 20, true),
      localPosition,
      localRotationXyzw,
      localScale,
      animationStateId: view.getUint32(offset + 64, true),
      animationStartTick: view.getBigUint64(offset + 68, true),
      animationFlags: view.getUint32(offset + 76, true),
      profile: null,
      interaction: null,
    }));
  }
  return Object.freeze(result);
}

function parseNodePayloads(bytes, refs, blob, nodes) {
  const view = dataView(bytes);
  let expectedOffset = 0;
  const result = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const offset = refs.byteOffset + index * PAYLOAD_REF_BYTES;
    const displayId = view.getBigUint64(offset, true);
    const payloadTypeId = view.getUint32(offset + 8, true);
    const flags = view.getUint32(offset + 12, true);
    const blobOffset = view.getUint32(offset + 16, true);
    const length = view.getUint32(offset + 20, true);
    if (displayId !== nodes[index].displayId || blobOffset !== expectedOffset) {
      fail('scene-node-payload-ref-invalid');
    }
    if (payloadTypeId === 0) {
      if (flags !== 0 || length !== 0) fail('scene-node-payload-ref-invalid');
      result.push(null);
    } else {
      if (length === 0 || blobOffset + length > blob.recordCount) {
        fail('scene-node-payload-ref-invalid');
      }
      result.push(Object.freeze({
        payloadTypeId,
        flags,
        data: bytes.slice(blob.byteOffset + blobOffset, blob.byteOffset + blobOffset + length),
      }));
      expectedOffset += length;
    }
  }
  if (expectedOffset !== blob.recordCount) fail('scene-node-payload-trailing-bytes');
  return Object.freeze(result);
}

function attachPayloads(nodes, profiles, interactions) {
  return Object.freeze(nodes.map((node, index) => Object.freeze({
    ...node,
    profile: profiles[index],
    interaction: interactions[index],
  })));
}

function parseMetadata(bytes, refs, blob) {
  const view = dataView(bytes);
  let expectedOffset = 0;
  const result = [];
  for (let index = 0; index < refs.recordCount; index += 1) {
    const offset = refs.byteOffset + index * METADATA_REF_BYTES;
    const metadataTypeId = view.getUint32(offset, true);
    const flags = view.getUint32(offset + 4, true);
    const blobOffset = view.getUint32(offset + 8, true);
    const length = view.getUint32(offset + 12, true);
    if (blobOffset !== expectedOffset || length === 0 || blobOffset + length > blob.recordCount) {
      fail('scene-metadata-ref-invalid');
    }
    result.push(Object.freeze({
      metadataTypeId,
      flags,
      data: bytes.slice(blob.byteOffset + blobOffset, blob.byteOffset + blobOffset + length),
    }));
    expectedOffset += length;
  }
  if (expectedOffset !== blob.recordCount) fail('scene-metadata-trailing-bytes');
  return Object.freeze(result);
}

function parseVisualTypes(bytes, entry) {
  const view = dataView(bytes);
  return Object.freeze(Array.from({ length: entry.recordCount }, (_, index) => {
    const offset = entry.byteOffset + index * VISUAL_BYTES;
    return Object.freeze({
      visualTypeId: view.getUint32(offset, true),
      flags: view.getUint32(offset + 4, true),
      profileTypeId: view.getUint32(offset + 8, true),
      interactionTypeId: view.getUint32(offset + 12, true),
    });
  }));
}

function parseAnimationStates(bytes, entry) {
  const view = dataView(bytes);
  return Object.freeze(Array.from({ length: entry.recordCount }, (_, index) => {
    const offset = entry.byteOffset + index * ANIMATION_BYTES;
    if (view.getUint32(offset + 12, true) !== 0) fail('scene-animation-reserved-nonzero');
    return Object.freeze({
      animationStateId: view.getUint32(offset, true),
      flags: view.getUint32(offset + 4, true),
      durationTicks: view.getUint32(offset + 8, true),
    });
  }));
}

function parseEvents(bytes, records, blob) {
  const view = dataView(bytes);
  let expectedOffset = 0;
  const result = [];
  for (let index = 0; index < records.recordCount; index += 1) {
    const offset = records.byteOffset + index * EVENT_BYTES;
    const blobOffset = view.getUint32(offset + 40, true);
    const length = view.getUint32(offset + 44, true);
    if (blobOffset !== expectedOffset || blobOffset + length > blob.recordCount) {
      fail('scene-event-ref-invalid');
    }
    result.push(Object.freeze({
      eventId: view.getBigUint64(offset, true),
      eventTypeId: view.getUint32(offset + 8, true),
      flags: view.getUint32(offset + 12, true),
      sourceDisplayId: view.getBigUint64(offset + 16, true),
      targetDisplayId: view.getBigUint64(offset + 24, true),
      startTick: view.getBigUint64(offset + 32, true),
      payload: bytes.slice(blob.byteOffset + blobOffset, blob.byteOffset + blobOffset + length),
    }));
    expectedOffset += length;
  }
  if (expectedOffset !== blob.recordCount) fail('scene-event-trailing-bytes');
  return Object.freeze(result);
}

function validateRegistries(visualTypes, animationStates) {
  let previous = 0;
  for (const item of visualTypes) {
    if (item.visualTypeId <= previous || item.visualTypeId === 0 || (item.flags & ~7)) {
      fail('scene-visual-registry-invalid');
    }
    previous = item.visualTypeId;
  }
  previous = 0;
  for (const item of animationStates) {
    if (item.animationStateId <= previous || item.animationStateId === 0
        || item.durationTicks === 0 || (item.flags & ~7)) {
      fail('scene-animation-registry-invalid');
    }
    previous = item.animationStateId;
  }
}

function validateMetadata(sceneMetadata) {
  let previous = 0;
  for (const item of sceneMetadata) {
    if (item.metadataTypeId <= previous || item.metadataTypeId === 0 || item.flags !== 0) {
      fail('scene-metadata-registry-invalid');
    }
    previous = item.metadataTypeId;
  }
}

function validateNodes(nodes, { visualTypes = null, animationStates = null, sourceTick }) {
  const visuals = visualTypes ? new Map(visualTypes.map((item) => [item.visualTypeId, item])) : null;
  const animations = animationStates
    ? new Set(animationStates.map((item) => item.animationStateId)) : null;
  let previous = 0n;
  for (const node of nodes) {
    if (node.displayId <= previous || node.displayId === 0n || node.visualTypeId === 0
        || (node.flags & ~1) || (node.animationFlags & ~7)) fail('scene-node-invalid');
    previous = node.displayId;
    if (![...node.localPosition, ...node.localRotationXyzw, ...node.localScale]
      .every(Number.isFinite) || node.localScale.some((item) => item <= 0)) {
      fail('scene-node-pose-invalid');
    }
    const norm = Math.sqrt(node.localRotationXyzw.reduce((sum, item) => sum + item * item, 0));
    if (Math.abs(norm - 1) > 1e-3) fail('scene-node-rotation-invalid');
    if (sourceTick !== null && node.animationStartTick > BigInt(sourceTick)) {
      fail('scene-node-animation-future');
    }
    if (visuals) {
      const visual = visuals.get(node.visualTypeId);
      if (!visual || (node.profile?.payloadTypeId ?? 0) !== visual.profileTypeId
          || (node.interaction?.payloadTypeId ?? 0) !== visual.interactionTypeId) {
        fail('scene-node-visual-payload-invalid');
      }
    }
    if (animations && node.animationStateId !== 0 && !animations.has(node.animationStateId)) {
      fail('scene-node-animation-unknown');
    }
  }
}

export function validateTree(nodes, staticNodes = [], maximumDepth = 64) {
  const all = [...staticNodes, ...nodes];
  const byId = new Map();
  for (const node of all) {
    if (byId.has(node.displayId)) fail('scene-tree-id-duplicate');
    byId.set(node.displayId, node);
  }
  for (const node of all) {
    if (node.parentDisplayId !== 0n && !byId.has(node.parentDisplayId)) {
      fail('scene-tree-parent-missing');
    }
  }
  const depth = new Map();
  for (const identity of byId.keys()) {
    const chain = [];
    const active = new Set();
    let cursor = identity;
    while (!depth.has(cursor)) {
      if (active.has(cursor)) fail('scene-tree-cycle');
      active.add(cursor); chain.push(cursor);
      const parent = byId.get(cursor).parentDisplayId;
      if (parent === 0n) break;
      cursor = parent;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const node = byId.get(chain[index]);
      const current = node.parentDisplayId === 0n ? 1 : depth.get(node.parentDisplayId) + 1;
      if (current > maximumDepth) fail('scene-tree-depth-limit');
      depth.set(node.displayId, current);
    }
  }
  return Object.freeze({ byId, depth });
}

function validateEvents(events, sourceTick) {
  let previous = 0n;
  for (const event of events) {
    if (event.eventId <= previous || event.eventId === 0n || event.eventTypeId === 0
        || (event.flags & ~1) || event.startTick > BigInt(sourceTick)) {
      fail('scene-event-invalid');
    }
    previous = event.eventId;
  }
}

function at(values, index, code) {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) fail(code);
  return values[index];
}
function ownedBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  fail('scene-body-bytes-invalid');
}
function uintLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail('scene-limit-invalid');
  return value;
}
function uint32(value, code) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail(code);
  return value;
}
function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}
function align4(value) { return (value + 3) & ~3; }
function dataView(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function allZero(bytes) { return bytes.every((item) => item === 0); }
function hex(bytes) { return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join(''); }
function fail(code) { throw new SceneBodyError(code); }
