import assert from 'node:assert/strict';
import test from 'node:test';

import * as displayCore from '../src/index.js';
import {
  SceneDisplayEngine,
  SceneDisplayEngineError,
  samplePresentationAnimation,
} from '../src/index.js';

const encoder = new TextEncoder();
const EMPTY_BYTES = new Uint8Array([0]);

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
      ? {
        typeId: visualTypeId === 1 ? 101 : 102,
        flags: 0,
        bytes: encoder.encode(`node:${displayId}`),
      }
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
    eventId: BigInt(id),
    eventTypeId: 501,
    flags: 1,
    sourceDisplayId: 3n,
    targetDisplayId: 0n,
    startTick: 1n,
    payload: encoder.encode(`event:${id}`),
  };
}

function validateAndCommit(prepared) {
  prepared.assertCommittable();
  prepared.commitValidated();
}

function aggregateCandidate(sourceTick, revision, changes = {}) {
  return {
    codecIdentity: changes.codecIdentity ?? 'neutral-test-state-json@1',
    revision,
    sourceTick,
    value: changes.value ?? {
      kind: 'neutral-test-state',
      revision,
      sourceTick,
      values: changes.values ?? [],
    },
  };
}

function engineCommit(commitSeq, sourceTick, worldRevision, changes = {}) {
  return {
    generation_id: changes.generationId ?? 1,
    commit_seq: commitSeq,
    source_tick: sourceTick,
    world_revision: worldRevision,
    cause: changes.cause ?? (commitSeq === 0 ? 'checkpoint' : 'tick'),
    causation_id: changes.causationId ?? null,
  };
}

test('display-core exposes one public Engine facade and no reset or single-frame API', () => {
  assert.deepEqual(Object.keys(displayCore).sort(), [
    'DEFAULT_SCENE_TREE_LIMITS',
    'SceneDisplayEngine',
    'SceneDisplayEngineError',
    'samplePresentationAnimation',
  ]);
  assert.equal('prepareFrame' in SceneDisplayEngine.prototype, false);
  assert.equal('reset' in SceneDisplayEngine.prototype, false);
  assert.equal(typeof SceneDisplayEngine.prototype.schedulePostCommitCapture, 'function');
  assert.equal('PresentationSceneTree' in displayCore, false);
  assert.equal('SceneDisplayEngineCore' in displayCore, false);
});

test('Engine options and tree limit names fail closed', () => {
  assert.throws(
    () => new SceneDisplayEngine({ unsupported: true }),
    (error) => error.code === 'scene-display-engine-option-unknown',
  );
  assert.throws(
    () => new SceneDisplayEngine(new Date()),
    (error) => error.code === 'scene-display-engine-options-invalid',
  );
  assert.throws(
    () => new SceneDisplayEngine({ captureHook: 'not-a-function' }),
    (error) => error.code === 'capture-hook-invalid',
  );
  assert.throws(
    () => new SceneDisplayEngine({ limits: null }),
    (error) => error.code === 'scene-tree-limits-invalid',
  );
  assert.throws(
    () => new SceneDisplayEngine({ limits: new Map() }),
    (error) => error.code === 'scene-tree-limits-invalid',
  );
  assert.throws(
    () => new SceneDisplayEngine({ limits: { maximumFramesPerCorrelation: 1 } }),
    (error) => error.code === 'scene-tree-limit-unknown',
  );
  assert.throws(
    () => new SceneDisplayEngine({ limits: { maximumFramesPerBatc: 1 } }),
    (error) => error.code === 'scene-tree-limit-unknown',
  );
  assert.throws(
    () => new SceneDisplayEngine({ limits: { [Symbol('unknown')]: 1 } }),
    (error) => error.code === 'scene-tree-limit-unknown',
  );

  const nullPrototypeLimits = Object.assign(Object.create(null), {
    maximumFramesPerBatch: 1,
  });
  const nullPrototypeOptions = Object.assign(Object.create(null), {
    limits: nullPrototypeLimits,
  });
  const engine = new SceneDisplayEngine(nullPrototypeOptions);
  engine.installBootstrap(bootstrap());
  assert.throws(
    () => engine.prepareFrames([frame(1, []), frame(2, [])]),
    (error) => error.code === 'frame-batch-limit-exceeded',
  );
});

test('Engine owns and atomically advances an opaque aggregate with the sole presentation tree', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());

  const initialAggregate = aggregateCandidate(0, 0);
  const initialCommit = engineCommit(0, 0, 0);
  const initial = engine.prepareCommit({
    aggregateCandidate: initialAggregate,
    frames: [frame(1, [node(1)], { sourceTick: 0 })],
    engineCommit: initialCommit,
  });
  assert.equal(engine.currentAggregate(), null);
  assert.equal(engine.currentCommit(), null);
  assert.equal(engine.currentView().dynamicNodeCount, 0);
  initial.assertCommittable();
  initial.commitValidated();

  assert.strictEqual(engine.currentAggregate(), initial.aggregate);
  assert.strictEqual(engine.currentCommit(), initial.engineCommit);
  assert.equal(engine.currentAggregate().value.kind, 'neutral-test-state');
  assert.equal(engine.currentView().dynamicNodeCount, 1);
  assert.equal(Object.isFrozen(engine.currentAggregate()), true);
  assert.equal(Object.isFrozen(engine.currentAggregate().value), true);

  const dataOnlyAggregate = aggregateCandidate(0, 1, {
    values: [{ credits: 10 }],
  });
  const dataOnly = engine.prepareCommit({
    aggregateCandidate: dataOnlyAggregate,
    engineCommit: engineCommit(1, 0, 1, {
      cause: 'command',
      causationId: 'intent:test',
    }),
    frames: [],
  });
  assert.deepEqual(dataOnly.steps, []);
  assert.equal(engine.currentAggregate().revision, 0);
  dataOnly.assertCommittable();
  dataOnly.commitValidated();

  assert.equal(engine.currentAggregate().revision, 1);
  assert.equal(engine.currentAggregate().value.values[0].credits, 10);
  assert.equal(engine.currentCommit().commit_seq, 1);
  assert.equal(engine.currentView().sourceTick, 0n);

  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(1, 2),
    engineCommit: engineCommit(2, 1, 2),
    frames: [frame(2, [node(2)], { sourceTick: 1 })],
  }));
  assert.equal(engine.currentView().sourceTick, 1n);
  assert.deepEqual(engine.capture().metrics, {
    committedAggregates: 3,
    committedFrames: 2,
    committedFrameBatches: 2,
    prepareFailures: 0,
  });
});

test('aggregate commit sequence and prepared tokens fail closed without partial mutation', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 0),
    frames: [frame(1, [], { sourceTick: 0 })],
    engineCommit: engineCommit(0, 0, 0),
  }));

  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(2, 2),
      engineCommit: engineCommit(2, 2, 2),
      frames: [frame(2, [], { sourceTick: 2 })],
    }),
    (error) => error.code === 'engine-commit-sequence-gap',
  );
  assert.equal(engine.currentAggregate().sourceTick, 0);
  assert.equal(engine.currentCommit().commit_seq, 0);

  const stale = engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 1, { values: ['winner'] }),
    engineCommit: engineCommit(1, 0, 1),
    frames: [],
  });
  const winner = engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 1, { values: ['winner'] }),
    engineCommit: engineCommit(1, 0, 1),
    frames: [],
  });
  validateAndCommit(winner);
  assert.throws(
    () => stale.assertCommittable(),
    (error) => error.code === 'engine-commit-token-stale',
  );
  stale.abort();
  assert.equal(engine.currentAggregate().revision, 1);

  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: engine.currentAggregate(),
      engineCommit: engineCommit(1, 0, 1, { cause: 'reused-differently' }),
      frames: [],
    }),
    (error) => error.code === 'engine-commit-identity-reused',
  );
  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(0, 1, { values: ['divergent'] }),
      engineCommit: engine.currentCommit(),
      frames: [],
    }),
    (error) => error.code === 'engine-commit-identity-reused',
  );
  assert.equal(engine.currentCommit().cause, 'tick');
});

test('aggregate ownership freezes nested data even below a frozen shell', () => {
  const nested = { credits: 1 };
  const value = Object.freeze({ nested });
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 0, { value }),
    engineCommit: engineCommit(0, 0, 0),
    frames: [frame(1, [], { sourceTick: 0 })],
  }));

  assert.equal(Object.isFrozen(nested), true);
  assert.throws(() => { nested.credits = 999; }, TypeError);
  assert.equal(engine.currentAggregate().value.nested.credits, 1);
});

test('aggregate commits enforce complete-frame time and checkpoint boundaries', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(0, 0),
      engineCommit: engineCommit(0, 0, 0),
      frames: [],
    }),
    (error) => error.code === 'engine-initial-commit-frame-missing',
  );
  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(0, 0),
      engineCommit: engineCommit(0, 0, 0),
      frames: [frame(1, [], { sourceTick: 1 })],
    }),
    (error) => error.code === 'engine-frame-source-tick-mismatch',
  );
  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 0),
    engineCommit: engineCommit(0, 0, 0),
    frames: [frame(1, [], { sourceTick: 0 })],
  }));

  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(1, 1),
      engineCommit: engineCommit(1, 1, 1),
      frames: [],
    }),
    (error) => error.code === 'engine-advanced-tick-frame-missing',
  );
  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(0, 0),
      engineCommit: engineCommit(0, 0, 0, { generationId: 2 }),
      frames: [],
    }),
    (error) => error.code === 'engine-checkpoint-frame-missing',
  );

  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 0, { values: ['checkpoint'] }),
    engineCommit: engineCommit(0, 0, 0, { generationId: 2 }),
    frames: [frame(2, [], { sourceTick: 0 })],
  }));
  assert.equal(engine.currentCommit().generation_id, 2);
  assert.equal(engine.currentCommit().commit_seq, 0);
});

test('aggregate commit sequence rejects time or revision regression', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(0, 5),
    engineCommit: engineCommit(0, 0, 5, { generationId: 7 }),
    frames: [frame(1, [], { sourceTick: 0 })],
  }));
  validateAndCommit(engine.prepareCommit({
    aggregateCandidate: aggregateCandidate(1, 6),
    engineCommit: engineCommit(1, 1, 6, { generationId: 7 }),
    frames: [frame(2, [], { sourceTick: 1 })],
  }));

  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(0, 7),
      engineCommit: engineCommit(2, 0, 7, { generationId: 7 }),
      frames: [frame(3, [], { sourceTick: 0 })],
    }),
    (error) => error.code === 'engine-commit-state-sequence-invalid',
  );
  assert.throws(
    () => engine.prepareCommit({
      aggregateCandidate: aggregateCandidate(1, 5),
      engineCommit: engineCommit(2, 1, 5, { generationId: 7 }),
      frames: [],
    }),
    (error) => error.code === 'engine-commit-state-sequence-invalid',
  );
  assert.equal(engine.currentCommit().commit_seq, 1);
});

test('capture observers run only in protected post-barrier microtasks', async () => {
  const observed = [];
  let jointOwner = 'before-bootstrap';
  let hookCalls = 0;
  const engine = new SceneDisplayEngine({
    captureHook(capture) {
      hookCalls += 1;
      observed.push(Object.freeze({
        frameSeq: capture.lastFrameSeq,
        jointOwner,
      }));
      if (hookCalls === 1) throw new Error('capture observer failed');
    },
  });

  engine.installBootstrap(bootstrap());
  engine.schedulePostCommitCapture();
  assert.equal(hookCalls, 0);
  await Promise.resolve();
  assert.deepEqual(observed, [{ frameSeq: 0n, jointOwner: 'before-bootstrap' }]);

  const prepared = engine.prepareFrames([frame(1, [node(1)])]);
  prepared.assertCommittable();
  prepared.commitValidated();
  assert.equal(hookCalls, 1, 'commitValidated must not enqueue or invoke capture hooks');
  await Promise.resolve();
  assert.equal(hookCalls, 1);

  jointOwner = 'jointly-committed';
  engine.schedulePostCommitCapture();
  engine.schedulePostCommitCapture();
  assert.equal(hookCalls, 1);
  await Promise.resolve();
  assert.deepEqual(observed.at(-1), {
    frameSeq: 1n,
    jointOwner: 'jointly-committed',
  });
  assert.equal(hookCalls, 2, 'post-commit capture requests coalesce');

  engine.schedulePostCommitCapture();
  engine.dispose();
  await Promise.resolve();
  assert.equal(hookCalls, 2, 'dispose invalidates a queued capture observer');
});

test('one internal dense tree owns static and dynamic state through the facade', () => {
  const engine = new SceneDisplayEngine();
  const root = node(1, 0, {
    position: [10, 0, 0],
    interaction: { typeId: 201, flags: 0, bytes: encoder.encode('root') },
  });
  const child = node(2, 1, { position: [2, 0, 0] });
  assert.deepEqual(engine.installBootstrap(bootstrap([root, child])).createIds, [1n, 2n]);
  assert.equal(engine.currentView().sceneMetadataCount, 1);
  assert.equal(
    new TextDecoder().decode(engine.currentView().getSceneMetadata(301).bytes),
    'topology',
  );

  const prepared = engine.prepareFrames([
    frame(1, [node(3, 2, { position: [1, 0, 0] })], { events: [event(1)] }),
  ]);
  assert.deepEqual(prepared.steps[0].plan.createIds, [3n]);
  assert.equal('events' in prepared.steps[0].plan, false);
  assert.equal(prepared.steps[0].events[0].eventId, 1n);
  assert.equal(engine.getNode(3n), null);
  validateAndCommit(prepared);

  const result = {
    position: new Float64Array(3),
    rotationXyzw: new Float64Array(4),
    scale: new Float64Array(3),
  };
  assert.equal(engine.getWorldPose(3n, result), true);
  assert.deepEqual([...result.position], [13, 0, 0]);
  assert.equal(engine.getNode(3n).parentDisplayId, 2n);
  assert.equal(new TextDecoder().decode(engine.getInteraction(1n).bytes), 'root');
});

test('prepared batch requires validation, commits once, and aborts without mutation', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  const prepared = engine.prepareFrames([frame(1, [node(1)])]);
  assert.equal(Object.isFrozen(prepared.steps), true);
  assert.equal(Object.isFrozen(prepared.steps[0].plan), true);
  assert.equal(engine.currentView().dynamicNodeCount, 0);
  assert.equal(prepared.steps[0].view.dynamicNodeCount, 1);
  assert.throws(
    () => prepared.commitValidated(),
    (error) => error.code === 'frame-batch-token-not-validated',
  );
  prepared.assertCommittable();
  assert.throws(
    () => prepared.assertCommittable(),
    (error) => error.code === 'frame-batch-token-not-prepared',
  );
  prepared.commitValidated();
  assert.equal(engine.currentView().dynamicNodeCount, 1);
  assert.throws(
    () => prepared.commitValidated(),
    (error) => error.code === 'frame-batch-token-not-validated',
  );
  assert.throws(
    () => prepared.abort(),
    (error) => error.code === 'frame-batch-token-settled',
  );

  const aborted = engine.prepareFrames([frame(2, [])]);
  aborted.abort();
  aborted.abort();
  assert.equal(engine.currentView().dynamicNodeCount, 1);
  assert.equal(engine.capture().lastFrameSeq, 1n);
});

test('assertCommittable fails closed after disposal', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  const prepared = engine.prepareFrames([frame(1, [node(1)])]);
  engine.dispose();
  assert.throws(
    () => prepared.assertCommittable(),
    (error) => error instanceof SceneDisplayEngineError && error.code === 'scene-tree-disposed',
  );
  prepared.abort();
});

test('frame batches are non-empty, bounded, ordered, and keep events outside plans', () => {
  const engine = new SceneDisplayEngine({ limits: { maximumFramesPerBatch: 4 } });
  engine.installBootstrap(bootstrap());
  assert.throws(() => engine.prepareFrames([]), (error) => error.code === 'frame-batch-empty');
  assert.throws(
    () => engine.prepareFrames([
      frame(1, []), frame(2, []), frame(3, []), frame(4, []), frame(5, []),
    ]),
    (error) => error.code === 'frame-batch-limit-exceeded',
  );

  const prepared = engine.prepareFrames([
    frame(1, [node(1)], { events: [event(1)] }),
    frame(2, [], { events: [event(2)] }),
    frame(3, [node(2)], { events: [event(3)] }),
    frame(4, [], { events: [event(4)] }),
  ]);
  assert.deepEqual(prepared.steps.map(({ events }) => events[0].eventId), [1n, 2n, 3n, 4n]);
  assert.equal(prepared.steps.every(({ plan }) => !('events' in plan)), true);
  assert.deepEqual(prepared.steps[0].plan.createIds, [1n]);
  assert.deepEqual(prepared.steps[1].plan.removeIds, [1n]);
  assert.equal(prepared.steps[0].view.getNode(1n).displayId, 1n);
  assert.equal(prepared.steps[1].view.getNode(1n), null);
  assert.equal(prepared.steps[2].view.getNode(2n).displayId, 2n);
  assert.equal(prepared.steps[3].view.getNode(2n), null);
  validateAndCommit(prepared);
  const capture = engine.capture();
  assert.equal(capture.lastFrameSeq, 4n);
  assert.equal(capture.metrics.committedFrames, 4);
  assert.equal(capture.metrics.committedFrameBatches, 1);
  assert.equal('lastCorrelationSeq' in capture, false);
  assert.equal('committedCorrelations' in capture.metrics, false);
  assert.equal('resets' in capture.metrics, false);
});

test('normalized event payloads own independent minimal byte copies', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  const backing = new Uint8Array([99, 10, 20, 30, 88]);
  const borrowedPayload = backing.subarray(1, 4);
  const shared = { ...event(1), payload: borrowedPayload };
  const prepared = engine.prepareFrames([
    frame(1, [], { events: [shared, { ...shared, eventId: 2n }] }),
  ]);
  const normalized = prepared.steps[0].events;

  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalized.every((value) => Object.isFrozen(value)), true);
  assert.notStrictEqual(normalized[0].payload, borrowedPayload);
  assert.notStrictEqual(normalized[0].payload, normalized[1].payload);
  assert.equal(normalized[0].payload.byteOffset, 0);
  assert.equal(normalized[0].payload.buffer.byteLength, borrowedPayload.byteLength);
  assert.deepEqual([...normalized[0].payload], [10, 20, 30]);
  assert.deepEqual([...normalized[1].payload], [10, 20, 30]);

  backing[2] = 200;
  normalized[0].payload[0] = 40;
  assert.deepEqual([...borrowedPayload], [10, 200, 30]);
  assert.deepEqual([...normalized[0].payload], [40, 20, 30]);
  assert.deepEqual([...normalized[1].payload], [10, 20, 30]);
  prepared.abort();
});

test('retained event bytes stay isolated across asynchronous delivery and later events', async () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  const borrowedPayload = new Uint8Array([7, 8, 9]);
  const first = engine.prepareFrames([
    frame(1, [], { events: [{ ...event(1), payload: borrowedPayload }] }),
  ]);
  const retained = first.steps[0].events[0].payload;
  validateAndCommit(first);

  retained[0] = 70;
  assert.deepEqual([...borrowedPayload], [7, 8, 9]);
  const second = engine.prepareFrames([
    frame(2, [], { events: [{ ...event(2), payload: borrowedPayload }] }),
  ]);
  const later = second.steps[0].events[0].payload;
  borrowedPayload.fill(0);
  await Promise.resolve();

  assert.deepEqual([...retained], [70, 8, 9]);
  assert.deepEqual([...later], [7, 8, 9]);
  second.abort();
});

test('linear merge emits changes and scalar max-seen rejects reappearance', () => {
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap([node(1), node(2, 1)]));
  validateAndCommit(engine.prepareFrames([frame(1, [node(3, 2), node(4, 0)])]));
  const changed = engine.prepareFrames([frame(2, [node(4, 2, {
    position: [4, 0, 0],
    flags: 0,
    visualTypeId: 2,
    profile: { typeId: 102, flags: 0, bytes: encoder.encode('changed') },
    animationStateId: 1,
    animationStartTick: 2,
    animationFlags: 1,
  })])]);
  const { plan } = changed.steps[0];
  assert.deepEqual(plan.removeIds, [3n]);
  assert.deepEqual(plan.reparentIds, [4n]);
  assert.deepEqual(plan.localPoseDirtyIds, [4n]);
  assert.deepEqual(plan.visibilityDirtyIds, [4n]);
  assert.deepEqual(plan.visualReplaceIds, [4n]);
  assert.deepEqual(plan.profileStateDirtyIds, [4n]);
  assert.deepEqual(plan.animationDirtyIds, [4n]);
  validateAndCommit(changed);
  assert.throws(
    () => engine.prepareFrames([frame(3, [
      node(3, 2),
      node(4, 2, {
        visualTypeId: 2,
        profile: { typeId: 102, flags: 0, bytes: encoder.encode('changed') },
      }),
    ])]),
    (error) => error instanceof SceneDisplayEngineError && error.code === 'display-id-reused',
  );
});

test('facade rejects dangling parents, cycles/order, excessive depth, and invalid payloads', () => {
  assert.throws(
    () => new SceneDisplayEngine().installBootstrap(bootstrap([node(2, 1)])),
    (error) => error.code === 'dangling-parent',
  );
  assert.throws(
    () => new SceneDisplayEngine().installBootstrap(bootstrap([node(1, 2), node(2, 1)])),
    (error) => error.code === 'node-order-or-parent-invalid',
  );
  assert.throws(
    () => new SceneDisplayEngine({ limits: { maximumTreeDepth: 2 } })
      .installBootstrap(bootstrap([node(1), node(2, 1), node(3, 2)])),
    (error) => error.code === 'tree-depth-exceeded',
  );
  assert.throws(
    () => new SceneDisplayEngine().installBootstrap(bootstrap([
      node(1, 0, { scale: [1, 0, 1] }),
    ])),
    (error) => error.code === 'node-scale-invalid',
  );
  assert.throws(
    () => new SceneDisplayEngine().installBootstrap(bootstrap([node(1, 0, { profile: null })])),
    (error) => error.code === 'profile-type-mismatch',
  );
  const engine = new SceneDisplayEngine();
  engine.installBootstrap(bootstrap());
  assert.throws(
    () => engine.prepareFrames([frame(1, [node(1, 0, { interaction: null })])]),
    (error) => error.code === 'interaction-type-mismatch',
  );
});

test('animation sampling is tick-based and contains no seconds conversion', () => {
  const sampled = samplePresentationAnimation({
    animationStateId: 7,
    animationStartTick: 60n,
    durationTicks: 120n,
    flags: 1,
    sourceTick: 150n,
  });
  assert.deepEqual(sampled, {
    animationStateId: 7,
    elapsedTicks: 90n,
    flags: 1,
    phase: 0.75,
    sourceTick: 150n,
  });
  assert.equal('elapsedSeconds' in sampled, false);
});

test('5000 nodes across 60 frames stay in a bounded dense typed-store pool', () => {
  const count = 5000;
  const engine = new SceneDisplayEngine({
    limits: { maximumNodes: count, maximumFramesPerBatch: 8 },
  });
  engine.installBootstrap(bootstrap([], count));
  for (let sequence = 1; sequence <= 60; sequence += 1) {
    validateAndCommit(engine.prepareFrames([syntheticFrame(sequence, count)]));
  }
  const capture = engine.capture();
  assert.equal(capture.dynamicNodeCount, count);
  assert.equal(capture.maxSeenDisplayId, BigInt(count));
  assert.equal(capture.denseDynamicStoreCount, 3);
  assert.equal(capture.dynamicStoreCapacity, count);
  assert.equal(capture.residentNodeObjectCount, 0);
  assert.equal(capture.residentPoseObjectCount, 0);
  assert.equal(capture.metrics.committedFrames, 60);
  assert.equal(capture.metrics.committedFrameBatches, 60);
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
    readProfileStateAt(_index, out) {
      out.typeId = 101;
      out.flags = 0;
      out.bytes = EMPTY_BYTES;
      return true;
    },
    readInteractionAt(_index, out) {
      out.typeId = 201;
      out.flags = 0;
      out.bytes = EMPTY_BYTES;
      return true;
    },
    eventCount: 0,
    eventAt() { throw new Error('unreachable'); },
  };
}
