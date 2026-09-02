import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREFAB_DEFINITION_SCHEMA,
  POINTER_TARGET_ROLES,
  PointerTargetComponent,
  createComponentRegistry,
  createPointerInteractionController,
  definePrefab,
} from '../src/index.js';
import { createFakeRenderBackend } from '../src/testing/fake-render-backend.js';
import { commitAuthority, createHarness, IDENTITY } from './helpers.mjs';

const WORLD_RAY = Object.freeze({
  origin: Object.freeze([0, 1, 2]),
  direction: Object.freeze([0, 0, -1]),
});

function exactInteraction({
  nodeName = 'scene/main/target',
  roles = ['select', 'drag-source'],
  data = { id: 'target' },
} = {}) {
  return Object.freeze({
    hit: Object.freeze({
      nodeName,
      componentKey: 'visual',
      point: Object.freeze([1, 2, 3]),
      distance: 4,
    }),
    target: roles === null ? null : Object.freeze({
      nodeName,
      authorityOwnerName: null,
      roles: Object.freeze([...roles]),
      data: Object.freeze({ ...data }),
    }),
  });
}

function proximityInteraction({
  nodeName = 'scene/main/target',
  roles = ['proximity', 'select'],
  distance = 3,
} = {}) {
  return Object.freeze({
    hit: Object.freeze({
      nodeName,
      componentKey: 'visual',
      screenDistancePixels: distance,
      depth: 0.25,
    }),
    target: roles === null ? null : Object.freeze({
      nodeName,
      authorityOwnerName: null,
      roles: Object.freeze([...roles]),
      data: Object.freeze({ id: nodeName }),
    }),
  });
}

class FakePointerElement {
  constructor() {
    this._listeners = new Map();
    this.captured = new Set();
    this.captureCalls = [];
    this.releaseCalls = [];
  }

  addEventListener(type, listener) {
    let listeners = this._listeners.get(type);
    if (listeners === undefined) {
      listeners = [];
      this._listeners.set(type, listeners);
    }
    listeners.push(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this._listeners.get(type) ?? [];
    this._listeners.set(type, listeners.filter((entry) => entry !== listener));
  }

  setPointerCapture(pointerId) {
    this.captureCalls.push(pointerId);
    this.captured.add(pointerId);
  }

  hasPointerCapture(pointerId) { return this.captured.has(pointerId); }

  releasePointerCapture(pointerId) {
    this.releaseCalls.push(pointerId);
    this.captured.delete(pointerId);
  }

  dispatch(type, values = {}) {
    const event = {
      type,
      pointerId: 1,
      pointerType: 'mouse',
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerdown' ? 1 : 0,
      clientX: 10,
      clientY: 20,
      timeStamp: 1,
      defaultPrevented: false,
      propagationStopped: false,
      immediatePropagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() {
        this.propagationStopped = true;
        this.immediatePropagationStopped = true;
      },
      ...values,
    };
    for (const listener of [...(this._listeners.get(type) ?? [])]) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  }

  listenerCount() {
    return [...this._listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
  }
}

function controllerRuntime({ exact = exactInteraction(), proximity = proximityInteraction() } = {}) {
  const state = {
    exact,
    proximity,
    exactQueries: [],
    proximityQueries: [],
    rayQueries: [],
  };
  const runtime = {
    pickInteraction(query) { state.exactQueries.push(query); return state.exact; },
    pickInteractionProximity(query) {
      state.proximityQueries.push(query);
      return state.proximity;
    },
    screenPointToWorldRay(query) { state.rayQueries.push(query); return WORLD_RAY; },
  };
  return { runtime, state };
}

function pointerTargetDefinition({ key = 'pointer', enabled = true, roles = ['select'], data = {} } = {}) {
  return { key, type: 'interaction.pointer-target@1', enabled, properties: { roles, data } };
}

test('pointer-target is a closed default component with ordered roles and deeply frozen JSON data', () => {
  assert.deepEqual(POINTER_TARGET_ROLES, [
    'proximity', 'select', 'drag-source', 'drop-surface', 'drop-target',
  ]);
  const registry = createComponentRegistry();
  const source = { nested: { values: [1, true, null] } };
  const compiled = registry.compile(pointerTargetDefinition({
    roles: ['drag-source', 'select'], data: source,
  }));
  source.nested.values[0] = 99;
  assert.deepEqual(compiled.properties, {
    roles: ['drag-source', 'select'], data: { nested: { values: [1, true, null] } },
  });
  assert(Object.isFrozen(compiled.properties));
  assert(Object.isFrozen(compiled.properties.roles));
  assert(Object.isFrozen(compiled.properties.data.nested.values));
  assert.equal(registry.has('interaction.pointer-target@1'), true);

  for (const properties of [
    {},
    { roles: [], data: {} },
    { roles: ['select', 'select'], data: {} },
    { roles: ['unknown'], data: {} },
    { roles: ['select'], data: [], },
    { roles: ['select'], data: { value: 1n } },
    { roles: ['select'], data: {}, extra: true },
  ]) {
    assert.throws(() => registry.compile({
      key: 'pointer', type: 'interaction.pointer-target@1', properties,
    }));
  }
});

test('Display interaction queries resolve the nearest enabled ancestor without constructing a view', async () => {
  const fake = createFakeRenderBackend();
  let rawPick = null;
  let rawProximity = null;
  fake.backend.pick = (query) => { fake.calls.push(['pick-query', query]); return rawPick; };
  fake.backend.pickProximity = (query) => {
    fake.calls.push(['proximity-query', query]); return rawProximity;
  };
  fake.backend.screenPointToWorldRay = (query) => {
    fake.calls.push(['ray-query', query]); return WORLD_RAY;
  };
  const { runtime } = await createHarness({
    backendFactory: () => fake.backend,
    sceneNodes: [
      {
        localName: 'target', parentLocalName: null, transform: IDENTITY,
        components: [pointerTargetDefinition({ roles: ['select'], data: { owner: true } })],
      },
      {
        localName: 'child', parentLocalName: 'target', transform: IDENTITY,
        components: [pointerTargetDefinition({
          key: 'disabled-pointer', enabled: false, roles: ['drag-source'], data: {},
        })],
      },
    ],
  });
  const originalCurrentView = runtime.currentView;
  runtime.currentView = () => { throw new Error('must-not-build-view'); };
  rawPick = {
    nodeName: 'scene/main/child', componentKey: 'visual', point: [1, 2, 3], distance: 4,
  };
  const picked = runtime.pickInteraction({ clientX: 5, clientY: 6 });
  assert.deepEqual(picked, {
    hit: rawPick,
    target: {
      nodeName: 'scene/main/target', authorityOwnerName: null,
      roles: ['select'], data: { owner: true },
    },
  });
  assert(Object.isFrozen(picked));
  assert(Object.isFrozen(picked.hit.point));
  assert(Object.isFrozen(picked.target.data));

  rawProximity = {
    nodeName: 'scene/main/child', componentKey: 'visual', screenDistancePixels: 7, depth: 0.5,
  };
  assert.equal(runtime.pickInteractionProximity({
    clientX: 5, clientY: 6, radiusPixels: 8,
  }).target.nodeName, 'scene/main/target');
  assert.deepEqual(runtime.screenPointToWorldRay({ clientX: 5, clientY: 6 }), WORLD_RAY);

  rawPick = null;
  assert.equal(runtime.pickInteraction({ clientX: 5, clientY: 6 }), null);
  rawPick = {
    nodeName: 'scene/main/camera', componentKey: 'camera', point: [0, 0, 0], distance: 0,
  };
  assert.deepEqual(runtime.pickInteraction({ clientX: 5, clientY: 6 }).target, null);
  runtime.currentView = originalCurrentView;
  await runtime.dispose();
});

test('Display rejects malformed interaction hits, radius results, rays, and query shapes', async () => {
  const fake = createFakeRenderBackend();
  const { runtime } = await createHarness({ backendFactory: () => fake.backend });
  fake.backend.pick = () => ({
    nodeName: 'scene/main/camera', componentKey: 'camera', point: [0, 0, 0], distance: -1,
  });
  assert.throws(() => runtime.pickInteraction({ clientX: 0, clientY: 0 }), {
    code: 'display-interaction-hit-invalid',
  });
  fake.backend.pickProximity = () => ({
    nodeName: 'scene/main/camera', componentKey: 'camera', screenDistancePixels: 13, depth: 0,
  });
  assert.throws(() => runtime.pickInteractionProximity({
    clientX: 0, clientY: 0, radiusPixels: 12,
  }), { code: 'display-interaction-proximity-hit-invalid' });
  assert.throws(() => runtime.pickInteractionProximity({
    clientX: 0, clientY: 0, radiusPixels: 257,
  }), { code: 'display-proximity-query-invalid' });
  fake.backend.screenPointToWorldRay = () => ({ origin: [0, 0, 0], direction: [0, 0, -2] });
  assert.throws(() => runtime.screenPointToWorldRay({ clientX: 0, clientY: 0 }), {
    code: 'display-world-ray-invalid',
  });
  fake.backend.screenPointToWorldRay = () => ({
    origin: [0, 0, 0], direction: [0, 0, -1], leaked: true,
  });
  assert.throws(() => runtime.screenPointToWorldRay({ clientX: 0, clientY: 0 }), {
    code: 'display-world-ray-invalid',
  });
  await runtime.dispose();
});

test('claimed select gestures emit click then double-click and require the same release target', () => {
  const element = new FakePointerElement();
  const { runtime, state } = controllerRuntime({
    exact: exactInteraction({ roles: ['select'] }),
  });
  const phases = [];
  const errors = [];
  let cameraDowns = 0;
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: (sample) => sample.currentInteraction.target === null ? null : 'token',
    onPress: (_token, sample) => phases.push(sample.phase),
    onClick: (_token, sample) => phases.push(sample.phase),
    onDoubleClick: (_token, sample) => phases.push(sample.phase),
    onCancel: (_token, sample) => phases.push(`${sample.phase}:${sample.reason}`),
    onError: (error) => errors.push(error),
  });
  element.addEventListener('pointerdown', () => { cameraDowns += 1; });

  for (const [pointerId, time] of [[1, 100], [2, 300]]) {
    const down = element.dispatch('pointerdown', {
      pointerId, button: 0, buttons: 1, clientX: 10, clientY: 20, timeStamp: time,
    });
    assert.equal(down.defaultPrevented, true);
    element.dispatch('pointerup', {
      pointerId, button: 0, buttons: 0, clientX: 12, clientY: 20, timeStamp: time + 10,
    });
  }
  assert.deepEqual(phases, ['press', 'click', 'press', 'click', 'double-click']);
  assert.equal(cameraDowns, 0);
  assert.deepEqual(element.captureCalls, [1, 2]);
  assert.deepEqual(element.releaseCalls, [1, 2]);
  assert.equal(state.exactQueries.length, 4);
  assert.equal(state.rayQueries.length, 4);
  assert.deepEqual(errors, []);

  phases.length = 0;
  element.dispatch('pointerdown', { pointerId: 3, button: 0, buttons: 1 });
  state.exact = exactInteraction({ nodeName: 'scene/main/other', roles: ['select'] });
  element.dispatch('pointerup', { pointerId: 3, button: 0, buttons: 0 });
  assert.deepEqual(phases, ['press', 'cancel:target-mismatch']);
  controller.dispose();
  assert.equal(controller.disposed, true);
  assert.equal(element.listenerCount(), 1);
});

test('drag uses strict grab, move, drop phases while roles gate click and drag independently', () => {
  const element = new FakePointerElement();
  const { runtime, state } = controllerRuntime();
  const phases = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => 'drag',
    dragThresholdPixels: 4,
    onClick: (_token, sample) => phases.push(sample.phase),
    onDragGrab: (_token, sample) => phases.push(sample.phase),
    onDragMove: (_token, sample) => phases.push(sample.phase),
    onDragDrop: (_token, sample) => phases.push(sample.phase),
    onCancel: (_token, sample) => phases.push(`${sample.phase}:${sample.reason}`),
  });
  element.dispatch('pointerdown', { pointerId: 1, button: 0, buttons: 1, clientX: 0, clientY: 0 });
  element.dispatch('pointermove', { pointerId: 1, buttons: 1, clientX: 4, clientY: 0 });
  assert.deepEqual(phases, []);
  element.dispatch('pointermove', { pointerId: 1, buttons: 1, clientX: 5, clientY: 0 });
  element.dispatch('pointermove', { pointerId: 1, buttons: 1, clientX: 7, clientY: 0 });
  state.exact = exactInteraction({ nodeName: 'scene/main/drop', roles: ['drop-target'] });
  element.dispatch('pointerup', { pointerId: 1, button: 0, buttons: 0, clientX: 7, clientY: 0 });
  assert.deepEqual(phases, ['drag-grab', 'drag-move', 'drag-drop']);

  phases.length = 0;
  state.exact = exactInteraction({ roles: ['drag-source'] });
  element.dispatch('pointerdown', { pointerId: 2, button: 0, buttons: 1 });
  element.dispatch('pointerup', { pointerId: 2, button: 0, buttons: 0 });
  assert.deepEqual(phases, ['cancel:released-without-action']);

  phases.length = 0;
  state.exact = exactInteraction({ roles: ['select'] });
  element.dispatch('pointerdown', { pointerId: 3, button: 0, buttons: 1, clientX: 0 });
  element.dispatch('pointermove', { pointerId: 3, buttons: 1, clientX: 5 });
  assert.deepEqual(phases, ['cancel:movement-threshold']);
  controller.dispose();
});

test('secondary claim emits context-click and suppresses only its native context menu', () => {
  const element = new FakePointerElement();
  const { runtime } = controllerRuntime({ exact: exactInteraction({ roles: ['select'] }) });
  const phases = [];
  let shouldClaim = true;
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => shouldClaim ? 'secondary' : null,
    onContextClick: (_token, sample) => phases.push(sample.phase),
  });
  element.dispatch('pointerdown', { pointerId: 1, button: 2, buttons: 2 });
  element.dispatch('pointerup', { pointerId: 1, button: 2, buttons: 0 });
  const keyboardMenu = element.dispatch('contextmenu', {
    pointerId: undefined, pointerType: undefined, button: 0,
  });
  assert.equal(keyboardMenu.defaultPrevented, false);
  const claimedMenu = element.dispatch('contextmenu', { pointerId: 1, button: 2 });
  assert.equal(claimedMenu.defaultPrevented, true);
  assert.deepEqual(phases, ['context-click']);

  element.dispatch('pointerdown', {
    pointerId: 2, button: 2, buttons: 2, clientX: 30, clientY: 40, timeStamp: 10,
  });
  const longPressMenu = element.dispatch('contextmenu', {
    pointerId: 2, button: 2, clientX: 30, clientY: 40, timeStamp: 5010,
  });
  assert.equal(longPressMenu.defaultPrevented, true);
  element.dispatch('pointerup', {
    pointerId: 2, button: 2, buttons: 0, clientX: 30, clientY: 40, timeStamp: 5020,
  });
  assert.equal(element.dispatch('contextmenu', {
    pointerId: 2, button: 2, clientX: 30, clientY: 40, timeStamp: 5030,
  }).defaultPrevented, false, 'an active-sequence menu is consumed only once');

  element.dispatch('pointerdown', {
    pointerId: 3, button: 2, buttons: 2, clientX: 50, clientY: 60, timeStamp: 6000,
  });
  element.dispatch('pointerup', {
    pointerId: 3, button: 2, buttons: 0, clientX: 50, clientY: 60, timeStamp: 6010,
  });
  assert.equal(element.dispatch('contextmenu', {
    pointerId: 3, button: 2, clientX: 90, clientY: 90, timeStamp: 6020,
  }).defaultPrevented, false, 'an unrelated menu is not suppressed');
  assert.equal(element.dispatch('contextmenu', {
    pointerId: 3, button: 2, clientX: 50, clientY: 60, timeStamp: 6030,
  }).defaultPrevented, true, 'the matching completed sequence is suppressed');

  shouldClaim = false;
  const down = element.dispatch('pointerdown', { pointerId: 4, button: 2, buttons: 2 });
  const menu = element.dispatch('contextmenu', { pointerId: 4, button: 2 });
  assert.equal(down.defaultPrevented, false);
  assert.equal(menu.defaultPrevented, false);
  controller.dispose();
});

test('proximity uses one radius pick and one ray per idle mouse or hovering pen event', () => {
  const element = new FakePointerElement();
  const { runtime, state } = controllerRuntime();
  const phases = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => null,
    proximityRadiusPixels: 19,
    onProximityEnter: (sample) => phases.push(sample.phase),
    onProximityMove: (sample) => phases.push(sample.phase),
    onProximityLeave: (sample) => phases.push(`${sample.phase}:${sample.reason}`),
  });
  const mouse = element.dispatch('pointermove', {
    pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: 1, clientY: 2,
  });
  element.dispatch('pointermove', {
    pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: 2, clientY: 3,
  });
  assert.equal(mouse.defaultPrevented, false);
  assert.deepEqual(phases, ['proximity-enter', 'proximity-move']);
  assert.equal(state.proximityQueries.length, 2);
  assert.equal(state.rayQueries.length, 2);
  assert.equal(state.proximityQueries[0].radiusPixels, 19);

  element.dispatch('pointerleave', { pointerId: 1, pointerType: 'mouse' });
  assert.deepEqual(phases.at(-1), 'proximity-leave:pointer-leave');
  assert.equal(state.proximityQueries.length, 2);
  element.dispatch('pointermove', { pointerId: 2, pointerType: 'touch', buttons: 0 });
  element.dispatch('pointermove', { pointerId: 3, pointerType: 'pen', buttons: 1 });
  assert.equal(state.proximityQueries.length, 2);
  element.dispatch('pointermove', { pointerId: 3, pointerType: 'pen', buttons: 0 });
  assert.equal(state.proximityQueries.length, 3);
  controller.dispose();
});

test('callback failures isolate through onError, leave/cancel once, and disposal has no listener leak', () => {
  const element = new FakePointerElement();
  const { runtime } = controllerRuntime();
  const phases = [];
  const errors = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => 'token',
    onDragGrab: () => { throw new Error('grab-failed'); },
    onCancel: (_token, sample) => phases.push(`${sample.phase}:${sample.reason}`),
    onProximityEnter: () => { throw new Error('enter-failed'); },
    onProximityLeave: (sample) => phases.push(`${sample.phase}:${sample.reason}`),
    onError: (error) => errors.push(error.message),
  });
  element.dispatch('pointermove', { pointerId: 9, pointerType: 'mouse', buttons: 0 });
  assert.deepEqual(phases, ['proximity-leave:callback-error']);
  assert.deepEqual(errors, ['enter-failed']);

  element.dispatch('pointerdown', {
    pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 0,
  });
  element.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 5 });
  assert.deepEqual(phases.at(-1), 'cancel:callback-error');
  assert.deepEqual(errors, ['enter-failed', 'grab-failed']);
  assert.deepEqual(element.releaseCalls, [1]);

  controller.dispose();
  controller.dispose();
  assert.equal(element.listenerCount(), 0);
});

test('one active pointer ignores extras and cancellation, lost capture, runtime replacement, and dispose end once', () => {
  const element = new FakePointerElement();
  const first = controllerRuntime();
  const second = controllerRuntime();
  let currentRuntime = first.runtime;
  const terminals = [];
  let claims = 0;
  const controller = createPointerInteractionController({
    element,
    runtime: () => currentRuntime,
    claim: () => { claims += 1; return 'token'; },
    onCancel: (_token, sample) => terminals.push(sample.reason),
  });
  element.dispatch('pointerdown', { pointerId: 1, button: 0, buttons: 1 });
  const extra = element.dispatch('pointerdown', { pointerId: 2, button: 0, buttons: 1 });
  assert.equal(extra.defaultPrevented, false);
  assert.equal(claims, 1);
  assert.equal(first.state.exactQueries.length, 1);
  element.dispatch('pointercancel', { pointerId: 1, button: 0, buttons: 0 });
  element.dispatch('pointercancel', { pointerId: 1, button: 0, buttons: 0 });
  assert.deepEqual(terminals, ['pointer-cancel']);

  element.dispatch('pointerdown', { pointerId: 3, button: 0, buttons: 1 });
  element.dispatch('lostpointercapture', { pointerId: 3 });
  element.dispatch('lostpointercapture', { pointerId: 3 });
  assert.deepEqual(terminals, ['pointer-cancel', 'lost-pointer-capture']);

  element.dispatch('pointerdown', { pointerId: 4, button: 0, buttons: 1 });
  currentRuntime = second.runtime;
  element.dispatch('pointermove', { pointerId: 4, buttons: 1, clientX: 20 });
  assert.deepEqual(terminals, [
    'pointer-cancel', 'lost-pointer-capture', 'runtime-replaced',
  ]);
  assert.equal(second.state.exactQueries.length, 0,
    'the replacement event cancels instead of continuing the old gesture');

  element.dispatch('pointerdown', { pointerId: 5, button: 0, buttons: 1 });
  controller.dispose();
  controller.dispose();
  assert.deepEqual(terminals, [
    'pointer-cancel', 'lost-pointer-capture', 'runtime-replaced', 'controller-disposed',
  ]);
  assert.equal(element.listenerCount(), 0);
});

test('an unclaimed primary sequence passes through without capture or camera isolation', () => {
  const element = new FakePointerElement();
  const { runtime, state } = controllerRuntime();
  let cameraDowns = 0;
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => null,
  });
  element.addEventListener('pointerdown', () => { cameraDowns += 1; });
  const down = element.dispatch('pointerdown', { pointerId: 1, button: 0, buttons: 1 });
  assert.equal(down.defaultPrevented, false);
  assert.equal(cameraDowns, 1);
  assert.deepEqual(element.captureCalls, []);
  assert.equal(state.exactQueries.length, 1);
  assert.equal(state.rayQueries.length, 1);
  controller.dispose();
});

test('a controller created before DOM attachment disposes after its later element removal', () => {
  let mutationCallback = null;
  class FakeMutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  }
  const element = new FakePointerElement();
  element.isConnected = false;
  element.ownerDocument = {
    documentElement: {},
    defaultView: { MutationObserver: FakeMutationObserver },
  };
  const { runtime } = controllerRuntime();
  const reasons = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => 'token',
    onCancel: (_token, sample) => reasons.push(sample.reason),
  });
  mutationCallback();
  assert.equal(controller.disposed, false);
  element.isConnected = true;
  mutationCallback();
  element.dispatch('pointerdown', { pointerId: 1, button: 0, buttons: 1 });
  element.isConnected = false;
  mutationCallback();
  assert.equal(controller.disposed, true);
  assert.deepEqual(reasons, ['element-removed']);
  assert.equal(element.listenerCount(), 0);
});

test('runtime rebuild and disposal cancel or leave each active interval exactly once', async () => {
  const fakes = [];
  const backendFactory = () => {
    const fake = createFakeRenderBackend();
    fake.backend.pick = () => ({
      nodeName: 'scene/main/target', componentKey: 'visual', point: [0, 0, 0], distance: 0,
    });
    fake.backend.pickProximity = () => ({
      nodeName: 'scene/main/target', componentKey: 'visual', screenDistancePixels: 0, depth: 0,
    });
    fakes.push(fake);
    return fake.backend;
  };
  const { runtime } = await createHarness({
    backendFactory,
    sceneNodes: [{
      localName: 'target', parentLocalName: null, transform: IDENTITY,
      components: [pointerTargetDefinition({ roles: ['proximity', 'select', 'drag-source'] })],
    }],
  });
  const element = new FakePointerElement();
  const terminals = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => 'token',
    onCancel: (_token, sample) => terminals.push(`${sample.phase}:${sample.reason}`),
    onProximityLeave: (sample) => terminals.push(`${sample.phase}:${sample.reason}`),
  });
  element.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0 });
  await runtime.rebuildRenderBackend();
  assert.deepEqual(terminals, ['proximity-leave:backend-rebuild']);

  element.dispatch('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, buttons: 1 });
  await runtime.dispose();
  assert.deepEqual(terminals, [
    'proximity-leave:backend-rebuild',
    'cancel:runtime-disposed',
  ]);
  controller.dispose();
});

test('live pointer-target data is refreshed while role removal cancels proximity and drag once', async () => {
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'target.pointer-live',
    gameplayType: 'test.pointer-live',
    root: {
      components: [],
      children: [{
        localName: 'body', transform: IDENTITY, visible: true,
        components: [pointerTargetDefinition({
          roles: ['proximity', 'select', 'drag-source'], data: { revision: 0 },
        })],
        children: [],
      }],
    },
    resolveState(state) {
      return {
        components: {
          'body/pointer': { roles: state.roles, data: { revision: state.revision } },
        },
      };
    },
  });
  const fake = createFakeRenderBackend();
  const nodeName = 'prefab/py/0/body';
  fake.backend.pick = () => ({
    nodeName, componentKey: 'visual', point: [0, 0, 0], distance: 0,
  });
  fake.backend.pickProximity = () => ({
    nodeName, componentKey: 'visual', screenDistancePixels: 0, depth: 0,
  });
  const { runtime } = await createHarness({
    prefabEntries: [prefab], backendFactory: () => fake.backend,
  });
  commitAuthority(runtime, () => runtime.authority.createNode({
    nodeId: 0,
    parentNodeId: null,
    displayKindId: prefab.id,
    transformMode: 'live',
    transform: IDENTITY,
    visible: true,
    state: { roles: ['proximity', 'select', 'drag-source'], revision: 1 },
  }), { sourceTickDelta: 1 });

  const element = new FakePointerElement();
  const events = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    claim: () => 'token',
    onProximityEnter: (sample) => events.push([sample.phase,
      sample.currentInteraction.target.data.revision]),
    onProximityMove: (sample) => events.push([sample.phase,
      sample.currentInteraction.target.data.revision]),
    onProximityLeave: (sample) => events.push([sample.phase, sample.reason]),
    onDragGrab: (_token, sample) => events.push([sample.phase]),
    onCancel: (_token, sample) => events.push([sample.phase, sample.reason]),
  });
  element.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0 });
  commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0,
    state: { roles: ['proximity', 'select', 'drag-source'], revision: 2 },
  }));
  await Promise.resolve();
  assert.deepEqual(events, [['proximity-enter', 1]], 'data-only replacement keeps identity');
  element.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0 });
  assert.deepEqual(events.at(-1), ['proximity-move', 2]);

  commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { roles: ['select', 'drag-source'], revision: 3 },
  }));
  await Promise.resolve();
  assert.deepEqual(events.at(-1), ['proximity-leave', 'target-role-removed']);

  element.dispatch('pointerdown', {
    pointerId: 2, pointerType: 'mouse', button: 0, buttons: 1, clientX: 0,
  });
  element.dispatch('pointermove', {
    pointerId: 2, pointerType: 'mouse', buttons: 1, clientX: 5,
  });
  assert.deepEqual(events.at(-1), ['drag-grab']);
  commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { roles: ['select'], revision: 4 },
  }));
  await Promise.resolve();
  assert.deepEqual(events.at(-1), ['cancel', 'target-role-removed']);
  const count = events.length;
  await Promise.resolve();
  assert.equal(events.length, count);

  commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0, state: { roles: ['select', 'drag-source'], revision: 5 },
  }));
  element.dispatch('pointerdown', {
    pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1,
  });
  const targetComponent = runtime._nodeIndex.require(nodeName).getComponent(PointerTargetComponent);
  targetComponent.setEnabled(false);
  await Promise.resolve();
  assert.deepEqual(events.at(-1), ['cancel', 'target-disabled']);
  targetComponent.setEnabled(true);
  await Promise.resolve();

  element.dispatch('pointerdown', {
    pointerId: 4, pointerType: 'mouse', button: 0, buttons: 1,
  });
  commitAuthority(runtime, () => runtime.authority.removeNode({ nodeId: 0 }));
  await Promise.resolve();
  assert.deepEqual(events.at(-1), ['cancel', 'target-removed']);

  controller.dispose();
  await runtime.dispose();
});
