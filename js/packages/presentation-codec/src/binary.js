import { sha256HexBytes } from './hash.js';

export const SCENE_PACKET_MAGIC = 'SEDF';
export const SCENE_PACKET_VERSION = 1;
export const SCENE_PACKET_HEADER_BYTES = 24;
export const SCENE_PACKET_MESSAGE_BOOTSTRAP = 1;
export const SCENE_PACKET_MESSAGE_FRAME = 2;
export const SCENE_BOOTSTRAP_SCHEMA_VERSION = 2;
export const PRESENTATION_FRAME_SCHEMA_VERSION = 2;
export const PRESENTATION_TICKS_PER_SECOND = 60;

const UINT32_MAX = 0xffffffff;
const BOOTSTRAP_HEADER_BYTES = 96;
const FRAME_HEADER_BYTES = 80;
const DIRECTORY_ENTRY_BYTES = 20;
const BOOTSTRAP_SECTION_TYPES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const BOOTSTRAP_STRIDES = Object.freeze([0, 80, 32, 16, 32, 16, 0]);
const FRAME_SECTION_TYPES = Object.freeze([1, 2, 3, 4, 5]);
const FRAME_STRIDES = Object.freeze([72, 64, 32, 0, 40]);
const ENTITY_INTERACTIVE_FLAG = 4;
const DOMAIN_KINDS = new Set([1, 2, 3]);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class PresentationBinaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PresentationBinaryError';
  }
}

export function parseScenePacket(value, limits = {}) {
  const bytes = borrowedBytes(value);
  const maximumStoredBytes = uint32Limit(limits.maximumStoredBytes);
  const maximumUncompressedBytes = uint32Limit(limits.maximumUncompressedBytes);
  if (bytes.byteLength < SCENE_PACKET_HEADER_BYTES) fail('packet header is truncated');
  if (bytes.byteLength > SCENE_PACKET_HEADER_BYTES + maximumStoredBytes) {
    fail('packet exceeds maximumStoredBytes');
  }
  const view = dataView(bytes);
  const header = Object.freeze({
    packetVersion: view.getUint16(4, true),
    messageType: view.getUint8(6),
    compressionCodec: view.getUint8(7),
    flags: view.getUint16(8, true),
    headerBytes: view.getUint16(10, true),
    uncompressedBytes: view.getUint32(12, true),
    storedBytes: view.getUint32(16, true),
    reserved0: view.getUint32(20, true),
  });
  if (ascii(bytes.subarray(0, 4)) !== SCENE_PACKET_MAGIC
      || header.packetVersion !== SCENE_PACKET_VERSION
      || ![SCENE_PACKET_MESSAGE_BOOTSTRAP, SCENE_PACKET_MESSAGE_FRAME].includes(header.messageType)
      || header.compressionCodec !== 0 || header.flags !== 0
      || header.headerBytes !== SCENE_PACKET_HEADER_BYTES || header.reserved0 !== 0
      || header.storedBytes !== header.uncompressedBytes
      || header.storedBytes > maximumStoredBytes
      || header.uncompressedBytes > maximumUncompressedBytes
      || bytes.byteLength !== header.headerBytes + header.storedBytes) {
    fail('packet header or length is non-canonical');
  }
  return Object.freeze({ data: bytes, header, payload: bytes.subarray(header.headerBytes) });
}

export function parseSceneBootstrapV2(value, limits = {}) {
  const bytes = borrowedBytes(value);
  if (bytes.byteLength > uint32Limit(limits.maximumBootstrapBytes)
      || bytes.byteLength < BOOTSTRAP_HEADER_BYTES) fail('bootstrap byte length is invalid');
  const view = dataView(bytes);
  const header = Object.freeze({
    schemaVersion: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    headerBytes: view.getUint16(4, true),
    sectionCount: view.getUint16(6, true),
    sceneEpoch: u64(view, 8),
    bootstrapId: u64(view, 16),
    ticksPerSecond: view.getUint16(24, true),
    coordinateProfile: view.getUint16(26, true),
    worldUnitsPerMeter: view.getFloat32(28, true),
    maximumDynamicEntities: view.getUint32(32, true),
    maximumFrameBytes: view.getUint32(36, true),
    directoryBytes: view.getUint32(40, true),
    payloadBytes: view.getUint32(44, true),
    contentSha256: hex(bytes.subarray(48, 80)),
  });
  if (header.schemaVersion !== SCENE_BOOTSTRAP_SCHEMA_VERSION || header.flags !== 1
      || header.headerBytes !== BOOTSTRAP_HEADER_BYTES
      || header.sectionCount !== BOOTSTRAP_SECTION_TYPES.length
      || header.sceneEpoch === '0' || header.bootstrapId === '0'
      || header.ticksPerSecond !== PRESENTATION_TICKS_PER_SECOND
      || header.coordinateProfile !== 1 || !Number.isFinite(header.worldUnitsPerMeter)
      || header.worldUnitsPerMeter <= 0 || header.maximumFrameBytes === 0
      || header.directoryBytes !== header.sectionCount * DIRECTORY_ENTRY_BYTES
      || header.headerBytes + header.directoryBytes + header.payloadBytes !== bytes.byteLength
      || !allZero(bytes.subarray(80, 96))) fail('bootstrap header is non-canonical');
  if (sha256HexBytes(bytes.subarray(header.headerBytes)) !== header.contentSha256) {
    fail('bootstrap content_sha256 mismatch');
  }
  const directory = parseDirectory(bytes, {
    countLimits: [
      1,
      uint32Limit(limits.maximumStaticNodes),
      uint32Limit(limits.maximumTopologyNodes),
      uint32Limit(limits.maximumAdjacencies),
      uint32Limit(limits.maximumVisualTypes),
      uint32Limit(limits.maximumAnimationStates),
      1,
    ],
    expectedHeaderBytes: BOOTSTRAP_HEADER_BYTES,
    sectionTypes: BOOTSTRAP_SECTION_TYPES,
    strides: BOOTSTRAP_STRIDES,
    variableSectionIndexes: new Set([0, 6]),
    singleRecordVariableSectionIndexes: new Set([0, 6]),
  });
  const identity = parseSessionIdentity(bytes, directory[0]);
  const staticNodes = parseStaticNodes(bytes, directory[1]);
  const topologyNodes = parseTopologyNodes(bytes, directory[2]);
  const adjacencies = parseAdjacencies(bytes, directory[3]);
  const visualRegistry = parseVisualRegistry(bytes, directory[4]);
  const animationRegistry = parseAnimationRegistry(bytes, directory[5]);
  const authorityBaseline = parseAuthorityBaseline(bytes, directory[6]);
  validateBootstrapReferences({ adjacencies, animationRegistry, staticNodes, topologyNodes, visualRegistry });
  return Object.freeze({
    adjacencies, animationRegistry, authorityBaseline, data: bytes, directory, header, identity,
    staticNodes, topologyNodes, visualRegistry,
  });
}

export function parsePresentationFrame(value, limits = {}) {
  const bytes = borrowedBytes(value);
  if (bytes.byteLength > uint32Limit(limits.maximumFrameBytes)
      || bytes.byteLength < FRAME_HEADER_BYTES) fail('frame byte length is invalid');
  const view = dataView(bytes);
  const header = Object.freeze({
    schemaVersion: view.getUint16(0, true), flags: view.getUint16(2, true),
    headerBytes: view.getUint16(4, true), sectionCount: view.getUint16(6, true),
    sceneEpoch: u64(view, 8), bootstrapId: u64(view, 16), frameSeq: u64(view, 24),
    sourceTick: u64(view, 32), projectionId: u64(view, 40),
    ticksPerSecond: view.getUint16(48, true), reserved0: view.getUint16(50, true),
    entityCount: view.getUint32(52, true), eventCount: view.getUint32(56, true),
    interactionCount: view.getUint32(60, true), payloadBytes: view.getUint32(64, true),
    directoryBytes: view.getUint32(68, true), ownerStateCount: view.getUint32(72, true),
    reserved1: view.getUint32(76, true),
  });
  if (header.schemaVersion !== PRESENTATION_FRAME_SCHEMA_VERSION || header.flags !== 1
      || header.headerBytes !== FRAME_HEADER_BYTES || header.sectionCount !== FRAME_SECTION_TYPES.length
      || [header.sceneEpoch, header.bootstrapId, header.frameSeq, header.projectionId].includes('0')
      || header.ticksPerSecond !== PRESENTATION_TICKS_PER_SECOND
      || header.reserved0 !== 0 || header.reserved1 !== 0
      || header.entityCount > uint32Limit(limits.maximumFrameEntities)
      || header.eventCount > uint32Limit(limits.maximumFrameEvents)
      || header.interactionCount > header.entityCount || header.ownerStateCount !== header.entityCount
      || header.directoryBytes !== header.sectionCount * DIRECTORY_ENTRY_BYTES
      || header.headerBytes + header.directoryBytes + header.payloadBytes !== bytes.byteLength) {
    fail('presentation frame header is non-canonical');
  }
  const directory = parseDirectory(bytes, {
    countLimits: [header.entityCount, header.ownerStateCount, header.interactionCount,
      header.interactionCount, header.eventCount],
    exactCounts: true,
    expectedHeaderBytes: FRAME_HEADER_BYTES,
    sectionTypes: FRAME_SECTION_TYPES,
    strides: FRAME_STRIDES,
    variableSectionIndexes: new Set([3]),
    singleRecordVariableSectionIndexes: new Set(),
  });
  const entities = parseEntities(bytes, directory[0], header.sourceTick);
  const ownerStates = parseOwnerStates(bytes, directory[1], entities);
  const interactions = parseInteractions(bytes, directory[2], directory[3]);
  const events = parseEvents(bytes, directory[4], header.sourceTick);
  const interactive = new Set(entities.filter((item) => item.flags & ENTITY_INTERACTIVE_FLAG)
    .map((item) => item.displayId));
  const mapped = new Set(interactions.map((item) => item.displayId));
  if (!setEquals(interactive, mapped)) fail('interactive entity and mapping sets differ');
  return Object.freeze({ data: bytes, directory, entities, events, header, interactions, ownerStates });
}

export function decodeSceneBootstrapV2Packet(value, limits = {}) {
  const packet = parseScenePacket(value, limits);
  if (packet.header.messageType !== SCENE_PACKET_MESSAGE_BOOTSTRAP) fail('packet is not scene.bootstrap');
  return parseSceneBootstrapV2(packet.payload, limits);
}

export function decodePresentationFramePacket(value, limits = {}) {
  const packet = parseScenePacket(value, limits);
  if (packet.header.messageType !== SCENE_PACKET_MESSAGE_FRAME) fail('packet is not display.frame');
  return parsePresentationFrame(packet.payload, limits);
}

function parseDirectory(bytes, options) {
  const { countLimits, exactCounts = false, expectedHeaderBytes, sectionTypes, strides,
    variableSectionIndexes, singleRecordVariableSectionIndexes } = options;
  const view = dataView(bytes);
  const entries = [];
  let previousEnd = expectedHeaderBytes + sectionTypes.length * DIRECTORY_ENTRY_BYTES;
  for (let index = 0; index < sectionTypes.length; index += 1) {
    const offset = expectedHeaderBytes + index * DIRECTORY_ENTRY_BYTES;
    const entry = Object.freeze({
      sectionType: view.getUint16(offset, true), flags: view.getUint16(offset + 2, true),
      recordCount: view.getUint32(offset + 4, true), byteOffset: view.getUint32(offset + 8, true),
      byteLength: view.getUint32(offset + 12, true), recordStride: view.getUint16(offset + 16, true),
      reserved0: view.getUint16(offset + 18, true),
    });
    if (entry.sectionType !== sectionTypes[index] || entry.flags !== 1
        || entry.recordStride !== strides[index] || entry.reserved0 !== 0
        || entry.recordCount > countLimits[index]
        || (exactCounts && entry.recordCount !== countLimits[index])
        || (!variableSectionIndexes.has(index) && entry.byteLength !== entry.recordCount * entry.recordStride)
        || (singleRecordVariableSectionIndexes.has(index) && entry.recordCount !== 1)
        || entry.byteOffset !== previousEnd || entry.byteOffset % 4 !== 0
        || entry.byteOffset + entry.byteLength > bytes.byteLength) fail('section directory is non-canonical');
    previousEnd = entry.byteOffset + entry.byteLength;
    entries.push(entry);
  }
  if (previousEnd !== bytes.byteLength) fail('message has trailing or unindexed bytes');
  return Object.freeze(entries);
}

function parseSessionIdentity(bytes, entry) {
  if (entry.byteLength < 12) fail('session identity section is truncated');
  const view = dataView(bytes);
  const lengths = [0, 2, 4].map((offset) => view.getUint16(entry.byteOffset + offset, true));
  const total = view.getUint32(entry.byteOffset + 6, true);
  if (view.getUint16(entry.byteOffset + 10, true) !== 0 || lengths.some((length) => length === 0)
      || total !== lengths.reduce((sum, length) => sum + length, 0)
      || align4(12 + total) !== entry.byteLength) fail('session identity section is non-canonical');
  let cursor = entry.byteOffset + 12;
  const strings = lengths.map((length) => {
    const result = canonicalString(bytes.subarray(cursor, cursor + length));
    cursor += length;
    return result;
  });
  ensureZeroPadding(bytes, cursor, entry.byteOffset + entry.byteLength);
  return Object.freeze({ runId: strings[0], viewerScope: strings[1], profileId: strings[2] });
}

function parseAuthorityBaseline(bytes, entry) {
  if (entry.byteLength < 12) fail('authority baseline section is truncated');
  const view = dataView(bytes);
  const codecLength = view.getUint16(entry.byteOffset, true);
  const cursorLength = view.getUint32(entry.byteOffset + 2, true);
  const total = view.getUint32(entry.byteOffset + 6, true);
  if (view.getUint16(entry.byteOffset + 10, true) !== 0 || codecLength === 0 || cursorLength === 0
      || total !== codecLength + cursorLength || align4(12 + total) !== entry.byteLength) {
    fail('authority baseline section is non-canonical');
  }
  let cursor = entry.byteOffset + 12;
  const codecIdentity = canonicalString(bytes.subarray(cursor, cursor + codecLength));
  cursor += codecLength;
  const canonicalBytes = bytes.subarray(cursor, cursor + cursorLength);
  cursor += cursorLength;
  ensureZeroPadding(bytes, cursor, entry.byteOffset + entry.byteLength);
  return Object.freeze({ codecIdentity, canonicalBytes });
}

function parseStaticNodes(bytes, entry) {
  const view = dataView(bytes); const result = []; let previous = 0n;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride;
    const display = view.getBigUint64(offset, true); const parent = view.getBigUint64(offset + 8, true);
    const record = Object.freeze({
      displayId: display.toString(), parentDisplayId: parent.toString(),
      visualTypeId: view.getUint32(offset + 16, true), ownerTypeId: view.getUint32(offset + 20, true),
      flags: view.getUint32(offset + 24, true), position: floatTuple(view, offset + 32, 3),
      rotationXyzw: floatTuple(view, offset + 44, 4), scale: floatTuple(view, offset + 60, 3),
      variantId: view.getUint32(offset + 72, true), contentId: view.getUint32(offset + 76, true),
    });
    if (display === 0n || display <= previous || (parent !== 0n && parent >= display)
        || view.getUint32(offset + 28, true) !== 0 || record.visualTypeId === 0
        || record.ownerTypeId === 0 || record.contentId === 0 || record.flags & ~1) {
      fail('static node is non-canonical');
    }
    validatePose(record); result.push(record); previous = display;
  }
  return Object.freeze(result);
}

function parseTopologyNodes(bytes, entry) {
  const view = dataView(bytes); const result = []; let previous = 0n;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride; const display = view.getBigUint64(offset, true);
    const record = Object.freeze({ staticDisplayId: display.toString(), islandTypeId: view.getUint32(offset + 8, true),
      tileTypeId: view.getUint32(offset + 12, true), axialQ: view.getInt32(offset + 16, true),
      axialR: view.getInt32(offset + 20, true), terrainTypeId: view.getUint32(offset + 24, true),
      flags: view.getUint32(offset + 28, true) });
    if (display === 0n || display <= previous || record.islandTypeId === 0 || record.tileTypeId === 0
        || record.terrainTypeId === 0 || record.flags !== 0) fail('topology node is non-canonical');
    result.push(record); previous = display;
  }
  return Object.freeze(result);
}

function parseAdjacencies(bytes, entry) {
  const view = dataView(bytes); const result = []; let previous = [0n, 0n];
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride;
    const pair = [view.getBigUint64(offset, true), view.getBigUint64(offset + 8, true)];
    if (pair[0] === 0n || pair[0] >= pair[1] || comparePair(pair, previous) <= 0) fail('adjacency is non-canonical');
    result.push(Object.freeze({ fromDisplayId: pair[0].toString(), toDisplayId: pair[1].toString() }));
    previous = pair;
  }
  return Object.freeze(result);
}

function parseVisualRegistry(bytes, entry) {
  const view = dataView(bytes); const result = []; let previous = 0;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride;
    const record = Object.freeze({ visualTypeId: view.getUint32(offset, true), ownerTypeId: view.getUint32(offset + 4, true),
      variantId: view.getUint32(offset + 8, true), capabilityFlags: view.getUint32(offset + 12, true),
      resourceContentId: view.getUint32(offset + 16, true), placementProfileId: view.getUint32(offset + 20, true),
      animationRegistryStart: view.getUint32(offset + 24, true), animationRegistryCount: view.getUint32(offset + 28, true) });
    if (record.visualTypeId === 0 || record.visualTypeId <= previous || record.ownerTypeId === 0
        || record.resourceContentId === 0 || record.placementProfileId === 0
        || record.capabilityFlags & ~7) fail('visual registry is non-canonical');
    result.push(record); previous = record.visualTypeId;
  }
  return Object.freeze(result);
}

function parseAnimationRegistry(bytes, entry) {
  const view = dataView(bytes); const result = []; let previous = 0;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride;
    const record = Object.freeze({ animationStateId: view.getUint32(offset, true), flags: view.getUint32(offset + 4, true),
      durationTicks: view.getUint32(offset + 8, true) });
    if (record.animationStateId === 0 || record.animationStateId <= previous || record.durationTicks === 0
        || record.flags & ~7 || view.getUint32(offset + 12, true) !== 0) fail('animation registry is non-canonical');
    result.push(record); previous = record.animationStateId;
  }
  return Object.freeze(result);
}

function parseEntities(bytes, entry, sourceTick) {
  const view = dataView(bytes); const result = []; let previous = 0n; const source = BigInt(sourceTick);
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride; const display = view.getBigUint64(offset, true);
    const animationStart = view.getBigUint64(offset + 60, true);
    const record = Object.freeze({ displayId: display.toString(), visualTypeId: view.getUint32(offset + 8, true),
      flags: view.getUint32(offset + 12, true), position: floatTuple(view, offset + 16, 3),
      rotationXyzw: floatTuple(view, offset + 28, 4), scale: floatTuple(view, offset + 44, 3),
      animationStateId: view.getUint32(offset + 56, true), animationStartTick: animationStart.toString(),
      animationFlags: view.getUint32(offset + 68, true) });
    if (display === 0n || display <= previous || record.visualTypeId === 0 || record.flags & ~7
        || animationStart > source) fail('presentation entity is non-canonical');
    validatePose(record); result.push(record); previous = display;
  }
  return Object.freeze(result);
}

function parseOwnerStates(bytes, entry, entities) {
  const view = dataView(bytes);
  return Object.freeze(entities.map((entity, index) => {
    const offset = entry.byteOffset + index * entry.recordStride;
    const record = Object.freeze({ displayId: u64(view, offset), parentDisplayId: u64(view, offset + 8),
      mountPointId: view.getUint32(offset + 16, true), variantId: view.getUint32(offset + 20, true),
      damageStateId: view.getUint32(offset + 24, true), constructionStateId: view.getUint32(offset + 28, true),
      assignmentStateId: view.getUint32(offset + 32, true), sideId: view.getUint32(offset + 36, true),
      colorRgba: view.getUint32(offset + 40, true), ownerFlags: view.getUint32(offset + 44, true),
      scalars: floatTuple(view, offset + 48, 3) });
    if (record.displayId !== entity.displayId || view.getUint32(offset + 60, true) !== 0) {
      fail('owner state identity/reserved mismatch');
    }
    return record;
  }));
}

function parseInteractions(bytes, records, strings) {
  const view = dataView(bytes); const stringBytes = bytes.subarray(strings.byteOffset, strings.byteOffset + strings.byteLength);
  const result = []; let previous = 0n; let expectedOffset = 0;
  for (let index = 0; index < records.recordCount; index += 1) {
    const offset = records.byteOffset + index * records.recordStride; const display = view.getBigUint64(offset, true);
    const domainKind = view.getUint32(offset + 8, true); const capabilityFlags = view.getUint32(offset + 12, true);
    const stringOffset = view.getUint32(offset + 16, true); const stringLength = view.getUint32(offset + 20, true);
    const end = stringOffset + stringLength;
    if (display === 0n || display <= previous || capabilityFlags === 0 || !DOMAIN_KINDS.has(domainKind)
        || stringLength === 0 || stringOffset !== expectedOffset || end > stringBytes.byteLength) {
      fail('interaction mapping is non-canonical');
    }
    result.push(Object.freeze({ displayId: display.toString(), domainKind, capabilityFlags,
      domainValue: canonicalString(stringBytes.subarray(stringOffset, end)),
      tileQ: view.getInt32(offset + 24, true), tileR: view.getInt32(offset + 28, true) }));
    previous = display; expectedOffset = end;
  }
  if (align4(expectedOffset) !== stringBytes.byteLength || !allZero(stringBytes.subarray(expectedOffset))) {
    fail('interaction string padding is non-canonical');
  }
  return Object.freeze(result);
}

function parseEvents(bytes, entry, sourceTick) {
  const view = dataView(bytes); const result = []; let previous = 0n; const source = BigInt(sourceTick);
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * entry.recordStride; const event = view.getBigUint64(offset, true);
    const start = view.getBigUint64(offset + 32, true);
    const record = Object.freeze({ eventId: event.toString(), effectTypeId: view.getUint32(offset + 8, true),
      flags: view.getUint32(offset + 12, true), sourceDisplayId: u64(view, offset + 16),
      targetDisplayId: u64(view, offset + 24), startTick: start.toString() });
    if (event === 0n || event <= previous || record.effectTypeId === 0 || record.flags & ~1 || start > source) {
      fail('presentation event is non-canonical');
    }
    result.push(record); previous = event;
  }
  return Object.freeze(result);
}

function validateBootstrapReferences({ adjacencies, animationRegistry, staticNodes, topologyNodes, visualRegistry }) {
  const staticIds = new Set(staticNodes.map((item) => item.displayId));
  const staticById = new Map(staticNodes.map((item) => [item.displayId, item]));
  const topologyIds = new Set(topologyNodes.map((item) => item.staticDisplayId));
  const visualIds = new Set(visualRegistry.map((item) => item.visualTypeId));
  for (const node of staticNodes) {
    if ((node.parentDisplayId !== '0' && !staticIds.has(node.parentDisplayId))
        || !visualIds.has(node.visualTypeId)) fail('static node cross-reference is missing');
  }
  for (const node of topologyNodes) {
    const tile = staticById.get(node.staticDisplayId); const island = staticById.get(tile?.parentDisplayId);
    if (!tile || !island || island.parentDisplayId !== '0' || topologyIds.has(island.displayId)) {
      fail('topology static island parent is missing or invalid');
    }
  }
  for (const edge of adjacencies) {
    if (!topologyIds.has(edge.fromDisplayId) || !topologyIds.has(edge.toDisplayId)) {
      fail('adjacency topology node is missing');
    }
  }
  for (const visual of visualRegistry) {
    if (visual.animationRegistryStart + visual.animationRegistryCount > animationRegistry.length) {
      fail('visual animation range is out of bounds');
    }
  }
}

function borrowedBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('binary input must be ArrayBuffer or typed array');
}

function uint32Limit(value) {
  if (value === undefined) return UINT32_MAX;
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) fail('byte/count limit must be uint32');
  return value;
}

function dataView(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u64(view, offset) { return view.getBigUint64(offset, true).toString(); }
function ascii(bytes) { return String.fromCharCode(...bytes); }
function hex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }
function allZero(bytes) { return bytes.every((value) => value === 0); }
function align4(value) { return (value + 3) & ~3; }
function comparePair(left, right) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return 0;
}
function setEquals(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
function floatTuple(view, offset, count) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const value = view.getFloat32(offset + index * 4, true);
    if (!Number.isFinite(value)) fail('float32 value must be finite');
    values.push(value);
  }
  return Object.freeze(values);
}
function validatePose(record) {
  const norm = Math.sqrt(record.rotationXyzw.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-3) fail('quaternion is not normalized');
}
function canonicalString(bytes) {
  let value;
  try { value = textDecoder.decode(bytes); } catch { fail('string is not valid UTF-8'); }
  if (!value || value.trim() !== value || value.includes('\0') || value.normalize('NFC') !== value) {
    fail('string is not canonical NFC');
  }
  return value;
}
function ensureZeroPadding(bytes, start, end) {
  if (!allZero(bytes.subarray(start, end))) fail('section padding must be zero');
}
function fail(message) { throw new PresentationBinaryError(message); }
