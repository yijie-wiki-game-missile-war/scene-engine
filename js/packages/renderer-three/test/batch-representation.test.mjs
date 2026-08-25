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

const MESH_PROPERTIES = Object.freeze({
  meshResourceId: 'mesh/triangle',
  materialResourceId: 'material/standard',
  castShadow: false,
  receiveShadow: false,
  renderOrder: 0,
  pickable: true,
});

const ALTERNATE_MESH = Object.freeze({
  id: 'mesh/alternate',
  kind: 'mesh',
  positions: Object.freeze([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0, 0.5, 0,
  ]),
  indices: Object.freeze([0, 1, 2]),
});

async function createMeshScenario(count = 2, descriptors = INLINE_RESOURCES) {
  const { backend, registry } = createHarness({ descriptors });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const bindings = await Promise.all(Array.from({ length: count }, (_, index) =>
    backend.createBinding(descriptor(`py/item-${index}`, 'mesh', 'render.mesh@1',
      MESH_PROPERTIES, registry))));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 5)));
  for (let index = 0; index < bindings.length; index += 1) {
    backend.updateBinding(bindings[index], patch(`py/item-${index}`, 'mesh', MESH_PROPERTIES,
      new THREE.Matrix4().makeTranslation(index * 3, 0, 0)));
  }
  return { backend, registry, camera, bindings };
}

function recordFor(backend, binding) {
  return backend._records.get(binding);
}

function batchFor(backend, record) {
  return backend._batches.find((batch) => batch.records.includes(record)) ?? null;
}

function assertExclusiveRepresentation(backend, record) {
  const batch = batchFor(backend, record);
  assert.equal(record.batched, batch !== null);
  assert.equal(record.handle.object.visible, record.visible && !record.batched);
  if (batch) assert.equal(record.handle.object.visible, false);
  return batch;
}

function instanceMatrix(batch, record) {
  const matrix = new THREE.Matrix4();
  batch.object.getMatrixAt(batch.records.indexOf(record), matrix);
  return matrix;
}

test('batch create hides every ordinary object and keeps one active representation', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  for (const binding of bindings) {
    const record = recordFor(backend, binding);
    assert.equal(record.batched, false);
    assert.equal(record.handle.object.visible, true);
  }

  backend.prepareFrame(frame(camera));

  assert.equal(backend.diagnostics().batchCount, 1);
  for (const binding of bindings) assertExclusiveRepresentation(backend, recordFor(backend, binding));
  backend.dispose();
});

test('batched transform update never reveals the ordinary object', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  backend.prepareFrame(frame(camera));
  const record = recordFor(backend, bindings[0]);
  const moved = new THREE.Matrix4().makeTranslation(7, 8, 9);

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', MESH_PROPERTIES, moved));

  assertExclusiveRepresentation(backend, record);
  backend.prepareFrame(frame(camera, 1));
  assert.deepEqual(instanceMatrix(batchFor(backend, record), record).toArray(), moved.toArray());
  assertExclusiveRepresentation(backend, record);
  backend.dispose();
});

test('batched visible true to false to true never reveals the ordinary object', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  backend.prepareFrame(frame(camera));
  const record = recordFor(backend, bindings[0]);
  const world = new THREE.Matrix4().makeTranslation(4, 5, 6);

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', MESH_PROPERTIES, world, false));
  assert.equal(record.visible, false);
  assertExclusiveRepresentation(backend, record);
  backend.prepareFrame(frame(camera, 1));
  assertExclusiveRepresentation(backend, record);

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', MESH_PROPERTIES, world, true));
  assert.equal(record.visible, true);
  assertExclusiveRepresentation(backend, record);
  backend.prepareFrame(frame(camera, 2));
  assertExclusiveRepresentation(backend, record);
  backend.dispose();
});

test('hidden batch instance uses ZERO_MATRIX and restores its real world matrix', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  backend.prepareFrame(frame(camera));
  const record = recordFor(backend, bindings[0]);
  const world = new THREE.Matrix4().makeTranslation(11, 12, 13);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', MESH_PROPERTIES, world, false));
  backend.prepareFrame(frame(camera, 1));
  assert.deepEqual(instanceMatrix(batchFor(backend, record), record).toArray(), zero.toArray());

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', MESH_PROPERTIES, world, true));
  backend.prepareFrame(frame(camera, 2));
  assert.deepEqual(instanceMatrix(batchFor(backend, record), record).toArray(), world.toArray());
  backend.dispose();
});

test('fingerprint change disposes the old batch and restores ordinary objects', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  backend.prepareFrame(frame(camera));
  const oldBatch = backend._batches[0];
  const changed = Object.freeze({ ...MESH_PROPERTIES, renderOrder: 7 });

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', changed));

  assert.equal(oldBatch.object.parent, null);
  assert.equal(backend.diagnostics().batchCount, 0);
  for (const binding of bindings) assertExclusiveRepresentation(backend, recordFor(backend, binding));
  backend.prepareFrame(frame(camera, 1));
  assert.equal(backend.diagnostics().batchCount, 0);
  for (const binding of bindings) assert.equal(recordFor(backend, binding).handle.object.visible, true);
  backend.dispose();
});

test('one remaining member removes its InstancedMesh and restores ordinary drawing', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  backend.prepareFrame(frame(camera));
  const remaining = recordFor(backend, bindings[1]);
  const oldBatch = backend._batches[0];

  backend.destroyBinding(bindings[0]);

  assert.equal(oldBatch.object.parent, null);
  assert.equal(backend.diagnostics().batchCount, 0);
  assert.equal(remaining.batched, false);
  assert.equal(remaining.handle.object.visible, true);
  backend.prepareFrame(frame(camera, 1));
  assert.equal(backend.diagnostics().batchCount, 0);
  backend.dispose();
});

test('destroying one of three members rebuilds without a duplicate representation', async () => {
  const { backend, camera, bindings } = await createMeshScenario(3);
  backend.prepareFrame(frame(camera));
  const destroyedRecord = recordFor(backend, bindings[0]);
  const destroyedObject = destroyedRecord.handle.object;

  backend.destroyBinding(bindings[0]);
  backend.prepareFrame(frame(camera, 1));

  assert.equal(destroyedRecord.destroyed, true);
  assert.equal(destroyedRecord.handle, null);
  assert.equal(destroyedObject.parent, null);
  assert.equal(backend.diagnostics().batchCount, 1);
  assert.equal(backend.diagnostics().instanceCount, 2);
  for (const binding of bindings.slice(1)) {
    assertExclusiveRepresentation(backend, recordFor(backend, binding));
  }
  backend.dispose();
});

test('resource replacement completes with exactly one ordinary representation', async () => {
  const descriptors = Object.freeze([...INLINE_RESOURCES, ALTERNATE_MESH]);
  const { backend, camera, bindings } = await createMeshScenario(2, descriptors);
  backend.prepareFrame(frame(camera));
  const oldBatch = backend._batches[0];
  const oldObject = recordFor(backend, bindings[0]).handle.object;
  const replacement = Object.freeze({ ...MESH_PROPERTIES, meshResourceId: 'mesh/alternate' });

  backend.updateBinding(bindings[0], patch('py/item-0', 'mesh', replacement));
  await backend.whenIdle();

  const replaced = recordFor(backend, bindings[0]);
  assert.equal(oldBatch.object.parent, null);
  assert.equal(oldObject.parent, null);
  assert.notStrictEqual(replaced.handle.object, oldObject);
  assert.equal(backend.diagnostics().batchCount, 0);
  for (const binding of bindings) assertExclusiveRepresentation(backend, recordFor(backend, binding));
  backend.prepareFrame(frame(camera, 1));
  assert.equal(backend.diagnostics().batchCount, 0);
  backend.dispose();
});

test('pick raycasts only the batch representation for a batched logical binding', async () => {
  const { backend, camera, bindings } = await createMeshScenario();
  backend.prepareFrame(frame(camera));
  const batch = backend._batches[0];
  let candidates = null;
  const originalIntersectObjects = THREE.Raycaster.prototype.intersectObjects;
  THREE.Raycaster.prototype.intersectObjects = function intersectObjectsForBatchTest(values) {
    candidates = values;
    return [{ object: values[0], instanceId: 0, point: new THREE.Vector3(1, 2, 3), distance: 4 }];
  };
  try {
    const hit = backend.pick({ clientX: 400, clientY: 300 });
    assert.deepEqual(candidates, [batch.object]);
    assert.equal(hit.nodeName, batch.records[0].identity.nodeName);
    assert.equal(hit.componentKey, batch.records[0].identity.componentKey);
    for (const binding of bindings) {
      assert.equal(recordFor(backend, binding).handle.object.visible, false);
    }
  } finally {
    THREE.Raycaster.prototype.intersectObjects = originalIntersectObjects;
    backend.dispose();
  }
});

test('capture and diagnostics retain correct binding, batch, and instance counts', async () => {
  const { backend, camera } = await createMeshScenario();
  backend.prepareFrame(frame(camera));

  const diagnostics = backend.diagnostics();
  const capture = backend.capture();
  assert.equal(diagnostics.bindingCount, 3);
  assert.equal(diagnostics.batchCount, 1);
  assert.equal(diagnostics.instanceCount, 2);
  assert.equal(capture.bindingCount, 3);
  assert.equal(capture.batchCount, 1);
  assert.equal(capture.instanceCount, 2);
  assert.equal(capture.drawCount, 0);
  backend.dispose();
});
