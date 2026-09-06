import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createProgramInstanceParameters } from '../src/program-instance-parameters.js';
import { CAMERA_PROPERTIES, createHarness, descriptor, frame, patch } from './support.mjs';

const PROGRAM = { id: 'program/batch', kind: 'program', revision: 1, language: 'glsl-module@1',
  stage: 'surface', timeChannel: 'water', textureSlots: {}, parameterSchema: {
    color: { type: 'color', default: [1, 0, 0], min: 0, max: 1, updateable: true },
    amount: { type: 'float', default: .5, min: 0, max: 1, updateable: true },
    fixed: { type: 'float', default: .2, min: 0, max: 1, updateable: false },
  }, source: 'vec4 evaluate(ProgramInput data){return vec4(p_color*(p_amount+p_fixed+0.01*sin(data.visualSeconds)),1.0);}' };
const MESH = { id: 'mesh/batch', kind: 'mesh', positions: [-1,-1,0, 1,-1,0, 0,1,0], indices: [0,1,2] };
const MATERIAL = { id: 'material/batch', kind: 'material', family: 'material.program',
  programResourceId: PROGRAM.id, parameters: { fixed: .7 }, textures: {},
  properties: { alphaMode: 'mask', alphaCutoff: .5, depthTest: true, depthWrite: true } };
const PROPERTIES = { meshResourceId: MESH.id, materialResourceId: MATERIAL.id,
  parameters: { amount: .4 }, pickable: true, renderOrder: 3 };

async function fixture({ count = 3, material = MATERIAL, maxTextureSize = 4096 } = {}) {
  const harness = createHarness({ descriptors: [PROGRAM, MESH, material,
    { ...MATERIAL, id: 'material/other', parameters: { fixed: .3 } }] });
  harness.renderer.capabilities = { maxTextureSize };
  const { backend, registry } = harness;
  const camera = await backend.createBinding(descriptor('camera', 'camera', 'render.camera@1', CAMERA_PROPERTIES, registry));
  backend.updateBinding(camera, patch('camera', 'camera', CAMERA_PROPERTIES, new THREE.Matrix4().makeTranslation(0, 0, 5)));
  const bindings = await Promise.all(Array.from({ length: count }, (_, index) => backend.createBinding(
    descriptor(`item/${index}`, 'mesh', 'render.mesh@1', { ...PROPERTIES, parameters: { amount: index / count } }, registry))));
  bindings.forEach((binding, index) => backend.updateBinding(binding, patch(`item/${index}`, 'mesh',
    { ...PROPERTIES, parameters: { amount: index / count } }, new THREE.Matrix4().makeTranslation(index * 3, 0, 0))));
  backend.prepareFrame(frame(camera));
  return { ...harness, camera, bindings, record: (index) => backend._records.get(bindings[index]) };
}

test('an entirely hidden program batch skips world draw, time sampling and parameter uploads until a member returns', async () => {
  const { backend, camera, bindings, record } = await fixture();
  try {
    const batch = record(0).batch, texture = batch.object.material.uniforms.se_instanceParameters.value;
    let samples = 0; const sample = batch.sample;
    batch.sample = value => { samples += 1; sample(value); };
    const version = texture.version;
    bindings.forEach((binding, index) => backend.updateBinding(binding, patch(`item/${index}`, 'mesh',
      { ...PROPERTIES, parameters: { amount: .9 } }, new THREE.Matrix4(), false)));
    assert.equal(backend.prepareFrame(frame(camera, 0, 9)).requiresContinuousDraw, false);
    assert.equal(batch.object.visible, false);
    assert.equal(batch.visibleCount, 0);
    assert.equal(samples, 0);
    assert.equal(texture.version, version);
    backend.updateBinding(bindings[1], patch('item/1', 'mesh', { ...PROPERTIES, parameters: { amount: .9 } }, new THREE.Matrix4(), true));
    backend.prepareFrame(frame(camera, 0, 10));
    assert.equal(record(1).batch, batch);
    assert.equal(batch.object.visible, true);
    assert.equal(batch.visibleCount, 1);
    assert.equal(samples, 1);
    assert.ok(texture.version > version);
    assert.equal(backend.pick({ clientX: 400, clientY: 300 })?.nodeName, 'item/1');
  } finally { backend.dispose(); }
});

test('program batch isolates mutable parameter rows and retains material defaults/depth/time', async () => {
  const { backend, camera, bindings, record } = await fixture();
  try {
    assert.equal(backend.diagnostics().batchCount, 1);
    const batch = record(0).batch;
    const material = batch.object.material;
    const texture = material.uniforms.se_instanceParameters.value;
    assert.equal(texture.type, THREE.FloatType);
    assert.equal(texture.colorSpace, THREE.NoColorSpace);
    assert.equal(material.uniforms.p_fixed.value, .7);
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, true);
    assert.equal(material.uniforms.se_alphaCutoff.value, .5);
    assert.equal(material.transparent, false);
    assert.deepEqual([...texture.image.data.slice(0, 4)], [1, 0, 0, 0]);
    assert.equal(texture.image.data[7], Math.fround(1 / 3));
    assert.equal(record(0).handle.object.parent, null);
    assert.equal(record(0).handle.object.visible, false);
    backend.prepareFrame({ ...frame(camera), visualTimes: { water: { seconds: 4, running: false } } });
    backend.render();
    assert.equal(material.uniforms.se_time.value, 4);
    assert.equal(material.uniforms.se_cameraWorld.value.elements[14], 5);
    for (let i = 0; i < 3; i++) {
      backend.updateBinding(bindings[i], patch(`item/${i}`, 'mesh', PROPERTIES, new THREE.Matrix4(), false));
    }
    assert.equal(backend.prepareFrame({ ...frame(camera), visualTimes: { water: { seconds: 5, running: true } } }).requiresContinuousDraw, false);
  } finally { await backend.dispose(); }
});

test('one program parameter patch updates one row without rebuilding or recompiling the batch', async () => {
  const { backend, camera, bindings, record } = await fixture();
  try {
    const batch = record(0).batch;
    const texture = batch.object.material.uniforms.se_instanceParameters.value;
    const materialVersion = batch.object.material.version;
    texture.clearUpdateRanges();
    const before = [...texture.image.data];
    for (let step = 0; step < 5; step++) {
      texture.clearUpdateRanges();
      backend.updateBinding(bindings[1], patch('item/1', 'mesh', { ...PROPERTIES,
        parameters: { amount: .51 + step * .01 } }, new THREE.Matrix4().makeTranslation(3, 0, 0)));
      backend.prepareFrame(frame(camera, step, step));
      assert.strictEqual(record(1).batch, batch);
      assert.equal(batch.object.material.version, materialVersion);
      assert.deepEqual(texture.updateRanges, [{ start: 4, count: 4 }]);
      assert.deepEqual([...texture.image.data.slice(0, 4)], before.slice(0, 4));
      assert.deepEqual([...texture.image.data.slice(8)], before.slice(8));
    }
    texture.clearUpdateRanges();
    const version = texture.version;
    backend.prepareFrame(frame(camera, 99, 50));
    assert.equal(texture.version, version, 'Time-only frames do not upload instance parameters');
    assert.equal(texture.updateRanges.length, 0);
    assert.strictEqual(record(0).batch, batch);
  } finally { await backend.dispose(); }
});

test('program instance movement/hide/material replacement preserve exclusive drawing and pick identity', async () => {
  const { backend, camera, bindings, record } = await fixture();
  try {
    const initialBatch = record(0).batch;
    assert.equal(backend.pick({ clientX: 400, clientY: 300 })?.nodeName, 'item/0');
    backend.updateBinding(bindings[0], patch('item/0', 'mesh', PROPERTIES, new THREE.Matrix4().makeTranslation(-3, 0, 0)));
    backend.prepareFrame(frame(camera));
    assert.strictEqual(record(0).batch, initialBatch);
    assert.equal(backend.pick({ clientX: 400, clientY: 300 }), null);
    backend.updateBinding(bindings[0], patch('item/0', 'mesh', PROPERTIES, new THREE.Matrix4(), false));
    backend.prepareFrame(frame(camera));
    assert.equal(backend.pick({ clientX: 400, clientY: 300 }), null);
    const matrix = new THREE.Matrix4(); initialBatch.object.getMatrixAt(record(0).batchIndex, matrix);
    assert.deepEqual(matrix.toArray(), [...Array(15).fill(0), 1]);
    backend.updateBinding(bindings[0], patch('item/0', 'mesh', { ...PROPERTIES, materialResourceId: 'material/other' }, new THREE.Matrix4(), true));
    await backend.whenIdle(); backend.prepareFrame(frame(camera));
    assert.equal(record(0).batched, false);
    assert.equal(record(0).handle.object.visible, true);
    assert.equal(record(0).handle.object.material.uniforms.p_fixed.value, .3);
    assert.equal(backend.pick({ clientX: 400, clientY: 300 })?.nodeName, 'item/0');
    assert.equal(record(1).batched, true);
  } finally { await backend.dispose(); }
});

test('order-dependent programs keep ordinary sorting and program batches obey texture height limits', async () => {
  for (const properties of [
    { alphaMode: 'blend', depthWrite: false },
    { alphaMode: 'opaque', depthTest: false, depthWrite: false },
    { alphaMode: 'mask', depthTest: true, depthWrite: false, alphaCutoff: .5 },
  ]) {
    const ordinary = await fixture({ material: { ...MATERIAL, properties } });
    assert.equal(ordinary.backend.diagnostics().batchCount, 0);
    assert.equal(ordinary.record(0).handle.object.material.transparent, properties.alphaMode === 'blend');
    assert.equal(ordinary.record(0).handle.object.material.depthTest, properties.depthTest ?? true);
    assert.equal(ordinary.record(0).handle.object.material.depthWrite, properties.depthWrite);
    await ordinary.backend.dispose();
  }
  const chunked = await fixture({ count: 5, maxTextureSize: 2 });
  assert.deepEqual(chunked.backend._batches.map((batch) => batch.records.length), [2, 2, 1]);
  assert.equal(chunked.backend.diagnostics().instanceCount, 5);
  await chunked.backend.dispose();
});

test('program instance transport covers vector/bool/int arrays without integer precision loss', () => {
  const program = { ...PROGRAM, parameterSchema: {
    flags: { type: 'bool', length: 2, default: [true, false], updateable: true },
    integers: { type: 'int', length: 4, default: [16777217, -2147483648, 2147483647, -12345], min: -2147483648, max: 2147483647, updateable: true },
    vectors: { type: 'vec4', length: 2, default: [[1,2,3,4], [5,6,7,8]], min: 0, max: 8, updateable: true },
  } };
  const parameters = createProgramInstanceParameters(program, 2);
  parameters.write(1, {});
  const data = parameters.texture.image.data.slice(parameters.stride);
  assert.deepEqual([...data.slice(0, 2)], [1, 0]);
  assert.deepEqual(Array.from({ length: 4 }, (_, index) => data[2 + index * 2] * 65536 + data[3 + index * 2]), program.parameterSchema.integers.default);
  assert.deepEqual([...data.slice(10, 18)], [1,2,3,4,5,6,7,8]);
  assert.throws(() => parameters.write(0, { flags: [1, 0] }), { code: 'display-program-invalid' });
  assert.throws(() => parameters.write(0, { vectors: [[1, 2, 3, 4]] }), { code: 'display-program-invalid' });
  assert.throws(() => parameters.write(0, { unknown: 1 }), { code: 'display-program-invalid' });
  parameters.dispose();
});

test('the full fixed-array parameter budget uses one bounded instance sampler', () => {
  const program = { ...PROGRAM, parameterSchema: {
    values: { type: 'vec4', length: 64, default: Array.from({ length: 64 }, (_, index) => [index, index, index, index]),
      min: 0, max: 64, updateable: true },
  } };
  const parameters = createProgramInstanceParameters(program, 3);
  assert.equal(parameters.texture.image.width, 64);
  assert.equal(parameters.texture.image.height, 3);
  parameters.write(2, {});
  assert.equal(parameters.texture.image.data[2 * 256 + 252], 63);
  assert.deepEqual(parameters.texture.updateRanges, [{ start: 512, count: 256 }]);
  let disposed = 0; parameters.texture.addEventListener('dispose', () => { disposed++; });
  parameters.dispose(); assert.equal(disposed, 1);
  assert.equal(createProgramInstanceParameters({ ...PROGRAM, parameterSchema: { fixed: PROGRAM.parameterSchema.fixed } }, 2), null);
});
