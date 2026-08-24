import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  batchFingerprint,
  normalizeBatch,
  normalizeCameraProfile,
  normalizeResourceCatalog,
  normalizeSnapshot,
} from '../src/contracts.js';
import {
  PIPELINE_IDS,
  RENDER_BATCH_SCHEMA,
  RENDER_COMPOSITION_SCHEMA,
  RENDER_RESOURCE_CATALOG_SCHEMA,
  RENDER_SNAPSHOT_SCHEMA,
  THREE_RENDER_RUNTIME_SCHEMA,
} from '../src/constants.js';

const EXPECTED_PIPELINES = Object.freeze([
  'model@2',
  'sprite@2',
  'surface@2',
  'particle@2',
  'scene-pass@2',
]);

test('0.8 package, V2 schemas, and fixed pipelines are the only identity', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(packageJson.version, '0.8.0');
  assert.equal(THREE_RENDER_RUNTIME_SCHEMA, 'scene-engine-three-render-runtime@2');
  assert.equal(RENDER_RESOURCE_CATALOG_SCHEMA, 'scene-engine-render-resource-catalog@2');
  assert.equal(RENDER_COMPOSITION_SCHEMA, 'scene-engine-render-composition@2');
  assert.equal(RENDER_SNAPSHOT_SCHEMA, 'scene-engine-render-snapshot@2');
  assert.equal(RENDER_BATCH_SCHEMA, 'scene-engine-render-batch@2');
  assert.deepEqual(PIPELINE_IDS, EXPECTED_PIPELINES);
});

test('camera contract is perspective-only closed pure-data pan-zoom', () => {
  const input = cameraProfile();
  const normalized = normalizeCameraProfile(input);
  assert.deepEqual(normalized, input);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.controls));
  assert.ok(Object.isFrozen(normalized.controls.panBounds));

  for (const [label, invalid, code] of [
    ['orthographic', cameraProfile({ projection: 'orthographic' }), 'render-camera-projection-invalid'],
    ['legacy ortho field', { ...cameraProfile(), orthoHeight: 20 }, 'render-camera-profile-invalid'],
    ['unknown field', { ...cameraProfile(), rotate: false }, 'render-camera-profile-invalid'],
    ['control mode', cameraProfile({ controls: { ...controls(), mode: 'orbit' } }), 'render-camera-controls-mode-invalid'],
    ['damping upper bound', cameraProfile({ controls: { ...controls(), dampingFactor: 1 } }), 'render-camera-damping-invalid'],
    ['negative pan speed', cameraProfile({ controls: { ...controls(), panSpeed: -1 } }), 'render-camera-pan-speed-invalid'],
    ['inverted X bounds', cameraProfile({ controls: { ...controls(), panBounds: {
      minX: 2, maxX: 1, minZ: -1, maxZ: 1,
    } } }), 'render-camera-pan-bounds-invalid'],
    ['control unknown field', cameraProfile({ controls: { ...controls(), rotate: false } }), 'render-camera-controls-invalid'],
  ]) {
    assertCode(() => normalizeCameraProfile(invalid), code, label);
  }
});

test('catalog normalizes and freezes the closed V2 resource set', () => {
  const catalog = normalizedCatalog();
  assert.equal(Object.getPrototypeOf(catalog.resources), null);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.resources));
  assert.ok(Object.isFrozen(catalog.resources['surface.water'].geometry));
  assert.deepEqual(catalog.resources['surface.water'].geometry, {
    primitive: 'plane', width: 20, height: 12, segmentsX: 8, segmentsY: 3,
  });
  assert.deepEqual(catalog.resources['model.primitive'].parts[1].dimensions, [0, 1, 2, 8]);
});

test('every old @1 schema and pipeline is rejected instead of adapted', () => {
  const catalog = normalizedCatalog();
  for (const [label, invoke, code] of [
    ['catalog @1', () => normalizeResourceCatalog({
      ...catalogInput(), schema: 'scene-engine-render-resource-catalog@1',
    }), 'render-resource-catalog-schema-invalid'],
    ['snapshot @1', () => normalizeSnapshot({
      ...snapshot(), schema: 'scene-engine-render-snapshot@1',
    }, catalog), 'render-snapshot-schema-invalid'],
    ['composition @1', () => normalizeSnapshot(snapshot({ compositions: [{
      ...composition([]), schema: 'scene-engine-render-composition@1',
    }] }), catalog), 'render-composition-schema-invalid'],
    ['batch @1', () => normalizeBatch({
      ...batch(), schema: 'scene-engine-render-batch@1',
    }, catalog), 'render-batch-schema-invalid'],
    ...['model@1', 'sprite@1', 'surface@1', 'particle@1', 'scene-pass@1'].map(
      (pipelineId) => [pipelineId, () => normalizeSnapshot(snapshot({
        compositions: [composition([layer('model@2', 'model.primitive', {
          pipelineId,
        })])],
      }), catalog), 'render-pipeline-id-invalid'],
    ),
  ]) assertCode(invoke, code, label);
});

test('top-level, resource, layer, material, and params unknown fields fail closed', () => {
  const catalog = normalizedCatalog();
  const base = layer('model@2', 'model.primitive');
  for (const [label, invoke, code] of [
    ['catalog', () => normalizeResourceCatalog({ ...catalogInput(), legacy: true }), 'render-resource-catalog-invalid'],
    ['resource', () => normalizeResourceCatalog(catalogInput((resources) => {
      resources.texture = { ...resources.texture, loader: 'legacy' };
    })), 'render-resource-field-unknown'],
    ['snapshot', () => normalizeSnapshot({ ...snapshot(), legacy: true }, catalog), 'render-snapshot-invalid'],
    ['composition', () => normalizeSnapshot(snapshot({ compositions: [{
      ...composition([]), legacy: true,
    }] }), catalog), 'render-composition-invalid'],
    ['layer', () => normalizeSnapshot(snapshot({ compositions: [composition([{
      ...base, legacy: true,
    }])]}), catalog), 'render-layer-invalid'],
    ['material', () => normalizeSnapshot(snapshot({ compositions: [composition([{
      ...base, material: { ...base.material, transparent: true },
    }])]}), catalog), 'render-material-invalid'],
    ['params', () => normalizeSnapshot(snapshot({ compositions: [composition([{
      ...base, params: { ...base.params, callback: 'legacy' },
    }])]}), catalog), 'render-pipeline-param-unknown'],
  ]) assertCode(invoke, code, label);
});

test('scope, resource matching, global scene keys, and singleton passes are atomic', () => {
  const catalog = normalizedCatalog();
  assertCode(() => normalizeSnapshot(snapshot({
    compositions: [composition([layer('scene-pass@2', 'pass.background')])],
  }), catalog), 'render-scene-pass-scope-invalid', 'scene pass in node composition');

  assertCode(() => normalizeSnapshot(snapshot({ sceneLayers: [
    layer('scene-pass@2', 'pass.background', { key: 'first' }),
    layer('scene-pass@2', 'pass.background.2', { key: 'second' }),
  ] }), catalog), 'render-scene-pass-singleton-duplicate', 'duplicate background');

  assertCode(() => normalizeSnapshot(snapshot({ sceneLayers: [
    layer('sprite@2', 'texture', { key: 'same' }),
    layer('surface@2', 'surface.water', { key: 'same' }),
  ] }), catalog), 'render-scene-layer-key-duplicate', 'global scene key');

  for (const [pipelineId, resourceId] of [
    ['model@2', 'texture'],
    ['sprite@2', 'particle'],
    ['surface@2', 'model.primitive'],
    ['particle@2', 'surface.water'],
    ['scene-pass@2', 'texture'],
  ]) {
    assertCode(() => normalizeSnapshot(snapshot({
      sceneLayers: [layer(pipelineId, resourceId)],
    }), catalog), 'render-pipeline-resource-mismatch', `${pipelineId}/${resourceId}`);
  }

  const valid = normalizeSnapshot(snapshot({ sceneLayers: [
    layer('scene-pass@2', 'pass.background', { key: 'background' }),
    layer('scene-pass@2', 'pass.lights', { key: 'lights' }),
    layer('surface@2', 'surface.water', { key: 'water' }),
  ] }), catalog);
  assert.equal(valid.sceneLayers.length, 3);
});

test('alphaMode and alphaCutoff rules are pipeline-specific and explicit', () => {
  const catalog = normalizedCatalog();
  for (const [pipelineId, resourceId, validModes] of [
    ['model@2', 'model.primitive', ['inherit', 'opaque', 'mask', 'blend']],
    ['sprite@2', 'texture', ['opaque', 'mask', 'blend']],
    ['surface@2', 'surface.water', ['opaque', 'mask', 'blend']],
    ['particle@2', 'particle', ['blend']],
    ['scene-pass@2', 'pass.background', ['opaque']],
  ]) {
    for (const alphaMode of validModes) {
      const result = normalizeSnapshot(snapshot({ sceneLayers: [layer(
        pipelineId,
        resourceId,
        { material: material(alphaMode, alphaMode === 'mask' ? 0.25 : 0) },
      )] }), catalog);
      assert.equal(result.sceneLayers[0].material.alphaMode, alphaMode);
    }
  }

  for (const [label, target, code] of [
    ['sprite inherit', layer('sprite@2', 'texture', { material: material('inherit') }), 'render-material-alpha-mode-invalid'],
    ['particle opaque', layer('particle@2', 'particle', { material: material('opaque') }), 'render-material-alpha-mode-invalid'],
    ['opaque cutoff', layer('model@2', 'model.primitive', { material: material('opaque', 0.1) }), 'render-material-alpha-cutoff-invalid'],
    ['cutoff over one', layer('sprite@2', 'texture', { material: material('mask', 1.1) }), 'render-material-alpha-cutoff-invalid'],
    ['scene opacity', layer('scene-pass@2', 'pass.background', {
      material: { ...material('opaque'), opacity: 0.5 },
    }), 'render-scene-pass-material-invalid'],
    ['scene emissive', layer('scene-pass@2', 'pass.background', {
      material: { ...material('opaque'), emissive: 0.1 },
    }), 'render-scene-pass-material-invalid'],
  ]) {
    assertCode(() => normalizeSnapshot(snapshot({ sceneLayers: [target] }), catalog), code, label);
  }
});

test('atlas cells and flipbooks are descriptor-aware and range checked before mutation', () => {
  const catalog = normalizedCatalog();
  const animated = animation();
  for (const [label, target, code] of [
    ['ordinary texture atlas cell', layer('sprite@2', 'texture', {
      params: spriteParams({ atlasCell: 0 }),
    }), 'render-sprite-atlas-resource-invalid'],
    ['ordinary texture flipbook', layer('sprite@2', 'texture', {
      params: spriteParams({ flipbook: flipbook() }), animation: animated,
    }), 'render-sprite-atlas-resource-invalid'],
    ['atlas cell end', layer('sprite@2', 'atlas', {
      params: spriteParams({ atlasCell: 8 }),
    }), 'render-atlas-cell-range-invalid'],
    ['flipbook end', layer('sprite@2', 'atlas', {
      params: spriteParams({ flipbook: flipbook({ startCell: 6, frameCount: 3 }) }),
      animation: animated,
    }), 'render-flipbook-range-invalid'],
    ['flipbook frame ticks', layer('sprite@2', 'atlas', {
      params: spriteParams({ flipbook: flipbook({ frameTicks: 0 }) }),
      animation: animated,
    }), 'render-flipbook-rate-invalid'],
    ['flipbook without animation', layer('sprite@2', 'atlas', {
      params: spriteParams({ flipbook: flipbook() }),
    }), 'render-sprite-animation-mismatch'],
    ['animation without flipbook', layer('sprite@2', 'atlas', {
      animation: animated,
    }), 'render-sprite-animation-mismatch'],
  ]) {
    assertCode(() => normalizeSnapshot(snapshot({ sceneLayers: [target] }), catalog), code, label);
  }

  const result = normalizeSnapshot(snapshot({ sceneLayers: [layer('sprite@2', 'atlas', {
    params: spriteParams({
      atlasCell: 7,
      flipbook: flipbook({ startCell: 4, frameCount: 4 }),
    }),
    animation: animated,
  })] }), catalog);
  assert.equal(result.sceneLayers[0].params.atlasCell, 7);
});

test('primitive cone/cylinder and independent surface geometry fields are strict', () => {
  const valid = normalizedCatalog();
  assert.deepEqual(valid.resources['model.primitive'].parts[1].dimensions, [0, 1, 2, 8]);
  assert.equal(valid.resources['surface.water'].geometry.segmentsX, 8);
  assert.equal(valid.resources['surface.water'].geometry.segmentsY, 3);

  for (const [label, shape, dimensions] of [
    ['cone negative top', 'cone', [-0.1, 1, 2, 8]],
    ['cone zero bottom', 'cone', [0, 0, 2, 8]],
    ['cone zero height', 'cone', [0, 1, 0, 8]],
    ['cone low segments', 'cone', [0, 1, 2, 2]],
    ['cone fractional segments', 'cone', [0, 1, 2, 3.5]],
    ['cylinder zero top', 'cylinder', [0, 1, 2, 8]],
    ['cylinder low segments', 'cylinder', [1, 1, 2, 2]],
  ]) {
    assertCode(() => normalizeResourceCatalog(catalogInput((resources) => {
      resources['model.primitive'].parts = [primitivePart(shape, dimensions)];
    })), 'render-primitive-dimensions-invalid', label);
  }

  for (const [label, mutate, code] of [
    ['missing segments X', (surface) => { delete surface.geometry.segmentsX; }, 'render-surface-segments-x-invalid'],
    ['zero segments Y', (surface) => { surface.geometry.segmentsY = 0; }, 'render-surface-segments-y-invalid'],
    ['multiple textures', (surface) => { surface.textureResourceIds = ['texture', 'texture.2']; }, 'render-surface-textures-invalid'],
    ['legacy family', (surface) => { surface.family = 'surface.foam'; }, 'render-surface-family-invalid'],
  ]) {
    assertCode(() => normalizeResourceCatalog(catalogInput((resources) => {
      resources['texture.2'] = { ...resources.texture, url: 'https://assets.invalid/2.png' };
      mutate(resources['surface.water']);
    })), code, label);
  }
});

test('surface, particle, and scene-pass params expose only implemented V2 fields', () => {
  const catalog = normalizedCatalog();
  for (const [label, target, code] of [
    ['surface legacy dimensions', layer('surface@2', 'surface.water', {
      params: { width: 10 },
    }), 'render-pipeline-param-unknown'],
    ['standard amplitude', layer('surface@2', 'surface.standard', {
      params: { amplitude: 1 },
    }), 'render-surface-param-family-invalid'],
    ['particle missing blend mode', layer('particle@2', 'particle', {
      params: particleParams({ blendMode: undefined }),
    }), 'render-particle-blend-mode-invalid'],
    ['background light field', layer('scene-pass@2', 'pass.background', {
      params: { intensity: 1 },
    }), 'render-scene-pass-param-kind-invalid'],
    ['lights zero direction', layer('scene-pass@2', 'pass.lights', {
      params: { direction: [0, 0, 0] },
    }), 'render-pass-direction-invalid'],
  ]) {
    assertCode(() => normalizeSnapshot(snapshot({ sceneLayers: [target] }), catalog), code, label);
  }

  assertCode(() => normalizeResourceCatalog(catalogInput((resources) => {
    resources['pass.background'].passKind = 'fog';
  })), 'render-scene-pass-kind-invalid', 'removed fog pass');
});

test('typed boundary values are copied and normalized results remain immutable', () => {
  const catalog = normalizedCatalog();
  const position = new Float32Array([1, 2, 3]);
  const raw = snapshot({ sceneLayers: [layer('model@2', 'model.primitive', {
    transform: { ...transform(), position },
  })] });
  const result = normalizeSnapshot(raw, catalog);
  position[0] = 99;
  assert.deepEqual(result.sceneLayers[0].transform.position, [1, 2, 3]);
  assert.ok(Object.isFrozen(result.sceneLayers[0]));
  assert.ok(Object.isFrozen(result.sceneLayers[0].material));
});

test('batch fingerprint follows V2 batching and explicit transparency rules', () => {
  const opaque = normalizedSceneLayer(layer('model@2', 'model.primitive', {
    params: { instance: true }, material: material('inherit'), batchKey: 'models',
  }));
  assert.equal(typeof batchFingerprint(opaque), 'string');
  assert.equal(batchFingerprint({ ...opaque, material: material('blend') }), null);
  assert.equal(batchFingerprint({ ...opaque, animation: animation() }), null);
  assert.equal(batchFingerprint({ ...opaque, params: {
    ...opaque.params, lodDistances: [10],
  } }), null);
  assert.equal(batchFingerprint(normalizedSceneLayer(layer('surface@2', 'surface.water'))), null);
});

function normalizedSceneLayer(value) {
  return normalizeSnapshot(snapshot({ sceneLayers: [value] }), normalizedCatalog()).sceneLayers[0];
}

function normalizedCatalog() {
  return normalizeResourceCatalog(catalogInput());
}

function catalogInput(mutate = null) {
  const resources = {
    'model.primitive': {
      kind: 'primitive-model',
      parts: [
        primitivePart('box', [1, 2, 3]),
        primitivePart('cone', [0, 1, 2, 8]),
      ],
    },
    texture: {
      kind: 'texture', url: 'https://assets.invalid/card.png', colorSpace: 'srgb', wrap: 'clamp',
    },
    'texture.2': {
      kind: 'texture', url: 'https://assets.invalid/card-2.png', colorSpace: 'linear', wrap: 'repeat',
    },
    atlas: {
      kind: 'texture-atlas', url: 'https://assets.invalid/atlas.png', columns: 4, rows: 2,
      colorSpace: 'srgb', wrap: { s: 'clamp', t: 'clamp' },
    },
    'surface.water': {
      kind: 'surface',
      family: 'surface.water',
      geometry: { primitive: 'plane', width: 20, height: 12, segmentsX: 8, segmentsY: 3 },
      textureResourceIds: [],
      defaults: { amplitude: 0.2, speed: 0.4, foam: 0.1, textureScale: 2 },
    },
    'surface.standard': {
      kind: 'surface',
      family: 'surface.standard',
      geometry: { primitive: 'plane', width: 4, height: 5, segmentsX: 1, segmentsY: 2 },
      textureResourceIds: ['texture'],
      defaults: { textureScale: 1 },
    },
    particle: { kind: 'particle', textureResourceId: null, maximumCapacity: 128 },
    'pass.background': {
      kind: 'scene-pass', passKind: 'background', defaults: { colorRgba: 0x224466ff },
    },
    'pass.background.2': {
      kind: 'scene-pass', passKind: 'background', defaults: { colorRgba: 0x112233ff },
    },
    'pass.lights': {
      kind: 'scene-pass', passKind: 'lights', defaults: {
        colorRgba: 0xffffffff, intensity: 1.5, direction: [1, 2, 3],
      },
    },
  };
  mutate?.(resources);
  return { schema: RENDER_RESOURCE_CATALOG_SCHEMA, resources };
}

function primitivePart(shape, dimensions) {
  return {
    shape,
    dimensions,
    material: { tintRgba: 0xffffffff, opacity: 1, emissive: 0 },
  };
}

function cameraProfile(overrides = {}) {
  return {
    projection: 'perspective',
    position: [10, 12, 14],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fovYDegrees: 42,
    near: 0.1,
    far: 10_000,
    minDistance: 2,
    maxDistance: 5_000,
    controls: controls(),
    ...overrides,
  };
}

function controls() {
  return {
    mode: 'pan-zoom',
    dampingFactor: 0.08,
    panSpeed: 1,
    zoomSpeed: 1,
    panBounds: { minX: -100, maxX: 100, minZ: -80, maxZ: 80 },
  };
}

function snapshot(overrides = {}) {
  return {
    schema: RENDER_SNAPSHOT_SCHEMA,
    generation: 1,
    commitSeq: 2,
    sourceTick: 3,
    compositions: [],
    sceneLayers: [],
    ...overrides,
  };
}

function batch(overrides = {}) {
  return {
    schema: RENDER_BATCH_SCHEMA,
    generation: 1,
    commitSeq: 2,
    sourceTick: 3,
    changed: [],
    removedDisplayIds: [],
    sceneLayers: null,
    ...overrides,
  };
}

function composition(layers, overrides = {}) {
  return {
    schema: RENDER_COMPOSITION_SCHEMA,
    displayId: 1n,
    renderRevision: 1,
    layers,
    ...overrides,
  };
}

function layer(pipelineId, resourceId, overrides = {}) {
  const params = {
    'model@2': { instance: false },
    'sprite@2': spriteParams(),
    'surface@2': {},
    'particle@2': particleParams(),
    'scene-pass@2': {},
  }[pipelineId] ?? {};
  const alphaMode = {
    'model@2': 'inherit',
    'sprite@2': 'mask',
    'surface@2': 'opaque',
    'particle@2': 'blend',
    'scene-pass@2': 'opaque',
  }[pipelineId] ?? 'opaque';
  return {
    key: 'layer',
    pipelineId,
    resourceId,
    transform: transform(),
    material: material(alphaMode, alphaMode === 'mask' ? 0.1 : 0),
    animation: pipelineId === 'particle@2' ? animation() : null,
    params,
    batchKey: null,
    pickable: false,
    renderOrder: 0,
    ...overrides,
  };
}

function transform() {
  return { position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function material(alphaMode, alphaCutoff = 0) {
  return { tintRgba: 0xffffffff, opacity: 1, emissive: 0, alphaMode, alphaCutoff };
}

function animation() {
  return { stateId: 1, clipId: 'active', startTick: 0n, flags: 0, clock: 'simulation' };
}

function spriteParams(overrides = {}) {
  return { orientation: 'fixed', width: 1, height: 1, ...overrides };
}

function particleParams(overrides = {}) {
  return {
    durationTicks: 60,
    capacity: 32,
    seed: 7,
    rate: 8,
    size: 0.2,
    velocity: [0, 1, 0],
    spread: [0.1, 0.2, 0.1],
    gravity: [0, -0.2, 0],
    blendMode: 'normal',
    ...overrides,
  };
}

function flipbook(overrides = {}) {
  return { startCell: 0, frameCount: 4, frameTicks: 2, loop: true, ...overrides };
}

function assertCode(invoke, code, label) {
  assert.throws(invoke, (error) => error?.code === code, label);
}
