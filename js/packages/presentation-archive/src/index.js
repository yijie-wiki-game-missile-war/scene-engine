import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJSON } from '@scene-engine/presentation-codec';

const MANIFEST_NAME = 'presentation-manifest.json';
const INDEX_NAME = 'presentation-index.bin';
const SEGMENTS_NAME = 'presentation-segments.bin';
const MANIFEST_SCHEMA = 'scene-presentation-archive-v3@1';
const INDEX_MAGIC = 'SEIX';
const INDEX_VERSION = 3;
const INDEX_HEADER_BYTES = 112;
const INDEX_ENTRY_BYTES = 112;
const CHECKPOINT_DIRECTORY_ENTRY_BYTES = 48;
const BLOCK_MAGIC = 'SEAB';
const BLOCK_VERSION = 3;
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
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await this.handle.read(
        buffer,
        bytesRead,
        length - bytesRead,
        position + bytesRead,
      );
      if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead <= 0
          || result.bytesRead > length - bytesRead) {
        throw new PresentationArchiveError('byte range is truncated');
      }
      bytesRead += result.bytesRead;
    }
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

export class PresentationArchiveReader {
  static async openDirectory(directory, options = {}) {
    let index = null;
    let segments = null;
    try {
      const manifestRaw = await readFile(join(directory, MANIFEST_NAME), 'utf8');
      let manifest;
      try {
        manifest = JSON.parse(manifestRaw);
      } catch (error) {
        throw new PresentationArchiveError('archive manifest is invalid JSON', { cause: error });
      }
      if (`${canonicalJSON(manifest)}\n` !== manifestRaw) {
        throw new PresentationArchiveError('archive manifest is not canonical');
      }
      index = await FileByteRangeSource.open(join(directory, INDEX_NAME));
      segments = await FileByteRangeSource.open(join(directory, SEGMENTS_NAME));
      const reader = new PresentationArchiveReader({ manifest, index, segments, ...options });
      await reader.open();
      return reader;
    } catch (error) {
      await Promise.allSettled([index?.close(), segments?.close()]);
      throw error;
    }
  }

  constructor({ manifest, index, segments, limits = {} }) {
    this._manifest = validateManifest(manifest);
    this.index = index;
    this.segments = segments;
    this.limits = normalizeLimits(limits);
    this.indexHeader = null;
    this.checkpointDirectory = null;
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
    if (this.indexHeader.checkpointCount !== BigInt(this._manifest.checkpoint_count)) {
      throw new PresentationArchiveError('archive checkpoint directory count mismatch');
    }
    const expectedDirectoryOffset = BigInt(INDEX_HEADER_BYTES)
      + this.indexHeader.entryCount * BigInt(INDEX_ENTRY_BYTES);
    if (this.indexHeader.checkpointDirectoryOffset !== expectedDirectoryOffset) {
      throw new PresentationArchiveError('archive checkpoint directory offset is invalid');
    }
    const expectedIndexSize = expectedDirectoryOffset
      + this.indexHeader.checkpointCount * BigInt(CHECKPOINT_DIRECTORY_ENTRY_BYTES);
    if (indexSize !== expectedIndexSize) {
      throw new PresentationArchiveError('archive index is truncated or has trailing bytes');
    }
    if (segmentsSize === 0n) throw new PresentationArchiveError('archive segments are empty');
    if (this.indexHeader.entryCount > BigInt(this.limits.maximumEntries)) {
      throw new PresentationArchiveError('archive exceeds local maximumEntries');
    }
    if (this.indexHeader.checkpointCount > BigInt(this.limits.maximumSegments)) {
      throw new PresentationArchiveError('archive exceeds local maximumSegments');
    }
    const directoryLength = bigintToSafeNumber(
      this.indexHeader.checkpointCount * BigInt(CHECKPOINT_DIRECTORY_ENTRY_BYTES),
      'checkpoint directory length',
    );
    const directoryBytes = await this.index.read(
      this.indexHeader.checkpointDirectoryOffset,
      directoryLength,
    );
    const directoryDigest = createHash('sha256').update(directoryBytes).digest('hex');
    if (directoryDigest !== this._manifest.checkpoint_directory_sha256
        || directoryDigest !== this.indexHeader.checkpointDirectorySha256.toString('hex')) {
      throw new PresentationArchiveError('archive checkpoint directory hash mismatch');
    }
    const checkpoints = [];
    let previousCheckpointId = 0n;
    for (let offset = 0; offset < directoryBytes.byteLength;
      offset += CHECKPOINT_DIRECTORY_ENTRY_BYTES) {
      const checkpoint = decodeCheckpointDirectoryEntry(
        directoryBytes.subarray(offset, offset + CHECKPOINT_DIRECTORY_ENTRY_BYTES),
      );
      if (checkpoint.checkpointId <= previousCheckpointId
          || checkpoint.segmentId > this._manifest.segment_count
          || checkpoint.indexEntryNumber >= this.indexHeader.entryCount) {
        throw new PresentationArchiveError('archive checkpoint directory is not canonical');
      }
      checkpoints.push(checkpoint);
      previousCheckpointId = checkpoint.checkpointId;
    }
    this.checkpointDirectory = Object.freeze(checkpoints);
    this.segmentsSize = segmentsSize;
  }

  async checkpoints() {
    return Object.freeze(this.checkpointDirectory.map(freezePublicCheckpoint));
  }

  async openCheckpoint(checkpointId) {
    const target = decimalU64(checkpointId, 'checkpointId');
    const checkpoint = binarySearchCheckpoint(this.checkpointDirectory, target);
    if (checkpoint == null) {
      throw new PresentationArchiveError('archive checkpoint does not exist');
    }
    const entry = await this.readIndexEntry(checkpoint.indexEntryNumber);
    assertCheckpointDirectoryMatch(checkpoint, entry);
    return Object.freeze({
      checkpoint: freezePublicEntry(entry),
      bootstrapPacket: await this.readBlock(entry),
      nextEntryIndex: checkpoint.indexEntryNumber + 1n,
    });
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
    const indexEntriesHash = createHash('sha256');
    const indexPayloadHash = createHash('sha256');
    const segmentsHash = createHash('sha256');
    let expectedOffset = 0n;
    let currentSegment = 0;
    let segmentSceneEpoch = 0n;
    let segmentBootstrapId = 0n;
    let lastFrameSeq = 0n;
    let lastCorrelationSeq = 0n;
    let lastSourceTick = null;
    let segmentFrames = 0;
    let segmentCorrelations = 0;
    let checkpoints = 0;
    let frames = 0n;
    let correlations = 0n;
    const checkpointIds = new Set();
    const checkpointIndexEntries = new Map();
    for (let index = 0n; index < this.indexHeader.entryCount; index += 1n) {
      const offset = BigInt(INDEX_HEADER_BYTES) + index * BigInt(INDEX_ENTRY_BYTES);
      const rawEntry = await this.index.read(offset, INDEX_ENTRY_BYTES);
      indexEntriesHash.update(rawEntry);
      indexPayloadHash.update(rawEntry);
      const entry = decodeIndexEntry(rawEntry);
      validateEntryLimits(entry, this.limits);
      if (entry.dataOffset !== expectedOffset) {
        throw new PresentationArchiveError('archive block offsets are not contiguous');
      }
      expectedOffset += BigInt(entry.dataLength);
      if (entry.segmentId !== currentSegment) {
        if (currentSegment !== 0 && (segmentFrames === 0 || segmentCorrelations === 0)) {
          throw new PresentationArchiveError(
            'archive segment requires a complete frame and correlation',
          );
        }
        if (entry.segmentId !== currentSegment + 1 || entry.kind !== BLOCK_KIND_CHECKPOINT) {
          throw new PresentationArchiveError('archive segment boundary is invalid');
        }
        currentSegment = entry.segmentId;
        segmentSceneEpoch = entry.sceneEpoch;
        segmentBootstrapId = entry.bootstrapId;
        lastFrameSeq = 0n;
        lastCorrelationSeq = 0n;
        lastSourceTick = entry.sourceTick;
        segmentFrames = 0;
        segmentCorrelations = 0;
        if (checkpointIds.has(entry.recordSeq.toString())) {
          throw new PresentationArchiveError('archive checkpoint ID is duplicated');
        }
        checkpointIds.add(entry.recordSeq.toString());
        checkpointIndexEntries.set(entry.recordSeq.toString(), Object.freeze({
          checkpointId: entry.recordSeq,
          segmentId: entry.segmentId,
          indexEntryNumber: index,
          sceneEpoch: entry.sceneEpoch,
          bootstrapId: entry.bootstrapId,
          sourceTick: entry.sourceTick,
        }));
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
        segmentFrames += 1;
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
        segmentCorrelations += 1;
      }
      const rawBlock = await this.segments.read(entry.dataOffset, entry.dataLength);
      segmentsHash.update(rawBlock);
      await this.readBlock(entry, rawBlock);
    }
    if (expectedOffset !== this.segmentsSize) {
      throw new PresentationArchiveError('archive segments are truncated or have trailing bytes');
    }
    if (currentSegment !== 0 && (segmentFrames === 0 || segmentCorrelations === 0)) {
      throw new PresentationArchiveError(
        'archive segment requires a complete frame and correlation',
      );
    }
    const checkpointDirectoryHash = createHash('sha256');
    let previousCheckpointId = 0n;
    for (let index = 0n; index < this.indexHeader.checkpointCount; index += 1n) {
      const offset = this.indexHeader.checkpointDirectoryOffset
        + index * BigInt(CHECKPOINT_DIRECTORY_ENTRY_BYTES);
      const rawCheckpoint = await this.index.read(offset, CHECKPOINT_DIRECTORY_ENTRY_BYTES);
      checkpointDirectoryHash.update(rawCheckpoint);
      indexPayloadHash.update(rawCheckpoint);
      const checkpoint = decodeCheckpointDirectoryEntry(rawCheckpoint);
      if (checkpoint.checkpointId <= previousCheckpointId) {
        throw new PresentationArchiveError('archive checkpoint directory is not sorted');
      }
      const expected = checkpointIndexEntries.get(checkpoint.checkpointId.toString());
      if (expected == null || !checkpointDirectoryEquals(checkpoint, expected)) {
        throw new PresentationArchiveError('archive checkpoint directory/index mismatch');
      }
      previousCheckpointId = checkpoint.checkpointId;
    }
    if (
      currentSegment !== this._manifest.segment_count ||
      checkpoints !== this._manifest.checkpoint_count ||
      frames !== BigInt(this._manifest.frame_count) ||
      correlations !== BigInt(this._manifest.correlation_count)
    ) {
      throw new PresentationArchiveError('archive manifest record counts mismatch');
    }
    const indexEntriesDigest = indexEntriesHash.digest();
    const checkpointDirectoryDigest = checkpointDirectoryHash.digest();
    const indexDigest = indexPayloadHash.digest();
    const segmentsDigest = segmentsHash.digest();
    if (!indexEntriesDigest.equals(this.indexHeader.indexEntriesSha256)
        || indexEntriesDigest.toString('hex') !== this._manifest.index_entries_sha256) {
      throw new PresentationArchiveError('archive index entries hash mismatch');
    }
    if (!checkpointDirectoryDigest.equals(this.indexHeader.checkpointDirectorySha256)
        || checkpointDirectoryDigest.toString('hex')
          !== this._manifest.checkpoint_directory_sha256) {
      throw new PresentationArchiveError('archive checkpoint directory hash mismatch');
    }
    if (indexDigest.toString('hex') !== this._manifest.index_payload_sha256) {
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

function decodeIndexHeader(value) {
  const buffer = Buffer.from(value);
  if (buffer.toString('ascii', 0, 4) !== INDEX_MAGIC
      || buffer.readUInt16LE(4) !== INDEX_VERSION
      || buffer.readUInt16LE(6) !== INDEX_HEADER_BYTES
      || buffer.readUInt16LE(8) !== INDEX_ENTRY_BYTES
      || buffer.readUInt16LE(10) !== CHECKPOINT_DIRECTORY_ENTRY_BYTES
      || !buffer.subarray(100).equals(Buffer.alloc(12))) {
    throw new PresentationArchiveError('archive index header is invalid');
  }
  return Object.freeze({
    entryCount: buffer.readBigUInt64LE(12),
    checkpointCount: buffer.readBigUInt64LE(20),
    checkpointDirectoryOffset: buffer.readBigUInt64LE(28),
    indexEntriesSha256: buffer.subarray(36, 68),
    checkpointDirectorySha256: buffer.subarray(68, 100),
  });
}

function decodeCheckpointDirectoryEntry(value) {
  const buffer = Buffer.from(value);
  if (buffer.byteLength !== CHECKPOINT_DIRECTORY_ENTRY_BYTES
      || buffer.readUInt32LE(12) !== 0) {
    throw new PresentationArchiveError('archive checkpoint directory entry is invalid');
  }
  const checkpoint = Object.freeze({
    checkpointId: buffer.readBigUInt64LE(0),
    segmentId: buffer.readUInt32LE(8),
    indexEntryNumber: buffer.readBigUInt64LE(16),
    sceneEpoch: buffer.readBigUInt64LE(24),
    bootstrapId: buffer.readBigUInt64LE(32),
    sourceTick: buffer.readBigUInt64LE(40),
  });
  if (checkpoint.checkpointId === 0n || checkpoint.segmentId === 0
      || checkpoint.sceneEpoch === 0n || checkpoint.bootstrapId === 0n) {
    throw new PresentationArchiveError('archive checkpoint directory entry is invalid');
  }
  return checkpoint;
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
    'checkpoint_directory_sha256',
    'compression_codecs',
    'correlation_count',
    'end_tick',
    'entry_count',
    'exporter_identity',
    'frame_count',
    'hard_limits',
    'index_payload_sha256',
    'index_entries_sha256',
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
    'checkpoint_directory_sha256',
    'index_entries_sha256',
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

function freezePublicCheckpoint(checkpoint) {
  return Object.freeze({
    checkpointId: checkpoint.checkpointId,
    segmentId: checkpoint.segmentId,
    indexEntryNumber: checkpoint.indexEntryNumber,
    sceneEpoch: checkpoint.sceneEpoch,
    bootstrapId: checkpoint.bootstrapId,
    sourceTick: checkpoint.sourceTick,
  });
}

function binarySearchCheckpoint(checkpoints, checkpointId) {
  let lower = 0;
  let upper = checkpoints.length - 1;
  while (lower <= upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const candidate = checkpoints[middle];
    if (candidate.checkpointId === checkpointId) return candidate;
    if (candidate.checkpointId < checkpointId) lower = middle + 1;
    else upper = middle - 1;
  }
  return null;
}

function assertCheckpointDirectoryMatch(checkpoint, entry) {
  if (entry.kind !== BLOCK_KIND_CHECKPOINT
      || entry.recordSeq !== checkpoint.checkpointId
      || entry.segmentId !== checkpoint.segmentId
      || entry.sceneEpoch !== checkpoint.sceneEpoch
      || entry.bootstrapId !== checkpoint.bootstrapId
      || entry.sourceTick !== checkpoint.sourceTick) {
    throw new PresentationArchiveError('archive checkpoint directory/index mismatch');
  }
}

function checkpointDirectoryEquals(left, right) {
  return left.checkpointId === right.checkpointId
    && left.segmentId === right.segmentId
    && left.indexEntryNumber === right.indexEntryNumber
    && left.sceneEpoch === right.sceneEpoch
    && left.bootstrapId === right.bootstrapId
    && left.sourceTick === right.sourceTick;
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

function byteView(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new PresentationArchiveError(`${label} must be bytes`);
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
