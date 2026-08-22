import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PresentationSceneTree,
  SceneDisplayEngineCore,
  SceneDisplayEngineError,
} from '../src/index.js';

const encoder = new TextEncoder();

function node(displayId, parentDisplayId = 0n, changes = {}) {
  const visualTypeId = changes.visualTypeId ?? 1;
  return {
    displayId: BigInt(displayId),
    parentDisplayId: BigInt(parentDisplayId),
    visualTypeId,
    flags: changes.flags ?? 1,
    position: changes.position ?? [0, 0, 0],
    rotation: changes.rotation ?? [0, 0, 0, 1],
    scale: changes.scale ?? [1, 1, 1],
    animationStateId: changes.animationStateId ?? 0,
    animationStartTick: BigInt(changes.animationStartTick ?? 0),
    animationFlags: changes.animationFlags ?? 0,
    profile: changes.profile === undefined
      ? { typeId: visualTypeId === 1 ? 101 : 102, flags: 0, bytes: encoder.encode(`node:${displayId}`) }
      : changes.profile,
    interaction: changes.interaction === undefined
      ? (visualTypeId === 1
        ? { typeId: 201, flags: 0, bytes: encoder.encode(`interaction:${displayId}`) }
        : null)
      : changes.interaction,
  };
}

function nodeView(nodes) {
  return {
    nodeCount: nodes.length,
    displayIdAt: (index) => nodes[index].displayId,
    parentDisplayIdAt: (index) => nodes[index].parentDisplayId,
    visualTypeIdAt: (index) => nodes[index].visualTypeId,
    flagsAt: (index) => nodes[index].flags,
    animationStateIdAt: (index) => nodes[index].animationStateId,
    animationStartTickAt: (index) => nodes[index].animationStartTick,
    animationFlagsAt: (index) => nodes[index].animationFlags,
    readLocalPoseAt: undefined,
    readLocalPose(index, out) {
      out.localPosition.set(nodes[index].position);
      out.localRotationXyzw.set(nodes[index].rotation);
      out.localScale.set(nodes[index].scale);
      return out;
    },
    readProfileStateAt(index, out) {
      const value = nodes[index].profile;
      if (!value) return false;
      Object.assign(out, value);
      return true;
    },
    readInteractionAt(index, out) {
      const value = nodes[index].interaction;
      if (!value) return false;
      Object.assign(out, value);
      return true;
    },
  };
}

function bootstrap(
  staticNodes = [],
  maximumDynamicNodes = 100,
  metadata = { typeId: 301, flags: 0, bytes: encoder.encode('topology') },
) {
  return {
    ...nodeView(staticNodes),
    raw: encoder.encode('bootstrap-owner'),
    header: { sceneEpoch: 7n, bootstrapId: 9n, maximumDynamicNodes },
    identity: { profileId: 'mw-presentation-v3@1', viewerScope: 'viewer:test' },
    visualTypeCount: 2,
    visualTypeAt(index) {
      return index === 0
        ? { visualTypeId: 1, flags: 0, profileTypeId: 101, interactionTypeId: 201 }
        : { visualTypeId: 2, flags: 0, profileTypeId: 102, interactionTypeId: 0 };
    },
    animationStateCount: 1,
    animationStateAt() { return { animationStateId: 1, flags: 1, durationTicks: 60 }; },
    metadataCount: 1,
    metadataAt() { return metadata; },
  };
}

function frame(sequence, nodes, { events = [], sourceTick = sequence } = {}) {
  return {
    ...nodeView(nodes),
    raw: encoder.encode(`frame:${sequence}`),
    header: {
      bootstrapId: 9n,
      frameSeq: BigInt(sequence),
      projectionId: BigInt(sequence),
      sceneEpoch: 7n,
      sourceTick: BigInt(sourceTick),
    },
    eventCount: events.length,
    eventAt: (index) => events[index],
  };
}

function event(id) {
  return {
    eventId: BigInt(id), eventTypeId: 501, flags: 1,
    sourceDisplayId: 3n, targetDisplayId: 0n, startTick: 1n,
    payload: encoder.encode(`event:${id}`),
  };
}

test('one dense tree owns static+dynamic parent/local state and metadata', () => {
  const tree = new PresentationSceneTree();
  const root = node(1, 0, { position: [10, 0, 0], interaction: {
    typeId: 201, flags: 0, bytes: encoder.encode('root'),
  } });
  const child = node(2, 1, { position: [2, 0, 0] });
  assert.deepEqual(tree.installBootstrap(bootstrap([root, child])).createIds, [1n, 2n]);
  assert.equal(tree.currentView().sceneMetadataCount, 1);
  assert.equal(new TextDecoder().decode(tree.currentView().getSceneMetadata(301).bytes), 'topology');

  const prepared = tree.prepareFrame(
    frame(1, [node(3, 2, { position: [1, 0, 0] })]),
    { correlationSeq: 1n },
  );
  assert.deepEqual(prepared.plan.createIds, [3n]);
  assert.equal(tree.getNode(3n), null);
  assert.equal(prepared.commit(), true);
  const result = { position: new Float64Array(3), rotationXyzw: new Float64Array(4), scale: new Float64Array(3) };
  assert.equal(tree.getWorldPose(3n, result), true);
  assert.deepEqual([...result.position], [13, 0, 0]);
  assert.equal(tree.getNode(3n).parentDisplayId, 2n);
  assert.equal(new TextDecoder().decode(tree.getInteraction(1n).bytes), 'root');
  tree.reset(bootstrap([], 100, {
    typeId: 302, flags: 0, bytes: encoder.encode('reset-metadata'),
  }));
  assert.equal(tree.currentView().generation, 2);
  assert.equal(tree.currentView().getSceneMetadata(301), null);
  assert.equal(new TextDecoder().decode(tree.getSceneMetadata(302).bytes), 'reset-metadata');
});

test('prepare freezes a compact plan and commit is the only live pointer swap', () => {
  const tree = new PresentationSceneTree();
  tree.installBootstrap(bootstrap());
  const prepared = tree.prepareFrame(frame(1, [node(1)]), { correlationSeq: 1n });
  assert.equal(Object.isFrozen(prepared.plan), true);
  assert.equal(Object.isFrozen(prepared.plan.createIds), true);
  assert.equal(tree.currentView().dynamicNodeCount, 0);
  assert.equal(prepared.view.dynamicNodeCount, 1);
  assert.equal(prepared.commit(), true);
  assert.equal(tree.currentView().dynamicNodeCount, 1);
  assert.equal(prepared.commit(), false);

  const aborted = tree.prepareFrame(frame(2, []), { correlationSeq: 2n });
  aborted.abort();
  assert.equal(tree.currentView().dynamicNodeCount, 1);
});

test('linear merge emits changes and scalar max-seen rejects reappearance', () => {
  const tree = new PresentationSceneTree();
  tree.installBootstrap(bootstrap([node(1), node(2, 1)]));
  tree.prepareFrame(frame(1, [node(3, 2), node(4, 0)]), { correlationSeq: 1n }).commit();
  const changed = tree.prepareFrame(frame(2, [node(4, 2, {
    position: [4, 0, 0],
    flags: 0,
    visualTypeId: 2,
    profile: { typeId: 102, flags: 0, bytes: encoder.encode('changed') },
    animationStateId: 1,
    animationStartTick: 2,
    animationFlags: 1,
  })]), { correlationSeq: 2n });
  assert.deepEqual(changed.plan.removeIds, [3n]);
  assert.deepEqual(changed.plan.reparentIds, [4n]);
  assert.deepEqual(changed.plan.localPoseDirtyIds, [4n]);
  assert.deepEqual(changed.plan.visibilityDirtyIds, [4n]);
  assert.deepEqual(changed.plan.visualReplaceIds, [4n]);
  assert.deepEqual(changed.plan.profileStateDirtyIds, [4n]);
  assert.deepEqual(changed.plan.animationDirtyIds, [4n]);
  changed.commit();
  assert.throws(
    () => tree.prepareFrame(frame(3, [node(3, 2), node(4, 2, {
      visualTypeId: 2,
      profile: { typeId: 102, flags: 0, bytes: encoder.encode('changed') },
    })]), { correlationSeq: 3n }),
    (error) => error instanceof SceneDisplayEngineError && error.code === 'display-id-reused',
  );
});

test('tree rejects dangling parents, cycles/order, excessive depth, and invalid local pose', () => {
  assert.throws(
    () => new PresentationSceneTree().installBootstrap(bootstrap([node(2, 1)])),
    (error) => error.code === 'dangling-parent',
  );
  assert.throws(
    () => new PresentationSceneTree().installBootstrap(bootstrap([node(1, 2), node(2, 1)])),
    (error) => error.code === 'node-order-or-parent-invalid',
  );
  assert.throws(
    () => new PresentationSceneTree({ limits: { maximumTreeDepth: 2 } })
      .installBootstrap(bootstrap([node(1), node(2, 1), node(3, 2)])),
    (error) => error.code === 'tree-depth-exceeded',
  );
  assert.throws(
    () => new PresentationSceneTree().installBootstrap(bootstrap([
      node(1, 0, { scale: [1, 0, 1] }),
    ])),
    (error) => error.code === 'node-scale-invalid',
  );
});

test('tree treats absent payload as type zero against the visual registry', () => {
  assert.throws(
    () => new PresentationSceneTree().installBootstrap(bootstrap([
      node(1, 0, { profile: null }),
    ])),
    (error) => error.code === 'profile-type-mismatch',
  );
  assert.throws(
    () => new PresentationSceneTree().installBootstrap(bootstrap([
      node(1, 0, { interaction: null }),
    ])),
    (error) => error.code === 'interaction-type-mismatch',
  );

  const tree = new PresentationSceneTree();
  tree.installBootstrap(bootstrap());
  assert.throws(
    () => tree.prepareFrame(
      frame(1, [node(1, 0, { profile: null })]),
      { correlationSeq: 1n },
    ),
    (error) => error.code === 'profile-type-mismatch',
  );
  assert.throws(
    () => tree.prepareFrame(
      frame(1, [node(1, 0, { interaction: null })]),
      { correlationSeq: 1n },
    ),
    (error) => error.code === 'interaction-type-mismatch',
  );
});

test('correlation batch preserves transient lifecycle/events and commits once', () => {
  const engine = new SceneDisplayEngineCore({ limits: { maximumFramesPerCorrelation: 4 } });
  engine.installBootstrap(bootstrap());
  const prepared = engine.prepareFrames([
    frame(1, [node(1)], { events: [event(1)] }),
    frame(2, [], { events: [event(2)] }),
    frame(3, [node(2)], { events: [event(3)] }),
    frame(4, [], { events: [event(4)] }),
  ], { correlationSeq: 1n });
  assert.equal(prepared.steps.length, 4);
  assert.deepEqual(prepared.steps[0].plan.createIds, [1n]);
  assert.deepEqual(prepared.steps[1].plan.removeIds, [1n]);
  assert.equal(prepared.steps[0].view.getNode(1n).displayId, 1n);
  assert.equal(prepared.steps[1].view.getNode(1n), null);
  assert.equal(prepared.steps[2].view.getNode(2n).displayId, 2n);
  assert.equal(prepared.steps[3].view.getNode(2n), null);
  assert.equal(prepared.steps[0].plan.events[0].eventId, 1n);
  assert.equal(prepared.steps[1].plan.events[0].eventId, 2n);
  assert.equal(engine.capture().dynamicNodeCount, 0);
  assert.equal(prepared.commit(), true);
  assert.equal(engine.capture().dynamicNodeCount, 0);
  assert.equal(engine.capture().metrics.committedFrames, 4);
  assert.equal(engine.capture().metrics.committedCorrelations, 1);
});

test('capture observers run after the synchronous commit barrier and stay isolated', async () => {
  const captures = [];
  const engine = new SceneDisplayEngineCore({
    captureHook(value) {
      captures.push(value);
      throw new Error('diagnostic observer failed');
    },
  });
  engine.installBootstrap(bootstrap());
  const prepared = engine.prepareFrame(frame(1, [node(1)]), {
    correlationSeq: 1n,
  });
  assert.equal(prepared.commit(), true);
  assert.deepEqual(captures, []);
  assert.equal(engine.currentView().getNode(1n).displayId, 1n);
  await Promise.resolve();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].dynamicNodeCount, 1);
});

test('5000 nodes across 60 frames stay in a bounded dense typed-store pool', () => {
  const count = 5000;
  const engine = new SceneDisplayEngineCore({
    limits: { maximumNodes: count, maximumFramesPerCorrelation: 8 },
  });
  engine.installBootstrap(bootstrap([], count));
  const pool = engine.tree.dynamicPool;
  assert.equal(pool.length, 3);
  assert.equal(pool.every((store) => store.displayIds instanceof BigUint64Array), true);
  assert.equal(pool.every((store) => store.localPositions instanceof Float32Array), true);
  assert.equal(pool.every((store) => store.worldPositions instanceof Float64Array), true);

  for (let sequence = 1; sequence <= 60; sequence += 1) {
    const synthetic = syntheticFrame(sequence, count);
    assert.equal(engine.prepareFrame(synthetic, { correlationSeq: BigInt(sequence) }).commit(), true);
  }
  const capture = engine.capture();
  assert.equal(capture.dynamicNodeCount, count);
  assert.equal(capture.maxSeenDisplayId, BigInt(count));
  assert.equal(capture.denseDynamicStoreCount, 3);
  assert.equal(capture.dynamicStoreCapacity, count);
  assert.equal(capture.residentNodeObjectCount, 0);
  assert.equal(capture.residentPoseObjectCount, 0);
  assert.deepEqual(engine.tree.dynamicPool, pool);
});

function syntheticFrame(sequence, count) {
  return {
    raw: encoder.encode(`synthetic:${sequence}`),
    nodeCount: count,
    header: {
      bootstrapId: 9n,
      frameSeq: BigInt(sequence),
      projectionId: BigInt(sequence),
      sceneEpoch: 7n,
      sourceTick: BigInt(sequence),
    },
    displayIdAt: (index) => BigInt(index + 1),
    parentDisplayIdAt: () => 0n,
    visualTypeIdAt: () => 1,
    flagsAt: () => 1,
    animationStateIdAt: () => 0,
    animationStartTickAt: () => 0n,
    animationFlagsAt: () => 0,
    readLocalPose(index, out) {
      out.localPosition[0] = index;
      out.localPosition[1] = sequence;
      out.localPosition[2] = 0;
      out.localRotationXyzw.set([0, 0, 0, 1]);
      out.localScale.set([1, 1, 1]);
      return out;
    },
    readProfileStateAt(index, out) {
      out.typeId = 101;
      out.flags = 0;
      out.bytes = EMPTY_BYTES;
      return true;
    },
    readInteractionAt(index, out) {
      out.typeId = 201;
      out.flags = 0;
      out.bytes = EMPTY_BYTES;
      return true;
    },
    eventCount: 0,
    eventAt() { throw new Error('unreachable'); },
  };
}

const EMPTY_BYTES = new Uint8Array([0]);
