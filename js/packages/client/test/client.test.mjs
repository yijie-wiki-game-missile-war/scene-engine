import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as publicApi from '../src/index.js';
import { applyJsonPatch } from '../src/json-tree.js';

const {
  DEFAULT_ENGINE_LIMITS,
  SceneEngineClient,
  encodeEngineInput,
  readEnginePacket,
} = publicApi;
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

test('default wire budget covers one 500-node checkpoint attachment', () => {
  assert.equal(DEFAULT_ENGINE_LIMITS.maximumPacketBytes, 64 * 1024 * 1024);
  assert.equal(DEFAULT_ENGINE_LIMITS.maximumAttachmentBytes, 48 * 1024 * 1024);
  assert.equal(DEFAULT_ENGINE_LIMITS.maximumSessionPendingBytes, 64 * 1024 * 1024);
});

test('root export surface is the frozen 0.6 allowlist', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'DEFAULT_ENGINE_LIMITS',
    'SceneEngineClient',
    'SceneEngineClientError',
    'encodeEngineAck',
    'encodeEngineInput',
    'readEnginePacket',
    'readPacketLog',
  ]);
});

test('decodes Python packets including finite float lexical boundaries', async () => {
  const packet = readEnginePacket(await fixture('checkpoint.bin'));
  const world = packet.attachments[0].value;
  assert.equal(packet.kind, 'engine.checkpoint');
  assert.equal(world.meta.one, 1);
  assert.equal(world.meta.small, 1e-7);
  assert.equal(world.meta.large, 1e20);
  assert.equal(Object.is(world.meta.negative_zero, -0), true);
  for (const name of [
    'wrong-magic.bin', 'truncated.bin', 'trailing.bin', 'unsafe-integer.bin', 'nonfinite.bin',
  ]) {
    assert.throws(() => readEnginePacket(awaitFixtureSyncError(name)));
  }
});

test('checkpoint and commits install world, sole tree, and cursor atomically', async () => {
  const observations = [];
  const client = new SceneEngineClient({ onCommit(value) { observations.push(value); } });
  const first = client.applyPacket(await fixture('checkpoint.bin'));
  assert.deepEqual(first.commit, {
    kind: 'checkpoint',
    streamId: '00000000-0000-4000-8000-000000000001',
    commitSeq: 0,
    sourceTick: 0,
    worldRevision: 0,
    cause: null,
    causationId: null,
  });
  assert.equal(readEnginePacket(first.ackPacket).kind, 'engine.ack');
  assert.equal(first.inputResult, null);
  const checkpointWorld = client.currentWorldState();
  const stable = checkpointWorld.state.stable;
  const view0 = client.currentView();
  assert.equal(view0.visualTypeCount, 1);
  assert.equal(view0.visualTypeAt(0).visualTypeId, 1);
  assert.equal(view0.getNode(1n).localPosition[0], 0);

  const tick = client.applyPacket(await fixture('commit-tick.bin'));
  assert.equal(tick.commit.kind, 'commit');
  assert.equal(tick.commit.cause, 'tick');
  assert.strictEqual(client.currentWorldState().state.stable, stable);
  const items = client.currentWorldState().state.items;
  assert.equal(client.currentView().getNode(1n).localPosition[0], 1.5);

  const input = client.applyPacket(await fixture('commit-input.bin'));
  assert.equal(input.commit.sourceTick, 1);
  assert.equal(input.commit.causationId, 'client-a:1');
  assert.strictEqual(client.currentWorldState().state.items, items);
  assert.notStrictEqual(client.currentWorldState().state.stable, stable);
  assert.equal(Object.isFrozen(client.currentWorldState().state.stable), true);
  await Promise.resolve();
  assert.deepEqual(observations.map(({ kind, commit, plan }) => [
    kind, commit.kind, plan?.kind ?? null,
  ]), [
    ['checkpoint', 'checkpoint', 'bootstrap'],
    ['commit', 'commit', 'frame'],
    ['commit', 'commit', null],
  ]);
  assert.deepEqual(observations[0].events, []);
  assert.equal(observations[1].events[0].eventId, 1n);
  assert.deepEqual(observations[2].events, []);
  for (const observation of observations) {
    assert.equal(Object.isFrozen(observation.events), true);
    assert.equal('product' in observation.events, false);
    assert.equal('scene' in observation.events, false);
  }
});

test('removed attachment kind 5 fails closed without a compatibility decoder', async () => {
  const raw = (await fixture('commit-input.bin')).slice();
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLength = view.getUint32(8, true);
  raw[16 + headerLength] = 5;
  assert.throws(
    () => readEnginePacket(raw),
    (error) => error.code === 'attachment-kind-or-encoding-unknown',
  );
});

test('a gap fails closed without changing any installed pointer', async () => {
  const client = new SceneEngineClient();
  client.applyPacket(await fixture('checkpoint.bin'));
  const before = client.capture();
  assert.throws(
    () => client.applyPacket(awaitFixtureSyncError('commit-input.bin')),
    (error) => error.code === 'commit-sequence-gap',
  );
  const after = client.capture();
  assert.strictEqual(after.worldState, before.worldState);
  assert.strictEqual(after.view, before.view);
  assert.strictEqual(after.commit, before.commit);
  assert.throws(() => client.applyPacket(awaitFixtureSyncError('commit-tick.bin')),
    (error) => error.code === 'client-failed');
});

test('input encoding observes the installed cursor and normalizes JS negative zero', async () => {
  const client = new SceneEngineClient();
  client.applyPacket(await fixture('checkpoint.bin'));
  const raw = client.encodeInput({
    inputId: 'browser:1',
    command: 'example.set',
    args: { finite: 1.5, large: 1e20, negativeZero: -0, small: 1e-7 },
  });
  const packet = readEnginePacket(raw);
  assert.equal(packet.header.observed_commit_seq, 0);
  assert.equal(packet.header.observed_stream_id, client.currentCommit().streamId);
  assert.equal(packet.attachments[0].value.large, 1e20);
  assert.equal(Object.is(packet.attachments[0].value.negativeZero, -0), false);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => encodeEngineInput({
      inputId: 'browser:bad',
      observedStreamId: client.currentCommit().streamId,
      observedCommitSeq: 0,
      command: 'bad',
      args: { value },
    }));
  }
});

test('input_result has no commit side effect and observer failures are isolated', async () => {
  const client = new SceneEngineClient({ onCommit() { throw new Error('renderer failed'); } });
  client.applyPacket(await fixture('checkpoint.bin'));
  const before = client.currentCommit();
  const result = client.applyPacket(await fixture('input-result.bin'));
  assert.equal(result.kind, 'input_result');
  assert.equal(result.ackPacket, null);
  assert.strictEqual(result.commit, before);
  assert.deepEqual(result.inputResult, {
    inputId: 'client-a:2', status: 'no-op', reasonCode: 'unchanged', result: { value: 1 },
  });
  await Promise.resolve();
  assert.strictEqual(client.currentCommit(), before);
});

test('the first server state packet must be a checkpoint', () => {
  const client = new SceneEngineClient();
  assert.throws(
    () => client.applyPacket(awaitFixtureSyncError('input-result.bin')),
    (error) => error.code === 'checkpoint-required',
  );
});

test('array sibling changes use simultaneous original indices', () => {
  const limits = {
    maximumJsonDepth: 256,
    maximumJsonPathSegments: 32,
    maximumWorldPatchChanges: 4096,
  };
  const root = Object.freeze({ items: Object.freeze([0, 1, 2, 3]) });
  const removed = applyJsonPatch(root, {
    schema: 'scene-engine-json-tree@1',
    changes: [
      { op: 'unset', path: ['items', 0] },
      { op: 'unset', path: ['items', 2] },
    ],
  }, limits);
  assert.deepEqual(removed.items, [1, 3]);
  const mixed = applyJsonPatch(root, {
    schema: 'scene-engine-json-tree@1',
    changes: [
      { op: 'set', path: ['items', 0], value: 9 },
      { op: 'unset', path: ['items', 2] },
    ],
  }, limits);
  assert.deepEqual(mixed.items, [9, 1, 3]);
});

async function fixture(name) {
  return new Uint8Array(await readFile(`${ROOT}/fixtures/wire-v1/${name}`));
}

function awaitFixtureSyncError(name) {
  // Tests calling a synchronous API need already-owned bytes; all fixtures are
  // small and loaded with Node's sync path only inside this helper.
  return globalFixture(name);
}

function globalFixture(name) {
  const path = `${ROOT}/fixtures/wire-v1/${name}`;
  return new Uint8Array(requireRead(path));
}

import { readFileSync as requireRead } from 'node:fs';
