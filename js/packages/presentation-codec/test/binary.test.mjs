import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as codec from '../src/index.js';

const FIXTURES = new URL('../../../../tests/fixtures/', import.meta.url);

function fixture(name) {
  const value = readFileSync(new URL(name, FIXTURES), 'ascii').trim();
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

test('SceneBootstrapV3 golden uses borrowed node accessors and frozen packed layout', () => {
  const bytes = fixture('scene_bootstrap_v3.hex');
  const decoded = codec.parseSceneBootstrapV3(bytes);
  assert.equal(decoded.raw.buffer, bytes.buffer);
  assert.equal(decoded.header.schemaVersion, 3);
  assert.equal(decoded.header.headerBytes, 96);
  assert.equal(decoded.directory.length, 11);
  assert.equal(decoded.nodeCount, 2);
  assert.equal(decoded.identity.profileId, 'mw-presentation-v3@1');
  assert.equal(decoded.authorityBaseline.codecIdentity, 'mw-v5-full-cursor@1');
  assert.equal(decoded.displayIdAt(0), 1n);
  assert.equal(decoded.parentDisplayIdAt(1), 1n);
  assert.equal(decoded.visualTypeIdAt(1), 2);
  assert.equal(decoded.entities, undefined);

  const pose = {
    localPosition: new Float32Array(3),
    localRotationXyzw: new Float32Array(4),
    localScale: new Float32Array(3),
  };
  assert.equal(decoded.readLocalPose(1, pose), pose);
  assert.deepEqual([...pose.localPosition], [2, 0, 0]);
  assert.deepEqual([...pose.localRotationXyzw], [0, 0, 0, 1]);
  assert.deepEqual([...pose.localScale], [1, 1, 1]);

  const profile = {};
  assert.equal(decoded.readProfileStateAt(0, profile), true);
  assert.equal(profile.typeId, 101);
  assert.equal(new TextDecoder().decode(profile.bytes), 'static-root');
  assert.equal(profile.bytes.buffer, bytes.buffer);
  assert.equal(decoded.readInteractionAt(1, {}), false);
  assert.equal(decoded.visualTypeAt(1).profileTypeId, 102);
  assert.equal(decoded.animationStateAt(0).durationTicks, 60);
  assert.equal(new TextDecoder().decode(decoded.metadataAt(0).bytes), 'hex-topology-v1');
});

test('PresentationFrameV3 golden keeps node and payload reads borrowed', () => {
  const bytes = fixture('presentation_frame_v3.hex');
  const decoded = codec.parsePresentationFrameV3(bytes);
  assert.equal(decoded.raw.buffer, bytes.buffer);
  assert.equal(decoded.header.schemaVersion, 3);
  assert.equal(decoded.header.headerBytes, 80);
  assert.equal(decoded.directory.length, 7);
  assert.equal(decoded.header.frameSeq, 60n);
  assert.equal(decoded.nodeCount, 2);
  assert.deepEqual([decoded.displayIdAt(0), decoded.displayIdAt(1)], [3n, 4n]);
  assert.equal(decoded.parentDisplayIdAt(0), 2n);
  assert.equal(decoded.animationStartTickAt(0), 60n);
  const interaction = {};
  assert.equal(decoded.readInteractionAt(0, interaction), true);
  assert.equal(interaction.typeId, 201);
  assert.equal(interaction.bytes.buffer, bytes.buffer);
  assert.equal(decoded.eventCount, 1);
  assert.equal(decoded.eventAt(0).eventTypeId, 501);
  assert.equal(new TextDecoder().decode(decoded.eventAt(0).payload), 'impact');
});

test('packet V1 envelope dispatches only to V3 presentation decoders', () => {
  const payload = fixture('scene_bootstrap_v3.hex');
  const packet = new Uint8Array(24 + payload.byteLength);
  packet.set(new TextEncoder().encode('SEDF'));
  const view = new DataView(packet.buffer);
  view.setUint16(4, 1, true);
  view.setUint8(6, 1);
  view.setUint16(10, 24, true);
  view.setUint32(12, payload.byteLength, true);
  view.setUint32(16, payload.byteLength, true);
  packet.set(payload, 24);
  assert.equal(codec.parseScenePacket(packet).payload.buffer, packet.buffer);
  assert.equal(codec.decodeSceneBootstrapV3Packet(packet).identity.runId, 'run:test');
  assert.equal(codec.parsePresentationFrame, undefined);
  assert.equal(codec.parseSceneBootstrapV2, undefined);
  assert.equal(codec.decodeSceneBootstrapV2Packet, undefined);
});

test('BootstrapV3 decoder rejects a hash-valid dangling static parent', () => {
  const bytes = fixture('scene_bootstrap_v3.hex');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigUint64(488, 3n, true);
  view.setBigUint64(496, 2n, true);
  view.setBigUint64(592, 3n, true);
  view.setBigUint64(656, 3n, true);
  bytes.set(createHash('sha256').update(bytes.subarray(96)).digest(), 48);
  assert.throws(
    () => codec.parseSceneBootstrapV3(bytes),
    /dangling parent/u,
  );
});

const corpus = JSON.parse(readFileSync(
  new URL('presentation_malformed_v3.json', FIXTURES),
  'utf8',
));

for (const entry of corpus.cases) {
  test(`shared malformed V3 corpus rejects ${entry.id}`, () => {
    const source = fixture(entry.target === 'bootstrap'
      ? 'scene_bootstrap_v3.hex' : 'presentation_frame_v3.hex');
    const malformed = mutate(source, entry.operation);
    const parse = entry.target === 'bootstrap'
      ? codec.parseSceneBootstrapV3 : codec.parsePresentationFrameV3;
    assert.throws(() => parse(malformed), codec.PresentationBinaryError);
  });
}

function mutate(source, operation) {
  if (operation.kind === 'bootstrap_identity_over_limit') {
    const run = Buffer.from('r'.repeat(4095));
    const viewer = Buffer.from('v');
    const profile = Buffer.from('p');
    const payload = new Uint8Array(12 + run.byteLength + viewer.byteLength + profile.byteLength);
    const view = new DataView(payload.buffer);
    view.setUint16(0, run.byteLength, true);
    view.setUint16(2, viewer.byteLength, true);
    view.setUint16(4, profile.byteLength, true);
    view.setUint32(6, run.byteLength + viewer.byteLength + profile.byteLength, true);
    payload.set(run, 12);
    payload.set(viewer, 12 + run.byteLength);
    payload.set(profile, 12 + run.byteLength + viewer.byteLength);
    return replaceBootstrapSection(source, 0, pad4(payload));
  }
  if (operation.kind === 'bootstrap_codec_identity_over_limit') {
    return replaceBootstrapSection(
      source,
      1,
      authorityBaselineSection(Buffer.from('a'.repeat(161)), Buffer.from('c')),
    );
  }
  if (operation.kind === 'bootstrap_cursor_over_limit') {
    return replaceBootstrapSection(
      source,
      1,
      authorityBaselineSection(Buffer.from('c'), Buffer.alloc(16 * 1024 + 1, 'x')),
    );
  }
  if (operation.kind === 'bootstrap_remove_node_payload') {
    return removeBootstrapNodePayload(source, operation.payload, operation.node_index);
  }
  if (operation.kind === 'truncate') return source.slice(0, operation.length);
  if (operation.kind === 'append_u8') {
    const result = new Uint8Array(source.byteLength + 1);
    result.set(source);
    result[result.byteLength - 1] = operation.value;
    return result;
  }
  const result = source.slice();
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  if (operation.kind === 'xor_u8') result[operation.offset] ^= operation.value;
  else if (operation.kind === 'write_u8') result[operation.offset] = operation.value;
  else if (operation.kind === 'write_u16') view.setUint16(operation.offset, operation.value, true);
  else if (operation.kind === 'write_u32') view.setUint32(operation.offset, operation.value, true);
  else if (operation.kind === 'write_u64') view.setBigUint64(
    operation.offset,
    BigInt(operation.value),
    true,
  );
  else throw new Error(`unknown mutation: ${operation.kind}`);
  return result;
}

function authorityBaselineSection(codec, cursor) {
  const payload = new Uint8Array(12 + codec.byteLength + cursor.byteLength);
  const view = new DataView(payload.buffer);
  view.setUint16(0, codec.byteLength, true);
  view.setUint32(2, cursor.byteLength, true);
  view.setUint32(6, codec.byteLength + cursor.byteLength, true);
  payload.set(codec, 12);
  payload.set(cursor, 12 + codec.byteLength);
  return pad4(payload);
}

function removeBootstrapNodePayload(source, payload, nodeIndex) {
  const indexes = payload === 'profile' ? [3, 4]
    : payload === 'interaction' ? [5, 6] : null;
  if (!indexes) throw new Error(`unknown node payload: ${payload}`);
  const [refsIndex, blobIndex] = indexes;
  const value = source.slice();
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const refsEntry = 96 + refsIndex * 20;
  const blobEntry = 96 + blobIndex * 20;
  const nodeCount = view.getUint32(refsEntry + 4, true);
  if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodeCount) {
    throw new Error('nodeIndex is outside the bootstrap fixture');
  }
  const refsOffset = view.getUint32(refsEntry + 8, true);
  const blobOffset = view.getUint32(blobEntry + 8, true);
  const blobCount = view.getUint32(blobEntry + 4, true);
  const targetRef = refsOffset + nodeIndex * 24;
  const removedOffset = view.getUint32(targetRef + 16, true);
  const removedLength = view.getUint32(targetRef + 20, true);
  if (removedLength === 0) throw new Error('fixture payload selected for removal is absent');
  view.setUint32(targetRef + 8, 0, true);
  view.setUint32(targetRef + 12, 0, true);
  view.setUint32(targetRef + 20, 0, true);
  for (let index = nodeIndex + 1; index < nodeCount; index += 1) {
    const ref = refsOffset + index * 24;
    view.setUint32(ref + 16, view.getUint32(ref + 16, true) - removedLength, true);
  }
  const logicalBlob = value.subarray(blobOffset, blobOffset + blobCount);
  const replacement = new Uint8Array(blobCount - removedLength);
  replacement.set(logicalBlob.subarray(0, removedOffset));
  replacement.set(
    logicalBlob.subarray(removedOffset + removedLength),
    removedOffset,
  );
  return replaceBootstrapSection(value, blobIndex, pad4(replacement), replacement.byteLength);
}

function replaceBootstrapSection(source, sectionIndex, replacement, recordCount = null) {
  const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const entry = 96 + sectionIndex * 20;
  const oldOffset = sourceView.getUint32(entry + 8, true);
  const oldLength = sourceView.getUint32(entry + 12, true);
  const delta = replacement.byteLength - oldLength;
  const result = new Uint8Array(source.byteLength + delta);
  result.set(source.subarray(0, oldOffset));
  result.set(replacement, oldOffset);
  result.set(source.subarray(oldOffset + oldLength), oldOffset + replacement.byteLength);
  const view = new DataView(result.buffer);
  if (recordCount != null) view.setUint32(entry + 4, recordCount, true);
  view.setUint32(entry + 12, replacement.byteLength, true);
  for (let index = sectionIndex + 1; index < 11; index += 1) {
    const following = 96 + index * 20;
    view.setUint32(following + 8, view.getUint32(following + 8, true) + delta, true);
  }
  view.setUint32(44, view.getUint32(44, true) + delta, true);
  result.set(createHash('sha256').update(result.subarray(96)).digest(), 48);
  return result;
}

function pad4(value) {
  const result = new Uint8Array((value.byteLength + 3) & ~3);
  result.set(value);
  return result;
}
