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
  OrderedPresentationSession,
  PresentationSessionError,
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

function ready(sequence = 1) {
  return control('presentation.ready', {
    authority_baseline: cursorEnvelopeToJSON(baseline),
    profile_id: 'test-profile@1',
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
  target.handleClientControl(control('presentation.ack', {
    authority_cursor: cursorEnvelopeToJSON(cursor1),
    correlation_seq: '1',
    frame_seq: '1',
  }, 2, PRESENTATION_CONTROL_CLIENT_TO_SERVER), { wallNowMs: 3 });
  assert.deepEqual(target.drainSendable({ wallNowMs: 3 })
    .filter(({ kind }) => kind === 'frame').map(({ frameSeq }) => frameSeq), [2]);
});

test('ready deadline expires even when no frame is in flight', () => {
  const target = session({ baselineReadyDeadlineMs: 5, presentationAckDeadlineMs: 500 });
  target.openBootstrap({ wallNowMs: 10 });
  assert.throws(() => target.checkTimeout({ wallNowMs: 16 }), /ready timed out/u);
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
  target.drainSendable({ wallNowMs: 1 });
  assert.throws(() => target.checkTimeout({ wallNowMs: 7 }), PresentationSessionError);
});
