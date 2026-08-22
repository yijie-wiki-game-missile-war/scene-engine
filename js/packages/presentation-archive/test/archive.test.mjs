import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile } from 'node:fs/promises';
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

async function writeArchive(directory) {
  const writer = await PresentationArchiveWriter.createDirectory(directory, {
    profileIdentity: 'test-presentation@1',
    sourceAuthorityArtifactIdentity: 'test-tape@1',
    sourceAuthoritySha256: '1'.repeat(64),
    authorityCursorCodecIdentity: codec.codecIdentity,
    exporterIdentity: 'test-exporter@1',
    sceneEngineIdentity: 'scene-engine@0.2.0',
    visualManifestIdentity: 'visual@test',
    resourceManifestIdentity: 'resource@test',
  });
  for (let segment = 1; segment <= 2; segment += 1) {
    await writer.startSegment({
      checkpointId: String(segment),
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

test('Archive V2 streams multi-epoch checkpoints and random-access records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scene-engine-archive-'));
  const manifest = await writeArchive(directory);
  assert.equal(manifest.segment_count, 2);
  assert.equal(manifest.checkpoint_count, 2);
  const reader = await PresentationArchiveReader.openDirectory(directory);
  assert.equal((await reader.checkpoints()).length, 2);
  const checkpoint = await reader.openCheckpoint('2');
  assert.equal(new TextDecoder().decode(checkpoint.bootstrapPacket), 'bootstrap:2');
  const records = [];
  for await (const record of reader.iterateFrom('2')) records.push(record.kind);
  assert.deepEqual(records, ['checkpoint', 'frame', 'correlation']);
  await assert.rejects(
    () => reader.readFrame('1'),
    /ambiguous across segments/,
  );
  assert.equal(
    new TextDecoder().decode((await reader.readFrame('1', { segmentId: 2 })).bytes),
    'frame:2',
  );
  const verified = await reader.verify();
  assert.equal(verified.entryCount, 6n);
  await reader.close();
});

test('Archive V2 fails closed on block corruption', async () => {
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
