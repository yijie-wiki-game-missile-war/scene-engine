import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { ResourceManager } from '../src/resource-manager.js';
import { disposeThreeResource, loadThreeResource } from '../src/resources.js';
import {
  CAMERA_PROPERTIES,
  INLINE_RESOURCES,
  TestRegistry,
  createHarness,
  descriptor,
  patch,
} from './support.mjs';

test('resource leases deduplicate pending work and retire a late asset exactly once', async () => {
  const registry = new TestRegistry([{ id: 'model/shared', kind: 'model', url: 'memory:model' }]);
  let resolveLoad; let loadCount = 0; let disposeCount = 0;
  const manager = new ResourceManager({
    registry,
    load() { loadCount += 1; return new Promise((resolve) => { resolveLoad = resolve; }); },
    dispose() { disposeCount += 1; },
    onFailure(_resourceId, error) { throw error; },
  });
  const first = manager.acquire('model/shared');
  const second = manager.acquire('model/shared');
  await Promise.resolve();
  assert.equal(loadCount, 1);
  first.release(); second.release();
  assert.equal(manager.diagnostics().resourceCount, 0);
  resolveLoad({ kind: 'model' });
  await manager.whenIdle();
  assert.equal(disposeCount, 1);
  manager.dispose();
  assert.equal(disposeCount, 1);
});

test('resource dependency acquisition failure releases already-acquired pending dependencies', async () => {
  const registry = new TestRegistry([
    { id: 'texture/first', kind: 'texture', url: 'memory:first' },
    { id: 'material/broken', kind: 'material', family: 'material.standard',
      properties: {}, textureResourceIds: ['texture/first', 'texture/missing'] },
  ]);
  let resolveTexture; let disposed = 0;
  const manager = new ResourceManager({
    registry,
    load(descriptorValue) {
      if (descriptorValue.kind === 'texture') {
        return new Promise((resolve) => { resolveTexture = resolve; });
      }
      throw new Error('material load must not start');
    },
    dispose() { disposed += 1; },
    onFailure() {},
  });
  const lease = manager.acquire('material/broken');
  await assert.rejects(lease.ready, /missing resource/u);
  lease.release();
  resolveTexture({ kind: 'texture' });
  await manager.whenIdle();
  assert.equal(manager.diagnostics().resourceCount, 0);
  assert.equal(manager.diagnostics().resourceLeaseCount, 0);
  assert.equal(disposed, 1);
  manager.dispose();
});

test('indexed inline meshes tolerate omitted normals and UVs and compute every vertex normal', async () => {
  const descriptorValue = {
    id: 'mesh/hex', kind: 'mesh',
    positions: [0, 0, 0, 0.58, 0, 0, 0.29, 0, 0.502, -0.29, 0, 0.502,
      -0.58, 0, 0, -0.29, 0, -0.502, 0.29, 0, -0.502],
    indices: [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4, 0, 6, 5, 0, 1, 6],
  };
  const asset = await loadThreeResource(descriptorValue, new AbortController().signal, []);
  assert.equal(asset.geometry.getAttribute('uv'), undefined);
  const normals = asset.geometry.getAttribute('normal');
  assert.equal(normals.count, 7);
  for (let index = 0; index < normals.count; index += 1) {
    assert.ok(Math.hypot(normals.getX(index), normals.getY(index), normals.getZ(index)) > 0.99);
  }
  disposeThreeResource(asset);
});

test('pending create honors AbortSignal and cannot attach a late resource', async () => {
  let resolveLoad; let disposedAsset = 0;
  const asset = { kind: 'model', descriptor: { id: 'model/slow', kind: 'model' },
    template: new THREE.Group(), templates: [new THREE.Group()], animations: [] };
  const loadResource = () => new Promise((resolve) => { resolveLoad = resolve; });
  const { backend, registry } = createHarness({
    descriptors: [{ id: 'model/slow', kind: 'model', url: 'memory:slow' }],
    loadResource,
  });
  const originalDispose = backend._implementation.disposeResource;
  backend._resources.disposeAsset = (value) => { disposedAsset += 1; originalDispose(value); };
  const controller = new AbortController();
  const pending = backend.createBinding(descriptor('py/late', 'model', 'render.model@1', {
    modelResourceId: 'model/slow', materialOverrides: {}, castShadow: false,
    receiveShadow: false, renderOrder: 0, pickable: false, animation: null,
  }, registry, controller.signal));
  await Promise.resolve();
  controller.abort();
  resolveLoad(asset);
  await assert.rejects(pending, /aborted/u);
  await backend.whenIdle();
  assert.equal(backend.diagnostics().bindingCount, 0);
  assert.equal(backend.diagnostics().resourceLeaseCount, 0);
  assert.equal(disposedAsset, 1);
  backend.dispose();
});

test('backend disposal aborts an unscoped pending create and late work cannot reattach', async () => {
  let resolveLoad; let disposedAsset = 0;
  const { backend, registry } = createHarness({
    descriptors: [{ id: 'model/late', kind: 'model', url: 'memory:late' }],
    loadResource: () => new Promise((resolve) => { resolveLoad = resolve; }),
  });
  const originalDispose = backend._resources.disposeAsset;
  backend._resources.disposeAsset = (value) => { disposedAsset += 1; originalDispose(value); };
  const pending = backend.createBinding(descriptor('py/late-unscoped', 'model',
    'render.model@1', {
      modelResourceId: 'model/late', materialOverrides: {}, castShadow: false,
      receiveShadow: false, renderOrder: 0, pickable: false, animation: null,
    }, registry));
  await Promise.resolve();
  backend.dispose();
  resolveLoad({ kind: 'model', descriptor: { id: 'model/late', kind: 'model' },
    template: new THREE.Group(), templates: [new THREE.Group()], animations: [] });
  await assert.rejects(pending, /disposed|aborted/u);
  await Promise.resolve();
  assert.equal(backend.diagnostics().bindingCount, 0);
  assert.equal(backend.diagnostics().resourceLeaseCount, 0);
  assert.equal(disposedAsset, 1);
});

test('technical failures report the exact health envelope with binding and resource identity', async () => {
  const events = [];
  const { backend, registry } = createHarness({
    descriptors: [{ id: 'model/broken', kind: 'model', url: 'memory:broken' }],
    loadResource: async () => { throw new Error('broken asset'); },
    onHealth: (event) => events.push(event),
  });
  await assert.rejects(() => backend.createBinding(descriptor('py/broken', 'model',
    'render.model@1', {
      modelResourceId: 'model/broken', materialOverrides: {}, castShadow: false,
      receiveShadow: false, renderOrder: 0, pickable: false, animation: null,
    }, registry)), /broken asset/u);
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      'componentKey', 'errorCode', 'nodeName', 'phase', 'recoverable', 'resourceId',
    ]);
    assert.equal(event.resourceId, 'model/broken');
    assert.equal(event.recoverable, true);
  }
  assert.equal(events[1].nodeName, 'py/broken');
  assert.equal(events[1].componentKey, 'model');
  backend.dispose();
});

test('real model clone preserves source material, validates clips, samples, and cleans up', async () => {
  const template = new THREE.Group();
  const sourceMaterial = new THREE.MeshStandardMaterial({ color: 0x80ff80, opacity: 0.8 });
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geometry, sourceMaterial); template.add(mesh);
  const clip = new THREE.AnimationClip('idle', 1, []);
  const asset = { kind: 'model', descriptor: null, template, templates: [template], animations: [clip] };
  const modelDescriptor = { id: 'model/ship', kind: 'model', url: 'memory:ship', clipNames: ['idle'] };
  const loadResource = async (resource, signal, dependencies) => resource.kind === 'model'
    ? { ...asset, descriptor: resource } : loadThreeResource(resource, signal, dependencies);
  const { backend, registry } = createHarness({ descriptors: [modelDescriptor], loadResource });
  const properties = { modelResourceId: 'model/ship',
    materialOverrides: { tintRgba: 0xff00_00ff, opacity: 0.5, emissive: 0,
      alphaMode: 'blend', alphaCutoff: 0 }, castShadow: true, receiveShadow: true,
    renderOrder: 3, pickable: true,
    animation: { clipId: 'idle', startTick: 10, clock: 'simulation', loop: true } };
  const binding = await backend.createBinding(descriptor('py/ship', 'model', 'render.model@1',
    properties, registry));
  const clonedMesh = backend._records.get(binding).handle.object.children[0];
  assert.notStrictEqual(clonedMesh.material, sourceMaterial);
  assert.equal(clonedMesh.material.color.getHex(), 0x800000);
  assert.equal(clonedMesh.material.opacity, 0.4);
  assert.equal(clonedMesh.castShadow, true);
  backend.updateBinding(binding, patch('py/ship', 'model', properties));
  backend.destroyBinding(binding);
  assert.equal(backend.diagnostics().resourceLeaseCount, 0);
  backend.dispose();
  geometry.dispose(); sourceMaterial.dispose();
});

test('model LOD plus animation is rejected before a clone becomes active', async () => {
  const makeTemplate = () => {
    const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial())); return root;
  };
  const descriptorValue = { id: 'model/lod', kind: 'model', url: 'memory:lod0',
    lodUrls: ['memory:lod1'], clipNames: ['idle'] };
  const loadResource = async (resource) => ({ kind: 'model', descriptor: resource,
    template: makeTemplate(), templates: [makeTemplate(), makeTemplate()],
    animations: [new THREE.AnimationClip('idle', 1, [])] });
  const { backend, registry } = createHarness({ descriptors: [descriptorValue], loadResource });
  await assert.rejects(() => backend.createBinding(descriptor('py/lod', 'model', 'render.model@1', {
    modelResourceId: 'model/lod', materialOverrides: {}, castShadow: false,
    receiveShadow: false, renderOrder: 0, pickable: false,
    animation: { clipId: 'idle', startTick: 0, clock: 'simulation', loop: true },
  }, registry)), /three-model-lod-animation-unsupported/u);
  assert.equal(backend.diagnostics().bindingCount, 0);
  backend.dispose();
});

test('real GLTF partial LOD failure releases the fulfilled level', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalProgressEvent = globalThis.ProgressEvent;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalSelf = globalThis.self;
  const originalGeometryDispose = THREE.BufferGeometry.prototype.dispose;
  let geometryDisposeCount = 0;
  THREE.BufferGeometry.prototype.dispose = function disposeGeometryForTest() {
    geometryDisposeCount += 1; return originalGeometryDispose.call(this);
  };
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.self = globalThis;
  globalThis.fetch = async (url) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.endsWith('/lod0.gltf')) {
      return new Response(minimalTriangleGltf(), { status: 200,
        headers: { 'content-type': 'model/gltf+json' } });
    }
    if (target.startsWith('data:')) return originalFetch(url);
    return new Response('missing', { status: 503 });
  };
  try {
    await assert.rejects(() => loadThreeResource({ id: 'model/lod', kind: 'model',
      url: 'https://example.test/lod0.gltf', lodUrls: ['https://example.test/lod1.gltf'] },
    new AbortController().signal, []), /Model request failed/u);
    assert.equal(geometryDisposeCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProgressEvent === undefined) delete globalThis.ProgressEvent;
    else globalThis.ProgressEvent = originalProgressEvent;
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
    THREE.BufferGeometry.prototype.dispose = originalGeometryDispose;
  }
});

test('destroy/recreate and backend replacement return all leases and bindings to zero', async () => {
  const first = createHarness({ descriptors: INLINE_RESOURCES });
  for (let index = 0; index < 25; index += 1) {
    const properties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
      castShadow: false, receiveShadow: false, renderOrder: index, pickable: false };
    const binding = await first.backend.createBinding(descriptor(`py/item-${index}`, 'mesh',
      'render.mesh@1', properties, first.registry));
    first.backend.destroyBinding(binding);
  }
  assert.equal(first.backend.diagnostics().bindingCount, 0);
  assert.equal(first.backend.diagnostics().nodeBindingCount, 0);
  assert.equal(first.backend.diagnostics().resourceLeaseCount, 0);
  first.backend.dispose();
  assert.equal(first.backend.diagnostics().resourceCount, 0);
  assert.equal(first.renderer.disposed, true);
  assert.equal(first.observerDisconnected, true);

  const second = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await second.backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, second.registry));
  second.backend.destroyBinding(camera); second.backend.dispose();
  assert.equal(second.backend.diagnostics().bindingCount, 0);
  assert.equal(second.backend.diagnostics().resourceLeaseCount, 0);
});

function minimalTriangleGltf() {
  const bytes = new Uint8Array(44);
  new Float32Array(bytes.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint16Array(bytes.buffer, 36, 3).set([0, 1, 2]);
  const uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
  return JSON.stringify({
    asset: { version: '2.0' }, buffers: [{ byteLength: 44, uri }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3',
        min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  });
}
