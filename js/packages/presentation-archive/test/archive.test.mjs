import assert from 'node:assert/strict';
import { cp, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  parsePresentationControl,
} from '@scene-engine/presentation-codec';
import * as archiveNode from '../src/index.js';
import {
  FileByteRangeSource,
  PresentationArchiveError,
  PresentationArchiveReader,
} from '../src/index.js';

const FIXTURE = fileURLToPath(new URL(
  '../../../../tests/fixtures/presentation-archive-v3/',
  import.meta.url,
));

test('archive-node public surface is reader-only', () => {
  assert.deepEqual(Object.keys(archiveNode).sort(), [
    'DEFAULT_ARCHIVE_LIMITS',
    'FileByteRangeSource',
    'PRESENTATION_ARCHIVE_SCHEMA_IDENTITY',
    'PresentationArchiveError',
    'PresentationArchiveReader',
  ]);
  assert.equal('PresentationArchiveWriter' in archiveNode, false);
  assert.equal('FileByteSink' in archiveNode, false);
});

test('Node reader verifies the fixed Python-writer multi-epoch fixture', async () => {
  const reader = await PresentationArchiveReader.openDirectory(FIXTURE);
  assert.equal(reader.manifest().schema_identity, 'scene-presentation-archive-v3@1');
  assert.equal(reader.manifest().scene_engine_identity, 'scene-engine@0.4.0');
  assert.equal(reader.manifest().segment_count, 2);
  assert.equal(reader.manifest().checkpoint_count, 2);
  assert.equal(reader.manifest().entry_count, '9');
  assert.equal(reader.manifest().frame_count, '3');
  assert.equal(reader.manifest().correlation_count, '4');
  assert.deepEqual(await reader.checkpoints(), [
    {
      checkpointId: 1n,
      segmentId: 1,
      indexEntryNumber: 0n,
      sceneEpoch: 9n,
      bootstrapId: 11n,
      sourceTick: 0n,
    },
    {
      checkpointId: 2n,
      segmentId: 2,
      indexEntryNumber: 6n,
      sceneEpoch: 10n,
      bootstrapId: 12n,
      sourceTick: 1n,
    },
  ]);
  const verified = await reader.verify();
  assert.equal(verified.entryCount, 9n);
  assert.equal(verified.indexSha256, reader.manifest().index_payload_sha256);
  assert.equal(verified.segmentsSha256, reader.manifest().segments_sha256);
  await reader.close();
});

test('fixed fixture preserves frame, zero-frame, frame correlation order', async () => {
  const reader = await PresentationArchiveReader.openDirectory(FIXTURE);
  const records = [];
  for await (const record of reader.iterateFrom('1')) records.push(record);
  assert.deepEqual(records.map(({ kind }) => kind), [
    'checkpoint',
    'frame',
    'correlation',
    'correlation',
    'frame',
    'correlation',
  ]);
  const correlations = records
    .filter(({ kind }) => kind === 'correlation')
    .map(({ bytes }) => parsePresentationControl(bytes, {
      direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    }));
  assert.deepEqual(
    correlations.map(({ payload }) => payload.frame_refs.map(({ frame_seq }) => frame_seq)),
    [['1'], [], ['2']],
  );
  assert.deepEqual(
    correlations.map(({ payload }) => payload.presentation_required),
    [true, false, true],
  );
  assert.deepEqual(
    correlations.map(({ payload }) => payload.correlation_seq),
    ['1', '2', '3'],
  );

  const nextEpochKinds = [];
  for await (const record of reader.iterateFrom('2')) nextEpochKinds.push(record.kind);
  assert.deepEqual(nextEpochKinds, ['checkpoint', 'frame', 'correlation']);
  assert.equal(typeof reader.readFrame, 'undefined');
  assert.equal(typeof reader.readCorrelation, 'undefined');
  await reader.close();
});

test('Archive V3 fails closed on block corruption and truncation', async () => {
  const corrupted = await fixtureCopy('scene-engine-archive-corrupt-');
  const corruptedPath = join(corrupted, 'presentation-segments.bin');
  const corruptedBytes = await readFile(corruptedPath);
  corruptedBytes[corruptedBytes.length - 1] ^= 0xff;
  await writeFile(corruptedPath, corruptedBytes);
  const corruptedReader = await PresentationArchiveReader.openDirectory(corrupted);
  await assert.rejects(() => corruptedReader.verify(), PresentationArchiveError);
  await corruptedReader.close();

  const truncated = await fixtureCopy('scene-engine-archive-truncated-');
  const truncatedPath = join(truncated, 'presentation-segments.bin');
  const truncatedBytes = await readFile(truncatedPath);
  await writeFile(truncatedPath, truncatedBytes.subarray(0, truncatedBytes.length - 1));
  const truncatedReader = await PresentationArchiveReader.openDirectory(truncated);
  await assert.rejects(() => truncatedReader.verify(), /truncated/u);
  await truncatedReader.close();
});

test('Archive V3 validates checkpoint directory before seek and closes open handles', {
  concurrency: false,
}, async () => {
  const directory = await fixtureCopy('scene-engine-archive-directory-corrupt-');
  const path = join(directory, 'presentation-index.bin');
  const bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(path, bytes);
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

test('Archive V3 enforces reader-local hard limits before block iteration', async () => {
  await assert.rejects(
    () => PresentationArchiveReader.openDirectory(FIXTURE, {
      limits: { maximumEntries: 8 },
    }),
    /maximumEntries/u,
  );
});

test('FileByteRangeSource loops until short reads complete', { concurrency: false }, async () => {
  const probe = await open(join(FIXTURE, 'presentation-index.bin'), 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  prototype.read = function shortRead(buffer, offset, length, position) {
    return originalRead.call(this, buffer, offset, Math.min(length, 7), position);
  };
  try {
    const reader = await PresentationArchiveReader.openDirectory(FIXTURE);
    await reader.verify();
    await reader.close();
  } finally {
    prototype.read = originalRead;
  }
});

async function fixtureCopy(prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await cp(FIXTURE, directory, { recursive: true });
  return directory;
}
