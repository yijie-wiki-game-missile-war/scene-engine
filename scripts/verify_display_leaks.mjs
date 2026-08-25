#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  defineScene,
} from '../js/packages/display/src/index.js';
import { ThreeRenderBackend } from '../js/packages/renderer-three/src/backend.js';
import {
  DEFAULT_THREE_IMPLEMENTATION,
  disposeThreeResource,
  loadThreeResource,
} from '../js/packages/renderer-three/src/resources.js';
import { TestRenderer } from '../js/packages/renderer-three/test/support.mjs';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = process.env.SCENE_ENGINE_DISPLAY_LEAK_OUTPUT
  ? resolve(process.env.SCENE_ENGINE_DISPLAY_LEAK_OUTPUT)
  : resolve(SCRIPT_DIRECTORY, '../docs/evidence/display-resource-leak-matrix.json');
const IDENTITY = Object.freeze({
  position: Object.freeze([0, 0, 0]),
  rotationXyzw: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
});
const PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x102030ff,
  antialias: false,
  alpha: false,
  shadows: false,
  toneMapping: 'none',
});
const CAMERA_PROPERTIES = Object.freeze({
  projection: 'perspective', near: 0.1, far: 1_000, fovYDegrees: 60,
});
const MESH_PROPERTIES = Object.freeze({
  meshResourceId: 'mesh/triangle',
  materialResourceId: 'material/standard',
  castShadow: false,
  receiveShadow: false,
  renderOrder: 0,
  pickable: true,
});
const SPRITE_PROPERTIES = Object.freeze({
  textureResourceId: 'texture/pixel',
  width: 1,
  height: 1,
  material: Object.freeze({
    tintRgba: 0xffffffff,
    opacity: 1,
    emissive: 0,
    alphaMode: 'opaque',
    alphaCutoff: 0,
  }),
  alpha: 1,
  frame: 0,
  flipbook: null,
  renderOrder: 1,
  pickable: true,
});
const RESOURCES = Object.freeze([
  Object.freeze({
    id: 'mesh/triangle', kind: 'mesh',
    positions: Object.freeze([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    indices: Object.freeze([0, 1, 2]),
  }),
  Object.freeze({
    id: 'texture/pixel', kind: 'texture',
    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA' +
      'DUlEQVR42mP8z8BQDwAFgwJ/lwDdWQAAAABJRU5ErkJggg==',
    colorSpace: 'srgb', wrap: 'clamp',
  }),
  Object.freeze({
    id: 'material/standard', kind: 'material', family: 'material.standard',
    properties: Object.freeze({
      tintRgba: 0xffffffff, opacity: 1, emissive: 0,
      alphaMode: 'opaque', alphaCutoff: 0,
    }),
    textureResourceIds: Object.freeze(['texture/pixel']),
  }),
]);

const originalImageBitmap = globalThis.createImageBitmap;
let closedImageBitmapCount = 0;
globalThis.createImageBitmap = async () => ({
  width: 1,
  height: 1,
  close() { closedImageBitmapCount += 1; },
});
const disposalProbe = installDisposalProbe();

async function main() {
  try {
  const lifecycle = await verifyAuthorityAndRebuildLifecycle();
  const faults = await verifyFaultInjectionMatrix();
  const report = {
    schema: 'scene-engine-display-resource-leak-matrix@1',
    status: 'READY',
    generatedAt: new Date().toISOString(),
    command: 'node --expose-gc scripts/verify_display_leaks.mjs',
    runtime: {
      node: process.version,
      displaySchema: 'scene-engine-display-node@2',
      rendererBackend: '@scene-engine/renderer-three@0.9.1',
      rendererInjection: 'real ThreeRenderBackend with a non-WebGL TestRenderer only',
      resourceLifecycle: 'loadThreeResource + disposeThreeResource',
    },
    thresholds: {
      authorityCreateRemoveCycles: 100,
      renderBackendRebuilds: 20,
      finalNodeCount: 0,
      finalComponentCount: 0,
      finalSchedulerCount: 0,
      finalBindingCount: 0,
      finalResourceLeaseCount: 0,
      finalPendingCount: 0,
      finalGeometryCount: 0,
      finalMaterialCount: 0,
      finalTextureCount: 0,
    },
    lifecycle,
    faults,
    disposalProbe: {
      ...disposalProbe.snapshot(),
      imageBitmapsClosed: closedImageBitmapCount,
    },
  };
  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    evidence: EVIDENCE_PATH,
    authorityCycles: lifecycle.authority.cycles,
    rebuilds: lifecycle.rebuild.rebuilds,
    faultCases: Object.keys(faults),
    final: lifecycle.final,
  }, null, 2)}\n`);
  } finally {
    disposalProbe.restore();
    if (originalImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalImageBitmap;
  }
}

async function verifyAuthorityAndRebuildLifecycle() {
  const healthEvents = [];
  const backends = [];
  const frames = new FrameAdapter();
  const hostElement = host();
  const canvas = { getContext: () => ({}), toDataURL: () => 'data:image/png;base64,' };
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry(RESOURCES);
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'leak-matrix.rendered',
    logicalType: 'leak-matrix.rendered',
    root: {
      components: [],
      children: [{
        localName: 'visual',
        transform: IDENTITY,
        visible: true,
        components: [
          { key: 'mesh', type: 'render.mesh@1', properties: MESH_PROPERTIES },
          { key: 'sprite', type: 'render.sprite@1', properties: SPRITE_PROPERTIES },
        ],
        children: [],
      }],
    },
  });
  const prefabRegistry = createPrefabRegistry([{
    sceneProfile: 'leak-matrix', logicalType: prefab.logicalType, definition: prefab,
  }]);
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'leak-matrix',
    rendererProfile: PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [
      {
        localName: 'camera', parentLocalName: null, transform: IDENTITY,
        components: [{ key: 'camera', type: 'render.camera@1', properties: CAMERA_PROPERTIES }],
      },
      {
        localName: 'baseline-visual', parentLocalName: null, transform: IDENTITY,
        components: [
          { key: 'mesh', type: 'render.mesh@1', properties: MESH_PROPERTIES },
          { key: 'sprite', type: 'render.sprite@1', properties: SPRITE_PROPERTIES },
        ],
      },
    ],
    prefabInstances: [],
  });
  const createRenderBackend = (options) => {
    const renderer = new TestRenderer();
    const observer = { disconnected: false };
    const backend = new ThreeRenderBackend(options, {
      ...DEFAULT_THREE_IMPLEMENTATION,
      createRenderer: () => renderer,
      createResizeObserver: () => ({
        observe() {},
        disconnect() { observer.disconnected = true; },
      }),
      devicePixelRatio: () => 1,
      loadResource: loadThreeResource,
      disposeResource: disposeThreeResource,
    });
    backends.push({ backend, renderer, observer });
    return backend;
  };
  const runtime = createDisplayRuntime({
    hostElement,
    canvas,
    sceneRegistry: createSceneRegistry([scene]),
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    createRenderBackend,
    frameAdapter: frames,
    onHealth: (event) => healthEvents.push(event),
  });
  runtime.installScene({ sceneName: 'main' });
  runtime.activate();
  await runtime.whenReady();

  const baseline = runtimeMetrics(runtime, backends.at(-1).backend, frames);
  assertHealthyBaseline(baseline);
  const authorityPeaks = [];
  let previousRoot = null;
  let previousMeshComponent = null;
  for (let cycle = 0; cycle < 100; cycle += 1) {
    runtime.authority.createNode({
      name: 'py/leak-cycle',
      parentName: null,
      prefabType: prefab.logicalType,
      transformMode: 'live',
      transform: IDENTITY,
      visible: true,
      state: {},
    });
    await runtime.whenReady();
    const root = runtime._nodeIndex.require('py/leak-cycle');
    const visual = runtime._nodeIndex.require('prefab/py/leak-cycle/visual');
    const meshComponent = visual.requireComponent('mesh');
    assert.notStrictEqual(root, previousRoot, 'authority Node identity must never be resurrected');
    assert.notStrictEqual(meshComponent, previousMeshComponent,
      'removed Component identity must never be resurrected');
    assert.equal(runtime.currentView().getAuthorityOwner(visual.name), root.name);
    const peak = runtimeMetrics(runtime, backends.at(-1).backend, frames);
    assert.equal(peak.nodeCount, baseline.nodeCount + 2);
    assert.equal(peak.componentCount, baseline.componentCount + 3);
    assert.equal(peak.bindingCount, baseline.bindingCount + 2);
    assert.equal(peak.pendingBindingCount, 0);
    assert.equal(peak.pendingResourceCount, 0);
    authorityPeaks.push(peak);
    previousRoot = root;
    previousMeshComponent = meshComponent;
    runtime.authority.removeNode({ name: 'py/leak-cycle' });
    await runtime.whenReady();
    assert.deepEqual(runtimeMetrics(runtime, backends.at(-1).backend, frames), baseline,
      `authority lifecycle ${cycle + 1} failed to return to baseline`);
  }

  let stableNode = runtime._nodeIndex.require('scene/main/baseline-visual');
  let stableMesh = stableNode.requireComponent('mesh');
  let stableSprite = stableNode.requireComponent('sprite');
  const rebuildRows = [];
  for (let rebuild = 0; rebuild < 20; rebuild += 1) {
    const retired = backends.at(-1);
    await runtime.rebuildRenderBackend();
    const active = backends.at(-1);
    assert.equal(backends.length, rebuild + 2);
    assert.strictEqual(runtime._nodeIndex.require(stableNode.name), stableNode,
      'backend rebuild replaced a Node identity');
    assert.strictEqual(stableNode.requireComponent('mesh'), stableMesh,
      'backend rebuild replaced the mesh Component identity');
    assert.strictEqual(stableNode.requireComponent('sprite'), stableSprite,
      'backend rebuild replaced the sprite Component identity');
    const activeMetrics = runtimeMetrics(runtime, active.backend, frames);
    assert.deepEqual(activeMetrics, baseline, `backend rebuild ${rebuild + 1} changed the baseline`);
    const retiredMetrics = backendMetrics(retired.backend);
    assertBackendZero(retiredMetrics, `retired backend ${rebuild + 1}`);
    assert.equal(retired.renderer.disposed, true);
    assert.equal(retired.observer.disconnected, true);
    rebuildRows.push({
      ordinal: rebuild + 1,
      nodeIdentityPreserved: true,
      componentIdentityPreserved: true,
      active: activeMetrics,
      retired: retiredMetrics,
    });
  }
  assert.equal(healthEvents.length, 0, 'nominal lifecycle emitted renderer health failures');

  const lastBackend = backends.at(-1);
  const releasedReferences = {
    node: new WeakRef(stableNode),
    meshComponent: new WeakRef(stableMesh),
    spriteComponent: new WeakRef(stableSprite),
  };
  stableNode = null;
  stableMesh = null;
  stableSprite = null;
  const runtimeRefs = retainRuntimeInternals(runtime);
  await runtime.dispose();
  const final = runtimeMetrics(runtime, lastBackend.backend, frames, runtimeRefs);
  assertRuntimeZero(final, 'disposed DisplayRuntime');
  assertRuntimeReferencesReleased(runtime, runtimeRefs);
  const weakReferencesCollected = await collectWeakReferences(releasedReferences);
  assert.deepEqual(weakReferencesCollected, {
    node: true,
    meshComponent: true,
    spriteComponent: true,
  }, 'externally retained DisplayRuntime kept its disposed object graph alive');
  assert.equal(lastBackend.renderer.disposed, true);
  assert.equal(lastBackend.observer.disconnected, true);

  return {
    authority: {
      cycles: 100,
      canonicalName: 'py/leak-cycle',
      distinctNodeIdentities: 100,
      distinctComponentIdentities: 100,
      baseline,
      maximum: maxima(authorityPeaks),
      eachCycleReturnedToBaseline: true,
    },
    rebuild: {
      rebuilds: 20,
      backendInstances: backends.length,
      nodeIdentityPreserved: true,
      componentIdentityPreserved: true,
      eachActiveBackendMatchedBaseline: true,
      eachRetiredBackendReturnedToZero: true,
      rows: rebuildRows,
    },
    healthEventCount: healthEvents.length,
    weakReferencesCollected,
    final,
  };
}

async function verifyFaultInjectionMatrix() {
  return {
    gltfLoadFailure: await verifyGltfLoadFailure(),
    partialLodFailure: await verifyPartialLodFailure(),
    pendingBindingDispose: await verifyPendingBindingDispose(),
  };
}

async function verifyGltfLoadFailure() {
  const beforeDispose = disposalProbe.snapshot();
  const health = [];
  const { backend, renderer, observer, registry } = directBackend([
    { id: 'model/broken', kind: 'model', url: 'https://leak-matrix.invalid/broken.gltf' },
  ], { onHealth: (event) => health.push(event) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input.url;
    if (target === 'https://leak-matrix.invalid/broken.gltf') {
      return new Response('injected failure', { status: 503 });
    }
    return originalFetch(input, init);
  };
  try {
    await assert.rejects(backend.createBinding(modelDescriptor(
      'py/fault-gltf', 'model', 'model/broken', registry,
    )), /Model request failed/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const settled = backendMetrics(backend);
  assertBackendZero(settled, 'GLTF failure settled backend');
  assert.ok(health.some((event) => event.resourceId === 'model/broken'));
  backend.dispose();
  const final = backendMetrics(backend);
  assertBackendZero(final, 'GLTF failure disposed backend');
  assert.equal(renderer.disposed, true);
  assert.equal(observer.disconnected, true);
  return {
    injected: 'HTTP 503 for the only GLTF level',
    rejected: true,
    healthEventCount: health.length,
    settled,
    final,
    disposedDelta: disposalDelta(beforeDispose, disposalProbe.snapshot()),
  };
}

async function verifyPartialLodFailure() {
  const beforeDispose = disposalProbe.snapshot();
  const health = [];
  const { backend, renderer, observer, registry } = directBackend([
    {
      id: 'model/partial-lod', kind: 'model',
      url: 'https://leak-matrix.invalid/lod0.gltf',
      lodUrls: ['https://leak-matrix.invalid/lod1.gltf'],
    },
  ], { onHealth: (event) => health.push(event) });
  const originalFetch = globalThis.fetch;
  const originalProgressEvent = globalThis.ProgressEvent;
  const originalSelf = globalThis.self;
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  };
  globalThis.self = globalThis;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : input.url;
    if (target === 'https://leak-matrix.invalid/lod0.gltf') {
      return new Response(minimalTriangleGltf(), {
        status: 200,
        headers: { 'content-type': 'model/gltf+json' },
      });
    }
    if (target === 'https://leak-matrix.invalid/lod1.gltf') {
      return new Response('injected second-level failure', { status: 503 });
    }
    return originalFetch(input, init);
  };
  try {
    await assert.rejects(backend.createBinding(modelDescriptor(
      'py/fault-lod', 'model', 'model/partial-lod', registry,
    )), /Model request failed/u);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProgressEvent === undefined) delete globalThis.ProgressEvent;
    else globalThis.ProgressEvent = originalProgressEvent;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
  const settled = backendMetrics(backend);
  assertBackendZero(settled, 'partial LOD failure settled backend');
  const disposedDelta = disposalDelta(beforeDispose, disposalProbe.snapshot());
  assert.ok(disposedDelta.geometry >= 1, 'fulfilled LOD geometry was not disposed');
  assert.ok(disposedDelta.material >= 1, 'fulfilled LOD material was not disposed');
  backend.dispose();
  const final = backendMetrics(backend);
  assertBackendZero(final, 'partial LOD failure disposed backend');
  assert.equal(renderer.disposed, true);
  assert.equal(observer.disconnected, true);
  return {
    injected: 'LOD0 valid GLTF followed by LOD1 HTTP 503',
    rejected: true,
    fulfilledLevelDisposed: true,
    healthEventCount: health.length,
    settled,
    final,
    disposedDelta,
  };
}

async function verifyPendingBindingDispose() {
  const beforeDispose = disposalProbe.snapshot();
  const beforeClosedImages = closedImageBitmapCount;
  let beginLoad = null;
  let resolveLoad = null;
  const loadStarted = new Promise((resolveStarted) => { beginLoad = resolveStarted; });
  const delayedLoad = (descriptor, signal, dependencies) => {
    beginLoad();
    return new Promise((resolvePending, rejectPending) => {
      resolveLoad = async () => {
        try { resolvePending(await loadThreeResource(descriptor, signal, dependencies)); }
        catch (error) { rejectPending(error); }
      };
    });
  };
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry([RESOURCES[1]]);
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'leak-matrix.pending', logicalType: 'leak-matrix.pending',
    root: { components: [], children: [{
      localName: 'visual', transform: IDENTITY, visible: true,
      components: [{ key: 'sprite', type: 'render.sprite@1', properties: SPRITE_PROPERTIES }],
      children: [],
    }] },
  });
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main', sceneProfile: 'leak-matrix-pending', rendererProfile: PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'camera', type: 'render.camera@1', properties: CAMERA_PROPERTIES }],
    }],
    prefabInstances: [],
  });
  const frames = new FrameAdapter();
  const backendRows = [];
  const runtime = createDisplayRuntime({
    hostElement: host(), canvas: { getContext: () => ({}) },
    sceneRegistry: createSceneRegistry([scene]),
    prefabRegistry: createPrefabRegistry([{
      sceneProfile: 'leak-matrix-pending', logicalType: prefab.logicalType, definition: prefab,
    }]),
    resourceRegistry,
    componentRegistry,
    createRenderBackend(options) {
      const row = directBackendFromOptions(options, delayedLoad);
      backendRows.push(row);
      return row.backend;
    },
    frameAdapter: frames,
  });
  runtime.installScene({ sceneName: 'main' });
  runtime.activate();
  await runtime.whenReady();
  const baseline = runtimeMetrics(runtime, backendRows[0].backend, frames);
  runtime.authority.createNode({
    name: 'py/pending', parentName: null, prefabType: prefab.logicalType,
    transformMode: 'live', transform: IDENTITY, visible: true, state: {},
  });
  await loadStarted;
  const pendingBeforeDispose = runtimeMetrics(runtime, backendRows[0].backend, frames);
  assert.equal(pendingBeforeDispose.pendingBindingCount, 1);
  assert.equal(pendingBeforeDispose.pendingResourceCount, 1);
  const runtimeRefs = retainRuntimeInternals(runtime);
  const disposal = runtime.dispose();
  await Promise.resolve();
  await resolveLoad();
  await disposal;
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  const final = runtimeMetrics(runtime, backendRows[0].backend, frames, runtimeRefs);
  assertRuntimeZero(final, 'pending binding disposed DisplayRuntime');
  assertRuntimeReferencesReleased(runtime, runtimeRefs);
  assert.equal(backendRows[0].renderer.disposed, true);
  assert.equal(backendRows[0].observer.disconnected, true);
  return {
    injected: 'DisplayRuntime disposed while its real texture Resource lease was pending',
    lateBindingAttached: false,
    baseline,
    pendingBeforeDispose,
    final,
    imageBitmapsClosed: closedImageBitmapCount - beforeClosedImages,
    disposedDelta: disposalDelta(beforeDispose, disposalProbe.snapshot()),
  };
}

function directBackend(descriptors, { onHealth = null, loadResource = loadThreeResource } = {}) {
  const registry = createResourceRegistry(descriptors);
  const row = directBackendFromOptions({
    hostElement: host(),
    canvas: { getContext: () => ({}), toDataURL: () => 'data:image/png;base64,' },
    rendererProfile: PROFILE,
    resourceRegistry: registry,
    onHealth,
  }, loadResource);
  return { ...row, registry };
}

function directBackendFromOptions(options, loadResource = loadThreeResource) {
  const renderer = new TestRenderer();
  const observer = { disconnected: false };
  const backend = new ThreeRenderBackend(options, {
    ...DEFAULT_THREE_IMPLEMENTATION,
    createRenderer: () => renderer,
    createResizeObserver: () => ({
      observe() {},
      disconnect() { observer.disconnected = true; },
    }),
    devicePixelRatio: () => 1,
    loadResource,
    disposeResource: disposeThreeResource,
  });
  return { backend, renderer, observer };
}

function modelDescriptor(nodeName, componentKey, modelResourceId, registry) {
  return {
    nodeName,
    componentKey,
    componentType: 'render.model@1',
    properties: {
      modelResourceId,
      materialOverrides: {},
      castShadow: false,
      receiveShadow: false,
      renderOrder: 0,
      pickable: false,
      animation: null,
    },
    resourceRegistry: registry,
  };
}

function retainRuntimeInternals(runtime) {
  return {
    nodeIndex: runtime._nodeIndex,
    scheduler: runtime._scheduler,
    renderSystem: runtime._renderSystem,
    sceneLoader: runtime._sceneLoader,
    prefabInstantiator: runtime._prefabInstantiator,
    scene: runtime._scene,
  };
}

function runtimeMetrics(runtime, backend, frames, retained = null) {
  const nodeIndex = runtime._nodeIndex ?? retained?.nodeIndex;
  const scheduler = runtime._scheduler ?? retained?.scheduler;
  const renderSystem = runtime._renderSystem ?? retained?.renderSystem;
  let componentCount = 0;
  for (const node of nodeIndex?.values() ?? []) componentCount += node._components.size;
  const backendState = backendMetrics(backend);
  return {
    nodeCount: nodeIndex?.size ?? 0,
    componentCount,
    schedulerCount: scheduler?._registered.size ?? 0,
    schedulerUpdateCount: scheduler?._phases.update.length ?? 0,
    schedulerBeforeRenderCount: scheduler?._phases['before-render'].length ?? 0,
    renderSystemEntryCount: renderSystem?._entries.size ?? 0,
    sceneLoaderScopeCount: (runtime._sceneLoader ?? retained?.sceneLoader)?._scopes.length ?? 0,
    prefabScopeCount: (runtime._prefabInstantiator ?? retained?.prefabInstantiator)?._scopes.size ?? 0,
    rafPendingCount: frames.pending,
    ...backendState,
  };
}

function assertRuntimeReferencesReleased(runtime, retained) {
  for (const key of [
    '_nodeIndex', '_scheduler', '_renderSystem', '_nodeGraph', '_scene', '_componentContext',
    '_prefabInstantiator', '_sceneLoader', '_hostElement', '_canvas', '_createRenderBackend',
  ]) assert.equal(runtime[key], null, `disposed DisplayRuntime retained ${key}`);
  assert.equal(retained.sceneLoader._scopes.length, 0);
  assert.equal(retained.prefabInstantiator._scopes.size, 0);
  for (const key of [
    'rootNode', 'authorityRootNode', 'definition', 'compiledDefinition', 'loader',
    'activeCameraName', 'registries', 'nodeIndex', 'nodeGraph', 'scheduler', 'renderSystem',
  ]) assert.equal(retained.scene[key], null, `disposed Scene retained ${key}`);
}

async function collectWeakReferences(references) {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    for (let collection = 0; collection < 3; collection += 1) globalThis.gc();
    if (Object.values(references).every((reference) => reference.deref() === undefined)) break;
  }
  return Object.fromEntries(Object.entries(references)
    .map(([key, reference]) => [key, reference.deref() === undefined]));
}

function backendMetrics(backend) {
  const diagnostics = backend.diagnostics();
  return {
    bindingCount: diagnostics.bindingCount,
    nodeBindingCount: diagnostics.nodeBindingCount,
    resourceCount: diagnostics.resourceCount,
    readyResourceCount: diagnostics.readyResourceCount,
    resourceLeaseCount: diagnostics.resourceLeaseCount,
    pendingBindingCount: diagnostics.pendingBindingCount,
    pendingResourceCount: diagnostics.pendingResourceCount,
    rendererGeometryCount: diagnostics.rendererGeometries,
    rendererTextureCount: diagnostics.rendererTextures,
    ...countBackendObjects(backend),
  };
}

function countBackendObjects(backend) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const visitTexture = (texture) => { if (texture?.isTexture) textures.add(texture); };
  const visitMaterial = (material) => {
    if (!material?.isMaterial || materials.has(material)) return;
    materials.add(material);
    for (const value of Object.values(material)) visitTexture(value);
    if (material.uniforms) {
      for (const uniform of Object.values(material.uniforms)) visitTexture(uniform?.value);
    }
  };
  const visitObject = (root) => root?.traverse?.((object) => {
    if (object.geometry?.isBufferGeometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      visitMaterial(material);
    }
  });
  visitObject(backend._scene);
  for (const entry of backend._resources.entries.values()) {
    const asset = entry.asset;
    if (!asset) continue;
    if (asset.geometry?.isBufferGeometry) geometries.add(asset.geometry);
    visitMaterial(asset.material);
    visitTexture(asset.texture);
    visitObject(asset.template);
    for (const template of asset.templates ?? []) visitObject(template);
  }
  visitTexture(backend._scene.background);
  visitTexture(backend._scene.environment);
  return {
    geometryCount: geometries.size,
    materialCount: materials.size,
    textureCount: textures.size,
  };
}

function assertHealthyBaseline(value) {
  assert.equal(value.pendingBindingCount, 0);
  assert.equal(value.pendingResourceCount, 0);
  assert.equal(value.rafPendingCount, 0);
  assert.ok(value.nodeCount > 0);
  assert.ok(value.componentCount > 0);
  assert.ok(value.bindingCount > 0);
  assert.ok(value.resourceLeaseCount > 0);
  assert.ok(value.geometryCount > 0);
  assert.ok(value.materialCount > 0);
  assert.ok(value.textureCount > 0);
}

function assertBackendZero(value, label) {
  for (const key of [
    'bindingCount', 'nodeBindingCount', 'resourceCount', 'readyResourceCount',
    'resourceLeaseCount', 'pendingBindingCount', 'pendingResourceCount',
    'rendererGeometryCount', 'rendererTextureCount', 'geometryCount', 'materialCount',
    'textureCount',
  ]) assert.equal(value[key], 0, `${label}: ${key} must return to zero`);
}

function assertRuntimeZero(value, label) {
  for (const key of [
    'nodeCount', 'componentCount', 'schedulerCount', 'schedulerUpdateCount',
    'schedulerBeforeRenderCount', 'renderSystemEntryCount', 'sceneLoaderScopeCount',
    'prefabScopeCount', 'rafPendingCount',
  ]) assert.equal(value[key], 0, `${label}: ${key} must return to zero`);
  assertBackendZero(value, label);
}

function maxima(rows) {
  const keys = Object.keys(rows[0] ?? {});
  return Object.fromEntries(keys.map((key) => [key, Math.max(...rows.map((row) => row[key]))]));
}

function host() {
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

class FrameAdapter {
  constructor() { this.next = 1; this.callbacks = new Map(); this.time = 0; }
  request(callback) { const id = this.next++; this.callbacks.set(id, callback); return id; }
  cancel(id) { this.callbacks.delete(id); }
  now() { return this.time; }
  get pending() { return this.callbacks.size; }
}

function installDisposalProbe() {
  const counters = { geometry: 0, material: 0, texture: 0 };
  const restorations = [];
  for (const [prototype, key] of [
    [THREE.BufferGeometry.prototype, 'geometry'],
    [THREE.Material.prototype, 'material'],
    [THREE.Texture.prototype, 'texture'],
  ]) {
    const original = prototype.dispose;
    const seen = new WeakSet();
    prototype.dispose = function probedDispose(...args) {
      if (!seen.has(this)) { seen.add(this); counters[key] += 1; }
      return original.apply(this, args);
    };
    restorations.push(() => { prototype.dispose = original; });
  }
  return {
    snapshot: () => ({ ...counters }),
    restore() { for (const restore of restorations.reverse()) restore(); },
  };
}

function disposalDelta(before, after) {
  return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
}

function minimalTriangleGltf() {
  const bytes = new Uint8Array(44);
  new Float32Array(bytes.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint16Array(bytes.buffer, 36, 3).set([0, 1, 2]);
  const uri = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
  return JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 44, uri }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3',
        min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
}

await main();
