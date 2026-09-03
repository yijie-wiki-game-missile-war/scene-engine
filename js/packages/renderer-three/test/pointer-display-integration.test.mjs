import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayKindRegistry,
  createDisplayRuntime,
  createPointerInteractionController,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineScene,
} from '../../display/src/index.js';
import { ThreeRenderBackend } from '../src/backend.js';
import { DEFAULT_THREE_IMPLEMENTATION } from '../src/resources.js';
import { INLINE_RESOURCES, PROFILE, TestRenderer } from './support.mjs';
import { IDENTITY_MATRIX } from '../../../../scripts/support/matrix4.mjs';

const IDENTITY = IDENTITY_MATRIX;
const CAMERA = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 5, 1,
]);

test('real Display and Three route proximity and drag through one target and lifecycle', async () => {
  const element = new PointerHost();
  const canvas = { getContext: () => ({}) };
  const frameAdapter = new FrameAdapter();
  const resources = createResourceRegistry(INLINE_RESOURCES);
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'pointer-main',
    sceneProfile: 'test',
    rendererProfile: PROFILE,
    compositionPlan: null,
    activeCameraLocalName: 'camera',
    nodes: [
      {
        localName: 'camera', parentLocalName: null, transform: CAMERA,
        components: [{ key: 'camera', type: 'render.camera@1', properties: {
          projection: 'perspective', near: 0.1, far: 100, fovYDegrees: 60,
        } }],
      },
      {
        localName: 'target', parentLocalName: null, transform: IDENTITY,
        components: [{
          key: 'pointer', type: 'interaction.pointer-target@1', properties: {
            roles: ['proximity', 'select', 'drag-source'], data: { productId: 'unit-7' },
          },
        }],
      },
      {
        localName: 'triangle', parentLocalName: 'target', transform: IDENTITY,
        components: [{ key: 'mesh', type: 'render.mesh@1', properties: {
          meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
          castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true,
        } }],
      },
    ],
    prefabInstances: [],
  });
  const backends = [];
  const runtime = createDisplayRuntime({
    hostElement: element,
    canvas,
    sceneRegistry: createSceneRegistry([scene]),
    displayKindRegistry: createDisplayKindRegistry(),
    prefabRegistry: createPrefabRegistry(),
    resourceRegistry: resources,
    componentRegistry: createComponentRegistry(),
    authorityStateSchemas: [],
    createRenderBackend(options) {
      const backend = new ThreeRenderBackend(options, {
        ...DEFAULT_THREE_IMPLEMENTATION,
        createRenderer: () => new TestRenderer(),
        createResizeObserver: () => ({ observe() {}, disconnect() {} }),
        devicePixelRatio: () => 1,
      });
      backends.push(backend);
      return backend;
    },
    frameAdapter,
  });
  runtime.installScene({ sceneName: scene.id });
  runtime.activate();
  runtime.start();
  await runtime.whenReady();
  frameAdapter.step();

  const phases = [];
  const controller = createPointerInteractionController({
    element,
    runtime: () => runtime,
    proximityRadiusPixels: 16,
    claim: (sample) => sample.startInteraction?.target?.data.productId === 'unit-7'
      ? Object.freeze({ productId: 'unit-7' }) : null,
    onProximityEnter: (sample) => phases.push(sample.phase),
    onProximityLeave: (sample) => phases.push(sample.phase),
    onDragGrab: (_token, sample) => phases.push(sample.phase),
    onDragMove: (_token, sample) => phases.push(sample.phase),
    onDragDrop: (_token, sample) => phases.push(sample.phase),
    onCancel: (_token, sample) => phases.push(sample.phase),
  });
  let cameraEvents = 0;
  element.addEventListener('pointermove', () => { cameraEvents += 1; });

  element.dispatch(pointer('pointermove', { clientX: 400, clientY: 300 }));
  assert.deepEqual(phases, ['proximity-enter']);
  assert.equal(cameraEvents, 1, 'observational proximity must pass through to camera controls');

  const down = element.dispatch(pointer('pointerdown', {
    clientX: 400, clientY: 300, button: 0, buttons: 1,
  }));
  element.dispatch(pointer('pointermove', {
    clientX: 405, clientY: 300, button: -1, buttons: 1,
  }));
  element.dispatch(pointer('pointermove', {
    clientX: 410, clientY: 300, button: -1, buttons: 1,
  }));
  element.dispatch(pointer('pointerup', {
    clientX: 415, clientY: 300, button: 0, buttons: 0,
  }));
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(phases, [
    'proximity-enter', 'proximity-leave', 'drag-grab', 'drag-move', 'drag-drop',
  ]);
  assert.equal(cameraEvents, 1, 'claimed drag moves must not reach camera controls');
  assert.equal(element.captures.size, 0);

  element.dispatch(pointer('pointerdown', {
    clientX: 400, clientY: 300, button: 0, buttons: 1,
  }));
  const rebuild = runtime.rebuildRenderBackend();
  assert.equal(phases.at(-1), 'cancel', 'backend rebuild cancels synchronously');
  await rebuild;
  assert.equal(backends.length, 2);

  controller.dispose();
  controller.dispose();
  assert.equal(element.listenerCount, 1, 'only the independent camera listener remains');
  await runtime.dispose();
  assert.equal(backends[1].diagnostics().disposed, true);
});

class PointerHost {
  constructor() {
    this.listeners = new Map();
    this.captures = new Set();
    this.isConnected = true;
  }

  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }

  addEventListener(type, listener) {
    let entries = this.listeners.get(type);
    if (entries === undefined) { entries = []; this.listeners.set(type, entries); }
    entries.push(listener);
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? [];
    const index = entries.indexOf(listener);
    if (index !== -1) entries.splice(index, 1);
    if (entries.length === 0) this.listeners.delete(type);
  }

  setPointerCapture(pointerId) { this.captures.add(pointerId); }
  hasPointerCapture(pointerId) { return this.captures.has(pointerId); }
  releasePointerCapture(pointerId) { this.captures.delete(pointerId); }

  dispatch(event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return event;
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((count, entries) => count + entries.length, 0);
  }
}

class FrameAdapter {
  constructor() { this.next = 1; this.callbacks = new Map(); this.time = 0; }
  request(callback) { const id = this.next; this.next += 1; this.callbacks.set(id, callback); return id; }
  cancel(id) { this.callbacks.delete(id); }
  now() { return this.time; }
  step(milliseconds = 16) {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }
}

function pointer(type, overrides = {}) {
  return {
    type,
    pointerId: 1,
    pointerType: 'mouse',
    button: -1,
    buttons: 0,
    clientX: 0,
    clientY: 0,
    timeStamp: 0,
    cancelable: true,
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    ...overrides,
  };
}
