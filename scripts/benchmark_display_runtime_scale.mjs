#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import * as THREE from 'three';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  TICKS_PER_SECOND,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineFrameAnimation,
  definePrefab,
  defineScene,
} from '../js/packages/display/src/index.js';
import { ThreeRenderBackend } from '../js/packages/renderer-three/src/backend.js';
import {
  DEFAULT_THREE_IMPLEMENTATION,
  disposeThreeResource,
  loadThreeResource,
} from '../js/packages/renderer-three/src/resources.js';
import {
  IDENTITY_MATRIX,
  composeMatrix4,
  matrix4AlmostEqual,
} from './support/matrix4.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROFILE_NAMES = Object.freeze([
  'static-mesh',
  'static-sprite',
  'mixed',
  'nested',
  'animated-sprite',
]);
const PROFILE_SET = new Set(PROFILE_NAMES);
const MAXIMUM_BINDINGS = 50_000;
const FRAME_MILLISECONDS = 1_000 / TICKS_PER_SECOND;
const IDENTITY = IDENTITY_MATRIX;
const IDS = Object.freeze({
  animation: 'benchmark/animation/walk',
  material: 'benchmark/material/standard',
  mesh: 'benchmark/mesh/triangle',
  model: 'benchmark/model/triangle',
  particle: 'benchmark/particle/sparks',
  surface: 'benchmark/surface/water',
  texture: 'benchmark/texture/atlas',
  prefabMesh: 'benchmark/prefab/static-mesh',
  prefabSprite: 'benchmark/prefab/static-sprite',
  prefabAnimated: 'benchmark/prefab/animated-sprite',
  prefabModel: 'benchmark/prefab/model',
  prefabSurface: 'benchmark/prefab/surface',
  prefabParticle: 'benchmark/prefab/particle',
  prefabNestedOwner: 'benchmark/prefab/nested-owner',
});

class FrameAdapter {
  constructor() {
    this.time = 0;
    this.nextIdentity = 1;
    this.callbacks = new Map();
  }

  request(callback) {
    const identity = this.nextIdentity;
    this.nextIdentity += 1;
    this.callbacks.set(identity, callback);
    return identity;
  }

  cancel(identity) { this.callbacks.delete(identity); }
  now() { return this.time; }
  get pendingCount() { return this.callbacks.size; }

  step(milliseconds = FRAME_MILLISECONDS) {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
    return callbacks.length;
  }
}

class TestRenderer {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.draws = 0;
    this.disposed = false;
    this.info = {
      render: { calls: 0 },
      memory: { geometries: 0, textures: 0 },
    };
  }

  setPixelRatio(value) { this.pixelRatio = value; }
  setSize(width, height) { this.width = width; this.height = height; }
  render(scene) {
    // WebGLRenderer performs the same world-matrix propagation before issuing draws.
    scene.updateMatrixWorld();
    this.draws += 1;
    this.info.render.calls += 1;
  }
  dispose() { this.disposed = true; }
}

function rendererProfile() {
  return Object.freeze({
    drawMode: 'requested',
    maximumPixelRatio: 1,
    clearRgba: 0x1020_30ff,
    antialias: false,
    alpha: false,
    shadows: false,
    toneMapping: 'none',
  });
}

function resources() {
  return [
    {
      id: IDS.mesh,
      kind: 'mesh',
      positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0],
      indices: [0, 1, 2],
    },
    {
      id: IDS.material,
      kind: 'material',
      family: 'material.standard',
      properties: {
        tintRgba: 0xffff_ffff,
        opacity: 1,
        emissive: 0,
        alphaMode: 'opaque',
        alphaCutoff: 0,
      },
    },
    {
      id: IDS.texture,
      kind: 'texture-atlas',
      url: 'memory:benchmark-atlas',
      columns: 4,
      rows: 1,
    },
    {
      id: IDS.model,
      kind: 'model',
      url: 'memory:benchmark-model',
    },
    {
      id: IDS.surface,
      kind: 'surface',
      family: 'surface.water',
      geometry: { primitive: 'plane', width: 1, height: 1, segmentsX: 1, segmentsY: 1 },
      textureResourceIds: [],
      defaults: { amplitude: 0.1, speed: 1, foam: 0.2, textureScale: 1 },
    },
    {
      id: IDS.particle,
      kind: 'particle',
      maximumCapacity: 4,
      textureResourceId: null,
      defaults: {},
    },
    defineFrameAnimation({
      id: IDS.animation,
      target: { node: '$root', component: 'visual' },
      frames: [0, 1, 2, 3],
      fps: 10,
      loop: true,
    }),
  ];
}

function meshComponent() {
  return {
    key: 'visual',
    type: 'render.mesh@1',
    properties: {
      meshResourceId: IDS.mesh,
      materialResourceId: IDS.material,
      castShadow: false,
      receiveShadow: false,
      renderOrder: 0,
      pickable: true,
    },
  };
}

function spriteComponent() {
  return {
    key: 'visual',
    type: 'render.sprite@3',
    properties: {
      textureResourceId: IDS.texture,
      width: 1,
      height: 1,
      material: {
        tintRgba: 0xffff_ffff,
        opacity: 1,
        emissive: 0,
        alphaMode: 'mask',
        alphaCutoff: 0.5,
      },
      alpha: 1,
      frame: 0,
      renderOrder: 1,
      pickable: true,
    },
  };
}

function prefab(id, components) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    revision: 1,
    gameplayType: 'benchmark.item',
    root: { components, children: [] },
  });
}

function itemPrefabs() {
  return Object.freeze({
    mesh: prefab(IDS.prefabMesh, [meshComponent()]),
    sprite: prefab(IDS.prefabSprite, [spriteComponent()]),
    animated: prefab(IDS.prefabAnimated, [
      { key: 'animator', type: 'animation.player@1', properties: { animationId: IDS.animation } },
      spriteComponent(),
    ]),
    model: prefab(IDS.prefabModel, [{
      key: 'visual',
      type: 'render.model@2',
      properties: {
        modelResourceId: IDS.model,
        materialOverrides: {},
        castShadow: false,
        receiveShadow: false,
        renderOrder: 2,
        pickable: true,
      },
    }]),
    surface: prefab(IDS.prefabSurface, [{
      key: 'visual',
      type: 'render.surface@1',
      properties: {
        surfaceResourceId: IDS.surface,
        material: {
          tintRgba: 0x4488_ffff,
          opacity: 0.8,
          emissive: 0,
          alphaMode: 'blend',
          alphaCutoff: 0,
        },
        parameters: {},
        renderOrder: 3,
        pickable: true,
      },
    }]),
    particle: prefab(IDS.prefabParticle, [{
      key: 'visual',
      type: 'render.particle@2',
      properties: {
        particleResourceId: IDS.particle,
        intensity: 1,
        parameters: {
          durationTicks: 60,
          capacity: 4,
          seed: 7,
          rate: 2,
          size: 0.1,
          velocity: [0, 1, 0],
          spread: [0.1, 0.1, 0.1],
          gravity: [0, -1, 0],
          blendMode: 'normal',
        },
        renderOrder: 4,
      },
    }]),
  });
}

function sceneDefinition() {
  return defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'benchmark-scale',
    sceneProfile: 'benchmark.scale.profile',
    rendererProfile: rendererProfile(),
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: composeMatrix4([0, 100, 200]),
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', near: 0.1, far: 10_000, fovYDegrees: 50 },
      }],
    }],
    prefabInstances: [],
  });
}

function nestedOwnerPrefab(bindings, mesh) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: IDS.prefabNestedOwner,
    revision: 1,
    gameplayType: 'benchmark.nested-owner',
    root: { components: [], children: [] },
    prefabSlots: [{
      key: 'items',
      parentLocalPath: null,
      allowedPrefabIds: [mesh.id],
      maximumInstances: bindings,
    }],
    resolveState(state) {
      return { prefabSlots: { items: state.items } };
    },
  });
}

function buildCatalog(options) {
  const items = itemPrefabs();
  const prefabs = Object.values(items);
  if (options.profile === 'nested') prefabs.push(nestedOwnerPrefab(options.bindings, items.mesh));
  const authorityStateSchemas = [
    { gameplayType: 'benchmark.item', schemaId: 'benchmark.item.state@1', revision: 1 },
  ];
  if (options.profile === 'nested') {
    authorityStateSchemas.push({
      gameplayType: 'benchmark.nested-owner',
      schemaId: 'benchmark.nested-owner.state@1',
      revision: 1,
    });
  }
  return {
    items,
    sceneRegistry: createSceneRegistry([sceneDefinition()]),
    prefabRegistry: createPrefabRegistry(prefabs),
    resourceRegistry: createResourceRegistry(resources()),
    componentRegistry: createComponentRegistry(),
    authorityStateSchemas,
  };
}

async function loadBenchmarkResource(descriptor, signal, dependencies) {
  if (signal.aborted) throw new Error('benchmark resource load aborted');
  if (descriptor.kind === 'texture-atlas') {
    const texture = new THREE.Texture();
    texture.needsUpdate = true;
    return { kind: descriptor.kind, descriptor, texture, ownsTexture: true };
  }
  if (descriptor.kind === 'model') {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0, 0.5, 0,
    ], 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const template = new THREE.Group();
    template.add(new THREE.Mesh(geometry, material));
    return { kind: 'model', descriptor, template, templates: [template] };
  }
  return loadThreeResource(descriptor, signal, dependencies);
}

function profileKind(profile, index) {
  if (profile === 'static-mesh' || profile === 'nested') return 'mesh';
  if (profile === 'static-sprite') return 'sprite';
  if (profile === 'animated-sprite') return 'animated';
  // Multiplication by a number coprime to 100 spreads the weighted mix through small fixtures too.
  const bucket = (index * 37) % 100;
  if (bucket < 50) return 'mesh';
  if (bucket < 70) return 'sprite';
  if (bucket < 80) return 'animated';
  if (bucket < 88) return 'model';
  if (bucket < 94) return 'surface';
  return 'particle';
}

function authorityName(index) { return `py/${index}`; }

function transformFor(index, tick, bindings) {
  const width = Math.max(1, Math.ceil(Math.sqrt(bindings)));
  const angle = ((tick * 7 + index) % 360) * Math.PI / 180;
  const scale = 1 + ((tick + index) % 5) * 0.05;
  return composeMatrix4([
      (index % width) + (tick % 11) / 32,
      ((tick + index) % 7) / 16,
      Math.floor(index / width),
    ], [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)],
    [scale, 1 + ((tick + index) % 3) * 0.025, scale]);
}

function nestedEntry(index, tick, bindings) {
  return {
    prefabId: IDS.prefabMesh,
    transform: transformFor(index, tick, bindings),
    visible: true,
    state: {},
  };
}

function initialNestedItems(bindings) {
  return Object.fromEntries(Array.from({ length: bindings }, (_, index) => [
    `item-${String(index).padStart(5, '0')}`,
    nestedEntry(index, 0, bindings),
  ]));
}

function elapsedMilliseconds(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))];
}

function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }

function durationSummary(samples) {
  const values = Array.from(samples);
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    totalMs: round(total),
    minimumMs: round(percentile(sorted, 0)),
    p50Ms: round(percentile(sorted, 0.50)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maximumMs: round(percentile(sorted, 1)),
    meanMs: round(total / Math.max(1, values.length)),
  };
}

function forceGc() {
  if (typeof globalThis.gc !== 'function') return;
  for (let index = 0; index < 3; index += 1) globalThis.gc();
}

function memorySnapshot(stage) {
  forceGc();
  const value = process.memoryUsage();
  return {
    stage,
    heapUsedBytes: value.heapUsed,
    heapTotalBytes: value.heapTotal,
    rssBytes: value.rss,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

function createBackendFactory(backends, renderers, lifecycle) {
  return (options) => {
    const renderer = new TestRenderer();
    const backend = new ThreeRenderBackend(options, {
      ...DEFAULT_THREE_IMPLEMENTATION,
      createRenderer: () => renderer,
      createResizeObserver: () => ({
        observe() {},
        disconnect() { lifecycle.observerDisconnects += 1; },
      }),
      devicePixelRatio: () => 1,
      loadResource: loadBenchmarkResource,
      disposeResource: disposeThreeResource,
    });
    backends.push(backend);
    renderers.push(renderer);
    return backend;
  };
}

function expectedBatchShape(profile, selectionCounts) {
  const eligible = [];
  if (profile === 'static-mesh' || profile === 'nested') eligible.push(selectionCounts.mesh);
  else if (profile === 'static-sprite') eligible.push(selectionCounts.sprite);
  else if (profile === 'mixed') eligible.push(selectionCounts.mesh, selectionCounts.sprite);
  const groups = eligible.filter((count) => count >= 2);
  return {
    batchCount: groups.length,
    instanceCount: groups.reduce((sum, count) => sum + count, 0),
  };
}

function structureSnapshot(runtime, backend, baselineNodeCount, objectBindings, selectionCounts) {
  let componentCount = 0;
  let authorityRoots = 0;
  let prefabLocalNodes = 0;
  for (const node of runtime._nodeIndex.values()) {
    componentCount += node.components.length;
    if (node.name.startsWith('py/')) authorityRoots += 1;
    if (node.name.startsWith('prefab/')) prefabLocalNodes += 1;
  }
  const diagnostics = backend.diagnostics();
  return {
    objectBindings,
    baselineNodeCount,
    authorityRoots,
    prefabLocalNodes,
    nodeCount: runtime._nodeIndex.size,
    componentCount,
    renderSystemEntries: runtime._renderSystem._entries.size,
    animationPlayers: runtime._animationSystem._players.size,
    selectionCounts,
    backend: diagnostics,
  };
}

function createFixture(runtime, catalog, options) {
  const samples = [];
  const selectionCounts = {
    mesh: 0,
    sprite: 0,
    animated: 0,
    model: 0,
    surface: 0,
    particle: 0,
  };
  let nestedItems = null;
  if (options.profile === 'nested') {
    runtime.authority.installNodeMatrixPool({
      poolSize: 1,
      matrices: new Float32Array(IDENTITY),
    });
    nestedItems = initialNestedItems(options.bindings);
    selectionCounts.mesh = options.bindings;
    const started = process.hrtime.bigint();
    runtime.authority.createNode({
      nodeId: 0,
      parentNodeId: null,
      prefabId: IDS.prefabNestedOwner,
      transformMode: 'live',
      visible: true,
      state: { items: nestedItems },
    });
    samples.push(elapsedMilliseconds(started));
    return { samples, selectionCounts, nestedItems, authorityRoots: 1 };
  }

  const matrixPool = new Float32Array(options.bindings * 16);
  for (let index = 0; index < options.bindings; index += 1) {
    matrixPool.set(transformFor(index, 0, options.bindings), index * 16);
  }
  runtime.authority.installNodeMatrixPool({
    poolSize: options.bindings,
    matrices: matrixPool,
  });
  for (let index = 0; index < options.bindings; index += 1) {
    const kind = profileKind(options.profile, index);
    selectionCounts[kind] += 1;
    const started = process.hrtime.bigint();
    runtime.authority.createNode({
      nodeId: index,
      parentNodeId: null,
      prefabId: catalog.items[kind].id,
      transformMode: 'live',
      visible: true,
      state: {},
    });
    samples.push(elapsedMilliseconds(started));
  }
  return { samples, selectionCounts, nestedItems, authorityRoots: options.bindings };
}

function applyTick(runtime, fixture, options, state) {
  const updateCount = Math.min(
    options.bindings,
    Math.max(options.updateRatio === 0 ? 0 : 1, Math.floor(options.bindings * options.updateRatio)),
  );
  const nextCommitSeq = state.commitSeq + 1;
  state.lastTransforms = [];
  if (options.profile === 'nested') {
    const nextItems = { ...fixture.nestedItems };
    for (let ordinal = 0; ordinal < updateCount; ordinal += 1) {
      const index = (state.logicalUpdates + ordinal) % options.bindings;
      const key = `item-${String(index).padStart(5, '0')}`;
      const nextEntry = nestedEntry(
        index,
        nextCommitSeq,
        options.bindings,
      );
      nextItems[key] = nextEntry;
      state.lastTransforms.push({
        name: `prefab/py/0/items/${key}`,
        expected: nextEntry.transform,
      });
    }
    const cursor = {
      commitSeq: nextCommitSeq,
      sourceTick: nextCommitSeq,
      lastCommandSeq: state.lastCommandSeq + 1,
    };
    runtime.commitGate.begin(cursor);
    try {
      runtime.authority.applyNodeTransformBatch({
        poolSize: 1,
        nodeIds: new Uint32Array(),
        matrices: new Float32Array(),
      });
      runtime.authority.setNodeState({ nodeId: 0, state: { items: nextItems } });
      runtime.commitGate.seal(cursor);
    } catch (error) {
      runtime.commitGate.fail(error);
      throw error;
    }
    fixture.nestedItems = nextItems;
    state.lastCommandSeq += 1;
  } else {
    const cursor = {
      commitSeq: nextCommitSeq,
      sourceTick: nextCommitSeq,
      lastCommandSeq: state.lastCommandSeq + updateCount,
    };
    runtime.commitGate.begin(cursor);
    try {
      const updates = [];
      for (let ordinal = 0; ordinal < updateCount; ordinal += 1) {
        const index = (state.logicalUpdates + ordinal) % options.bindings;
        const nextTransform = transformFor(index, nextCommitSeq, options.bindings);
        updates.push({ nodeId: index, transform: nextTransform });
        state.lastTransforms.push({ name: authorityName(index), expected: nextTransform });
      }
      const sorted = [...updates].sort((left, right) => left.nodeId - right.nodeId);
      const matrices = new Float32Array(sorted.length * 16);
      sorted.forEach(({ transform }, index) => matrices.set(transform, index * 16));
      runtime.authority.applyNodeTransformBatch({
        poolSize: options.bindings,
        nodeIds: new Uint32Array(sorted.map(({ nodeId }) => nodeId)),
        matrices,
      });
      for (const { nodeId } of updates) runtime.authority.setNodeTransform({ nodeId });
      runtime.commitGate.seal(cursor);
    } catch (error) {
      runtime.commitGate.fail(error);
      throw error;
    }
    state.lastCommandSeq += updateCount;
  }
  state.logicalUpdates += updateCount;
  state.commitSeq = nextCommitSeq;
  return updateCount;
}

function sameTransform(left, right) {
  return matrix4AlmostEqual(left, right);
}

function sampleFinalTransforms(runtime, fixture, options, state) {
  let candidates = state.lastTransforms;
  if (candidates.length === 0) {
    if (options.profile === 'nested') {
      const key = 'item-00000';
      candidates = [{
        name: `prefab/py/0/items/${key}`,
        expected: fixture.nestedItems[key].transform,
      }];
    } else {
      candidates = [{ name: authorityName(0), expected: transformFor(0, 0, options.bindings) }];
    }
  }
  const indices = [...new Set([0, Math.floor((candidates.length - 1) / 2), candidates.length - 1])];
  const view = runtime.currentView();
  return indices.map((index) => {
    const candidate = candidates[index];
    const actual = view.getNode(candidate.name).localTransform;
    return {
      name: candidate.name,
      expected: candidate.expected,
      actual,
      matches: sameTransform(candidate.expected, actual),
    };
  });
}

function requireOneFrame(frames, label) {
  const callbacks = frames.step();
  if (callbacks !== 1) throw new Error(`${label} scheduled ${callbacks} frame callbacks instead of 1`);
}

function finalOwnership(runtimeRefs, backends, renderers, lifecycle, frames) {
  const backendDiagnostics = backends.map((backend) => backend.diagnostics());
  const zeroBackend = backendDiagnostics.every((diagnostics) => diagnostics.bindingCount === 0
    && diagnostics.nodeBindingCount === 0
    && diagnostics.batchCount === 0
    && diagnostics.instanceCount === 0
    && diagnostics.resourceCount === 0
    && diagnostics.resourceLeaseCount === 0
    && diagnostics.pendingBindingCount === 0
    && diagnostics.pendingResourceCount === 0
    && diagnostics.disposed === true);
  const counts = {
    nodeIndexCount: runtimeRefs.nodeIndex.size,
    schedulerHandlerCount: runtimeRefs.scheduler._registered.size,
    renderSystemEntryCount: runtimeRefs.renderSystem._entries.size,
    animationPlayerCount: runtimeRefs.animationSystem._players.size,
    prefabScopeCount: runtimeRefs.prefabInstantiator._scopes.size,
    sceneScopeCount: runtimeRefs.sceneLoader._scopes.length,
    pendingFrameCount: frames.pendingCount,
    backendCount: backends.length,
    observerDisconnectCount: lifecycle.observerDisconnects,
    disposedRendererCount: renderers.filter((renderer) => renderer.disposed).length,
  };
  const zeroRuntime = counts.nodeIndexCount === 0
    && counts.schedulerHandlerCount === 0
    && counts.renderSystemEntryCount === 0
    && counts.animationPlayerCount === 0
    && counts.prefabScopeCount === 0
    && counts.sceneScopeCount === 0
    && counts.pendingFrameCount === 0;
  return {
    counts,
    backendDiagnostics,
    returnedToZero: zeroBackend && zeroRuntime
      && counts.observerDisconnectCount === counts.backendCount
      && counts.disposedRendererCount === counts.backendCount,
  };
}

async function runBenchmark(options) {
  const memory = [memorySnapshot('before')];
  const totalStarted = process.hrtime.bigint();
  const catalogStarted = process.hrtime.bigint();
  const catalog = buildCatalog(options);
  const catalogDuration = elapsedMilliseconds(catalogStarted);
  const frames = new FrameAdapter();
  const backends = [];
  const renderers = [];
  const healthEvents = [];
  const lifecycle = { observerDisconnects: 0 };
  const baselineNodeCountStarted = process.hrtime.bigint();
  const runtime = createDisplayRuntime({
    hostElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1_280, height: 720 }),
    },
    canvas: {
      getContext: () => ({}),
      toDataURL: () => 'data:image/png;base64,benchmark',
    },
    sceneRegistry: catalog.sceneRegistry,
    prefabRegistry: catalog.prefabRegistry,
    resourceRegistry: catalog.resourceRegistry,
    componentRegistry: catalog.componentRegistry,
    authorityStateSchemas: catalog.authorityStateSchemas,
    createRenderBackend: createBackendFactory(backends, renderers, lifecycle),
    frameAdapter: frames,
    onHealth: (event) => healthEvents.push(event),
  });
  let disposalStarted = false;
  try {
  const runtimeConstructDuration = elapsedMilliseconds(baselineNodeCountStarted);
  const installStarted = process.hrtime.bigint();
  runtime.installScene({ sceneName: 'benchmark-scale' });
  const installDuration = elapsedMilliseconds(installStarted);
  const baselineNodeCount = runtime.summary().nodeCount;
  const authorityStarted = process.hrtime.bigint();
  const fixture = createFixture(runtime, catalog, options);
  const authorityTotalDuration = elapsedMilliseconds(authorityStarted);
  const activateStarted = process.hrtime.bigint();
  runtime.activate({ commitSeq: 0, sourceTick: 0, lastCommandSeq: 0 });
  runtime.start();
  const activateDuration = elapsedMilliseconds(activateStarted);
  const readyStarted = process.hrtime.bigint();
  await runtime.whenReady();
  const readyDuration = elapsedMilliseconds(readyStarted);
  const initialFrameStarted = process.hrtime.bigint();
  requireOneFrame(frames, 'initial fixture');
  const initialFrameDuration = elapsedMilliseconds(initialFrameStarted);
  const creationTotalDuration = elapsedMilliseconds(totalStarted);
  const firstBackend = backends[0];
  const initialStructure = structureSnapshot(
    runtime,
    firstBackend,
    baselineNodeCount,
    options.bindings,
    fixture.selectionCounts,
  );
  const authorityCreateOperationSummary = durationSummary(fixture.samples);
  memory.push(memorySnapshot('after-create'));

  const expectedBatches = expectedBatchShape(options.profile, fixture.selectionCounts);
  const expectedNodeCount = baselineNodeCount + options.bindings
    + (options.profile === 'nested' ? 1 : 0);
  const structureChecks = {
    exactAuthorityRoots: initialStructure.authorityRoots === fixture.authorityRoots,
    exactNodeCount: initialStructure.nodeCount === expectedNodeCount,
    exactRenderBindings: initialStructure.backend.bindingCount === options.bindings + 1,
    exactRenderEntries: initialStructure.renderSystemEntries === options.bindings + 1,
    exactBatchCount: initialStructure.backend.batchCount === expectedBatches.batchCount,
    exactBatchInstances: initialStructure.backend.instanceCount === expectedBatches.instanceCount,
    exactAnimationPlayers: initialStructure.animationPlayers === fixture.selectionCounts.animated,
    noInitialPendingWork: initialStructure.backend.pendingBindingCount === 0
      && initialStructure.backend.pendingResourceCount === 0,
  };

  const state = { commitSeq: 0, lastCommandSeq: 0, logicalUpdates: 0, lastTransforms: [] };
  for (let tick = 0; tick < options.warmup; tick += 1) {
    applyTick(runtime, fixture, options, state);
    requireOneFrame(frames, `warmup ${tick + 1}`);
  }

  const commitSamples = [];
  const frameSamples = [];
  let measuredLogicalUpdates = 0;
  for (let tick = 0; tick < options.ticks; tick += 1) {
    const commitStarted = process.hrtime.bigint();
    measuredLogicalUpdates += applyTick(runtime, fixture, options, state);
    commitSamples.push(elapsedMilliseconds(commitStarted));
    const frameStarted = process.hrtime.bigint();
    requireOneFrame(frames, `measured tick ${tick + 1}`);
    frameSamples.push(elapsedMilliseconds(frameStarted));
  }
  const beforeRebuildStructure = structureSnapshot(
    runtime,
    backends.at(-1),
    baselineNodeCount,
    options.bindings,
    fixture.selectionCounts,
  );
  const finalCursor = runtime.summary().cursor;
  const transformSamples = sampleFinalTransforms(runtime, fixture, options, state);
  memory.push(memorySnapshot('after-ticks'));

  const rebuildStarted = process.hrtime.bigint();
  await runtime.rebuildRenderBackend();
  const rebuildRemountDuration = elapsedMilliseconds(rebuildStarted);
  const rebuildFrameStarted = process.hrtime.bigint();
  requireOneFrame(frames, 'backend rebuild');
  const rebuildFrameDuration = elapsedMilliseconds(rebuildFrameStarted);
  const rebuiltBackend = backends.at(-1);
  const rebuiltStructure = structureSnapshot(
    runtime,
    rebuiltBackend,
    baselineNodeCount,
    options.bindings,
    fixture.selectionCounts,
  );
  memory.push(memorySnapshot('after-rebuild'));

  const runtimeRefs = {
    nodeIndex: runtime._nodeIndex,
    scheduler: runtime._scheduler,
    renderSystem: runtime._renderSystem,
    animationSystem: runtime._animationSystem,
    prefabInstantiator: runtime._prefabInstantiator,
    sceneLoader: runtime._sceneLoader,
  };
  const disposeStarted = process.hrtime.bigint();
  disposalStarted = true;
  await runtime.dispose();
  const disposeDuration = elapsedMilliseconds(disposeStarted);
  const ownership = finalOwnership(runtimeRefs, backends, renderers, lifecycle, frames);
  fixture.samples.length = 0;
  fixture.nestedItems = null;
  memory.push(memorySnapshot('after-dispose'));

  const rebuildChecks = {
    backendWasReplaced: backends.length === 2,
    exactNodeCount: rebuiltStructure.nodeCount === initialStructure.nodeCount,
    exactRenderBindings: rebuiltStructure.backend.bindingCount === options.bindings + 1,
    exactBatchCount: rebuiltStructure.backend.batchCount === expectedBatches.batchCount,
    exactBatchInstances: rebuiltStructure.backend.instanceCount === expectedBatches.instanceCount,
    exactAnimationPlayers: rebuiltStructure.animationPlayers === fixture.selectionCounts.animated,
    noPendingWork: rebuiltStructure.backend.pendingBindingCount === 0
      && rebuiltStructure.backend.pendingResourceCount === 0,
  };
  const checks = {
    structure: Object.values(structureChecks).every(Boolean),
    cursor: state.commitSeq === options.warmup + options.ticks
      && finalCursor.commitSeq === state.commitSeq
      && finalCursor.sourceTick === state.commitSeq
      && finalCursor.lastCommandSeq === state.lastCommandSeq,
    transforms: transformSamples.every((sample) => sample.matches),
    rebuild: Object.values(rebuildChecks).every(Boolean),
    health: healthEvents.length === 0,
    disposal: ownership.returnedToZero,
  };
  const passed = Object.values(checks).every(Boolean);
  const cpuInfo = os.cpus();
  return {
    schema: 'scene-engine-display-runtime-scale@2',
    status: passed ? (options.quick ? 'QUICK PASS' : 'READY') : 'NOT READY',
    mode: options.quick ? 'quick' : 'formal',
    configuration: {
      profile: options.profile,
      requestedBindings: options.bindings,
      measuredTicks: options.ticks,
      warmupTicks: options.warmup,
      updateRatio: options.updateRatio,
      measuredLogicalUpdates,
      authoritativeRateHz: TICKS_PER_SECOND,
      renderer: 'ThreeRenderBackend with deterministic TestRenderer',
      networkAccess: false,
      nestedMutationMode: options.profile === 'nested'
        ? 'one complete desired-set state command per tick'
        : null,
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      explicitGc: typeof globalThis.gc === 'function',
    },
    hardware: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      cpuModel: cpuInfo[0]?.model ?? null,
      logicalCpuCount: cpuInfo.length,
      totalMemoryBytes: os.totalmem(),
    },
    fixture: initialStructure,
    steadyState: beforeRebuildStructure,
    transformSamples,
    finalCursor,
    rebuilt: rebuiltStructure,
    timings: {
      creation: {
        total: durationSummary([creationTotalDuration]),
        catalog: durationSummary([catalogDuration]),
        runtimeConstruct: durationSummary([runtimeConstructDuration]),
        sceneInstall: durationSummary([installDuration]),
        authorityCreateTotal: durationSummary([authorityTotalDuration]),
        authorityCreateOperations: authorityCreateOperationSummary,
        activateAndStart: durationSummary([activateDuration]),
        resourceReady: durationSummary([readyDuration]),
        firstFrame: durationSummary([initialFrameDuration]),
      },
      commit: durationSummary(commitSamples),
      frame: durationSummary(frameSamples),
      rebuild: {
        remount: durationSummary([rebuildRemountDuration]),
        firstFrame: durationSummary([rebuildFrameDuration]),
        total: durationSummary([rebuildRemountDuration + rebuildFrameDuration]),
      },
      dispose: durationSummary([disposeDuration]),
    },
    memory,
    lifecycle: ownership,
    healthEvents,
    checks: {
      ...checks,
      structureDetails: structureChecks,
      rebuildDetails: rebuildChecks,
    },
  };
  } finally {
    if (!disposalStarted) await runtime.dispose();
  }
}

function parsePositiveInteger(name, raw, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseOptions(arguments_) {
  let quick = false;
  let bindings = 500;
  let profile = 'static-mesh';
  let ticks = null;
  let warmup = null;
  let updateRatio = 0.01;
  for (const argument of arguments_) {
    if (argument === '--quick') {
      quick = true;
      continue;
    }
    let match = /^--bindings=(\d+)$/u.exec(argument);
    if (match) {
      bindings = parsePositiveInteger('bindings', match[1], { maximum: MAXIMUM_BINDINGS });
      continue;
    }
    match = /^--profile=(.+)$/u.exec(argument);
    if (match) {
      profile = match[1];
      continue;
    }
    match = /^--ticks=(\d+)$/u.exec(argument);
    if (match) {
      ticks = parsePositiveInteger('ticks', match[1]);
      continue;
    }
    match = /^--warmup=(\d+)$/u.exec(argument);
    if (match) {
      warmup = parsePositiveInteger('warmup', match[1], { minimum: 0 });
      continue;
    }
    match = /^--update-ratio=(.+)$/u.exec(argument);
    if (match) {
      updateRatio = Number(match[1]);
      if (!Number.isFinite(updateRatio) || updateRatio < 0 || updateRatio > 1) {
        throw new Error('update-ratio must be a finite number between 0 and 1');
      }
      continue;
    }
    throw new Error(`unknown benchmark option: ${argument}`);
  }
  if (!PROFILE_SET.has(profile)) {
    throw new Error(`profile must be one of: ${PROFILE_NAMES.join(', ')}`);
  }
  return Object.freeze({
    quick,
    bindings,
    profile,
    ticks: ticks ?? (quick ? 6 : 120),
    warmup: warmup ?? (quick ? 1 : 5),
    updateRatio,
  });
}

async function main() {
  if (typeof globalThis.gc !== 'function') {
    const child = spawnSync(process.execPath, [
      '--expose-gc',
      SCRIPT_PATH,
      ...process.argv.slice(2),
    ], { cwd: process.cwd(), stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  }
  const options = parseOptions(process.argv.slice(2));
  const report = await runBenchmark(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status === 'NOT READY') process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
