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
const FIXTURES = fileURLToPath(new URL('../fixtures/wire-v3/', import.meta.url));
const PYTHON_FIXTURES = fileURLToPath(new URL('../../../../fixtures/wire-v3/', import.meta.url));
const DISPLAY_STREAM_MAGIC = new TextEncoder().encode('SDCS');

function corruptDisplayStreamU64(raw, relativeOffset, value) {
  const result = raw.slice();
  let payloadOffset = -1;
  outer: for (let offset = 0; offset <= result.length - DISPLAY_STREAM_MAGIC.length; offset += 1) {
    for (let index = 0; index < DISPLAY_STREAM_MAGIC.length; index += 1) {
      if (result[offset + index] !== DISPLAY_STREAM_MAGIC[index]) continue outer;
    }
    payloadOffset = offset;
    break;
  }
  assert.notEqual(payloadOffset, -1);
  new DataView(result.buffer, result.byteOffset, result.byteLength)
    .setBigUint64(payloadOffset + relativeOffset, BigInt(value), true);
  return result;
}

test('root export surface remains the exact client allowlist', () => {
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

test('client package and Display codec versions are the frozen matrix-native release', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(packageJson.version, '0.13.0');
  assert.throws(() => encodePacket('engine.checkpoint', {
    schema: 'scene-engine-wire@3',
    type: 'engine.checkpoint',
    stream_id: STREAM_ID,
    commit_seq: 0,
    source_tick: 0,
    world_revision: 0,
    last_command_seq: 0,
    world_codec: WORLD_CODEC,
    display_codec: 'scene-engine-display-node@5',
  }), (error) => error.code === 'display-codec-unsupported');
});

test('wire v3 fixture has binary display checkpoint and ACK command cursor', async () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  const raw = new Uint8Array(await readFile(`${FIXTURES}/checkpoint.bin`));
  const decoded = readEnginePacket(raw);
  assert.equal(decoded.header.schema, 'scene-engine-wire@3');
  assert.equal(decoded.header.display_codec, 'scene-engine-display-node@6');
  assert.deepEqual(decoded.attachments.map(({ kind, encoding }) => [kind, encoding]), [
    ['world_snapshot', 'json'],
    ['display_checkpoint', 'raw'],
  ]);

  const result = client.applyPacket(raw);
  const ack = readEnginePacket(result.ackPacket);
  const identity = JSON.parse(await readFile(new URL(
    '../../../../fixtures/display-catalog-v2/identity.json', import.meta.url,
  )));
  assert.equal(ack.header.last_command_seq, 0);
  assert.deepEqual(client.currentDisplayView(), { sessionId: 1 });
  assert.deepEqual({
    scene_catalog_hash: sessions[0].metadata.sceneCatalogHash,
    prefab_catalog_hash: sessions[0].metadata.prefabCatalogHash,
    state_schema_hash: sessions[0].metadata.stateSchemaHash,
  }, identity);
  assert.deepEqual(sessions[0].log.map(([kind]) => kind), [
    'installScene', 'installNodeMatrixPool', 'createNode', 'createNode', 'createNode',
    'activate', 'start', 'summary',
  ]);
  assert.deepEqual(sessions[0].log[0][1], { sceneName: 'main' });
  assert.deepEqual(sessions[0].log.find(([kind]) => kind === 'activate')[1], {
    commitSeq: 0, sourceTick: 0, lastCommandSeq: 0,
  });
  assert.deepEqual(Object.keys(sessions[0].log.find(([kind]) => kind === 'createNode')[1]), [
    'nodeId', 'parentNodeId', 'prefabId', 'transformMode', 'visible', 'state',
  ]);
  assert.equal('currentView' in client, false);
  assert.equal('getNode' in client, false);
  assert.equal('getWorldPose' in client, false);
});

test('packaged wire v3 fixtures are exact copies of the canonical generated corpus', async () => {
  for (const name of [
    'checkpoint.bin',
    'commit-tick.bin',
    'commit-input.bin',
    'input.bin',
    'ack.bin',
    'input-result.bin',
  ]) {
    assert.deepEqual(
      new Uint8Array(await readFile(`${FIXTURES}/${name}`)),
      new Uint8Array(await readFile(`${PYTHON_FIXTURES}/${name}`)),
      name,
    );
  }
});

test('Authority takes one packet-independent matrix pool tensor and preserves shear exactly', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  const shear = new Float32Array([
    2, 0.25, 0, 0,
    0.5, 3, 0.75, 0,
    0, 0.5, 4, 0,
    7, 8, 9, 1,
  ]);
  const raw = checkpointPacket({
    matrixPool: shear,
  });
  client.applyPacket(raw);
  const authorityPool = sessions[0].log.find(([kind]) => kind === 'installNodeMatrixPool')[1]
    .matrices;
  assert.ok(authorityPool instanceof Float32Array);
  assert.deepEqual(authorityPool, shear);
  assert.notStrictEqual(authorityPool, shear);
  assert.notStrictEqual(authorityPool.buffer, raw.buffer);
  raw.fill(0);
  assert.deepEqual(authorityPool, shear);
});

test('applies canonical Python wire@3 fixtures through exact Authority payloads', async () => {
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
    'installScene', 'installNodeMatrixPool', 'createNode', 'createNode', 'createNode',
    'activate', 'start', 'summary',
    'begin', 'applyNodeTransformBatch', 'createNode', 'setNodeTransform',
    'setNodeParent', 'setNodeVisible',
    'setNodeState', 'replaceNodePrefab', 'removeNode', 'seal', 'summary',
    'begin', 'applyNodeTransformBatch', 'seal', 'summary',
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

test('same-stream checkpoints cannot shrink the matrix pool or resurrect retired IDs', () => {
  const shrink = new SceneEngineClient({ createDisplaySession: createMockDisplayFactory().factory });
  shrink.applyPacket(checkpointPacket({
    nodes: [baselineNode(0)],
    matrixPoolSize: 2,
  }));
  assert.throws(() => shrink.applyPacket(checkpointPacket({
    commitSeq: 1,
    sourceTick: 1,
    worldRevision: 1,
    matrixPoolSize: 1,
  })), (error) => error.code === 'display-matrix-pool-progression-invalid');

  const resurrect = new SceneEngineClient({
    createDisplaySession: createMockDisplayFactory().factory,
  });
  resurrect.applyPacket(checkpointPacket({
    nodes: [baselineNode(0)],
    matrixPoolSize: 2,
  }));
  assert.throws(() => resurrect.applyPacket(checkpointPacket({
    commitSeq: 1,
    sourceTick: 1,
    worldRevision: 1,
    nodes: [baselineNode(0), baselineNode(1)],
    matrixPoolSize: 2,
  })), (error) => error.code === 'display-matrix-pool-progression-invalid');

  const removed = new SceneEngineClient({
    createDisplaySession: createMockDisplayFactory().factory,
  });
  removed.applyPacket(checkpointPacket({
    nodes: [baselineNode(0), baselineNode(1)],
    matrixPoolSize: 2,
  }));
  removed.applyPacket(commitPacket({
    commands: [command('node-remove', 1, 1, { node_id: 1 })],
    matrixPoolSize: 2,
  }));
  assert.throws(() => removed.applyPacket(checkpointPacket({
    commitSeq: 2,
    sourceTick: 2,
    worldRevision: 2,
    lastCommandSeq: 1,
    nodes: [baselineNode(0), baselineNode(1)],
    matrixPoolSize: 2,
  })), (error) => error.code === 'display-matrix-pool-progression-invalid');
});

test('checkpoint factory reentry cannot overwrite progression even when it swallows the error', () => {
  const mock = createMockDisplayFactory();
  let client;
  let factoryCalls = 0;
  let nestedError = null;
  client = new SceneEngineClient({
    createDisplaySession(metadata) {
      factoryCalls += 1;
      if (factoryCalls === 2) {
        try {
          client.applyPacket(checkpointPacket({
            commitSeq: 3,
            sourceTick: 3,
            worldRevision: 3,
          }));
        } catch (error) {
          nestedError = error;
        }
      }
      return mock.factory(metadata);
    },
  });
  client.applyPacket(checkpointPacket());
  const acknowledged = client.currentCommit();

  assert.throws(() => client.applyPacket(checkpointPacket({
    commitSeq: 2,
    sourceTick: 2,
    worldRevision: 2,
  })), (error) => error.code === 'client-apply-reentrant');
  assert.equal(nestedError?.code, 'client-apply-reentrant');
  assert.strictEqual(client.currentCommit(), acknowledged);
  assert.equal(mock.sessions[0].log.some(([kind]) => kind === 'dispose'), false);
  assert.equal(mock.sessions[1].log.at(-1)[0], 'dispose');
  assert.throws(() => client.applyPacket(checkpointPacket()),
    (error) => error.code === 'client-failed');
});

test('Authority and gate callback reentry cannot commit a stale outer packet', () => {
  for (const [owner, method] of [
    ['authorityPort', 'applyNodeTransformBatch'],
    ['commitGate', 'seal'],
  ]) {
    const mock = createMockDisplayFactory();
    const client = new SceneEngineClient({ createDisplaySession: mock.factory });
    client.applyPacket(checkpointPacket());
    const acknowledged = client.currentCommit();
    const receiver = mock.sessions[0].session[owner];
    const original = receiver[method];
    let nestedError = null;
    receiver[method] = function reentrantCallback(...args) {
      try {
        client.applyPacket(checkpointPacket({
          commitSeq: 3,
          sourceTick: 3,
          worldRevision: 3,
        }));
      } catch (error) {
        nestedError = error;
      }
      return original.apply(this, args);
    };

    assert.throws(() => client.applyPacket(commitPacket()),
      (error) => error.code === 'client-apply-reentrant', `${owner}.${method}`);
    assert.equal(nestedError?.code, 'client-apply-reentrant', `${owner}.${method}`);
    assert.strictEqual(client.currentCommit(), acknowledged, `${owner}.${method}`);
    assert.equal(mock.sessions[0].log.at(-1)[0], 'fail', `${owner}.${method}`);
    assert.throws(() => client.applyPacket(commitPacket()),
      (error) => error.code === 'client-failed', `${owner}.${method}`);
  }
});

test('post-swap disposal rejects reentry without rolling back or poisoning replacement', () => {
  const mock = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: mock.factory });
  client.applyPacket(checkpointPacket());
  const originalDispose = mock.sessions[0].session.dispose;
  let nestedError = null;
  mock.sessions[0].session.dispose = function reentrantDispose() {
    try {
      client.applyPacket(checkpointPacket({
        commitSeq: 3,
        sourceTick: 3,
        worldRevision: 3,
      }));
    } catch (error) {
      nestedError = error;
    }
    return originalDispose.call(this);
  };

  const replacement = client.applyPacket(checkpointPacket({
    commitSeq: 2,
    sourceTick: 2,
    worldRevision: 2,
  }));
  assert.ok(replacement.ackPacket instanceof Uint8Array);
  assert.equal(nestedError?.code, 'client-apply-reentrant');
  assert.equal(client.currentCommit().commitSeq, 2);
  assert.equal(mock.sessions[0].log.at(-1)[0], 'dispose');
  assert.equal(mock.sessions[1].log.some(([kind]) => kind === 'dispose'), false);

  const next = client.applyPacket(commitPacket({
    commitSeq: 3,
    sourceTick: 3,
    worldRevision: 3,
  }));
  assert.ok(next.ackPacket instanceof Uint8Array);
  assert.equal(client.currentCommit().commitSeq, 3);
});

test('checkpoint and commit observers receive only immutable summary payloads after ACK', async () => {
  const { factory, sessions } = createMockDisplayFactory();
  const observations = [];
  const client = new SceneEngineClient({
    createDisplaySession: factory,
    onCommit: (payload) => observations.push(payload),
  });

  const checkpoint = client.applyPacket(checkpointPacket());
  const commit = client.applyPacket(commitPacket({
    commands: [command('node-set-transform', 1, 1, { matrix: transform(2) })],
  }));

  assert.ok(checkpoint.ackPacket instanceof Uint8Array);
  assert.ok(commit.ackPacket instanceof Uint8Array);
  assert.equal(observations.length, 0);
  assert.equal(sessions[0].metrics.currentViewCalls, 0);
  await Promise.resolve();

  assert.equal(observations.length, 2);
  for (const payload of observations) {
    assert.deepEqual(Object.keys(payload), [
      'kind', 'commit', 'worldState', 'displaySummary',
    ]);
    assert.equal(Object.isFrozen(payload), true);
    assert.equal('displayView' in payload, false);
    assert.equal(['get', 'Display', 'View'].join('') in payload, false);
  }
  assert.equal(observations[0].kind, 'checkpoint');
  assert.equal(observations[0].worldState.tick, 0);
  assert.equal(observations[0].displaySummary.cursor.commitSeq, 0);
  assert.equal(observations[1].kind, 'commit');
  assert.equal(observations[1].worldState.tick, 1);
  assert.equal(observations[1].displaySummary.cursor.commitSeq, 1);
  assert.equal(sessions[0].metrics.summaryCalls, 2);
  assert.equal(sessions[0].metrics.currentViewCalls, 0);
});

test('currentDisplayView and capture explicitly materialize a full runtime view', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  assert.equal(sessions[0].metrics.currentViewCalls, 0);

  assert.strictEqual(client.currentDisplayView(), sessions[0].view);
  assert.equal(sessions[0].metrics.currentViewCalls, 1);
  const capture = client.capture();
  assert.strictEqual(capture.displayView, sessions[0].view);
  assert.equal(sessions[0].metrics.currentViewCalls, 2);
  assert.equal(sessions[0].metrics.summaryCalls, 1);
});

test('10,000 commits take summaries without materializing DisplayView', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());

  for (let commitSeq = 1; commitSeq <= 10_000; commitSeq += 1) {
    client.applyPacket(commitPacket({
      commitSeq,
      sourceTick: commitSeq,
      worldRevision: commitSeq,
      baseCommandSeq: commitSeq - 1,
      commands: [command('node-set-transform', commitSeq, commitSeq, {
        matrix: transform(commitSeq),
      })],
    }));
  }

  assert.equal(client.currentCommit().commitSeq, 10_000);
  assert.equal(sessions[0].metrics.summaryCalls, 10_001);
  assert.equal(sessions[0].metrics.currentViewCalls, 0);
});

test('observer exceptions do not withhold ACK or make the client fail', async () => {
  const { factory } = createMockDisplayFactory();
  let calls = 0;
  const client = new SceneEngineClient({
    createDisplaySession: factory,
    onCommit() {
      calls += 1;
      throw new Error('observer-failed');
    },
  });

  const checkpoint = client.applyPacket(checkpointPacket());
  const firstCommit = client.applyPacket(commitPacket());
  assert.ok(checkpoint.ackPacket instanceof Uint8Array);
  assert.ok(firstCommit.ackPacket instanceof Uint8Array);
  await Promise.resolve();
  assert.equal(calls, 2);

  const secondCommit = client.applyPacket(commitPacket({
    commitSeq: 2, sourceTick: 2, worldRevision: 2,
  }));
  assert.ok(secondCommit.ackPacket instanceof Uint8Array);
  assert.equal(client.currentCommit().commitSeq, 2);
  client.dispose();
});

test('commit stages one contiguous tensor then applies ID commands in order before seal', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const commands = [
    command('node-create', 1, 1, {
      node_id: 1,
      parent_node_id: null,
      prefab_id: 'unit.example',
      transform_mode: 'live',
      matrix: transform(2),
      visible: true,
      state: { mode: 'new' },
    }),
    command('node-set-transform', 2, 1, { matrix: transform(3) }),
    command('node-set-parent', 3, 1, { parent_node_id: 1 }),
    command('node-set-visible', 4, 1, { visible: false }),
    command('node-set-state', 5, 1, { state: { mode: 'active' } }),
    command('node-replace-prefab', 6, 1, {
      prefab_id: 'unit.variant/prefab@1', state: { variant: 2 },
    }),
    command('node-remove', 7, 1),
  ];
  const result = client.applyPacket(commitPacket({ commands, matrixPoolSize: 2 }));
  const ack = readEnginePacket(result.ackPacket);
  assert.equal(ack.header.last_command_seq, 7);
  assert.equal(client.currentCommit().lastCommandSeq, 7);
  assert.deepEqual(sessions[0].log.slice(6).map(([kind]) => kind), [
    'begin', 'applyNodeTransformBatch', 'createNode', 'setNodeTransform',
    'setNodeParent', 'setNodeVisible',
    'setNodeState', 'replaceNodePrefab', 'removeNode', 'seal', 'summary',
  ]);
  const batch = sessions[0].log.find(([kind]) => kind === 'applyNodeTransformBatch')[1];
  assert.deepEqual([...batch.nodeIds], [0, 1]);
  assert.deepEqual([...batch.matrices.slice(0, 16)], [...transform(3)]);
  assert.deepEqual([...batch.matrices.slice(16)], [...transform(2)]);
  const transformRecord = sessions[0].log.find(([kind]) => kind === 'setNodeTransform')[1];
  assert.deepEqual(transformRecord, { nodeId: 0 });
  assert.deepEqual(Object.keys(transformRecord), ['nodeId']);
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
  assert.deepEqual(sessions[0].log.slice(6).map(([kind]) => kind), [
    'begin', 'applyNodeTransformBatch', 'seal', 'summary',
  ]);
  assert.equal(client.currentWorldState().tick, 1);
});

test('matrix pool growth requires transmitted contiguous create rows before the draw gate', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const beforeLogLength = sessions[0].log.length;

  assert.throws(() => client.applyPacket(commitPacket({
    commands: [],
    matrixPoolSize: 0x10000000,
  })), (error) => error.code === 'display-matrix-pool-progression-invalid');
  assert.equal(sessions[0].log.length, beforeLogLength, 'invalid growth must not open the gate');
});

test('invalid binary command base fails before draw gate and leaves pointers unchanged', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const before = client.capture();
  const raw = corruptDisplayStreamU64(commitPacket({
    commands: [command('node-set-visible', 1, 1, { visible: false })],
  }), 8, 1);
  assert.throws(
    () => client.applyPacket(raw),
    (error) => error.code === 'display-command-base-mismatch',
  );
  const after = client.capture();
  assert.strictEqual(after.commit, before.commit);
  assert.strictEqual(after.worldState, before.worldState);
  assert.equal(sessions[0].log.slice(6).length, 0);
  assert.throws(() => client.applyPacket(raw), (error) => error.code === 'client-failed');
});

test('validates the binary source-tick seal before the first Authority mutation', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  const raw = corruptDisplayStreamU64(commitPacket({
    commands: [
      command('node-set-visible', 1, 1, { visible: false }),
      command('node-set-state', 2, 1, { state: { mode: 'wrong-tick' } }),
    ],
  }), 16, 2);
  assert.throws(
    () => client.applyPacket(raw),
    (error) => error.code === 'display-command-source-tick-mismatch',
  );
  assert.equal(sessions[0].log.length, 6);
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
  assert.deepEqual(sessions[0].log.slice(6).map(([kind]) => kind), [
    'begin', 'applyNodeTransformBatch', 'setNodeState', 'fail',
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

test('Promise-returning checkpoint summary fails closed and disposes the candidate', () => {
  const { factory, sessions } = createMockDisplayFactory({ asyncMethod: 'summary' });
  const client = new SceneEngineClient({ createDisplaySession: factory });
  assert.throws(
    () => client.applyPacket(checkpointPacket()),
    (error) => error.code === 'display-summary-async',
  );
  assert.deepEqual(sessions[0].log.map(([kind]) => kind), [
    'installScene', 'installNodeMatrixPool', 'createNode',
    'activate', 'start', 'summary', 'dispose',
  ]);
  assert.equal(client.currentDisplayView(), null);
  assert.throws(
    () => client.applyPacket(checkpointPacket()),
    (error) => error.code === 'client-failed',
  );
});

test('Promise-returning commit summary fails the gate and publishes no ACK', () => {
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpointPacket());
  sessions[0].session.runtime.summary = () => Promise.resolve();

  assert.throws(
    () => client.applyPacket(commitPacket()),
    (error) => error.code === 'display-summary-async',
  );
  assert.deepEqual(sessions[0].log.slice(6).map(([kind]) => kind), [
    'begin', 'applyNodeTransformBatch', 'seal', 'fail',
  ]);
  assert.equal(client.currentCommit().commitSeq, 1);
  assert.throws(
    () => client.applyPacket(commitPacket({
      commitSeq: 2, sourceTick: 2, worldRevision: 2,
    })),
    (error) => error.code === 'client-failed',
  );
});

test('display session accepts wrapper fields but extracts only the four required capabilities', () => {
  const extra = createMockDisplayFactory();
  const extraClient = new SceneEngineClient({
    createDisplaySession(metadata) {
      const session = extra.factory(metadata);
      return { ...session, diagnostics: () => ({ session: 'extra' }) };
    },
  });
  assert.ok(extraClient.applyPacket(checkpointPacket()).ackPacket instanceof Uint8Array);
  assert.equal(extra.sessions[0].log.some(([kind]) => kind === 'dispose'), false);

  const missing = createMockDisplayFactory();
  const missingClient = new SceneEngineClient({
    createDisplaySession(metadata) {
      const session = missing.factory(metadata);
      delete session.runtime.summary;
      return session;
    },
  });
  assert.throws(
    () => missingClient.applyPacket(checkpointPacket()),
    (error) => error.code === 'display-session-runtime-invalid',
  );
  assert.equal(missing.sessions[0].log.at(-1)[0], 'dispose');
});

test('checkpoint rejects a Display catalog identity mismatch before scene installation', () => {
  const mismatch = createMockDisplayFactory();
  const client = new SceneEngineClient({
    createDisplaySession(metadata) {
      const session = mismatch.factory(metadata);
      session.runtime.catalogIdentity = () => Object.freeze({
        sceneCatalogHash: 'f'.repeat(64),
        prefabCatalogHash: metadata.prefabCatalogHash,
        stateSchemaHash: metadata.stateSchemaHash,
      });
      return session;
    },
  });
  assert.throws(() => client.applyPacket(checkpointPacket()),
    (error) => error.code === 'display-catalog-identity-mismatch');
  assert.deepEqual(mismatch.sessions[0].log.map(([kind]) => kind), ['dispose']);
});

test('failed replacement checkpoint disposes only candidate and does not swap old display', () => {
  const first = createMockDisplayFactory();
  const failing = createMockDisplayFactory({ failMethod: 'summary' });
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
    schema: 'scene-engine-wire@3',
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

test('v2 packet fails closed without a compatibility decoder', async () => {
  const v3 = new Uint8Array(await readFile(`${FIXTURES}/checkpoint.bin`));
  const v2 = v3.slice();
  v2[4] = 2;
  assert.throws(
    () => readEnginePacket(v2),
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
  assert.equal(baselineNode().node_id, 0);
});
