import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  PresentationCodecError,
  cursorEnvelopeToJSON,
  encodePresentationControl,
  envelopeCursor,
  parsePresentationControl,
} from '../src/index.js';

const codec = {
  codecIdentity: 'test-authority-cursor@1',
  encode: (cursor) => new TextEncoder().encode(JSON.stringify(cursor)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
  key: (cursor) => cursor.seq,
  tick: (cursor) => cursor.tick,
};
const cursor = envelopeCursor({ seq: 1, tick: 0 }, codec);

function envelope(type, payload, sessionSeq = 1) {
  return {
    bootstrap_id: '2',
    message_id: `message:${sessionSeq}`,
    payload,
    protocol: 'scene-presentation-control-v2',
    scene_epoch: '1',
    schema_version: 1,
    session_seq: sessionSeq,
    type,
    viewer_scope: 'viewer:test',
  };
}

test('control V2 round-trips opaque authority cursor bytes canonically', () => {
  const ready = envelope('presentation.ready', {
    authority_baseline: cursorEnvelopeToJSON(cursor),
    profile_id: 'test-profile@1',
  });
  const encoded = encodePresentationControl(ready, {
    direction: PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  });
  assert.equal(new TextDecoder().decode(encoded).includes('state_stream_id'), false);
  assert.deepEqual(parsePresentationControl(encoded, {
    direction: PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  }), ready);

  const correlation = envelope('presentation.correlation', {
    authority_cursor: cursorEnvelopeToJSON(cursor),
    correlation_seq: '1',
    frame_refs: [{ frame_seq: '1', sha256: 'a'.repeat(64) }],
    presentation_required: true,
    projection_id: '1',
    source_tick: '1',
  });
  assert.deepEqual(parsePresentationControl(encodePresentationControl(correlation, {
    direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  }), { direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT }), correlation);
});

test('control V2 rejects noncanonical base64 and unknown fields', () => {
  const ready = envelope('presentation.ready', {
    authority_baseline: {
      ...cursorEnvelopeToJSON(cursor),
      canonical_bytes_base64: `${cursorEnvelopeToJSON(cursor).canonical_bytes_base64}=`,
    },
    profile_id: 'test-profile@1',
  });
  assert.throws(() => encodePresentationControl(ready, {
    direction: PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  }), PresentationCodecError);
  assert.throws(() => encodePresentationControl({ ...ready, legacy_cursor: {} }, {
    direction: PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  }), /unknown or missing fields/u);
});
