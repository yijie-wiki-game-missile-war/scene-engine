import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthorityMatrixPool } from '../src/runtime/authority-matrix-pool.js';
import {
  IDENTITY,
  commitAuthority,
  createHarness,
  emptyPrefab,
  matrixPosition,
  matrixTransform,
} from './helpers.mjs';

function matrixPool(size, entries) {
  const matrices = new Float32Array(size * 16);
  for (const [nodeId, matrix] of entries) matrices.set(matrix, nodeId * 16);
  return matrices;
}

function matrixBatch(entries) {
  const nodeIds = new Uint32Array(entries.map(([nodeId]) => nodeId));
  const matrices = new Float32Array(entries.length * 16);
  entries.forEach(([, matrix], index) => matrices.set(matrix, index * 16));
  return { nodeIds, matrices };
}

function createCommand(nodeId, parentNodeId = null, overrides = {}) {
  return {
    nodeId,
    parentNodeId,
    displayKindId: 'target.test.item',
    transformMode: 'live',
    visible: true,
    state: {},
    ...overrides,
  };
}

test('AuthorityMatrixPool stages one owned sparse batch and consumes rows in command order', () => {
  const pool = new AuthorityMatrixPool();
  const checkpointOwner = matrixPool(3, [[0, IDENTITY]]);
  pool.install({ poolSize: 3, matrices: checkpointOwner });
  pool.claim(0);
  pool.assertSettled();
  assert.strictEqual(pool.matrix(0).buffer, checkpointOwner.buffer);

  const moved = matrixTransform({ position: [4, 5, 6] });
  const batch = matrixBatch([[0, moved], [3, IDENTITY]]);
  pool.applyBatch({ poolSize: 4, ...batch });
  assert.deepEqual(matrixPosition(Array.from(pool.matrix(0))), [0, 0, 0]);
  assert.throws(() => pool.assertSettled(), {
    code: 'display-authority-matrix-pool-unclaimed',
  });
  pool.claim(3);
  pool.consumeMany(new Uint32Array([0]));
  pool.assertSettled();
  assert.deepEqual(matrixPosition(Array.from(pool.matrix(0))), [4, 5, 6]);
  assert.deepEqual(Array.from(pool.matrix(3)), IDENTITY);
  assert.notStrictEqual(pool.matrix(0).buffer, checkpointOwner.buffer);

  pool.applyBatch({ poolSize: 4, ...matrixBatch([]) });
  assert.throws(() => pool.consumeMany(new Uint32Array([0])), {
    code: 'display-authority-transform-batch-unavailable',
  }, 'settling clears only the prior batch\'s touched row indices');
  pool.assertSettled();
});

test('AuthorityMatrixPool rejects malformed batches before changing its live owner', () => {
  const pool = new AuthorityMatrixPool();
  pool.install({ poolSize: 2, matrices: matrixPool(2, [[0, IDENTITY]]) });
  pool.claim(0);
  pool.assertSettled();
  const before = Array.from(pool.matrix(0));

  const invalid = matrixBatch([[0, matrixTransform({ position: [7, 0, 0] })]]);
  invalid.matrices[15] = 0;
  assert.throws(() => pool.applyBatch({ poolSize: 2, ...invalid }), {
    code: 'display-transform-invalid',
  });
  assert.deepEqual(Array.from(pool.matrix(0)), before);

  assert.throws(() => pool.applyBatch({
    poolSize: 2,
    nodeIds: new Uint32Array([1, 0]),
    matrices: new Float32Array([...IDENTITY, ...IDENTITY]),
  }), { code: 'display-authority-transform-batch-invalid' });
  assert.deepEqual(Array.from(pool.matrix(0)), before);
});

test('AuthorityMatrixPool consumeMany preflights the whole batch before any row mutation', () => {
  const pool = new AuthorityMatrixPool();
  pool.install({
    poolSize: 2,
    matrices: matrixPool(2, [[0, IDENTITY], [1, IDENTITY]]),
  });
  pool.claim(0);
  pool.claim(1);
  pool.assertSettled();
  const moved0 = matrixTransform({ position: [4, 0, 0] });
  const moved1 = matrixTransform({ position: [8, 0, 0] });
  pool.applyBatch({ poolSize: 2, ...matrixBatch([[0, moved0], [1, moved1]]) });

  assert.throws(() => pool.consumeMany(new Uint32Array([0, 2])), {
    code: 'display-authority-transform-batch-unavailable',
  });
  assert.deepEqual(Array.from(pool.matrix(0)), IDENTITY);
  assert.deepEqual(Array.from(pool.matrix(1)), IDENTITY);

  pool.consumeMany(new Uint32Array([0, 1]));
  pool.assertSettled();
  assert.deepEqual(Array.from(pool.matrix(0)), moved0);
  assert.deepEqual(Array.from(pool.matrix(1)), moved1);
});

test('AuthorityMatrixPool separates logical size from geometric backing capacity', () => {
  const pool = new AuthorityMatrixPool();
  pool.install({ poolSize: 1, matrices: matrixPool(1, [[0, IDENTITY]]) });
  pool.claim(0);
  pool.assertSettled();
  assert.equal(pool.size, 1);
  assert.equal(pool.capacity, 1);
  const firstRow = pool.matrix(0);
  assert.strictEqual(pool.matrix(0), firstRow, 'matrix lookup caches its row view');

  pool.applyBatch({ poolSize: 2, ...matrixBatch([[1, IDENTITY]]) });
  pool.claim(1);
  pool.assertSettled();
  assert.equal(pool.size, 2);
  assert.equal(pool.capacity, 2);

  pool.applyBatch({ poolSize: 3, ...matrixBatch([[2, IDENTITY]]) });
  pool.claim(2);
  pool.assertSettled();
  assert.notStrictEqual(pool.matrix(0), firstRow,
    'geometric reallocation lazily replaces cached row views');
  const owner = pool.matrix(0).buffer;
  const rowWithinCapacity = pool.matrix(0);
  assert.equal(pool.size, 3);
  assert.equal(pool.capacity, 4);

  pool.applyBatch({ poolSize: 4, ...matrixBatch([[3, IDENTITY]]) });
  pool.claim(3);
  pool.assertSettled();
  assert.equal(pool.size, 4);
  assert.equal(pool.capacity, 4);
  assert.strictEqual(pool.matrix(0).buffer, owner, 'growth within capacity must not reallocate');
  assert.strictEqual(pool.matrix(0), rowWithinCapacity,
    'growth within capacity preserves cached row views');
});

test('AuthorityMatrixPool rejects sparse growth before allocating a larger owner', () => {
  const pool = new AuthorityMatrixPool();
  pool.install({ poolSize: 1, matrices: matrixPool(1, [[0, IDENTITY]]) });
  pool.claim(0);
  pool.assertSettled();
  const owner = pool.matrix(0).buffer;

  assert.throws(() => pool.applyBatch({
    poolSize: 100_000,
    ...matrixBatch([[99_999, IDENTITY]]),
  }), { code: 'display-authority-transform-batch-invalid' });
  assert.equal(pool.size, 1);
  assert.equal(pool.capacity, 1);
  assert.strictEqual(pool.matrix(0).buffer, owner);
});

test('checkpoint tombstones and released IDs can never be claimed again', () => {
  const negativeZero = new Float32Array(16);
  negativeZero[0] = -0;
  assert.throws(() => new AuthorityMatrixPool().install({
    poolSize: 1,
    matrices: negativeZero,
  }), { code: 'display-transform-invalid' }, 'a tombstone row must contain exact +0 bits');

  const pool = new AuthorityMatrixPool();
  pool.install({ poolSize: 2, matrices: matrixPool(2, [[0, IDENTITY]]) });
  pool.claim(0);
  assert.throws(() => pool.claim(1), { code: 'display-authority-matrix-node-invalid' });
  pool.assertSettled();

  pool.release(0);
  assert.throws(() => pool.claim(0), { code: 'display-authority-matrix-node-invalid' });
  assert.throws(() => pool.applyBatch({
    poolSize: 2,
    ...matrixBatch([[0, IDENTITY]]),
  }), { code: 'display-authority-transform-batch-invalid' });
});

test('ID authority roots dynamically read one pool across growth and use numeric commands', async (t) => {
  let checkpointOwner;
  const { runtime } = await createHarness({
    rawAuthority: true,
    bootstrapAuthority(authority) {
      checkpointOwner = matrixPool(3, [
        [0, IDENTITY],
        [2, matrixTransform({ position: [2, 0, 0] })],
      ]);
      authority.installNodeMatrixPool({ poolSize: 3, matrices: checkpointOwner });
      assert.equal(authority.createNode(createCommand(0)), 0);
      assert.equal(authority.createNode(createCommand(2, 0)), 2);
    },
  });
  t.after(() => runtime.dispose());

  const root = runtime._nodeIndex.require('py/0');
  assert.equal(root._ownedLocalTransform, null);
  assert.strictEqual(root._localTransform.buffer, checkpointOwner.buffer);
  assert.equal(runtime.currentView().getNode('py/2').parentName, 'py/0');

  const moved = matrixTransform({ position: [9, 0, 0] });
  commitAuthority(runtime, () => {
    const batch = matrixBatch([[0, moved], [3, IDENTITY]]);
    runtime.authority.applyNodeTransformBatch({ poolSize: 4, ...batch });
    assert.deepEqual(matrixPosition(root.localTransform), [0, 0, 0],
      'staging must not expose a transform before its command');
    runtime.authority.setNodeTransforms({ nodeIds: batch.nodeIds.subarray(0, 1) });
    runtime.authority.createNode(createCommand(3));
  }, { sourceTickDelta: 1, commandCount: 2 });

  assert.strictEqual(runtime._nodeIndex.require('py/0'), root);
  assert.notStrictEqual(root._localTransform.buffer, checkpointOwner.buffer);
  assert.deepEqual(matrixPosition(root.localTransform), [9, 0, 0]);
  assert.deepEqual(runtime.currentView().getNode('py/3').localTransform, IDENTITY);

  commitAuthority(runtime, () => {
    runtime.authority.applyNodeTransformBatch({
      poolSize: 4,
      nodeIds: new Uint32Array(0),
      matrices: new Float32Array(0),
    });
    runtime.authority.setNodeParent({ nodeId: 2, parentNodeId: null });
    runtime.authority.setNodeVisible({ nodeId: 2, visible: false });
    runtime.authority.setNodeState({ nodeId: 2, state: { phase: 'next' } });
    runtime.authority.removeNode({ nodeId: 3 });
  }, { commandCount: 4 });
  assert.equal(runtime.currentView().getNode('py/2').parentName, 'sys/authority-root');
  assert.equal(runtime.currentView().getNode('py/2').visibleSelf, false);
  assert.equal(runtime.currentView().getNode('py/3'), null);
});

test('Prefab replacement rebinds the replacement authority root to the same matrix row', async (t) => {
  const replacement = emptyPrefab({ id: 'target.test.replacement', childName: 'replacement-body' });
  const { runtime } = await createHarness({
    rawAuthority: true,
    prefabEntries: [emptyPrefab(), replacement],
    bootstrapAuthority(authority) {
      authority.installNodeMatrixPool({
        poolSize: 1,
        matrices: matrixPool(1, [[0, IDENTITY]]),
      });
      authority.createNode(createCommand(0));
    },
  });
  t.after(() => runtime.dispose());
  const before = runtime._nodeIndex.require('py/0');

  commitAuthority(runtime, () => runtime.authority.setNodeDisplayKind({
    nodeId: 0,
    displayKindId: replacement.id,
    state: {},
  }));
  const after = runtime._nodeIndex.require('py/0');
  assert.notStrictEqual(after, before);
  assert.equal(before.disposed, true);
  assert.equal(after._authorityNodeId, 0);
  assert.notEqual(runtime.currentView().getNode('prefab/py/0/replacement-body'), null);

  const moved = matrixTransform({ position: [12, 0, 0] });
  commitAuthority(runtime, () => {
    runtime.authority.applyNodeTransformBatch({ poolSize: 1, ...matrixBatch([[0, moved]]) });
    runtime.authority.setNodeTransforms({ nodeIds: new Uint32Array([0]) });
  });
  assert.deepEqual(matrixPosition(after.localTransform), [12, 0, 0]);
});
