import assert from 'node:assert/strict';
import test from 'node:test';

import { Matrix4, Texture } from 'three';

import {
  RENDER_BATCH_SCHEMA,
  RENDER_COMPOSITION_SCHEMA,
  RENDER_RESOURCE_CATALOG_SCHEMA,
  RENDER_SNAPSHOT_SCHEMA,
} from '../src/constants.js';
import { createThreeRenderRuntimeForTest } from '../src/testing.js';
import { DEFAULT_THREE_ADAPTER } from '../src/three-adapter.js';

const MODEL = 'model@2';
const SPRITE = 'sprite@2';

test('V2 pose dirties update only the real model, fixed-sprite, and billboard slots', async () => {
  assert.ok([
    RENDER_BATCH_SCHEMA,
    RENDER_COMPOSITION_SCHEMA,
    RENDER_RESOURCE_CATALOG_SCHEMA,
    RENDER_SNAPSHOT_SCHEMA,
  ].every((schema) => schema.endsWith('@2')));

  const harness = realBatchHarness();
  const runtime = harness.runtime();
  const initialNodes = [
    node(1, 1), node(2, 2),
    node(3, 3), node(4, 4),
    node(5, 5), node(6, 6),
  ];
  const initialView = sceneView(initialNodes, 1, 1, 1);
  runtime.install({
    view: initialView,
    snapshot: snapshot(initialView, [
      composition(1, 1, [modelLayer()]),
      composition(2, 1, [modelLayer()]),
      composition(3, 1, [spriteLayer('fixed')]),
      composition(4, 1, [spriteLayer('fixed')]),
      composition(5, 1, [spriteLayer('billboard')]),
      composition(6, 1, [spriteLayer('billboard')]),
    ]),
  });
  await runtime.whenIdle();
  runtime.start();
  harness.flushRaf(1_000);

  const modelBatch = harness.batch(MODEL, null);
  const fixedBatch = harness.batch(SPRITE, 'fixed');
  const billboardBatch = harness.batch(SPRITE, 'billboard');
  const before = new Map([
    [1n, slotMatrix(modelBatch, 1n)], [2n, slotMatrix(modelBatch, 2n)],
    [3n, slotMatrix(fixedBatch, 3n)], [4n, slotMatrix(fixedBatch, 4n)],
    [5n, slotMatrix(billboardBatch, 5n)], [6n, slotMatrix(billboardBatch, 6n)],
  ]);

  const nextNodes = [
    node(1, 11), node(2, 2),
    node(3, 13), node(4, 4),
    node(5, 15), node(6, 6),
  ];
  const nextView = sceneView(nextNodes, 1, 2, 2);
  const matrixUpdates = harness.matrixUpdates;
  runtime.applyBatch([{
    plan: framePlan(2, 2, { localPoseDirtyIds: [1n, 3n, 5n] }),
    view: nextView,
    batch: batch(1, 2, 2),
  }]);
  assert.equal(harness.matrixUpdates, matrixUpdates + 1, 'one final matrix barrier');
  harness.flushRaf(1_016);
  assert.equal(harness.matrixUpdates, matrixUpdates + 1, 'draw did not add a redundant barrier');

  for (const [handle, changedId, stableId, expectedX] of [
    [modelBatch, 1n, 2n, 11],
    [fixedBatch, 3n, 4n, 13],
    [billboardBatch, 5n, 6n, 15],
  ]) {
    const changed = slotMatrix(handle, changedId);
    const stable = slotMatrix(handle, stableId);
    assert.notDeepEqual(changed.elements, before.get(changedId).elements);
    assert.deepEqual(stable.elements, before.get(stableId).elements);
    assert.equal(changed.elements[12], expectedX);
  }
  runtime.dispose();
});

test('V2 null-plan sourceTick resamples simulation without inventing local cursor movement', async () => {
  const harness = faultHarness();
  const runtime = harness.runtime();
  const firstView = sceneView([node(1, 0)], 1, 1, 10);
  const animated = spriteLayer('fixed', {
    animation: animation('simulation', 5n),
  });
  runtime.install({
    view: firstView,
    snapshot: snapshot(firstView, [composition(1, 1, [animated])]),
  });
  await runtime.whenIdle();
  runtime.start();
  harness.flushRaf(1_000);
  assert.equal(harness.samples.at(-1).tick, 10);

  const advanced = sceneView([node(1, 0)], 1, 2, 11);
  runtime.apply({ plan: null, view: advanced, batch: batch(1, 2, 11) });
  assert.equal(harness.rafCount, 1, 'no-frame simulation tick requested one draw');
  harness.flushRaf(1_016);
  assert.equal(harness.samples.at(-1).tick, 11);
  assert.equal(harness.samples.at(-1).seconds, 6 / 60);

  const sameTick = sceneView([node(1, 0)], 1, 3, 11);
  runtime.apply({ plan: null, view: sameTick, batch: batch(1, 3, 11) });
  assert.equal(harness.rafCount, 0, 'empty same-sourceTick commit did not request a draw');

  const visualLayer = spriteLayer('fixed', {
    animation: animation('visual', 5n),
  });
  runtime.apply({
    plan: null,
    view: sameTick,
    batch: batch(1, 3, 11, {
      changed: [composition(1, 2, [visualLayer])],
    }),
  });
  assert.equal(runtime.capture().commitSeq, 3);
  assert.equal(runtime.capture().sourceTick, 11);
  harness.flushRaf(2_000);
  assert.equal(runtime.capture().sourceTick, 11, 'visual time never rewrote Engine time');
  runtime.dispose();
});

for (const [stage, expectedCode] of [
  ['control', 'render-control-update-failed'],
  ['sample', 'render-pipeline-sample-failed'],
  ['batch', 'render-batch-prepare-failed'],
  ['draw', 'render-draw-failed'],
  ['diagnostics', 'render-diagnostics-capture-failed'],
]) {
  test(`V2 ${stage} frame failure is contained and recovers only through rebuild`, async () => {
    const health = [];
    const harness = faultHarness({ failStage: stage });
    const runtime = harness.runtime({ onHealth: (event) => health.push(event) });
    const firstView = sceneView([node(1, 1)], 1, 1, 1);
    const visual = modelLayer({ instance: stage === 'batch' });
    runtime.install({
      view: firstView,
      snapshot: snapshot(firstView, [composition(1, 1, [visual])]),
    });
    await runtime.whenIdle();
    runtime.start();
    assert.doesNotThrow(() => harness.flushRaf(1_000), 'RAF error did not escape globally');

    const capture = runtime.capture();
    assert.equal(capture.drawCount, 0);
    assert.equal(capture.lastFrameCpuTimeMs, null);
    assert.equal(capture.rafCount, 0);
    assert.equal(harness.rafCount, 0);
    assert.equal(capture.listenerCount, 4);
    assert.equal(capture.observerCount, 1);
    assert.equal(Object.hasOwn(capture, 'renderTargetPassCount'), false);
    assert.deepEqual(capture.healthFailure, {
      code: expectedCode,
      message: `${stage} exploded`,
      cursor: { generation: 1, commitSeq: 1, sourceTick: 1 },
    });
    assert.deepEqual(health.map((event) => event.code), [expectedCode]);
    assertPlainHealth(health[0]);
    await assert.rejects(
      runtime.whenIdle(),
      (error) => error.code === 'render-projection-unhealthy',
    );

    const recoveredView = sceneView([node(1, 9)], 2, 2, 2);
    runtime.rebuild({
      view: recoveredView,
      snapshot: snapshot(recoveredView, [composition(1, 2, [visual])]),
    });
    await runtime.whenIdle();
    const recovered = runtime.capture();
    assert.equal(Object.hasOwn(recovered, 'healthFailure'), false);
    assert.equal(recovered.rafCount, 1, 'successful latest rebuild requests recovery draw');
    assert.equal(harness.rendererCreates, stage === 'draw' ? 2 : 1);
    assert.equal(harness.rendererDisposes, stage === 'draw' ? 1 : 0);
    harness.flushRaf(1_016);
    assert.equal(runtime.capture().drawCount, 1);
    assert.deepEqual(health.map((event) => event.code), [expectedCode]);
    runtime.dispose();
    assert.equal(harness.rendererDisposes, stage === 'draw' ? 2 : 1);
  });
}

test('V2 failed rebuild stays unhealthy and a newer successful rebuild wins', async () => {
  const health = [];
  const harness = faultHarness({ failStage: 'draw' });
  const runtime = harness.runtime({ onHealth: (event) => health.push(event) });
  const first = sceneView([node(1, 0)], 1, 1, 1);
  runtime.install({ view: first, snapshot: snapshot(first, [
    composition(1, 1, [modelLayer({ instance: false })]),
  ]) });
  await runtime.whenIdle();
  runtime.start();
  harness.flushRaf(1_000);

  harness.failPipelineOnce();
  const failed = sceneView([node(1, 1)], 2, 2, 2);
  runtime.rebuild({ view: failed, snapshot: snapshot(failed, [
    composition(1, 2, [modelLayer({ instance: false })]),
  ]) });
  await assert.rejects(
    runtime.whenIdle(),
    (error) => error.code === 'render-projection-unhealthy',
  );
  assert.equal(runtime.capture().healthFailure.code, 'render-pipeline-create-failed');
  assert.equal(harness.rafCount, 0);

  const latest = sceneView([node(1, 2)], 3, 3, 3);
  runtime.rebuild({ view: latest, snapshot: snapshot(latest, [
    composition(1, 3, [modelLayer({ instance: false })]),
  ]) });
  await runtime.whenIdle();
  assert.equal(runtime.capture().generation, 3);
  harness.flushRaf(1_032);
  assert.equal(runtime.capture().drawCount, 1);
  assert.deepEqual(health.map((event) => event.code), [
    'render-draw-failed',
    'render-pipeline-create-failed',
  ]);
  runtime.dispose();
});

test('V2 profile updates stay in place with stable resources and zero pending work', async () => {
  const harness = faultHarness();
  const runtime = harness.runtime();
  const view = sceneView([node(1, 0)], 1, 1, 1);
  runtime.install({ view, snapshot: snapshot(view, [
    composition(1, 1, [modelLayer({ instance: false })]),
  ]) });
  await runtime.whenIdle();
  for (let revision = 2; revision <= 101; revision += 1) {
    runtime.apply({
      plan: null,
      view,
      batch: batch(1, 1, 1, {
        changed: [composition(1, revision, [modelLayer({
          instance: false,
          tintRgba: revision % 2 === 0 ? 0xff8844ff : 0x4488ffff,
          emissive: revision % 3 === 0 ? 0.25 : 0,
          pickable: revision % 2 === 0,
          renderOrder: revision % 4,
        })])],
      }),
    });
    assert.equal(runtime.capture().pendingJobCount, 0);
  }
  assert.equal(harness.resourceCreates, 1);
  assert.equal(harness.pipelineCreates, 1);
  assert.equal(harness.pipelineUpdates, 100);
  assert.equal(runtime.capture().resourceCount, 1);
  runtime.dispose();
  assert.equal(harness.liveResources, 0);
  assert.equal(harness.livePipelines, 0);
});

test('V2 generation token disposes a late pre-rebuild asset and attaches only the latest', async () => {
  const harness = faultHarness({ deferResources: true });
  const runtime = harness.runtime();
  const oldView = sceneView([node(1, 1)], 1, 1, 1);
  runtime.install({ view: oldView, snapshot: snapshot(oldView, [
    composition(1, 1, [modelLayer({ instance: false })]),
  ]) });
  await immediate();
  assert.equal(harness.resourceGateCount, 1);

  const latestView = sceneView([node(1, 2)], 2, 2, 2);
  runtime.rebuild({ view: latestView, snapshot: snapshot(latestView, [
    composition(1, 2, [modelLayer({ instance: false })]),
  ]) });
  await immediate();
  assert.equal(harness.resourceGateCount, 2);

  harness.resolveResource(0, { kind: 'primitive-model', marker: 'stale' });
  harness.resolveResource(1, { kind: 'primitive-model', marker: 'latest' });
  await runtime.whenIdle();
  assert.deepEqual(harness.pipelineAssets, ['latest']);
  assert.deepEqual(harness.disposedAssets, ['stale']);
  assert.equal(runtime.capture().generation, 2);
  assert.equal(runtime.capture().pendingJobCount, 0);
  runtime.dispose();
  assert.deepEqual(harness.disposedAssets.sort(), ['latest', 'stale']);
});

function realBatchHarness() {
  const raf = new Map();
  const batches = [];
  let nextRaf = 1;
  let matrixUpdates = 0;
  const adapter = {
    ...DEFAULT_THREE_ADAPTER,
    isHostElement: () => true,
    isCanvas: () => true,
    createRenderer: () => ({}),
    createControls: () => ({ update() {}, focus() {}, dispose() {}, listenerCount: 0 }),
    createResizeObserver: () => ({ observe() {}, disconnect() {}, observerCount: 0 }),
    setViewport() {},
    render() {},
    captureRendererInfo: () => null,
    disposeRenderer() {},
    requestAnimationFrame(callback) {
      const identity = nextRaf;
      nextRaf += 1;
      raf.set(identity, callback);
      return identity;
    },
    cancelAnimationFrame(identity) { raf.delete(identity); },
    now: () => 0,
    updateMatrices(root) {
      matrixUpdates += 1;
      DEFAULT_THREE_ADAPTER.updateMatrices(root);
    },
    async createResource(descriptor, signal, dependencies) {
      if (descriptor.kind === 'texture-atlas') {
        return { kind: descriptor.kind, descriptor, texture: new Texture() };
      }
      return DEFAULT_THREE_ADAPTER.createResource(descriptor, signal, dependencies);
    },
    disposeResource(asset) {
      if (asset.kind === 'texture-atlas') asset.texture.dispose();
      else DEFAULT_THREE_ADAPTER.disposeResource(asset);
    },
    createInstanceBatch(pipelineId, asset, layer, context) {
      const handle = DEFAULT_THREE_ADAPTER.createInstanceBatch(
        pipelineId,
        asset,
        layer,
        context,
      );
      if (handle) batches.push({ handle, orientation: layer.params.orientation ?? null, pipelineId });
      return handle;
    },
  };
  return {
    get matrixUpdates() { return matrixUpdates; },
    runtime() { return createThreeRenderRuntimeForTest(options(catalog()), adapter); },
    batch(pipelineId, orientation) {
      return batches.find((item) => item.pipelineId === pipelineId
        && item.orientation === orientation)?.handle;
    },
    flushRaf(timestamp) {
      const callbacks = [...raf.values()];
      raf.clear();
      for (const callback of callbacks) callback(timestamp);
    },
  };
}

function faultHarness({ failStage = null, deferResources = false } = {}) {
  const raf = new Map();
  let nextRaf = 1;
  let armedStage = failStage;
  let failPipeline = false;
  let liveResources = 0;
  let livePipelines = 0;
  let pipelineCreates = 0;
  let pipelineUpdates = 0;
  let rendererCreates = 0;
  let rendererDisposes = 0;
  let resourceCreates = 0;
  const disposedAssets = [];
  const pipelineAssets = [];
  const resourceGates = [];
  const samples = [];
  const explode = (stage) => {
    if (armedStage !== stage) return;
    armedStage = null;
    throw new Error(`${stage} exploded`);
  };
  const adapter = {
    isHostElement: () => true,
    isCanvas: () => true,
    createRenderer() { rendererCreates += 1; return {}; },
    createScene: () => new FakeGroup(),
    createGroup: () => new FakeGroup(),
    createCamera: () => ({}),
    createControls: () => ({
      update() { explode('control'); },
      focus() {},
      dispose() {},
      listenerCount: 4,
    }),
    createResizeObserver: () => ({ observe() {}, disconnect() {}, observerCount: 1 }),
    requestAnimationFrame(callback) {
      const identity = nextRaf;
      nextRaf += 1;
      raf.set(identity, callback);
      return identity;
    },
    cancelAnimationFrame(identity) { raf.delete(identity); },
    now: () => 0,
    devicePixelRatio: () => 1,
    setViewport() {},
    render() { explode('draw'); },
    captureRendererInfo() {
      explode('diagnostics');
      return Object.freeze({
        calls: 0, frame: 0, geometries: 1, lines: 0, points: 0, textures: 0, triangles: 12,
      });
    },
    updateMatrices() {},
    setTransform(object, transform) { object.transform = transform; },
    setNodePose(object, value) { object.pose = value; },
    async createResource(descriptor, signal, dependencies) {
      resourceCreates += 1;
      if (deferResources) {
        const gate = deferred();
        resourceGates.push(gate);
        const asset = await gate.promise;
        liveResources += 1;
        return asset;
      }
      liveResources += 1;
      return { kind: descriptor.kind, descriptor, dependencies };
    },
    disposeResource(asset) {
      liveResources -= 1;
      if (asset.marker) disposedAssets.push(asset.marker);
    },
    createInstanceBatch() {
      pipelineCreates += 1;
      livePipelines += 1;
      const object = new FakeGroup();
      return {
        object,
        update() {},
        updateLayer() { pipelineUpdates += 1; return true; },
        prepareDraw() { explode('batch'); },
        dispose() { if (object.disposed) return; object.disposed = true; livePipelines -= 1; },
      };
    },
    createPipelineObject(pipelineId, asset) {
      if (failPipeline) {
        failPipeline = false;
        throw new Error('pipeline rebuild exploded');
      }
      pipelineCreates += 1;
      livePipelines += 1;
      if (asset.marker) pipelineAssets.push(asset.marker);
      const object = new FakeGroup();
      return {
        object,
        update() { pipelineUpdates += 1; return true; },
        sample(seconds, tick) {
          explode('sample');
          samples.push({ pipelineId, seconds, tick });
        },
        dispose() {
          if (object.disposed) return;
          object.disposed = true;
          livePipelines -= 1;
        },
      };
    },
    markPickIdentity() {},
    project: () => ({ ok: true }),
    pick: () => ({ hit: false }),
    disposeObject(object) { object.removeFromParent(); },
    disposeRenderer() { rendererDisposes += 1; },
  };
  return {
    get livePipelines() { return livePipelines; },
    get liveResources() { return liveResources; },
    get pipelineCreates() { return pipelineCreates; },
    get pipelineUpdates() { return pipelineUpdates; },
    get rafCount() { return raf.size; },
    get resourceCreates() { return resourceCreates; },
    get resourceGateCount() { return resourceGates.length; },
    get rendererCreates() { return rendererCreates; },
    get rendererDisposes() { return rendererDisposes; },
    disposedAssets,
    pipelineAssets,
    samples,
    failPipelineOnce() { failPipeline = true; },
    resolveResource(index, asset) { resourceGates[index].resolve(asset); },
    runtime(overrides = {}) {
      return createThreeRenderRuntimeForTest({ ...options(catalog()), ...overrides }, adapter);
    },
    flushRaf(timestamp) {
      const callbacks = [...raf.values()];
      raf.clear();
      for (const callback of callbacks) callback(timestamp);
    },
  };
}

function options(resourceCatalog) {
  return {
    hostElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      addEventListener() {},
      removeEventListener() {},
    },
    canvas: { getContext() {} },
    cameraProfile: {
      projection: 'perspective',
      position: [10, 8, 10],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 50,
      near: 0.1,
      far: 1_000,
      minDistance: 1,
      maxDistance: 100,
      controls: {
        mode: 'pan-zoom',
        dampingFactor: 0.1,
        panSpeed: 1,
        zoomSpeed: 1,
        panBounds: null,
      },
    },
    rendererProfile: {
      drawMode: 'requested',
      maximumPixelRatio: 2,
      clearRgba: 0x000000ff,
      antialias: false,
      alpha: false,
      shadows: false,
      toneMapping: 'none',
    },
    resourceCatalog,
  };
}

function catalog() {
  return {
    schema: RENDER_RESOURCE_CATALOG_SCHEMA,
    resources: {
      model: {
        kind: 'primitive-model',
        parts: [{
          shape: 'box',
          dimensions: [1, 1, 1],
          material: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0 },
        }],
      },
      atlas: {
        kind: 'texture-atlas',
        url: '/atlas.png',
        columns: 2,
        rows: 2,
        colorSpace: 'srgb',
        wrap: 'clamp',
      },
    },
  };
}

function node(identity, x) {
  return Object.freeze({
    displayId: BigInt(identity),
    parentDisplayId: 0n,
    localPosition: [x, 0, 0],
    localRotationXyzw: [0, 0, 0, 1],
    localScale: [1, 1, 1],
    flags: 1,
  });
}

function sceneView(nodes, generation, commitSeq, sourceTick) {
  const byId = new Map(nodes.map((item) => [item.displayId, item]));
  return Object.freeze({
    generation,
    commitSeq,
    sourceTick,
    nodeCount: nodes.length,
    nodeAt: (index) => nodes[index],
    getNode: (identity) => byId.get(identity) ?? null,
  });
}

function composition(identity, renderRevision, layers) {
  return {
    schema: RENDER_COMPOSITION_SCHEMA,
    displayId: BigInt(identity),
    renderRevision,
    layers,
  };
}

function snapshot(view, compositions) {
  return {
    schema: RENDER_SNAPSHOT_SCHEMA,
    generation: view.generation,
    commitSeq: view.commitSeq,
    sourceTick: view.sourceTick,
    compositions,
    sceneLayers: [],
  };
}

function batch(generation, commitSeq, sourceTick, overrides = {}) {
  return {
    schema: RENDER_BATCH_SCHEMA,
    generation,
    commitSeq,
    sourceTick,
    changed: overrides.changed ?? [],
    removedDisplayIds: overrides.removedDisplayIds ?? [],
    sceneLayers: overrides.sceneLayers ?? null,
  };
}

function framePlan(commitSeq, sourceTick, overrides = {}) {
  return {
    kind: 'frame',
    generation: 1,
    commitSeq,
    sourceTick,
    animationDirtyIds: overrides.animationDirtyIds ?? [],
    createIds: overrides.createIds ?? [],
    interactionDirtyIds: overrides.interactionDirtyIds ?? [],
    localPoseDirtyIds: overrides.localPoseDirtyIds ?? [],
    profileStateDirtyIds: overrides.profileStateDirtyIds ?? [],
    removeIds: overrides.removeIds ?? [],
    reparentIds: overrides.reparentIds ?? [],
    visibilityDirtyIds: overrides.visibilityDirtyIds ?? [],
    visualReplaceIds: overrides.visualReplaceIds ?? [],
  };
}

function modelLayer(overrides = {}) {
  return renderLayer({
    pipelineId: MODEL,
    resourceId: 'model',
    params: { instance: overrides.instance ?? true },
    material: material({
      tintRgba: overrides.tintRgba,
      emissive: overrides.emissive,
      alphaMode: 'opaque',
    }),
    animation: overrides.animation ?? null,
    pickable: overrides.pickable ?? false,
    renderOrder: overrides.renderOrder ?? 0,
  });
}

function spriteLayer(orientation, overrides = {}) {
  return renderLayer({
    pipelineId: SPRITE,
    resourceId: 'atlas',
    params: {
      orientation,
      width: 1,
      height: 1,
      atlasCell: 0,
      ...(overrides.animation === undefined ? {} : {
        flipbook: { startCell: 0, frameCount: 4, frameTicks: 1, loop: true },
      }),
    },
    material: material({ alphaMode: 'mask', alphaCutoff: 0.5 }),
    animation: overrides.animation ?? null,
  });
}

function renderLayer(overrides) {
  return {
    key: 'body',
    pipelineId: overrides.pipelineId,
    resourceId: overrides.resourceId,
    transform: {
      position: [0, 0, 0],
      rotationXyzw: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    material: overrides.material,
    animation: overrides.animation ?? null,
    params: overrides.params,
    batchKey: 'shared',
    pickable: overrides.pickable ?? false,
    renderOrder: overrides.renderOrder ?? 0,
  };
}

function material(overrides = {}) {
  return {
    tintRgba: overrides.tintRgba ?? 0xffff_ffff,
    opacity: 1,
    emissive: overrides.emissive ?? 0,
    alphaMode: overrides.alphaMode ?? 'opaque',
    alphaCutoff: overrides.alphaCutoff ?? 0,
  };
}

function animation(clock, startTick) {
  return { stateId: 1, clipId: 'idle', startTick, flags: 0, clock };
}

function slotMatrix(handle, displayId) {
  assert.ok(handle, `missing instance batch for ${displayId}`);
  const identities = handle.object.userData.renderBatchIdentities;
  const slot = identities.findIndex((item) => item.displayId === displayId);
  assert.notEqual(slot, -1, `missing slot for ${displayId}`);
  const result = new Matrix4();
  handle.object.getMatrixAt(slot, result);
  return result;
}

function assertPlainHealth(event) {
  assert.equal(Object.isFrozen(event), true);
  for (const value of Object.values(event)) {
    assert.equal(value instanceof Error, false);
    assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeGroup {
  constructor() {
    this.children = [];
    this.name = '';
    this.parent = null;
    this.visible = true;
    this.disposed = false;
  }

  add(...children) {
    for (const child of children) {
      child.removeFromParent?.();
      child.parent = this;
      this.children.push(child);
    }
  }

  remove(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    if (child.parent === this) child.parent = null;
  }

  removeFromParent() { this.parent?.remove(this); }
}
