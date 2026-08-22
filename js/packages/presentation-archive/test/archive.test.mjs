import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  cursorEnvelopeToJSON,
  encodePresentationControl,
  envelopeCursor,
} from '@scene-engine/presentation-codec';
import {
  FileByteRangeSource,
  PresentationArchiveError,
  PresentationArchiveReader,
  PresentationArchiveWriter,
} from '../src/index.js';

const codec = {
  codecIdentity: 'test-authority-cursor@1',
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
  key: (value) => value.seq,
  tick: (value) => value.tick,
};

function correlation({ sceneEpoch, bootstrapId, sequence, tick, framePacket }) {
  const cursor = envelopeCursor({ seq: sequence, tick }, codec);
  return encodePresentationControl({
    bootstrap_id: String(bootstrapId),
    message_id: `correlation:${sequence}`,
    payload: {
      authority_cursor: cursorEnvelopeToJSON(cursor),
      correlation_seq: String(sequence),
      frame_refs: [{
        frame_seq: String(sequence),
        sha256: createHash('sha256').update(framePacket).digest('hex'),
      }],
      presentation_required: true,
      projection_id: String(sequence),
      source_tick: String(tick),
    },
    protocol: 'scene-presentation-control-v2',
    scene_epoch: String(sceneEpoch),
    schema_version: 1,
    session_seq: sequence,
    type: 'presentation.correlation',
    viewer_scope: 'viewer:test',
  }, { direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT });
}

async function writeArchive(directory, checkpointIds = [1, 2]) {
  const writer = await PresentationArchiveWriter.createDirectory(directory, {
    profileIdentity: 'test-presentation@1',
    sourceAuthorityArtifactIdentity: 'test-tape@1',
    sourceAuthoritySha256: '1'.repeat(64),
    authorityCursorCodecIdentity: codec.codecIdentity,
    exporterIdentity: 'test-exporter@1',
    sceneEngineIdentity: 'scene-engine@0.3.0',
    visualManifestIdentity: 'visual@test',
    resourceManifestIdentity: 'resource@test',
  });
  for (let segment = 1; segment <= 2; segment += 1) {
    await writer.startSegment({
      checkpointId: String(checkpointIds[segment - 1]),
      sceneEpoch: segment,
      bootstrapId: segment,
      sourceTick: segment - 1,
      bootstrapPacket: new TextEncoder().encode(`bootstrap:${segment}`),
    });
    const frame = new TextEncoder().encode(`frame:${segment}`);
    await writer.appendFrame({
      frameSeq: 1,
      sourceTick: segment,
      projectionId: 1,
      packet: frame,
    });
    await writer.appendCorrelation({
      correlation: correlation({
        sceneEpoch: segment,
        bootstrapId: segment,
        sequence: 1,
        tick: segment,
        framePacket: frame,
      }),
    });
  }
  return writer.seal();
}

function writerOptions() {
  return {
    profileIdentity: 'test-presentation@1',
    sourceAuthorityArtifactIdentity: 'test-tape@1',
    sourceAuthoritySha256: '1'.repeat(64),
    authorityCursorCodecIdentity: codec.codecIdentity,
    exporterIdentity: 'test-exporter@1',
    sceneEngineIdentity: 'scene-engine@0.3.0',
    visualManifestIdentity: 'visual@test',
    resourceManifestIdentity: 'resource@test',
  };
}

test('Archive V3 canonicalizes non-monotonic checkpoint IDs for binary search', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-checkpoint-order-'));
  await writeArchive(directory, [20, 10]);
  const reader = await PresentationArchiveReader.openDirectory(directory);
  assert.deepEqual(
    (await reader.checkpoints()).map(({ checkpointId }) => checkpointId),
    [10n, 20n],
  );
  assert.equal(
    new TextDecoder().decode((await reader.openCheckpoint('10')).bootstrapPacket),
    'bootstrap:2',
  );
  await reader.verify();
  await reader.close();
});

test('Archive V3 streams multi-epoch checkpoints and uses its checkpoint directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-'));
  const manifest = await writeArchive(directory);
  assert.equal(manifest.schema_identity, 'scene-presentation-archive-v3@1');
  assert.equal(manifest.segment_count, 2);
  assert.equal(manifest.checkpoint_count, 2);
  const reader = await PresentationArchiveReader.openDirectory(directory);
  assert.deepEqual(await reader.checkpoints(), [
    {
      checkpointId: 1n,
      segmentId: 1,
      indexEntryNumber: 0n,
      sceneEpoch: 1n,
      bootstrapId: 1n,
      sourceTick: 0n,
    },
    {
      checkpointId: 2n,
      segmentId: 2,
      indexEntryNumber: 3n,
      sceneEpoch: 2n,
      bootstrapId: 2n,
      sourceTick: 1n,
    },
  ]);
  let indexEntryReads = 0;
  const readIndexEntry = reader.readIndexEntry.bind(reader);
  reader.readIndexEntry = async (index) => {
    indexEntryReads += 1;
    return readIndexEntry(index);
  };
  const checkpoint = await reader.openCheckpoint('2');
  assert.equal(new TextDecoder().decode(checkpoint.bootstrapPacket), 'bootstrap:2');
  assert.equal(indexEntryReads, 1);
  const records = [];
  for await (const record of reader.iterateFrom('2')) records.push(record.kind);
  assert.deepEqual(records, ['checkpoint', 'frame', 'correlation']);
  assert.equal(typeof reader.readFrame, 'undefined');
  assert.equal(typeof reader.readCorrelation, 'undefined');
  const verified = await reader.verify();
  assert.equal(verified.entryCount, 6n);
  await reader.close();
});

test('Archive V3 fails closed on block corruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-corrupt-'));
  await writeArchive(directory);
  const path = join(directory, 'presentation-segments.bin');
  const bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 0xff;
  const handle = await open(path, 'w');
  await handle.write(bytes);
  await handle.close();
  const reader = await PresentationArchiveReader.openDirectory(directory);
  await assert.rejects(() => reader.verify(), PresentationArchiveError);
  await reader.close();
});

test('Archive V3 validates the checkpoint directory before seek', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-directory-corrupt-'));
  await writeArchive(directory);
  const path = join(directory, 'presentation-index.bin');
  const bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 0xff;
  const handle = await open(path, 'w');
  await handle.write(bytes);
  await handle.close();
  const originalClose = FileByteRangeSource.prototype.close;
  let closeCount = 0;
  FileByteRangeSource.prototype.close = async function closeAfterOpenFailure() {
    closeCount += 1;
    return originalClose.call(this);
  };
  try {
    await assert.rejects(
      () => PresentationArchiveReader.openDirectory(directory),
      /checkpoint directory hash mismatch/u,
    );
  } finally {
    FileByteRangeSource.prototype.close = originalClose;
  }
  assert.equal(closeCount, 2);
});

test('Archive V3 caps the uncorrelated frame window at eight before writing a ninth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-frame-window-'));
  const writer = await PresentationArchiveWriter.createDirectory(directory, writerOptions());
  await writer.startSegment({
    checkpointId: '1',
    sceneEpoch: 1,
    bootstrapId: 1,
    sourceTick: 0,
    bootstrapPacket: new TextEncoder().encode('bootstrap'),
  });
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    await writer.appendFrame({
      frameSeq: sequence,
      sourceTick: 1,
      projectionId: 1,
      packet: new TextEncoder().encode(`frame:${sequence}`),
    });
  }
  await assert.rejects(
    () => writer.appendFrame({
      frameSeq: 9,
      sourceTick: 1,
      projectionId: 1,
      packet: new TextEncoder().encode('frame:9'),
    }),
    /uncorrelated frame window exceeds 8/u,
  );
  await writer.closeIncomplete();
});

test('Archive V3 writer loops until short file writes are complete', { concurrency: false }, async () => {
  const probePath = join(await mkdtemp(join(tmpdir(), 'scene-engine-archive-write-probe-')), 'probe');
  const probe = await open(probePath, 'w+');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = prototype.write;
  prototype.write = function shortWrite(buffer, offset, length, position) {
    return originalWrite.call(this, buffer, offset, Math.min(length, 7), position);
  };
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-short-write-'));
  try {
    await writeArchive(directory);
  } finally {
    prototype.write = originalWrite;
  }
  const reader = await PresentationArchiveReader.openDirectory(directory);
  await reader.verify();
  await reader.close();
});

test('Archive V3 writer closes owned files when construction validation fails', { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-constructor-close-'));
  await assert.rejects(
    () => PresentationArchiveWriter.createDirectory(directory, {
      ...writerOptions(),
      profileIdentity: '',
    }),
    /profileIdentity is invalid/u,
  );
  await rm(directory, { recursive: true });
});

test('Archive V3 writer closes owned files after seal failure and abort is idempotent', { concurrency: false }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-seal-close-'));
  const writer = await PresentationArchiveWriter.createDirectory(directory, writerOptions());
  await writer.startSegment({
    checkpointId: '1',
    sceneEpoch: 1,
    bootstrapId: 1,
    sourceTick: 0,
    bootstrapPacket: new TextEncoder().encode('bootstrap'),
  });
  const frame = new TextEncoder().encode('frame');
  await writer.appendFrame({ frameSeq: 1, sourceTick: 1, projectionId: 1, packet: frame });
  await writer.appendCorrelation({
    correlation: correlation({
      sceneEpoch: 1,
      bootstrapId: 1,
      sequence: 1,
      tick: 1,
      framePacket: frame,
    }),
  });
  await writeFile(join(directory, 'presentation-manifest.json'), 'already exists');

  await assert.rejects(() => writer.seal(), /EEXIST/u);
  assert.equal(writer.closed, true);
  assert.equal(writer.index.closed, true);
  assert.equal(writer.segments.closed, true);
  await writer.closeIncomplete();
});
