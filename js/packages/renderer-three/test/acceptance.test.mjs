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

test('500 flat real-Three bindings batch, sample, rebuild cleanly, and leak zero leases', async () => {
  const descriptors = [
    ...INLINE_RESOURCES,
    { id: 'texture/atlas', kind: 'texture-atlas', url: 'memory:atlas', columns: 4, rows: 4 },
    { id: 'particle/ambient', kind: 'particle', maximumCapacity: 32,
      textureResourceId: null, defaults: {} },
  ];
  const loadResource = async (resource, signal, dependencies) => {
    if (resource.kind === 'texture-atlas') {
      return { kind: resource.kind, descriptor: resource, texture: new THREE.Texture(), ownsTexture: true };
    }
    return loadThreeResource(resource, signal, dependencies);
  };
  const first = createHarness({ descriptors, loadResource });
  const camera = await first.backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, first.registry));
  const rows = await Promise.all(Array.from({ length: 500 }, async (_, index) => {
    const nodeName = `py/item-${index}`;
    if (index < 300) {
      const properties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
        castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true };
      return { nodeName, key: 'mesh', properties, binding: await first.backend.createBinding(
        descriptor(nodeName, 'mesh', 'render.mesh@1', properties, first.registry)) };
    }
    if (index < 450) {
      const properties = { textureResourceId: 'texture/atlas', width: 1, height: 1,
        material: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0,
          alphaMode: 'mask', alphaCutoff: 0.5 }, alpha: 1, frame: 0,
        flipbook: null, renderOrder: 1, pickable: true };
      return { nodeName, key: 'sprite', properties, binding: await first.backend.createBinding(
        descriptor(nodeName, 'sprite', 'render.sprite@1', properties, first.registry)) };
    }
    const properties = { particleResourceId: 'particle/ambient', intensity: 1,
      parameters: { durationTicks: 120, capacity: 16, seed: index, rate: 10, size: 0.1,
        velocity: [0, 1, 0], spread: [0.2, 0.2, 0.2], gravity: [0, -1, 0],
        blendMode: 'normal' }, animation: { startTick: 0, clock: 'visual' }, renderOrder: 2 };
    return { nodeName, key: 'particle', properties, binding: await first.backend.createBinding(
      descriptor(nodeName, 'particle', 'render.particle@1', properties, first.registry)) };
  }));
  first.backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 30)));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const matrix = new THREE.Matrix4().makeTranslation((index % 25) - 12, Math.floor(index / 25) - 10, 0);
    first.backend.updateBinding(row.binding, patch(row.nodeName, row.key, row.properties, matrix));
  }
  const prepared = first.backend.prepareFrame(frame(camera, 60, 1));
  first.backend.render();
  const diagnostics = first.backend.diagnostics();
  assert.equal(prepared.requiresContinuousDraw, true);
  assert.equal(diagnostics.bindingCount, 501);
  assert.equal(diagnostics.nodeBindingCount, 501);
  assert.equal(diagnostics.batchCount, 2);
  assert.equal(diagnostics.instanceCount, 450);
  assert.equal(diagnostics.resourceCount, 4);
  assert.equal(diagnostics.resourceLeaseCount, 800);
  assert.equal(diagnostics.renderTargetCount, 0);
  for (const row of rows.slice(0, 450)) {
    const record = first.backend._records.get(row.binding);
    assert.equal(record.batched, true);
    assert.equal(record.handle.object.visible, false,
      'a batched logical binding has no simultaneously drawable ordinary object');
  }
  const batchVersions = first.backend._batches.map((batch) => batch.object.instanceMatrix.version);
  for (let index = 0; index < 50; index += 1) {
    const row = rows[index];
    first.backend.updateBinding(row.binding, patch(row.nodeName, row.key, row.properties,
      new THREE.Matrix4().makeTranslation(index, 0, 0)));
    assert.equal(first.backend._records.get(row.binding).handle.object.visible, false,
      'transform updates must not reveal batched ordinary objects');
  }
  first.backend.prepareFrame(frame(camera, 61, 1.016));
  assert.deepEqual(first.backend._batches.map((batch, index) =>
    batch.object.instanceMatrix.version > batchVersions[index]), [true, true]);
  for (const row of rows.slice(0, 450)) {
    assert.equal(first.backend._records.get(row.binding).handle.object.visible, false);
  }
  for (const row of rows) first.backend.destroyBinding(row.binding);
  first.backend.destroyBinding(camera);
  assert.equal(first.backend.diagnostics().bindingCount, 0);
  assert.equal(first.backend.diagnostics().batchCount, 0);
  assert.equal(first.backend.diagnostics().resourceLeaseCount, 0);
  assert.equal(first.backend.diagnostics().resourceCount, 0);
  first.backend.dispose();

  const rebuilt = createHarness({ descriptors, loadResource });
  const rebuiltCamera = await rebuilt.backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, rebuilt.registry));
  rebuilt.backend.destroyBinding(rebuiltCamera); rebuilt.backend.dispose();
  assert.equal(rebuilt.backend.diagnostics().bindingCount, 0);
  assert.equal(rebuilt.backend.diagnostics().resourceLeaseCount, 0);
});
