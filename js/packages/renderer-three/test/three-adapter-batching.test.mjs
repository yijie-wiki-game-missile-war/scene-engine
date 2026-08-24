import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
  RENDER_COMPOSITION_SCHEMA,
  RENDER_SNAPSHOT_SCHEMA,
} from '../src/index.js';
import { createThreeRenderRuntimeForTest } from '../src/testing.js';
import { DEFAULT_THREE_ADAPTER } from '../src/three-adapter.js';

for (const orientation of ['billboard', 'y-billboard']) {
  test(`real Three ${orientation} sprites share one batch and refresh once per draw`, async () => {
    const fixture = createSpriteRuntime(orientation);
    fixture.runtime.install(fixture.installation);
    await fixture.runtime.whenIdle();

    assert.equal(fixture.runtime.capture().batchCount, 1);
    assert.equal(fixture.batch().object.count, 2);

    fixture.runtime.start();
    fixture.draw(16);
    assert.equal(fixture.prepareCount(), 1);
    assertSpritesFaceCamera(fixture.batch().object, fixture.camera(), orientation);
    const before = matrixElements(fixture.batch().object, 0);

    fixture.camera().position.set(10, 6, 0);
    fixture.camera().lookAt(0, 0, 0);
    fixture.controlsChanged();
    fixture.draw(32);

    assert.equal(fixture.prepareCount(), 2, 'the batch was prepared exactly once per draw');
    assert.notDeepEqual(matrixElements(fixture.batch().object, 0), before);
    assertSpritesFaceCamera(fixture.batch().object, fixture.camera(), orientation);
    assert.equal(fixture.maximumPendingRaf(), 1, 'one Runtime RAF owns every batch member');
    fixture.runtime.dispose();
  });
}

test('real Three single-mesh model assets form an opaque instance batch', () => {
  const template = new THREE.Group();
  template.add(new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  ));
  const asset = { animations: [], kind: 'model-url', template, templates: [template] };
  const handle = DEFAULT_THREE_ADAPTER.createInstanceBatch(
    'model@2',
    asset,
    modelLayer(),
    { camera: new THREE.PerspectiveCamera() },
  );
  const first = new THREE.Group();
  const second = new THREE.Group();
  first.position.set(2, 3, 4);
  second.position.set(-5, 1, 7);
  first.updateMatrixWorld(true);
  second.updateMatrixWorld(true);
  handle.update([
    { container: first, displayId: 1n, layerKey: 'body' },
    { container: second, displayId: 2n, layerKey: 'body' },
  ]);

  assert.ok(handle.object.isInstancedMesh);
  assert.equal(handle.object.count, 2);
  assert.deepEqual(matrixPosition(handle.object, 0), [2, 3, 4]);
  assert.deepEqual(matrixPosition(handle.object, 1), [-5, 1, 7]);
  handle.dispose();
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
});

function createSpriteRuntime(orientation) {
  let batchHandle = null;
  let camera = null;
  let controlsChanged = null;
  let nextRaf = 1;
  let prepareCount = 0;
  let maximumPendingRaf = 0;
  const rafCallbacks = new Map();
  const adapter = {
    ...DEFAULT_THREE_ADAPTER,
    createRenderer() { return {}; },
    disposeRenderer() {},
    createCamera(profile, aspect) {
      camera = DEFAULT_THREE_ADAPTER.createCamera(profile, aspect);
      return camera;
    },
    createControls(_camera, _element, _profile, onChange) {
      controlsChanged = onChange;
      return { dispose() {}, focus() { onChange(); }, update() { return false; } };
    },
    createResizeObserver() { return { disconnect() {}, observe() {} }; },
    setViewport(_renderer, nextCamera, profile, width, height) {
      DEFAULT_THREE_ADAPTER.resizeCamera(nextCamera, profile, width / height);
    },
    render() {},
    requestAnimationFrame(callback) {
      const identity = nextRaf;
      nextRaf += 1;
      rafCallbacks.set(identity, callback);
      maximumPendingRaf = Math.max(maximumPendingRaf, rafCallbacks.size);
      return identity;
    },
    cancelAnimationFrame(identity) { rafCallbacks.delete(identity); },
    now() { return 0; },
    devicePixelRatio() { return 1; },
    async createResource(descriptor) {
      return { descriptor, kind: descriptor.kind, texture: new THREE.Texture() };
    },
    disposeResource(asset) { asset.texture.dispose(); },
    createInstanceBatch(...args) {
      batchHandle = DEFAULT_THREE_ADAPTER.createInstanceBatch(...args);
      const prepareDraw = batchHandle.prepareDraw;
      batchHandle.prepareDraw = () => {
        prepareCount += 1;
        prepareDraw();
      };
      return batchHandle;
    },
  };
  const runtime = createThreeRenderRuntimeForTest(options(), adapter);
  const nodes = [node(1n, [0, 0, 0]), node(2n, [2, 0, 0])];
  const view = sceneView(nodes);
  const layers = nodes.map(({ displayId }) => composition(displayId, spriteLayer(orientation)));
  return {
    batch: () => batchHandle,
    camera: () => camera,
    controlsChanged: () => controlsChanged(),
    draw(timestamp) {
      assert.equal(rafCallbacks.size, 1);
      const callbacks = [...rafCallbacks.values()];
      rafCallbacks.clear();
      callbacks[0](timestamp);
    },
    installation: {
      view,
      snapshot: {
        schema: RENDER_SNAPSHOT_SCHEMA,
        generation: 1,
        commitSeq: 1,
        sourceTick: 1,
        compositions: layers,
        sceneLayers: [],
      },
    },
    maximumPendingRaf: () => maximumPendingRaf,
    prepareCount: () => prepareCount,
    runtime,
  };
}

function options() {
  return {
    hostElement: {
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; },
    },
    canvas: { getContext() { return {}; } },
    cameraProfile: {
      projection: 'perspective',
      position: [0, 4, 10],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 50,
      near: 0.1,
      far: 1_000,
      minDistance: 1,
      maxDistance: 100,
      controls: {
        mode: 'pan-zoom',
        dampingFactor: 0.08,
        panSpeed: 1,
        zoomSpeed: 1,
        panBounds: null,
      },
    },
    rendererProfile: {
      drawMode: 'requested',
      maximumPixelRatio: 2,
      clearRgba: 0x000000ff,
      antialias: true,
      alpha: false,
      shadows: false,
      toneMapping: 'none',
    },
    resourceCatalog: {
      schema: 'scene-engine-render-resource-catalog@2',
      resources: {
        'test.sprite': { kind: 'texture', url: '/sprite.png' },
      },
    },
  };
}

function node(displayId, localPosition) {
  return Object.freeze({
    displayId,
    parentDisplayId: 0n,
    localPosition: Object.freeze(localPosition),
    localRotationXyzw: Object.freeze([0, 0, 0, 1]),
    localScale: Object.freeze([1, 1, 1]),
    flags: 1,
  });
}

function sceneView(nodes) {
  const byId = new Map(nodes.map((item) => [item.displayId, item]));
  return Object.freeze({
    generation: 1,
    commitSeq: 1,
    sourceTick: 1,
    nodeCount: nodes.length,
    nodeAt(index) { return nodes[index] ?? null; },
    getNode(displayId) { return byId.get(displayId) ?? null; },
  });
}

function composition(displayId, layer) {
  return {
    schema: RENDER_COMPOSITION_SCHEMA,
    displayId,
    renderRevision: 1,
    layers: [layer],
  };
}

function spriteLayer(orientation) {
  return {
    key: 'body',
    pipelineId: 'sprite@2',
    resourceId: 'test.sprite',
    transform: transform(),
    material: material({ alphaMode: 'mask', alphaCutoff: 0.03 }),
    animation: null,
    params: { orientation, width: 2, height: 3 },
    batchKey: `test:${orientation}`,
    pickable: true,
    renderOrder: 10,
  };
}

function modelLayer() {
  return {
    key: 'body',
    pipelineId: 'model@2',
    resourceId: 'test.model',
    transform: transform(),
    material: material(),
    animation: null,
    params: { castShadow: true, receiveShadow: false, instance: true },
    batchKey: 'test:model',
    pickable: false,
    renderOrder: 20,
  };
}

function transform() {
  return {
    position: [0, 0, 0],
    rotationXyzw: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function material(overrides = {}) {
  return {
    tintRgba: 0xffffffff,
    opacity: 1,
    emissive: 0,
    alphaMode: 'opaque',
    alphaCutoff: 0,
    ...overrides,
  };
}

function assertSpritesFaceCamera(instancedMesh, camera, orientation) {
  camera.updateMatrixWorld(true);
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const cameraQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
  for (let index = 0; index < instancedMesh.count; index += 1) {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    instancedMesh.getMatrixAt(index, matrix);
    matrix.decompose(position, quaternion, scale);
    if (orientation === 'billboard') {
      assert.ok(Math.abs(quaternion.dot(cameraQuaternion)) > 0.999999);
    } else {
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
      const towardCamera = cameraPosition.clone().sub(position).setY(0).normalize();
      assert.ok(normal.dot(towardCamera) > 0.999999);
      assert.ok(Math.abs(normal.y) < 1e-12);
    }
  }
}

function matrixElements(instancedMesh, index) {
  const matrix = new THREE.Matrix4();
  instancedMesh.getMatrixAt(index, matrix);
  return [...matrix.elements];
}

function matrixPosition(instancedMesh, index) {
  const matrix = new THREE.Matrix4();
  instancedMesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix).toArray();
}
