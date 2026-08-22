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

function archiveFrame(sequence, bytes) {
  return {
    kind: 'frame',
    entry: { frameSeq: BigInt(sequence), sourceTick: 0n, projectionId: 1n },
    bytes,
  };
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
        return {
          baseline: records[0],
          endRecordIndexExclusive: BigInt(records.length),
          nextRecordIndex: 1n,
        };
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

test('AuthorityReplaySession bounds copied output bytes per pump', async () => {
  const { authorityLane } = createPorts();
  const target = new AuthorityReplaySession({
    authorityLane,
    instant: true,
    maximumBytesPerPump: 8,
  });
  await target.open('1', { wallNowMs: 0 });
  target.markBaselineReady(cursor(0, 0));
  assert.deepEqual((await target.pump(0)).map(({ data }) => new TextDecoder().decode(data)), [
    'delta:1',
  ]);
  assert.deepEqual((await target.pump(0)).map(({ data }) => new TextDecoder().decode(data)), [
    'delta:2',
  ]);
});

test('AuthorityReplaySession replays baseline-adjacent and later outbound controls in tape order', async () => {
  const { authorityLane } = createPorts();
  const text = new TextEncoder();
  authorityLane.transmissionsOf = (record) => Object.freeze([
    Object.freeze({ kind: 'authority', data: record.wire }),
    Object.freeze({
      kind: 'authority-control',
      data: text.encode(`control:${record.tick}`),
    }),
  ]);
  const target = new AuthorityReplaySession({ authorityLane, instant: true });
  assert.deepEqual(
    (await target.open('1', { wallNowMs: 0 })).map(({ data }) => new TextDecoder().decode(data)),
    ['snapshot'],
  );
  target.markBaselineReady(cursor(0, 0));
  assert.deepEqual(
    (await target.pump(0)).map(({ data }) => new TextDecoder().decode(data)),
    ['control:0', 'delta:1', 'control:1', 'delta:2', 'control:2'],
  );
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

test('CompositeReplaySession stops at the selected authority checkpoint boundary', async () => {
  const ports = createPorts();
  ports.authorityLane.openCheckpoint = async () => ({
    baseline: await ports.authorityLane.readRecord(0n),
    endRecordIndexExclusive: 2n,
    nextRecordIndex: 1n,
  });
  const target = new CompositeReplaySession({
    ...ports,
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    sessionLimits: { maximumInFlightFrames: 1 },
    instant: true,
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 0 });
  await target.pump(0);
  target.handlePresentationControl(ack(1), { wallNowMs: 0 });
  await target.pump(0);
  target.handlePresentationControl(ack(2), { wallNowMs: 0 });

  assert.deepEqual(await target.pump(0), []);
  assert.equal(target.status().authorityRecordIndex, 2n);
  assert.equal(target.status().exhausted, true);
});

test('CompositeReplaySession retains raw outbound controls around presentation joins', async () => {
  const ports = createPorts();
  const text = new TextEncoder();
  ports.authorityLane.transmissionsOf = (record) => Object.freeze([
    Object.freeze({ kind: 'authority', data: record.wire }),
    Object.freeze({
      kind: 'authority-control',
      data: text.encode(`control:${record.tick}`),
    }),
  ]);
  const target = new CompositeReplaySession({
    ...ports,
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    sessionLimits: { maximumInFlightFrames: 1 },
    instant: true,
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 0 });
  assert.deepEqual((await target.pump(0)).map(({ kind }) => kind), [
    'frame',
    'correlation',
    'authority-control',
  ]);
  target.handlePresentationControl(ack(1), { wallNowMs: 0 });
  assert.deepEqual((await target.pump(0)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
    'authority-control',
  ]);
});

test('CompositeReplaySession never splits an authority primary from its presentation at a pump boundary', async () => {
  const ports = createPorts();
  ports.authorityLane.transmissionsOf = (record) => record.tick === 1
    ? Object.freeze([
      Object.freeze({ kind: 'authority', data: record.wire }),
      Object.freeze({ kind: 'authority-control', data: new Uint8Array(1024) }),
    ])
    : Object.freeze([Object.freeze({ kind: 'authority', data: record.wire })]);
  const target = new CompositeReplaySession({
    ...ports,
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    sessionLimits: { maximumInFlightFrames: 1 },
    instant: true,
    maximumBytesPerPump: 1024,
    maximumTransmissionsPerPump: 3,
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 0 });
  await target.pump(0);
  target.handlePresentationControl(ack(1), { wallNowMs: 0 });

  assert.deepEqual((await target.pump(0)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
  assert.equal(target.status().authorityRecordIndex, 1n);
  target.pause(1);
  assert.deepEqual(await target.pump(100), []);
  target.resume(101);
  assert.deepEqual((await target.pump(101)).map(({ kind }) => kind), [
    'authority-control',
  ]);
  assert.equal(target.status().authorityRecordIndex, 2n);
});

test('CompositeReplaySession bounds presentation joins while reading archive records', async () => {
  const cases = [
    {
      limits: { maximumInFlightFrames: 1 },
      pattern: /frame-count limit/u,
      records() {
        let secondPacketRead = false;
        return {
          list: [
            archiveFrame(1, new Uint8Array([1])),
            {
              kind: 'frame',
              entry: { frameSeq: 2n, sourceTick: 0n, projectionId: 1n },
              get bytes() {
                secondPacketRead = true;
                throw new Error('second packet bytes must not be read');
              },
            },
          ],
          verify: () => assert.equal(secondPacketRead, false),
        };
      },
    },
    {
      limits: { maximumPacketBytes: 9 },
      pattern: /maximumPacketBytes/u,
      records: () => ({ list: [archiveFrame(1, new Uint8Array(10))], verify() {} }),
    },
    {
      limits: { maximumInFlightFrames: 8, maximumQueuedBytes: 10 },
      pattern: /maximumQueuedBytes/u,
      records: () => ({
        list: [
          archiveFrame(1, new Uint8Array(6)),
          archiveFrame(2, new Uint8Array(6)),
        ],
        verify() {},
      }),
    },
  ];
  for (const item of cases) {
    const ports = createPorts();
    const generated = item.records();
    ports.presentationArchive.iterateFrom = async function* iterateFrom() {
      yield { kind: 'checkpoint' };
      yield* generated.list;
    };
    const target = new CompositeReplaySession({
      ...ports,
      viewerScope: 'viewer:test',
      profileId: 'test-profile@1',
      sessionLimits: item.limits,
    });
    await assert.rejects(target.open('1', { wallNowMs: 0 }), item.pattern);
    generated.verify();
  }
});

test('CompositeReplaySession admits an 8 MiB payload plus its 24-byte packet header exactly', async () => {
  const packet = new Uint8Array(8 * 1024 * 1024 + 24);
  const correlationBytes = correlation(1, packet);
  const createBoundaryPorts = () => {
    const ports = createPorts();
    ports.presentationArchive.iterateFrom = async function* iterateFrom() {
      yield { kind: 'checkpoint' };
      yield archiveFrame(1, packet);
      yield {
        kind: 'correlation',
        entry: { correlationSeq: 1n },
        bytes: correlationBytes,
      };
    };
    return ports;
  };
  const accepted = new CompositeReplaySession({
    ...createBoundaryPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    sessionLimits: {
      maximumPacketBytes: packet.byteLength,
      maximumQueuedBytes: 16 * 1024 * 1024,
    },
  });
  await accepted.open('1', { wallNowMs: 0 });

  const rejected = new CompositeReplaySession({
    ...createBoundaryPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    sessionLimits: {
      maximumPacketBytes: packet.byteLength - 1,
      maximumQueuedBytes: 16 * 1024 * 1024,
    },
  });
  await assert.rejects(
    rejected.open('1', { wallNowMs: 0 }),
    /maximumPacketBytes/u,
  );
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

test('pause/resume shifts an already joined replay deadline by the paused duration', async () => {
  const target = new CompositeReplaySession({
    ...createPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 0 });
  assert.deepEqual((await target.pump(0)).map(({ kind }) => kind), ['frame', 'correlation']);
  target.handlePresentationControl(ack(1), { wallNowMs: 0 });
  assert.deepEqual(await target.pump(1), []);

  target.pause(5);
  target.resume(105);

  assert.deepEqual(await target.pump(116), []);
  assert.deepEqual((await target.pump(117)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
});

test('speed changes rescale the remaining delay of an already joined replay record', async () => {
  const target = new CompositeReplaySession({
    ...createPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 0 });
  await target.pump(0);
  target.handlePresentationControl(ack(1), { wallNowMs: 0 });
  await target.pump(1);

  target.setSpeed(2, 5);

  assert.deepEqual(await target.pump(10), []);
  assert.deepEqual((await target.pump(11)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
});

test('speed changes while paused preserve and rescale the frozen remaining delay', async () => {
  const target = new CompositeReplaySession({
    ...createPorts(),
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
  });
  await target.open('1', { wallNowMs: 0 });
  target.markAuthorityBaselineReady(cursor(0, 0));
  target.handlePresentationControl(ready(), { wallNowMs: 0 });
  await target.pump(0);
  target.handlePresentationControl(ack(1), { wallNowMs: 0 });
  await target.pump(1);

  target.pause(5);
  target.setSpeed(2, 50);
  target.resume(105);

  assert.deepEqual(await target.pump(110), []);
  assert.deepEqual((await target.pump(111)).map(({ kind }) => kind), [
    'authority',
    'frame',
    'correlation',
  ]);
});
