import assert from 'node:assert/strict';
import * as client from '@scene-engine/client';
import { createThreeRenderBackend } from '@scene-engine/renderer-three';
import { createDisplayRuntime, createResourceRegistry, createComponentRegistry, createSceneRegistry,
  createDisplayKindRegistry, createPrefabRegistry, defineScene, SCENE_DEFINITION_SCHEMA,
  DisplayTransform, BehaviourComponent } from '@scene-engine/display';

assert.equal(typeof createThreeRenderBackend, 'function');
assert.ok(Object.keys(client).length > 0);
assert.equal(typeof BehaviourComponent.prototype.setProgramParameters, 'function');
const descriptor = { id: 'field', kind: 'generated-texture', revision: 1, width: 2, height: 2,
  format: 'rgba8unorm', usage: 'data', initialValue: [0, 0, 0, 255], budget: { maxUpdateBytes: 16, maxRegions: 2 } };
const resources = createResourceRegistry([descriptor, { id: 'card', kind: 'texture', url: './card.png' },
  { id: 'sampled-color', kind: 'texture', url: './color.png', colorSpace: 'srgb',
  minFilter: 'linear-mipmap-linear', magFilter: 'linear', mipmaps: true,
  alphaEncoding: 'straight', alphaSampling: 'premultiplied', wrap: { s: 'repeat', t: 'clamp' } },
  { id: 'program', kind: 'program', revision: 1, language: 'glsl-module@1', stage: 'surface',
    parameterSchema: { amount: { type: 'float', default: .5, min: 0, max: 1, updateable: true } },
    textureSlots: { image: { usage: 'color' } },
    source: 'vec4 evaluate(ProgramInput data){return texture2D(t_image,data.uv)*p_amount;}' },
  { id: 'program-material', kind: 'material', family: 'material.program', programResourceId: 'program',
    textures: { image: 'sampled-color' }, parameters: {}, properties: { alphaMode: 'blend' } }]);
const components = createComponentRegistry();
assert.deepEqual(components.normalizeProperties('render.sprite@3', { textureResourceId: 'card',
  width: 2, height: 1, projectionSemantics: 'anchor-extent', anchorOffset: [1, 2, 3] }, resources).anchorOffset, [1, 2, 3]);
const programSprite = components.normalizeProperties('render.sprite@3', { materialResourceId: 'program-material',
  width: 2, height: 1, projectionSemantics: 'anchor-extent', pivot: [.5, .2], parameters: { amount: .7 } }, resources);
assert.deepEqual(programSprite.pivot, [.5, .2]);
assert.equal(programSprite.parameters.amount, .7);
assert.equal('textureResourceId' in programSprite, false);
const backends = [], health = [], callbacks = new Map();
let nextId = 0;
const frameAdapter = { request(callback) { callbacks.set(++nextId, callback); return nextId; },
  cancel(id) { callbacks.delete(id); }, now() { return 0; } };
const scene = defineScene({ schema: SCENE_DEFINITION_SCHEMA, id: 'consumer', sceneProfile: 'test',
  rendererProfile: { drawMode: 'requested', maximumPixelRatio: 1, clearRgba: 255,
    antialias: false, alpha: false, shadows: false, toneMapping: 'none' },
  activeCameraLocalName: 'camera', nodes: [{ localName: 'camera', parentLocalName: null,
    transform: DisplayTransform.identity(), components: [{ key: 'camera', type: 'render.camera@1',
      properties: { projection: 'perspective', near: .1, far: 100, fovYDegrees: 50 } }] }], prefabInstances: [] });
const runtime = createDisplayRuntime({ sceneRegistry: createSceneRegistry([scene]),
  resourceRegistry: resources, componentRegistry: components, prefabRegistry: createPrefabRegistry([]),
  displayKindRegistry: createDisplayKindRegistry([]), authorityStateSchemas: [], frameAdapter,
  onHealth: event => health.push(event), createRenderBackend({ generatedTextureSource }) {
    // Consumer-owned backend: public source/rebuild lifecycle, not GPU proof.
    const lease = generatedTextureSource.acquire('field'), bindings = new Set();
    const record = { lease, disposed: false }; backends.push(record);
    return {
      createBinding(value) { const binding = { value }; bindings.add(binding); return binding; },
      updateBinding(binding, patch) { binding.patch = patch; },
      destroyBinding(binding) { bindings.delete(binding); },
      prepareFrame() { return { requiresContinuousDraw: false }; }, render() {}, requestResize() {},
      pick() { return null; }, pickProximity() { return null; },
      screenPointToWorldRay() { return { origin: [0, 0, 0], direction: [0, 0, -1] }; },
      projectWorldPoint() { return { clientX: 0, clientY: 0, depth: 0, visible: true }; },
      focusWorldPoint() { return { nodeName: 'camera', componentKey: 'camera', position: [0, 0, 1], target: [0, 0, 0] }; },
      capture() { return { bindings: bindings.size }; }, diagnostics() { return {}; }, whenIdle() {},
      dispose() { record.disposed = true; lease.release('consumer-backend-disposed'); bindings.clear(); },
    };
  } });
try {
  runtime.installScene({ sceneName: 'consumer' }); runtime.activate(); runtime.start(); await runtime.whenReady();
  const ticket = runtime.generatedTextures.begin('field', { sourceRevision: 'checkpoint@consumer' });
  const pixels = new Uint8Array([31, 32, 33, 255]);
  assert.equal(ticket.commit({ regions: [{ x: 1, y: 1, width: 1, height: 1, data: pixels }] }).status, 'staged');
  pixels.fill(0);
  const first = backends[0].lease;
  const before = first.update(16);
  assert.deepEqual([...before.regions.at(-1).data.slice(-4)], [31, 32, 33, 255]);
  first.submitted(ticket.generation); first.uploaded(ticket.generation);
  assert.equal((await runtime.generatedTextures.whenReady('field')).status, 'ready');
  runtime.setVisualTimePaused(true); runtime.setVisualTimePaused(false);
  await runtime.rebuildRenderBackend(); await runtime.whenReady();
  assert.equal(backends.length, 2); assert.equal(backends[0].disposed, true);
  const second = backends[1].lease;
  const update = second.update(16);
  assert.deepEqual(update, before);
  assert.equal(update.generation, ticket.generation); assert.equal(update.byteLength, 16);
  second.submitted(update.generation); second.uploaded(update.generation);
  assert.equal((await runtime.generatedTextures.whenReady('field')).status, 'ready');
  assert.equal(runtime.generatedTextures.status('field').committedSourceRevision, 'checkpoint@consumer');
  assert.equal(health.filter(event => event.severity === 'error').length, 0, JSON.stringify(health));
} finally { await runtime.dispose(); }
assert.equal(backends.every(value => value.disposed), true);
process.stdout.write(JSON.stringify({ rootImports: true, spriteAndSamplerNormalization: true, programSpriteCombination: true,
  generatedTextureCopyAndRebuild: true, globalVisualPause: true, backendCount: backends.length, disposed: true }));
