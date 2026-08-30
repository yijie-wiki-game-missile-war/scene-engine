import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { loadThreeResource } from '../src/resources.js';
import { CAMERA_PROPERTIES, createHarness, descriptor, frame, patch } from './support.mjs';

const ATLAS = Object.freeze({ id: 'texture/atlas', kind: 'texture-atlas', url: 'memory:atlas',
  columns: 2, rows: 2 });

function atlasLoader() {
  return async (resource, signal, dependencies) => {
    if (resource.kind === 'texture-atlas' || resource.kind === 'texture') {
      const texture = new THREE.Texture(); texture.needsUpdate = true;
      return { kind: resource.kind, descriptor: resource, texture, ownsTexture: true };
    }
    return loadThreeResource(resource, signal, dependencies);
  };
}

const SPRITE = Object.freeze({ textureResourceId: 'texture/atlas', width: 2, height: 3,
  material: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0, alphaMode: 'opaque',
    alphaCutoff: 0 }, alpha: 1, frame: 0, renderOrder: 0, pickable: false });

async function setup(harness, entries) {
  const camera = await harness.backend.createBinding(harness.descriptor
    ? harness.descriptor('scene/camera', 'camera', 'render.camera@1', CAMERA_PROPERTIES,
      harness.registry)
    : descriptor('scene/camera', 'camera', 'render.camera@1', CAMERA_PROPERTIES, harness.registry));
  harness.backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 5)));
  const bindings = new Map();
  for (const [nodeName, componentKey, properties, batchable] of entries) {
    const binding = await harness.backend.createBinding(descriptor(nodeName, componentKey,
      'render.sprite@3', properties, harness.registry, undefined, batchable));
    harness.backend.updateBinding(binding, patch(nodeName, componentKey, properties,
      new THREE.Matrix4(), true, batchable));
    bindings.set(nodeName, binding);
  }
  return { camera, bindings };
}

test('legacy sprite and particle animation fields are rejected fail-closed', async () => {
  const harness = createHarness({ descriptors: [ATLAS, { id: 'particle/sparks',
    kind: 'particle', maximumCapacity: 8 }, { id: 'texture/plain', kind: 'texture',
    url: 'memory:plain' }], loadResource: atlasLoader() });
  try {
    await assert.rejects(() => harness.backend.createBinding(descriptor('py/flip', 'sprite',
      'render.sprite@3', { ...SPRITE, flipbook: { frameCount: 2, frameTicks: 1 } },
      harness.registry)), /three-sprite-properties-invalid/u);
    await assert.rejects(() => harness.backend.createBinding(descriptor('py/clk', 'sprite',
      'render.sprite@3', { ...SPRITE, startTick: 3 }, harness.registry)),
    /three-sprite-properties-invalid/u);
    await assert.rejects(() => harness.backend.createBinding(descriptor('py/anim', 'particle',
      'render.particle@2', { particleResourceId: 'particle/sparks', intensity: 1,
        parameters: { capacity: 4 }, animation: { startTick: 0, clock: 'visual' },
        renderOrder: 0 }, harness.registry)), /three-particle-properties-invalid/u);
    await assert.rejects(() => harness.backend.createBinding(descriptor('py/plain', 'sprite',
      'render.sprite@3', { ...SPRITE, textureResourceId: 'texture/plain', frame: 1 },
      harness.registry)), /three-sprite-frame-invalid/u);
    assert.equal(harness.backend.diagnostics().bindingCount, 0);
  } finally { harness.backend.dispose(); }
});

test('animation resources are display data and are never loaded by Three', async () => {
  const animationDescriptor = { id: 'anim.unit.walk', kind: 'animation',
    schema: 'scene-engine-animation-resource@2', durationMs: 400, loop: true,
    tracks: [{ channel: 'sprite.frame', target: { node: 'body', component: 'sprite' },
      interpolation: 'step', keyframes: [{ atMs: 0, value: 0 }] }] };
  await assert.rejects(() => loadThreeResource(animationDescriptor),
    /three-resource-kind-invalid/u);
});

test('animated sprites stay out of static batches and frame flips never rebatch', async () => {
  const batchDisposals = [];
  const harness = createHarness({ descriptors: [ATLAS], loadResource: atlasLoader() });
  try {
    const { camera, bindings } = await setup(harness, [
      ['py/static-a', 'sprite', SPRITE, true],
      ['py/static-b', 'sprite', SPRITE, true],
      ['py/animated', 'sprite', SPRITE, false],
    ]);
    harness.backend.prepareFrame(frame(camera));
    assert.equal(harness.backend.diagnostics().batchCount, 1);
    assert.equal(harness.backend.diagnostics().instanceCount, 2,
      'only the two static sprites are batched');
    const staticBatchObject = harness.backend._batches[0].object;
    staticBatchObject.material.addEventListener('dispose',
      () => batchDisposals.push(Date.now()));
    const animatedHandle = harness.backend._records.get(bindings.get('py/animated')).handle;
    assert.equal(harness.backend._records.get(bindings.get('py/animated')).batched, false);

    for (let index = 0; index < 30; index += 1) {
      const nextFrame = index % 4;
      const properties = { ...SPRITE, frame: nextFrame };
      harness.backend.updateBinding(bindings.get('py/animated'),
        patch('py/animated', 'sprite', properties, new THREE.Matrix4(), true, false));
      harness.backend.prepareFrame(frame(camera, index, index / 60));
      const { offset, repeat } = animatedHandle.object.material.map;
      assert.equal(repeat.x, 0.5);
      assert.equal(offset.x, (nextFrame % 2) * 0.5, `frame ${nextFrame} applied to atlas UV`);
    }
    assert.equal(batchDisposals.length, 0, '30 frame flips never rebuilt the static batch');
    assert.equal(harness.backend._batches[0].object, staticBatchObject);
    assert.equal(harness.backend.diagnostics().instanceCount, 2);
  } finally { harness.backend.dispose(); }
});

test('a 500-sprite animation load keeps static batches stable across 120 frames', async () => {
  const harness = createHarness({ descriptors: [ATLAS], loadResource: atlasLoader() });
  try {
    const camera = await harness.backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', CAMERA_PROPERTIES, harness.registry));
    harness.backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
      new THREE.Matrix4().makeTranslation(0, 0, 8)));
    const staticProperties = SPRITE;
    const animated = [];
    for (let index = 0; index < 500; index += 1) {
      const isAnimated = index >= 450;
      const nodeName = isAnimated ? `py/anim-${index}` : `py/static-${index}`;
      const binding = await harness.backend.createBinding(descriptor(nodeName, 'sprite',
        'render.sprite@3', staticProperties, harness.registry, undefined, !isAnimated));
      harness.backend.updateBinding(binding, patch(nodeName, 'sprite', staticProperties,
        new THREE.Matrix4().makeTranslation((index % 25) - 12, 0, Math.floor(index / 25) - 10),
        true, !isAnimated));
      if (isAnimated) animated.push({ binding, nodeName });
    }
    harness.backend.prepareFrame(frame(camera));
    assert.equal(harness.backend.diagnostics().batchCount, 1);
    assert.equal(harness.backend.diagnostics().instanceCount, 450,
      'only the 450 static sprites are batched');
    const staticBatchObject = harness.backend._batches[0].object;
    let staticBatchDisposals = 0;
    staticBatchObject.material.addEventListener('dispose', () => { staticBatchDisposals += 1; });

    let animatedUpdates = 0;
    for (let tick = 0; tick < 120; tick += 1) {
      for (let index = 0; index < animated.length; index += 1) {
        animatedUpdates += 1;
        const nextFrame = (tick + index) % 4;
        harness.backend.updateBinding(animated[index].binding,
          patch(animated[index].nodeName, 'sprite', { ...SPRITE, frame: nextFrame },
            new THREE.Matrix4(), true, false));
      }
      harness.backend.prepareFrame(frame(camera, tick, tick / 60));
    }
    assert.equal(staticBatchDisposals, 0,
      '120 frames of 50 animated sprites never rebuilt the static batch');
    assert.equal(harness.backend._batches[0].object, staticBatchObject);
    assert.equal(harness.backend.diagnostics().instanceCount, 450);
    assert.equal(animatedUpdates, 50 * 120,
      'dynamic updates scale with animated sprites, not with all 500 bindings');

    for (const { binding } of animated) harness.backend.destroyBinding(binding);
    harness.backend.dispose();
  } finally { harness.backend.dispose(); }
});

test('batching eligibility changes rebuild exactly once per transition', async () => {
  const harness = createHarness({ descriptors: [ATLAS], loadResource: atlasLoader() });
  try {
    const { camera, bindings } = await setup(harness, [
      ['py/static-a', 'sprite', SPRITE, true],
      ['py/static-b', 'sprite', SPRITE, true],
      ['py/changing', 'sprite', SPRITE, true],
    ]);
    harness.backend.prepareFrame(frame(camera));
    assert.equal(harness.backend.diagnostics().instanceCount, 3);
    const changing = bindings.get('py/changing');
    const seen = new Set(); let builtCount = 0; let disposedCount = 0;
    const audit = () => {
      for (const batch of harness.backend._batches) {
        if (seen.has(batch)) continue;
        seen.add(batch);
        builtCount += 1;
        batch.object.material.addEventListener('dispose', () => { disposedCount += 1; });
      }
    };
    audit();

    // Animation start: batchable true -> false leaves the static batch once.
    harness.backend.updateBinding(changing,
      patch('py/changing', 'sprite', { ...SPRITE, frame: 1 }, new THREE.Matrix4(), true, false));
    harness.backend.prepareFrame(frame(camera, 1, 0.1));
    audit();
    assert.equal(builtCount, 2, 'animation start builds one replacement batch');
    assert.equal(disposedCount, 1, 'animation start disposes the previous batch once');
    assert.equal(harness.backend._records.get(changing).batched, false);
    assert.equal(harness.backend.diagnostics().instanceCount, 2);

    // Animation stop: batchable false -> true re-enters the static batch once.
    harness.backend.updateBinding(changing,
      patch('py/changing', 'sprite', SPRITE, new THREE.Matrix4(), true, true));
    harness.backend.prepareFrame(frame(camera, 2, 0.2));
    audit();
    assert.equal(builtCount, 3, 'animation stop builds one replacement batch');
    assert.equal(disposedCount, 2, 'animation stop disposes the previous batch once');
    assert.equal(harness.backend._records.get(changing).batched, true);
    assert.equal(harness.backend.diagnostics().instanceCount, 3);
  } finally { harness.backend.dispose(); }
});
