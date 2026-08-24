import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  defineScene,
} from '../src/index.js';
import { createFakeRenderBackend } from '../src/testing/fake-render-backend.js';

export const IDENTITY = Object.freeze({
  position: Object.freeze([0, 0, 0]),
  rotationXyzw: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
});

export const RENDERER_PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x000000ff,
  antialias: false,
  alpha: false,
  shadows: false,
  toneMapping: 'none',
});

export class FakeFrameAdapter {
  constructor() { this._next = 1; this._callbacks = new Map(); this.time = 0; }
  request(callback) { const id = this._next++; this._callbacks.set(id, callback); return id; }
  cancel(id) { this._callbacks.delete(id); }
  now() { return this.time; }
  get pending() { return this._callbacks.size; }
  step(milliseconds = 16) {
    this.time += milliseconds;
    const callbacks = [...this._callbacks.values()];
    this._callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }
}

export function emptyPrefab({ id = 'target.test.item', logicalType = 'test.item',
  childName = 'body', resolveState = undefined, childComponents = [] } = {}) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    logicalType,
    root: {
      components: [],
      children: childName === null ? [] : [{
        localName: childName,
        transform: IDENTITY,
        visible: true,
        components: childComponents,
        children: [],
      }],
    },
    ...(resolveState ? { resolveState } : {}),
  });
}

export async function createHarness({ prefabEntries = null, resources = [], sceneNodes = [],
  prefabInstances = [], backendFactory = null, onHealth = null, configureComponents = null,
  authoringMode = false } = {}) {
  const componentRegistry = createComponentRegistry();
  configureComponents?.(componentRegistry);
  const resourceRegistry = createResourceRegistry(resources);
  const defaultPrefab = emptyPrefab();
  const entries = prefabEntries ?? [{ sceneProfile: 'test', logicalType: defaultPrefab.logicalType,
    definition: defaultPrefab }];
  const prefabRegistry = createPrefabRegistry(entries);
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: IDENTITY,
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 },
      }],
    }, ...sceneNodes],
    prefabInstances,
  });
  const sceneRegistry = createSceneRegistry([scene]);
  const frames = new FakeFrameAdapter();
  const fakeBackends = [];
  const createBackend = backendFactory ?? (() => {
    const fake = createFakeRenderBackend(); fakeBackends.push(fake); return fake.backend;
  });
  const runtime = createDisplayRuntime({
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    createRenderBackend: createBackend,
    frameAdapter: frames,
    onHealth,
    authoringMode,
  });
  const installReturn = runtime.installScene({ sceneName: 'main' });
  runtime.activate();
  return { runtime, frames, fakeBackends, componentRegistry, resourceRegistry,
    prefabRegistry, sceneRegistry, installReturn };
}
