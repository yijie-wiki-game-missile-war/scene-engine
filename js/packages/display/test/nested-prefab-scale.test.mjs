import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  BehaviourComponent,
  PREFAB_DEFINITION_SCHEMA,
  definePrefab,
} from '../src/index.js';
import { IDENTITY, commitAuthority, createHarness } from './helpers.mjs';

const SCALE_CHILD_COUNT = 640;
const PHASE_TIMEOUT_MS = 15_000;

class ScaleProbeBehaviour extends BehaviourComponent {
  static typeId = 'test.nested-scale-probe@1';
  static tickPhase = 'update';
  tick() {}
}

class StageProbeBehaviour extends BehaviourComponent {
  static typeId = 'test.nested-stage-probe@1';
  static tickPhase = 'update';
  static constructed = new Set();

  constructor(options) {
    super(options);
    StageProbeBehaviour.constructed.add(this);
  }

  onAttach() {
    if (this.properties.failure === 'attach') {
      const error = new Error(`staged attach rejected: ${this.properties.tag}`);
      error.code = 'test-nested-stage-attach-failed';
      throw error;
    }
  }

  tick() {}
}

function configureScaleProbe(registry) {
  registry.register({
    ComponentClass: ScaleProbeBehaviour,
    normalizeProperties(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some((key) => key !== 'value')
          || !Number.isSafeInteger(value.value)) {
        throw new TypeError('scale probe properties are invalid');
      }
      return Object.freeze({ value: value.value });
    },
    resourceReferences: () => [],
  });
}

function configureStageProbe(registry) {
  registry.register({
    ComponentClass: StageProbeBehaviour,
    normalizeProperties(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some((key) => !['tag', 'value', 'failure'].includes(key))
          || typeof value.tag !== 'string' || value.tag.length === 0
          || !Number.isSafeInteger(value.value)
          || ![null, 'attach'].includes(value.failure)) {
        throw new TypeError('stage probe properties are invalid');
      }
      return Object.freeze({ tag: value.tag, value: value.value, failure: value.failure });
    },
    resourceReferences: () => [],
  });
}

function dynamicOwner({ id, childPrefab, maximumInstances, gameplayType, resolveEntryState }) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    gameplayType,
    root: {
      components: [],
      children: [{
        localName: 'mount',
        transform: IDENTITY,
        visible: true,
        components: [],
        children: [],
      }],
    },
    prefabSlots: [{
      key: 'children',
      parentLocalPath: 'mount',
      allowedPrefabIds: [childPrefab.id],
      maximumInstances,
    }],
    resolveState(state) {
      return {
        nodes: {},
        components: {},
        prefabSlots: {
          children: Object.fromEntries(Object.entries(state.children ?? {}).map(([key, value]) => [
            key,
            {
              prefabId: childPrefab.id,
              state: resolveEntryState(value),
            },
          ])),
        },
      };
    },
  });
}

function authorityCommand(nodeId, displayKindId, state) {
  return {
    nodeId,
    parentNodeId: null,
    displayKindId,
    transformMode: 'live',
    transform: IDENTITY,
    visible: true,
    state,
  };
}

function scaleDefinitions() {
  const child = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/scale-child',
    gameplayType: 'test.nested-scale-child',
    root: {
      components: [{
        key: 'probe',
        type: ScaleProbeBehaviour.typeId,
        properties: { value: 0 },
      }],
      children: [],
    },
    resolveState(state) {
      return {
        nodes: {},
        components: { '$root/probe': { value: state.value } },
      };
    },
  });
  const owner = dynamicOwner({
    id: 'nested/scale-owner',
    gameplayType: 'test.nested-scale-owner',
    childPrefab: child,
    maximumInstances: SCALE_CHILD_COUNT + 1,
    resolveEntryState: (value) => ({ value }),
  });
  return { child, owner };
}

function scaleState({ start = 0, count = SCALE_CHILD_COUNT, valueOffset = 0 } = {}) {
  return {
    children: Object.fromEntries(Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return [`child-${String(index).padStart(4, '0')}`, index + valueOffset];
    })),
  };
}

function time(operation) {
  const started = performance.now();
  operation();
  return performance.now() - started;
}

function instrumentNodeIndex(index) {
  const originalValues = index.values.bind(index);
  const originalFindByPrefix = index.findByPrefix.bind(index);
  const counts = { values: 0, findByPrefix: 0 };
  index.values = (...args) => {
    counts.values += 1;
    return originalValues(...args);
  };
  index.findByPrefix = (...args) => {
    counts.findByPrefix += 1;
    return originalFindByPrefix(...args);
  };
  return {
    counts,
    reset() { counts.values = 0; counts.findByPrefix = 0; },
    restore() { index.values = originalValues; index.findByPrefix = originalFindByPrefix; },
  };
}

test('640 dynamic children reconcile by ledger identity without full NodeIndex scans', async (t) => {
  const definitions = scaleDefinitions();
  const { runtime, fakeBackends } = await createHarness({
    prefabEntries: [definitions.owner, definitions.child],
    configureComponents: configureScaleProbe,
  });
  t.after(() => runtime.dispose());
  const index = runtime._nodeIndex;
  const scheduler = runtime._scheduler;
  const animationSystem = runtime._animationSystem;
  const renderSystem = runtime._renderSystem;
  const fakeBackend = fakeBackends[0];
  const scans = instrumentNodeIndex(index);
  const durations = {};
  const ownerName = 'py/0';

  try {
    durations.initialize = time(() => commitAuthority(runtime, () => runtime.authority.createNode(
      authorityCommand(0, definitions.owner.id, scaleState()),
    ), { sourceTickDelta: 1 }));
    assert.deepEqual(scans.counts, { values: 0, findByPrefix: 0 });
    assert.equal(runtime.summary().nodeCount, SCALE_CHILD_COUNT + 5);
    assert.equal(scheduler._registered.size, SCALE_CHILD_COUNT);
    assert.equal(animationSystem._players.size, 0);
    assert.equal(renderSystem._entries.size, 1, 'the Scene camera is the only RenderComponent');

    const retainedName = 'prefab/py/0/children/child-0320';
    const retainedNode = index.require(retainedName);
    const retainedProbe = retainedNode.requireComponent('probe');
    scans.reset();
    durations.retain = time(() => commitAuthority(runtime, () => runtime.authority.setNodeState({
      nodeId: 0,
      state: scaleState({ valueOffset: 10_000 }),
    }), { sourceTickDelta: 1 }));
    assert.deepEqual(scans.counts, { values: 0, findByPrefix: 0 });
    assert.strictEqual(index.require(retainedName), retainedNode);
    assert.strictEqual(index.require(retainedName).requireComponent('probe'), retainedProbe);
    assert.equal(retainedProbe.properties.value, 10_320);
    assert.equal(scheduler._registered.size, SCALE_CHILD_COUNT);

    const removedName = 'prefab/py/0/children/child-0000';
    const removedNode = index.require(removedName);
    const removedProbe = removedNode.requireComponent('probe');
    const plusOneMinusOne = scaleState({ start: 1, count: SCALE_CHILD_COUNT, valueOffset: 20_000 });
    scans.reset();
    durations.plusOneMinusOne = time(() => commitAuthority(
      runtime,
      () => runtime.authority.setNodeState({ nodeId: 0, state: plusOneMinusOne }),
      { sourceTickDelta: 1 },
    ));
    assert.deepEqual(scans.counts, { values: 0, findByPrefix: 0 });
    assert.equal(index.get(removedName), null);
    assert.equal(removedNode.disposed, true);
    assert.equal(removedProbe.disposed, true);
    assert.notEqual(index.get('prefab/py/0/children/child-0640'), null);
    assert.strictEqual(index.require(retainedName), retainedNode);
    assert.equal(scheduler._registered.size, SCALE_CHILD_COUNT);
    assert.equal(runtime.summary().nodeCount, SCALE_CHILD_COUNT + 5);

    for (const [phase, milliseconds] of Object.entries(durations)) {
      assert.ok(milliseconds < PHASE_TIMEOUT_MS,
        `${phase} took ${milliseconds.toFixed(1)}ms (limit ${PHASE_TIMEOUT_MS}ms)`);
    }
    t.diagnostic(`nested Prefab timings: ${JSON.stringify(Object.fromEntries(
      Object.entries(durations).map(([phase, milliseconds]) => [phase, +milliseconds.toFixed(2)]),
    ))} ms`);
  } finally {
    scans.restore();
  }

  const nodes = [...index.values()];
  const components = nodes.flatMap((node) => [...node._components.values()]);
  const disposal = runtime.dispose();
  assert.strictEqual(runtime.dispose(), disposal);
  await disposal;
  assert.equal(index.size, 0);
  assert.equal(nodes.every((node) => node.disposed), true);
  assert.equal(components.every((component) => component.disposed), true);
  assert.equal(scheduler._registered.size, 0);
  assert.equal(animationSystem._players.size, 0);
  assert.equal(renderSystem._entries.size, 0);
  assert.equal(fakeBackend.bindings.size, 0);
});

function stageDefinitions() {
  const child = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/stage-child',
    gameplayType: 'test.nested-stage-child',
    root: {
      components: [{
        key: 'probe',
        type: StageProbeBehaviour.typeId,
        properties: { tag: 'base', value: 0, failure: null },
      }],
      children: [],
    },
    resolveState(state) {
      return {
        nodes: {},
        components: {
          '$root/probe': {
            tag: state.tag,
            value: state.value,
            failure: state.failure ?? null,
          },
        },
      };
    },
  });
  const owner = dynamicOwner({
    id: 'nested/stage-owner',
    gameplayType: 'test.nested-stage-owner',
    childPrefab: child,
    maximumInstances: 8,
    resolveEntryState: (value) => value,
  });
  return { child, owner };
}

async function stageHarness() {
  const definitions = stageDefinitions();
  const harness = await createHarness({
    prefabEntries: [definitions.owner, definitions.child],
    configureComponents: configureStageProbe,
  });
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityCommand(
    0,
    definitions.owner.id,
    { children: { kept: { tag: 'kept', value: 1, failure: null } } },
  )), { sourceTickDelta: 1 });
  return { ...harness, definitions };
}

function nextCursor(runtime) {
  const previous = runtime.summary().cursor;
  return Object.freeze({
    commitSeq: previous.commitSeq + 1,
    sourceTick: previous.sourceTick + 1,
    lastCommandSeq: previous.lastCommandSeq + 1,
  });
}

function beginFailingNestedState(runtime, children) {
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  let caught = null;
  try {
    runtime.authority.setNodeState({ nodeId: 0, state: { children } });
  } catch (error) {
    caught = error;
  }
  return { cursor, caught };
}

function assertStagedFailureIsAtomic(runtime, before, staged) {
  const keptName = 'prefab/py/0/children/kept';
  assert.strictEqual(runtime._nodeIndex.require(keptName), before.node);
  assert.strictEqual(runtime._nodeIndex.require(keptName).requireComponent('probe'), before.probe);
  assert.strictEqual(before.probe.properties, before.properties);
  assert.strictEqual(before.authority.state, before.authorityState);
  assert.equal(before.probe.properties.value, 1);
  for (const key of ['aa-first', 'bb-fails', 'cc-later']) {
    assert.equal(runtime._nodeIndex.get(`prefab/py/0/children/${key}`), null);
  }
  assert.equal(runtime.summary().nodeCount, before.nodeCount);
  assert.deepEqual(runtime.summary().cursor, before.cursor);
  assert.equal(runtime._scheduler._registered.size, 1);
  assert.equal(runtime._scheduler._registered.has(before.probe), true);
  assert.ok(staged.size >= 2, 'the failure must occur after at least one earlier child was staged');
  assert.equal([...staged].every((component) => component.disposed), true);
  assert.equal([...staged].some((component) => runtime._scheduler._registered.has(component)), false);
}

function captureLiveStageBaseline(runtime) {
  const node = runtime._nodeIndex.require('prefab/py/0/children/kept');
  const probe = node.requireComponent('probe');
  const authority = runtime._nodeIndex.require('py/0').requireComponent('authority');
  return {
    node,
    probe,
    properties: probe.properties,
    authority,
    authorityState: authority.state,
    nodeCount: runtime.summary().nodeCount,
    cursor: runtime.summary().cursor,
  };
}

test('a middle staged child attach failure disposes every earlier candidate with zero live mutation',
  async (t) => {
    const { runtime } = await stageHarness();
    t.after(() => runtime.dispose());
    const before = captureLiveStageBaseline(runtime);
    StageProbeBehaviour.constructed = new Set();
    const result = beginFailingNestedState(runtime, {
      'aa-first': { tag: 'aa-first', value: 2, failure: null },
      'bb-fails': { tag: 'bb-fails', value: 3, failure: 'attach' },
      'cc-later': { tag: 'cc-later', value: 4, failure: null },
      kept: { tag: 'kept', value: 99, failure: null },
    });
    assert.equal(result.caught?.code, 'test-nested-stage-attach-failed');
    assertStagedFailureIsAtomic(runtime, before, StageProbeBehaviour.constructed);
    runtime.commitGate.fail(result.caught);
    await runtime.dispose();
  });

test('a late staged child adoption failure rolls back earlier adopted registrations and Nodes',
  async (t) => {
    const { runtime } = await stageHarness();
    t.after(() => runtime.dispose());
    const before = captureLiveStageBaseline(runtime);
    StageProbeBehaviour.constructed = new Set();
    const originalAttached = runtime._componentAttached.bind(runtime);
    const failure = new Error('late nested adoption rejected');
    failure.code = 'test-nested-stage-adoption-failed';
    runtime._componentAttached = (component) => {
      originalAttached(component);
      if (component instanceof StageProbeBehaviour && component.properties.tag === 'bb-fails') {
        throw failure;
      }
    };
    const result = beginFailingNestedState(runtime, {
      'aa-first': { tag: 'aa-first', value: 2, failure: null },
      'bb-fails': { tag: 'bb-fails', value: 3, failure: null },
      'cc-later': { tag: 'cc-later', value: 4, failure: null },
      kept: { tag: 'kept', value: 99, failure: null },
    });
    runtime._componentAttached = originalAttached;
    assert.strictEqual(result.caught, failure);
    assertStagedFailureIsAtomic(runtime, before, StageProbeBehaviour.constructed);
    runtime.commitGate.fail(result.caught);
    await runtime.dispose();
  });
