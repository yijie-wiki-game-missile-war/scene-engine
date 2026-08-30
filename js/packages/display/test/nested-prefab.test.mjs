import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Component,
  PREFAB_DEFINITION_SCHEMA,
  definePrefab,
} from '../src/index.js';
import { IDENTITY, commitAuthority, createHarness, matrixPosition, matrixTransform } from './helpers.mjs';

class NestedProbeComponent extends Component {
  static typeId = 'test.nested-probe@1';
}

function transformAt(x, y = 0, z = 0) {
  return matrixTransform({ position: [x, y, z] });
}

function configureProbe(registry) {
  registry.register({
    ComponentClass: NestedProbeComponent,
    normalizeProperties(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some((key) => !['variant', 'value'].includes(key))
          || typeof value.variant !== 'string' || value.variant.length === 0
          || !Number.isSafeInteger(value.value)) {
        const error = new Error('nested probe properties are invalid');
        error.code = 'test-nested-probe-properties-invalid';
        throw error;
      }
      return Object.freeze({ variant: value.variant, value: value.value });
    },
    resourceReferences: () => [],
  });
}

function leafPrefab({ id, variant, bodyTransform = IDENTITY }) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    gameplayType: `test.${variant}`,
    root: {
      components: [],
      children: [{
        localName: 'body',
        transform: bodyTransform,
        visible: true,
        components: [{
          key: 'probe',
          type: NestedProbeComponent.typeId,
          properties: { variant, value: 0 },
        }],
        children: [],
      }],
    },
    resolveState(state) {
      return {
        nodes: {
          body: {
            visible: state.bodyVisible ?? true,
            ...(Object.hasOwn(state, 'bodyTransform')
              ? { transform: state.bodyTransform } : {}),
          },
        },
        components: {
          'body/probe': { value: state.value ?? 0 },
        },
      };
    },
  });
}

function fixedThreeLevelPrefabs() {
  const leaf = leafPrefab({
    id: 'nested/fixed-leaf',
    variant: 'fixed-leaf',
    bodyTransform: transformAt(5),
  });
  const middle = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/fixed-middle',
    gameplayType: 'test.fixed-middle',
    root: {
      components: [],
      children: [{
        localName: 'branch',
        transform: transformAt(3),
        visible: true,
        components: [],
        children: [],
      }],
    },
    prefabInstances: [{
      key: 'leaf',
      parentLocalPath: 'branch',
      prefabId: leaf.id,
      transform: transformAt(4),
      visible: true,
      state: { value: 7 },
    }],
    resolveState(state) {
      return {
        nodes: {},
        components: {},
        prefabInstances: {
          leaf: { state: { value: state.leafValue ?? 7 } },
        },
      };
    },
  });
  const outer = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/fixed-outer',
    gameplayType: 'test.fixed-outer',
    root: {
      components: [],
      children: [{
        localName: 'mount',
        transform: transformAt(1),
        visible: true,
        components: [],
        children: [],
      }],
    },
    prefabInstances: [{
      key: 'middle',
      parentLocalPath: 'mount',
      prefabId: middle.id,
      transform: transformAt(2),
      visible: true,
      state: { leafValue: 7 },
    }],
    resolveState(state) {
      const prefabInstances = {};
      if (Object.hasOwn(state, 'middle')) prefabInstances.middle = state.middle;
      return { nodes: {}, components: {}, prefabInstances };
    },
  });
  return { leaf, middle, outer };
}

function dynamicPrefabs({ maximumInstances = 3 } = {}) {
  const leafA = leafPrefab({ id: 'nested/slot-leaf-a', variant: 'slot-leaf-a' });
  const leafB = leafPrefab({ id: 'nested/slot-leaf-b', variant: 'slot-leaf-b' });
  const outer = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: `nested/slot-owner-${maximumInstances}`,
    gameplayType: `test.slot-owner-${maximumInstances}`,
    root: {
      components: [],
      children: [{
        localName: 'mount',
        transform: transformAt(2),
        visible: true,
        components: [],
        children: [],
      }],
    },
    prefabSlots: [{
      key: 'units',
      parentLocalPath: 'mount',
      allowedPrefabIds: [leafA.id, leafB.id],
      maximumInstances,
    }],
    resolveState(state) {
      const patch = { nodes: {}, components: {} };
      if (state.omitSlots !== true) {
        patch.prefabSlots = { units: state.units ?? {} };
      }
      return patch;
    },
  });
  return { leafA, leafB, outer };
}

function authorityCommand(name, prefabId, state, transform = IDENTITY) {
  return {
    name,
    parentName: null,
    prefabId,
    transformMode: 'live',
    transform,
    visible: true,
    state,
  };
}

function nextCursor(runtime) {
  const previous = runtime.summary().cursor;
  return Object.freeze({
    commitSeq: previous.commitSeq + 1,
    sourceTick: previous.sourceTick + 1,
    lastCommandSeq: previous.lastCommandSeq + 1,
  });
}

test('three fixed Prefab levels expand into ordinary Nodes in the one live graph', async (t) => {
  const prefabs = fixedThreeLevelPrefabs();
  const { runtime } = await createHarness({
    prefabEntries: [prefabs.outer, prefabs.middle, prefabs.leaf],
    configureComponents: configureProbe,
  });
  t.after(() => runtime.dispose());

  commitAuthority(runtime, () => runtime.authority.createNode(
    authorityCommand('py/fixed', prefabs.outer.id, {}, transformAt(10)),
  ), { sourceTickDelta: 1 });

  const names = {
    owner: 'py/fixed',
    mount: 'prefab/py/fixed/mount',
    middle: 'prefab/py/fixed/middle',
    branch: 'prefab/py/fixed/middle/branch',
    leaf: 'prefab/py/fixed/middle/leaf',
    body: 'prefab/py/fixed/middle/leaf/body',
  };
  const view = runtime.currentView();
  assert.equal(view.getNode(names.middle).parentName, names.mount);
  assert.equal(view.getNode(names.branch).parentName, names.middle);
  assert.equal(view.getNode(names.leaf).parentName, names.branch);
  assert.equal(view.getNode(names.body).parentName, names.leaf);
  assert.deepEqual(matrixPosition(view.getWorldTransform(names.body)), [25, 0, 0]);
  assert.equal(view.getComponentState(names.body, 'probe').properties.value, 7);

  for (const name of Object.values(names)) {
    const node = runtime._nodeIndex.require(name);
    assert.equal(node.constructor.name, 'Node');
    assert.strictEqual(node._graph, runtime._nodeGraph);
    assert.equal(view.getAuthorityOwner(name), 'py/fixed');
  }
  assert.strictEqual(runtime._scene.nodeIndex, runtime._nodeIndex);
  assert.strictEqual(runtime._scene.nodeGraph, runtime._nodeGraph);

  const middleIdentity = runtime._nodeIndex.require(names.middle);
  const leafIdentity = runtime._nodeIndex.require(names.leaf);
  const probeIdentity = runtime._nodeIndex.require(names.body).requireComponent('probe');
  commitAuthority(runtime, () => runtime.authority.setNodeState({
    name: names.owner,
    state: {
      middle: {
        transform: transformAt(8),
        visible: false,
        state: { leafValue: 19 },
      },
    },
  }), { sourceTickDelta: 1 });

  assert.strictEqual(runtime._nodeIndex.require(names.middle), middleIdentity);
  assert.strictEqual(runtime._nodeIndex.require(names.leaf), leafIdentity);
  assert.strictEqual(runtime._nodeIndex.require(names.body).requireComponent('probe'), probeIdentity);
  assert.deepEqual(matrixPosition(runtime.currentView().getNode(names.middle).localTransform), [8, 0, 0]);
  assert.equal(runtime.currentView().getNode(names.middle).visibleSelf, false);
  assert.equal(runtime.currentView().getNode(names.body).visibleInHierarchy, false);
  assert.equal(runtime.currentView().getComponentState(names.body, 'probe').properties.value, 19);

  // A missing fixed override restores the declaration baseline, including complete child state.
  commitAuthority(runtime, () => runtime.authority.setNodeState({ name: names.owner, state: {} }),
    { sourceTickDelta: 1 });
  assert.strictEqual(runtime._nodeIndex.require(names.middle), middleIdentity);
  assert.deepEqual(matrixPosition(runtime.currentView().getNode(names.middle).localTransform), [2, 0, 0]);
  assert.equal(runtime.currentView().getNode(names.middle).visibleSelf, true);
  assert.equal(runtime.currentView().getComponentState(names.body, 'probe').properties.value, 7);
});

test('dynamic Prefab slots reconcile 0..N instances and retain only the same key/id identity',
  async (t) => {
    const prefabs = dynamicPrefabs();
    const { runtime } = await createHarness({
      prefabEntries: [prefabs.outer, prefabs.leafA, prefabs.leafB],
      configureComponents: configureProbe,
    });
    t.after(() => runtime.dispose());
    const owner = 'py/dynamic';
    const alpha = 'prefab/py/dynamic/units/alpha';
    const alphaBody = `${alpha}/body`;
    const bravo = 'prefab/py/dynamic/units/bravo';

    commitAuthority(runtime, () => runtime.authority.createNode(
      authorityCommand(owner, prefabs.outer.id, { units: {} }),
    ), { sourceTickDelta: 1 });
    assert.equal(runtime.currentView().getNode(alpha), null);

    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: owner,
      state: {
        units: {
          alpha: {
            prefabId: prefabs.leafA.id,
            transform: transformAt(1),
            visible: true,
            state: { value: 3 },
          },
        },
      },
    }), { sourceTickDelta: 1 });
    const alphaRootIdentity = runtime._nodeIndex.require(alpha);
    const alphaBodyIdentity = runtime._nodeIndex.require(alphaBody);
    const alphaProbeIdentity = alphaBodyIdentity.requireComponent('probe');
    assert.equal(runtime.currentView().getNode(alpha).parentName, 'prefab/py/dynamic/mount');
    assert.equal(runtime.currentView().getComponentState(alphaBody, 'probe').properties.value, 3);

    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: owner,
      state: {
        units: {
          alpha: {
            prefabId: prefabs.leafA.id,
            transform: transformAt(7),
            visible: false,
            state: { value: 9, bodyTransform: transformAt(4) },
          },
          bravo: {
            prefabId: prefabs.leafB.id,
            transform: transformAt(8),
            visible: true,
            state: { value: 12 },
          },
        },
      },
    }), { sourceTickDelta: 1 });
    assert.strictEqual(runtime._nodeIndex.require(alpha), alphaRootIdentity);
    assert.strictEqual(runtime._nodeIndex.require(alphaBody), alphaBodyIdentity);
    assert.strictEqual(runtime._nodeIndex.require(alphaBody).requireComponent('probe'), alphaProbeIdentity);
    assert.deepEqual(matrixPosition(runtime.currentView().getNode(alpha).localTransform), [7, 0, 0]);
    assert.equal(runtime.currentView().getNode(alpha).visibleSelf, false);
    assert.deepEqual(matrixPosition(runtime.currentView().getNode(alphaBody).localTransform), [4, 0, 0]);
    assert.equal(runtime.currentView().getComponentState(alphaBody, 'probe').properties.value, 9);
    assert.equal(runtime.currentView().getComponentState(`${bravo}/body`, 'probe').properties.variant,
      'slot-leaf-b');

    const removedBravo = runtime._nodeIndex.require(bravo);
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: owner,
      state: {
        units: {
          alpha: {
            prefabId: prefabs.leafB.id,
            transform: transformAt(11),
            visible: true,
            state: { value: 21 },
          },
        },
      },
    }), { sourceTickDelta: 1 });
    assert.equal(removedBravo.disposed, true);
    assert.equal(runtime.currentView().getNode(bravo), null);
    assert.notStrictEqual(runtime._nodeIndex.require(alpha), alphaRootIdentity);
    assert.equal(alphaRootIdentity.disposed, true);
    assert.equal(alphaBodyIdentity.disposed, true);
    assert.equal(alphaProbeIdentity.disposed, true);
    assert.equal(runtime.currentView().getComponentState(alphaBody, 'probe').properties.variant,
      'slot-leaf-b');
    assert.equal(runtime.currentView().getComponentState(alphaBody, 'probe').properties.value, 21);

    // Resolver omission means the complete desired set for every declared slot is empty.
    const replacedAlpha = runtime._nodeIndex.require(alpha);
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: owner,
      state: { omitSlots: true },
    }), { sourceTickDelta: 1 });
    assert.equal(runtime.currentView().getNode(alpha), null);
    assert.equal(replacedAlpha.disposed, true);
  });

test('a Scene static Prefab instance performs recursive dynamic initialization', async (t) => {
  const prefabs = dynamicPrefabs();
  const { runtime } = await createHarness({
    prefabEntries: [prefabs.outer, prefabs.leafA, prefabs.leafB],
    configureComponents: configureProbe,
    prefabInstances: [{
      localName: 'preview',
      parentLocalName: null,
      prefabId: prefabs.outer.id,
      transform: transformAt(10),
      visible: true,
      state: {
        units: {
          first: {
            prefabId: prefabs.leafA.id,
            transform: transformAt(3),
            visible: true,
            state: { value: 31 },
          },
          second: {
            prefabId: prefabs.leafB.id,
            transform: transformAt(4),
            visible: false,
            state: { value: 32 },
          },
        },
      },
    }],
  });
  t.after(() => runtime.dispose());

  const first = 'prefab/scene/main/preview/units/first';
  const second = 'prefab/scene/main/preview/units/second';
  assert.equal(runtime.currentView().getNode(first).parentName, 'prefab/scene/main/preview/mount');
  assert.equal(runtime.currentView().getNode(`${second}/body`).visibleInHierarchy, false);
  assert.equal(runtime.currentView().getComponentState(`${first}/body`, 'probe').properties.value, 31);
  assert.equal(runtime.currentView().getComponentState(`${second}/body`, 'probe').properties.value, 32);
  assert.equal(runtime.currentView().getAuthorityOwner(first), null);
  assert.strictEqual(runtime._nodeIndex.require(first)._graph, runtime._nodeGraph);
});

async function assertRejectedNestedStatePreservesLiveTree({ state, expectedCode,
  maximumInstances = 2 }) {
  const prefabs = dynamicPrefabs({ maximumInstances });
  const { runtime } = await createHarness({
    prefabEntries: [prefabs.outer, prefabs.leafA, prefabs.leafB],
    configureComponents: configureProbe,
  });
  const owner = 'py/atomic-nested';
  const rootName = 'prefab/py/atomic-nested/units/kept';
  const bodyName = `${rootName}/body`;
  commitAuthority(runtime, () => runtime.authority.createNode(authorityCommand(
    owner,
    prefabs.outer.id,
    { units: { kept: { prefabId: prefabs.leafA.id, state: { value: 41 } } } },
  )), { sourceTickDelta: 1 });
  const before = runtime.summary();
  const authority = runtime._nodeIndex.require(owner).requireComponent('authority');
  const authorityState = authority.state;
  const root = runtime._nodeIndex.require(rootName);
  const body = runtime._nodeIndex.require(bodyName);
  const probe = body.requireComponent('probe');
  const properties = probe.properties;
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  let caught = null;
  try {
    runtime.authority.setNodeState({ name: owner, state: state(prefabs) });
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, null, 'nested candidate must fail');
  assert.equal(caught.code, expectedCode);
  assert.strictEqual(runtime._nodeIndex.require(rootName), root);
  assert.strictEqual(runtime._nodeIndex.require(bodyName), body);
  assert.strictEqual(body.requireComponent('probe'), probe);
  assert.strictEqual(probe.properties, properties);
  assert.strictEqual(authority.state, authorityState);
  assert.equal(probe.properties.value, 41);
  assert.equal(root.disposed, false);
  assert.equal(body.disposed, false);
  assert.equal(probe.disposed, false);
  assert.deepEqual(runtime.summary().cursor, before.cursor);
  assert.equal(runtime.summary().nodeCount, before.nodeCount);
  runtime.commitGate.fail(caught);
  await runtime.dispose();
}

test('invalid nested allowlist, count, and child state candidates cause zero live mutation',
  async (t) => {
    await t.test('allowlist', () => assertRejectedNestedStatePreservesLiveTree({
      state: () => ({
        units: {
          kept: { prefabId: 'nested/not-allowed', state: { value: 99 } },
        },
      }),
      expectedCode: 'display-prefab-instance-id-not-allowed',
    }));
    await t.test('maximum instance count', () => assertRejectedNestedStatePreservesLiveTree({
      maximumInstances: 2,
      state: (prefabs) => ({
        units: {
          kept: { prefabId: prefabs.leafA.id, state: { value: 99 } },
          second: { prefabId: prefabs.leafA.id, state: { value: 1 } },
          third: { prefabId: prefabs.leafB.id, state: { value: 2 } },
        },
      }),
      expectedCode: 'display-prefab-instance-count-limit',
    }));
    await t.test('deep child state', () => assertRejectedNestedStatePreservesLiveTree({
      state: (prefabs) => ({
        units: {
          kept: { prefabId: prefabs.leafA.id, state: { value: 'invalid' } },
        },
      }),
      expectedCode: 'test-nested-probe-properties-invalid',
    }));
  });

test('runtime disposal releases every recursively expanded Node and Component exactly once',
  async () => {
    const prefabs = dynamicPrefabs();
    const { runtime } = await createHarness({
      prefabEntries: [prefabs.outer, prefabs.leafA, prefabs.leafB],
      configureComponents: configureProbe,
    });
    commitAuthority(runtime, () => runtime.authority.createNode(authorityCommand(
      'py/cleanup',
      prefabs.outer.id,
      {
        units: {
          first: { prefabId: prefabs.leafA.id, state: { value: 1 } },
          second: { prefabId: prefabs.leafB.id, state: { value: 2 } },
        },
      },
    )), { sourceTickDelta: 1 });
    const index = runtime._nodeIndex;
    const nodes = [...index.values()];
    const components = nodes.flatMap((node) => [...node._components.values()]);

    const firstDispose = runtime.dispose();
    assert.strictEqual(runtime.dispose(), firstDispose);
    await firstDispose;

    assert.equal(index.size, 0);
    assert.equal(nodes.every((node) => node.disposed), true);
    assert.equal(components.every((component) => component.disposed), true);
  });
