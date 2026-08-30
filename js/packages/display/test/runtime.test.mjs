import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnimationPlayerComponent,
  BehaviourComponent,
  DISPLAY_SUMMARY_SCHEMA,
  PREFAB_DEFINITION_SCHEMA,
  RenderComponent,
  defineFrameAnimation,
  definePrefab,
} from '../src/index.js';
import { createFakeRenderBackend } from '../src/testing/fake-render-backend.js';
import { IDENTITY, commitAuthority, createHarness, emptyPrefab,
  matrixPosition, matrixTransform } from './helpers.mjs';

function createCommand(nodeId, prefabId = 'target.test.item', parentNodeId = null,
  transformMode = 'live') {
  return {
    nodeId, parentNodeId, prefabId, transformMode, transform: IDENTITY, visible: true, state: {},
  };
}

function nextCursor(runtime, { sourceTickDelta = 1, commandCount = 1 } = {}) {
  const previous = runtime.summary().cursor;
  return Object.freeze({
    commitSeq: previous.commitSeq + 1,
    sourceTick: previous.sourceTick + sourceTickDelta,
    lastCommandSeq: previous.lastCommandSeq + commandCount,
  });
}

function expectAuthorityFailure(runtime, mutate, expected) {
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  let error = null;
  try { mutate(); } catch (caught) { error = caught; }
  assert.notEqual(error, null, 'Authority mutation must fail');
  if (typeof expected === 'string') assert.equal(error.code, expected);
  else assert.equal(error instanceof expected, true);
  runtime.commitGate.fail(error);
  return error;
}

test('Authority create uses one Node graph and initial mode rejects later transform', async (t) => {
  const { runtime, installReturn } = await createHarness(); t.after(() => runtime.dispose());
  assert.equal(installReturn, runtime, 'installScene is a synchronous checkpoint barrier');
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0, 'target.test.item', null, 'initial'),
  ), { sourceTickDelta: 1 });
  assert.equal(runtime.currentView().getNode('prefab/py/0/body').parentName, 'py/0');
  assert.equal(runtime.currentView().getAuthorityOwner('prefab/py/0/body'), 'py/0');
  expectAuthorityFailure(runtime, () => runtime.authority.setNodeTransform({
    nodeId: 0, transform: matrixTransform({ position: [1, 0, 0] }),
  }), 'display-authority-transform-initial');
  assert.deepEqual(matrixPosition(runtime.currentView().getNode('py/0').localTransform), [0, 0, 0]);
});

test('Authority rejects a transform command for an initial-only node before mutation', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => {
    runtime.authority.createNode(createCommand(0));
    runtime.authority.createNode(createCommand(1, 'target.test.item', null, 'initial'));
  }, { sourceTickDelta: 1, commandCount: 2 });

  expectAuthorityFailure(runtime, () => runtime.authority.setNodeTransform({
    nodeId: 1, transform: matrixTransform({ position: [1, 0, 0] }),
  }), 'display-authority-transform-initial');
  assert.deepEqual(runtime.currentView().getNode('py/1').localTransform, IDENTITY);
});

test('malformed test transform batch leaves the Node and revision unchanged', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(createCommand(0)), {
    sourceTickDelta: 1,
  });
  const before = runtime.summary();

  expectAuthorityFailure(runtime, () => runtime.authority.setNodeTransform({
    nodeId: 0, transform: {
      position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1],
    },
  }), 'display-authority-transform-batch-invalid');
  assert.deepEqual(runtime.currentView().getNode('py/0').localTransform, IDENTITY);
  assert.equal(runtime.summary().revision, before.revision);
});

test('derived world overflow fails seal before the ACK cursor advances', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  const localScale = matrixTransform({ scale: [1000, 1000, 1000] });
  commitAuthority(runtime, () => {
    let parentNodeId = null;
    for (let index = 0; index < 101; index += 1) {
      runtime.authority.createNode({
        ...createCommand(index, 'target.test.item', parentNodeId),
        transform: localScale,
      });
      parentNodeId = index;
    }
  }, { sourceTickDelta: 1, commandCount: 101 });

  const acknowledged = runtime.summary().cursor;
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  runtime.authority.setNodeTransform({
    nodeId: 0,
    transform: matrixTransform({ scale: [1e10, 1e10, 1e10] }),
  });
  let error = null;
  try { runtime.commitGate.seal(cursor); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'display-transform-world-nonfinite');
  assert.deepEqual(runtime.summary().cursor, acknowledged);
  runtime.commitGate.fail(error);
  assert.deepEqual(runtime.summary().cursor, acknowledged);
  assert.equal(runtime.summary().health, 'projection-invalid');
});

test('activated Authority rejects every mutation outside the active commit gate', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  const before = runtime.summary();
  assert.throws(() => runtime.authority.createNode(createCommand(0)),
    { code: 'display-authority-outside-commit' });
  assert.deepEqual(runtime.summary(), before);
  assert.equal(runtime.currentView().getNode('py/0'), null);
});

test('installScene rejects an asynchronous backend factory', async () => {
  const fake = createFakeRenderBackend();
  await assert.rejects(createHarness({ backendFactory: () => Promise.resolve(fake.backend) }),
    { code: 'display-render-backend-factory-async' });
});

test('backend factory health bridge drives DisplayRuntime health', async (t) => {
  const fake = createFakeRenderBackend();
  const health = [];
  let reportBackendHealth = null;
  const { runtime } = await createHarness({
    backendFactory(options) {
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.equal(typeof options.onHealth, 'function');
      reportBackendHealth = options.onHealth;
      return fake.backend;
    },
    onHealth: (event) => health.push(event),
  });
  t.after(() => runtime.dispose());
  reportBackendHealth({
    phase: 'resource-load',
    nodeName: 'scene/main/camera',
    componentKey: 'camera',
    resourceId: 'model/missing',
    errorCode: 'three-resource-load-failed',
    recoverable: true,
  });
  assert.equal(runtime.currentView().health, 'renderer-unhealthy');
  assert.deepEqual(health.at(-1), {
    severity: 'error',
    code: 'three-resource-load-failed',
    message: 'three-resource-load-failed',
    nodeName: 'scene/main/camera',
    componentType: null,
    componentKey: 'camera',
    resourceId: 'model/missing',
    phase: 'resource-load',
    recoverable: true,
  });
});

test('Authority remove rejects a named authority descendant without mutation', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => {
    runtime.authority.createNode(createCommand(0));
    runtime.authority.createNode(createCommand(1, 'target.test.item', 0));
  }, { sourceTickDelta: 1, commandCount: 2 });
  expectAuthorityFailure(runtime, () => runtime.authority.removeNode({ nodeId: 0 }),
    'display-authority-descendant-exists');
  assert.equal(runtime.currentView().getNode('py/1').parentName, 'py/0');
  assert.notEqual(runtime.currentView().getNode('py/0'), null);
});

test('state resolver validates the whole patch before changing any target', async (t) => {
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'target.stateful', gameplayType: 'test.stateful',
    root: { components: [], children: [{
      localName: 'body', visible: true, transform: IDENTITY,
      components: [{
        key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/good' },
      }], children: [],
    }] },
    resolveState(state) {
      return {
        nodes: { body: { visible: state.visible } },
        components: { 'body/model': { modelResourceId: state.modelResourceId } },
      };
    },
  });
  const { runtime } = await createHarness({
    resources: [
      { id: 'model/good', kind: 'model', url: './good.glb' },
      { id: 'texture/wrong', kind: 'texture', url: './wrong.png' },
    ],
    prefabEntries: [prefab],
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode({
    ...createCommand(0, prefab.id),
    state: { visible: true, modelResourceId: 'model/good' },
  }), { sourceTickDelta: 1 });
  expectAuthorityFailure(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { visible: false, modelResourceId: 'model/missing' },
  }), 'display-resource-missing');
  assert.equal(runtime.currentView().getNode('prefab/py/0/body').visibleSelf, true);
  assert.equal(runtime.currentView().getComponentState('prefab/py/0/body', 'model')
    .properties.modelResourceId, 'model/good');
});

test('nested renderer state fails before cursor seal or backend update', async (t) => {
  const prefab = emptyPrefab({
    id: 'target.animated',
    gameplayType: 'test.animated',
    childComponents: [{
      key: 'model',
      type: 'render.model@2',
      properties: {
        modelResourceId: 'model/animated',
        materialOverrides: { tintRgba: 0xff00_00ff, opacity: 1, emissive: 0,
          alphaMode: 'opaque', alphaCutoff: 0 },
      },
    }],
    resolveState(state) {
      return { nodes: {}, components: { 'body/model': { materialOverrides: state.materialOverrides } } };
    },
  });
  const { runtime, fakeBackends } = await createHarness({
    resources: [{
      id: 'model/animated', kind: 'model', url: './animated.glb',
    }],
    prefabEntries: [prefab],
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode({
    ...createCommand(0, prefab.id),
    state: { materialOverrides: { tintRgba: 0xff00_00ff, opacity: 1, emissive: 0,
      alphaMode: 'opaque', alphaCutoff: 0 } },
  }), { sourceTickDelta: 1 });
  await runtime.whenReady();

  const before = runtime.summary();
  const component = runtime._nodeIndex.require('prefab/py/0/body').requireComponent('model');
  const propertiesBefore = component.properties;
  const backendCallsBefore = fakeBackends[0].calls.length;

  expectAuthorityFailure(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { materialOverrides: { tintRgba: -1 } },
  }), 'display-component-properties-invalid');

  assert.deepEqual(runtime.summary().cursor, before.cursor);
  assert.strictEqual(component.properties, propertiesBefore);
  assert.equal(fakeBackends[0].calls.length, backendCallsBefore);
  assert.equal(runtime.summary().health, 'projection-invalid');
});

test('invalid resource patch leaves RenderSystem dirty, draw, and lease state unchanged', async (t) => {
  const fake = createFakeRenderBackend();
  const leases = new Map();
  let leaseAcquisitions = 0; let leaseReleases = 0;
  const resourceIds = (componentType, properties) => componentType === 'render.model@2'
    ? [properties.modelResourceId] : [];
  const replaceLeases = (binding, nextIds) => {
    const previousIds = leases.get(binding) ?? [];
    if (previousIds.length === nextIds.length
        && previousIds.every((id, index) => id === nextIds[index])) return;
    leaseReleases += previousIds.length;
    leaseAcquisitions += nextIds.length;
    leases.set(binding, Object.freeze([...nextIds]));
  };
  const backend = {
    ...fake.backend,
    createBinding(descriptor) {
      const binding = fake.backend.createBinding(descriptor);
      const ids = resourceIds(descriptor.componentType, descriptor.properties);
      leases.set(binding, Object.freeze([...ids]));
      leaseAcquisitions += ids.length;
      return binding;
    },
    updateBinding(binding, patch) {
      replaceLeases(binding, resourceIds(binding.descriptor.componentType, patch.properties));
      return fake.backend.updateBinding(binding, patch);
    },
    destroyBinding(binding) {
      const ids = leases.get(binding) ?? [];
      leaseReleases += ids.length;
      leases.delete(binding);
      return fake.backend.destroyBinding(binding);
    },
    diagnostics() {
      return {
        ...fake.backend.diagnostics(),
        resourceLeaseCount: [...leases.values()].reduce((count, ids) => count + ids.length, 0),
        resourceLeaseAcquisitions: leaseAcquisitions,
        resourceLeaseReleases: leaseReleases,
      };
    },
    dispose() {
      for (const ids of leases.values()) leaseReleases += ids.length;
      leases.clear();
      return fake.backend.dispose();
    },
  };
  const prefab = emptyPrefab({
    id: 'target.atomic-resource',
    gameplayType: 'test.atomic-resource',
    childComponents: [{
      key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/good' },
    }],
    resolveState(state) {
      return { nodes: {}, components: { 'body/model': { modelResourceId: state.modelResourceId } } };
    },
  });
  const { runtime, frames } = await createHarness({
    resources: [{ id: 'model/good', kind: 'model', url: './good.glb' }],
    prefabEntries: [prefab],
    backendFactory: () => backend,
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode({
    ...createCommand(0, prefab.id),
    state: { modelResourceId: 'model/good' },
  }), { sourceTickDelta: 1 });
  runtime.start();
  frames.step();

  const component = runtime._nodeIndex.require('prefab/py/0/body')
    .requireComponent('model');
  const renderEntry = runtime._renderSystem._entries.get(component);
  assert.equal(renderEntry.dirty, false);
  assert.equal(runtime._drawRequested, false);
  assert.equal(frames.pending, 0);
  const propertiesBefore = component.properties;
  const bindingBefore = renderEntry.binding;
  const diagnosticsBefore = backend.diagnostics();
  const backendCallCountBefore = fake.calls.length;

  expectAuthorityFailure(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { modelResourceId: 'model/missing' },
  }), 'display-resource-missing');

  assert.strictEqual(component.properties, propertiesBefore);
  assert.strictEqual(renderEntry.binding, bindingBefore);
  assert.equal(renderEntry.dirty, false);
  assert.equal(runtime._drawRequested, false);
  assert.equal(frames.pending, 0);
  assert.equal(fake.calls.length, backendCallCountBefore);
  assert.deepEqual(backend.diagnostics(), diagnosticsBefore);
});

test('validated state patches install normalized properties exactly once before mutation', async (t) => {
  class StatefulBehaviour extends BehaviourComponent { static typeId = 'test.normalized-state@1'; }
  let armed = false; let armedCalls = 0;
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'target.normalized-state', gameplayType: 'test.normalized-state',
    root: { components: [], children: [{
      localName: 'body', visible: true, transform: IDENTITY,
      components: [{ key: 'state', type: StatefulBehaviour.typeId, properties: { value: 0 } }],
      children: [],
    }] },
    resolveState(state) {
      return { nodes: { body: { visible: state.visible } },
        components: { 'body/state': { value: state.value } } };
    },
  });
  const { runtime } = await createHarness({
    configureComponents: (registry) => registry.register({
      ComponentClass: StatefulBehaviour,
      normalizeProperties(value) {
        if (armed && ++armedCalls > 1) throw new Error('normalizer ran twice');
        return { value: value.value };
      },
      resourceReferences: () => [],
    }),
    prefabEntries: [prefab],
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode({
    ...createCommand(0, prefab.id), state: { visible: true, value: 0 },
  }), { sourceTickDelta: 1 });
  armed = true;
  commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { visible: false, value: 2 },
  }), { sourceTickDelta: 1 });
  assert.equal(armedCalls, 1);
  assert.equal(runtime.currentView().getNode('prefab/py/0/body').visibleSelf, false);
  assert.equal(runtime.currentView().getComponentState('prefab/py/0/body', 'state').properties.value, 2);
});

test('replaceNodePrefab stages a private shadow scope and preserves authority children', async (t) => {
  const first = emptyPrefab({ id: 'target.first', gameplayType: 'test.first', childName: 'first' });
  const second = emptyPrefab({ id: 'target.second', gameplayType: 'test.second', childName: 'second' });
  const { runtime } = await createHarness({ prefabEntries: [
    first,
    second,
  ] });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => {
    runtime.authority.createNode(createCommand(0, first.id));
    runtime.authority.createNode(createCommand(1, first.id, 0));
    runtime.authority.replaceNodePrefab({ nodeId: 0, prefabId: second.id, state: {} });
  }, { sourceTickDelta: 1, commandCount: 3 });
  assert.equal(runtime.currentView().getNode('prefab/py/0/first'), null);
  assert.equal(runtime.currentView().getNode('prefab/py/0/second').parentName, 'py/0');
  assert.equal(runtime.currentView().getNode('py/1').parentName, 'py/0');
});

test('replacement onAttach sees the final root childNames including preserved authority children',
  async (t) => {
    let observedChildNames = null;
    class AuthorityChildCandidateProbe extends BehaviourComponent {
      static typeId = 'test.authority-child-candidate-probe@1';

      onAttach(display) {
        observedChildNames = [...display.nodes.require('py/0').childNames];
      }
    }
    const original = emptyPrefab({
      id: 'target.candidate-authority-old',
      gameplayType: 'test.candidate-authority-old',
      childName: 'old',
    });
    const replacement = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'target.candidate-authority-new',
      gameplayType: 'test.candidate-authority-new',
      root: {
        components: [{
          key: 'probe', type: AuthorityChildCandidateProbe.typeId, properties: {},
        }],
        children: [{
          localName: 'new', transform: IDENTITY, visible: true, components: [], children: [],
        }],
      },
    });
    const { runtime } = await createHarness({
      configureComponents: (registry) => registry.register({
        ComponentClass: AuthorityChildCandidateProbe,
      }),
      prefabEntries: [original, replacement],
    });
    t.after(() => runtime.dispose());
    commitAuthority(runtime, () => {
      runtime.authority.createNode(createCommand(0, original.id));
      runtime.authority.createNode(createCommand(1, original.id, 0));
    }, { sourceTickDelta: 1, commandCount: 2 });

    commitAuthority(runtime, () => runtime.authority.replaceNodePrefab({
      nodeId: 0, prefabId: replacement.id, state: {},
    }), { sourceTickDelta: 1 });

    const expected = ['prefab/py/0/new', 'py/1'];
    assert.deepEqual(observedChildNames, expected);
    assert.deepEqual(runtime.currentView().getNode('py/0').childNames, expected);
    const scope = runtime._prefabInstantiator.getScope(
      runtime._nodeIndex.require('py/0'),
    );
    assert.strictEqual(scope.componentContext, runtime._componentContext);
    assert.equal(scope.shadowParent, null);
    assert.equal(scope.shadowNodeIndex, null);
  });

test('shadow adoption uses the non-virtual live registration path for every component kind',
  async (t) => {
    let shadowMethodCalls = 0;
    class ShadowBehaviour extends BehaviourComponent {
      static typeId = 'test.shadow-behaviour@1';
      static tickPhase = 'update';
      _adoptContext = () => { shadowMethodCalls += 1; };
      tick() {}
    }
    class ShadowPlayer extends AnimationPlayerComponent {
      static typeId = 'test.shadow-player@1';
      _adoptContext = () => { shadowMethodCalls += 1; };
    }
    class ShadowRender extends RenderComponent {
      static typeId = 'render.shadow@1';
      _adoptContext = () => { shadowMethodCalls += 1; };
    }
    const original = emptyPrefab({ id: 'target.adopt-old', gameplayType: 'test.adopt-old' });
    const replacement = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'target.adopt-new',
      gameplayType: 'test.adopt-new',
      root: {
        components: [
          { key: 'behaviour', type: ShadowBehaviour.typeId, properties: {} },
          { key: 'animator', type: ShadowPlayer.typeId,
            properties: { animationId: 'anim.shadow' } },
        ],
        children: [{
          localName: 'body', transform: IDENTITY, visible: true,
          components: [
            { key: 'sprite', type: 'render.sprite@3', properties: {
              textureResourceId: 'tex.shadow', width: 1, height: 1, frame: 0,
            } },
            { key: 'custom-render', type: ShadowRender.typeId, properties: {} },
          ],
          children: [],
        }],
      },
    });
    const animation = defineFrameAnimation({
      id: 'anim.shadow', target: { node: 'body', component: 'sprite' },
      frames: [0, 1], fps: 10, loop: true,
    });
    const { runtime } = await createHarness({
      resources: [
        { id: 'tex.shadow', kind: 'texture-atlas', url: './shadow.png', columns: 2, rows: 1 },
        animation,
      ],
      configureComponents(registry) {
        registry.register({ ComponentClass: ShadowBehaviour });
        registry.register({
          ComponentClass: ShadowPlayer,
          normalizeProperties: (value) => Object.freeze({ animationId: value.animationId ?? null }),
          resourceReferences: ({ animationId }) => animationId === null ? []
            : [{ id: animationId, kinds: ['animation'] }],
        });
        registry.register({ ComponentClass: ShadowRender,
          normalizeProperties: () => Object.freeze({}) });
      },
      prefabEntries: [original, replacement],
    });
    t.after(() => runtime.dispose());
    commitAuthority(runtime, () => runtime.authority.createNode(
      createCommand(0, original.id),
    ), { sourceTickDelta: 1 });
    commitAuthority(runtime, () => runtime.authority.replaceNodePrefab({
      nodeId: 0, prefabId: replacement.id, state: {},
    }), { sourceTickDelta: 1 });

    const root = runtime._nodeIndex.require('py/0');
    const body = runtime._nodeIndex.require('prefab/py/0/body');
    const behaviour = root.requireComponent('behaviour');
    const player = root.requireComponent('animator');
    const render = body.requireComponent('custom-render');
    assert.equal(shadowMethodCalls, 0);
    assert.equal(runtime._scheduler._registered.has(behaviour), true);
    assert.equal(runtime._animationSystem._players.has(player), true);
    assert.equal(runtime._renderSystem._entries.has(render), true);
  });

test('replacement adoption failure restores the complete old live scope', async (t) => {
  class AdoptionProbe extends BehaviourComponent {
    static typeId = 'test.adoption-probe@1';
    static tickPhase = 'update';
    static allowMultiple = true;
    tick() {}
  }
  const original = emptyPrefab({
    id: 'target.atomic-adopt-old', gameplayType: 'test.atomic-adopt-old',
    childComponents: [
      { key: 'old', type: AdoptionProbe.typeId, properties: {} },
      { key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/adopt' } },
    ],
  });
  const replacement = emptyPrefab({
    id: 'target.atomic-adopt-new', gameplayType: 'test.atomic-adopt-new',
    childComponents: [
      { key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/adopt' } },
      { key: 'first', type: AdoptionProbe.typeId, properties: {} },
      { key: 'fail', type: AdoptionProbe.typeId, properties: {} },
    ],
  });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/adopt', kind: 'model', url: './adopt.glb' }],
    configureComponents: (registry) => registry.register({ ComponentClass: AdoptionProbe }),
    prefabEntries: [original, replacement],
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0, original.id),
  ), { sourceTickDelta: 1 });
  const oldRoot = runtime._nodeIndex.require('py/0');
  const oldBody = runtime._nodeIndex.require('prefab/py/0/body');
  const oldComponent = oldBody.requireComponent('old');
  const oldRender = oldBody.requireComponent('model');
  const originalAttached = runtime._componentAttached.bind(runtime);
  const failure = new Error('live adoption rejected');
  runtime._componentAttached = (component) => {
    originalAttached(component);
    if (component.key === 'fail') throw failure;
  };

  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  let caught = null;
  try {
    runtime.authority.replaceNodePrefab({
      nodeId: 0, prefabId: replacement.id, state: {},
    });
  } catch (error) { caught = error; }
  runtime._componentAttached = originalAttached;
  assert.strictEqual(caught, failure);
  assert.strictEqual(runtime._nodeIndex.require('py/0'), oldRoot);
  assert.strictEqual(runtime._nodeIndex.require('prefab/py/0/body'), oldBody);
  assert.strictEqual(oldBody.requireComponent('old'), oldComponent);
  assert.equal(oldComponent.disposed, false);
  assert.equal(runtime._scheduler._registered.has(oldComponent), true);
  assert.equal(runtime._renderSystem._entries.has(oldRender), true);
  assert.equal([...runtime._scheduler._registered]
    .some((component) => component.key === 'first' || component.key === 'fail'), false);
  runtime.commitGate.fail(caught);
});

test('replacement adoption rollback restores interleaved Prefab and authority sibling order',
  async (t) => {
    class OrderAdoptionProbe extends BehaviourComponent {
      static typeId = 'test.order-adoption-probe@1';
      static allowMultiple = true;
    }
    const nested = emptyPrefab({
      id: 'target.order-nested', gameplayType: 'test.order-nested', childName: null,
    });
    const original = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'target.order-old',
      gameplayType: 'test.order-old',
      root: {
        components: [],
        children: [{
          localName: 'fixed', transform: IDENTITY, visible: true, components: [], children: [],
        }],
      },
      prefabSlots: [{
        key: 'units',
        parentLocalPath: null,
        allowedPrefabIds: [nested.id],
        maximumInstances: 2,
      }],
      resolveState(state) {
        return {
          prefabSlots: {
            units: {
              ...(state.alpha ? { alpha: { prefabId: nested.id } } : {}),
              ...(state.bravo ? { bravo: { prefabId: nested.id } } : {}),
            },
          },
        };
      },
    });
    const replacement = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'target.order-new',
      gameplayType: 'test.order-new',
      root: {
        components: [
          { key: 'first', type: OrderAdoptionProbe.typeId, properties: {} },
          { key: 'fail', type: OrderAdoptionProbe.typeId, properties: {} },
        ],
        children: [],
      },
    });
    const { runtime } = await createHarness({
      configureComponents: (registry) => registry.register({
        ComponentClass: OrderAdoptionProbe,
      }),
      prefabEntries: [original, replacement, nested],
    });
    t.after(() => runtime.dispose());
    const rootName = 'py/0';
    commitAuthority(runtime, () => runtime.authority.createNode({
      ...createCommand(0, original.id), state: { alpha: false, bravo: false },
    }), { sourceTickDelta: 1 });
    commitAuthority(runtime, () => runtime.authority.createNode(
      createCommand(1, nested.id, 0),
    ), { sourceTickDelta: 1 });
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      nodeId: 0, state: { alpha: true, bravo: false },
    }), { sourceTickDelta: 1 });
    commitAuthority(runtime, () => runtime.authority.createNode(
      createCommand(2, nested.id, 0),
    ), { sourceTickDelta: 1 });
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      nodeId: 0, state: { alpha: true, bravo: true },
    }), { sourceTickDelta: 1 });

    const root = runtime._nodeIndex.require(rootName);
    const baselineChildren = [...root._children];
    const baselineNames = [
      `prefab/${rootName}/fixed`,
      'py/1',
      `prefab/${rootName}/units/alpha`,
      'py/2',
      `prefab/${rootName}/units/bravo`,
    ];
    assert.deepEqual(baselineChildren.map((node) => node.name), baselineNames);

    const originalAttached = runtime._componentAttached.bind(runtime);
    const failure = new Error('injected ordered adoption failure');
    runtime._componentAttached = (component) => {
      originalAttached(component);
      if (component.key === 'fail') throw failure;
    };
    let caught;
    try {
      caught = expectAuthorityFailure(runtime, () => runtime.authority.replaceNodePrefab({
        nodeId: 0, prefabId: replacement.id, state: {},
      }), Error);
    } finally {
      runtime._componentAttached = originalAttached;
    }

    assert.strictEqual(caught, failure);
    assert.strictEqual(runtime._nodeIndex.require(rootName), root);
    assert.deepEqual(root._children.map((node) => node.name), baselineNames);
    for (let index = 0; index < baselineChildren.length; index += 1) {
      assert.strictEqual(root._children[index], baselineChildren[index]);
      assert.strictEqual(baselineChildren[index].parent, root);
    }
    assert.equal(runtime._nodeIndex.get(`prefab/${rootName}/units/alpha`), baselineChildren[2]);
    assert.equal(runtime._nodeIndex.get(`prefab/${rootName}/units/bravo`), baselineChildren[4]);
  });

test('replacement shadow handlers cannot mutate live nodes through lookup capabilities', async (t) => {
  class EscapingBehaviour extends BehaviourComponent {
    static typeId = 'test.shadow-escape@1';
    onAttach(display) { display.nodeIndex.require('scene/main/camera').setVisible(false); }
  }
  const first = emptyPrefab({ id: 'target.safe-old', gameplayType: 'test.safe-old', childName: 'old' });
  const escaping = emptyPrefab({ id: 'target.escaping-new', gameplayType: 'test.escaping-new', childName: 'new',
    childComponents: [{ key: 'escape', type: EscapingBehaviour.typeId, properties: {} }] });
  const { runtime } = await createHarness({
    configureComponents: (registry) => registry.register({
      ComponentClass: EscapingBehaviour, normalizeProperties: () => ({}), resourceReferences: () => [],
    }),
    prefabEntries: [
      first,
      escaping,
    ],
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0, first.id),
  ), { sourceTickDelta: 1 });
  expectAuthorityFailure(runtime, () => runtime.authority.replaceNodePrefab({
    nodeId: 0, prefabId: escaping.id, state: {},
  }), TypeError);
  assert.equal(runtime.currentView().getNode('scene/main/camera').visibleSelf, true);
  assert(runtime.currentView().getNode('prefab/py/0/old'));
  assert.equal(runtime.currentView().getNode('prefab/py/0/new'), null);
});

test('each RenderComponent owns a (nodeName, componentKey) backend binding', async (t) => {
  const prefab = emptyPrefab({
    id: 'target.rendered', gameplayType: 'test.rendered', childName: 'body',
    childComponents: [
      { key: 'first', type: 'render.model@2', properties: { modelResourceId: 'model/a' } },
      { key: 'second', type: 'render.model@2', properties: { modelResourceId: 'model/a' } },
    ],
  });
  const { runtime, fakeBackends } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [prefab],
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0, prefab.id),
  ), { sourceTickDelta: 1 });
  await runtime.whenReady();
  assert(fakeBackends[0].bindings.has(JSON.stringify(['prefab/py/0/body', 'first'])));
  assert(fakeBackends[0].bindings.has(JSON.stringify(['prefab/py/0/body', 'second'])));
});

test('pending binding create cannot attach after its Node was removed', async (t) => {
  const prefab = emptyPrefab({
    id: 'target.pending', gameplayType: 'test.pending', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/a' } }],
  });
  const fake = createFakeRenderBackend({ asyncCreate: true });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [prefab],
    backendFactory: () => fake.backend,
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => {
    runtime.authority.createNode(createCommand(0, prefab.id));
    runtime.authority.removeNode({ nodeId: 0 });
  }, { sourceTickDelta: 1, commandCount: 2 });
  await runtime.whenReady();
  assert.equal(fake.bindings.has(JSON.stringify(['prefab/py/0/body', 'model'])), false);
});

test('same binding identity waits for a pending old create and its stale cleanup', async (t) => {
  const first = emptyPrefab({ id: 'target.pending-first', gameplayType: 'test.pending-first', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/a' } }] });
  const second = emptyPrefab({ id: 'target.pending-second', gameplayType: 'test.pending-second', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/a' } }] });
  const fake = createFakeRenderBackend({ asyncCreate: true });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [
      first,
      second,
    ],
    backendFactory: () => fake.backend,
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => {
    runtime.authority.createNode(createCommand(0, first.id));
    runtime.authority.replaceNodePrefab({
      nodeId: 0, prefabId: second.id, state: {},
    });
  }, { sourceTickDelta: 1, commandCount: 2 });
  await runtime.whenReady();
  const relevant = fake.calls.filter((call) => call[1] === 'prefab/py/0/body'
    && call[2] === 'model');
  assert.deepEqual(relevant.map((call) => call[0]), ['create', 'destroy', 'create']);
  assert(fake.bindings.has(JSON.stringify(['prefab/py/0/body', 'model'])));
});

test('an asynchronous null binding result makes renderer health fail closed', async (t) => {
  const fake = createFakeRenderBackend({ asyncCreate: true, resolveCreateNull: true });
  const health = [];
  const { runtime } = await createHarness({
    backendFactory: () => fake.backend,
    onHealth: (event) => health.push(event),
  });
  t.after(() => runtime.dispose());
  await assert.rejects(runtime.whenReady(), { code: 'display-render-binding-create-failed' });
  assert.equal(runtime.currentView().health, 'renderer-unhealthy');
  assert.equal(health.at(-1).code, 'display-render-binding-create-failed');
});

test('same binding identity waits for asynchronous old destroy before replacement create', async (t) => {
  const first = emptyPrefab({ id: 'target.render-first', gameplayType: 'test.render-first', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/a' } }] });
  const second = emptyPrefab({ id: 'target.render-second', gameplayType: 'test.render-second', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@2', properties: { modelResourceId: 'model/a' } }] });
  const fake = createFakeRenderBackend({ asyncDestroy: true });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [
      first,
      second,
    ],
    backendFactory: () => fake.backend,
  });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => {
    runtime.authority.createNode(createCommand(0, first.id));
    runtime.authority.replaceNodePrefab({ nodeId: 0, prefabId: second.id, state: {} });
  }, { sourceTickDelta: 1, commandCount: 2 });
  await runtime.whenReady();
  const relevant = fake.calls.filter((call) => call[1] === 'prefab/py/0/body' && call[2] === 'model');
  assert.deepEqual(relevant.map((call) => call[0]), ['create', 'destroy', 'create']);
  assert(fake.bindings.has(JSON.stringify(['prefab/py/0/body', 'model'])));
});

test('commitGate blocks draw until exact seal and fail makes projection invalid', async (t) => {
  const health = [];
  const { runtime, frames, fakeBackends } = await createHarness({ onHealth: (event) => health.push(event) });
  t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0),
  ), { sourceTickDelta: 1 });
  runtime.start();
  assert.equal(frames.pending, 1);
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  assert.equal(frames.pending, 0);
  runtime.authority.setNodeVisible({ nodeId: 0, visible: false });
  assert.equal(frames.pending, 0);
  assert.throws(() => runtime.commitGate.seal({ ...cursor, sourceTick: cursor.sourceTick + 1 }),
    { code: 'display-commit-gate-cursor-mismatch' });
  runtime.commitGate.seal(cursor);
  assert.equal(frames.pending, 1);
  frames.step();
  assert.equal(fakeBackends[0].lastFrame.sourceTick, cursor.sourceTick);

  const failedCursor = nextCursor(runtime);
  runtime.commitGate.begin(failedCursor);
  runtime.commitGate.fail(new Error('command failed'));
  assert.equal(runtime.currentView().health, 'projection-invalid');
  assert.equal(frames.pending, 0);
  assert.equal(health.at(-1).code, 'display-commit-failed');
});

test('currentView is an immutable cursor-bound projection', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0),
  ), { sourceTickDelta: 1 });
  const before = runtime.currentView();
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  runtime.authority.setNodeVisible({ nodeId: 0, visible: false });
  runtime.commitGate.seal(cursor);
  const after = runtime.currentView();
  assert.deepEqual(before.cursor, { commitSeq: 1, sourceTick: 1, lastCommandSeq: 1 });
  assert.equal(before.getNode('py/0').visibleSelf, true);
  assert.deepEqual(after.cursor, cursor);
  assert.equal(after.getNode('py/0').visibleSelf, false);
});

test('commitGate seal does not materialize a full DisplayView', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0),
  ), { sourceTickDelta: 1 });
  let fullIndexTraversals = 0;
  const values = runtime._nodeIndex.values.bind(runtime._nodeIndex);
  runtime._nodeIndex.values = (...args) => {
    fullIndexTraversals += 1;
    return values(...args);
  };
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  runtime.authority.setNodeVisible({ nodeId: 0, visible: false });
  assert.equal(runtime.commitGate.seal(cursor), undefined);
  assert.equal(fullIndexTraversals, 0);
  assert.equal(runtime.currentView().getNode('py/0').visibleSelf, false);
  assert.equal(fullIndexTraversals, 1);
});

test('summary is a fresh frozen O(1) record and never traverses Nodes or Components', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0),
  ), { sourceTickDelta: 1 });
  let nodeTraversals = 0;
  const values = runtime._nodeIndex.values.bind(runtime._nodeIndex);
  runtime._nodeIndex.values = (...args) => { nodeTraversals += 1; return values(...args); };
  for (const node of values()) {
    Object.defineProperty(node, 'components', {
      configurable: true,
      get() { throw new Error('summary traversed Component state'); },
    });
  }
  const first = runtime.summary();
  const second = runtime.summary();
  assert.notStrictEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(first, {
    schema: DISPLAY_SUMMARY_SCHEMA,
    sceneName: 'main',
    revision: 3,
    cursor: { commitSeq: 1, sourceTick: 1, lastCommandSeq: 1 },
    nodeCount: 5,
    health: 'ready',
  });
  assert.equal(nodeTraversals, 0);

  const installedNodes = runtime._nodeIndex._nodes;
  runtime._nodeIndex._nodes = new Map(Array.from({ length: 10_000 }, (_, index) => [
    `synthetic/${index}`,
    Object.freeze({}),
  ]));
  try {
    assert.equal(runtime.summary().nodeCount, 10_000);
    assert.equal(nodeTraversals, 0);
  } finally {
    runtime._nodeIndex._nodes = installedNodes;
  }
});

test('runtime excludes LocalEdit and rejects the removed authoring option', async () => {
  const { runtime } = await createHarness();
  assert.equal(['local', 'Edit'].join('') in runtime, false);
  await runtime.dispose();
  const removedOption = ['authoring', 'Mode'].join('');
  await assert.rejects(createHarness({ runtimeOptions: { [removedOption]: true } }),
    { code: 'display-options-invalid' });
});

test('a frame waits for its asynchronous active Camera binding', async (t) => {
  const fake = createFakeRenderBackend();
  let resolveCamera;
  const backend = {
    ...fake.backend,
    createBinding(descriptor) {
      const binding = fake.backend.createBinding(descriptor);
      if (descriptor.componentType !== 'render.camera@1') return binding;
      return new Promise((resolve) => { resolveCamera = () => resolve(binding); });
    },
  };
  const { runtime, frames } = await createHarness({ backendFactory: () => backend });
  t.after(() => runtime.dispose());
  runtime.start(); frames.step();
  assert.equal(fake.draws, 0);
  assert.equal(runtime.capture().frameIndex, 0);
  resolveCamera(); await runtime.whenReady();
  assert.equal(frames.pending, 1);
  frames.step();
  assert.equal(fake.draws, 1);
  assert.equal(runtime.capture().frameIndex, 1);
});

test('backend rebuild preserves Node state and remounts declarative bindings', async (t) => {
  const fakes = [];
  const backendFactory = () => { const fake = createFakeRenderBackend(); fakes.push(fake); return fake.backend; };
  const { runtime } = await createHarness({ backendFactory }); t.after(() => runtime.dispose());
  commitAuthority(runtime, () => runtime.authority.createNode(
    createCommand(0),
  ), { sourceTickDelta: 1 });
  const before = runtime.currentView().getNode('py/0').localTransform;
  await runtime.rebuildRenderBackend();
  assert.deepEqual(runtime.currentView().getNode('py/0').localTransform, before);
  assert.equal(fakes.length, 2);
  assert(fakes[1].bindings.has(JSON.stringify(['scene/main/camera', 'camera'])));
});

test('fixed panels send the same Node world matrix to the backend before and after rebuild', async (t) => {
  const prefab = emptyPrefab({ childComponents: [
    { key: 'facing', type: 'behavior.billboard@2', properties: { mode: 'continuous', axisMode: 'y-axis' } },
    { key: 'sprite', type: 'render.sprite@3', properties: { textureResourceId: 'texture/card', width: 2, height: 3 } },
  ] });
  const { runtime, frames, fakeBackends } = await createHarness({
    prefabEntries: [prefab], resources: [{ id: 'texture/card', kind: 'texture', url: './card.png' }],
    bootstrapAuthority(authority) {
      authority.createNode({ ...createCommand(0), transform: matrixTransform({
        position: [4, 2, -3], rotationXyzw: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [3, 1, 1],
      }) });
    },
  });
  t.after(() => runtime.dispose());
  runtime.start(); await runtime.whenReady(); frames.step();
  const name = 'prefab/py/0/body';
  const expected = Array.from(runtime.currentView().getWorldTransform(name));
  for (const [offset, axis] of [[4, [0, 1, 0]], [8, [0, 0, 1]]]) {
    const values = expected.slice(offset, offset + 3); const length = Math.hypot(...values);
    values.forEach((value, index) => assert.ok(Math.abs(value / length - axis[index]) < 1e-12));
  }
  const assertBinding = () => {
    const binding = fakeBackends.at(-1).bindings.get(JSON.stringify([name, 'sprite']));
    assert.deepEqual(Array.from(binding.patch.worldMatrix), expected);
    assert.deepEqual(binding.patch.panelAnchorWorld, [4, 2, -3]);
    assert.equal(runtime.summary().cursor.sourceTick, 0);
  };
  assertBinding();
  frames.step(1000); assertBinding();
  await runtime.rebuildRenderBackend(); await runtime.whenReady(); frames.step(); assertBinding();
});

test('sprite projection uses its fixed ancestor footpoint across authority moves and backend rebuild', async (t) => {
  const sprite = { key: 'sprite', type: 'render.sprite@3', properties: {
    textureResourceId: 'texture/card', width: 2, height: 3,
  } };
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'target.test.item', gameplayType: 'test.item',
    root: { components: [], children: [
      { localName: 'body', transform: matrixTransform({ position: [1, 0, 0] }),
        components: [{ key: 'facing', type: 'behavior.billboard@2',
          properties: { mode: 'continuous', axisMode: 'y-axis' } }],
        children: [{ localName: 'card', transform: matrixTransform({ position: [0.6, 1.2, 0] }),
          components: [sprite], children: [] }] },
      { localName: 'ground', components: [sprite], children: [] },
    ] },
  });
  const { runtime, frames, fakeBackends } = await createHarness({
    prefabEntries: [prefab], resources: [{ id: 'texture/card', kind: 'texture', url: './card.png' }],
    bootstrapAuthority(authority) {
      authority.createNode({ ...createCommand(0), transform: matrixTransform({
        position: [4, 2, -3], rotationXyzw: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 2, 2],
      }) });
    },
  });
  t.after(() => runtime.dispose());
  runtime.start(); await runtime.whenReady(); frames.step();
  const assertProjection = () => {
    const view = runtime.currentView();
    const bindings = fakeBackends.at(-1).bindings;
    const card = bindings.get(JSON.stringify(['prefab/py/0/body/card', 'sprite']));
    const foot = view.getWorldTransform('prefab/py/0/body');
    const center = view.getWorldTransform('prefab/py/0/body/card');
    assert.deepEqual(card.patch.panelAnchorWorld, matrixPosition(foot));
    assert.notDeepEqual(card.patch.panelAnchorWorld, matrixPosition(center));
    assert.deepEqual(Array.from(card.patch.worldMatrix), Array.from(center));
    assert.equal(bindings.get(JSON.stringify(['prefab/py/0/ground', 'sprite'])).patch.panelAnchorWorld, null);
    return card.patch.panelAnchorWorld;
  };
  const initial = assertProjection();
  commitAuthority(runtime, () => runtime.authority.setNodeTransform({
    nodeId: 0, transform: matrixTransform({ position: [9, 2, -3] }),
  }), { sourceTickDelta: 1 });
  frames.step();
  const moved = assertProjection();
  assert.notDeepEqual(initial, moved);
  await runtime.rebuildRenderBackend(); await runtime.whenReady(); frames.step();
  assert.deepEqual(assertProjection(), moved);
});

test('sprite panel anchors invalidate only from their nearest Billboard source', async (t) => {
  const spriteProperties = { textureResourceId: 'texture/card', width: 2, height: 3 };
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'target.test.item',
    gameplayType: 'test.item',
    root: { components: [], children: [{
      localName: 'outer',
      transform: matrixTransform({ position: [5, 0, 0] }),
      components: [
        { key: 'outer-facing', type: 'behavior.billboard@2', properties: {
          mode: 'initialize', axisMode: 'full', facing: 'fixed',
        } },
        { key: 'outer-sprite', type: 'render.sprite@3', properties: spriteProperties },
      ],
      children: [{
        localName: 'inner',
        transform: matrixTransform({ position: [2, 0, 0] }),
        components: [
          { key: 'inner-facing', type: 'behavior.billboard@2', properties: {
            mode: 'initialize', axisMode: 'full', facing: 'fixed',
          } },
          { key: 'inner-sprite', type: 'render.sprite@3', properties: spriteProperties },
        ],
        children: [],
      }],
    }] },
  });
  const { runtime, frames, fakeBackends, componentRegistry, resourceRegistry } = await createHarness({
    prefabEntries: [prefab],
    resources: [{ id: 'texture/card', kind: 'texture', url: './card.png' }],
    bootstrapAuthority(authority) {
      authority.createNode(createCommand(0));
    },
  });
  t.after(() => runtime.dispose());
  runtime.start(); await runtime.whenReady(); frames.step();

  const fake = fakeBackends[0];
  const outerName = 'prefab/py/0/outer';
  const innerName = 'prefab/py/0/outer/inner';
  const outer = runtime._nodeIndex.require(outerName);
  const inner = runtime._nodeIndex.require(innerName);
  const binding = (nodeName, componentKey) => fake.bindings.get(
    JSON.stringify([nodeName, componentKey]),
  );
  const outerBinding = () => binding(outerName, 'outer-sprite');
  const innerBinding = () => binding(innerName, 'inner-sprite');
  assert.deepEqual(outerBinding().patch.panelAnchorWorld, [5, 0, 0]);
  assert.deepEqual(innerBinding().patch.panelAnchorWorld, [7, 0, 0]);

  // A clean requested frame must not rediscover anchors by scanning every Sprite.
  const originalGetComponent = outer.getComponent;
  let cleanAnchorLookups = 0;
  outer.getComponent = function (...arguments_) {
    cleanAnchorLookups += 1;
    return originalGetComponent.apply(this, arguments_);
  };
  commitAuthority(runtime, () => {}, { sourceTickDelta: 1, commandCount: 0 });
  frames.step();
  outer.getComponent = originalGetComponent;
  assert.equal(cleanAnchorLookups, 0);

  const applyAndRender = (operation) => {
    const callIndex = fake.calls.length;
    operation();
    assert.equal(frames.pending, 1);
    frames.step();
    return fake.calls.slice(callIndex)
      .filter(([kind]) => kind === 'update')
      .map(([, nodeName, componentKey]) => [nodeName, componentKey]);
  };
  const outerFacing = outer.requireComponent('outer-facing');
  const innerFacing = inner.requireComponent('inner-facing');

  assert.deepEqual(applyAndRender(() => outerFacing.setEnabled(false)), [
    [outerName, 'outer-sprite'],
  ]);
  assert.equal(outerBinding().patch.panelAnchorWorld, null);
  assert.deepEqual(innerBinding().patch.panelAnchorWorld, [7, 0, 0]);

  assert.deepEqual(applyAndRender(() => outerFacing.setEnabled(true)), [
    [outerName, 'outer-sprite'],
  ]);
  assert.deepEqual(outerBinding().patch.panelAnchorWorld, [5, 0, 0]);

  assert.deepEqual(applyAndRender(() => componentRegistry.patchComponentProperties({
    component: outerFacing,
    patch: { facing: 'camera', cameraName: 'scene/main/camera' },
    resourceRegistry,
  })), [[outerName, 'outer-sprite']]);
  assert.equal(outerBinding().patch.panelAnchorWorld, null);
  assert.deepEqual(innerBinding().patch.panelAnchorWorld, [7, 0, 0]);

  assert.deepEqual(applyAndRender(() => componentRegistry.patchComponentProperties({
    component: outerFacing,
    patch: { facing: 'fixed', cameraName: null },
    resourceRegistry,
  })), [[outerName, 'outer-sprite']]);
  assert.deepEqual(outerBinding().patch.panelAnchorWorld, [5, 0, 0]);

  assert.deepEqual(applyAndRender(() => inner.removeComponent(innerFacing.key)), [
    [innerName, 'inner-sprite'],
  ]);
  assert.deepEqual(innerBinding().patch.panelAnchorWorld, [5, 0, 0]);

  const replacementFacing = componentRegistry.create(componentRegistry.compile({
    key: 'inner-facing-replacement',
    type: 'behavior.billboard@2',
    properties: {
      mode: 'initialize',
      axisMode: 'full',
      facing: 'camera',
      cameraName: 'scene/main/camera',
    },
  }, resourceRegistry));
  assert.deepEqual(applyAndRender(() => {
    inner.addComponent(replacementFacing);
    replacementFacing.attach(inner, runtime._componentContext);
  }), [[innerName, 'inner-sprite']]);
  assert.equal(innerBinding().patch.panelAnchorWorld, null);
});

test('rebuild cancels a never-settling old create before draining backend work', async (t) => {
  const first = createFakeRenderBackend(); const second = createFakeRenderBackend();
  let factoryCalls = 0; let firstDisposals = 0;
  const pendingBackend = {
    ...first.backend,
    createBinding(descriptor) {
      if (descriptor.componentType === 'render.camera@1') return new Promise(() => {});
      return first.backend.createBinding(descriptor);
    },
    async dispose() { firstDisposals += 1; return first.backend.dispose(); },
  };
  const { runtime } = await createHarness({
    backendFactory: () => factoryCalls++ === 0 ? pendingBackend : second.backend,
  });
  t.after(() => runtime.dispose());
  await runtime.rebuildRenderBackend();
  assert.equal(firstDisposals, 1);
  assert.equal(runtime.currentView().health, 'ready');
});

test('runtime disposal detaches the complete scene topology with one bulk forest operation', async () => {
  const { runtime } = await createHarness();
  const graph = runtime._nodeGraph;
  const detachForest = graph.detachForest.bind(graph);
  const detach = graph.detach.bind(graph);
  let forestCalls = 0; let singleCalls = 0;
  graph.detachForest = (...arguments_) => {
    forestCalls += 1;
    return detachForest(...arguments_);
  };
  graph.detach = (...arguments_) => {
    singleCalls += 1;
    return detach(...arguments_);
  };

  await runtime.dispose();

  assert.equal(forestCalls, 1);
  assert.equal(singleCalls, 1, 'only the parentless Scene root needs a single-node detach');
});

test('dispose is one completion barrier and health observers cannot interrupt cleanup', async () => {
  class NoisyDispose extends BehaviourComponent {
    static typeId = 'test.noisy-dispose@1';
    onDispose() { throw new Error('dispose hook failed'); }
  }
  let releaseBackend; let backendDisposals = 0;
  const barrier = new Promise((resolve) => { releaseBackend = resolve; });
  const fake = createFakeRenderBackend();
  const backend = { ...fake.backend, async dispose() {
    backendDisposals += 1; await barrier; return fake.backend.dispose();
  } };
  const { runtime } = await createHarness({
    backendFactory: () => backend,
    onHealth: () => { throw new Error('observer failed'); },
    configureComponents: (registry) => registry.register({
      ComponentClass: NoisyDispose, normalizeProperties: () => ({}), resourceReferences: () => [],
    }),
    sceneNodes: [{ localName: 'noisy', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'noisy', type: NoisyDispose.typeId, properties: {} }] }],
  });
  const authority = runtime.authority;
  const commitGate = runtime.commitGate;
  const retained = {
    scene: runtime._scene,
    loader: runtime._sceneLoader,
    instantiator: runtime._prefabInstantiator,
    nodeIndex: runtime._nodeIndex,
    scheduler: runtime._scheduler,
    renderSystem: runtime._renderSystem,
  };
  const first = runtime.dispose(); const second = runtime.dispose();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(runtime.summary().health, 'disposing');
  let completed = false; second.then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  releaseBackend(); await second;
  assert.equal(backendDisposals, 1);
  assert.equal(runtime.summary().health, 'disposed');
  assert.equal(runtime.summary().nodeCount, 0);
  assert.equal(retained.nodeIndex.size, 0);
  assert.equal(retained.scheduler._registered.size, 0);
  assert.equal(retained.renderSystem._entries.size, 0);
  assert.equal(retained.loader._scopes.length, 0);
  assert.equal(retained.loader._directComponents.length, 0);
  assert.equal(retained.loader._scene, null);
  assert.equal(retained.instantiator._scopes.size, 0);
  assert.equal(retained.instantiator._scene, null);
  assert.equal(retained.instantiator._componentContext, null);
  for (const key of [
    'rootNode', 'authorityRootNode', 'definition', 'compiledDefinition', 'loader',
    'activeCameraName', 'registries', 'nodeIndex', 'nodeGraph', 'scheduler', 'renderSystem',
  ]) assert.equal(retained.scene[key], null, `Scene.${key} must be released`);
  for (const key of [
    '_nodeIndex', '_scheduler', '_renderSystem', '_nodeGraph', '_scene', '_componentContext',
    '_prefabInstantiator', '_sceneLoader', '_hostElement', '_canvas', '_createRenderBackend',
  ]) assert.equal(runtime[key], null, `DisplayRuntime.${key} must be released`);
  assert.equal(runtime.authority, authority);
  assert.equal(runtime.commitGate, commitGate);
  assert.throws(() => authority.createNode(createCommand(0)),
    { code: 'display-disposed' });
  assert.throws(() => commitGate.begin({ commitSeq: 1, sourceTick: 1, lastCommandSeq: 1 }),
    { code: 'display-disposed' });
});

test('dispose wins an asynchronous rebuild and releases the orphan backend', async () => {
  const first = createFakeRenderBackend(); const orphan = createFakeRenderBackend();
  let factoryCalls = 0; let resolveFactory; let orphanDisposals = 0;
  const orphanBackend = { ...orphan.backend, dispose() {
    orphanDisposals += 1; return orphan.backend.dispose();
  } };
  const { runtime } = await createHarness({ backendFactory: () => {
    if (factoryCalls++ === 0) return first.backend;
    return new Promise((resolve) => { resolveFactory = resolve; });
  } });
  const rebuild = runtime.rebuildRenderBackend();
  assert.equal(runtime.rebuildRenderBackend(), rebuild);
  const disposal = runtime.dispose();
  resolveFactory(orphanBackend);
  await assert.rejects(rebuild, { code: 'display-disposed' });
  await disposal;
  assert.equal(orphanDisposals, 1);
  assert.equal(runtime.summary().health, 'disposed');
});

test('dispose cancels a rebuild after its candidate backend is installed', async () => {
  const first = createFakeRenderBackend(); const candidate = createFakeRenderBackend();
  let factoryCalls = 0; let candidateCreateCalled = false; let candidateSignal = null;
  let candidateDisposals = 0;
  const candidateBackend = {
    ...candidate.backend,
    createBinding(descriptor) {
      if (descriptor.componentType === 'render.camera@1') {
        candidateCreateCalled = true; candidateSignal = descriptor.signal;
        return new Promise(() => {});
      }
      return candidate.backend.createBinding(descriptor);
    },
    dispose() { candidateDisposals += 1; return candidate.backend.dispose(); },
  };
  const { runtime } = await createHarness({
    backendFactory: () => factoryCalls++ === 0 ? first.backend : candidateBackend,
  });
  const rebuild = runtime.rebuildRenderBackend();
  while (!candidateCreateCalled) await Promise.resolve();
  const disposal = runtime.dispose();
  await assert.rejects(rebuild);
  await disposal;
  assert.equal(candidateSignal.aborted, true);
  assert.equal(candidateDisposals, 1);
  assert.equal(runtime.summary().health, 'disposed');
});

test('runtime construction seals the catalog registries', async (t) => {
  const { runtime, prefabRegistry, resourceRegistry } = await createHarness();
  t.after(() => runtime.dispose());
  const late = emptyPrefab({ id: 'target.late', gameplayType: 'test.late' });
  assert.throws(() => prefabRegistry.register(late), { code: 'display-registry-sealed' });
  assert.throws(() => resourceRegistry.register({ id: 'model/late', kind: 'model', url: './late.glb' }),
    { code: 'display-registry-sealed' });
});

test('tick failure reports the component and stops all future frames', async (t) => {
  class ThrowingBehaviour extends BehaviourComponent {
    static typeId = 'test.throwing@1'; static tickPhase = 'update';
    tick() { throw new Error('tick exploded'); }
  }
  const health = [];
  const { runtime, frames } = await createHarness({
    onHealth: (event) => health.push(event),
    configureComponents: (registry) => registry.register({
      ComponentClass: ThrowingBehaviour,
      normalizeProperties: () => ({}),
      resourceReferences: () => [],
    }),
    sceneNodes: [{
      localName: 'thrower', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'thrower', type: ThrowingBehaviour.typeId, properties: {} }],
    }],
  });
  t.after(() => runtime.dispose());
  runtime.start(); frames.step();
  assert.equal(runtime.currentView().health, 'unhealthy');
  assert.equal(frames.pending, 0);
  assert.equal(health.at(-1).code, 'display-component-tick-failed');
  assert.equal(health.at(-1).componentType, ThrowingBehaviour.typeId);
});

test('scene attach rollback disposes child-before-parent across direct and prefab components', async () => {
  const events = [];
  class RootBehaviour extends BehaviourComponent {
    static typeId = 'test.rollback-root@1';
    onDispose() { events.push('root'); }
  }
  class ChildBehaviour extends BehaviourComponent {
    static typeId = 'test.rollback-child@1';
    onDispose() { events.push('child'); }
  }
  class FailingBehaviour extends BehaviourComponent {
    static typeId = 'test.rollback-failing@1';
    onAttach() { throw new Error('attach exploded'); }
    onDispose() { events.push('failure'); }
  }
  const configureComponents = (registry) => {
    for (const ComponentClass of [RootBehaviour, ChildBehaviour, FailingBehaviour]) {
      registry.register({ ComponentClass, normalizeProperties: () => ({}), resourceReferences: () => [] });
    }
  };
  await assert.rejects(createHarness({
    configureComponents,
    sceneNodes: [
      { localName: 'rollback-root', parentLocalName: null, transform: IDENTITY,
        components: [{ key: 'root', type: RootBehaviour.typeId, properties: {} }] },
      { localName: 'rollback-child', parentLocalName: 'rollback-root', transform: IDENTITY,
        components: [{ key: 'child', type: ChildBehaviour.typeId, properties: {} }] },
      { localName: 'rollback-failing', parentLocalName: 'rollback-root', transform: IDENTITY,
        components: [{ key: 'failing', type: FailingBehaviour.typeId, properties: {} }] },
    ],
  }), /attach exploded/);
  assert.deepEqual(events, ['failure', 'child', 'root']);
});
