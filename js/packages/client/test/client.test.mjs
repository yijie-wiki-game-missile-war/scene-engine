import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as publicApi from '../src/index.js';
import { applyJsonPatch } from '../src/json-tree.js';
import { encodePacket } from '../src/wire.js';
import {
  HASH_A,
  STREAM_ID,
  WORLD_CODEC,
  baselineNode,
  checkpointPacket,
  command,
  commitPacket,
  createMockDisplayFactory,
  transform,
} from './support.mjs';

const {
  DEFAULT_ENGINE_LIMITS,
  SceneEngineClient,
  encodeEngineInput,
  readEnginePacket,
} = publicApi;
const FIXTURES = fileURLToPath(new URL('../fixtures/wire-v2/', import.meta.url));
const PYTHON_FIXTURES = fileURLToPath(new URL('../../../../fixtures/wire-v2/', import.meta.url));

test('root export surface is the breaking 0.7 allowlist', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'DEFAULT_ENGINE_LIMITS',
    'SceneEngineClient',
    'SceneEngineClientError',
    'encodeEngineAck',
    'encodeEngineInput',
    'readEnginePacket',
    'readPacketLog',
  ]);
  assert.equal('maximumDisplayCommands' in DEFAULT_ENGINE_LIMITS, false);
  assert.equal('maximumNodeStateBytes' in DEFAULT_ENGINE_LIMITS, false);
});

test('wire v2 fixture has JSON display checkpoint and ACK command cursor', async () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  const raw = new Uint8Array(await readFile(`${FIXTURES}/checkpoint.bin`));
  const decoded = readEnginePacket(raw);
  assert.equal(decoded.header.schema, 'scene-engine-wire@2');
  assert.equal(decoded.header.display_codec, 'scene-engine-display-node@2');
  assert.deepEqual(decoded.attachments.map(({ kind, encoding }) => [kind, encoding]), [
    ['world_snapshot', 'json'],
    ['display_checkpoint', 'json'],
  ]);

  const result = client.applyPacket(raw);
  const ack = readEnginePacket(result.ackPacket);
  assert.equal(ack.header.last_command_seq, 0);
  assert.deepEqual(client.currentDisplayView(), { sessionId: 1 });
  assert.equal(sessions[0].metadata.sceneCatalogHash, HASH_A);
  assert.deepEqual(sessions[0].log.map(([kind]) => kind), [
    'installScene', 'createNode', 'activate', 'start',
  ]);
  assert.deepEqual(sessions[0].log[0][1], { sceneName: 'main' });
  assert.deepEqual(sessions[0].log[2][1], {
    commitSeq: 0, sourceTick: 0, lastCommandSeq: 0,
  });
  assert.deepEqual(Object.keys(sessions[0].log[1][1]), [
    'name', 'parentName', 'prefabType', 'transformMode', 'transform', 'visible', 'state',
  ]);
  assert.equal('currentView' in client, false);
  assert.equal('getNode' in client, false);
  assert.equal('getWorldPose' in client, false);
});

test('applies canonical Python wire@2 fixtures through exact Authority payloads', async () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  const checkpoint = client.applyPacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/checkpoint.bin`),
  ));
  const tick = client.applyPacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/commit-tick.bin`),
  ));
  const input = client.applyPacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/commit-input.bin`),
  ));
  assert.deepEqual([
    checkpoint.commit.lastCommandSeq,
    tick.commit.lastCommandSeq,
    input.commit.lastCommandSeq,
  ], [0, 7, 7]);
  assert.deepEqual(sessions[0].log.map(([kind]) => kind), [
    'installScene', 'createNode', 'createNode', 'activate', 'start',
    'begin', 'createNode', 'setNodeTransform', 'setNodeParent', 'setNodeVisible',
    'setNodeState', 'replaceNodePrefab', 'removeNode', 'seal',
    'begin', 'seal',
  ]);
  assert.equal(client.currentWorldState().state.stable.value, 8);
});

test('checkpoint fresh session swaps only after complete synchronous activation', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const firstView = client.currentDisplayView();

  client.applyPacket(checkpointPacket({
    commitSeq: 3,
    sourceTick: 3,
    worldRevision: 3,
    lastCommandSeq: 2,
    worldSnapshot: { tick: 3, world_revision: 3, value: 9 },
  }));

  assert.notStrictEqual(client.currentDisplayView(), firstView);
  assert.deepEqual(client.currentDisplayView(), { sessionId: 2 });
  assert.equal(sessions[0].log.at(-1)[0], 'dispose');
  assert.equal(sessions[1].log.some(([kind]) => kind === 'dispose'), false);
  assert.equal(client.currentCommit().lastCommandSeq, 2);
});

test('commit validates all commands then applies one Authority call per target before seal', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const observations = [];
  const client = new SceneEngineClient({
    createDisplaySession: factory,
    onCommit: (value) => observations.push(value),
  });
  client.applyPacket(checkpointPacket());
  const commands = [
    command('node-create', 1, 1, {
      name: 'py/unit-2',
      parent_name: null,
      prefab_type: 'unit.example',
      transform_mode: 'live',
      transform: transform(2),
      visible: true,
      state: { mode: 'new' },
    }),
    command('node-set-transform', 2, 1, { transform: transform(3) }),
    command('node-set-parent', 3, 1, { parent_name: 'py/unit-2' }),
    command('node-set-visible', 4, 1, { visible: false }),
    command('node-set-state', 5, 1, { state: { mode: 'active' } }),
    command('node-replace-prefab', 6, 1, {
      prefab_type: 'unit.variant', state: { variant: 2 },
    }),
    command('node-remove', 7, 1),
  ];
  const result = client.applyPacket(commitPacket({ commands }));
  const ack = readEnginePacket(result.ackPacket);
  assert.equal(ack.header.last_command_seq, 7);
  assert.equal(client.currentCommit().lastCommandSeq, 7);
  assert.deepEqual(sessions[0].log.slice(4).map(([kind]) => kind), [
    'begin', 'createNode', 'setNodeTransform', 'setNodeParent', 'setNodeVisible',
    'setNodeState', 'replaceNodePrefab', 'removeNode', 'seal',
  ]);
  const transformRecord = sessions[0].log.find(([kind]) => kind === 'setNodeTransform')[1];
  assert.deepEqual(transformRecord.transform.rotationXyzw, [0, 0, 0, 1]);
  assert.deepEqual(Object.keys(transformRecord), ['name', 'transform']);
  assert.equal(Object.isFrozen(transformRecord), true);
});

test('empty command stream still seals and ACKs while preserving command cursor', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket({ lastCommandSeq: 4 }));
  const result = client.applyPacket(commitPacket({
    baseCommandSeq: 4,
    commands: [],
  }));
  assert.equal(readEnginePacket(result.ackPacket).header.last_command_seq, 4);
  assert.deepEqual(sessions[0].log.slice(4).map(([kind]) => kind), ['begin', 'seal']);
  assert.equal(client.currentWorldState().tick, 1);
});

test('invalid sequence fails before draw gate and leaves installed pointers unchanged', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const before = client.capture();
  const raw = commitPacket({
    commands: [command('node-set-visible', 2, 1, { visible: false })],
  });
  assert.throws(
    () => client.applyPacket(raw),
    (error) => error.code === 'display-command-sequence-invalid',
  );
  const after = client.capture();
  assert.strictEqual(after.commit, before.commit);
  assert.strictEqual(after.worldState, before.worldState);
  assert.equal(sessions[0].log.slice(4).length, 0);
  assert.throws(() => client.applyPacket(raw), (error) => error.code === 'client-failed');
});

test('validates the entire command stream before the first Authority mutation', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const raw = commitPacket({
    commands: [
      command('node-set-visible', 1, 1, { visible: false }),
      command('node-set-state', 2, 2, { state: { mode: 'wrong-tick' } }),
    ],
  });
  assert.throws(
    () => client.applyPacket(raw),
    (error) => error.code === 'display-command-source-tick-mismatch',
  );
  assert.equal(sessions[0].log.length, 4);
});

test('Authority failure calls gate.fail, emits no ACK, and makes client terminal', () => {
  const { factory, sessions } = createMockDisplayFactory({ failMethod: 'setNodeState' });
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const before = client.capture();
  let thrown;
  try {
    client.applyPacket(commitPacket({
      commands: [command('node-set-state', 1, 1, { state: { mode: 'bad' } })],
    }));
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.code, 'packet-apply-failed');
  assert.deepEqual(sessions[0].log.slice(4).map(([kind]) => kind), [
    'begin', 'setNodeState', 'fail',
  ]);
  assert.equal(sessions[0].log.at(-1)[1].message, 'failed:setNodeState');
  assert.strictEqual(client.currentCommit(), before.commit);
  assert.strictEqual(client.currentWorldState(), before.worldState);
  assert.throws(
    () => client.applyPacket(commitPacket()),
    (error) => error.code === 'client-failed',
  );
});

test('Promise-returning Authority operation is a synchronous barrier failure', () => {
  const { factory, sessions } = createMockDisplayFactory({ asyncMethod: 'setNodeVisible' });
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  assert.throws(
    () => client.applyPacket(commitPacket({
      commands: [command('node-set-visible', 1, 1, { visible: false })],
    })),
    (error) => error.code === 'authority-operation-async',
  );
  assert.equal(sessions[0].log.at(-1)[0], 'fail');
});

test('failed replacement checkpoint disposes only candidate and does not swap old display', () => {
  const first = createMockDisplayFactory();
  const failing = createMockDisplayFactory({ failMethod: 'createNode' });
  let calls = 0;
  const client = new SceneEngineClient({
    createDisplaySession(metadata) {
      calls += 1;
      return calls === 1 ? first.factory(metadata) : failing.factory(metadata);
    },
  });
  client.applyPacket(checkpointPacket());
  const oldView = client.currentDisplayView();
  assert.throws(() => client.applyPacket(checkpointPacket({
    commitSeq: 2, sourceTick: 2, worldRevision: 2,
  })));
  assert.strictEqual(client.currentDisplayView(), oldView);
  assert.equal(first.sessions[0].log.some(([kind]) => kind === 'dispose'), false);
  assert.equal(failing.sessions[0].log.at(-1)[0], 'dispose');
});

test('input observes commit cursor and input_result has no state side effect', () => {
  const { factory } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const raw = client.encodeInput({
    inputId: 'browser:1', command: 'example.set', args: { negativeZero: -0 },
  });
  const input = readEnginePacket(raw);
  assert.equal(input.header.observed_commit_seq, 0);
  assert.equal(input.header.observed_stream_id, STREAM_ID);
  assert.equal(Object.is(input.attachments[0].value.negativeZero, -0), false);

  const before = client.currentCommit();
  const resultPacket = encodePacket('engine.input_result', {
    schema: 'scene-engine-wire@2',
    type: 'engine.input_result',
    input_id: 'browser:1',
    status: 'no-op',
    reason_code: 'unchanged',
  }, [{ kind: 'result_payload', encoding: 'json', value: { value: 1 } }]);
  const result = client.applyPacket(resultPacket);
  assert.equal(result.ackPacket, null);
  assert.strictEqual(client.currentCommit(), before);
  assert.deepEqual(result.inputResult, {
    inputId: 'browser:1', status: 'no-op', reasonCode: 'unchanged', result: { value: 1 },
  });
});

test('v1 packet fails closed without a compatibility decoder', async () => {
  const v2 = new Uint8Array(await readFile(`${FIXTURES}/checkpoint.bin`));
  const v1 = v2.slice();
  v1[4] = 1;
  assert.throws(
    () => readEnginePacket(v1),
    (error) => error.code === 'packet-version-invalid',
  );
});

test('array sibling changes retain simultaneous original-index semantics', () => {
  const limits = {
    maximumJsonDepth: 256,
    maximumJsonPathSegments: 32,
    maximumWorldPatchChanges: 4096,
  };
  const root = Object.freeze({ items: Object.freeze([0, 1, 2, 3]) });
  const result = applyJsonPatch(root, {
    schema: 'scene-engine-json-tree@1',
    changes: [
      { op: 'unset', path: ['items', 0] },
      { op: 'unset', path: ['items', 2] },
    ],
  }, limits);
  assert.deepEqual(result.items, [1, 3]);
});

test('constructor rejects missing display session factory', () => {
  assert.throws(
    () => new SceneEngineClient(),
    (error) => error.code === 'client-display-session-factory-invalid',
  );
  assert.throws(() => encodeEngineInput({
    inputId: 'bad', observedStreamId: STREAM_ID, observedCommitSeq: 0,
    command: 'bad', args: { value: NaN },
  }));
  assert.equal(WORLD_CODEC, 'example-world@2');
  assert.equal(baselineNode().name, 'py/unit-1');
});
