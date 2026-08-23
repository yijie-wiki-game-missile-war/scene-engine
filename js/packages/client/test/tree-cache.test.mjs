import assert from 'node:assert/strict';
import test from 'node:test';

import { SceneTree } from '../src/tree.js';

const EMPTY = Object.freeze([]);
const ROTATION = Object.freeze([0, 0, 0, 1]);
const SCALE = Object.freeze([1, 1, 1]);

test('frames use checkpoint caches and retain one virtual static/dynamic view', () => {
  const profileBytes = new Uint8Array([11, 12]);
  const { bootstrap, lock } = guardedBootstrap([
    sceneNode(1n, 0n, [10, 0, 0], { profileBytes }),
    sceneNode(2n, 1n, [0, 2, 0]),
  ]);
  const tree = new SceneTree();
  tree.commit(tree.prepareCheckpoint(
    bootstrap,
    sceneFrame([
      sceneNode(100n, 2n, [0, 0, 3]),
      sceneNode(101n, 100n, [1, 0, 0]),
    ]),
    commit(0),
  ));
  lock();

  const initial = tree.currentView();
  const checkpointState = tree.state;
  const initialStaticNode = initial.getNode(1n);
  const initialVisual = initial.visualTypeAt(0);
  assert.equal(initial.nodeCount, 4);
  assert.deepEqual(Array.from({ length: initial.nodeCount }, (_, index) => (
    initial.nodeAt(index).displayId
  )), [1n, 2n, 100n, 101n]);
  assert.deepEqual(worldPosition(initial, 101n), [11, 2, 3]);
  profileBytes[0] = 99;
  assert.deepEqual([...initial.getProfile(1n).bytes], [11, 12]);

  const candidate = tree.prepareFrame(sceneFrame([
    sceneNode(100n, 2n, [0.5, 0, 3]),
    sceneNode(102n, 100n, [2, 0, 0]),
  ]), commit(1));
  assert.strictEqual(candidate.state.staticNodes, checkpointState.staticNodes);
  assert.strictEqual(candidate.state.staticById, checkpointState.staticById);
  assert.strictEqual(candidate.state.staticWorldPoses, checkpointState.staticWorldPoses);
  assert.strictEqual(candidate.state.registries, checkpointState.registries);
  assert.notStrictEqual(candidate.state.dynamicNodes, checkpointState.dynamicNodes);
  assert.notStrictEqual(candidate.state.dynamicById, checkpointState.dynamicById);
  assert.notStrictEqual(candidate.state.dynamicWorldPoses, checkpointState.dynamicWorldPoses);
  for (const retiredCombinedField of ['nodes', 'nodeById', 'poses', 'bootstrap']) {
    assert.equal(Object.hasOwn(candidate.state, retiredCombinedField), false);
  }
  assert.deepEqual(candidate.plan.localPoseDirtyIds, [100n]);
  assert.deepEqual(candidate.plan.removeIds, [101n]);
  assert.deepEqual(candidate.plan.createIds, [102n]);
  tree.commit(candidate);

  const current = tree.currentView();
  assert.strictEqual(current.getNode(1n), initialStaticNode);
  assert.strictEqual(current.visualTypeAt(0), initialVisual);
  assert.deepEqual(worldPosition(current, 1n), [10, 0, 0]);
  assert.deepEqual(worldPosition(current, 102n), [12.5, 2, 3]);
  assert.deepEqual(Array.from({ length: current.nodeCount }, (_, index) => (
    current.nodeAt(index).displayId
  )), [1n, 2n, 100n, 102n]);

  const beforeRejected = tree.currentView();
  assert.throws(
    () => tree.prepareFrame(sceneFrame([
      sceneNode(100n, 2n, [0.5, 0, 3]),
      sceneNode(101n, 100n, [1, 0, 0]),
    ]), commit(2)),
    (error) => error.code === 'scene-display-id-reused',
  );
  assert.strictEqual(tree.currentView(), beforeRejected);
});

test('tree validation rejects dynamic/static collisions without committing', () => {
  const { bootstrap } = guardedBootstrap([sceneNode(1n, 0n, [0, 0, 0])]);
  const tree = new SceneTree();
  tree.commit(tree.prepareCheckpoint(
    bootstrap,
    sceneFrame([sceneNode(100n, 1n, [0, 0, 0])]),
    commit(0),
  ));
  const before = tree.currentView();
  assert.throws(
    () => tree.prepareFrame(
      sceneFrame([sceneNode(1n, 0n, [0, 0, 0])]),
      commit(1),
    ),
    (error) => error.code === 'scene-tree-id-duplicate',
  );
  assert.strictEqual(tree.currentView(), before);
  assert.equal(tree.currentView().getNode(1n).isStatic, true);
});

test('dynamic parent, cycle, and depth failures leave the installed tree untouched', () => {
  const { bootstrap } = guardedBootstrap([
    sceneNode(1n, 0n, [0, 0, 0]),
    sceneNode(2n, 1n, [0, 0, 0]),
  ]);
  const tree = new SceneTree({ maximumTreeDepth: 3 });
  tree.commit(tree.prepareCheckpoint(
    bootstrap,
    sceneFrame([sceneNode(100n, 1n, [0, 0, 0])]),
    commit(0),
  ));
  const before = tree.currentView();
  for (const [nodes, code] of [
    [[sceneNode(200n, 999n, [0, 0, 0])], 'scene-tree-parent-missing'],
    [[
      sceneNode(200n, 201n, [0, 0, 0]),
      sceneNode(201n, 200n, [0, 0, 0]),
    ], 'scene-tree-cycle'],
    [[
      sceneNode(200n, 2n, [0, 0, 0]),
      sceneNode(201n, 200n, [0, 0, 0]),
    ], 'scene-tree-depth-limit'],
  ]) {
    assert.throws(
      () => tree.prepareFrame(sceneFrame(nodes), commit(1)),
      (error) => error.code === code,
    );
    assert.strictEqual(tree.currentView(), before);
  }
});

test('internal lookups are frozen dynamic-first with static fallback', () => {
  const { bootstrap } = guardedBootstrap([sceneNode(1n, 0n, [1, 2, 3])]);
  const tree = new SceneTree();
  tree.commit(tree.prepareCheckpoint(
    bootstrap,
    sceneFrame([sceneNode(100n, 1n, [0, 0, 0])]),
    commit(0),
  ));
  const candidate = tree.prepareFrame(
    sceneFrame([sceneNode(100n, 1n, [0, 0, 0])]),
    commit(1),
  );
  const dynamicShadow = Object.freeze({
    ...candidate.state.staticById.get(1n),
    isStatic: false,
    profile: Object.freeze({ typeId: 7, flags: 0, bytes: new Uint8Array([77]) }),
  });
  candidate.state.dynamicById.set(1n, dynamicShadow);
  candidate.state.dynamicWorldPoses.set(1n, Object.freeze({
    position: Object.freeze([91, 92, 93]),
    rotationXyzw: ROTATION,
    scale: SCALE,
  }));
  tree.commit(candidate);

  assert.strictEqual(tree.getNode(1n), dynamicShadow);
  assert.strictEqual(tree.getProfile(1n), dynamicShadow.profile);
  assert.deepEqual(worldPosition(tree.currentView(), 1n), [91, 92, 93]);
  assert.equal(tree.getNode(999n), null);
});

function guardedBootstrap(staticNodes) {
  let locked = false;
  const visualTypes = Object.freeze([
    Object.freeze({
      visualTypeId: 1,
      flags: 0,
      profileTypeId: 7,
      interactionTypeId: 0,
    }),
  ]);
  const value = Object.freeze({
    header: Object.freeze({ maximumDynamicNodes: 8, maximumFrameBytes: 4096 }),
    staticNodes: Object.freeze(staticNodes),
    sceneMetadata: Object.freeze([
      Object.freeze({ metadataTypeId: 9, flags: 0, data: new Uint8Array([9]) }),
    ]),
    visualTypes,
    animationStates: EMPTY,
  });
  return {
    bootstrap: new Proxy(value, {
      get(target, property, receiver) {
        if (locked) throw new Error(`bootstrap cache miss: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    }),
    lock() { locked = true; },
  };
}

function sceneNode(displayId, parentDisplayId, localPosition, { profileBytes = null } = {}) {
  return Object.freeze({
    animationFlags: 0,
    animationStartTick: 0n,
    animationStateId: 0,
    displayId,
    flags: 1,
    interaction: null,
    localPosition: Object.freeze(localPosition),
    localRotationXyzw: ROTATION,
    localScale: SCALE,
    parentDisplayId,
    profile: Object.freeze({
      payloadTypeId: 7,
      flags: 0,
      data: profileBytes ?? new Uint8Array([displayId === 0n ? 0 : Number(displayId % 251n)]),
    }),
    visualTypeId: 1,
  });
}

function sceneFrame(nodes) {
  return Object.freeze({ bytes: new Uint8Array(1), nodes: Object.freeze(nodes), events: EMPTY });
}

function commit(commitSeq) {
  return Object.freeze({ commitSeq, sourceTick: commitSeq });
}

function worldPosition(view, displayId) {
  const out = {
    position: new Float64Array(3),
    rotationXyzw: new Float64Array(4),
    scale: new Float64Array(3),
  };
  assert.equal(view.getWorldPose(displayId, out), true);
  return [...out.position];
}
