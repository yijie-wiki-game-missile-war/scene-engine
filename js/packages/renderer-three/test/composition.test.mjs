import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
  CAMERA_PROPERTIES,
  INLINE_RESOURCES,
  createHarness,
  descriptor,
  frame,
  patch,
} from './support.mjs';

const PLAN = Object.freeze({
  schema: 'scene-engine-render-composition@1',
  id: 'gameplay-view',
  revision: 1,
  defaultGroup: 'ordinary',
  groups: Object.freeze([
    Object.freeze({ id: 'base' }),
    Object.freeze({ id: 'ordinary' }),
    Object.freeze({ id: 'foreground' }),
  ]),
  passes: Object.freeze([
    Object.freeze({ id: 'base-pass', kind: 'protected-base', groups: Object.freeze(['base']) }),
    Object.freeze({ id: 'ordinary-pass', kind: 'ordinary', groups: Object.freeze(['ordinary']) }),
    Object.freeze({ id: 'foreground-pass', kind: 'foreground', groups: Object.freeze(['foreground']) }),
  ]),
});

const MESH_PROPERTIES = Object.freeze({
  meshResourceId: 'mesh/triangle',
  materialResourceId: 'material/standard',
  castShadow: false,
  receiveShadow: false,
  renderOrder: 0,
  pickable: true,
});

async function createMesh(backend, registry, name, group, z) {
  const binding = await backend.createBinding(descriptor(
    `py/${name}`, 'mesh', 'render.mesh@1', MESH_PROPERTIES, registry,
    undefined, true, group,
  ));
  backend.updateBinding(binding, patch(
    `py/${name}`, 'mesh', MESH_PROPERTIES, new THREE.Matrix4().makeTranslation(0, 0, z),
    true, true, group,
  ));
  return binding;
}

test('composition renders four passes and exact picking follows protected depth', async () => {
  const { backend, registry, renderer } = createHarness({
    descriptors: INLINE_RESOURCES,
    compositionPlan: PLAN,
  });
  const camera = await backend.createBinding(descriptor(
    'scene/camera', 'camera', 'render.camera@1', CAMERA_PROPERTIES, registry,
  ));
  const ordinary = await createMesh(backend, registry, 'ordinary', 'ordinary', -2);
  const foreground = await createMesh(backend, registry, 'foreground', 'foreground', -4);
  const base = await createMesh(backend, registry, 'base', 'base', -5);

  backend.prepareFrame(frame(camera));
  backend.render();
  assert.equal(renderer.draws, 4);
  assert.equal(renderer.clears, 1);
  assert.equal(renderer.depthClears, 1);
  assert.deepEqual(renderer.renderStates.map((state) => state.cameraMask), [2, 4, 2, 8]);
  assert.equal(renderer.renderStates[0].colorWrites.every((value) => value === true), true);
  assert.equal(renderer.renderStates[2].colorWrites.every((value) => value === false), true);
  assert.equal(backend.capture().drawCount, 1);
  assert.equal(backend.diagnostics().compositionPlanId, 'gameplay-view');
  assert.equal(backend.pick({ clientX: 400, clientY: 300 }).nodeName, 'py/foreground');
  assert.equal(backend.pickProximity({ clientX: 400, clientY: 300, radiusPixels: 16 }).nodeName,
    'py/foreground');

  backend.updateBinding(base, patch(
    'py/base', 'mesh', MESH_PROPERTIES, new THREE.Matrix4().makeTranslation(0, 0, -3),
    true, true, 'base',
  ));
  assert.equal(backend.pick({ clientX: 400, clientY: 300 }).nodeName, 'py/ordinary');

  backend.updateBinding(ordinary, patch(
    'py/ordinary', 'mesh', MESH_PROPERTIES, new THREE.Matrix4().makeTranslation(0, 0, -4),
    true, true, 'ordinary',
  ));
  assert.equal(backend.pick({ clientX: 400, clientY: 300 }).nodeName, 'py/base');

  for (const binding of [ordinary, foreground, base, camera]) backend.destroyBinding(binding);
  backend.dispose();
});

test('composition membership isolates batch keys and rejects unknown groups', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES, compositionPlan: PLAN });
  const camera = await backend.createBinding(descriptor(
    'scene/camera', 'camera', 'render.camera@1', CAMERA_PROPERTIES, registry,
  ));
  const bindings = [];
  for (const [group, z] of [['ordinary', -2], ['foreground', -3]]) {
    bindings.push(await createMesh(backend, registry, `${group}-a`, group, z));
    bindings.push(await createMesh(backend, registry, `${group}-b`, group, z));
  }
  backend.prepareFrame(frame(camera));
  assert.equal(backend.diagnostics().batchCount, 2);
  assert.throws(() => backend.createBinding(descriptor(
    'py/invalid', 'mesh', 'render.mesh@1', MESH_PROPERTIES, registry,
    undefined, true, 'missing',
  )), { code: 'three-backend-composition-group-missing' });
  for (const binding of bindings) backend.destroyBinding(binding);
  backend.destroyBinding(camera);
  backend.dispose();
});
