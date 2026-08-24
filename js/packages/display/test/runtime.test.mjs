import assert from 'node:assert/strict';
import test from 'node:test';

import { BehaviourComponent, PREFAB_DEFINITION_SCHEMA, definePrefab } from '../src/index.js';
import { createFakeRenderBackend } from '../src/testing/fake-render-backend.js';
import { IDENTITY, createHarness, emptyPrefab } from './helpers.mjs';

function createCommand(name, prefabType = 'test.item', parentName = null, transformMode = 'live') {
  return { name, parentName, prefabType, transformMode, transform: IDENTITY, visible: true, state: {} };
}

test('Authority create uses one Node graph and initial mode rejects later transform', async (t) => {
  const { runtime, installReturn } = await createHarness(); t.after(() => runtime.dispose());
  assert.equal(installReturn, runtime, 'installScene is a synchronous checkpoint barrier');
  runtime.authority.createNode(createCommand('py/initial', 'test.item', null, 'initial'));
  assert.equal(runtime.currentView().getNode('prefab/py/initial/body').parentName, 'py/initial');
  assert.equal(runtime.currentView().getAuthorityOwner('prefab/py/initial/body'), 'py/initial');
  assert.throws(() => runtime.authority.setNodeTransform({
    name: 'py/initial', transform: { ...IDENTITY, position: [1, 0, 0] },
  }), { code: 'display-authority-transform-initial' });
  assert.deepEqual(runtime.currentView().getNode('py/initial').localTransform.position, [0, 0, 0]);
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
  runtime.authority.createNode(createCommand('py/parent'));
  runtime.authority.createNode(createCommand('py/child', 'test.item', 'py/parent'));
  assert.throws(() => runtime.authority.removeNode({ name: 'py/parent' }),
    { code: 'display-authority-descendant-exists' });
  assert.equal(runtime.currentView().getNode('py/child').parentName, 'py/parent');
  runtime.authority.removeNode({ name: 'py/child' });
  runtime.authority.removeNode({ name: 'py/parent' });
  assert.equal(runtime.currentView().getNode('py/parent'), null);
});

test('state resolver validates the whole patch before changing any target', async (t) => {
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'target.stateful', logicalType: 'test.stateful',
    root: { components: [], children: [{
      localName: 'body', visible: true, transform: IDENTITY,
      components: [{
        key: 'model', type: 'render.model@1', properties: { modelResourceId: 'model/good' },
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
    prefabEntries: [{ sceneProfile: 'test', logicalType: prefab.logicalType, definition: prefab }],
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode({ ...createCommand('py/stateful', prefab.logicalType),
    state: { visible: true, modelResourceId: 'model/good' } });
  assert.throws(() => runtime.authority.setNodeState({
    name: 'py/stateful', state: { visible: false, modelResourceId: 'model/missing' },
  }), { code: 'display-resource-missing' });
  assert.equal(runtime.currentView().getNode('prefab/py/stateful/body').visibleSelf, true);
  assert.equal(runtime.currentView().getComponentState('prefab/py/stateful/body', 'model')
    .properties.modelResourceId, 'model/good');
  assert.throws(() => runtime.authority.setNodeState({
    name: 'py/stateful', state: { visible: false, modelResourceId: 'texture/wrong' },
  }), { code: 'display-resource-reference-kind-invalid' });
  assert.equal(runtime.currentView().getNode('prefab/py/stateful/body').visibleSelf, true);
});

test('validated state patches install normalized properties exactly once before mutation', async (t) => {
  class StatefulBehaviour extends BehaviourComponent { static typeId = 'test.normalized-state@1'; }
  let armed = false; let armedCalls = 0;
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'target.normalized-state', logicalType: 'test.normalized-state',
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
    prefabEntries: [{ sceneProfile: 'test', logicalType: prefab.logicalType, definition: prefab }],
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode({ ...createCommand('py/state', prefab.logicalType),
    state: { visible: true, value: 0 } });
  armed = true;
  runtime.authority.setNodeState({ name: 'py/state', state: { visible: false, value: 2 } });
  assert.equal(armedCalls, 1);
  assert.equal(runtime.currentView().getNode('prefab/py/state/body').visibleSelf, false);
  assert.equal(runtime.currentView().getComponentState('prefab/py/state/body', 'state').properties.value, 2);
});

test('replaceNodePrefab stages a private shadow scope and preserves authority children', async (t) => {
  const first = emptyPrefab({ id: 'target.first', logicalType: 'test.first', childName: 'first' });
  const second = emptyPrefab({ id: 'target.second', logicalType: 'test.second', childName: 'second' });
  const { runtime } = await createHarness({ prefabEntries: [
    { sceneProfile: 'test', logicalType: first.logicalType, definition: first },
    { sceneProfile: 'test', logicalType: second.logicalType, definition: second },
  ] });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/root', first.logicalType));
  runtime.authority.createNode(createCommand('py/child', first.logicalType, 'py/root'));
  runtime.authority.replaceNodePrefab({ name: 'py/root', prefabType: second.logicalType, state: {} });
  assert.equal(runtime.currentView().getNode('prefab/py/root/first'), null);
  assert.equal(runtime.currentView().getNode('prefab/py/root/second').parentName, 'py/root');
  assert.equal(runtime.currentView().getNode('py/child').parentName, 'py/root');
});

test('replacement shadow handlers cannot mutate live nodes through lookup capabilities', async (t) => {
  class EscapingBehaviour extends BehaviourComponent {
    static typeId = 'test.shadow-escape@1';
    onAttach(context) { context.nodeIndex.require('scene/main/camera').setVisible(false); }
  }
  const first = emptyPrefab({ id: 'target.safe-old', logicalType: 'test.safe-old', childName: 'old' });
  const escaping = emptyPrefab({ id: 'target.escaping-new', logicalType: 'test.escaping-new', childName: 'new',
    childComponents: [{ key: 'escape', type: EscapingBehaviour.typeId, properties: {} }] });
  const { runtime } = await createHarness({
    configureComponents: (registry) => registry.register({
      ComponentClass: EscapingBehaviour, normalizeProperties: () => ({}), resourceReferences: () => [],
    }),
    prefabEntries: [
      { sceneProfile: 'test', logicalType: first.logicalType, definition: first },
      { sceneProfile: 'test', logicalType: escaping.logicalType, definition: escaping },
    ],
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/safe', first.logicalType));
  assert.throws(() => runtime.authority.replaceNodePrefab({
    name: 'py/safe', prefabType: escaping.logicalType, state: {},
  }), TypeError);
  assert.equal(runtime.currentView().getNode('scene/main/camera').visibleSelf, true);
  assert(runtime.currentView().getNode('prefab/py/safe/old'));
  assert.equal(runtime.currentView().getNode('prefab/py/safe/new'), null);
});

test('each RenderComponent owns a (nodeName, componentKey) backend binding', async (t) => {
  const prefab = emptyPrefab({
    id: 'target.rendered', logicalType: 'test.rendered', childName: 'body',
    childComponents: [
      { key: 'first', type: 'render.model@1', properties: { modelResourceId: 'model/a' } },
      { key: 'second', type: 'render.model@1', properties: { modelResourceId: 'model/a' } },
    ],
  });
  const { runtime, fakeBackends } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [{ sceneProfile: 'test', logicalType: prefab.logicalType, definition: prefab }],
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/rendered', prefab.logicalType));
  await runtime.whenReady();
  assert(fakeBackends[0].bindings.has(JSON.stringify(['prefab/py/rendered/body', 'first'])));
  assert(fakeBackends[0].bindings.has(JSON.stringify(['prefab/py/rendered/body', 'second'])));
});

test('pending binding create cannot attach after its Node was removed', async (t) => {
  const prefab = emptyPrefab({
    id: 'target.pending', logicalType: 'test.pending', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@1', properties: { modelResourceId: 'model/a' } }],
  });
  const fake = createFakeRenderBackend({ asyncCreate: true });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [{ sceneProfile: 'test', logicalType: prefab.logicalType, definition: prefab }],
    backendFactory: () => fake.backend,
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/pending', prefab.logicalType));
  runtime.authority.removeNode({ name: 'py/pending' });
  await runtime.whenReady();
  assert.equal(fake.bindings.has(JSON.stringify(['prefab/py/pending/body', 'model'])), false);
});

test('same binding identity waits for a pending old create and its stale cleanup', async (t) => {
  const first = emptyPrefab({ id: 'target.pending-first', logicalType: 'test.pending-first', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@1', properties: { modelResourceId: 'model/a' } }] });
  const second = emptyPrefab({ id: 'target.pending-second', logicalType: 'test.pending-second', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@1', properties: { modelResourceId: 'model/a' } }] });
  const fake = createFakeRenderBackend({ asyncCreate: true });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [
      { sceneProfile: 'test', logicalType: first.logicalType, definition: first },
      { sceneProfile: 'test', logicalType: second.logicalType, definition: second },
    ],
    backendFactory: () => fake.backend,
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/pending-reused', first.logicalType));
  runtime.authority.replaceNodePrefab({
    name: 'py/pending-reused', prefabType: second.logicalType, state: {},
  });
  await runtime.whenReady();
  const relevant = fake.calls.filter((call) => call[1] === 'prefab/py/pending-reused/body'
    && call[2] === 'model');
  assert.deepEqual(relevant.map((call) => call[0]), ['create', 'destroy', 'create']);
  assert(fake.bindings.has(JSON.stringify(['prefab/py/pending-reused/body', 'model'])));
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
  const first = emptyPrefab({ id: 'target.render-first', logicalType: 'test.render-first', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@1', properties: { modelResourceId: 'model/a' } }] });
  const second = emptyPrefab({ id: 'target.render-second', logicalType: 'test.render-second', childName: 'body',
    childComponents: [{ key: 'model', type: 'render.model@1', properties: { modelResourceId: 'model/a' } }] });
  const fake = createFakeRenderBackend({ asyncDestroy: true });
  const { runtime } = await createHarness({
    resources: [{ id: 'model/a', kind: 'model', url: './a.glb' }],
    prefabEntries: [
      { sceneProfile: 'test', logicalType: first.logicalType, definition: first },
      { sceneProfile: 'test', logicalType: second.logicalType, definition: second },
    ],
    backendFactory: () => fake.backend,
  });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/reused', first.logicalType));
  runtime.authority.replaceNodePrefab({ name: 'py/reused', prefabType: second.logicalType, state: {} });
  await runtime.whenReady();
  const relevant = fake.calls.filter((call) => call[1] === 'prefab/py/reused/body' && call[2] === 'model');
  assert.deepEqual(relevant.map((call) => call[0]), ['create', 'destroy', 'create']);
  assert(fake.bindings.has(JSON.stringify(['prefab/py/reused/body', 'model'])));
});

test('commitGate blocks draw until exact seal and fail makes projection invalid', async (t) => {
  const health = [];
  const { runtime, frames, fakeBackends } = await createHarness({ onHealth: (event) => health.push(event) });
  t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/gated'));
  runtime.start();
  assert.equal(frames.pending, 1);
  const cursor = { commitSeq: 1, sourceTick: 1, lastCommandSeq: 1 };
  runtime.commitGate.begin(cursor);
  assert.equal(frames.pending, 0);
  runtime.authority.setNodeVisible({ name: 'py/gated', visible: false });
  assert.equal(frames.pending, 0);
  assert.throws(() => runtime.commitGate.seal({ ...cursor, sourceTick: 2 }),
    { code: 'display-commit-gate-cursor-mismatch' });
  runtime.commitGate.seal(cursor);
  assert.equal(frames.pending, 1);
  frames.step();
  assert.equal(fakeBackends[0].lastFrame.sourceTick, 1);

  const failedCursor = { commitSeq: 2, sourceTick: 2, lastCommandSeq: 2 };
  runtime.commitGate.begin(failedCursor);
  runtime.commitGate.fail(new Error('command failed'));
  assert.equal(runtime.currentView().health, 'projection-invalid');
  assert.equal(frames.pending, 0);
  assert.equal(health.at(-1).code, 'display-commit-failed');
});

test('currentView is an immutable cursor-bound projection', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/view'));
  const before = runtime.currentView();
  const cursor = { commitSeq: 1, sourceTick: 1, lastCommandSeq: 1 };
  runtime.commitGate.begin(cursor);
  runtime.authority.setNodeVisible({ name: 'py/view', visible: false });
  runtime.commitGate.seal(cursor);
  const after = runtime.currentView();
  assert.deepEqual(before.cursor, { commitSeq: 0, sourceTick: 0, lastCommandSeq: 0 });
  assert.equal(before.getNode('py/view').visibleSelf, true);
  assert.deepEqual(after.cursor, cursor);
  assert.equal(after.getNode('py/view').visibleSelf, false);
});

test('commitGate seal does not materialize a full DisplayView', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  runtime.authority.createNode(createCommand('py/direct-index'));
  let fullIndexTraversals = 0;
  const values = runtime._nodeIndex.values.bind(runtime._nodeIndex);
  runtime._nodeIndex.values = (...args) => {
    fullIndexTraversals += 1;
    return values(...args);
  };
  const cursor = { commitSeq: 1, sourceTick: 1, lastCommandSeq: 1 };
  runtime.commitGate.begin(cursor);
  runtime.authority.setNodeVisible({ name: 'py/direct-index', visible: false });
  assert.equal(runtime.commitGate.seal(cursor), undefined);
  assert.equal(fullIndexTraversals, 0);
  assert.equal(runtime.currentView().getNode('py/direct-index').visibleSelf, false);
  assert.equal(fullIndexTraversals, 1);
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
  runtime.authority.createNode(createCommand('py/stable'));
  const before = runtime.currentView().getNode('py/stable').localTransform;
  await runtime.rebuildRenderBackend();
  assert.deepEqual(runtime.currentView().getNode('py/stable').localTransform, before);
  assert.equal(fakes.length, 2);
  assert(fakes[1].bindings.has(JSON.stringify(['scene/main/camera', 'camera'])));
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
  const first = runtime.dispose(); const second = runtime.dispose();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(runtime.currentView().health, 'disposing');
  let completed = false; second.then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  releaseBackend(); await second;
  assert.equal(backendDisposals, 1);
  assert.equal(runtime.currentView().health, 'disposed');
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
  assert.equal(runtime.currentView().health, 'disposed');
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
  assert.equal(runtime.currentView().health, 'disposed');
});

test('runtime construction seals the catalog registries', async (t) => {
  const { runtime, prefabRegistry, resourceRegistry } = await createHarness();
  t.after(() => runtime.dispose());
  const late = emptyPrefab({ id: 'target.late', logicalType: 'test.late' });
  assert.throws(() => prefabRegistry.register({
    sceneProfile: 'test', logicalType: late.logicalType, definition: late,
  }), { code: 'display-registry-sealed' });
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
