import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  decodeSceneBootstrapV2Packet,
  parsePresentationFrame,
  parseSceneBootstrapV2,
  parseScenePacket,
  PresentationBinaryError,
} from '../src/index.js';

const BOOTSTRAP_HEX = [
  '0200010060000700020000000000000003000000000000003c0001000000803f6400000000001000',
  '8c0000006c0000003a592a7226e23bc7e74f9e8b2a7af6a527f8b0fb23e071d21b2772bbfbb822a0',
  '000000000000000000000000000000000100010001000000ec000000340000000000000002000100',
  '00000000200100000000000050000000030001000000000020010000000000002000000004000100',
  '00000000200100000000000010000000050001000000000020010000000000002000000006000100',
  '00000000200100000000000010000000070001000100000020010000380000000000000008000b00',
  '130026000000000072756e3a746573747669657765723a74657374746573742d70726573656e746174',
  '696f6e403200001700130000002a0000000000746573742d617574686f726974792d637572736f72',
  '40316f70617175652d637572736f722d62797465730000',
].join('');

test('bootstrap V2 decoder preserves engine identity and opaque authority baseline', () => {
  const bytes = Uint8Array.from(Buffer.from(BOOTSTRAP_HEX, 'hex'));
  const decoded = parseSceneBootstrapV2(bytes);
  assert.equal(decoded.data.buffer, bytes.buffer);
  assert.deepEqual(decoded.identity, {
    profileId: 'test-presentation@2',
    runId: 'run:test',
    viewerScope: 'viewer:test',
  });
  assert.equal(decoded.authorityBaseline.codecIdentity, 'test-authority-cursor@1');
  assert.equal(new TextDecoder().decode(decoded.authorityBaseline.canonicalBytes), 'opaque-cursor-bytes');
});

test('packet envelope decoder uses borrowed payload views and validates the message type', () => {
  const payload = Uint8Array.from(Buffer.from(BOOTSTRAP_HEX, 'hex'));
  const packet = new Uint8Array(24 + payload.byteLength);
  packet.set(new TextEncoder().encode('SEDF'));
  const view = new DataView(packet.buffer);
  view.setUint16(4, 1, true);
  view.setUint8(6, 1);
  view.setUint16(10, 24, true);
  view.setUint32(12, payload.byteLength, true);
  view.setUint32(16, payload.byteLength, true);
  packet.set(payload, 24);
  assert.equal(parseScenePacket(packet).payload.buffer, packet.buffer);
  assert.equal(decodeSceneBootstrapV2Packet(packet).identity.runId, 'run:test');
});

test('presentation frame V2 golden bytes are decoded and malformed bytes fail closed', () => {
  const fixture = new URL('../../../../tests/fixtures/presentation_frame_v2.hex', import.meta.url);
  const bytes = Uint8Array.from(Buffer.from(readFileSync(fixture, 'ascii').trim(), 'hex'));
  const decoded = parsePresentationFrame(bytes);
  assert.equal(decoded.header.frameSeq, '60');
  assert.deepEqual(decoded.entities.map(({ displayId }) => displayId), ['1', '2']);
  assert.equal(decoded.interactions[0].domainValue, 'entity:alpha');
  const corrupt = bytes.slice();
  corrupt[80] = 99;
  assert.throws(() => parsePresentationFrame(corrupt), PresentationBinaryError);
});
