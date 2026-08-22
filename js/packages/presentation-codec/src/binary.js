import { sha256HexBytes } from './hash.js';

export const SCENE_PACKET_MAGIC = 'SEDF';
export const SCENE_PACKET_VERSION = 1;
export const SCENE_PACKET_HEADER_BYTES = 24;
export const SCENE_PACKET_MESSAGE_BOOTSTRAP = 1;
export const SCENE_PACKET_MESSAGE_FRAME = 2;
export const SCENE_BOOTSTRAP_SCHEMA_VERSION = 3;
export const PRESENTATION_FRAME_SCHEMA_VERSION = 3;
export const PRESENTATION_TICKS_PER_SECOND = 60;
export const PRESENTATION_NODE_RECORD_BYTES = 80;

const UINT32_MAX = 0xffffffff;
const BOOTSTRAP_HEADER_BYTES = 96;
const FRAME_HEADER_BYTES = 80;
const DIRECTORY_ENTRY_BYTES = 20;
const NODE_PAYLOAD_REF_BYTES = 24;
const SCENE_METADATA_REF_BYTES = 16;
const VISUAL_TYPE_RECORD_BYTES = 16;
const ANIMATION_STATE_RECORD_BYTES = 16;
const EVENT_RECORD_BYTES = 48;
const BOOTSTRAP_SECTION_TYPES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const BOOTSTRAP_STRIDES = Object.freeze([0, 0, 80, 24, 1, 24, 1, 16, 1, 16, 16]);
const FRAME_SECTION_TYPES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const FRAME_STRIDES = Object.freeze([80, 24, 1, 24, 1, 48, 1]);
const NODE_ALLOWED_FLAGS = 1;
const VISUAL_ALLOWED_FLAGS = 7;
const ANIMATION_ALLOWED_FLAGS = 7;
const EVENT_ALLOWED_FLAGS = 1;
const MAXIMUM_SESSION_IDENTITY_UTF8_BYTES = 4096;
const MAXIMUM_CURSOR_CODEC_IDENTITY_BYTES = 160;
const MAXIMUM_AUTHORITY_CURSOR_BYTES = 16 * 1024;
const CURSOR_CODEC_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
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

export function parseSceneBootstrapV3(value, limits = {}) {
  const bytes = borrowedBytes(value);
  if (bytes.byteLength > uint32Limit(limits.maximumBootstrapBytes)
      || bytes.byteLength < BOOTSTRAP_HEADER_BYTES) fail('bootstrap byte length is invalid');
  const view = dataView(bytes);
  const header = Object.freeze({
    schemaVersion: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    headerBytes: view.getUint16(4, true),
    sectionCount: view.getUint16(6, true),
    sceneEpoch: view.getBigUint64(8, true),
    bootstrapId: view.getBigUint64(16, true),
    ticksPerSecond: view.getUint16(24, true),
    coordinateProfile: view.getUint16(26, true),
    worldUnitsPerMeter: view.getFloat32(28, true),
    maximumDynamicNodes: view.getUint32(32, true),
    maximumFrameBytes: view.getUint32(36, true),
    directoryBytes: view.getUint32(40, true),
    payloadBytes: view.getUint32(44, true),
    contentSha256: hex(bytes.subarray(48, 80)),
  });
  if (header.schemaVersion !== SCENE_BOOTSTRAP_SCHEMA_VERSION || header.flags !== 1
      || header.headerBytes !== BOOTSTRAP_HEADER_BYTES
      || header.sectionCount !== BOOTSTRAP_SECTION_TYPES.length
      || header.sceneEpoch === 0n || header.bootstrapId === 0n
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
      1,
      uint32Limit(limits.maximumStaticNodes),
      uint32Limit(limits.maximumStaticNodes),
      UINT32_MAX,
      uint32Limit(limits.maximumStaticNodes),
      UINT32_MAX,
      uint32Limit(limits.maximumSceneMetadata),
      UINT32_MAX,
      uint32Limit(limits.maximumVisualTypes),
      uint32Limit(limits.maximumAnimationStates),
    ],
    expectedHeaderBytes: BOOTSTRAP_HEADER_BYTES,
    sectionTypes: BOOTSTRAP_SECTION_TYPES,
    strides: BOOTSTRAP_STRIDES,
    variableSectionIndexes: new Set([0, 1, 4, 6, 8]),
    singleRecordVariableSectionIndexes: new Set([0, 1]),
  });
  const identity = parseSessionIdentity(bytes, directory[0]);
  const authorityBaseline = parseAuthorityBaseline(bytes, directory[1]);
  const visuals = validateVisualTypes(bytes, directory[9]);
  const animations = validateAnimationStates(bytes, directory[10]);
  const nodes = new BorrowedNodeTable(bytes, {
    nodeEntry: directory[2],
    profileEntry: directory[3],
    profileBytesEntry: directory[4],
    interactionEntry: directory[5],
    interactionBytesEntry: directory[6],
    sourceTick: null,
  });
  nodes.validate({ visuals, animations });
  nodes.validateStaticParentClosure();
  validateSceneMetadata(bytes, directory[7], directory[8]);
  return new SceneBootstrapV3View({
    authorityBaseline,
    bytes,
    directory,
    header,
    identity,
    nodes,
    metadataEntry: directory[7],
    metadataBytesEntry: directory[8],
    visualEntry: directory[9],
    animationEntry: directory[10],
  });
}

export function parsePresentationFrameV3(value, limits = {}) {
  const bytes = borrowedBytes(value);
  if (bytes.byteLength > uint32Limit(limits.maximumFrameBytes)
      || bytes.byteLength < FRAME_HEADER_BYTES) fail('frame byte length is invalid');
  const view = dataView(bytes);
  const header = Object.freeze({
    schemaVersion: view.getUint16(0, true),
    flags: view.getUint16(2, true),
    headerBytes: view.getUint16(4, true),
    sectionCount: view.getUint16(6, true),
    sceneEpoch: view.getBigUint64(8, true),
    bootstrapId: view.getBigUint64(16, true),
    frameSeq: view.getBigUint64(24, true),
    sourceTick: view.getBigUint64(32, true),
    projectionId: view.getBigUint64(40, true),
    ticksPerSecond: view.getUint16(48, true),
    reserved0: view.getUint16(50, true),
    nodeCount: view.getUint32(52, true),
    profileCount: view.getUint32(56, true),
    interactionCount: view.getUint32(60, true),
    payloadBytes: view.getUint32(64, true),
    directoryBytes: view.getUint32(68, true),
    eventCount: view.getUint32(72, true),
    reserved1: view.getUint32(76, true),
  });
  if (header.schemaVersion !== PRESENTATION_FRAME_SCHEMA_VERSION || header.flags !== 1
      || header.headerBytes !== FRAME_HEADER_BYTES
      || header.sectionCount !== FRAME_SECTION_TYPES.length
      || header.sceneEpoch === 0n || header.bootstrapId === 0n
      || header.frameSeq === 0n || header.projectionId === 0n
      || header.ticksPerSecond !== PRESENTATION_TICKS_PER_SECOND
      || header.reserved0 !== 0 || header.reserved1 !== 0
      || header.nodeCount > uint32Limit(limits.maximumFrameNodes)
      || header.eventCount > uint32Limit(limits.maximumFrameEvents)
      || header.profileCount > header.nodeCount || header.interactionCount > header.nodeCount
      || header.directoryBytes !== header.sectionCount * DIRECTORY_ENTRY_BYTES
      || header.headerBytes + header.directoryBytes + header.payloadBytes !== bytes.byteLength) {
    fail('presentation frame header is non-canonical');
  }
  const directory = parseDirectory(bytes, {
    countLimits: [header.nodeCount, header.nodeCount, UINT32_MAX, header.nodeCount,
      UINT32_MAX, header.eventCount, UINT32_MAX],
    exactCounts: new Map([[0, header.nodeCount], [1, header.nodeCount],
      [3, header.nodeCount], [5, header.eventCount]]),
    expectedHeaderBytes: FRAME_HEADER_BYTES,
    sectionTypes: FRAME_SECTION_TYPES,
    strides: FRAME_STRIDES,
    variableSectionIndexes: new Set([2, 4, 6]),
    singleRecordVariableSectionIndexes: new Set(),
  });
  const nodes = new BorrowedNodeTable(bytes, {
    nodeEntry: directory[0],
    profileEntry: directory[1],
    profileBytesEntry: directory[2],
    interactionEntry: directory[3],
    interactionBytesEntry: directory[4],
    sourceTick: header.sourceTick,
  });
  const counts = nodes.validate();
  if (counts.profileCount !== header.profileCount
      || counts.interactionCount !== header.interactionCount) fail('frame payload counts disagree');
  validateEvents(bytes, directory[5], directory[6], header.sourceTick);
  return new PresentationFrameV3View({ bytes, directory, header, nodes,
    eventEntry: directory[5], eventBytesEntry: directory[6] });
}

export function decodeSceneBootstrapV3Packet(value, limits = {}) {
  const packet = parseScenePacket(value, limits);
  if (packet.header.messageType !== SCENE_PACKET_MESSAGE_BOOTSTRAP) fail('packet is not scene.bootstrap');
  return parseSceneBootstrapV3(packet.payload, limits);
}

export function decodePresentationFrameV3Packet(value, limits = {}) {
  const packet = parseScenePacket(value, limits);
  if (packet.header.messageType !== SCENE_PACKET_MESSAGE_FRAME) fail('packet is not presentation.frame');
  return parsePresentationFrameV3(packet.payload, limits);
}

export class SceneBootstrapV3View {
  constructor(value) {
    Object.assign(this, value);
    this.raw = value.bytes;
    this.data = value.bytes;
    this.nodeCount = value.nodes.count;
    Object.freeze(this);
  }

  displayIdAt(index) { return this.nodes.displayIdAt(index); }
  parentDisplayIdAt(index) { return this.nodes.parentDisplayIdAt(index); }
  visualTypeIdAt(index) { return this.nodes.visualTypeIdAt(index); }
  flagsAt(index) { return this.nodes.flagsAt(index); }
  animationStateIdAt(index) { return this.nodes.animationStateIdAt(index); }
  animationStartTickAt(index) { return this.nodes.animationStartTickAt(index); }
  animationFlagsAt(index) { return this.nodes.animationFlagsAt(index); }
  readLocalPose(index, out) { return this.nodes.readLocalPose(index, out); }
  readProfileStateAt(index, out) { return this.nodes.readProfileStateAt(index, out); }
  readInteractionAt(index, out) { return this.nodes.readInteractionAt(index, out); }
  profileStateAt(index) { return this.nodes.payloadViewAt(index, 'profile'); }
  interactionAt(index) { return this.nodes.payloadViewAt(index, 'interaction'); }

  get metadataCount() { return this.metadataEntry.recordCount; }
  metadataAt(index) {
    checkIndex(index, this.metadataCount);
    const view = dataView(this.bytes);
    const offset = this.metadataEntry.byteOffset + index * SCENE_METADATA_REF_BYTES;
    const typeId = view.getUint32(offset, true);
    const flags = view.getUint32(offset + 4, true);
    const byteOffset = view.getUint32(offset + 8, true);
    const byteLength = view.getUint32(offset + 12, true);
    return Object.freeze({ typeId, flags, bytes: this.bytes.subarray(
      this.metadataBytesEntry.byteOffset + byteOffset,
      this.metadataBytesEntry.byteOffset + byteOffset + byteLength,
    ) });
  }

  get visualTypeCount() { return this.visualEntry.recordCount; }
  visualTypeAt(index) {
    checkIndex(index, this.visualTypeCount);
    const view = dataView(this.bytes);
    const offset = this.visualEntry.byteOffset + index * VISUAL_TYPE_RECORD_BYTES;
    return Object.freeze({
      visualTypeId: view.getUint32(offset, true),
      flags: view.getUint32(offset + 4, true),
      profileTypeId: view.getUint32(offset + 8, true),
      interactionTypeId: view.getUint32(offset + 12, true),
    });
  }

  get animationStateCount() { return this.animationEntry.recordCount; }
  animationStateAt(index) {
    checkIndex(index, this.animationStateCount);
    const view = dataView(this.bytes);
    const offset = this.animationEntry.byteOffset + index * ANIMATION_STATE_RECORD_BYTES;
    return Object.freeze({
      animationStateId: view.getUint32(offset, true),
      flags: view.getUint32(offset + 4, true),
      durationTicks: view.getUint32(offset + 8, true),
    });
  }
}

export class PresentationFrameV3View {
  constructor(value) {
    Object.assign(this, value);
    this.raw = value.bytes;
    this.data = value.bytes;
    this.nodeCount = value.nodes.count;
    this.eventCount = value.eventEntry.recordCount;
    Object.freeze(this);
  }

  displayIdAt(index) { return this.nodes.displayIdAt(index); }
  parentDisplayIdAt(index) { return this.nodes.parentDisplayIdAt(index); }
  visualTypeIdAt(index) { return this.nodes.visualTypeIdAt(index); }
  flagsAt(index) { return this.nodes.flagsAt(index); }
  animationStateIdAt(index) { return this.nodes.animationStateIdAt(index); }
  animationStartTickAt(index) { return this.nodes.animationStartTickAt(index); }
  animationFlagsAt(index) { return this.nodes.animationFlagsAt(index); }
  readLocalPose(index, out) { return this.nodes.readLocalPose(index, out); }
  readProfileStateAt(index, out) { return this.nodes.readProfileStateAt(index, out); }
  readInteractionAt(index, out) { return this.nodes.readInteractionAt(index, out); }
  profileStateAt(index) { return this.nodes.payloadViewAt(index, 'profile'); }
  interactionAt(index) { return this.nodes.payloadViewAt(index, 'interaction'); }

  eventAt(index) {
    checkIndex(index, this.eventCount);
    const view = dataView(this.bytes);
    const offset = this.eventEntry.byteOffset + index * EVENT_RECORD_BYTES;
    const payloadOffset = view.getUint32(offset + 40, true);
    const payloadLength = view.getUint32(offset + 44, true);
    return Object.freeze({
      eventId: view.getBigUint64(offset, true),
      eventTypeId: view.getUint32(offset + 8, true),
      flags: view.getUint32(offset + 12, true),
      sourceDisplayId: view.getBigUint64(offset + 16, true),
      targetDisplayId: view.getBigUint64(offset + 24, true),
      startTick: view.getBigUint64(offset + 32, true),
      payload: this.bytes.subarray(
        this.eventBytesEntry.byteOffset + payloadOffset,
        this.eventBytesEntry.byteOffset + payloadOffset + payloadLength,
      ),
    });
  }
}

class BorrowedNodeTable {
  constructor(bytes, options) {
    this.bytes = bytes;
    this.view = dataView(bytes);
    Object.assign(this, options);
    this.count = options.nodeEntry.recordCount;
  }

  nodeOffset(index) { checkIndex(index, this.count); return this.nodeEntry.byteOffset + index * 80; }
  displayIdAt(index) { return this.view.getBigUint64(this.nodeOffset(index), true); }
  parentDisplayIdAt(index) { return this.view.getBigUint64(this.nodeOffset(index) + 8, true); }
  visualTypeIdAt(index) { return this.view.getUint32(this.nodeOffset(index) + 16, true); }
  flagsAt(index) { return this.view.getUint32(this.nodeOffset(index) + 20, true); }
  animationStateIdAt(index) { return this.view.getUint32(this.nodeOffset(index) + 64, true); }
  animationStartTickAt(index) { return this.view.getBigUint64(this.nodeOffset(index) + 68, true); }
  animationFlagsAt(index) { return this.view.getUint32(this.nodeOffset(index) + 76, true); }

  readLocalPose(index, out) {
    if (!out || !out.localPosition || !out.localRotationXyzw || !out.localScale) {
      fail('MutablePose output is invalid');
    }
    const view = this.view; const offset = this.nodeOffset(index);
    readFloats(view, offset + 24, 3, out.localPosition);
    readFloats(view, offset + 36, 4, out.localRotationXyzw);
    readFloats(view, offset + 52, 3, out.localScale);
    return out;
  }

  readProfileStateAt(index, out) { return this.readPayloadAt(index, 'profile', out); }
  readInteractionAt(index, out) { return this.readPayloadAt(index, 'interaction', out); }

  readPayloadAt(index, kind, out) {
    if (!out || typeof out !== 'object') fail('payload output is invalid');
    checkIndex(index, this.count);
    const refs = kind === 'profile' ? this.profileEntry : this.interactionEntry;
    const blob = kind === 'profile' ? this.profileBytesEntry : this.interactionBytesEntry;
    const view = this.view;
    const offset = refs.byteOffset + index * NODE_PAYLOAD_REF_BYTES;
    const typeId = view.getUint32(offset + 8, true);
    const byteOffset = view.getUint32(offset + 16, true);
    const byteLength = view.getUint32(offset + 20, true);
    out.typeId = typeId;
    out.flags = view.getUint32(offset + 12, true);
    out.bytes = this.bytes.subarray(
      blob.byteOffset + byteOffset,
      blob.byteOffset + byteOffset + byteLength,
    );
    return typeId !== 0;
  }

  payloadViewAt(index, kind) {
    const result = this.payloadDescriptorAt(index, kind);
    return result.typeId === 0 ? null : Object.freeze(result);
  }

  payloadDescriptorAt(index, kind) {
    checkIndex(index, this.count);
    const refs = kind === 'profile' ? this.profileEntry : this.interactionEntry;
    const blob = kind === 'profile' ? this.profileBytesEntry : this.interactionBytesEntry;
    const view = this.view;
    const offset = refs.byteOffset + index * NODE_PAYLOAD_REF_BYTES;
    const typeId = view.getUint32(offset + 8, true);
    const flags = view.getUint32(offset + 12, true);
    const byteOffset = view.getUint32(offset + 16, true);
    const byteLength = view.getUint32(offset + 20, true);
    return { typeId, flags, bytes: this.bytes.subarray(
      blob.byteOffset + byteOffset,
      blob.byteOffset + byteOffset + byteLength,
    ) };
  }

  validate({ visuals = null, animations = null } = {}) {
    const view = this.view;
    let previous = 0n; let profileOffset = 0; let interactionOffset = 0;
    let profileCount = 0; let interactionCount = 0;
    const profile = { typeId: 0, byteLength: 0 };
    const interaction = { typeId: 0, byteLength: 0 };
    for (let index = 0; index < this.count; index += 1) {
      const offset = this.nodeEntry.byteOffset + index * 80;
      const displayId = view.getBigUint64(offset, true);
      const parentId = view.getBigUint64(offset + 8, true);
      const visualTypeId = view.getUint32(offset + 16, true);
      const flags = view.getUint32(offset + 20, true);
      const animationStateId = view.getUint32(offset + 64, true);
      const animationStartTick = view.getBigUint64(offset + 68, true);
      const animationFlags = view.getUint32(offset + 76, true);
      if (displayId === 0n || displayId <= previous || (parentId !== 0n && parentId >= displayId)
          || visualTypeId === 0 || flags & ~NODE_ALLOWED_FLAGS || animationFlags & ~ANIMATION_ALLOWED_FLAGS
          || (this.sourceTick != null && animationStartTick > this.sourceTick)
          || (visuals && !visuals.has(visualTypeId))
          || (animations && animationStateId !== 0 && !animations.has(animationStateId))) {
        fail('presentation node is non-canonical');
      }
      validatePose(view, offset);
      validateNodePayloadRef(view, this.profileEntry,
        this.profileBytesEntry, index, displayId, profileOffset, profile);
      validateNodePayloadRef(view, this.interactionEntry,
        this.interactionBytesEntry, index, displayId, interactionOffset, interaction);
      profileOffset += profile.byteLength; interactionOffset += interaction.byteLength;
      if (profile.typeId !== 0) profileCount += 1;
      if (interaction.typeId !== 0) interactionCount += 1;
      if (visuals) {
        const visual = visuals.get(visualTypeId);
        if (profile.typeId !== visual.profileTypeId
            || interaction.typeId !== visual.interactionTypeId) {
          fail('node payload type does not match visual registry');
        }
      }
      previous = displayId;
    }
    if (profileOffset !== this.profileBytesEntry.recordCount
        || interactionOffset !== this.interactionBytesEntry.recordCount) {
      fail('node payload blob has trailing bytes');
    }
    return { profileCount, interactionCount };
  }

  validateStaticParentClosure() {
    for (let index = 0; index < this.count; index += 1) {
      const parentId = this.view.getBigUint64(
        this.nodeEntry.byteOffset + index * 80 + 8,
        true,
      );
      if (parentId === 0n) continue;
      let low = 0;
      let high = index - 1;
      let found = false;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = this.view.getBigUint64(
          this.nodeEntry.byteOffset + middle * 80,
          true,
        );
        if (candidate === parentId) {
          found = true;
          break;
        }
        if (candidate < parentId) low = middle + 1;
        else high = middle - 1;
      }
      if (!found) fail('static presentation node has a dangling parent');
    }
  }
}

function parseDirectory(bytes, options) {
  const { countLimits, exactCounts = new Map(), expectedHeaderBytes, sectionTypes, strides,
    variableSectionIndexes, singleRecordVariableSectionIndexes } = options;
  const view = dataView(bytes); const entries = [];
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
        || (exactCounts.has(index) && entry.recordCount !== exactCounts.get(index))
        || entry.byteOffset !== previousEnd || entry.byteOffset % 4 !== 0
        || entry.byteOffset + entry.byteLength > bytes.byteLength) fail('section directory is non-canonical');
    if (variableSectionIndexes.has(index)) {
      if (singleRecordVariableSectionIndexes.has(index)) {
        if (entry.recordCount !== 1 || entry.recordStride !== 0) fail('variable singleton is non-canonical');
      } else if (entry.recordStride !== 1 || entry.byteLength !== align4(entry.recordCount)
          || !allZero(bytes.subarray(entry.byteOffset + entry.recordCount,
            entry.byteOffset + entry.byteLength))) fail('byte blob section is non-canonical');
    } else if (entry.byteLength !== entry.recordCount * entry.recordStride) {
      fail('fixed section byte length is non-canonical');
    }
    previousEnd = entry.byteOffset + entry.byteLength; entries.push(entry);
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
      || total > MAXIMUM_SESSION_IDENTITY_UTF8_BYTES
      || align4(12 + total) !== entry.byteLength) fail('session identity section is non-canonical');
  let cursor = entry.byteOffset + 12;
  const strings = lengths.map((length) => {
    const result = canonicalString(bytes.subarray(cursor, cursor + length)); cursor += length; return result;
  });
  ensureZeroPadding(bytes, cursor, entry.byteOffset + entry.byteLength);
  return Object.freeze({ runId: strings[0], viewerScope: strings[1], profileId: strings[2] });
}

function parseAuthorityBaseline(bytes, entry) {
  if (entry.byteLength < 12) fail('authority baseline section is truncated');
  const view = dataView(bytes); const codecLength = view.getUint16(entry.byteOffset, true);
  const cursorLength = view.getUint32(entry.byteOffset + 2, true);
  const total = view.getUint32(entry.byteOffset + 6, true);
  if (view.getUint16(entry.byteOffset + 10, true) !== 0 || codecLength === 0 || cursorLength === 0
      || codecLength > MAXIMUM_CURSOR_CODEC_IDENTITY_BYTES
      || cursorLength > MAXIMUM_AUTHORITY_CURSOR_BYTES
      || total !== codecLength + cursorLength || align4(12 + total) !== entry.byteLength) {
    fail('authority baseline section is non-canonical');
  }
  let cursor = entry.byteOffset + 12;
  const codecIdentity = canonicalString(bytes.subarray(cursor, cursor + codecLength)); cursor += codecLength;
  if (!CURSOR_CODEC_IDENTITY.test(codecIdentity)) {
    fail('authority baseline codec identity is invalid');
  }
  const canonicalBytes = bytes.subarray(cursor, cursor + cursorLength); cursor += cursorLength;
  ensureZeroPadding(bytes, cursor, entry.byteOffset + entry.byteLength);
  return Object.freeze({ codecIdentity, canonicalBytes });
}

function validateVisualTypes(bytes, entry) {
  const view = dataView(bytes); const result = new Map(); let previous = 0;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * VISUAL_TYPE_RECORD_BYTES;
    const visualTypeId = view.getUint32(offset, true);
    const flags = view.getUint32(offset + 4, true);
    const record = Object.freeze({ visualTypeId, flags,
      profileTypeId: view.getUint32(offset + 8, true),
      interactionTypeId: view.getUint32(offset + 12, true) });
    if (visualTypeId === 0 || visualTypeId <= previous || flags & ~VISUAL_ALLOWED_FLAGS) {
      fail('visual type registry is non-canonical');
    }
    result.set(visualTypeId, record); previous = visualTypeId;
  }
  return result;
}

function validateAnimationStates(bytes, entry) {
  const view = dataView(bytes); const result = new Set(); let previous = 0;
  for (let index = 0; index < entry.recordCount; index += 1) {
    const offset = entry.byteOffset + index * ANIMATION_STATE_RECORD_BYTES;
    const stateId = view.getUint32(offset, true); const flags = view.getUint32(offset + 4, true);
    if (stateId === 0 || stateId <= previous || flags & ~ANIMATION_ALLOWED_FLAGS
        || view.getUint32(offset + 8, true) === 0 || view.getUint32(offset + 12, true) !== 0) {
      fail('animation state registry is non-canonical');
    }
    result.add(stateId); previous = stateId;
  }
  return result;
}

function validateSceneMetadata(bytes, refs, blob) {
  const view = dataView(bytes); let previous = 0; let expectedOffset = 0;
  for (let index = 0; index < refs.recordCount; index += 1) {
    const offset = refs.byteOffset + index * SCENE_METADATA_REF_BYTES;
    const typeId = view.getUint32(offset, true); const flags = view.getUint32(offset + 4, true);
    const byteOffset = view.getUint32(offset + 8, true); const byteLength = view.getUint32(offset + 12, true);
    if (typeId === 0 || typeId <= previous || flags !== 0 || byteOffset !== expectedOffset
        || byteLength === 0 || byteOffset + byteLength > blob.recordCount) {
      fail('scene metadata is non-canonical');
    }
    previous = typeId; expectedOffset += byteLength;
  }
  if (expectedOffset !== blob.recordCount) fail('scene metadata blob has trailing bytes');
}

function validateNodePayloadRef(view, refs, blob, index, displayId, expectedOffset, out) {
  const offset = refs.byteOffset + index * NODE_PAYLOAD_REF_BYTES;
  const refDisplayId = view.getBigUint64(offset, true); const typeId = view.getUint32(offset + 8, true);
  const flags = view.getUint32(offset + 12, true); const byteOffset = view.getUint32(offset + 16, true);
  const byteLength = view.getUint32(offset + 20, true);
  if (refDisplayId !== displayId || flags !== 0 || byteOffset !== expectedOffset
      || byteOffset + byteLength > blob.recordCount
      || (typeId === 0) !== (byteLength === 0)) fail('node payload reference is non-canonical');
  out.typeId = typeId;
  out.byteLength = byteLength;
}

function validateEvents(bytes, records, blob, sourceTick) {
  const view = dataView(bytes); let previous = 0n; let expectedOffset = 0;
  for (let index = 0; index < records.recordCount; index += 1) {
    const offset = records.byteOffset + index * EVENT_RECORD_BYTES;
    const eventId = view.getBigUint64(offset, true); const typeId = view.getUint32(offset + 8, true);
    const flags = view.getUint32(offset + 12, true); const startTick = view.getBigUint64(offset + 32, true);
    const byteOffset = view.getUint32(offset + 40, true); const byteLength = view.getUint32(offset + 44, true);
    if (eventId === 0n || eventId <= previous || typeId === 0 || flags & ~EVENT_ALLOWED_FLAGS
        || startTick > sourceTick || byteOffset !== expectedOffset
        || byteOffset + byteLength > blob.recordCount) fail('presentation event is non-canonical');
    previous = eventId; expectedOffset += byteLength;
  }
  if (expectedOffset !== blob.recordCount) fail('event payload blob has trailing bytes');
}

function validatePose(view, offset) {
  let norm = 0;
  for (let index = 0; index < 3; index += 1) finite(view.getFloat32(offset + 24 + index * 4, true));
  for (let index = 0; index < 4; index += 1) {
    const value = finite(view.getFloat32(offset + 36 + index * 4, true)); norm += value * value;
  }
  for (let index = 0; index < 3; index += 1) {
    if (finite(view.getFloat32(offset + 52 + index * 4, true)) <= 0) fail('node scale must be positive');
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) fail('node quaternion is not normalized');
}

function readFloats(view, offset, count, target) {
  if (typeof target.length !== 'number' || target.length < count) fail('MutablePose tuple is invalid');
  for (let index = 0; index < count; index += 1) target[index] = view.getFloat32(offset + index * 4, true);
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

function checkIndex(index, count) {
  if (!Number.isInteger(index) || index < 0 || index >= count) fail('record index is out of range');
}

function finite(value) { if (!Number.isFinite(value)) fail('float32 value must be finite'); return value; }
function dataView(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function ascii(bytes) { return String.fromCharCode(...bytes); }
function hex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }
function allZero(bytes) { return bytes.every((value) => value === 0); }
function align4(value) { return (value + 3) & ~3; }
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
