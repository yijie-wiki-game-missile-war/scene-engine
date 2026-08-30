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
  frame,
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

test('ImageBitmap textures are decoded in Three UV orientation exactly once',
  { concurrency: false }, async () => {
    const originalFetch = globalThis.fetch;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const bitmap = { width: 2, height: 2, closeCount: 0,
      close() { this.closeCount += 1; } };
    let bitmapOptions = null;
    globalThis.fetch = async () => new Response('texture-bytes', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    globalThis.createImageBitmap = async (_blob, options) => {
      bitmapOptions = options;
      return bitmap;
    };
    try {
      const asset = await loadThreeResource({
        id: 'texture/oriented', kind: 'texture', url: 'https://example.test/oriented.png',
        colorSpace: 'srgb', wrap: 'clamp',
      }, new AbortController().signal, []);
      assert.deepEqual(bitmapOptions, {
        imageOrientation: 'flipY',
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      assert.strictEqual(asset.texture.image, bitmap);
      assert.equal(asset.texture.flipY, false);
      disposeThreeResource(asset);
      assert.equal(bitmap.closeCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
      else globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

test('pending create honors AbortSignal and cannot attach a late resource', async () => {
  let resolveLoad; let disposedAsset = 0;
  const asset = { kind: 'model', descriptor: { id: 'model/slow', kind: 'model' },
    template: new THREE.Group(), templates: [new THREE.Group()] };
  const loadResource = () => new Promise((resolve) => { resolveLoad = resolve; });
  const { backend, registry } = createHarness({
    descriptors: [{ id: 'model/slow', kind: 'model', url: 'memory:slow' }],
    loadResource,
  });
  const originalDispose = backend._implementation.disposeResource;
  backend._resources.disposeAsset = (value) => { disposedAsset += 1; originalDispose(value); };
  const controller = new AbortController();
  const pending = backend.createBinding(descriptor('py/late', 'model', 'render.model@2', {
    modelResourceId: 'model/slow', materialOverrides: {}, castShadow: false,
    receiveShadow: false, renderOrder: 0, pickable: false,
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
    'render.model@2', {
      modelResourceId: 'model/late', materialOverrides: {}, castShadow: false,
      receiveShadow: false, renderOrder: 0, pickable: false,
    }, registry));
  await Promise.resolve();
  backend.dispose();
  resolveLoad({ kind: 'model', descriptor: { id: 'model/late', kind: 'model' },
    template: new THREE.Group(), templates: [new THREE.Group()] });
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
    'render.model@2', {
      modelResourceId: 'model/broken', materialOverrides: {}, castShadow: false,
      receiveShadow: false, renderOrder: 0, pickable: false,
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

test('real model clone preserves source material, updates, and cleans up', async () => {
  const template = new THREE.Group();
  const sourceMaterial = new THREE.MeshStandardMaterial({ color: 0x80ff80, opacity: 0.8 });
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geometry, sourceMaterial); template.add(mesh);
  const asset = { kind: 'model', descriptor: null, template, templates: [template] };
  const modelDescriptor = { id: 'model/ship', kind: 'model', url: 'memory:ship' };
  const loadResource = async (resource, signal, dependencies) => resource.kind === 'model'
    ? { ...asset, descriptor: resource } : loadThreeResource(resource, signal, dependencies);
  const { backend, registry } = createHarness({ descriptors: [modelDescriptor], loadResource });
  const properties = { modelResourceId: 'model/ship',
    materialOverrides: { tintRgba: 0xff00_00ff, opacity: 0.5, emissive: 0,
      alphaMode: 'blend', alphaCutoff: 0 }, castShadow: true, receiveShadow: true,
    renderOrder: 3, pickable: true };
  const binding = await backend.createBinding(descriptor('py/ship', 'model', 'render.model@2',
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

test('mesh material appearance survives ordinary, batched, and updated clones without reapplication', async () => {
  for (const spec of [
    { family: 'material.unlit', tintRgba: 0x1024_2aff, opacity: 0.28 },
    { family: 'material.standard', tintRgba: 0x4b72_9180, opacity: 0.65 },
  ]) {
    const materialDescriptor = {
      id: 'material/tinted', kind: 'material', family: spec.family,
      properties: { tintRgba: spec.tintRgba, opacity: spec.opacity, emissive: 0,
        alphaMode: 'blend', alphaCutoff: 0 },
    };
    const assets = new Map();
    const disposals = new Map();
    const watch = (object, label) => {
      disposals.set(label, 0);
      object.addEventListener('dispose', () => disposals.set(label, disposals.get(label) + 1));
    };
    const { backend, registry } = createHarness({
      descriptors: [INLINE_RESOURCES[0], materialDescriptor],
      async loadResource(resource, signal, dependencies) {
        const asset = await loadThreeResource(resource, signal, dependencies);
        assets.set(resource.id, asset);
        watch(asset.material ?? asset.geometry, resource.id);
        return asset;
      },
    });
    const assertAppearance = (material) => {
      assert.equal(material.color.getHex(), spec.tintRgba >>> 8);
      assert.equal(material.opacity, spec.opacity * ((spec.tintRgba & 255) / 255));
      assert.equal(material.transparent, true);
      assert.equal(material.depthWrite, false);
    };
    try {
      const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
        'render.camera@1', CAMERA_PROPERTIES, registry));
      backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
        new THREE.Matrix4().makeTranslation(0, 0, 5)));
      const properties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/tinted',
        castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true };
      const first = await backend.createBinding(descriptor('py/first', 'mesh', 'render.mesh@1',
        properties, registry));
      const ordinary = backend._records.get(first).handle.object;
      const sourceMaterial = assets.get('material/tinted').material;
      watch(ordinary.material, 'first-material');
      assert.notStrictEqual(ordinary.material, sourceMaterial);
      assertAppearance(sourceMaterial);
      assertAppearance(ordinary.material);
      backend.updateBinding(first, patch('py/first', 'mesh', properties));
      backend.prepareFrame(frame(camera)); backend.render();
      assert.equal(backend.diagnostics().batchCount, 0);

      const second = await backend.createBinding(descriptor('py/second', 'mesh', 'render.mesh@1',
        properties, registry));
      const peerMaterial = backend._records.get(second).handle.object.material;
      watch(peerMaterial, 'second-material');
      assert.notStrictEqual(peerMaterial, ordinary.material);
      assert.notStrictEqual(peerMaterial, sourceMaterial);
      backend.updateBinding(second, patch('py/second', 'mesh', properties,
        new THREE.Matrix4().makeTranslation(2, 0, 0)));
      backend.prepareFrame(frame(camera)); backend.render();
      assert.equal(backend.diagnostics().batchCount, 1);
      const batch = backend._batches[0].object;
      watch(batch.material, 'batch-material'); watch(batch.geometry, 'batch-geometry');
      assert.notStrictEqual(batch.material, ordinary.material);
      assertAppearance(batch.material);

      const updated = { ...properties, renderOrder: 7, castShadow: true, receiveShadow: true };
      backend.updateBinding(first, patch('py/first', 'mesh', updated));
      backend.prepareFrame(frame(camera)); backend.render();
      assert.equal(backend.diagnostics().batchCount, 0);
      assert.equal(ordinary.renderOrder, 7);
      assert.equal(ordinary.castShadow, true);
      assert.equal(ordinary.receiveShadow, true);
      assertAppearance(ordinary.material);
      assertAppearance(peerMaterial);
      assertAppearance(sourceMaterial);
      assert.equal(disposals.get('batch-material'), 1);
      assert.equal(disposals.get('batch-geometry'), 1);
      assert.equal(disposals.get('material/tinted'), 0);

      backend.updateBinding(first, patch('py/first', 'mesh', properties));
      backend.prepareFrame(frame(camera)); backend.render();
      const rebuiltBatch = backend._batches[0].object;
      watch(rebuiltBatch.material, 'rebuilt-material'); watch(rebuiltBatch.geometry, 'rebuilt-geometry');
      assertAppearance(rebuiltBatch.material);
      backend.destroyBinding(second);
      assert.equal(disposals.get('second-material'), 1);
      assert.equal(disposals.get('first-material'), 0);
      assert.equal(disposals.get('material/tinted'), 0, 'the remaining mesh still leases the resource');
      backend.destroyBinding(first); backend.destroyBinding(camera);
      assert.equal(backend.diagnostics().resourceLeaseCount, 0);
      assert.equal(backend.diagnostics().resourceCount, 0);
      backend.dispose();
      for (const [label, count] of disposals) assert.equal(count, 1, label);
    } finally {
      backend.dispose();
    }
  }
});

test('model properties carrying legacy animation fields are rejected fail-closed', async () => {
  const makeTemplate = () => {
    const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial())); return root;
  };
  const descriptorValue = { id: 'model/lod', kind: 'model', url: 'memory:lod0',
    lodUrls: ['memory:lod1'] };
  const loadResource = async (resource) => ({ kind: 'model', descriptor: resource,
    template: makeTemplate(), templates: [makeTemplate(), makeTemplate()] });
  const { backend, registry } = createHarness({ descriptors: [descriptorValue], loadResource });
  await assert.rejects(() => backend.createBinding(descriptor('py/lod', 'model', 'render.model@2', {
    modelResourceId: 'model/lod', materialOverrides: {}, castShadow: false,
    receiveShadow: false, renderOrder: 0, pickable: false,
    animation: { clipId: 'idle', startTick: 0, clock: 'simulation', loop: true },
  }, registry)), /three-model-properties-invalid/u);
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
