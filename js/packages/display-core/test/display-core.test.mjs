import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SceneDisplayEngineCore,
  SceneDisplayEngineError,
} from '../src/index.js';

function frame(sequence, entities) {
  return {
    header: {
      bootstrapId: '1',
      frameSeq: String(sequence),
      sceneEpoch: '1',
      sourceTick: String(sequence),
    },
    entities: entities.map((displayId) => ({
      animationStartTick: '0',
      displayId: String(displayId),
      position: [displayId, 0, 0],
      rotationXyzw: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visualTypeId: 1,
    })),
    events: [],
    ownerStates: entities.map(() => ({})),
  };
}

function engine(renderer) {
  const target = new SceneDisplayEngineCore({ renderer });
  target.installBootstrap({
    bootstrap: {},
    identity: {
      bootstrapId: '1',
      profileId: 'test@1',
      sceneEpoch: '1',
      viewerScope: 'viewer:test',
    },
  });
  return target;
}

test('renderer prepare failure leaves store and business state unchanged', async () => {
  let businessCommitted = false;
  const target = engine({
    async prepare() { throw new Error('resource failed'); },
  });
  await assert.rejects(() => target.prepareCommit({
    frames: [frame(1, [1])],
    correlationSeq: '1',
    businessPrepared: { commitNoThrow() { businessCommitted = true; } },
  }), /resource failed/u);
  assert.equal(target.capture().entityCount, 0);
  assert.equal(target.capture().lastFrameSeq, null);
  assert.equal(businessCommitted, false);
});

test('prepared renderer and store commit in one synchronous no-throw section', async () => {
  const live = new Set();
  const target = engine({
    async prepare(plan) {
      assert.equal(live.size, 0);
      return {
        async abort() {},
        commitNoThrow() {
          for (const entity of plan.frameSteps.at(-1).creates) live.add(entity.displayId);
        },
      };
    },
  });
  const prepared = await target.prepareCommit({
    frames: [frame(1, [1, 2])],
    correlationSeq: '1',
    businessPrepared: { commitNoThrow() {} },
  });
  assert.equal(target.capture().entityCount, 0);
  assert.equal(prepared.commitNoThrow(), true);
  assert.equal(target.capture().entityCount, 2);
  assert.deepEqual([...live], [1n, 2n]);
});

test('display IDs cannot reappear after retirement in one epoch', async () => {
  const target = engine({
    async prepare() { return { async abort() {}, commitNoThrow() {} }; },
  });
  for (const [sequence, entities] of [[1, [1]], [2, []]]) {
    const prepared = await target.prepareCommit({
      frames: [frame(sequence, entities)],
      correlationSeq: String(sequence),
    });
    assert.equal(prepared.commitNoThrow(), true);
  }
  await assert.rejects(
    () => target.prepareCommit({ frames: [frame(3, [1])], correlationSeq: '3' }),
    (error) => error instanceof SceneDisplayEngineError && error.code === 'display-id-reused',
  );
});

test('bootstrap static installer runs before dynamic commits', () => {
  const calls = [];
  const target = new SceneDisplayEngineCore({
    renderer: { async prepare() {} },
  });
  target.installBootstrap({
    bootstrap: { staticNodes: [1] },
    identity: {
      bootstrapId: '1',
      profileId: 'test@1',
      sceneEpoch: '1',
      viewerScope: 'viewer:test',
    },
    staticInstaller: {
      install(bootstrap, context) {
        calls.push([bootstrap.staticNodes.length, context.generation]);
      },
    },
  });
  assert.deepEqual(calls, [[1, 1]]);
});

test('checkpoint join can start with a later correlation and no frame', async () => {
  const target = new SceneDisplayEngineCore({
    allowCheckpointCorrelationStart: true,
    renderer: {
      async prepare(plan) {
        assert.equal(plan.frameSteps.length, 0);
        return { async abort() {}, commitNoThrow() {} };
      },
    },
  });
  target.installBootstrap({
    bootstrap: {},
    identity: {
      bootstrapId: '1',
      profileId: 'test@1',
      sceneEpoch: '1',
      viewerScope: 'viewer:test',
    },
  });
  const prepared = await target.prepareCommit({
    correlationSeq: '19',
    frames: [],
  });
  assert.equal(prepared.commitNoThrow(), true);
  assert.equal(target.capture().lastCorrelationSeq, 19n);
});
