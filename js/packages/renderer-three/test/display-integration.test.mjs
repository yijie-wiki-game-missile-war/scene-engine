import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineScene,
} from '../../display/src/index.js';
import { ThreeRenderBackend } from '../src/backend.js';
import { DEFAULT_THREE_IMPLEMENTATION } from '../src/resources.js';
import { INLINE_RESOURCES, PROFILE, TestRenderer } from './support.mjs';

const IDENTITY = Object.freeze({ position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1] });

test('Display RenderSystem drives the exact backend port and rebuilds from declarative bindings', async () => {
  const resources = createResourceRegistry(INLINE_RESOURCES);
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'test',
    rendererProfile: PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [
      { localName: 'camera', parentLocalName: null, transform: IDENTITY,
        components: [{ key: 'camera', type: 'render.camera@1', properties: {
          projection: 'perspective', near: 0.1, far: 100, fovYDegrees: 60,
        } }] },
      { localName: 'triangle', parentLocalName: null, transform: IDENTITY,
        components: [{ key: 'mesh', type: 'render.mesh@1', properties: {
          meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
          castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true,
        } }] },
    ],
    prefabInstances: [],
  });
  const frameAdapter = new FrameAdapter();
  const backends = [];
  const hostElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  const canvas = { getContext: () => ({}) };
  const createRenderBackend = (options) => {
    const renderer = new TestRenderer();
    const backend = new ThreeRenderBackend(options, {
      ...DEFAULT_THREE_IMPLEMENTATION,
      createRenderer: () => renderer,
      createResizeObserver: () => ({ observe() {}, disconnect() {} }),
      devicePixelRatio: () => 1,
    });
    backends.push({ backend, renderer }); return backend;
  };
  const runtime = createDisplayRuntime({
    hostElement,
    canvas,
    sceneRegistry: createSceneRegistry([scene]),
    prefabRegistry: createPrefabRegistry(),
    resourceRegistry: resources,
    componentRegistry: createComponentRegistry(),
    createRenderBackend,
    frameAdapter,
  });
  runtime.installScene({ sceneName: 'main' }); runtime.activate(); runtime.start();
  await runtime.whenReady(); frameAdapter.step();
  assert.equal(backends.length, 1);
  assert.equal(backends[0].backend.diagnostics().bindingCount, 2);
  assert.equal(backends[0].renderer.draws, 1);
  runtime.commitGate.begin({ commitSeq: 1, sourceTick: 1, lastCommandSeq: 0 });
  runtime.commitGate.seal({ commitSeq: 1, sourceTick: 1, lastCommandSeq: 0 });
  frameAdapter.step();
  await runtime.rebuildRenderBackend();
  assert.equal(backends.length, 2);
  assert.equal(backends[0].renderer.disposed, true);
  assert.equal(backends[1].backend.diagnostics().bindingCount, 2);
  assert.equal(runtime.currentView().cursor.commitSeq, 1);
  await runtime.dispose();
  assert.equal(backends[1].renderer.disposed, true);
  assert.equal(backends[1].backend.diagnostics().resourceLeaseCount, 0);
});

class FrameAdapter {
  constructor() { this.next = 1; this.callbacks = new Map(); this.time = 0; }
  request(callback) { const id = this.next; this.next += 1; this.callbacks.set(id, callback); return id; }
  cancel(id) { this.callbacks.delete(id); }
  now() { return this.time; }
  step(milliseconds = 16) {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }
}
