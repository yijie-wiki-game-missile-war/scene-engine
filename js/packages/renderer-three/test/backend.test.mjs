import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { loadThreeResource } from '../src/resources.js';
import {
  CAMERA_PROPERTIES,
  INLINE_RESOURCES,
  createHarness,
  descriptor,
  frame,
  patch,
} from './support.mjs';

test('real Three bindings are flat per node and consume Engine world matrices', async () => {
  const { backend, registry, renderer } = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  assert.equal(backend._records.get(camera).handle.camera.aspect, 4 / 3,
    'a camera created after initial resize inherits the current host aspect');
  const meshProperties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
    castShadow: true, receiveShadow: true, renderOrder: 2, pickable: true };
  const first = await backend.createBinding(descriptor('py/aircraft', 'body',
    'render.mesh@1', meshProperties, registry));
  const second = await backend.createBinding(descriptor('py/aircraft', 'outline',
    'render.mesh@1', meshProperties, registry));
  const cameraMatrix = new THREE.Matrix4().makeTranslation(0, 0, 5);
  const modelMatrix = new THREE.Matrix4().makeTranslation(2, 3, 4);
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES, cameraMatrix));
  backend.updateBinding(first, patch('py/aircraft', 'body', meshProperties, modelMatrix));
  backend.updateBinding(second, patch('py/aircraft', 'outline', meshProperties, modelMatrix));
  const preparation = backend.prepareFrame(frame(camera, 12, 1.5));
  assert.equal(preparation.requiresContinuousDraw, false);
  assert.equal(backend.diagnostics().nodeBindingCount, 2);
  assert.equal(backend.diagnostics().bindingCount, 3);
  assert.equal(backend.diagnostics().batchCount, 1);
  assert.equal(backend.diagnostics().instanceCount, 2);
  const nodeRoot = backend._nodes.get('py/aircraft').object;
  assert.strictEqual(nodeRoot.parent, backend._root);
  assert.equal(nodeRoot.matrixAutoUpdate, false);
  assert.deepEqual(nodeRoot.matrix.toArray(), modelMatrix.toArray());
  assert.equal(backend._root.children.some((child) => child.name.includes('parent')), false);
  backend.render();
  assert.equal(renderer.draws, 1);
  assert.equal(backend.diagnostics().rendererCalls, 1);
  backend.destroyBinding(first); backend.destroyBinding(second); backend.destroyBinding(camera);
  assert.equal(backend.diagnostics().nodeBindingCount, 0);
  backend.dispose();
});

test('pick and project return only node/component identities and plain coordinates', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const meshProperties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
    castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true };
  const mesh = await backend.createBinding(descriptor('py/target', 'mesh', 'render.mesh@1',
    meshProperties, registry));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 5)));
  backend.updateBinding(mesh, patch('py/target', 'mesh', meshProperties));
  backend.prepareFrame(frame(camera));
  const projected = backend.projectWorldPoint({ position: [0, 0, 0] });
  assert.equal(projected.visible, true);
  assert.ok(Math.abs(projected.clientX - 400) < 1e-6);
  assert.ok(Math.abs(projected.clientY - 300) < 1e-6);
  const hit = backend.pick({ clientX: 400, clientY: 300 });
  assert.equal(hit.nodeName, 'py/target');
  assert.equal(hit.componentKey, 'mesh');
  assert.deepEqual(Object.keys(hit).sort(), ['componentKey', 'distance', 'nodeName', 'point']);
  backend.render();
  const cameraBefore = backend._activeCamera.handle.camera.position.toArray();
  const suggestion = backend.focusWorldPoint({ position: [1, 2, 3], radius: 2 });
  assert.equal(suggestion.nodeName, 'scene/camera');
  assert.deepEqual(backend._activeCamera.handle.camera.position.toArray(), cameraBefore,
    'focus returns a Node-transform suggestion and never mutates the backend camera');
  backend.dispose();
});

test('environment-only background keeps its explicit color across async resource replacement', async () => {
  const descriptors = [
    { id: 'texture/environment-a', kind: 'texture', url: 'memory:a' },
    { id: 'texture/environment-b', kind: 'texture', url: 'memory:b' },
  ];
  const loadResource = async (resource) => {
    const texture = new THREE.Texture(); texture.name = resource.id;
    return { kind: 'texture', descriptor: resource, texture, ownsTexture: true };
  };
  const { backend, registry } = createHarness({ descriptors, loadResource });
  const initial = { colorRgba: 0x2244_66ff, textureResourceId: null,
    environmentResourceId: 'texture/environment-a' };
  const binding = await backend.createBinding(descriptor('scene/environment', 'background',
    'render.background@1', initial, registry));
  assert.equal(backend._scene.background.getHex(), 0x224466);
  assert.equal(backend._scene.environment.name, 'texture/environment-a');
  const next = { ...initial, colorRgba: 0x1133_55ff,
    environmentResourceId: 'texture/environment-b' };
  backend.updateBinding(binding, patch('scene/environment', 'background', next));
  await backend.whenIdle();
  assert.equal(backend._scene.background.getHex(), 0x113355);
  assert.equal(backend._scene.environment.name, 'texture/environment-b');
  backend.dispose();
});

test('reverting to the active resource cancels a pending replacement generation', async () => {
  let resolveReplacement;
  const descriptors = [
    { id: 'texture/active', kind: 'texture', url: 'memory:active' },
    { id: 'texture/pending', kind: 'texture', url: 'memory:pending' },
  ];
  const loadResource = async (resource) => {
    if (resource.id === 'texture/pending') {
      return new Promise((resolve) => { resolveReplacement = () => {
        const texture = new THREE.Texture(); texture.name = resource.id;
        resolve({ kind: 'texture', descriptor: resource, texture, ownsTexture: true });
      }; });
    }
    const texture = new THREE.Texture(); texture.name = resource.id;
    return { kind: 'texture', descriptor: resource, texture, ownsTexture: true };
  };
  const { backend, registry } = createHarness({ descriptors, loadResource });
  const active = { colorRgba: 0x1122_33ff, textureResourceId: null,
    environmentResourceId: 'texture/active' };
  const binding = await backend.createBinding(descriptor('scene/environment', 'background',
    'render.background@1', active, registry));
  const pending = { ...active, environmentResourceId: 'texture/pending' };
  backend.updateBinding(binding, patch('scene/environment', 'background', pending));
  await Promise.resolve();
  backend.updateBinding(binding, patch('scene/environment', 'background', active));
  resolveReplacement();
  await backend.whenIdle();
  assert.equal(backend._scene.environment.name, 'texture/active');
  assert.deepEqual(backend._records.get(binding).resourceIds, ['texture/active']);
  backend.dispose();
});

test('camera, background, and all light bindings are explicit with no default light', async () => {
  const { backend, registry } = createHarness();
  assert.equal(backend._scene.children.some((object) => object.isLight), false);
  assert.throws(() => backend.createBinding(descriptor('scene/invalid', 'background',
    'render.background@1', null, registry)), /resource|properties/u);
  const recovered = await backend.createBinding(descriptor('scene/invalid', 'background',
    'render.background@1', { colorRgba: 0x0000_00ff, textureResourceId: null,
      environmentResourceId: null }, registry));
  backend.destroyBinding(recovered);
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const backgroundProperties = { colorRgba: 0x2244_66ff,
    textureResourceId: null, environmentResourceId: null };
  const background = await backend.createBinding(descriptor('scene/environment', 'background',
    'render.background@1', backgroundProperties, registry));
  const ambientProperties = { colorRgba: 0xffff_ffff, intensity: 0.3, castShadow: false };
  const directionalProperties = { colorRgba: 0xffee_ccff, intensity: 2,
    castShadow: true };
  const pointProperties = { colorRgba: 0xff00_00ff, intensity: 3,
    castShadow: false, range: 20 };
  const spotProperties = { colorRgba: 0x00ff_00ff, intensity: 4, castShadow: true,
    range: 30, angleDegrees: 35, penumbra: 0.25 };
  const lights = await Promise.all([
    backend.createBinding(descriptor('scene/ambient', 'light', 'render.ambient-light@1',
      ambientProperties, registry)),
    backend.createBinding(descriptor('scene/sun', 'light', 'render.directional-light@1',
      directionalProperties, registry)),
    backend.createBinding(descriptor('scene/point', 'light', 'render.point-light@1',
      pointProperties, registry)),
    backend.createBinding(descriptor('scene/spot', 'light', 'render.spot-light@1',
      spotProperties, registry)),
  ]);
  assert.equal(backend.diagnostics().lightCount, 4);
  assert.equal(backend.diagnostics().backgroundCount, 1);
  assert.equal(backend._scene.background.getHex(), 0x224466);
  assert.throws(() => backend.createBinding(descriptor('scene/other', 'background',
    'render.background@1', backgroundProperties, registry)), /three-background-duplicate/u);
  const orthographic = { projection: 'orthographic', near: 0.1, far: 100, orthoHeight: 20 };
  backend.updateBinding(camera, patch('scene/camera', 'camera', orthographic));
  assert.equal(backend._records.get(camera).handle.camera.isOrthographicCamera, true);
  for (const binding of lights) backend.destroyBinding(binding);
  backend.destroyBinding(background);
  assert.equal(backend._scene.background, null);
  assert.equal(backend.diagnostics().lightCount, 0);
  backend.dispose();
});

test('sprite has no orientation path and static sprites batch with real Three objects', async () => {
  const textureDescriptor = { id: 'texture/atlas', kind: 'texture-atlas', url: 'memory:atlas',
    columns: 2, rows: 2 };
  const loadResource = async (resource, signal, dependencies) => {
    if (resource.kind === 'texture-atlas') {
      const texture = new THREE.Texture(); texture.needsUpdate = true;
      return { kind: resource.kind, descriptor: resource, texture, ownsTexture: true };
    }
    return loadThreeResource(resource, signal, dependencies);
  };
  const { backend, registry } = createHarness({ descriptors: [textureDescriptor], loadResource });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const properties = { textureResourceId: 'texture/atlas', width: 2, height: 3,
    material: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0,
      alphaMode: 'blend', alphaCutoff: 0 }, alpha: 0.8, frame: 1,
    flipbook: null, renderOrder: 4, pickable: true };
  const first = await backend.createBinding(descriptor('py/a', 'sprite', 'render.sprite@1',
    properties, registry));
  const second = await backend.createBinding(descriptor('py/b', 'sprite', 'render.sprite@1',
    properties, registry));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 5)));
  backend.updateBinding(first, patch('py/a', 'sprite', properties));
  backend.updateBinding(second, patch('py/b', 'sprite', properties,
    new THREE.Matrix4().makeTranslation(3, 0, 0)));
  backend.prepareFrame(frame(camera));
  assert.equal(backend.diagnostics().batchCount, 1);
  assert.equal(backend._records.get(first).handle.object.rotation.x, 0);
  await assert.rejects(() => backend.createBinding(descriptor('py/legacy', 'sprite',
    'render.sprite@1', { ...properties, orientation: 'billboard' }, registry)),
  /three-sprite-properties-invalid/u);
  backend.dispose();
});

test('water and particle visual samplers request continuous draw without RenderTargets', async () => {
  const descriptors = [
    { id: 'surface/water', kind: 'surface', family: 'surface.water',
      geometry: { primitive: 'plane', width: 10, height: 10, segmentsX: 2, segmentsY: 3 },
      textureResourceIds: [], defaults: { amplitude: 0.2, speed: 1, foam: 0.5, textureScale: 1 } },
    { id: 'particle/sparks', kind: 'particle', maximumCapacity: 64,
      textureResourceId: null, defaults: {} },
  ];
  const { backend, registry } = createHarness({ descriptors });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const surfaceProperties = { surfaceResourceId: 'surface/water',
    material: { tintRgba: 0x4488_ffff, opacity: 0.8, emissive: 0,
      alphaMode: 'blend', alphaCutoff: 0 }, parameters: {}, renderOrder: 0, pickable: true };
  const particleProperties = { particleResourceId: 'particle/sparks', intensity: 1,
    parameters: { durationTicks: 60, capacity: 32, seed: 7, rate: 30, size: 0.2,
      velocity: [0, 2, 0], spread: [1, 0, 1], gravity: [0, -9.8, 0],
      blendMode: 'additive' }, animation: { startTick: 0, clock: 'visual' }, renderOrder: 1 };
  const surface = await backend.createBinding(descriptor('scene/water', 'surface',
    'render.surface@1', surfaceProperties, registry));
  const particle = await backend.createBinding(descriptor('py/sparks', 'particle',
    'render.particle@1', particleProperties, registry));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES));
  backend.updateBinding(surface, patch('scene/water', 'surface', surfaceProperties));
  backend.updateBinding(particle, patch('py/sparks', 'particle', particleProperties));
  const prepared = backend.prepareFrame(frame(camera, 30, 0.5));
  assert.equal(prepared.requiresContinuousDraw, true);
  assert.equal(backend.diagnostics().renderTargetCount, 0);
  const particleObject = backend._records.get(particle).handle.object;
  assert.equal(particleObject.geometry.drawRange.count > 0, true);
  assert.equal(particleObject.geometry.attributes.position.version > 0, true);
  backend.dispose();
});
