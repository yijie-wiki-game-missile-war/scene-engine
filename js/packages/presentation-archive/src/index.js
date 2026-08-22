import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  canonicalJSON,
  parsePresentationControl,
} from '@scene-engine/presentation-codec';

const MANIFEST_NAME = 'presentation-manifest.json';
const INDEX_NAME = 'presentation-index.bin';
const SEGMENTS_NAME = 'presentation-segments.bin';
const MANIFEST_SCHEMA = 'scene-presentation-archive-v2@1';
const INDEX_MAGIC = 'SEIX';
const INDEX_VERSION = 2;
const INDEX_HEADER_BYTES = 64;
const INDEX_ENTRY_BYTES = 112;
const BLOCK_MAGIC = 'SEAB';
const BLOCK_VERSION = 2;
const BLOCK_HEADER_BYTES = 64;
const BLOCK_KIND_CHECKPOINT = 1;
const BLOCK_KIND_FRAME = 2;
const BLOCK_KIND_CORRELATION = 3;
const COMPRESSION_NONE = 0;
const SHA256_BYTES = 32;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class PresentationArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PresentationArchiveError';
  }
}

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maximumBlockBytes: 64 * 1024 * 1024,
  maximumCursorBytes: 16 * 1024,
  maximumEntries: 100_000_000,
  maximumSegments: 1_000_000,
});

export class FileByteRangeSource {
  static async open(path) {
    return new FileByteRangeSource(await open(path, 'r'));
  }

  constructor(handle) {
    this.handle = handle;
    this.closed = false;
  }

  async size() {
    this.requireOpen();
    return BigInt((await this.handle.stat()).size);
  }

  async read(offset, length) {
    this.requireOpen();
    const position = bigintToSafeNumber(offset, 'byte range offset');
    positiveSafeInteger(length, 'byte range length');
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new PresentationArchiveError('byte range is truncated');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close();
    }
  }

  requireOpen() {
    if (this.closed) throw new PresentationArchiveError('byte range source is closed');
  }
}

class FileByteSink {
  static async create(path, prefixBytes = 0) {
    const handle = await open(path, 'w+');
    const sink = new FileByteSink(handle);
    if (prefixBytes > 0) await sink.append(new Uint8Array(prefixBytes));
    return sink;
  }

  constructor(handle) {
    this.handle = handle;
    this.offset = 0n;
    this.closed = false;
  }

  async append(value) {
    this.requireOpen();
    const bytes = readonlyBytes(value, 'byte sink append');
    const start = this.offset;
    await this.handle.write(bytes, 0, bytes.byteLength, bigintToSafeNumber(start, 'sink offset'));
    this.offset += BigInt(bytes.byteLength);
    return start;
  }

  async writeAt(offset, value) {
    this.requireOpen();
    const bytes = readonlyBytes(value, 'byte sink writeAt');
    const numeric = bigintToSafeNumber(offset, 'sink write offset');
    if (offset + BigInt(bytes.byteLength) > this.offset) {
      throw new PresentationArchiveError('writeAt exceeds appended bytes');
    }
    await this.handle.write(bytes, 0, bytes.byteLength, numeric);
  }

  async sync() {
    this.requireOpen();
    await this.handle.sync();
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close();
    }
  }

  requireOpen() {
    if (this.closed) throw new PresentationArchiveError('byte sink is closed');
  }
}

export class PresentationArchiveWriter {
  static async createDirectory(directory, options) {
    await mkdir(directory, { recursive: true });
    const segments = await FileByteSink.create(join(directory, SEGMENTS_NAME));
    const index = await FileByteSink.create(join(directory, INDEX_NAME), INDEX_HEADER_BYTES);
    return new PresentationArchiveWriter({ directory, segments, index, ...options });
  }

  constructor({
    directory,
    segments,
    index,
    profileIdentity,
    sourceAuthorityArtifactIdentity,
    sourceAuthoritySha256,
    authorityCursorCodecIdentity,
    exporterIdentity,
    sceneEngineIdentity,
    visualManifestIdentity,
    resourceManifestIdentity,
    limits = {},
  }) {
    this.directory = directory;
    this.segments = segments;
    this.index = index;
    this.limits = normalizeLimits(limits);
    this.identities = Object.freeze({
      profile_identity: identity(profileIdentity, 'profileIdentity'),
      source_authority_artifact_identity: identity(
        sourceAuthorityArtifactIdentity,
        'sourceAuthorityArtifactIdentity',
      ),
      source_authority_sha256: sha256Identity(sourceAuthoritySha256, 'sourceAuthoritySha256'),
      authority_cursor_codec_identity: identity(
        authorityCursorCodecIdentity,
        'authorityCursorCodecIdentity',
      ),
      exporter_identity: identity(exporterIdentity, 'exporterIdentity'),
      scene_engine_identity: identity(sceneEngineIdentity, 'sceneEngineIdentity'),
      visual_manifest_identity: identity(visualManifestIdentity, 'visualManifestIdentity'),
      resource_manifest_identity: identity(resourceManifestIdentity, 'resourceManifestIdentity'),
    });
    this.indexHash = createHash('sha256');
    this.segmentsHash = createHash('sha256');
    this.entryCount = 0n;
    this.segmentCount = 0;
    this.checkpointCount = 0;
    this.frameCount = 0n;
    this.correlationCount = 0n;
    this.current = null;
    this.checkpointIds = new Set();
    this.lastSceneEpoch = 0n;
    this.lastBootstrapId = 0n;
    this.lastFrameSeq = 0n;
    this.lastCorrelationSeq = 0n;
    this.pendingFrames = new Map();
    this.startTick = null;
    this.endTick = null;
    this.sealed = false;
  }

  async startSegment({
    checkpointId,
    sceneEpoch,
    bootstrapId,
    sourceTick,
    bootstrapPacket,
  }) {
    this.requireWritable();
    if (this.current) await this.sealSegment();
    const checkpoint = decimalU64(checkpointId, 'checkpointId');
    const epoch = positiveBigInt(sceneEpoch, 'sceneEpoch');
    const bootstrap = positiveBigInt(bootstrapId, 'bootstrapId');
    const tick = nonnegativeBigInt(sourceTick, 'sourceTick');
    if (this.checkpointIds.has(checkpoint.toString())) {
      throw new PresentationArchiveError('checkpoint ID is duplicated');
    }
    if (epoch <= this.lastSceneEpoch || bootstrap <= this.lastBootstrapId) {
      throw new PresentationArchiveError(
        'new archive segment requires increasing scene epoch and Bootstrap identity',
      );
    }
    this.segmentCount += 1;
    if (this.segmentCount > this.limits.maximumSegments) {
      throw new PresentationArchiveError('archive exceeds maximumSegments');
    }
    this.current = {
      segmentId: this.segmentCount,
      checkpointId: checkpoint,
      sceneEpoch: epoch,
      bootstrapId: bootstrap,
      sourceTick: tick,
      frameCount: 0,
      correlationCount: 0,
    };
    this.checkpointCount += 1;
    this.checkpointIds.add(checkpoint.toString());
    this.lastSceneEpoch = epoch;
    this.lastBootstrapId = bootstrap;
    this.pendingFrames.clear();
    this.lastFrameSeq = 0n;
    this.lastCorrelationSeq = 0n;
    this.startTick ??= tick;
    this.endTick = tick;
    await this.appendBlock({
      kind: BLOCK_KIND_CHECKPOINT,
      recordSeq: checkpoint,
      sourceTick: tick,
      payload: bootstrapPacket,
      correlationSeq: 0n,
      frameSeq: 0n,
      projectionId: 0n,
    });
  }

  async appendFrame({ frameSeq, sourceTick, projectionId, packet }) {
    this.requireSegment();
    const sequence = positiveBigInt(frameSeq, 'frameSeq');
    if (sequence !== this.lastFrameSeq + 1n) {
      throw new PresentationArchiveError('frame sequence gap');
    }
    const tick = nonnegativeBigInt(sourceTick, 'sourceTick');
    if (this.endTick != null && tick !== this.endTick && tick !== this.endTick + 1n) {
      throw new PresentationArchiveError('frame source tick gap');
    }
    const projection = positiveBigInt(projectionId, 'projectionId');
    const entry = await this.appendBlock({
      kind: BLOCK_KIND_FRAME,
      recordSeq: sequence,
      sourceTick: tick,
      payload: packet,
      correlationSeq: 0n,
      frameSeq: sequence,
      projectionId: projection,
    });
    this.pendingFrames.set(sequence.toString(), {
      frameSeq: sequence,
      sourceTick: tick,
      projectionId: projection,
      sha256: entry.sha256,
    });
    if (this.pendingFrames.size > this.limits.maximumEntries) {
      throw new PresentationArchiveError('unbounded uncorrelated frame window');
    }
    this.lastFrameSeq = sequence;
    this.frameCount += 1n;
    this.current.frameCount += 1;
    this.endTick = tick;
  }

  async appendCorrelation({ correlation }) {
    this.requireSegment();
    const raw = readonlyBytes(correlation, 'correlation');
    const message = parsePresentationControl(raw, {
      direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    });
    if (message.type !== 'presentation.correlation') {
      throw new PresentationArchiveError('archive correlation record has wrong control type');
    }
    if (BigInt(message.scene_epoch) !== this.current.sceneEpoch
        || BigInt(message.bootstrap_id) !== this.current.bootstrapId) {
      throw new PresentationArchiveError('correlation checkpoint identity mismatch');
    }
    const payload = message.payload;
    const sequence = positiveBigInt(payload.correlation_seq, 'correlationSeq');
    if (sequence !== this.lastCorrelationSeq + 1n) {
      throw new PresentationArchiveError('correlation sequence gap');
    }
    const tick = nonnegativeBigInt(payload.source_tick, 'sourceTick');
    if (this.endTick != null && tick !== this.endTick && tick !== this.endTick + 1n) {
      throw new PresentationArchiveError('correlation source tick gap');
    }
    const projection = positiveBigInt(payload.projection_id, 'projectionId');
    for (const ref of payload.frame_refs) {
      const frame = this.pendingFrames.get(ref.frame_seq);
      if (!frame || frame.sha256 !== ref.sha256) {
        throw new PresentationArchiveError('correlation references an unknown frame');
      }
      if (frame.sourceTick !== tick || frame.projectionId !== projection) {
        throw new PresentationArchiveError('correlation frame identity mismatch');
      }
      this.pendingFrames.delete(ref.frame_seq);
    }
    if (payload.presentation_required !== (payload.frame_refs.length > 0)) {
      throw new PresentationArchiveError('correlation presentation_required mismatch');
    }
    await this.appendBlock({
      kind: BLOCK_KIND_CORRELATION,
      recordSeq: sequence,
      sourceTick: tick,
      payload: raw,
      correlationSeq: sequence,
      frameSeq: payload.frame_refs.length === 0
        ? this.lastFrameSeq
        : BigInt(payload.frame_refs.at(-1).frame_seq),
      projectionId: projection,
    });
    this.lastCorrelationSeq = sequence;
    this.correlationCount += 1n;
    this.current.correlationCount += 1;
    this.endTick = tick;
  }

  async sealSegment() {
    this.requireSegment();
    if (this.pendingFrames.size !== 0) {
      throw new PresentationArchiveError('segment contains uncorrelated frames');
    }
    if (this.current.frameCount === 0 || this.current.correlationCount === 0) {
      throw new PresentationArchiveError(
        'segment checkpoint requires a complete frame and correlation',
      );
    }
    this.current = null;
  }

  async seal() {
    this.requireWritable();
    if (this.current) await this.sealSegment();
    if (this.segmentCount === 0) throw new PresentationArchiveError('archive has no segments');
    const indexDigest = this.indexHash.digest();
    const indexHeader = encodeIndexHeader({
      entryCount: this.entryCount,
      payloadSha256: indexDigest,
    });
    await this.index.writeAt(0n, indexHeader);
    const segmentsDigest = this.segmentsHash.digest();
    const archiveRootSha256 = digestHex(Buffer.concat([indexDigest, segmentsDigest]));
    await this.index.sync();
    await this.segments.sync();
    const manifest = {
      archive_root_sha256: archiveRootSha256,
      checkpoint_count: this.checkpointCount,
      compression_codecs: ['none'],
      correlation_count: this.correlationCount.toString(),
      end_tick: this.endTick.toString(),
      entry_count: this.entryCount.toString(),
      frame_count: this.frameCount.toString(),
      hard_limits: {
        maximum_block_bytes: this.limits.maximumBlockBytes,
        maximum_cursor_bytes: this.limits.maximumCursorBytes,
        maximum_entries: this.limits.maximumEntries,
        maximum_segments: this.limits.maximumSegments,
      },
      index_payload_sha256: indexDigest.toString('hex'),
      schema_identity: MANIFEST_SCHEMA,
      segment_count: this.segmentCount,
      segments_sha256: segmentsDigest.toString('hex'),
      start_tick: this.startTick.toString(),
      ...this.identities,
    };
    await writeFile(join(this.directory, MANIFEST_NAME), `${canonicalJSON(manifest)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await Promise.all([this.index.close(), this.segments.close()]);
    this.sealed = true;
    return Object.freeze(manifest);
  }

  async appendBlock({
    kind,
    recordSeq,
    sourceTick,
    payload,
    correlationSeq,
    frameSeq,
    projectionId,
  }) {
    const bytes = readonlyBytes(payload, 'archive block');
    if (bytes.byteLength === 0 || bytes.byteLength > this.limits.maximumBlockBytes) {
      throw new PresentationArchiveError('archive block byte length is invalid');
    }
    if (this.entryCount >= BigInt(this.limits.maximumEntries)) {
      throw new PresentationArchiveError('archive exceeds maximumEntries');
    }
    const payloadSha256 = createHash('sha256').update(bytes).digest();
    const blockHeader = encodeBlockHeader({
      kind,
      segmentId: this.current.segmentId,
      recordSeq,
      payloadLength: bytes.byteLength,
      payloadSha256,
    });
    const block = Buffer.concat([blockHeader, bytes]);
    const offset = await this.segments.append(block);
    this.segmentsHash.update(block);
    const entry = encodeIndexEntry({
      kind,
      segmentId: this.current.segmentId,
      recordSeq,
      sceneEpoch: this.current.sceneEpoch,
      bootstrapId: this.current.bootstrapId,
      correlationSeq,
      frameSeq,
      sourceTick,
      projectionId,
      dataOffset: offset,
      dataLength: block.byteLength,
      uncompressedLength: bytes.byteLength,
      sha256: payloadSha256,
    });
    await this.index.append(entry);
    this.indexHash.update(entry);
    this.entryCount += 1n;
    return { sha256: payloadSha256.toString('hex'), offset };
  }

  requireSegment() {
    this.requireWritable();
    if (!this.current) throw new PresentationArchiveError('archive segment is not open');
  }

  requireWritable() {
    if (this.sealed) throw new PresentationArchiveError('archive writer is sealed');
  }
}

export class PresentationArchiveReader {
  static async openDirectory(directory, options = {}) {
    const [manifestRaw, index, segments] = await Promise.all([
      readFile(join(directory, MANIFEST_NAME), 'utf8'),
      FileByteRangeSource.open(join(directory, INDEX_NAME)),
      FileByteRangeSource.open(join(directory, SEGMENTS_NAME)),
    ]);
    let manifest;
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (error) {
      throw new PresentationArchiveError('archive manifest is invalid JSON', { cause: error });
    }
    if (`${canonicalJSON(manifest)}\n` !== manifestRaw) {
      throw new PresentationArchiveError('archive manifest is not canonical');
    }
    const reader = new PresentationArchiveReader({ manifest, index, segments, ...options });
    await reader.open();
    return reader;
  }

  constructor({ manifest, index, segments, limits = {} }) {
    this._manifest = validateManifest(manifest);
    this.index = index;
    this.segments = segments;
    this.limits = normalizeLimits(limits);
    this.indexHeader = null;
    this.segmentsSize = null;
    this.closed = false;
  }

  manifest() {
    return this._manifest;
  }

  async open() {
    const [indexSize, segmentsSize] = await Promise.all([
      this.index.size(),
      this.segments.size(),
    ]);
    if (indexSize < BigInt(INDEX_HEADER_BYTES)) {
      throw new PresentationArchiveError('archive index is truncated');
    }
    this.indexHeader = decodeIndexHeader(await this.index.read(0n, INDEX_HEADER_BYTES));
    if (this.indexHeader.entryCount !== BigInt(this._manifest.entry_count)) {
      throw new PresentationArchiveError('archive index entry count mismatch');
    }
    const expectedIndexSize = BigInt(INDEX_HEADER_BYTES)
      + this.indexHeader.entryCount * BigInt(INDEX_ENTRY_BYTES);
    if (indexSize !== expectedIndexSize) {
      throw new PresentationArchiveError('archive index is truncated or has trailing bytes');
    }
    if (segmentsSize === 0n) throw new PresentationArchiveError('archive segments are empty');
    if (this.indexHeader.entryCount > BigInt(this.limits.maximumEntries)) {
      throw new PresentationArchiveError('archive exceeds local maximumEntries');
    }
    this.segmentsSize = segmentsSize;
  }

  async checkpoints() {
    const checkpoints = [];
    for (let index = 0n; index < this.indexHeader.entryCount; index += 1n) {
      const entry = await this.readIndexEntry(index);
      if (entry.kind === BLOCK_KIND_CHECKPOINT) checkpoints.push(freezePublicEntry(entry));
    }
    return Object.freeze(checkpoints);
  }

  async openCheckpoint(checkpointId) {
    const target = decimalU64(checkpointId, 'checkpointId');
    for (let index = 0n; index < this.indexHeader.entryCount; index += 1n) {
      const entry = await this.readIndexEntry(index);
      if (entry.kind === BLOCK_KIND_CHECKPOINT && entry.recordSeq === target) {
        return Object.freeze({
          checkpoint: freezePublicEntry(entry),
          bootstrapPacket: await this.readBlock(entry),
          nextEntryIndex: index + 1n,
        });
      }
    }
    throw new PresentationArchiveError('archive checkpoint does not exist');
  }

  async readFrame(frameSeq, options = {}) {
    return this.readBySequence(
      BLOCK_KIND_FRAME,
      positiveBigInt(frameSeq, 'frameSeq'),
      options,
    );
  }

  async readCorrelation(correlationSeq, options = {}) {
    return this.readBySequence(
      BLOCK_KIND_CORRELATION,
      positiveBigInt(correlationSeq, 'correlationSeq'),
      options,
    );
  }

  async *iterateFrom(checkpointId) {
    const opened = await this.openCheckpoint(checkpointId);
    yield Object.freeze({
      kind: 'checkpoint',
      entry: opened.checkpoint,
      bytes: opened.bootstrapPacket,
    });
    const segmentId = opened.checkpoint.segmentId;
    for (let index = opened.nextEntryIndex; index < this.indexHeader.entryCount; index += 1n) {
      const entry = await this.readIndexEntry(index);
      if (entry.segmentId !== segmentId) break;
      yield Object.freeze({
        kind: entry.kind === BLOCK_KIND_FRAME ? 'frame' : 'correlation',
        entry: freezePublicEntry(entry),
        bytes: await this.readBlock(entry),
      });
    }
  }

  async verify() {
    const indexHash = createHash('sha256');
    const segmentsHash = createHash('sha256');
    let expectedOffset = 0n;
    let currentSegment = 0;
    let segmentSceneEpoch = 0n;
    let segmentBootstrapId = 0n;
    let lastFrameSeq = 0n;
    let lastCorrelationSeq = 0n;
    let lastSourceTick = null;
    let checkpoints = 0;
    let frames = 0n;
    let correlations = 0n;
    const checkpointIds = new Set();
    for (let index = 0n; index < this.indexHeader.entryCount; index += 1n) {
      const offset = BigInt(INDEX_HEADER_BYTES) + index * BigInt(INDEX_ENTRY_BYTES);
      const rawEntry = await this.index.read(offset, INDEX_ENTRY_BYTES);
      indexHash.update(rawEntry);
      const entry = decodeIndexEntry(rawEntry);
      validateEntryLimits(entry, this.limits);
      if (entry.dataOffset !== expectedOffset) {
        throw new PresentationArchiveError('archive block offsets are not contiguous');
      }
      expectedOffset += BigInt(entry.dataLength);
      if (entry.segmentId !== currentSegment) {
        if (entry.segmentId !== currentSegment + 1 || entry.kind !== BLOCK_KIND_CHECKPOINT) {
          throw new PresentationArchiveError('archive segment boundary is invalid');
        }
        currentSegment = entry.segmentId;
        segmentSceneEpoch = entry.sceneEpoch;
        segmentBootstrapId = entry.bootstrapId;
        lastFrameSeq = 0n;
        lastCorrelationSeq = 0n;
        lastSourceTick = entry.sourceTick;
        if (checkpointIds.has(entry.recordSeq.toString())) {
          throw new PresentationArchiveError('archive checkpoint ID is duplicated');
        }
        checkpointIds.add(entry.recordSeq.toString());
        if (
          entry.recordSeq === 0n || entry.correlationSeq !== 0n ||
          entry.frameSeq !== 0n || entry.projectionId !== 0n
        ) {
          throw new PresentationArchiveError('archive checkpoint index fields are invalid');
        }
        checkpoints += 1;
      } else if (entry.kind === BLOCK_KIND_CHECKPOINT) {
        throw new PresentationArchiveError('archive segment contains multiple checkpoints');
      }
      if (entry.sceneEpoch !== segmentSceneEpoch || entry.bootstrapId !== segmentBootstrapId) {
        throw new PresentationArchiveError('archive segment identity changes without checkpoint');
      }
      if (
        lastSourceTick !== null &&
        entry.sourceTick !== lastSourceTick &&
        entry.sourceTick !== lastSourceTick + 1n
      ) {
        throw new PresentationArchiveError('archive source tick has a gap or rollback');
      }
      lastSourceTick = entry.sourceTick;
      if (entry.kind === BLOCK_KIND_FRAME) {
        if (
          entry.recordSeq !== lastFrameSeq + 1n ||
          entry.frameSeq !== entry.recordSeq ||
          entry.correlationSeq !== 0n ||
          entry.projectionId === 0n
        ) {
          throw new PresentationArchiveError('archive frame sequence is invalid');
        }
        lastFrameSeq = entry.recordSeq;
        frames += 1n;
      } else if (entry.kind === BLOCK_KIND_CORRELATION) {
        if (
          entry.recordSeq !== lastCorrelationSeq + 1n ||
          entry.correlationSeq !== entry.recordSeq ||
          entry.projectionId === 0n
        ) {
          throw new PresentationArchiveError('archive correlation sequence is invalid');
        }
        lastCorrelationSeq = entry.recordSeq;
        correlations += 1n;
      }
      const rawBlock = await this.segments.read(entry.dataOffset, entry.dataLength);
      segmentsHash.update(rawBlock);
      await this.readBlock(entry, rawBlock);
    }
    if (expectedOffset !== this.segmentsSize) {
      throw new PresentationArchiveError('archive segments are truncated or have trailing bytes');
    }
    if (
      currentSegment !== this._manifest.segment_count ||
      checkpoints !== this._manifest.checkpoint_count ||
      frames !== BigInt(this._manifest.frame_count) ||
      correlations !== BigInt(this._manifest.correlation_count)
    ) {
      throw new PresentationArchiveError('archive manifest record counts mismatch');
    }
    const indexDigest = indexHash.digest();
    const segmentsDigest = segmentsHash.digest();
    if (!indexDigest.equals(this.indexHeader.payloadSha256)
        || indexDigest.toString('hex') !== this._manifest.index_payload_sha256) {
      throw new PresentationArchiveError('archive index payload hash mismatch');
    }
    if (segmentsDigest.toString('hex') !== this._manifest.segments_sha256) {
      throw new PresentationArchiveError('archive segments hash mismatch');
    }
    if (digestHex(Buffer.concat([indexDigest, segmentsDigest]))
        !== this._manifest.archive_root_sha256) {
      throw new PresentationArchiveError('archive root hash mismatch');
    }
    return Object.freeze({
      entryCount: this.indexHeader.entryCount,
      indexSha256: indexDigest.toString('hex'),
      segmentsSha256: segmentsDigest.toString('hex'),
    });
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      await Promise.all([this.index.close(), this.segments.close()]);
    }
  }

  async readBySequence(kind, sequence, { segmentId = null } = {}) {
    const segment = segmentId == null
      ? null
      : positiveSafeInteger(segmentId, 'segmentId');
    let match = null;
    for (let index = 0n; index < this.indexHeader.entryCount; index += 1n) {
      const entry = await this.readIndexEntry(index);
      if (
        entry.kind !== kind || entry.recordSeq !== sequence ||
        (segment !== null && entry.segmentId !== segment)
      ) continue;
      if (match) {
        throw new PresentationArchiveError(
          'archive sequence is ambiguous across segments; segmentId is required',
        );
      }
      match = entry;
    }
    if (match) {
      return Object.freeze({
        entry: freezePublicEntry(match),
        bytes: await this.readBlock(match),
      });
    }
    throw new PresentationArchiveError('archive record does not exist');
  }

  async readIndexEntry(index) {
    if (index < 0n || index >= this.indexHeader.entryCount) {
      throw new PresentationArchiveError('archive index entry is out of range');
    }
    const offset = BigInt(INDEX_HEADER_BYTES) + index * BigInt(INDEX_ENTRY_BYTES);
    const entry = decodeIndexEntry(await this.index.read(offset, INDEX_ENTRY_BYTES));
    validateEntryLimits(entry, this.limits);
    return entry;
  }

  async readBlock(entry, existing = null) {
    const raw = existing ?? await this.segments.read(entry.dataOffset, entry.dataLength);
    if (raw.byteLength !== entry.dataLength || raw.byteLength < BLOCK_HEADER_BYTES) {
      throw new PresentationArchiveError('archive block is truncated');
    }
    const header = decodeBlockHeader(raw.subarray(0, BLOCK_HEADER_BYTES));
    if (header.kind !== entry.kind || header.segmentId !== entry.segmentId
        || header.recordSeq !== entry.recordSeq
        || header.payloadLength !== entry.uncompressedLength
        || BLOCK_HEADER_BYTES + header.payloadLength !== entry.dataLength) {
      throw new PresentationArchiveError('archive block header/index mismatch');
    }
    const payload = raw.subarray(BLOCK_HEADER_BYTES);
    const digest = createHash('sha256').update(payload).digest();
    if (!digest.equals(header.payloadSha256) || !digest.equals(entry.sha256)) {
      throw new PresentationArchiveError('archive block hash mismatch');
    }
    return new Uint8Array(payload);
  }
}

function encodeIndexHeader({ entryCount, payloadSha256 }) {
  const buffer = Buffer.alloc(INDEX_HEADER_BYTES);
  buffer.write(INDEX_MAGIC, 0, 4, 'ascii');
  buffer.writeUInt16LE(INDEX_VERSION, 4);
  buffer.writeUInt16LE(INDEX_HEADER_BYTES, 6);
  buffer.writeUInt16LE(INDEX_ENTRY_BYTES, 8);
  buffer.writeUInt16LE(0, 10);
  buffer.writeBigUInt64LE(entryCount, 12);
  payloadSha256.copy(buffer, 20);
  return buffer;
}

function decodeIndexHeader(value) {
  const buffer = Buffer.from(value);
  if (buffer.toString('ascii', 0, 4) !== INDEX_MAGIC
      || buffer.readUInt16LE(4) !== INDEX_VERSION
      || buffer.readUInt16LE(6) !== INDEX_HEADER_BYTES
      || buffer.readUInt16LE(8) !== INDEX_ENTRY_BYTES
      || buffer.readUInt16LE(10) !== 0
      || !buffer.subarray(52).equals(Buffer.alloc(12))) {
    throw new PresentationArchiveError('archive index header is invalid');
  }
  return Object.freeze({
    entryCount: buffer.readBigUInt64LE(12),
    payloadSha256: buffer.subarray(20, 52),
  });
}

function encodeIndexEntry(value) {
  const buffer = Buffer.alloc(INDEX_ENTRY_BYTES);
  buffer.writeUInt16LE(value.kind, 0);
  buffer.writeUInt16LE(0, 2);
  buffer.writeUInt32LE(value.segmentId, 4);
  buffer.writeBigUInt64LE(value.recordSeq, 8);
  buffer.writeBigUInt64LE(value.sceneEpoch, 16);
  buffer.writeBigUInt64LE(value.bootstrapId, 24);
  buffer.writeBigUInt64LE(value.correlationSeq, 32);
  buffer.writeBigUInt64LE(value.frameSeq, 40);
  buffer.writeBigUInt64LE(value.sourceTick, 48);
  buffer.writeBigUInt64LE(value.projectionId, 56);
  buffer.writeBigUInt64LE(value.dataOffset, 64);
  buffer.writeUInt32LE(value.dataLength, 72);
  buffer.writeUInt32LE(value.uncompressedLength, 76);
  value.sha256.copy(buffer, 80);
  return buffer;
}

function decodeIndexEntry(value) {
  const buffer = Buffer.from(value);
  const kind = buffer.readUInt16LE(0);
  if (![BLOCK_KIND_CHECKPOINT, BLOCK_KIND_FRAME, BLOCK_KIND_CORRELATION].includes(kind)
      || buffer.readUInt16LE(2) !== 0) {
    throw new PresentationArchiveError('archive index entry kind/flags are invalid');
  }
  return Object.freeze({
    kind,
    segmentId: buffer.readUInt32LE(4),
    recordSeq: buffer.readBigUInt64LE(8),
    sceneEpoch: buffer.readBigUInt64LE(16),
    bootstrapId: buffer.readBigUInt64LE(24),
    correlationSeq: buffer.readBigUInt64LE(32),
    frameSeq: buffer.readBigUInt64LE(40),
    sourceTick: buffer.readBigUInt64LE(48),
    projectionId: buffer.readBigUInt64LE(56),
    dataOffset: buffer.readBigUInt64LE(64),
    dataLength: buffer.readUInt32LE(72),
    uncompressedLength: buffer.readUInt32LE(76),
    sha256: buffer.subarray(80, 112),
  });
}

function encodeBlockHeader({ kind, segmentId, recordSeq, payloadLength, payloadSha256 }) {
  const buffer = Buffer.alloc(BLOCK_HEADER_BYTES);
  buffer.write(BLOCK_MAGIC, 0, 4, 'ascii');
  buffer.writeUInt16LE(BLOCK_VERSION, 4);
  buffer.writeUInt16LE(kind, 6);
  buffer.writeUInt32LE(COMPRESSION_NONE, 8);
  buffer.writeUInt32LE(segmentId, 12);
  buffer.writeBigUInt64LE(recordSeq, 16);
  buffer.writeUInt32LE(payloadLength, 24);
  buffer.writeUInt32LE(payloadLength, 28);
  payloadSha256.copy(buffer, 32);
  return buffer;
}

function decodeBlockHeader(value) {
  const buffer = Buffer.from(value);
  const kind = buffer.readUInt16LE(6);
  if (buffer.toString('ascii', 0, 4) !== BLOCK_MAGIC
      || buffer.readUInt16LE(4) !== BLOCK_VERSION
      || ![BLOCK_KIND_CHECKPOINT, BLOCK_KIND_FRAME, BLOCK_KIND_CORRELATION].includes(kind)
      || buffer.readUInt32LE(8) !== COMPRESSION_NONE) {
    throw new PresentationArchiveError('archive block header is invalid');
  }
  const payloadLength = buffer.readUInt32LE(24);
  if (payloadLength !== buffer.readUInt32LE(28)) {
    throw new PresentationArchiveError('codec none block length mismatch');
  }
  return Object.freeze({
    kind,
    segmentId: buffer.readUInt32LE(12),
    recordSeq: buffer.readBigUInt64LE(16),
    payloadLength,
    payloadSha256: buffer.subarray(32, 64),
  });
}

function validateManifest(value) {
  const fields = [
    'archive_root_sha256',
    'authority_cursor_codec_identity',
    'checkpoint_count',
    'compression_codecs',
    'correlation_count',
    'end_tick',
    'entry_count',
    'exporter_identity',
    'frame_count',
    'hard_limits',
    'index_payload_sha256',
    'profile_identity',
    'resource_manifest_identity',
    'scene_engine_identity',
    'schema_identity',
    'segment_count',
    'segments_sha256',
    'source_authority_artifact_identity',
    'source_authority_sha256',
    'start_tick',
    'visual_manifest_identity',
  ];
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields.sort()) ||
    value.schema_identity !== MANIFEST_SCHEMA
  ) {
    throw new PresentationArchiveError('archive manifest schema is invalid');
  }
  for (const field of [
    'archive_root_sha256',
    'index_payload_sha256',
    'segments_sha256',
    'source_authority_sha256',
  ]) sha256Identity(value[field], field);
  for (const field of [
    'authority_cursor_codec_identity',
    'exporter_identity',
    'profile_identity',
    'resource_manifest_identity',
    'scene_engine_identity',
    'source_authority_artifact_identity',
    'visual_manifest_identity',
  ]) identity(value[field], field);
  positiveSafeInteger(value.segment_count, 'segment_count');
  positiveSafeInteger(value.checkpoint_count, 'checkpoint_count');
  positiveBigInt(value.entry_count, 'entry_count');
  positiveBigInt(value.frame_count, 'frame_count');
  positiveBigInt(value.correlation_count, 'correlation_count');
  nonnegativeBigInt(value.start_tick, 'start_tick');
  nonnegativeBigInt(value.end_tick, 'end_tick');
  if (BigInt(value.end_tick) < BigInt(value.start_tick)) {
    throw new PresentationArchiveError('archive tick range is invalid');
  }
  if (value.checkpoint_count !== value.segment_count) {
    throw new PresentationArchiveError('each archive segment requires one checkpoint');
  }
  if (
    !Array.isArray(value.compression_codecs) ||
    value.compression_codecs.length !== 1 ||
    value.compression_codecs[0] !== 'none'
  ) {
    throw new PresentationArchiveError('archive compression codecs are unsupported');
  }
  const hardLimitFields = [
    'maximum_block_bytes',
    'maximum_cursor_bytes',
    'maximum_entries',
    'maximum_segments',
  ];
  if (
    !value.hard_limits || typeof value.hard_limits !== 'object' ||
    Array.isArray(value.hard_limits) ||
    JSON.stringify(Object.keys(value.hard_limits).sort()) !==
      JSON.stringify(hardLimitFields.sort())
  ) {
    throw new PresentationArchiveError('archive hard limits are invalid');
  }
  for (const [field, item] of Object.entries(value.hard_limits)) {
    positiveSafeInteger(item, `hard_limits.${field}`);
  }
  return Object.freeze(value);
}

function validateEntryLimits(entry, limits) {
  if (
    entry.segmentId <= 0 || entry.segmentId > limits.maximumSegments ||
    entry.dataLength <= BLOCK_HEADER_BYTES ||
    entry.dataLength > limits.maximumBlockBytes + BLOCK_HEADER_BYTES ||
    entry.uncompressedLength <= 0 ||
    entry.uncompressedLength > limits.maximumBlockBytes ||
    entry.dataLength !== entry.uncompressedLength + BLOCK_HEADER_BYTES
  ) {
    throw new PresentationArchiveError('archive index entry exceeds local limits');
  }
}

function freezePublicEntry(entry) {
  return Object.freeze({
    kind: entry.kind,
    segmentId: entry.segmentId,
    recordSeq: entry.recordSeq,
    sceneEpoch: entry.sceneEpoch,
    bootstrapId: entry.bootstrapId,
    correlationSeq: entry.correlationSeq,
    frameSeq: entry.frameSeq,
    sourceTick: entry.sourceTick,
    projectionId: entry.projectionId,
    sha256: Buffer.from(entry.sha256).toString('hex'),
  });
}

function normalizeLimits(changes) {
  const result = { ...DEFAULT_ARCHIVE_LIMITS, ...changes };
  for (const [name, value] of Object.entries(result)) positiveSafeInteger(value, name);
  return Object.freeze(result);
}

function identity(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
      || value.length > 240 || value.normalize('NFC') !== value) {
    throw new PresentationArchiveError(`${field} is invalid`);
  }
  return value;
}

function sha256Identity(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new PresentationArchiveError(`${field} must be lowercase SHA-256`);
  }
  return value;
}

function readonlyBytes(value, label) {
  let view;
  if (value instanceof Uint8Array) view = value;
  else if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new PresentationArchiveError(`${label} must be bytes`);
  return new Uint8Array(view);
}

function digestHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function decimalU64(value, field) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new PresentationArchiveError(`${field} must be canonical decimal u64`);
  }
  return positiveBigInt(value, field);
}

function positiveBigInt(value, field) {
  const result = nonnegativeBigInt(value, field);
  if (result === 0n) throw new PresentationArchiveError(`${field} must be positive`);
  return result;
}

function nonnegativeBigInt(value, field) {
  let result;
  try {
    result = BigInt(value);
  } catch (error) {
    throw new PresentationArchiveError(`${field} must be uint64`, { cause: error });
  }
  if (result < 0n || result > ((1n << 64n) - 1n)) {
    throw new PresentationArchiveError(`${field} must be uint64`);
  }
  return result;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PresentationArchiveError(`${field} must be a positive safe integer`);
  }
  return value;
}

function bigintToSafeNumber(value, field) {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new PresentationArchiveError(`${field} exceeds local file range`);
  }
  return Number(value);
}

export const PRESENTATION_ARCHIVE_SCHEMA_IDENTITY = MANIFEST_SCHEMA;
