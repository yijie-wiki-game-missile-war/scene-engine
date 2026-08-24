import assert from 'node:assert/strict';
import test from 'node:test';

import * as publicApi from '../src/index.js';
import { batchFingerprint } from '../src/contracts.js';
import { createThreeRenderRuntimeForTest } from '../src/testing.js';
import { DEFAULT_THREE_ADAPTER } from '../src/three-adapter.js';

const {
  RENDER_BATCH_SCHEMA,
  RENDER_COMPOSITION_SCHEMA,
  RENDER_SNAPSHOT_SCHEMA,
  THREE_RENDER_RUNTIME_SCHEMA,
  ThreeRenderRuntime,
} = publicApi;

test('root export surface is the exact breaking 0.8 allowlist', () => {
  assert.deepEqual(Object.keys(publicApi).sort(), [
    'RENDER_BATCH_SCHEMA',
    'RENDER_COMPOSITION_SCHEMA',
    'RENDER_SNAPSHOT_SCHEMA',
    'THREE_RENDER_RUNTIME_SCHEMA',
    'ThreeRenderRuntime',
    'ThreeRenderRuntimeError',
    'createThreeRenderRuntime',
  ]);
});

test('owned Three adapter creates a real primitive instance batch without initialization races', async () => {
  const asset = await DEFAULT_THREE_ADAPTER.createResource({
    kind: 'primitive-model',
    parts: [{
      shape: 'box',
      dimensions: [1, 1, 1],
      material: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0 },
    }],
  }, new AbortController().signal, []);
  const batch = DEFAULT_THREE_ADAPTER.createInstanceBatch(
    'model@2',
    asset,
    layer('model@2', 'model.primitive', {
      castShadow: true, receiveShadow: true, instance: true,
    }, { material: material({ alphaMode: 'mask', alphaCutoff: 0.35 }) }),
    { camera: null },
  );
  assert.ok(batch?.object?.isInstancedMesh);
  assert.equal(batch.object.material.transparent, false);
  assert.equal(batch.object.material.alphaTest, 0.35);
  assert.equal(batch.object.material.depthWrite, true);
  const container = DEFAULT_THREE_ADAPTER.createGroup();
  container.updateMatrixWorld(true);
  batch.update([{ container, displayId: 1n, layerKey: 'body' }]);
  assert.equal(batch.object.count, 1);
  assert.deepEqual(batch.object.userData.renderBatchIdentities, [
    { displayId: 1n, layerKey: 'body' },
  ]);
  batch.dispose();
  DEFAULT_THREE_ADAPTER.disposeResource(asset);
});

test('host internals are owned, hidden, and cannot be injected', () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  assert.deepEqual(Reflect.ownKeys(runtime), []);
  for (const name of [
    'getRenderer', 'getScene', 'getCamera', 'getControls', 'getRoot', 'getObject3D',
    'addFrameTask', 'registerPipeline', 'registerFactory',
  ]) assert.equal(name in ThreeRenderRuntime.prototype, false);
  for (const forbidden of ['THREE', 'root', 'renderer', 'scene']) {
    assert.throws(
      () => new ThreeRenderRuntime({ ...publicOptions(), [forbidden]: {} }),
      (error) => error.code === 'render-constructor-option-unknown',
    );
  }
  assert.equal(harness.stats.renderersCreated, 1);
  assert.equal(harness.stats.scenesCreated, 1);
  assert.equal(harness.stats.camerasCreated, 1);
  assert.equal(harness.stats.cameraProfiles[0].projection, 'perspective');
  assert.deepEqual(harness.stats.controlProfiles[0].controls, {
    mode: 'pan-zoom',
    dampingFactor: 0.08,
    panSpeed: 1,
    zoomSpeed: 1,
    panBounds: { minX: -100, maxX: 100, minZ: -80, maxZ: 80 },
  });
  runtime.dispose();
});

test('install creates every anchor before non-parent-first linking and installs layers', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const nodes = [node(1, { parentDisplayId: 2n }), node(2)];
  const view = sceneView(nodes);
  runtime.install({
    view,
    snapshot: renderSnapshot(view, nodes.map((item) => composition(item.displayId, 1, [
      layer('model@2', 'model.primitive', { instance: true }),
    ]))),
  });
  await runtime.whenIdle();
  assert.deepEqual(runtime.capture(), {
    schema: THREE_RENDER_RUNTIME_SCHEMA,
    generation: 1,
    commitSeq: 1,
    sourceTick: 1,
    nodeCount: 2,
    layerCount: 2,
    sceneLayerCount: 0,
    batchCount: 1,
    resourceCount: 1,
    pendingJobCount: 0,
    drawCount: 0,
    lastFrameCpuTimeMs: null,
    rendererInfo: {
      calls: 0,
      frame: 0,
      geometries: 0,
      lines: 0,
      points: 50,
      textures: 1,
      triangles: 450,
    },
    listenerCount: 1,
    observerCount: 1,
    rafCount: 0,
  });
  const childAnchor = harness.stats.groups.find((item) => item.name === 'SceneAnchor:1');
  const parentAnchor = harness.stats.groups.find((item) => item.name === 'SceneAnchor:2');
  assert.strictEqual(childAnchor.parent, parentAnchor);
  assert.equal(harness.stats.resourceCreates.get('primitive-model'), 1);
  runtime.dispose();
});

test('layer diff retains transform-only mechanics and replaces changed resources once', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const initialView = sceneView([node(1)]);
  runtime.install({
    view: initialView,
    snapshot: renderSnapshot(initialView, [composition(1n, 1, [
      layer('model@2', 'model.primitive', { instance: true }),
      layer('sprite@2', 'texture.card', { orientation: 'fixed' }, { key: 'card' }),
    ])]),
  });
  await runtime.whenIdle();
  const creates = harness.stats.pipelineCreates;

  const moved = layer('model@2', 'model.primitive', { instance: true }, {
    transform: transform({ position: [4, 5, 6] }),
  });
  runtime.apply({
    plan: framePlan(2),
    view: sceneView([node(1)], 1, 2, 2),
    batch: renderBatch(1, 2, 2, {
      changed: [composition(1n, 2, [
        moved,
        layer('sprite@2', 'texture.atlas', {
          orientation: 'billboard', atlasCell: 1,
        }, { key: 'card' }),
      ])],
    }),
  });
  await runtime.whenIdle();
  assert.equal(harness.stats.pipelineCreates, creates + 1, 'transform-only model stayed live');
  assert.equal(harness.stats.pipelineDisposes, 1, 'only replaced sprite was disposed');
  assert.equal(runtime.capture().layerCount, 2);
  assert.equal(runtime.capture().resourceCount, 2);
  runtime.dispose();
});

test('applyBatch preserves intermediate create/remove and performs one matrix barrier', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const emptyView = sceneView([], 1, 0, 0);
  runtime.install({ view: emptyView, snapshot: renderSnapshot(emptyView, []) });
  const before = harness.stats.matrixUpdates;
  const createdView = sceneView([node(1)], 1, 1, 1);
  const removedView = sceneView([], 1, 2, 2);
  runtime.applyBatch([
    {
      plan: framePlan(1, { createIds: [1n] }),
      view: createdView,
      batch: renderBatch(1, 1, 1, {
        changed: [composition(1n, 1, [layer('model@2', 'model.primitive', {})])],
      }),
    },
    {
      plan: framePlan(2, { removeIds: [1n] }),
      view: removedView,
      batch: renderBatch(1, 2, 2, { removedDisplayIds: [1n] }),
    },
  ]);
  await runtime.whenIdle();
  assert.equal(runtime.capture().nodeCount, 0);
  assert.equal(runtime.capture().layerCount, 0);
  assert.equal(runtime.capture().commitSeq, 2);
  assert.equal(runtime.capture().sourceTick, 2);
  assert.equal(harness.stats.matrixUpdates - before, 1, 'one scene matrix barrier');
  assert.ok(harness.stats.groups.some((item) => item.name === 'SceneAnchor:1'));
  runtime.dispose();
});

test('null plan distinguishes ordered Engine no-frame and same-cursor local state', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const firstView = sceneView([node(1)], 1, 1, 1);
  runtime.install({
    view: firstView,
    snapshot: renderSnapshot(firstView, [composition(1n, 1, [
      layer('model@2', 'model.primitive', {}),
    ])]),
  });
  await runtime.whenIdle();
  const nextView = sceneView([node(1)], 1, 2, 1);
  runtime.apply({ plan: null, view: nextView, batch: renderBatch(1, 2, 1) });
  assert.equal(runtime.capture().commitSeq, 2);
  runtime.apply({
    plan: null,
    view: nextView,
    batch: renderBatch(1, 2, 1, {
      changed: [composition(1n, 2, [layer('model@2', 'model.primitive', {}, {
        material: material({ tintRgba: 0xff0000ff }),
      })])],
    }),
  });
  await runtime.whenIdle();
  assert.equal(runtime.capture().commitSeq, 2);
  assert.throws(
    () => runtime.apply({
      plan: null,
      view: sceneView([node(1)], 1, 4, 1),
      batch: renderBatch(1, 4, 1),
    }),
    (error) => error.code === 'render-null-plan-cursor-invalid',
  );
  runtime.dispose();
});

test('pending resources are tokened across remove and rebuild; stale assets are disposed', async () => {
  const first = deferred();
  const harness = fakeHarness({ deferredUrls: new Map([['/slow.glb', first.promise]]) });
  const runtime = harness.runtime();
  const view1 = sceneView([node(1)], 1, 1, 1);
  runtime.install({
    view: view1,
    snapshot: renderSnapshot(view1, [composition(1n, 1, [
      layer('model@2', 'model.slow', {}),
    ])]),
  });
  assert.equal(runtime.capture().pendingJobCount, 1);
  const view2 = sceneView([node(2)], 2, 8, 6);
  runtime.rebuild({
    view: view2,
    snapshot: renderSnapshot(view2, [composition(2n, 1, [
      layer('model@2', 'model.primitive', {}),
    ])]),
  });
  const staleAsset = { kind: 'model-url', marker: 'stale' };
  first.resolve(staleAsset);
  await runtime.whenIdle();
  assert.equal(runtime.capture().generation, 2);
  assert.equal(runtime.capture().nodeCount, 1);
  assert.ok(harness.stats.disposedAssets.includes(staleAsset));
  assert.equal(harness.stats.pipelineCreates, 1, 'stale resource never attached');
  runtime.dispose();
});

test('a newer equal composition supersedes a pending revision without losing the visual', async () => {
  const pending = deferred();
  const harness = fakeHarness({ deferredUrls: new Map([['/slow.glb', pending.promise]]) });
  const runtime = harness.runtime();
  const view1 = sceneView([node(1)], 1, 1, 1);
  const visual = layer('model@2', 'model.slow', {});
  runtime.install({
    view: view1,
    snapshot: renderSnapshot(view1, [composition(1n, 1, [visual])]),
  });
  const view2 = sceneView([node(1)], 1, 2, 2);
  runtime.apply({
    plan: framePlan(2),
    view: view2,
    batch: renderBatch(1, 2, 2, { changed: [composition(1n, 2, [visual])] }),
  });
  pending.resolve({ kind: 'model-url', marker: 'shared-result' });
  await runtime.whenIdle();
  assert.equal(harness.stats.pipelineCreates, 1);
  assert.equal(runtime.capture().layerCount, 1);
  assert.equal(runtime.capture().pendingJobCount, 0);
  runtime.dispose();
});

test('failed and late dependency loads release every catalog lease back to baseline', async () => {
  const rejected = deferred();
  const harness = fakeHarness({ deferredUrls: new Map([['/card.png', rejected.promise]]) });
  const runtime = harness.runtime();
  const view1 = sceneView([node(1)], 1, 1, 1);
  runtime.install({
    view: view1,
    snapshot: renderSnapshot(view1, [composition(1n, 1, [
      layer('surface@2', 'surface.water', {}),
    ])]),
  });
  rejected.reject(new Error('texture failed'));
  await assert.rejects(
    runtime.whenIdle(),
    (error) => error.code === 'render-projection-unhealthy',
  );
  assert.equal(runtime.capture().resourceCount, 1, 'only the still-referenced failed parent remains');
  const recoveredView = sceneView([node(1)], 2, 2, 2);
  runtime.rebuild({
    view: recoveredView,
    snapshot: renderSnapshot(recoveredView, [composition(1n, 2, [])]),
  });
  await runtime.whenIdle();
  assert.equal(runtime.capture().resourceCount, 0);
  runtime.dispose();

  const late = deferred();
  const lateHarness = fakeHarness({ deferredUrls: new Map([['/card.png', late.promise]]) });
  const lateRuntime = lateHarness.runtime();
  lateRuntime.install({
    view: view1,
    snapshot: renderSnapshot(view1, [composition(1n, 1, [
      layer('surface@2', 'surface.water', {}),
    ])]),
  });
  const view2 = sceneView([node(1)], 1, 2, 2);
  lateRuntime.apply({
    plan: framePlan(2),
    view: view2,
    batch: renderBatch(1, 2, 2, { changed: [composition(1n, 2, [])] }),
  });
  const lateAsset = { kind: 'texture', marker: 'late-dependency' };
  late.resolve(lateAsset);
  await lateRuntime.whenIdle();
  assert.equal(lateRuntime.capture().resourceCount, 0);
  assert.ok(lateHarness.stats.disposedAssets.includes(lateAsset));
  lateRuntime.dispose();
});

test('a current resource failure is fatal until a newer rebuild settles successfully', async () => {
  const first = deferred();
  const health = [];
  const harness = fakeHarness({ deferredUrls: new Map([['/slow.glb', first.promise]]) });
  const runtime = harness.runtime({ onHealth: (event) => health.push(event) });
  const failedView = sceneView([node(1)], 1, 1, 1);
  runtime.install({
    view: failedView,
    snapshot: renderSnapshot(failedView, [composition(1n, 1, [
      layer('model@2', 'model.slow', {}),
    ])]),
  });
  first.reject(new Error('bootstrap asset missing'));
  await assert.rejects(
    runtime.whenIdle(),
    (error) => error.code === 'render-projection-unhealthy'
      && error.message.includes('bootstrap asset missing'),
  );
  assert.equal(runtime.capture().pendingJobCount, 0);
  assert.deepEqual(health.map((event) => event.code), ['render-resource-load-failed']);
  assert.throws(() => runtime.start(), (error) => error.code === 'render-projection-unhealthy');

  const failedRecoveryView = sceneView([node(1)], 2, 2, 2);
  runtime.rebuild({
    view: failedRecoveryView,
    snapshot: renderSnapshot(failedRecoveryView, [composition(1n, 2, [
      layer('model@2', 'model.slow', {}),
    ])]),
  });
  await assert.rejects(
    runtime.whenIdle(),
    (error) => error.code === 'render-projection-unhealthy'
      && error.message.includes('bootstrap asset missing'),
  );
  assert.deepEqual(health.map((event) => event.code), [
    'render-resource-load-failed',
    'render-resource-load-failed',
  ]);

  const recoveredView = sceneView([node(1)], 3, 3, 3);
  runtime.rebuild({
    view: recoveredView,
    snapshot: renderSnapshot(recoveredView, [composition(1n, 3, [
      layer('model@2', 'model.primitive', {}),
    ])]),
  });
  await runtime.whenIdle();
  assert.equal(runtime.capture().generation, 3);
  assert.equal(runtime.capture().pendingJobCount, 0);
  runtime.start();
  assert.equal(runtime.capture().rafCount, 1);
  runtime.dispose();
});

test('a current pipeline construction failure makes bootstrap whenIdle reject', async () => {
  const health = [];
  const harness = fakeHarness({ pipelineFailure: new Error('primitive pipeline exploded') });
  const runtime = harness.runtime({ onHealth: (event) => health.push(event) });
  const view = sceneView([node(1)]);
  runtime.install({
    view,
    snapshot: renderSnapshot(view, [composition(1n, 1, [
      layer('model@2', 'model.primitive', {}),
    ])]),
  });
  await assert.rejects(
    runtime.whenIdle(),
    (error) => error.code === 'render-projection-unhealthy'
      && error.message.includes('primitive pipeline exploded'),
  );
  assert.deepEqual(health.map((event) => event.code), ['render-pipeline-create-failed']);
  runtime.dispose();
});

test('dispose aborts a pending rejection without health or unhandled failure', async () => {
  const pending = deferred();
  const health = [];
  const harness = fakeHarness({ deferredUrls: new Map([['/slow.glb', pending.promise]]) });
  const runtime = harness.runtime({ onHealth: (event) => health.push(event) });
  const view = sceneView([node(1)]);
  runtime.install({
    view,
    snapshot: renderSnapshot(view, [composition(1n, 1, [
      layer('model@2', 'model.slow', {}),
    ])]),
  });
  runtime.dispose();
  pending.reject(new Error('late disposed failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(health, []);
  assert.equal(harness.stats.liveResources.size, 0);
  assert.equal(harness.stats.livePipelineHandles.size, 0);
});

test('invalid dirty IDs are rejected before any projection mutation', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const firstView = sceneView([node(1)], 1, 1, 1);
  runtime.install({
    view: firstView,
    snapshot: renderSnapshot(firstView, [composition(1n, 1, [
      layer('model@2', 'model.primitive', {}),
    ])]),
  });
  await runtime.whenIdle();
  const before = runtime.capture();
  const matrixUpdates = harness.stats.matrixUpdates;
  assert.throws(
    () => runtime.apply({
      plan: framePlan(2, { removeIds: [1n], visibilityDirtyIds: [99n] }),
      view: sceneView([], 1, 2, 2),
      batch: renderBatch(1, 2, 2, { removedDisplayIds: [1n] }),
    }),
    (error) => error.code === 'render-plan-dirty-id-invalid',
  );
  assert.equal(runtime.capture().commitSeq, before.commitSeq);
  assert.equal(runtime.capture().nodeCount, before.nodeCount);
  assert.equal(harness.stats.matrixUpdates, matrixUpdates);
  runtime.apply({
    plan: framePlan(2, { removeIds: [1n] }),
    view: sceneView([], 1, 2, 2),
    batch: renderBatch(1, 2, 2, { removedDisplayIds: [1n] }),
  });
  assert.equal(runtime.capture().nodeCount, 0, 'validation failure did not poison runtime');
  runtime.dispose();
});

test('all five fixed pipelines accept their closed parameters and reject unknown ones', async () => {
  const valid = [
    layer('model@2', 'model.primitive', {
      castShadow: true, receiveShadow: true, instance: false,
    }, { key: 'model' }),
    layer('sprite@2', 'texture.atlas', {
      orientation: 'billboard', width: 2, height: 3, atlasCell: 2,
      flipbook: { startCell: 0, frameCount: 4, frameTicks: 3, loop: true },
    }, { key: 'sprite', animation: animation({ clipId: 'flipbook' }) }),
    layer('surface@2', 'surface.water', {
      amplitude: 0.2, speed: 1, foam: 0.1, textureScale: 2,
    }, { key: 'surface' }),
    layer('particle@2', 'particle.smoke', {
      durationTicks: 120, capacity: 32, seed: 7, rate: 5, size: 1,
      velocity: [1, 2, 3], spread: [0.1, 0.2, 0.3], gravity: [0, -9.8, 0],
      blendMode: 'additive',
    }, { key: 'particle' }),
  ];
  const pass = layer('scene-pass@2', 'pass.background', {
    passKind: 'background', colorRgba: 0x112233ff,
  }, { key: 'pass' });
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const view = sceneView([node(1)]);
  runtime.install({
    view,
    snapshot: renderSnapshot(view, [composition(1n, 1, valid)], [pass]),
  });
  await runtime.whenIdle();
  assert.equal(runtime.capture().layerCount, 5);
  assert.deepEqual(new Set(harness.stats.pipelineIds), new Set([
    'model@2', 'sprite@2', 'surface@2', 'particle@2', 'scene-pass@2',
  ]));
  assert.deepEqual(harness.stats.scenePassStates.at(-1), [{
    key: 'pass', passKind: 'background', colorRgba: 0x112233ff,
  }]);
  assert.equal(Object.hasOwn(runtime.capture(), 'renderTargetPassCount'), false,
    'surface@2 is an ordinary scene object and allocates no render target pass');
  runtime.dispose();

  for (const [pipelineId, resourceId] of [
    ['model@2', 'model.primitive'], ['sprite@2', 'texture.card'],
    ['surface@2', 'surface.water'], ['particle@2', 'particle.smoke'],
    ['scene-pass@2', 'pass.background'],
  ]) {
    const invalidHarness = fakeHarness();
    const invalid = invalidHarness.runtime();
    assert.throws(
      () => invalid.install({
        view,
        snapshot: pipelineId === 'scene-pass@2'
          ? renderSnapshot(view, [], [layer(pipelineId, resourceId, { unknown: true })])
          : renderSnapshot(view, [composition(1n, 1, [
            layer(pipelineId, resourceId, { unknown: true }),
          ])]),
      }),
      (error) => error.code === 'render-pipeline-param-unknown',
    );
    invalid.dispose();
  }
});

test('requested RAF draws once, interaction ports stay plain, and disposal is idempotent', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const view = sceneView([node(1)]);
  runtime.install({
    view,
    snapshot: renderSnapshot(view, [composition(1n, 1, [
      layer('model@2', 'model.primitive', {}, { pickable: true }),
    ])]),
  });
  await runtime.whenIdle();
  runtime.start();
  runtime.requestDraw();
  assert.equal(runtime.capture().rafCount, 1);
  assert.equal(harness.stats.rafCallbacks.size, 1, 'sole RAF owner has one request');
  harness.flushRaf(1_000);
  assert.equal(runtime.capture().drawCount, 1);
  assert.equal(runtime.capture().lastFrameCpuTimeMs, 0);
  assert.deepEqual(runtime.capture().rendererInfo, {
    calls: 1,
    frame: 1,
    geometries: 0,
    lines: 0,
    points: 50,
    textures: 1,
    triangles: 450,
  });
  assert.equal(runtime.capture().rafCount, 0);
  assert.deepEqual(runtime.focusWorldPoint({ position: [1, 2, 3], radius: 4 }), { ok: true });
  assert.deepEqual(runtime.projectWorldPoint({ position: [1, 2, 3] }), {
    ok: true, clientX: 51, clientY: 42, visible: true, depth: 0.5,
  });
  assert.deepEqual(runtime.pick({ clientX: 10, clientY: 20 }), {
    hit: true, displayId: 1n, layerKey: 'layer', worldPosition: [0, 0, 0],
  });
  runtime.stop();
  runtime.dispose();
  runtime.dispose();
  assert.equal(harness.stats.observerDisconnects, 1);
  assert.equal(harness.stats.rendererDisposes, 1);
  assert.equal(harness.stats.rafCallbacks.size, 0);
  assert.throws(() => runtime.capture(), (error) => error.code === 'render-runtime-disposed');
});

test('a framed tick requests simulation sampling while RAF never advances the cursor', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const firstView = sceneView([node(1)], 1, 1, 10);
  runtime.install({
    view: firstView,
    snapshot: renderSnapshot(firstView, [composition(1n, 1, [
      layer('model@2', 'model.slow', {}, {
        animation: {
          stateId: 1, clipId: 'idle', startTick: 5n, flags: 0, clock: 'simulation',
        },
      }),
    ])]),
  });
  await runtime.whenIdle();
  runtime.start();
  harness.flushRaf(1_000);
  assert.deepEqual(harness.stats.samples.at(-1), { pipelineId: 'model@2', seconds: 5 / 60, tick: 10 });

  const nextView = sceneView([node(1)], 1, 2, 11);
  runtime.apply({
    plan: framePlan(2, { sourceTick: 11 }),
    view: nextView,
    batch: renderBatch(1, 2, 11),
  });
  assert.equal(runtime.capture().rafCount, 1);
  harness.flushRaf(9_999);
  assert.deepEqual(harness.stats.samples.at(-1), { pipelineId: 'model@2', seconds: 6 / 60, tick: 11 });
  assert.equal(runtime.capture().sourceTick, 11, 'wall time and RAF did not rewrite Engine time');
  runtime.dispose();
});

test('instance batches separate pickability and exclude hidden parent subtrees from draw and pick', async () => {
  const harness = fakeHarness();
  const runtime = harness.runtime();
  const initialNodes = [node(1), node(2, { parentDisplayId: 1n })];
  const initialView = sceneView(initialNodes);
  runtime.install({
    view: initialView,
    snapshot: renderSnapshot(initialView, [
      composition(1n, 1, [layer('model@2', 'model.primitive', { instance: true }, {
        batchKey: 'shared', pickable: false,
      })]),
      composition(2n, 1, [layer('model@2', 'model.primitive', { instance: true }, {
        batchKey: 'shared', pickable: true,
      })]),
    ]),
  });
  await runtime.whenIdle();
  assert.equal(runtime.capture().batchCount, 2, 'pickability partitions batch identity');
  assert.deepEqual(runtime.pick({ clientX: 1, clientY: 1 }), {
    hit: true, displayId: 2n, layerKey: 'layer', worldPosition: [0, 0, 0],
  });
  assert.equal(harness.stats.lastPickableCount, 1, 'non-pickable batch was not raycast');

  const hiddenNodes = [node(1, { flags: 0 }), node(2, { parentDisplayId: 1n })];
  runtime.apply({
    plan: framePlan(2, { visibilityDirtyIds: [1n] }),
    view: sceneView(hiddenNodes, 1, 2, 2),
    batch: renderBatch(1, 2, 2),
  });
  assert.equal(harness.stats.groups.find((item) => item.name === 'SceneAnchor:1').visible, false);
  assert.deepEqual(harness.stats.instanceBatches.map((batch) => batch.members.length), [0, 0]);
  assert.deepEqual(runtime.pick({ clientX: 1, clientY: 1 }), { hit: false });
  runtime.dispose();
});

test('effective tint alpha disables instancing and pickability changes the batch key', async () => {
  const opaque = layer('model@2', 'model.primitive', { instance: true }, {
    batchKey: 'same', pickable: false,
  });
  const pickable = { ...opaque, pickable: true };
  const translucent = {
    ...opaque,
    material: material({ tintRgba: 0xffffff80 }),
  };
  assert.notEqual(batchFingerprint(opaque), batchFingerprint(pickable));
  assert.equal(batchFingerprint(translucent), null);

  const harness = fakeHarness();
  const runtime = harness.runtime();
  const nodes = [node(1), node(2)];
  const view = sceneView(nodes);
  runtime.install({
    view,
    snapshot: renderSnapshot(view, [
      composition(1n, 1, [opaque]),
      composition(2n, 1, [translucent]),
    ]),
  });
  await runtime.whenIdle();
  assert.equal(harness.stats.instanceBatches.length, 1);
  assert.equal(runtime.capture().batchCount, 2, 'one real batch plus one transparent draw');
  runtime.dispose();
});

test('deterministic mixed 500-node fixture preserves ordered lifecycle and leak baselines', async () => {
  const cardLoad = deferred();
  const harness = fakeHarness({ deferredUrls: new Map([['/card.png', cardLoad.promise]]) });
  const runtime = harness.runtime();
  const fixture = mixedAcceptanceFixture();
  const initialView = sceneView(fixture.initialNodes);
  runtime.install({
    view: initialView,
    snapshot: renderSnapshot(
      initialView,
      fixture.initialNodes.map((item) => mixedComposition(item.displayId, 1)),
      fixture.sceneLayers,
    ),
  });

  assert.equal(harness.stats.renderersCreated, 1, 'the fixture owns one Runtime renderer');
  assert.equal(harness.stats.scenesCreated, 1, 'the fixture owns one scene');
  assert.equal(harness.stats.camerasCreated, 1, 'the fixture owns one camera');
  assert.equal(
    runtime.capture().pendingJobCount,
    502,
    'all node and scene bindings wait behind the deterministic shared-resource cache miss',
  );
  cardLoad.resolve({ kind: 'texture', marker: 'shared-card' });
  await runtime.whenIdle();

  const initial = runtime.capture();
  assert.deepEqual(fixture.categoryCounts, {
    particle: 50,
    sprite: 200,
    terrain: 100,
    model: 150,
  });
  assert.deepEqual({
    nodeCount: initial.nodeCount,
    layerCount: initial.layerCount,
    sceneLayerCount: initial.sceneLayerCount,
    batchCount: initial.batchCount,
    resourceCount: initial.resourceCount,
    pendingJobCount: initial.pendingJobCount,
  }, {
    nodeCount: 500,
    layerCount: 502,
    sceneLayerCount: 2,
    batchCount: 55,
    resourceCount: 5,
    pendingJobCount: 0,
  });
  assert.equal(Object.hasOwn(initial, 'renderTargetPassCount'), false,
    'surface@2 never reports an offscreen render-target pass');
  assert.deepEqual(
    activeInstanceBatchSizes(harness),
    [100, 150, 200],
    'terrain, model, and sprite members each share one structural instance batch',
  );
  assert.deepEqual(Object.fromEntries(harness.stats.resourceCreates), {
    texture: 1,
    'primitive-model': 1,
    surface: 1,
    particle: 1,
    'scene-pass': 1,
  }, 'hundreds of shared references load each resource kind once');

  runtime.start();
  assert.equal(runtime.capture().rafCount, 1);
  harness.flushRaf(1_000);
  assert.equal(runtime.capture().drawCount, 1);
  assert.equal(runtime.capture().rafCount, 1, 'the visual-clock surface keeps one RAF queued');
  assert.equal(harness.stats.maximumRafCallbacks, 1, 'there is never a per-node RAF');

  const poseDirtyIds = fixture.stepOneNodes.slice(0, 50).map((item) => item.displayId);
  const compositionDirtyIds = fixture.stepOneNodes.slice(0, 25).map((item) => item.displayId);
  assert.equal(poseDirtyIds.length / fixture.initialNodes.length, 0.10);
  assert.equal(compositionDirtyIds.length / fixture.initialNodes.length, 0.05);
  const stepOneView = sceneView(fixture.stepOneNodes, 1, 2, 2);
  const stepTwoView = sceneView(fixture.stepTwoNodes, 1, 3, 3);
  const stepThreeView = sceneView(fixture.finalNodes, 1, 4, 4);
  const matrixUpdatesBeforeBatch = harness.stats.matrixUpdates;
  const orderedSteps = [
    {
      plan: framePlan(2, {
        createIds: [501n],
        localPoseDirtyIds: poseDirtyIds,
        profileStateDirtyIds: compositionDirtyIds,
        removeIds: [500n],
        reparentIds: [250n],
        visualReplaceIds: compositionDirtyIds,
      }),
      view: stepOneView,
      batch: renderBatch(1, 2, 2, {
        changed: [
          ...compositionDirtyIds.map((identity) => mixedComposition(identity, 2, true)),
          mixedComposition(501n, 1),
        ],
        removedDisplayIds: [500n],
        sceneLayers: fixture.sceneLayers,
      }),
    },
    {
      plan: framePlan(3, {
        createIds: [502n],
        localPoseDirtyIds: poseDirtyIds,
        profileStateDirtyIds: compositionDirtyIds,
        removeIds: [501n],
        reparentIds: [250n],
        visualReplaceIds: compositionDirtyIds,
      }),
      view: stepTwoView,
      batch: renderBatch(1, 3, 3, {
        changed: [
          ...compositionDirtyIds.map((identity) => mixedComposition(identity, 3, false)),
          mixedComposition(502n, 1),
        ],
        removedDisplayIds: [501n],
        sceneLayers: fixture.sceneLayers,
      }),
    },
    {
      plan: framePlan(4, {
        createIds: [500n],
        localPoseDirtyIds: poseDirtyIds,
        profileStateDirtyIds: compositionDirtyIds,
        removeIds: [502n],
        reparentIds: [250n],
        visualReplaceIds: compositionDirtyIds,
      }),
      view: stepThreeView,
      batch: renderBatch(1, 4, 4, {
        changed: [
          ...compositionDirtyIds.map((identity) => mixedComposition(identity, 4, true)),
          mixedComposition(500n, 1),
        ],
        removedDisplayIds: [502n],
        sceneLayers: fixture.sceneLayers,
      }),
    },
  ];
  for (const step of orderedSteps) {
    assert.equal(step.plan.localPoseDirtyIds.length, 50, 'every commit dirties 10% of poses');
    assert.equal(
      step.plan.profileStateDirtyIds.length,
      25,
      'every commit recomposes 5% of business visuals',
    );
  }
  runtime.applyBatch(orderedSteps);
  assert.equal(
    harness.stats.matrixUpdates - matrixUpdatesBeforeBatch,
    1,
    'applyBatch emits one synchronous matrix barrier for three ordered commits',
  );
  await runtime.whenIdle();

  const final = runtime.capture();
  assert.deepEqual({
    generation: final.generation,
    commitSeq: final.commitSeq,
    sourceTick: final.sourceTick,
    nodeCount: final.nodeCount,
    layerCount: final.layerCount,
    sceneLayerCount: final.sceneLayerCount,
    batchCount: final.batchCount,
    resourceCount: final.resourceCount,
    pendingJobCount: final.pendingJobCount,
    drawCount: final.drawCount,
    listenerCount: final.listenerCount,
    observerCount: final.observerCount,
    rafCount: final.rafCount,
  }, {
    generation: 1,
    commitSeq: 4,
    sourceTick: 4,
    nodeCount: 500,
    layerCount: 502,
    sceneLayerCount: 2,
    batchCount: 56,
    resourceCount: 5,
    pendingJobCount: 0,
    drawCount: 1,
    listenerCount: 1,
    observerCount: 1,
    rafCount: 1,
  });
  assert.deepEqual(activeInstanceBatchSizes(harness), [25, 100, 150, 175]);
  assert.deepEqual(Object.fromEntries(harness.stats.resourceCreates), {
    texture: 1,
    'primitive-model': 1,
    surface: 1,
    particle: 1,
    'scene-pass': 1,
  }, 'dirty composition and lifecycle churn reuse all five resources');
  assert.equal(
    harness.stats.pipelineDisposeKeys.includes('acceptance.background'),
    false,
    'the complete scene layer survives every ordered commit',
  );

  const transientAnchors = harness.stats.groups
    .filter((item) => ['SceneAnchor:501', 'SceneAnchor:502'].includes(item.name))
    .map((item) => item.name);
  assert.deepEqual(transientAnchors, ['SceneAnchor:501', 'SceneAnchor:502'],
    'applyBatch did not skip transient create/remove lifecycles');
  assert.equal(
    harness.stats.groups.filter((item) => item.name === 'SceneAnchor:500').length,
    2,
    'the removed identity was recreated instead of latest-only retention',
  );
  assert.deepEqual(
    harness.stats.parentEvents
      .filter((event) => event.child === 'SceneAnchor:250')
      .slice(-3)
      .map((event) => event.parent),
    ['SceneAnchor:201', 'SceneEngineRenderRoot', 'SceneAnchor:201'],
    'all intermediate reparent operations ran in order',
  );

  harness.flushRaf(1_016.67);
  assert.equal(runtime.capture().drawCount, 2, 'one RAF callback produced one final scene draw');
  assert.equal(harness.stats.sceneDraws, 2);
  assert.equal(harness.stats.maximumRafCallbacks, 1);
  runtime.stop();
  runtime.stop();
  assert.equal(runtime.capture().rafCount, 0);
  runtime.dispose();
  runtime.dispose();

  assert.equal(harness.stats.activeListeners, 0);
  assert.equal(harness.stats.activeObservers, 0);
  assert.equal(harness.stats.rafCallbacks.size, 0);
  assert.equal(harness.stats.liveResources.size, 0);
  assert.equal(harness.stats.livePipelineHandles.size, 0);
  assert.equal(harness.stats.rendererDisposes, 1);
  assert.equal(harness.stats.observerDisconnects, 1);
  assert.ok(harness.stats.hosts.every((host) => host.listeners.size === 0));
});

function publicOptions() {
  return {
    hostElement: fakeHost(),
    canvas: { getContext() { return {}; } },
    cameraProfile: {
      projection: 'perspective',
      position: [10, 10, 10],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 60,
      near: 0.1,
      far: 10_000,
      minDistance: 1,
      maxDistance: 1_000,
      controls: {
        mode: 'pan-zoom',
        dampingFactor: 0.08,
        panSpeed: 1,
        zoomSpeed: 1,
        panBounds: { minX: -100, maxX: 100, minZ: -80, maxZ: 80 },
      },
    },
    rendererProfile: {
      drawMode: 'requested',
      maximumPixelRatio: 2,
      clearRgba: 0x000000ff,
      antialias: true,
      alpha: false,
      shadows: true,
      toneMapping: 'aces-filmic',
    },
    resourceCatalog: catalog(),
  };
}

function catalog() {
  return {
    schema: 'scene-engine-render-resource-catalog@2',
    resources: {
      'model.primitive': {
        kind: 'primitive-model',
        parts: [{
          shape: 'box', dimensions: [1, 1, 1],
          transform: transform(), material: sourceMaterial(),
        }],
      },
      'model.slow': { kind: 'model-url', url: '/slow.glb', clipNames: ['idle'] },
      'texture.card': { kind: 'texture', url: '/card.png', colorSpace: 'srgb', wrap: 'clamp' },
      'texture.atlas': {
        kind: 'texture-atlas', url: '/atlas.png', columns: 4, rows: 4,
        colorSpace: 'srgb', wrap: 'repeat',
      },
      'surface.water': {
        kind: 'surface', family: 'surface.water',
        geometry: { primitive: 'plane', width: 10, height: 10, segmentsX: 2, segmentsY: 2 },
        textureResourceIds: ['texture.card'],
        defaults: { amplitude: 0.1, speed: 0.25, foam: 0.05, textureScale: 1 },
      },
      'particle.smoke': {
        kind: 'particle', textureResourceId: 'texture.card', maximumCapacity: 128,
      },
      'pass.background': {
        kind: 'scene-pass', passKind: 'background', defaults: { colorRgba: 0x14213dff },
      },
      'pass.lights': {
        kind: 'scene-pass', passKind: 'lights',
        defaults: { colorRgba: 0xffffffff, intensity: 1, direction: [1, 2, 3] },
      },
    },
  };
}

function node(identity, overrides = {}) {
  return Object.freeze({
    displayId: BigInt(identity),
    parentDisplayId: overrides.parentDisplayId ?? 0n,
    localPosition: Object.freeze(overrides.localPosition ?? [Number(identity), 0, 0]),
    localRotationXyzw: Object.freeze([0, 0, 0, 1]),
    localScale: Object.freeze([1, 1, 1]),
    flags: overrides.flags ?? 1,
  });
}

function sceneView(nodes, generation = 1, commitSeq = 1, sourceTick = 1) {
  const byId = new Map(nodes.map((item) => [item.displayId, item]));
  return Object.freeze({
    generation, commitSeq, sourceTick, nodeCount: nodes.length,
    nodeAt(index) { return nodes[index] ?? null; },
    getNode(identity) { return byId.get(identity) ?? null; },
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

function renderSnapshot(view, compositions, sceneLayers = []) {
  return {
    schema: RENDER_SNAPSHOT_SCHEMA,
    generation: view.generation,
    commitSeq: view.commitSeq,
    sourceTick: view.sourceTick,
    compositions,
    sceneLayers,
  };
}

function renderBatch(generation, commitSeq, sourceTick, overrides = {}) {
  return {
    schema: RENDER_BATCH_SCHEMA,
    generation,
    commitSeq,
    sourceTick,
    changed: [],
    removedDisplayIds: [],
    sceneLayers: null,
    ...overrides,
  };
}

function framePlan(commitSeq, overrides = {}) {
  return {
    kind: 'frame', generation: 1, commitSeq, sourceTick: commitSeq,
    animationDirtyIds: [], createIds: [], interactionDirtyIds: [],
    localPoseDirtyIds: [], profileStateDirtyIds: [], removeIds: [], reparentIds: [],
    visibilityDirtyIds: [], visualReplaceIds: [],
    ...overrides,
  };
}

function layer(pipelineId, resourceId, params, overrides = {}) {
  return {
    key: 'layer', pipelineId, resourceId,
    transform: transform(),
    material: material({ alphaMode: pipelineId === 'particle@2' ? 'blend' : 'opaque' }),
    animation: pipelineId === 'particle@2' ? animation() : null,
    params, batchKey: null, pickable: false, renderOrder: 0,
    ...overrides,
  };
}

function transform(overrides = {}) {
  return {
    position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1],
    ...overrides,
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

function sourceMaterial(overrides = {}) {
  return { tintRgba: 0xffffffff, opacity: 1, emissive: 0, ...overrides };
}

function animation(overrides = {}) {
  return {
    stateId: 1,
    clipId: 'active',
    startTick: 0n,
    flags: 0,
    clock: 'simulation',
    ...overrides,
  };
}

function mixedAcceptanceFixture() {
  const initialNodes = mixedNodes({ particleId: 500, poseRevision: 0, parent250: 0n });
  const stepOneNodes = mixedNodes({ particleId: 501, poseRevision: 1, parent250: 201n });
  const stepTwoNodes = mixedNodes({ particleId: 502, poseRevision: 2, parent250: 0n });
  const finalNodes = mixedNodes({ particleId: 500, poseRevision: 3, parent250: 201n });
  const categoryCounts = { particle: 0, sprite: 0, terrain: 0, model: 0 };
  for (const item of initialNodes) categoryCounts[mixedCategory(item.displayId)] += 1;
  return Object.freeze({
    categoryCounts: Object.freeze(categoryCounts),
    finalNodes,
    initialNodes,
    sceneLayers: Object.freeze([
      Object.freeze(layer('scene-pass@2', 'pass.background', {
        passKind: 'background', colorRgba: 0x14213dff,
      }, { key: 'acceptance.background', renderOrder: -1000 })),
      Object.freeze(layer('surface@2', 'surface.water', {
        amplitude: 0.1, speed: 0.25, foam: 0.05, textureScale: 1,
      }, { key: 'acceptance.water', renderOrder: -900 })),
    ]),
    stepOneNodes,
    stepTwoNodes,
  });
}

function mixedNodes({ particleId, poseRevision, parent250 }) {
  const identities = [
    ...Array.from({ length: 499 }, (_, index) => index + 1),
    particleId,
  ];
  return Object.freeze(identities.map((identity) => node(identity, {
    parentDisplayId: identity === 250 ? parent250 : 0n,
    localPosition: identity <= 50 && poseRevision > 0
      ? [identity, poseRevision, identity % 7]
      : [identity, 0, 0],
  })));
}

function mixedCategory(identity) {
  const numeric = Number(identity);
  if (numeric <= 200) return 'sprite';
  if (numeric <= 350) return 'model';
  if (numeric <= 450) return 'terrain';
  return 'particle';
}

function mixedComposition(identity, renderRevision, profileDirty = false) {
  const category = mixedCategory(identity);
  let visual;
  if (category === 'sprite') {
    visual = layer('sprite@2', 'texture.card', {
      orientation: 'fixed', width: 1.5, height: 2,
    }, {
      key: 'card',
      batchKey: 'acceptance.cards',
      material: material({ tintRgba: profileDirty ? 0x6ec1ffff : 0xffffffff }),
    });
  } else if (category === 'model') {
    visual = layer('model@2', 'model.primitive', {
      castShadow: true, receiveShadow: true, instance: true,
    }, { key: 'model', batchKey: 'acceptance.models' });
  } else if (category === 'terrain') {
    visual = layer('model@2', 'model.primitive', {
      castShadow: false, receiveShadow: true, instance: true,
    }, { key: 'terrain', batchKey: 'acceptance.terrain' });
  } else {
    visual = layer('particle@2', 'particle.smoke', {
      durationTicks: 90,
      capacity: 32,
      seed: Number(identity),
      rate: 4,
      size: 0.5,
      velocity: [0, 1, 0],
      spread: [0.25, 0.25, 0.25],
      gravity: [0, -0.5, 0],
      blendMode: 'normal',
    }, { key: 'effect' });
  }
  return composition(identity, renderRevision, [visual]);
}

function activeInstanceBatchSizes(harness) {
  return harness.stats.instanceBatches
    .filter((handle) => !handle.disposed)
    .map((handle) => handle.members.length)
    .sort((left, right) => left - right);
}

function fakeHost() {
  return {
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 80 }; },
  };
}

function fakeHarness({ deferredUrls = new Map(), pipelineFailure = null } = {}) {
  const stats = {
    activeListeners: 0,
    activeObservers: 0,
    cameraProfiles: [],
    camerasCreated: 0,
    controlProfiles: [],
    disposedAssets: [],
    groups: [],
    hosts: [],
    instanceBatches: [],
    lastPickableCount: 0,
    livePipelineHandles: new Set(),
    liveResources: new Set(),
    matrixUpdates: 0,
    maximumRafCallbacks: 0,
    observerDisconnects: 0,
    parentEvents: [],
    pipelineCreates: 0,
    pipelineDisposeKeys: [],
    pipelineDisposes: 0,
    pipelineIds: [],
    rafCallbacks: new Map(),
    rendererDisposes: 0,
    renderersCreated: 0,
    resourceCreates: new Map(),
    samples: [],
    scenePassStates: [],
    sceneDraws: 0,
    scenesCreated: 0,
  };
  let nextRaf = 1;
  const adapter = {
    isHostElement(value) { return typeof value?.getBoundingClientRect === 'function'; },
    isCanvas(value) { return typeof value?.getContext === 'function'; },
    createRenderer() { stats.renderersCreated += 1; return {}; },
    createScene() { stats.scenesCreated += 1; return new FakeGroup(stats); },
    createGroup() { return new FakeGroup(stats); },
    createCamera(profile) {
      stats.camerasCreated += 1;
      stats.cameraProfiles.push(profile);
      return {};
    },
    createControls(camera, element, profile, onChange) {
      stats.controlProfiles.push(profile);
      const listener = () => onChange();
      let disposed = false;
      element.addEventListener('pointerdown', listener);
      stats.activeListeners += 1;
      return {
        focus() { onChange(); },
        update() { return false; },
        dispose() {
          if (disposed) return;
          disposed = true;
          element.removeEventListener('pointerdown', listener);
          stats.activeListeners -= 1;
        },
      };
    },
    createDefaultLights() { return new FakeGroup(stats); },
    createResizeObserver(callback) {
      let active = false;
      return {
        observe() {
          if (active) return;
          active = true;
          stats.activeObservers += 1;
        },
        disconnect() {
          if (!active) return;
          active = false;
          stats.activeObservers -= 1;
          stats.observerDisconnects += 1;
        },
      };
    },
    requestAnimationFrame(callback) {
      const identity = nextRaf;
      nextRaf += 1;
      stats.rafCallbacks.set(identity, callback);
      stats.maximumRafCallbacks = Math.max(
        stats.maximumRafCallbacks,
        stats.rafCallbacks.size,
      );
      return identity;
    },
    cancelAnimationFrame(identity) { stats.rafCallbacks.delete(identity); },
    now() { return 0; },
    devicePixelRatio() { return 1; },
    setViewport() {},
    render() { stats.sceneDraws += 1; },
    captureRendererInfo() {
      return Object.freeze({
        calls: stats.sceneDraws,
        frame: stats.sceneDraws,
        geometries: 0,
        lines: 0,
        points: 50,
        textures: 1,
        triangles: 450,
      });
    },
    updateMatrices() { stats.matrixUpdates += 1; },
    setTransform(object, value) { object.transform = structuredClone(value); },
    setNodePose(object, value) { object.nodePose = structuredClone(value); },
    async createResource(descriptor, signal, dependencies) {
      stats.resourceCreates.set(
        descriptor.kind,
        (stats.resourceCreates.get(descriptor.kind) ?? 0) + 1,
      );
      const asset = descriptor.url && deferredUrls.has(descriptor.url)
        ? await deferredUrls.get(descriptor.url)
        : { kind: descriptor.kind, descriptor, dependencies };
      stats.liveResources.add(asset);
      return asset;
    },
    disposeResource(asset) {
      asset.disposed = true;
      stats.liveResources.delete(asset);
      stats.disposedAssets.push(asset);
    },
    createInstanceBatch(pipelineId, asset, visualLayer) {
      stats.pipelineCreates += 1;
      stats.pipelineIds.push(pipelineId);
      const handle = {
        disposed: false,
        object: new FakeGroup(stats),
        members: [],
        update(members) { this.members = members; },
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          stats.pipelineDisposes += 1;
          stats.pipelineDisposeKeys.push(visualLayer.key);
          stats.livePipelineHandles.delete(this);
          this.object.removeFromParent();
        },
      };
      stats.instanceBatches.push(handle);
      stats.livePipelineHandles.add(handle);
      return handle;
    },
    createPipelineObject(pipelineId, asset, visualLayer) {
      if (pipelineFailure) throw pipelineFailure;
      stats.pipelineCreates += 1;
      stats.pipelineIds.push(pipelineId);
      const object = new FakeGroup(stats);
      const handle = {
        disposed: false,
        object,
        sample(seconds, tick) { stats.samples.push({ pipelineId, seconds, tick }); },
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          stats.pipelineDisposes += 1;
          stats.pipelineDisposeKeys.push(visualLayer.key);
          stats.livePipelineHandles.delete(this);
          object.removeFromParent();
        },
      };
      stats.livePipelineHandles.add(handle);
      return handle;
    },
    replaceScenePassState(renderer, scene, entries) {
      stats.scenePassStates.push(entries.map(({ key, descriptor, layer: entryLayer }) => ({
        key,
        passKind: descriptor.passKind,
        colorRgba: entryLayer.params.colorRgba ?? descriptor.defaults.colorRgba,
      })));
    },
    markPickIdentity(object, identity) { object.pickIdentity = identity; },
    project() {
      return { ok: true, clientX: 51, clientY: 42, visible: true, depth: 0.5 };
    },
    pick(camera, host, clientX, clientY, pickables) {
      stats.lastPickableCount = pickables.length;
      if (pickables.length === 0) return { hit: false };
      const identity = pickables[0].batchMembers?.[0] ?? pickables[0];
      return {
        hit: true,
        displayId: identity.displayId,
        layerKey: identity.layerKey,
        worldPosition: [0, 0, 0],
      };
    },
    disposeObject(object) { object.removeFromParent?.(); },
    disposeRenderer() { stats.rendererDisposes += 1; },
  };
  return {
    adapter,
    stats,
    runtime(overrides = {}) {
      const options = publicOptions();
      stats.hosts.push(options.hostElement);
      return createThreeRenderRuntimeForTest({ ...options, ...overrides }, adapter);
    },
    flushRaf(timestamp) {
      const entries = [...stats.rafCallbacks.entries()];
      stats.rafCallbacks.clear();
      for (const [, callback] of entries) callback(timestamp);
    },
  };
}

class FakeGroup {
  constructor(stats) {
    this.stats = stats;
    this.children = [];
    this.name = '';
    this.parent = null;
    this.visible = true;
    stats.groups.push(this);
  }

  add(...values) {
    for (const value of values) {
      value.removeFromParent?.();
      this.children.push(value);
      value.parent = this;
      if (value.name) this.stats.parentEvents.push({ child: value.name, parent: this.name });
    }
  }

  remove(value) {
    const index = this.children.indexOf(value);
    if (index >= 0) this.children.splice(index, 1);
    if (value.parent === this) value.parent = null;
  }

  removeFromParent() { this.parent?.remove(this); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
