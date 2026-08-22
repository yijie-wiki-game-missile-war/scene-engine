import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  cursorEnvelopeToJSON,
  encodePresentationControl,
  envelopeCursor,
  SCENE_PACKET_HEADER_BYTES,
} from '@scene-engine/presentation-codec';
import {
  DEFAULT_PRESENTATION_SESSION_LIMITS,
  OrderedPresentationSession,
  PresentationBackpressureError,
  PresentationResetRequiredError,
} from '../src/index.js';

const codec = {
  codecIdentity: 'test-authority-cursor@1',
  encode: (cursor) => new TextEncoder().encode(JSON.stringify(cursor)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
  key: (cursor) => cursor.seq,
  tick: (cursor) => cursor.tick,
};
const baseline = envelopeCursor({ seq: 0, tick: 0 }, codec);

function control(type, payload, sequence, direction) {
  return encodePresentationControl({
    bootstrap_id: '2',
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

function session(limits = {}) {
  return new OrderedPresentationSession({
    bootstrapPacket: new TextEncoder().encode('bootstrap'),
    sceneEpoch: 1,
    bootstrapId: 2,
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    authorityBaseline: baseline,
    limits,
  });
}

test('default packet limit includes the SEDF header', () => {
  const maximumWireBytes = 8 * 1024 * 1024 + SCENE_PACKET_HEADER_BYTES;
  assert.equal(DEFAULT_PRESENTATION_SESSION_LIMITS.maximumPacketBytes, maximumWireBytes);
  assert.doesNotThrow(() => new OrderedPresentationSession({
    bootstrapPacket: new Uint8Array(maximumWireBytes),
    sceneEpoch: 1,
    bootstrapId: 2,
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    authorityBaseline: baseline,
  }));
  assert.throws(() => new OrderedPresentationSession({
    bootstrapPacket: new Uint8Array(maximumWireBytes + 1),
    sceneEpoch: 1,
    bootstrapId: 2,
    viewerScope: 'viewer:test',
    profileId: 'test-profile@1',
    authorityBaseline: baseline,
  }), /bootstrap packet byte length/u);
});

function ready(sequence = 1) {
  return control('presentation.ready', {
    authority_baseline: cursorEnvelopeToJSON(baseline),
    profile_id: 'test-profile@1',
  }, sequence, PRESENTATION_CONTROL_CLIENT_TO_SERVER);
}

function ack({ sequence, correlationSeq, frameSeq, cursor }) {
  return control('presentation.ack', {
    authority_cursor: cursorEnvelopeToJSON(cursor),
    correlation_seq: String(correlationSeq),
    frame_seq: String(frameSeq),
  }, sequence, PRESENTATION_CONTROL_CLIENT_TO_SERVER);
}

function resync(sequence, lastFrameSeq) {
  return control('presentation.resync_request', {
    last_frame_seq: lastFrameSeq == null ? null : String(lastFrameSeq),
    reason: 'client-state-invalid',
  }, sequence, PRESENTATION_CONTROL_CLIENT_TO_SERVER);
}

function admit(target, { correlationSeq, frameSeq, tick, cursor }) {
  const packet = new TextEncoder().encode(`frame:${frameSeq}`);
  target.admit({
    frames: [{ frameSeq, sourceTick: tick, projectionId: correlationSeq, packet }],
    correlation: control('presentation.correlation', {
      authority_cursor: cursorEnvelopeToJSON(cursor),
      correlation_seq: String(correlationSeq),
      frame_refs: [{
        frame_seq: String(frameSeq),
        sha256: createHash('sha256').update(packet).digest('hex'),
      }],
      presentation_required: true,
      projection_id: String(correlationSeq),
      source_tick: String(tick),
    }, correlationSeq, PRESENTATION_CONTROL_SERVER_TO_CLIENT),
  });
}

test('ordered session separates ready and ACK deadlines and enforces credit', () => {
  const target = session({ maximumInFlightFrames: 1 });
  assert.equal(target.openBootstrap({ wallNowMs: 0 }).kind, 'bootstrap');
  const cursor1 = envelopeCursor({ seq: 1, tick: 1 }, codec);
  const cursor2 = envelopeCursor({ seq: 2, tick: 2 }, codec);
  admit(target, { correlationSeq: 1, frameSeq: 1, tick: 1, cursor: cursor1 });
  admit(target, { correlationSeq: 2, frameSeq: 2, tick: 2, cursor: cursor2 });
  assert.deepEqual(target.drainSendable({ wallNowMs: 1 }), []);
  target.handleClientControl(ready(), { wallNowMs: 2 });
  assert.deepEqual(target.drainSendable({ wallNowMs: 2 }).map(({ kind }) => kind), [
    'frame',
    'correlation',
  ]);
  target.handleClientControl(ack({
    sequence: 2,
    correlationSeq: 1,
    frameSeq: 1,
    cursor: cursor1,
  }), { wallNowMs: 3 });
  assert.deepEqual(target.drainSendable({ wallNowMs: 3 })
    .filter(({ kind }) => kind === 'frame').map(({ frameSeq }) => frameSeq), [2]);
});

test('ready deadline expires even when no frame is in flight', () => {
  const target = session({ baselineReadyDeadlineMs: 5, presentationAckDeadlineMs: 500 });
  target.openBootstrap({ wallNowMs: 10 });
  assert.throws(
    () => target.checkTimeout({ wallNowMs: 16 }),
    (error) => error instanceof PresentationResetRequiredError
      && error.resetRequired.reason === 'ready-timeout'
      && error.resetRequired.lastAcknowledgedCursor === null,
  );
  assert.equal(target.valid, false);
});

test('ACK deadline begins after a frame enters the sent window', () => {
  const target = session({ baselineReadyDeadlineMs: 500, presentationAckDeadlineMs: 5 });
  target.openBootstrap({ wallNowMs: 0 });
  target.handleClientControl(ready(), { wallNowMs: 1 });
  admit(target, {
    correlationSeq: 1,
    frameSeq: 1,
    tick: 1,
    cursor: envelopeCursor({ seq: 1, tick: 1 }, codec),
  });
  target.drainSendable({ wallNowMs: 100 });
  target.checkTimeout({ wallNowMs: 105 });
  assert.throws(
    () => target.checkTimeout({ wallNowMs: 106 }),
    (error) => error instanceof PresentationResetRequiredError
      && error.resetRequired.reason === 'ack-timeout',
  );
  assert.equal(target.queuedFrames, 0);
  assert.equal(target.queuedBytes, 0);
});

test('retry cache retains only the last byte-identical client message', () => {
  const target = session({ maximumInFlightFrames: 1 });
  target.openBootstrap({ wallNowMs: 0 });
  target.handleClientControl(ready(), { wallNowMs: 1 });
  let lastAck;
  let lastCursor;
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    lastCursor = envelopeCursor({ seq: sequence, tick: sequence }, codec);
    admit(target, {
      correlationSeq: sequence,
      frameSeq: sequence,
      tick: sequence,
      cursor: lastCursor,
    });
    target.drainSendable({ wallNowMs: sequence });
    lastAck = ack({
      sequence: sequence + 1,
      correlationSeq: sequence,
      frameSeq: sequence,
      cursor: lastCursor,
    });
    target.handleClientControl(lastAck, { wallNowMs: sequence });
  }

  assert.equal(Object.hasOwn(target, 'clientMessages'), false);
  assert.deepEqual(target.lastClientMessageBytes, lastAck);
  assert.equal(target.handleClientControl(lastAck, { wallNowMs: 101 }), null);
  assert.throws(
    () => target.handleClientControl(ready(), { wallNowMs: 101 }),
    /sequence gap/u,
  );
  assert.throws(
    () => target.handleClientControl(ack({
      sequence: 101,
      correlationSeq: 100,
      frameSeq: 100,
      cursor: baseline,
    }), { wallNowMs: 101 }),
    /changed bytes/u,
  );
});

test('reset requirement reports cursor without allocating product identity', () => {
  const target = session({ maximumInFlightFrames: 1 });
  target.openBootstrap({ wallNowMs: 0 });
  target.handleClientControl(ready(), { wallNowMs: 1 });
  const cursor = envelopeCursor({ seq: 1, tick: 1 }, codec);
  admit(target, { correlationSeq: 1, frameSeq: 1, tick: 1, cursor });
  target.drainSendable({ wallNowMs: 1 });
  target.handleClientControl(ack({
    sequence: 2,
    correlationSeq: 1,
    frameSeq: 1,
    cursor,
  }), { wallNowMs: 2 });

  const required = target.handleClientControl(resync(3, 1), { wallNowMs: 2 });

  assert.deepEqual({
    required: required.required,
    reason: required.reason,
    sceneEpoch: required.sceneEpoch,
    bootstrapId: required.bootstrapId,
    cursor: required.lastAcknowledgedCursor,
    frameSeq: required.lastAcknowledgedFrameSeq,
    correlationSeq: required.lastAcknowledgedCorrelationSeq,
  }, {
    required: true,
    reason: 'client-resync',
    sceneEpoch: 1,
    bootstrapId: 2,
    cursor,
    frameSeq: 1,
    correlationSeq: 1,
  });
  assert.equal(Object.hasOwn(required, 'nextSceneEpoch'), false);
  assert.equal(Object.hasOwn(required, 'nextBootstrapId'), false);
  assert.equal(target.valid, false);
});

test('queue retention has an explicit tick-span limit', () => {
  const target = session({ maximumQueuedTickSpan: 1 });
  for (const sequence of [1, 2]) {
    admit(target, {
      correlationSeq: sequence,
      frameSeq: sequence,
      tick: sequence,
      cursor: envelopeCursor({ seq: sequence, tick: sequence }, codec),
    });
  }
  assert.throws(
    () => admit(target, {
      correlationSeq: 3,
      frameSeq: 3,
      tick: 3,
      cursor: envelopeCursor({ seq: 3, tick: 3 }, codec),
    }),
    PresentationBackpressureError,
  );
});

test('one correlation cannot exceed the in-flight credit window', () => {
  const target = session({ maximumInFlightFrames: 1 });
  const packets = [
    new TextEncoder().encode('frame:1'),
    new TextEncoder().encode('frame:2'),
  ];
  const frames = packets.map((packet, index) => ({
    frameSeq: index + 1,
    sourceTick: 1,
    projectionId: 1,
    packet,
  }));
  const cursor = envelopeCursor({ seq: 1, tick: 1 }, codec);
  const correlation = control('presentation.correlation', {
    authority_cursor: cursorEnvelopeToJSON(cursor),
    correlation_seq: '1',
    frame_refs: packets.map((packet, index) => ({
      frame_seq: String(index + 1),
      sha256: createHash('sha256').update(packet).digest('hex'),
    })),
    presentation_required: true,
    projection_id: '1',
    source_tick: '1',
  }, 1, PRESENTATION_CONTROL_SERVER_TO_CLIENT);

  assert.throws(
    () => target.admit({ frames, correlation }),
    PresentationBackpressureError,
  );
  assert.equal(target.queuedFrames, 0);
  assert.equal(target.queuedCorrelations, 0);
});

test('frame iterables stop at the credit limit before inspecting another packet', () => {
  const target = session({ maximumInFlightFrames: 1 });
  const firstPacket = new TextEncoder().encode('frame:1');
  let oversizedPacketWasRead = false;
  const frames = function* framesBeyondLimit() {
    yield { frameSeq: 1, sourceTick: 1, projectionId: 1, packet: firstPacket };
    yield {
      frameSeq: 2,
      sourceTick: 1,
      projectionId: 1,
      get packet() {
        oversizedPacketWasRead = true;
        throw new Error('packet past the credit limit must not be inspected');
      },
    };
    throw new Error('frame iterable must not be expanded without a bound');
  };
  const correlation = control('presentation.correlation', {
    authority_cursor: cursorEnvelopeToJSON(envelopeCursor({ seq: 1, tick: 1 }, codec)),
    correlation_seq: '1',
    frame_refs: [{
      frame_seq: '1',
      sha256: createHash('sha256').update(firstPacket).digest('hex'),
    }],
    presentation_required: true,
    projection_id: '1',
    source_tick: '1',
  }, 1, PRESENTATION_CONTROL_SERVER_TO_CLIENT);

  assert.throws(
    () => target.admit({ frames: frames(), correlation }),
    PresentationBackpressureError,
  );
  assert.equal(oversizedPacketWasRead, false);
  assert.equal(target.queuedFrames, 0);
});

test('oversized control bytes are rejected before codec parsing', () => {
  const target = session();
  assert.throws(
    () => target.handleClientControl(new Uint8Array(256 * 1024 + 1), { wallNowMs: 0 }),
    /control byte length is invalid/u,
  );
});
