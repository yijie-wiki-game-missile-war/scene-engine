import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { Matrix4, REVISION, Texture } from 'three';

import {
  RENDER_BATCH_SCHEMA,
  RENDER_COMPOSITION_SCHEMA,
  RENDER_RESOURCE_CATALOG_SCHEMA,
  RENDER_SNAPSHOT_SCHEMA,
} from '../src/constants.js';
import { createThreeRenderRuntimeForTest } from '../src/testing.js';
import { DEFAULT_THREE_ADAPTER } from '../src/three-adapter.js';

const require = createRequire(import.meta.url);
const THREE_PACKAGE = JSON.parse(readFileSync(
  new URL('../package.json', new URL(`file://${require.resolve('three')}`)),
  'utf8',
));

const INITIAL_GENERATION = 1;
const INITIAL_COMMIT_SEQ = 1;
const INITIAL_SOURCE_TICK = 1;
const NODE_COUNT = 500;
// The scene graph, materials, geometry, particles, surfaces, and instance slots
// below are real Three 0.181.2 objects. Node has no browser WebGL context, so
// the renderer/host/RAF are instrumented and this test claims no GPU metrics.
const POSE_DIRTY_IDS = Object.freeze([
  ...range(1, 25),
  ...range(201, 225),
].map(BigInt));
const MATERIAL_UI_DIRTY_IDS = Object.freeze(range(1, 25).map(BigInt));
const SCENE_LAYERS = Object.freeze([
  sceneLayer('surface@2', 'surface.water', 'acceptance.water', {
    amplitude: 0.2,
    speed: 0.5,
    foam: 0.1,
    textureScale: 2,
  }),
  sceneLayer('scene-pass@2', 'pass.background', 'acceptance.background', {
    passKind: 'background',
    colorRgba: 0x14213dff,
  }),
]);

test('real three@0.181.2 V2 500-node semantics, recovery, and 100-round stability', async () => {
  assert.equal(THREE_PACKAGE.version, '0.181.2');
  assert.equal(REVISION, '181');

  const healthEvents = [];
  const harness = realThreeAcceptanceHarness();
  const runtime = harness.runtime({ onHealth: (event) => healthEvents.push(event) });
  let cursor = {
    generation: INITIAL_GENERATION,
    commitSeq: INITIAL_COMMIT_SEQ,
    sourceTick: INITIAL_SOURCE_TICK,
  };
  let nodes = acceptanceNodes({ particleId: 500, poseEpoch: 0, parent250: 0n });
  let view = sceneView(nodes, cursor);

  runtime.install({
    view,
    snapshot: renderSnapshot(view, nodes.map((item) => acceptanceComposition(
      item.displayId,
      1,
      false,
    ))),
  });
  await runtime.whenIdle();

  assert.deepEqual(categoryCounts(nodes), {
    sprite: 200,
    model: 150,
    terrain: 100,
    particle: 50,
  });
  assert.equal(POSE_DIRTY_IDS.length, NODE_COUNT * 0.10);
  assert.equal(MATERIAL_UI_DIRTY_IDS.length, NODE_COUNT * 0.05);
  assert.ok(POSE_DIRTY_IDS.some((identity) => category(identity) === 'sprite'));
  assert.ok(POSE_DIRTY_IDS.some((identity) => category(identity) === 'model'));
  assert.deepEqual(harness.ownerCounts(), {
    runtimes: 1,
    renderers: 1,
    scenes: 1,
    cameras: 1,
  });
  assertRuntimeShape(runtime.capture(), {
    generation: 1,
    commitSeq: 1,
    sourceTick: 1,
    nodeCount: 500,
    layerCount: 502,
    sceneLayerCount: 2,
    resourceCount: 5,
    pendingJobCount: 0,
  });
  assert.deepEqual(harness.resourceCreateCounts(), {
    texture: 1,
    'primitive-model': 1,
    surface: 1,
    particle: 1,
    'scene-pass': 1,
  });
  assert.equal(harness.liveResourceCount, 5);
  assert.equal(harness.disposedResourceCount, 0);

  const matricesBefore = new Map([
    ...POSE_DIRTY_IDS,
    26n,
    226n,
  ].map((identity) => [identity, harness.slotMatrix(identity)]));
  const createCountsBeforeOrderedCommits = harness.resourceCreateCounts();

  const ordered = [
    { particleId: 501, removeId: 500n, parent250: 1n, poseEpoch: 1, selected: true },
    { particleId: 502, removeId: 501n, parent250: 2n, poseEpoch: 2, selected: false },
    { particleId: 500, removeId: 502n, parent250: 1n, poseEpoch: 3, selected: true },
  ].map((state, index) => {
    const nextCursor = {
      generation: 1,
      commitSeq: index + 2,
      sourceTick: index + 2,
    };
    const nextNodes = acceptanceNodes(state);
    const nextView = sceneView(nextNodes, nextCursor);
    const createId = BigInt(state.particleId);
    return {
      nodes: nextNodes,
      cursor: nextCursor,
      step: {
        plan: framePlan(nextCursor, {
          createIds: [createId],
          localPoseDirtyIds: POSE_DIRTY_IDS,
          profileStateDirtyIds: MATERIAL_UI_DIRTY_IDS,
          removeIds: [state.removeId],
          reparentIds: [250n],
          visualReplaceIds: MATERIAL_UI_DIRTY_IDS,
        }),
        view: nextView,
        batch: renderBatch(nextCursor, {
          changed: [
            ...MATERIAL_UI_DIRTY_IDS.map((identity) => acceptanceComposition(
              identity,
              index + 2,
              state.selected,
            )),
            acceptanceComposition(createId, 1, false),
          ],
          removedDisplayIds: [state.removeId],
        }),
      },
    };
  });

  const matrixBarriersBefore = harness.matrixBarriers;
  runtime.applyBatch(ordered.map(({ step }) => step));
  assert.equal(harness.matrixBarriers, matrixBarriersBefore + 1);
  await runtime.whenIdle();
  assert.equal(
    harness.matrixBarriers,
    matrixBarriersBefore + 2,
    'one ordered barrier plus one async transient-binding attachment barrier',
  );
  ({ cursor, nodes } = ordered.at(-1));
  view = sceneView(nodes, cursor);

  for (const identity of POSE_DIRTY_IDS) {
    const before = matricesBefore.get(identity);
    const after = harness.slotMatrix(identity);
    const expectedNode = view.getNode(identity);
    assert.notDeepEqual(after.elements, before.elements, `dirty slot ${identity} moved`);
    assert.equal(after.elements[12], expectedNode.localPosition[0], `slot ${identity} x`);
    assert.equal(after.elements[13], expectedNode.localPosition[1], `slot ${identity} y`);
    assert.equal(after.elements[14], expectedNode.localPosition[2], `slot ${identity} z`);
  }
  assert.deepEqual(harness.slotMatrix(26n).elements, matricesBefore.get(26n).elements);
  assert.deepEqual(harness.slotMatrix(226n).elements, matricesBefore.get(226n).elements);
  assert.deepEqual(harness.resourceCreateCounts(), createCountsBeforeOrderedCommits);
  assert.equal(runtime.capture().pendingJobCount, 0);
  assert.equal(harness.anchorCreationCount(501n), 1);
  assert.equal(harness.anchorCreationCount(502n), 1);
  assert.equal(harness.anchorCreationCount(500n), 2);
  assert.deepEqual(harness.parentHistory(250n).slice(-3), [1n, 2n, 1n]);

  runtime.start();
  assert.equal(runtime.capture().rafCount, 1);
  assert.equal(harness.maximumRafCount, 1);
  harness.flushRaf(1_000);
  assert.equal(runtime.capture().drawCount, 1);
  assert.equal(runtime.capture().rafCount, 1, 'water keeps the sole visual RAF');

  const noFrameCursor = { generation: 1, commitSeq: 5, sourceTick: 5 };
  view = sceneView(nodes, noFrameCursor);
  runtime.apply({
    plan: null,
    view,
    batch: renderBatch(noFrameCursor),
  });
  assert.equal(runtime.capture().sourceTick, 5, 'null-frame commit advances sourceTick');
  const createsBeforeLocalUi = harness.resourceCreateCounts();
  runtime.apply({
    plan: null,
    view,
    batch: renderBatch(noFrameCursor, {
      changed: MATERIAL_UI_DIRTY_IDS.map((identity) => acceptanceComposition(
        identity,
        5,
        false,
      )),
    }),
  });
  await runtime.whenIdle();
  assert.deepEqual(harness.resourceCreateCounts(), createsBeforeLocalUi);
  assert.equal(runtime.capture().pendingJobCount, 0);
  cursor = noFrameCursor;

  harness.failNextDraw();
  assert.doesNotThrow(() => harness.flushRaf(1_016.67));
  assert.equal(runtime.capture().healthFailure.code, 'render-draw-failed');
  assert.equal(runtime.capture().rafCount, 0);
  assert.deepEqual(healthEvents.map(({ code }) => code), ['render-draw-failed']);

  cursor = { generation: 2, commitSeq: 6, sourceTick: 6 };
  view = sceneView(nodes, cursor);
  runtime.rebuild({
    view,
    snapshot: renderSnapshot(view, nodes.map((item) => acceptanceComposition(
      item.displayId,
      6,
      MATERIAL_UI_DIRTY_IDS.includes(item.displayId),
    ))),
  });
  await runtime.whenIdle();
  assert.equal(Object.hasOwn(runtime.capture(), 'healthFailure'), false);
  assert.equal(runtime.capture().rafCount, 1);
  harness.flushRaf(1_033.34);
  assert.equal(runtime.capture().drawCount, 2, 'draw continues after full rebuild');
  assert.equal(harness.maximumRafCount, 1);

  const stableResourceCount = runtime.capture().resourceCount;
  const stableLiveResources = harness.liveResourceCount;
  const stableLiveHandles = harness.liveHandleCount;
  let particleId = 500;
  let fullRebuilds = 1;
  for (let round = 1; round <= 100; round += 1) {
    const nextParticleId = particleId === 500 ? 501 : 500;
    cursor = {
      generation: cursor.generation,
      commitSeq: cursor.commitSeq + 1,
      sourceTick: cursor.sourceTick + 1,
    };
    nodes = acceptanceNodes({
      particleId: nextParticleId,
      poseEpoch: 3 + round,
      parent250: round % 2 === 0 ? 1n : 2n,
    });
    view = sceneView(nodes, cursor);
    const createsBeforeChurnCommit = harness.resourceCreateCounts();
    runtime.apply({
      plan: framePlan(cursor, {
        createIds: [BigInt(nextParticleId)],
        localPoseDirtyIds: POSE_DIRTY_IDS,
        removeIds: [BigInt(particleId)],
        reparentIds: [250n],
      }),
      view,
      batch: renderBatch(cursor, {
        changed: [acceptanceComposition(BigInt(nextParticleId), round + 6, false)],
        removedDisplayIds: [BigInt(particleId)],
      }),
    });
    await runtime.whenIdle();
    assert.deepEqual(
      harness.resourceCreateCounts(),
      createsBeforeChurnCommit,
      `round ${round} create/remove reused resources`,
    );
    particleId = nextParticleId;

    cursor = {
      generation: cursor.generation + 1,
      commitSeq: cursor.commitSeq + 1,
      sourceTick: cursor.sourceTick + 1,
    };
    view = sceneView(nodes, cursor);
    runtime.rebuild({
      view,
      snapshot: renderSnapshot(view, nodes.map((item) => acceptanceComposition(
        item.displayId,
        round + 6,
        MATERIAL_UI_DIRTY_IDS.includes(item.displayId),
      ))),
    });
    await runtime.whenIdle();
    fullRebuilds += 1;

    const capture = runtime.capture();
    assert.equal(capture.nodeCount, NODE_COUNT);
    assert.equal(capture.resourceCount, stableResourceCount);
    assert.equal(capture.pendingJobCount, 0);
    assert.equal(harness.liveResourceCount, stableLiveResources);
    assert.equal(harness.liveHandleCount, stableLiveHandles);
    assert.equal(capture.rafCount, 1);
    assert.equal(harness.maximumRafCount, 1);
    harness.assertNoDisposedResourceRevived();
  }
  assert.equal(fullRebuilds, 101, 'initial recovery plus one hundred soak rebuilds');
  assert.equal(harness.disposedResourceCount, 505);
  assert.deepEqual(harness.resourceCreateCounts(), {
    texture: 102,
    'primitive-model': 102,
    surface: 102,
    particle: 102,
    'scene-pass': 102,
  });
  assert.equal(harness.maximumRafCount, 1);
  assert.deepEqual(harness.ownerCounts(), {
    runtimes: 1,
    renderers: 1,
    scenes: 1,
    cameras: 1,
  });
  assert.equal(harness.rendererCreateCount, 2, 'tainted draw renderer was replaced exactly once');
  assert.equal(harness.rendererDisposeCount, 1, 'tainted renderer was retired before replacement');

  runtime.stop();
  runtime.dispose();
  runtime.dispose();
  assert.equal(harness.rafCount, 0);
  assert.equal(harness.liveResourceCount, 0);
  assert.equal(harness.liveHandleCount, 0);
  assert.equal(harness.listenerCount, 0);
  assert.equal(harness.observerCount, 0);
  assert.equal(harness.rendererDisposeCount, 2);
  assert.equal(harness.ownerCounts().renderers, 0);
  assert.equal(harness.disposedResourceCount, 510);
  process.stdout.write(`${JSON.stringify({
    check: 'renderer-three-v2-500-node-acceptance',
    ok: true,
    threeVersion: THREE_PACKAGE.version,
    nodeCount: NODE_COUNT,
    categories: { sprite: 200, model: 150, terrain: 100, particle: 50 },
    poseDirtySlotsChecked: POSE_DIRTY_IDS.length,
    materialUiDirtyCount: MATERIAL_UI_DIRTY_IDS.length,
    orderedCommitCount: 3,
    createRemoveRounds: 100,
    fullRebuildCount: fullRebuilds,
    maximumRafCount: harness.maximumRafCount,
    disposedResourceCount: harness.disposedResourceCount,
  })}\n`);
});

function realThreeAcceptanceHarness() {
  const stats = {
    activeHandles: new Set(),
    cameras: 0,
    disposedAssets: new Set(),
    groups: [],
    listeners: 0,
    matrixBarriers: 0,
    maximumRafCount: 0,
    observers: 0,
    parentEvents: [],
    raf: new Map(),
    renderers: new Set(),
    rendererCreates: 0,
    rendererDisposes: 0,
    resources: new Set(),
    resourceCreates: new Map(),
    runtimes: 0,
    scenes: 0,
  };
  let failDraw = false;
  let nextRaf = 1;
  const instrument = (object) => {
    stats.groups.push(object);
    const add = object.add.bind(object);
    object.add = (...children) => {
      for (const child of children) {
        const match = /^SceneAnchor:(\d+)$/.exec(child.name);
        if (match) {
          const parent = /^SceneAnchor:(\d+)$/.exec(object.name);
          stats.parentEvents.push({
            child: BigInt(match[1]),
            parent: parent ? BigInt(parent[1]) : 0n,
          });
        }
      }
      return add(...children);
    };
    return object;
  };
  const trackHandle = (handle, asset) => {
    if (!handle) return handle;
    assert.equal(stats.disposedAssets.has(asset), false, 'disposed resource was not rebound');
    let disposed = false;
    const originalDispose = handle.dispose.bind(handle);
    const proxy = {
      get object() { return handle.object; },
      ...(typeof handle.update === 'function' ? {
        update(...args) { return handle.update(...args); },
      } : {}),
      ...(typeof handle.updateLayer === 'function' ? {
        updateLayer(...args) { return handle.updateLayer(...args); },
      } : {}),
      ...(typeof handle.prepareDraw === 'function' ? {
        prepareDraw(...args) { return handle.prepareDraw(...args); },
      } : {}),
      ...(typeof handle.sample === 'function' ? {
        sample(...args) { return handle.sample(...args); },
      } : {}),
      ...(typeof handle.update === 'function' && typeof handle.updateLayer !== 'function' ? {
        update(...args) { return handle.update(...args); },
      } : {}),
      dispose() {
        if (disposed) return;
        disposed = true;
        stats.activeHandles.delete(proxy);
        originalDispose();
      },
    };
    stats.activeHandles.add(proxy);
    return proxy;
  };
  const adapter = {
    ...DEFAULT_THREE_ADAPTER,
    isHostElement: () => true,
    isCanvas: () => true,
    createRenderer() {
      const renderer = {};
      stats.renderers.add(renderer);
      stats.rendererCreates += 1;
      return renderer;
    },
    createScene() {
      stats.scenes += 1;
      return instrument(DEFAULT_THREE_ADAPTER.createScene());
    },
    createGroup() { return instrument(DEFAULT_THREE_ADAPTER.createGroup()); },
    createCamera(...args) {
      stats.cameras += 1;
      return DEFAULT_THREE_ADAPTER.createCamera(...args);
    },
    createControls() {
      stats.listeners += 1;
      let disposed = false;
      return {
        listenerCount: 1,
        focus() {},
        update() { return false; },
        dispose() {
          if (disposed) return;
          disposed = true;
          stats.listeners -= 1;
          this.listenerCount = 0;
        },
      };
    },
    createResizeObserver() {
      let active = false;
      return {
        observerCount: 1,
        observe() {
          if (active) return;
          active = true;
          stats.observers += 1;
        },
        disconnect() {
          if (!active) return;
          active = false;
          stats.observers -= 1;
          this.observerCount = 0;
        },
      };
    },
    requestAnimationFrame(callback) {
      const identity = nextRaf;
      nextRaf += 1;
      stats.raf.set(identity, callback);
      stats.maximumRafCount = Math.max(stats.maximumRafCount, stats.raf.size);
      return identity;
    },
    cancelAnimationFrame(identity) { stats.raf.delete(identity); },
    now: () => 0,
    devicePixelRatio: () => 1,
    setViewport() {},
    render() {
      if (!failDraw) return;
      failDraw = false;
      throw new Error('acceptance draw fault');
    },
    captureRendererInfo: () => null,
    updateMatrices(root) {
      stats.matrixBarriers += 1;
      DEFAULT_THREE_ADAPTER.updateMatrices(root);
    },
    async createResource(descriptor, signal, dependencies) {
      stats.resourceCreates.set(
        descriptor.kind,
        (stats.resourceCreates.get(descriptor.kind) ?? 0) + 1,
      );
      let asset;
      if (descriptor.kind === 'texture') {
        const texture = new Texture();
        texture.needsUpdate = true;
        asset = { kind: descriptor.kind, texture, descriptor };
      } else {
        asset = await DEFAULT_THREE_ADAPTER.createResource(
          descriptor,
          signal,
          dependencies,
        );
      }
      assert.equal(stats.disposedAssets.has(asset), false);
      stats.resources.add(asset);
      return asset;
    },
    disposeResource(asset) {
      stats.resources.delete(asset);
      stats.disposedAssets.add(asset);
      DEFAULT_THREE_ADAPTER.disposeResource(asset);
    },
    createInstanceBatch(pipelineId, asset, layer, context) {
      return trackHandle(DEFAULT_THREE_ADAPTER.createInstanceBatch(
        pipelineId,
        asset,
        layer,
        context,
      ), asset);
    },
    createPipelineObject(pipelineId, asset, layer, context) {
      return trackHandle(DEFAULT_THREE_ADAPTER.createPipelineObject(
        pipelineId,
        asset,
        layer,
        context,
      ), asset);
    },
    disposeRenderer(renderer) {
      if (!stats.renderers.delete(renderer)) return;
      stats.rendererDisposes += 1;
    },
  };
  return {
    get disposedResourceCount() { return stats.disposedAssets.size; },
    get listenerCount() { return stats.listeners; },
    get liveHandleCount() { return stats.activeHandles.size; },
    get liveResourceCount() { return stats.resources.size; },
    get matrixBarriers() { return stats.matrixBarriers; },
    get maximumRafCount() { return stats.maximumRafCount; },
    get observerCount() { return stats.observers; },
    get rafCount() { return stats.raf.size; },
    get rendererCreateCount() { return stats.rendererCreates; },
    get rendererDisposeCount() { return stats.rendererDisposes; },
    anchorCreationCount(identity) {
      return stats.groups.filter((group) => group.name === `SceneAnchor:${identity}`).length;
    },
    assertNoDisposedResourceRevived() {
      for (const asset of stats.resources) assert.equal(stats.disposedAssets.has(asset), false);
    },
    failNextDraw() { failDraw = true; },
    flushRaf(timestamp) {
      const callbacks = [...stats.raf.values()];
      stats.raf.clear();
      for (const callback of callbacks) callback(timestamp);
    },
    ownerCounts() {
      return {
        runtimes: stats.runtimes,
        renderers: stats.renderers.size,
        scenes: stats.scenes,
        cameras: stats.cameras,
      };
    },
    parentHistory(identity) {
      return stats.parentEvents
        .filter(({ child }) => child === identity)
        .map(({ parent }) => parent);
    },
    resourceCreateCounts() { return Object.fromEntries(stats.resourceCreates); },
    runtime(overrides = {}) {
      stats.runtimes += 1;
      return createThreeRenderRuntimeForTest({
        ...runtimeOptions(),
        ...overrides,
      }, adapter);
    },
    slotMatrix(identity) {
      for (const handle of stats.activeHandles) {
        const object = handle.object;
        if (!object?.isInstancedMesh) continue;
        const index = object.userData.renderBatchIdentities
          .findIndex(({ displayId }) => displayId === identity);
        if (index < 0) continue;
        const matrix = new Matrix4();
        object.getMatrixAt(index, matrix);
        return matrix;
      }
      assert.fail(`No active instance slot for displayId ${identity}.`);
    },
  };
}

function runtimeOptions() {
  return {
    hostElement: {
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    },
    canvas: { getContext() {} },
    cameraProfile: {
      projection: 'perspective',
      position: [0, 80, 120],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fovYDegrees: 45,
      near: 0.1,
      far: 10_000,
      minDistance: 1,
      maxDistance: 1_000,
      controls: {
        mode: 'pan-zoom',
        dampingFactor: 0.08,
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
    resourceCatalog: acceptanceCatalog(),
  };
}

function acceptanceCatalog() {
  return {
    schema: RENDER_RESOURCE_CATALOG_SCHEMA,
    resources: {
      'texture.card': {
        kind: 'texture',
        url: '/acceptance-card.png',
        colorSpace: 'srgb',
        wrap: 'clamp',
      },
      'model.repeated': {
        kind: 'primitive-model',
        parts: [{
          shape: 'box',
          dimensions: [1, 1, 1],
          material: { tintRgba: 0xc0d8ffff, opacity: 1, emissive: 0 },
        }],
      },
      'surface.water': {
        kind: 'surface',
        family: 'surface.water',
        geometry: {
          primitive: 'plane',
          width: 100,
          height: 100,
          segmentsX: 16,
          segmentsY: 16,
        },
        textureResourceIds: ['texture.card'],
        defaults: { amplitude: 0.2, speed: 0.5, foam: 0.1, textureScale: 2 },
      },
      'particle.dynamic': {
        kind: 'particle',
        textureResourceId: 'texture.card',
        maximumCapacity: 64,
      },
      'pass.background': {
        kind: 'scene-pass',
        passKind: 'background',
        defaults: { colorRgba: 0x14213dff },
      },
    },
  };
}

function acceptanceNodes({ particleId, poseEpoch, parent250 }) {
  const identities = [...range(1, 499), particleId];
  return Object.freeze(identities.map((identity) => {
    const dirty = POSE_DIRTY_IDS.includes(BigInt(identity));
    return Object.freeze({
      displayId: BigInt(identity),
      parentDisplayId: identity === 250 ? parent250 : 0n,
      localPosition: Object.freeze([
        identity % 25,
        dirty ? poseEpoch : 0,
        Math.floor(identity / 25),
      ]),
      localRotationXyzw: Object.freeze([0, 0, 0, 1]),
      localScale: Object.freeze([1, 1, 1]),
      flags: 1,
    });
  }));
}

function acceptanceComposition(identity, renderRevision, selected) {
  const kind = category(identity);
  if (kind === 'sprite') {
    return composition(identity, renderRevision, [renderLayer({
      key: 'card',
      pipelineId: 'sprite@2',
      resourceId: 'texture.card',
      params: { orientation: 'fixed', width: 1.5, height: 2 },
      batchKey: 'acceptance.cards',
      material: material({
        tintRgba: selected ? 0x6ec1ffff : 0xffffffff,
        alphaMode: 'mask',
        alphaCutoff: 0.5,
      }),
    })]);
  }
  if (kind === 'model' || kind === 'terrain') {
    return composition(identity, renderRevision, [renderLayer({
      key: kind,
      pipelineId: 'model@2',
      resourceId: 'model.repeated',
      params: {
        castShadow: kind === 'model',
        receiveShadow: true,
        instance: true,
      },
      batchKey: `acceptance.${kind}`,
      material: material({ alphaMode: 'opaque' }),
    })]);
  }
  return composition(identity, renderRevision, [renderLayer({
    key: 'effect',
    pipelineId: 'particle@2',
    resourceId: 'particle.dynamic',
    params: {
      durationTicks: 90,
      capacity: 16,
      seed: Number(identity),
      rate: 4,
      size: 0.5,
      velocity: [0, 1, 0],
      spread: [0.25, 0.25, 0.25],
      gravity: [0, -0.5, 0],
      blendMode: 'normal',
    },
    material: material({ alphaMode: 'blend' }),
    animation: {
      stateId: 1,
      clipId: 'active',
      startTick: 0n,
      flags: 0,
      clock: 'simulation',
    },
  })]);
}

function sceneLayer(pipelineId, resourceId, key, params) {
  return Object.freeze(renderLayer({
    key,
    pipelineId,
    resourceId,
    params,
    material: material({ alphaMode: 'opaque' }),
    renderOrder: -100,
  }));
}

function renderLayer({
  key,
  pipelineId,
  resourceId,
  params,
  material: layerMaterial,
  animation = null,
  batchKey = null,
  pickable = false,
  renderOrder = 0,
}) {
  return {
    key,
    pipelineId,
    resourceId,
    transform: {
      position: [0, 0, 0],
      rotationXyzw: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    material: layerMaterial,
    animation,
    params,
    batchKey,
    pickable,
    renderOrder,
  };
}

function material(overrides = {}) {
  return {
    tintRgba: overrides.tintRgba ?? 0xffffffff,
    opacity: overrides.opacity ?? 1,
    emissive: overrides.emissive ?? 0,
    alphaMode: overrides.alphaMode ?? 'opaque',
    alphaCutoff: overrides.alphaCutoff ?? 0,
  };
}

function composition(identity, renderRevision, layers) {
  return {
    schema: RENDER_COMPOSITION_SCHEMA,
    displayId: BigInt(identity),
    renderRevision,
    layers,
  };
}

function renderSnapshot(view, compositions) {
  return {
    schema: RENDER_SNAPSHOT_SCHEMA,
    generation: view.generation,
    commitSeq: view.commitSeq,
    sourceTick: view.sourceTick,
    compositions,
    sceneLayers: SCENE_LAYERS,
  };
}

function renderBatch(cursor, overrides = {}) {
  return {
    schema: RENDER_BATCH_SCHEMA,
    generation: cursor.generation,
    commitSeq: cursor.commitSeq,
    sourceTick: cursor.sourceTick,
    changed: overrides.changed ?? [],
    removedDisplayIds: overrides.removedDisplayIds ?? [],
    sceneLayers: overrides.sceneLayers ?? null,
  };
}

function framePlan(cursor, overrides = {}) {
  return {
    kind: 'frame',
    generation: cursor.generation,
    commitSeq: cursor.commitSeq,
    sourceTick: cursor.sourceTick,
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

function sceneView(nodes, cursor) {
  const byId = new Map(nodes.map((item) => [item.displayId, item]));
  return Object.freeze({
    ...cursor,
    nodeCount: nodes.length,
    nodeAt: (index) => nodes[index] ?? null,
    getNode: (identity) => byId.get(identity) ?? null,
  });
}

function category(identity) {
  const numeric = Number(identity);
  if (numeric <= 200) return 'sprite';
  if (numeric <= 350) return 'model';
  if (numeric <= 450) return 'terrain';
  return 'particle';
}

function categoryCounts(nodes) {
  const counts = { sprite: 0, model: 0, terrain: 0, particle: 0 };
  for (const { displayId } of nodes) counts[category(displayId)] += 1;
  return counts;
}

function assertRuntimeShape(actual, expected) {
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])),
    expected,
  );
}

function range(first, last) {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
