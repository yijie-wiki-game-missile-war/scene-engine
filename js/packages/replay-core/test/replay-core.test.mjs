import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  cursorEnvelopeToJSON,
  encodePresentationControl,
  envelopeCursor,
} from '@scene-engine/presentation-codec';
import {
  AuthorityReplaySession,
  CompositeReplaySession,
  ReplayTimeline,
} from '../src/index.js';

const codec = {
  codecIdentity: 'test-authority-cursor@1',
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
  key: (value) => value.seq,
  tick: (value) => value.tick,
};

function cursor(seq, tick) {
  return envelopeCursor({ seq, tick }, codec);
}

function control(type, payload, sequence, direction) {
  return encodePresentationControl({
    bootstrap_id: '1',
    message_id: `${type}:${sequence}`,
    payload,
    protocol: 'scene-presentation-control-v2',
    scene_epoch: '1',
    schema_version: 1,
    session_seq: sequence,
    type,
    viewer_scope: 'viewer:test',
  }, { direction });
}

function correlation(sequence, frame) {
  return control('presentation.correlation', {
    authority_cursor: cursorEnvelopeToJSON(cursor(sequence - 1, sequence - 1)),
    correlation_seq: String(sequence),
    frame_refs: [{
      frame_seq: String(sequence),
      sha256: createHash('sha256').update(frame).digest('hex'),
    }],
    presentation_required: true,
    projection_id: String(sequence),
    source_tick: String(sequence - 1),
  }, sequence, PRESENTATION_CONTROL_SERVER_TO_CLIENT);
}

function createPorts() {
  const records = [
    { tick: 0, cursor: cursor(0, 0), wire: new TextEncoder().encode('snapshot') },
    { tick: 1, cursor: cursor(1, 1), wire: new TextEncoder().encode('delta:1') },
    { tick: 2, cursor: cursor(2, 2), wire: new TextEncoder().encode('delta:2') },
  ];
  const frame1 = new TextEncoder().encode('frame:baseline');
  const frame2 = new TextEncoder().encode('frame:1');
  const frame3 = new TextEncoder().encode('frame:2');
  const presentation = [
    { kind: 'checkpoint', entry: { sourceTick: 0n }, bytes: new TextEncoder().encode('bootstrap') },
    { kind: 'frame', entry: { frameSeq: 1n, sourceTick: 0n, projectionId: 1n }, bytes: frame1 },
    { kind: 'correlation', entry: { correlationSeq: 1n }, bytes: correlation(1, frame1) },
    { kind: 'frame', entry: { frameSeq: 2n, sourceTick: 1n, projectionId: 2n }, bytes: frame2 },
    { kind: 'correlation', entry: { correlationSeq: 2n }, bytes: correlation(2, frame2) },
    { kind: 'frame', entry: { frameSeq: 3n, sourceTick: 2n, projectionId: 3n }, bytes: frame3 },
    { kind: 'correlation', entry: { correlationSeq: 3n }, bytes: correlation(3, frame3) },
  ];
  return {
    authorityLane: {
      async openCheckpoint(id) {
        assert.equal(id, '1');
        return { baseline: records[0], nextRecordIndex: 1n };
      },
      async readRecord(index) { return records[Number(index)] ?? null; },
      tickOf(record) { return record.tick; },
      cursorOf(record) { return record.cursor; },
      wire(record) { return record.wire; },
    },
    presentationArchive: {
      async openCheckpoint(id) {
        assert.equal(id, '1');
        return {
          checkpoint: { sourceTick: 0n, sceneEpoch: 1n, bootstrapId: 1n },
          bootstrapPacket: new TextEncoder().encode('bootstrap'),
          nextEntryIndex: 1n,
        };
      },
      async *iterateFrom(id) {
        assert.equal(id, '1');
        yield* presentation;
      },
    },
  };
}

function ready() {
  return control('presentation.ready', {
    authority_baseline: cursorEnvelopeToJSON(cursor(0, 0)),
    profile_id: 'test-profile@1',
  }, 1, PRESENTATION_CONTROL_CLIENT_TO_SERVER);
}

function ack(sequence) {
  return control('presentation.ack', {
    authority_cursor: cursorEnvelopeToJSON(cursor(sequence - 1, sequence - 1)),
    correlation_seq: String(sequence),
    frame_seq: String(sequence),
  }, sequence + 1, PRESENTATION_CONTROL_CLIENT_TO_SERVER);
}

test('ReplayTimeline derives delay only from ticks and speed', () => {
  const timeline = new ReplayTimeline();
  timeline.reset({ baselineTick: 10, wallNowMs: 100 });
  assert.equal(timeline.dueFor(11, 100), 100 + 1000 / 60);
  timeline.setSpeed(2, 100);
  assert.equal(timeline.dueFor(11, 100), 100 + 500 / 60);
});

test('AuthorityReplaySession owns baseline gate, instant playback, and generation seek', async () => {
  const { authorityLane } = createPorts();
  const target = new AuthorityReplaySession({ authorityLane, instant: true });
  assert.deepEqual((await target.open('1', { wallNowMs: 0 })).map(({ kind }) => kind), [
    'authority-baseline',
  ]);
  assert.deepEqual(await target.pump(10), []);
  target.markBaselineReady(cursor(0, 0));
  assert.deepEqual((await target.pump(10)).map(({ kind }) => kind), ['authority', 'authority']);
  const sought = await target.seek('1', { wallNowMs: 20 });
  assert.equal(sought.reconnectRequired, true);
  assert.equal(sought.generation, 2);
});

test('CompositeReplaySession jointly gates lanes and respects cumulative credit', async () => {
  const target = new CompositeReplaySession({
    ...createPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    sessionLimits: { maximumInFlightFrames: 1 },
  });
  assert.deepEqual((await target.open('1', { wallNowMs: 0 })).map(({ kind }) => kind), [
    'authority-baseline',
    'bootstrap',
  ]);
  assert.deepEqual(await target.pump(100), []);
  target.markAuthorityBaselineReady(cursor(0, 0));
  assert.deepEqual(await target.pump(100), []);
  target.handlePresentationControl(ready(), { wallNowMs: 1 });
  assert.deepEqual((await target.pump(1)).map(({ kind }) => kind), [
    'frame',
    'correlation',
  ]);
  assert.deepEqual((await target.pump(16)).map(({ kind }) => kind), []);
  target.handlePresentationControl(ack(1), { wallNowMs: 16 });
  assert.deepEqual((await target.pump(17)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
  assert.deepEqual(await target.pump(100), []);
  target.handlePresentationControl(ack(2), { wallNowMs: 18 });
  assert.deepEqual((await target.pump(34)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
});

test('pause freezes both lanes and speed only scales wall-clock', async () => {
  const target = new CompositeReplaySession({
    ...createPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 1 });
  target.pause(5);
  assert.deepEqual(await target.pump(100), []);
  target.resume(105);
  target.setSpeed(2, 105);
  assert.deepEqual((await target.pump(108)).map(({ kind }) => kind), [
    'frame',
    'correlation',
  ]);
  target.handlePresentationControl(ack(1), { wallNowMs: 108 });
  assert.deepEqual((await target.pump(109)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
});
