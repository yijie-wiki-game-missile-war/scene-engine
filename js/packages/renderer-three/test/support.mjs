import * as THREE from 'three';

import { ThreeRenderBackend } from '../src/backend.js';
import {
  DEFAULT_THREE_IMPLEMENTATION,
  disposeThreeResource,
  loadThreeResource,
} from '../src/resources.js';

export const PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 2,
  clearRgba: 0x1020_30ff,
  antialias: false,
  alpha: false,
  shadows: true,
  toneMapping: 'none',
});

export class TestRegistry {
  constructor(descriptors = []) {
    this.values = new Map(descriptors.map((descriptor) => [descriptor.id,
      Object.freeze({ describe: () => Object.freeze({ ...descriptor }) })]));
  }
  get(id) { return this.values.get(id) ?? null; }
  require(id) {
    const value = this.get(id);
    if (!value) throw new Error(`missing resource ${id}`);
    return value;
  }
}

export class TestRenderer {
  constructor() {
    this.pixelRatio = 1; this.width = 1; this.height = 1; this.draws = 0; this.disposed = false;
    this.autoClear = true; this.clears = 0; this.depthClears = 0;
    this.shadowMap = { autoUpdate: true };
    this.renderStates = [];
    this.info = { render: { calls: 0 }, memory: { geometries: 0, textures: 0 } };
  }
  setPixelRatio(value) { this.pixelRatio = value; }
  setSize(width, height) { this.width = width; this.height = height; }
  render(scene, camera) {
    scene.updateMatrixWorld(true);
    const colorWrites = [];
    scene.traverse((object) => {
      if (!object.material || !object.layers.test(camera.layers)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        colorWrites.push(material.colorWrite);
      }
    });
    this.renderStates.push({ cameraMask: camera.layers.mask, colorWrites });
    this.draws += 1; this.info.render.calls += 1;
  }
  clear() { this.clears += 1; }
  clearDepth() { this.depthClears += 1; }
  dispose() { this.disposed = true; }
}

export function createHarness({ descriptors = [], loadResource = loadThreeResource,
  onHealth = null, width = 800, height = 600, compositionPlan = null } = {}) {
  const registry = new TestRegistry(descriptors);
  const renderer = new TestRenderer();
  const host = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  };
  const canvas = { getContext: () => ({}), toDataURL: () => 'data:image/png;base64,test' };
  let observerDisconnected = false;
  const implementation = {
    ...DEFAULT_THREE_IMPLEMENTATION,
    createRenderer: () => renderer,
    createResizeObserver: () => ({ observe() {}, disconnect() { observerDisconnected = true; } }),
    devicePixelRatio: () => 3,
    loadResource,
    disposeResource: disposeThreeResource,
  };
  const backend = new ThreeRenderBackend({ hostElement: host, canvas, rendererProfile: PROFILE,
    compositionPlan, resourceRegistry: registry, onHealth }, implementation);
  return { backend, registry, renderer, host, canvas,
    get observerDisconnected() { return observerDisconnected; } };
}

export function descriptor(nodeName, componentKey, componentType, properties, registry,
  signal = undefined, batchable = true, compositionGroup = null) {
  return { nodeName, componentKey, componentType, properties, batchable, compositionGroup,
    resourceRegistry: registry, ...(signal ? { signal } : {}) };
}

export function patch(nodeName, componentKey, properties, matrix = new THREE.Matrix4(),
  visible = true, batchable = true, compositionGroup = null) {
  return { identity: { nodeName, componentKey }, worldMatrix: matrix.toArray(), panelAnchorWorld: null,
    visible, batchable, compositionGroup, properties };
}

export const CAMERA_PROPERTIES = Object.freeze({
  projection: 'perspective', near: 0.1, far: 1_000, fovYDegrees: 60,
});

export const INLINE_RESOURCES = Object.freeze([
  { id: 'mesh/triangle', kind: 'mesh', positions: [
    -1, -1, 0,
    1, -1, 0,
    0, 1, 0,
  ], indices: [0, 1, 2] },
  { id: 'material/standard', kind: 'material', family: 'material.standard',
    properties: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0,
      alphaMode: 'opaque', alphaCutoff: 0 } },
]);

export function frame(activeCameraBinding, sourceTick = 0, visualSeconds = 0) {
  return { sourceTick, visualSeconds, dirtyBindings: [], activeCameraBinding };
}
