import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THREE_PRESENTATION_BACKEND_SCHEMA,
  ThreePresentationBackend,
} from '../src/index.js';

test('installs one parented anchor tree without retaining node records', () => {
  const root = new FakeGroup();
  const owner = ownerFactory();
  const backend = createBackend(root, () => owner.factory);
  const nodes = [node(1), node(2, { parentDisplayId: 1n })];
  const view = sceneView(nodes);

  backend.installBootstrap(plan({ kind: 'bootstrap', createIds: [1n, 2n] }), view);

  assert.equal(backend.schema, THREE_PRESENTATION_BACKEND_SCHEMA);
  assert.equal(backend.capture().nodeCount, 2);
  assert.equal(backend.capture().handleCount, 2);
  assert.strictEqual(backend.getAnchor(2n).parent, backend.getAnchor(1n));
  assert.deepEqual(backend.getAnchor(2n).position.values, [2, 0, 0]);
  assert.equal(root.matrixWorldUpdateCount, 1);
  assert.equal('entity' in backend.records.get(1n), false);
  assert.equal('node' in backend.records.get(1n), false);
  assert.equal('parentDisplayId' in backend.records.get(1n), false);
});

test('applies only declared changes and skips an unchanged owner profile', () => {
  const root = new FakeGroup();
  const owner = ownerFactory();
  const backend = createBackend(root, () => owner.factory);
  const first = node(1, { profile: payload([1, 2, 3]) });
  backend.rebuild(sceneView([first]));
  assert.equal(owner.stats.creates, 1);

  backend.apply(plan({ profileStateDirtyIds: [1n] }), sceneView([first]));
  assert.equal(owner.stats.profileUpdates, 0);
  assert.equal(root.matrixWorldUpdateCount, 1);

  const changed = node(1, {
    animationStateId: 2,
    localPosition: [9, 8, 7],
    profile: payload([4, 5, 6]),
  });
  backend.apply(plan({
    animationDirtyIds: [1n],
    localPoseDirtyIds: [1n],
    profileStateDirtyIds: [1n],
  }), sceneView([changed]));
  assert.equal(owner.stats.profileUpdates, 1);
  assert.equal(owner.stats.animationUpdates, 1);
  assert.deepEqual(backend.getAnchor(1n).position.values, [9, 8, 7]);
  assert.equal(root.matrixWorldUpdateCount, 2);
});

test('applies a correlation batch and updates world matrices exactly once', () => {
  const root = new FakeGroup();
  const events = [];
  const backend = createBackend(root, () => ownerFactory().factory, {
    onEvents(values, identity) { events.push([values, identity]); },
  });
  const created = node(1);
  backend.applyBatch([
    {
      plan: plan({ createIds: [1n], events: [{ eventId: 1n }], frameSeq: 1n }),
      view: sceneView([created]),
    },
    {
      plan: plan({ removeIds: [1n], events: [{ eventId: 2n }], frameSeq: 2n }),
      view: sceneView([]),
    },
  ]);

  assert.equal(backend.capture().nodeCount, 0);
  assert.equal(root.matrixWorldUpdateCount, 1);
  assert.deepEqual(events.map(([, identity]) => identity.frameSeq), [1n, 2n]);
});

test('rejects stale asynchronous resources after replace and remove', async () => {
  const root = new FakeGroup();
  const first = deferred();
  const second = deferred();
  const factories = new Map([
    [1, { create: () => first.promise }],
    [2, { create: () => second.promise }],
  ]);
  const backend = createBackend(root, (visualTypeId) => factories.get(visualTypeId));
  backend.apply(plan({ createIds: [1n] }), sceneView([node(1)]));
  backend.apply(plan({ visualReplaceIds: [1n] }), sceneView([
    node(1, { visualTypeId: 2 }),
  ]));

  const stale = visualHandle();
  first.resolve(stale);
  await Promise.resolve();
  assert.equal(stale.disposed, true);

  backend.apply(plan({ removeIds: [1n] }), sceneView([]));
  const removed = visualHandle();
  second.resolve(removed);
  await backend.whenIdle();
  assert.equal(removed.disposed, true);
  assert.equal(backend.getAnchor(1n), null);
  assert.equal(backend.capture().handleCount, 0);
});

test('a pending create is superseded by the newest profile request', async () => {
  const root = new FakeGroup();
  const requests = [];
  let visualReadyCount = 0;
  const backend = createBackend(root, () => ({
    create(input) {
      const pending = deferred();
      requests.push({ input, pending });
      return pending.promise;
    },
  }), {
    onVisualReady() { visualReadyCount += 1; },
  });
  const first = node(1, { profile: payload([1]) });
  backend.apply(plan({ createIds: [1n] }), sceneView([first]));
  const latest = node(1, { profile: payload([2]) });
  backend.apply(plan({ profileStateDirtyIds: [1n] }), sceneView([latest]));
  assert.equal(requests.length, 2);
  assert.deepEqual([...requests[1].input.profile.bytes], [2]);

  const stale = visualHandle();
  const active = visualHandle();
  requests[0].pending.resolve(stale);
  requests[1].pending.resolve(active);
  await backend.whenIdle();
  assert.equal(stale.disposed, true);
  assert.equal(active.disposed, false);
  assert.strictEqual(active.object3d.parent, backend.getAnchor(1n));
  assert.equal(visualReadyCount, 1);
  assert.equal(root.matrixWorldUpdateCount, 3);
});

test('rebuild invalidates old generation jobs and restores the current view', async () => {
  const root = new FakeGroup();
  const pending = deferred();
  let call = 0;
  const backend = createBackend(root, () => ({
    create() {
      call += 1;
      return call === 1 ? pending.promise : visualHandle();
    },
  }));
  backend.apply(plan({ createIds: [1n] }), sceneView([node(1)], 1));
  backend.rebuild(sceneView([node(2)], 2));
  const old = visualHandle();
  pending.resolve(old);
  await backend.whenIdle();

  assert.equal(old.disposed, true);
  assert.equal(backend.getAnchor(1n), null);
  assert.ok(backend.getAnchor(2n));
  assert.equal(backend.capture().generation, 2);
  await backend.dispose();
  assert.equal(backend.capture().nodeCount, 0);
});

test('dispose does not wait forever for an owner that ignores AbortSignal', async () => {
  const root = new FakeGroup();
  const pending = deferred();
  const backend = createBackend(root, () => ({ create: () => pending.promise }));
  backend.apply(plan({ createIds: [1n] }), sceneView([node(1)]));
  assert.equal(backend.capture().pendingJobCount, 1);
  await backend.dispose();
  assert.equal(backend.capture().pendingJobCount, 0);
  assert.equal(backend.capture().nodeCount, 0);
});

function createBackend(root, resolveFactory, overrides = {}) {
  return new ThreePresentationBackend({
    createAnchor: () => new FakeGroup(),
    resolveFactory,
    root,
    ...overrides,
  });
}

function ownerFactory() {
  const stats = { animationUpdates: 0, creates: 0, profileUpdates: 0 };
  return {
    factory: {
      create() {
        stats.creates += 1;
        const handle = visualHandle();
        handle.updateProfile = () => { stats.profileUpdates += 1; };
        handle.updateAnimation = () => { stats.animationUpdates += 1; };
        return handle;
      },
    },
    stats,
  };
}

function visualHandle() {
  return {
    disposed: false,
    object3d: new FakeGroup(),
    dispose() {
      this.disposed = true;
      this.object3d.removeFromParent();
    },
  };
}

function node(displayId, overrides = {}) {
  return Object.freeze({
    animationFlags: overrides.animationFlags ?? 0,
    animationStartTick: overrides.animationStartTick ?? 0n,
    animationStateId: overrides.animationStateId ?? 0,
    displayId: BigInt(displayId),
    flags: overrides.flags ?? 1,
    isStatic: overrides.isStatic ?? false,
    localPosition: Object.freeze(overrides.localPosition ?? [Number(displayId), 0, 0]),
    localRotationXyzw: Object.freeze(overrides.localRotationXyzw ?? [0, 0, 0, 1]),
    localScale: Object.freeze(overrides.localScale ?? [1, 1, 1]),
    parentDisplayId: overrides.parentDisplayId ?? 0n,
    profile: overrides.profile ?? payload([1, 2, 3]),
    visualTypeId: overrides.visualTypeId ?? 1,
  });
}

function payload(values) {
  return Object.freeze({ bytes: new Uint8Array(values), flags: 0, typeId: 101 });
}

function sceneView(nodes, generation = 1) {
  const byId = new Map(nodes.map((value) => [value.displayId, value]));
  return Object.freeze({
    generation,
    nodeAt(index) { return nodes[index] ?? null; },
    nodeCount: nodes.length,
    getNode(displayId) { return byId.get(displayId) ?? null; },
    getProfile(displayId) { return byId.get(displayId)?.profile ?? null; },
  });
}

function plan(overrides = {}) {
  return Object.freeze({
    animationDirtyIds: Object.freeze([]),
    correlationSeq: 1n,
    createIds: Object.freeze([]),
    events: Object.freeze([]),
    frameSeq: 1n,
    generation: 1,
    interactionDirtyIds: Object.freeze([]),
    kind: 'frame',
    localPoseDirtyIds: Object.freeze([]),
    profileStateDirtyIds: Object.freeze([]),
    removeIds: Object.freeze([]),
    reparentIds: Object.freeze([]),
    sourceTick: 1n,
    visibilityDirtyIds: Object.freeze([]),
    visualReplaceIds: Object.freeze([]),
    ...overrides,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

class FakeGroup {
  constructor() {
    this.children = [];
    this.matrixAutoUpdate = true;
    this.matrixWorldNeedsUpdate = false;
    this.matrixWorldUpdateCount = 0;
    this.name = '';
    this.parent = null;
    this.position = tuplePort();
    this.quaternion = tuplePort();
    this.scale = tuplePort();
    this.visible = true;
  }

  add(value) {
    value.removeFromParent?.();
    this.children.push(value);
    value.parent = this;
  }

  remove(value) {
    const index = this.children.indexOf(value);
    if (index >= 0) this.children.splice(index, 1);
    if (value.parent === this) value.parent = null;
  }

  removeFromParent() { this.parent?.remove(this); }
  updateMatrix() {}
  updateMatrixWorld(force) {
    assert.equal(force, true);
    this.matrixWorldUpdateCount += 1;
  }
}

function tuplePort() {
  return { values: [], set(...values) { this.values = values; } };
}
