import assert from 'node:assert/strict';
import test from 'node:test';

import { ThreePresentationBackend } from '../src/index.js';

function vector() {
  return { values: [], set(...values) { this.values = values; } };
}

function object3d() {
  return {
    position: vector(),
    quaternion: vector(),
    scale: vector(),
    visible: true,
  };
}

function entity(displayId, x = 0) {
  return Object.freeze({
    displayId: BigInt(displayId),
    flags: 1,
    ownerTypeId: 1,
    position: [x, 0, 0],
    rotationXyzw: [0, 0, 0, 1],
    scale: [1, 1, 1],
    visualTypeId: 1,
  });
}

function plan(entities, { creates = entities, updates = [], removes = [] } = {}) {
  return {
    finalEntities: new Map(entities.map((item) => [item.displayId, item])),
    frameSteps: [{ creates, updates, removes }],
  };
}

test('prepare keeps live tree unchanged until commitNoThrow', async () => {
  const root = {
    children: [],
    add(value) { this.children.push(value); },
    remove(value) { this.children = this.children.filter((item) => item !== value); },
  };
  const disposed = [];
  const backend = new ThreePresentationBackend({
    root,
    resolveFactory: () => ({
      async prepareCreate() {
        const sceneObject = object3d();
        return {
          handle: { object3d: sceneObject, dispose() { disposed.push(sceneObject); } },
          object3d: sceneObject,
        };
      },
    }),
  });
  const first = entity(1, 5);
  const prepared = await backend.prepare(plan([first]), {
    generation: 1,
    trackJob: () => {},
  });
  assert.equal(root.children.length, 0);
  prepared.commitNoThrow();
  assert.equal(root.children.length, 1);
  assert.deepEqual(root.children[0].position.values, [5, 0, 0]);

  const removed = await backend.prepare(plan([], { creates: [], removes: [1n] }), {
    generation: 1,
    trackJob: (job) => job,
  });
  assert.equal(root.children.length, 1);
  removed.commitNoThrow();
  assert.equal(root.children.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed.length, 1);
});

test('prepare failure aborts detached handles and leaves live tree intact', async () => {
  const root = { children: [], add(value) { this.children.push(value); }, remove() {} };
  let disposed = 0;
  const backend = new ThreePresentationBackend({
    root,
    resolveFactory: () => ({
      async prepareCreate(value) {
        if (value.displayId === 2n) throw new Error('missing resource');
        const sceneObject = object3d();
        return {
          handle: { object3d: sceneObject, dispose() { disposed += 1; } },
          object3d: sceneObject,
        };
      },
    }),
  });
  await assert.rejects(() => backend.prepare(plan([entity(1), entity(2)]), {
    generation: 1,
    trackJob: () => {},
  }), /missing resource/u);
  assert.equal(root.children.length, 0);
  assert.equal(disposed, 1);
});

test('events are emitted only inside commit', async () => {
  const seen = [];
  const root = { add() {}, remove() {} };
  const backend = new ThreePresentationBackend({
    root,
    resolveFactory: () => null,
    onEvents(events, identity) {
      seen.push([events, identity]);
    },
  });
  const prepared = await backend.prepare({
    finalEntities: new Map(),
    frameSteps: [{
      creates: [],
      events: [{ eventId: '1' }],
      frameSeq: 4n,
      removes: [],
      sourceTick: 9n,
      updates: [],
    }],
  }, { generation: 1, trackJob: () => {} });
  assert.deepEqual(seen, []);
  prepared.commitNoThrow();
  assert.equal(seen[0][0][0].eventId, '1');
  assert.equal(seen[0][1].sourceTick, 9n);
});
