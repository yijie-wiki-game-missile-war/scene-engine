import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { ResourceManager } from '../src/resource-manager.js';
import { DEFAULT_THREE_ADAPTER } from '../src/three-adapter.js';

const IDENTITY_TRANSFORM = Object.freeze({
  position: Object.freeze([0, 0, 0]),
  rotationXyzw: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
});

test('real Three model@2 preserves source material and multiplies tint for normal and batch paths', () => {
  const map = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const roughnessMap = new THREE.Texture();
  const source = new THREE.MeshStandardMaterial({
    color: 0x804020,
    emissive: 0x101820,
    map,
    normalMap,
    roughnessMap,
    opacity: 0.8,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    alphaTest: 0.17,
    vertexColors: true,
    toneMapped: false,
  });
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const template = new THREE.Group();
  template.add(new THREE.Mesh(geometry, source));
  const asset = { kind: 'model-url', template, templates: [template], animations: [] };
  const layer = modelLayer({
    material: material({
      tintRgba: 0x80ff_8080,
      opacity: 0.5,
      emissive: 0.25,
      alphaMode: 'inherit',
    }),
  });

  const handle = DEFAULT_THREE_ADAPTER.createPipelineObject(
    'model@2', asset, layer, { camera: new THREE.PerspectiveCamera() },
  );
  const batch = DEFAULT_THREE_ADAPTER.createInstanceBatch(
    'model@2', asset, layer, { camera: new THREE.PerspectiveCamera() },
  );
  const composed = firstMesh(handle.object).material;
  const batched = batch.object.material;

  assertColorClose(composed.color, new THREE.Color(0x804020).multiply(new THREE.Color(0x80ff80)));
  assertColorClose(composed.color, batched.color);
  assertColorClose(
    composed.emissive,
    new THREE.Color(0x101820).add(new THREE.Color(0x80ff80).multiplyScalar(0.25)),
  );
  assert.equal(composed.opacity, 0.8 * 0.5 * (0x80 / 0xff));
  assert.equal(composed.transparent, true);
  assert.equal(composed.depthWrite, false);
  assert.equal(composed.depthTest, false);
  assert.equal(composed.alphaTest, 0.17);
  assert.equal(composed.side, THREE.DoubleSide);
  assert.equal(composed.vertexColors, true);
  assert.equal(composed.toneMapped, false);
  assert.equal(composed.map, map);
  assert.equal(composed.normalMap, normalMap);
  assert.equal(composed.roughnessMap, roughnessMap);
  assert.equal(source.color.getHex(), 0x804020, 'source material is immutable');
  assert.equal(source.opacity, 0.8);

  const materialIdentity = composed;
  const next = modelLayer({
    material: material({ tintRgba: 0x40_80_ffff, opacity: 1, emissive: 0, alphaMode: 'mask', alphaCutoff: 0.4 }),
  });
  assert.equal(handle.update(layer, next, {}), true);
  assert.equal(firstMesh(handle.object).material, materialIdentity);
  assert.equal(materialIdentity.transparent, false);
  assert.equal(materialIdentity.depthWrite, true);
  assert.equal(materialIdentity.alphaTest, 0.4);
  assert.equal(batch.updateLayer(layer, next, {}), true);
  assertColorClose(materialIdentity.color, batch.object.material.color);

  handle.dispose();
  batch.dispose();
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
});

test('real Three model disposal retires the lazily allocated skeleton bone texture', () => {
  const bone = new THREE.Bone();
  const mesh = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const template = new THREE.Group();
  template.add(mesh);
  const asset = { kind: 'model-url', template, templates: [template], animations: [] };
  const handle = DEFAULT_THREE_ADAPTER.createPipelineObject(
    'model@2',
    asset,
    modelLayer({ params: { castShadow: true, receiveShadow: false, instance: false } }),
    { camera: new THREE.PerspectiveCamera() },
  );
  const clone = handle.object.getObjectByProperty('isSkinnedMesh', true);
  const boneTexture = new THREE.DataTexture(new Float32Array(16), 4, 1);
  let disposeCount = 0;
  boneTexture.addEventListener('dispose', () => { disposeCount += 1; });
  clone.skeleton.boneTexture = boneTexture;

  handle.dispose();
  assert.equal(disposeCount, 1);
  assert.equal(clone.skeleton.boneTexture, null);
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
});

test('real Three primitive model keeps every part base color under layer tint', async () => {
  const descriptor = {
    kind: 'primitive-model',
    parts: [
      primitivePart(0xff0000ff, [-1, 0, 0]),
      primitivePart(0x00ff00ff, [1, 0, 0]),
    ],
  };
  const asset = await DEFAULT_THREE_ADAPTER.createResource(
    descriptor,
    new AbortController().signal,
    [],
  );
  const layer = modelLayer({
    material: material({ tintRgba: 0x8080ffff, alphaMode: 'inherit' }),
    params: { castShadow: false, receiveShadow: false, instance: false },
  });
  const handle = DEFAULT_THREE_ADAPTER.createPipelineObject('model@2', asset, layer, {});
  const colors = [];
  handle.object.traverse((item) => { if (item.isMesh) colors.push(item.material.color.getHex()); });
  assert.deepEqual(colors, [0x800000, 0x008000]);
  handle.dispose();
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
});

test('real Three sprite@2 applies explicit alpha, atlas, flipbook, and billboard semantics', () => {
  const texture = new THREE.Texture();
  const asset = {
    kind: 'texture-atlas',
    texture,
    descriptor: { kind: 'texture-atlas', columns: 4, rows: 2 },
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(6, 4, 8);
  camera.lookAt(0, 0, 0);
  const layer = spriteLayer({
    params: {
      orientation: 'billboard', width: 2, height: 3, atlasCell: 5,
      flipbook: { startCell: 2, frameCount: 4, frameTicks: 2, loop: true },
    },
    animation: animation({ clock: 'simulation', startTick: 10n }),
    material: material({ alphaMode: 'mask', alphaCutoff: 0.37 }),
  });
  const parent = new THREE.Group();
  parent.rotation.y = 0.4;
  const handle = DEFAULT_THREE_ADAPTER.createPipelineObject('sprite@2', asset, layer, { camera });
  parent.add(handle.object);
  parent.updateMatrixWorld(true);

  assert.equal(handle.object.material.transparent, false);
  assert.equal(handle.object.material.depthWrite, true);
  assert.equal(handle.object.material.alphaTest, 0.37);
  handle.sample(0, 14);
  assert.deepEqual(handle.object.material.map.repeat.toArray(), [0.25, 0.5]);
  assert.deepEqual(handle.object.material.map.offset.toArray(), [0, 0]);
  assertWorldQuaternionClose(handle.object, camera);

  const next = spriteLayer({
    params: { orientation: 'fixed', width: 4, height: 1, atlasCell: 1 },
    material: material({ alphaMode: 'blend', opacity: 0.6 }),
  });
  const objectIdentity = handle.object;
  const materialIdentity = handle.object.material;
  assert.equal(handle.update(layer, next, {}), true);
  assert.equal(handle.object, objectIdentity);
  assert.equal(handle.object.material, materialIdentity);
  assert.equal(materialIdentity.transparent, true);
  assert.equal(materialIdentity.depthWrite, false);
  assert.equal(materialIdentity.alphaTest, 0);
  assert.deepEqual(handle.object.scale.toArray(), [4, 1, 1]);
  handle.dispose();
  texture.dispose();
});

test('real Three sprite batch rejects flipbooks and refreshes billboard matrices without allocation policy leaks', () => {
  const asset = {
    kind: 'texture-atlas', texture: new THREE.Texture(),
    descriptor: { kind: 'texture-atlas', columns: 2, rows: 2 },
  };
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 4, 10);
  camera.lookAt(0, 0, 0);
  const animated = spriteLayer({
    params: {
      orientation: 'billboard', width: 1, height: 1, atlasCell: 0,
      flipbook: { startCell: 0, frameCount: 2, frameTicks: 1, loop: true },
    },
    animation: animation(),
  });
  assert.equal(DEFAULT_THREE_ADAPTER.createInstanceBatch('sprite@2', asset, animated, { camera }), null);

  const layer = spriteLayer({ params: { orientation: 'y-billboard', width: 2, height: 3, atlasCell: 0 } });
  const batch = DEFAULT_THREE_ADAPTER.createInstanceBatch('sprite@2', asset, layer, { camera });
  const member = new THREE.Group();
  member.position.set(2, 0, 1);
  member.updateMatrixWorld(true);
  batch.update([{ container: member, displayId: 1n, layerKey: 'body' }]);
  const before = matrixAt(batch.object, 0);
  camera.position.set(10, 5, 0);
  batch.prepareDraw();
  assert.notDeepEqual(matrixAt(batch.object, 0), before);
  batch.dispose();
  asset.texture.dispose();
});

test('real Three surface@2 owns independent segments and water uses every uniform with zero render targets', async () => {
  const descriptor = {
    kind: 'surface',
    family: 'surface.water',
    geometry: { primitive: 'plane', width: 10, height: 7, segmentsX: 3, segmentsY: 2 },
    textureResourceIds: [],
    defaults: { amplitude: 0.2, speed: 1.5, foam: 0.4, textureScale: 3 },
  };
  const asset = await DEFAULT_THREE_ADAPTER.createResource(
    descriptor,
    new AbortController().signal,
    [],
  );
  const layer = surfaceLayer({ params: { amplitude: 0.7 }, material: material({ alphaMode: 'blend', opacity: 0.8 }) });
  const handle = DEFAULT_THREE_ADAPTER.createPipelineObject('surface@2', asset, layer, {});
  const { geometry, material: shader } = handle.object;

  assert.equal(geometry.attributes.position.count, 12, '(segmentsX+1)*(segmentsY+1)');
  assert.equal(geometry.index.count, 36, 'segmentsX*segmentsY*6');
  assert.equal(shader.isShaderMaterial, true);
  assert.equal(shader.uniforms.amplitude.value, 0.7);
  assert.equal(shader.uniforms.speed.value, 1.5);
  assert.equal(shader.uniforms.foam.value, 0.4);
  assert.equal(shader.uniforms.textureScale.value, 3);
  assert.equal(shader.transparent, true);
  assert.equal(shader.depthWrite, false);
  assert.match(shader.vertexShader, /position \+ normal \*/);
  assert.match(shader.vertexShader, /speed/);
  assert.match(shader.fragmentShader, /foam/);
  assert.equal('renderTargetPassCount' in handle, false);
  assert.equal(findRenderTargets(handle).length, 0);
  handle.sample(2.25, 0);
  assert.equal(shader.uniforms.time.value, 2.25);

  const materialIdentity = shader;
  const next = surfaceLayer({
    params: { amplitude: 0.1, speed: 2, foam: 0.9, textureScale: 5 },
    material: material({ alphaMode: 'opaque', opacity: 1 }),
  });
  assert.equal(handle.update(layer, next, {}), true);
  assert.equal(handle.object.material, materialIdentity);
  assert.equal(shader.uniforms.speed.value, 2);
  assert.equal(shader.transparent, false);
  handle.dispose();
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
});

test('real Three particle@2 is deterministic, blended, and updates typed storage in place', () => {
  const asset = {
    kind: 'particle',
    descriptor: { kind: 'particle', textureResourceId: null, maximumCapacity: 32 },
    dependencies: [],
  };
  const layer = particleLayer();
  const first = DEFAULT_THREE_ADAPTER.createPipelineObject('particle@2', asset, layer, {});
  const second = DEFAULT_THREE_ADAPTER.createPipelineObject('particle@2', asset, layer, {});
  first.sample(1.25, 75);
  second.sample(1.25, 75);
  assert.deepEqual(
    [...first.object.geometry.attributes.position.array],
    [...second.object.geometry.attributes.position.array],
  );
  assert.equal(first.object.material.transparent, true);
  assert.equal(first.object.material.depthWrite, false);
  assert.equal(first.object.material.depthTest, true);
  assert.equal(first.object.material.blending, THREE.AdditiveBlending);
  const geometryIdentity = first.object.geometry;
  const next = particleLayer({ params: { ...layer.params, capacity: 24, size: 4, blendMode: 'normal' } });
  assert.equal(first.update(layer, next, {}), true);
  assert.equal(first.object.geometry, geometryIdentity);
  assert.equal(first.object.material.size, 4);
  assert.equal(first.object.material.blending, THREE.NormalBlending);
  first.dispose();
  second.dispose();
});

test('real Three resource disposal deduplicates geometry, material, texture, and ImageBitmap', () => {
  const geometry = new THREE.BufferGeometry();
  const image = { closeCount: 0, close() { this.closeCount += 1; } };
  const texture = new THREE.Texture(image);
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const first = new THREE.Group();
  const second = new THREE.Group();
  first.add(new THREE.Mesh(geometry, material));
  second.add(new THREE.Mesh(geometry, material));
  const counts = { geometry: 0, material: 0, texture: 0 };
  geometry.addEventListener('dispose', () => { counts.geometry += 1; });
  material.addEventListener('dispose', () => { counts.material += 1; });
  texture.addEventListener('dispose', () => { counts.texture += 1; });
  const asset = { kind: 'model-url', template: first, templates: [first, second], animations: [] };

  DEFAULT_THREE_ADAPTER.disposeResource(asset);
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
  assert.deepEqual(counts, { geometry: 1, material: 1, texture: 1 });
  assert.equal(image.closeCount, 1);
});

test('ResourceManager retires a late shared asset exactly once after the final lease releases', async () => {
  let resolveAsset;
  const asset = {};
  let disposeCount = 0;
  const manager = new ResourceManager({
    adapter: {
      createResource() {
        return new Promise((resolve) => { resolveAsset = resolve; });
      },
      disposeResource(value) {
        assert.equal(value, asset);
        disposeCount += 1;
      },
    },
    catalog: { resources: { model: { kind: 'model-url', url: '/model.glb' } } },
    onFailure(_resourceId, error) { throw error; },
  });
  const first = manager.acquire('model');
  const second = manager.acquire('model');
  first.release();
  first.release();
  assert.equal(disposeCount, 0);
  second.release();
  assert.equal(manager.capture().resourceCount, 0);
  await Promise.resolve();
  resolveAsset(asset);
  await manager.whenIdle();
  assert.equal(disposeCount, 1);
  manager.dispose();
  assert.equal(disposeCount, 1);
});

test('real GLTF partial LOD failure disposes the fulfilled level before rejecting', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalProgressEvent = globalThis.ProgressEvent;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalSelf = globalThis.self;
  const originalGeometryDispose = THREE.BufferGeometry.prototype.dispose;
  const originalMaterialDispose = THREE.Material.prototype.dispose;
  const originalTextureDispose = THREE.Texture.prototype.dispose;
  let geometryDisposeCount = 0;
  let materialDisposeCount = 0;
  let textureDisposeCount = 0;
  let imageCloseCount = 0;
  THREE.BufferGeometry.prototype.dispose = function disposeGeometryForTest() {
    geometryDisposeCount += 1;
    return originalGeometryDispose.call(this);
  };
  THREE.Material.prototype.dispose = function disposeMaterialForTest() {
    materialDisposeCount += 1;
    return originalMaterialDispose.call(this);
  };
  THREE.Texture.prototype.dispose = function disposeTextureForTest() {
    textureDisposeCount += 1;
    return originalTextureDispose.call(this);
  };
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
  globalThis.createImageBitmap = async () => ({
    width: 1,
    height: 1,
    close() { imageCloseCount += 1; },
  });
  globalThis.self = globalThis;
  globalThis.fetch = async (url) => {
    const target = typeof url === 'string' ? url : url.url;
    if (target.endsWith('/lod0.gltf')) {
      return new Response(minimalTriangleGltf(), { status: 200, headers: { 'content-type': 'model/gltf+json' } });
    }
    if (target.startsWith('data:')) return originalFetch(url);
    return new Response('missing', { status: 503 });
  };
  try {
    await assert.rejects(
      DEFAULT_THREE_ADAPTER.createResource(
        {
          kind: 'model-url',
          url: 'https://example.test/lod0.gltf',
          lodUrls: ['https://example.test/lod1.gltf'],
        },
        new AbortController().signal,
        [],
      ),
      /Model request failed \(503\)/,
    );
    assert.equal(geometryDisposeCount, 1);
    assert.equal(materialDisposeCount, 1);
    assert.equal(textureDisposeCount, 1);
    assert.equal(imageCloseCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProgressEvent === undefined) delete globalThis.ProgressEvent;
    else globalThis.ProgressEvent = originalProgressEvent;
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
    THREE.BufferGeometry.prototype.dispose = originalGeometryDispose;
    THREE.Material.prototype.dispose = originalMaterialDispose;
    THREE.Texture.prototype.dispose = originalTextureDispose;
  }
});

test('pan-zoom controls provide mouse/touch parity, bounds, damping, focus, and exact listener disposal', () => {
  const host = new FakeHost();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1_000);
  camera.position.set(0, 8, 12);
  const profile = cameraProfile({
    controls: {
      mode: 'pan-zoom', dampingFactor: 0.25, panSpeed: 1,
      zoomSpeed: 1, panBounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 },
    },
  });
  let changes = 0;
  const controls = DEFAULT_THREE_ADAPTER.createControls(camera, host, profile, () => { changes += 1; });
  assert.equal(controls.listenerCount, 6);
  const initialDistance = camera.position.distanceTo(controls.target);

  host.emit('wheel', { deltaY: -120 });
  for (let index = 0; index < 80; index += 1) controls.update();
  assert.ok(camera.position.distanceTo(controls.target) < initialDistance);

  host.emit('pointerdown', mouse(1, 0, 100, 100));
  host.emit('pointermove', mouse(1, 0, 1000, -900));
  host.emit('pointerup', mouse(1, 0, 1000, -900));
  for (let index = 0; index < 80; index += 1) controls.update();
  assert.ok(controls.target.x >= -1 && controls.target.x <= 1);
  assert.ok(controls.target.z >= -1 && controls.target.z <= 1);

  const beforeTouch = controls.target.clone();
  host.emit('pointerdown', touch(2, 100, 100));
  host.emit('pointermove', touch(2, 130, 120));
  host.emit('pointerup', touch(2, 130, 120));
  for (let index = 0; index < 20; index += 1) controls.update();
  assert.notDeepEqual(controls.target.toArray(), beforeTouch.toArray());

  controls.focus([0.5, 0, -0.5], 2);
  assert.equal(controls.target.x, 0.5);
  assert.equal(controls.target.z, -0.5);
  assert.ok(changes > 0);
  controls.dispose();
  assert.equal(controls.listenerCount, 0);
  assert.equal(host.listenerCount, 0);
  controls.dispose();
});

test('scene-pass@2 replacement is singleton, disposes shadow targets, and clears state', () => {
  const scene = new THREE.Scene();
  const backgroundDescriptor = {
    kind: 'scene-pass', passKind: 'background', defaults: { colorRgba: 0x204060ff },
  };
  const lightsDescriptor = {
    kind: 'scene-pass', passKind: 'lights',
    defaults: { colorRgba: 0xffe0c0ff, intensity: 2, direction: [3, 5, 7] },
  };
  const background = scenePassLayer('background.resource');
  const lights = scenePassLayer('lights.resource');
  DEFAULT_THREE_ADAPTER.replaceScenePassState(null, scene, [
    { key: 'lights', descriptor: lightsDescriptor, layer: lights },
    { key: 'background', descriptor: backgroundDescriptor, layer: background },
  ]);
  assert.equal(scene.background.getHex(), 0x204060);
  assert.equal(scene.children.filter((item) => item.name === 'SceneEngineLights').length, 1);
  assert.equal(scene.getObjectsByProperty('isAmbientLight', true).length, 1);
  assert.equal(scene.getObjectsByProperty('isDirectionalLight', true).length, 1);
  const previousDirectional = scene.getObjectByProperty('isDirectionalLight', true);
  const originalShadowDispose = previousDirectional.shadow.dispose.bind(previousDirectional.shadow);
  let shadowDisposeCount = 0;
  previousDirectional.shadow.dispose = () => {
    shadowDisposeCount += 1;
    originalShadowDispose();
  };

  DEFAULT_THREE_ADAPTER.replaceScenePassState(null, scene, [
    { key: 'background', descriptor: { ...backgroundDescriptor, defaults: { colorRgba: 0x102030ff } }, layer: background },
  ]);
  assert.equal(shadowDisposeCount, 1);
  assert.equal(scene.background.getHex(), 0x102030);
  assert.equal(scene.children.filter((item) => item.name === 'SceneEngineLights').length, 0);
  DEFAULT_THREE_ADAPTER.replaceScenePassState(null, scene, []);
  assert.equal(scene.background, null);
  assert.equal(scene.children.length, 0);
});

test('renderer replacement restores WebGL2 pixel-store defaults before 3D placeholders', () => {
  const names = [
    'UNPACK_FLIP_Y_WEBGL',
    'UNPACK_PREMULTIPLY_ALPHA_WEBGL',
    'UNPACK_ALIGNMENT',
    'UNPACK_ROW_LENGTH',
    'UNPACK_IMAGE_HEIGHT',
    'UNPACK_SKIP_PIXELS',
    'UNPACK_SKIP_ROWS',
    'UNPACK_SKIP_IMAGES',
    'PACK_ALIGNMENT',
    'PACK_ROW_LENGTH',
    'PACK_SKIP_PIXELS',
    'PACK_SKIP_ROWS',
    'UNPACK_COLORSPACE_CONVERSION_WEBGL',
    'BROWSER_DEFAULT_WEBGL',
  ];
  const calls = [];
  const gl = Object.fromEntries(names.map((name, index) => [name, index + 1]));
  gl.pixelStorei = (key, value) => calls.push([key, value]);

  DEFAULT_THREE_ADAPTER.resetRendererContext({ getContext: () => gl });

  assert.deepEqual(calls, [
    [gl.UNPACK_FLIP_Y_WEBGL, false],
    [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false],
    [gl.UNPACK_ALIGNMENT, 4],
    [gl.UNPACK_ROW_LENGTH, 0],
    [gl.UNPACK_IMAGE_HEIGHT, 0],
    [gl.UNPACK_SKIP_PIXELS, 0],
    [gl.UNPACK_SKIP_ROWS, 0],
    [gl.UNPACK_SKIP_IMAGES, 0],
    [gl.PACK_ALIGNMENT, 4],
    [gl.PACK_ROW_LENGTH, 0],
    [gl.PACK_SKIP_PIXELS, 0],
    [gl.PACK_SKIP_ROWS, 0],
    [gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL],
  ]);
});

function primitivePart(tintRgba, position) {
  return {
    shape: 'box', dimensions: [1, 1, 1],
    transform: { ...IDENTITY_TRANSFORM, position },
    material: { tintRgba, opacity: 1, emissive: 0 },
  };
}

function modelLayer(overrides = {}) {
  return layer('model@2', {
    params: { castShadow: true, receiveShadow: false, instance: true },
    material: material({ alphaMode: 'inherit' }),
    ...overrides,
  });
}

function spriteLayer(overrides = {}) {
  return layer('sprite@2', {
    params: { orientation: 'fixed', width: 1, height: 1 },
    material: material({ alphaMode: 'mask', alphaCutoff: 0.1 }),
    ...overrides,
  });
}

function surfaceLayer(overrides = {}) {
  return layer('surface@2', {
    params: { amplitude: 0.2, speed: 1, foam: 0.3, textureScale: 1 },
    material: material({ alphaMode: 'opaque' }),
    ...overrides,
  });
}

function particleLayer(overrides = {}) {
  return layer('particle@2', {
    params: {
      durationTicks: 120, capacity: 16, seed: 9182, rate: 10, size: 2,
      velocity: [1, 2, 3], spread: [0.5, 0.5, 0.5], gravity: [0, -9.8, 0],
      blendMode: 'additive',
    },
    animation: animation(),
    material: material({ alphaMode: 'blend', opacity: 0.7, emissive: 0.2 }),
    ...overrides,
  });
}

function scenePassLayer(resourceId) {
  return layer('scene-pass@2', {
    resourceId,
    params: {},
    material: material({ alphaMode: 'opaque', opacity: 1, emissive: 0 }),
    pickable: false,
  });
}

function layer(pipelineId, overrides = {}) {
  return {
    key: 'body', pipelineId, resourceId: 'resource',
    transform: IDENTITY_TRANSFORM,
    material: material(), animation: null, params: {}, batchKey: 'batch',
    pickable: true, renderOrder: 10,
    ...overrides,
  };
}

function material(overrides = {}) {
  return {
    tintRgba: 0xffff_ffff, opacity: 1, emissive: 0,
    alphaMode: 'opaque', alphaCutoff: 0,
    ...overrides,
  };
}

function animation(overrides = {}) {
  return {
    stateId: 1, clipId: 'effect', startTick: 0n, flags: 0, clock: 'simulation',
    ...overrides,
  };
}

function cameraProfile(overrides = {}) {
  return {
    projection: 'perspective', position: [0, 8, 12], target: [0, 0, 0], up: [0, 1, 0],
    fovYDegrees: 50, near: 0.1, far: 1_000, minDistance: 1, maxDistance: 100,
    controls: {
      mode: 'pan-zoom', dampingFactor: 0, panSpeed: 1, zoomSpeed: 1, panBounds: null,
    },
    ...overrides,
  };
}

function firstMesh(object) {
  let result = null;
  object.traverse((item) => { if (!result && item.isMesh) result = item; });
  return result;
}

function assertColorClose(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual.r - expected.r) <= tolerance, `${actual.r} != ${expected.r}`);
  assert.ok(Math.abs(actual.g - expected.g) <= tolerance, `${actual.g} != ${expected.g}`);
  assert.ok(Math.abs(actual.b - expected.b) <= tolerance, `${actual.b} != ${expected.b}`);
}

function assertWorldQuaternionClose(object, camera) {
  object.updateWorldMatrix(true, false);
  camera.updateWorldMatrix(true);
  const actual = object.getWorldQuaternion(new THREE.Quaternion());
  const expected = camera.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(1 - Math.abs(actual.dot(expected)) < 1e-8);
}

function matrixAt(mesh, index) {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix.elements.slice();
}

function findRenderTargets(root) {
  const found = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
    seen.add(value);
    if (value.isWebGLRenderTarget) found.push(value);
    if (seen.size > 2_000) return;
    for (const item of Object.values(value)) visit(item);
  };
  visit(root);
  return found;
}

function minimalTriangleGltf() {
  const bytes = new Uint8Array(44);
  new Float32Array(bytes.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint16Array(bytes.buffer, 36, 3).set([0, 1, 2]);
  const uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
  return JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 44, uri }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    images: [{ uri: 'data:image/png;base64,AA==' }],
    textures: [{ source: 0 }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [0.2, 0.4, 0.6, 1],
        baseColorTexture: { index: 0 },
      },
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  });
}

class FakeHost {
  constructor() { this.listeners = new Map(); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, set) => count + set.size, 0); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, ...event });
  }
}

function mouse(pointerId, button, clientX, clientY) {
  return { pointerId, pointerType: 'mouse', button, clientX, clientY };
}

function touch(pointerId, clientX, clientY) {
  return { pointerId, pointerType: 'touch', button: 0, clientX, clientY };
}
