#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BehaviourComponent,
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FORMAL_OUTPUT = 'docs/evidence/display-node-cutover/js-display-runtime-500-formal.json';
const AUTHORITY_ROOTS = 500;
const INITIAL_ROOTS = 250;
const PREFAB_LOCAL_NODES_PER_ROOT = 2;
const BEHAVIOUR_ROOTS = 20;
const COMMANDS_PER_TICK = 40;
const FORMAL_VALIDATION_TICKS = 600;
const FORMAL_SOAK_TICKS = 36_000;
const QUICK_VALIDATION_TICKS = 30;
const QUICK_SOAK_TICKS = 120;
const TICK_MS = 1_000 / 60;
const FRAME_BUDGET_MS = TICK_MS;
const PREPARE_P95_TARGET_MS = 8;
const HEAP_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_CONSECUTIVE_FRAME_OVERRUNS = 3;
const IDENTITY = Object.freeze({
  position: Object.freeze([0, 0, 0]),
  rotationXyzw: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
});
const RENDERER_PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x1020_30ff,
  antialias: false,
  alpha: false,
  shadows: false,
  toneMapping: 'none',
});
const RESOURCES = Object.freeze([
  Object.freeze({
    id: 'benchmark/mesh',
    kind: 'mesh',
    positions: Object.freeze([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]),
    indices: Object.freeze([0, 1, 2]),
  }),
  Object.freeze({
    id: 'benchmark/material',
    kind: 'material',
    family: 'material.standard',
    properties: Object.freeze({
      tintRgba: 0xffff_ffff,
      opacity: 1,
      emissive: 0,
      alphaMode: 'opaque',
      alphaCutoff: 0,
    }),
  }),
]);

let behaviourTicks = 0;

class BenchmarkBehaviour extends BehaviourComponent {
  static typeId = 'benchmark.tick-behaviour@1';
  static tickPhase = 'update';

  tick(frame) {
    if (!Number.isSafeInteger(frame.sourceTick)) throw new Error('benchmark source tick invalid');
    behaviourTicks += 1;
  }
}

class FrameAdapter {
  constructor() {
    this.time = 0;
    this.next = 1;
    this.callbacks = new Map();
  }

  request(callback) {
    const identity = this.next;
    this.next += 1;
    this.callbacks.set(identity, callback);
    return identity;
  }

  cancel(identity) { this.callbacks.delete(identity); }
  now() { return this.time; }
  get pendingCount() { return this.callbacks.size; }

  step(milliseconds = TICK_MS) {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
    return callbacks.length;
  }
}

class EvidenceRenderer {
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
    // WebGLRenderer performs this propagation internally. The DisplayRuntime does not
    // force a second Three tree prepass.
    scene.updateMatrixWorld();
    this.draws += 1;
    this.info.render.calls += 1;
  }

  dispose() { this.disposed = true; }
}

function prefab({ gameplayType, withBehaviour }) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: `benchmark.${gameplayType}`,
    gameplayType,
    root: {
      components: [],
      children: [
        {
          localName: 'visual',
          transform: IDENTITY,
          visible: true,
          components: [{
            key: 'mesh',
            type: 'render.mesh@1',
            properties: {
              meshResourceId: 'benchmark/mesh',
              materialResourceId: 'benchmark/material',
              castShadow: false,
              receiveShadow: false,
              renderOrder: 0,
              pickable: true,
            },
          }],
          children: [],
        },
        {
          localName: withBehaviour ? 'behaviour' : 'marker',
          transform: IDENTITY,
          visible: true,
          components: withBehaviour ? [{
            key: 'tick',
            type: BenchmarkBehaviour.typeId,
            properties: {},
          }] : [],
          children: [],
        },
      ],
    },
    resolveState(state) {
      const phase = Number.isSafeInteger(state.phase) ? state.phase : 0;
      return {
        nodes: {
          visual: {
            transform: {
              position: [0, (phase % 17) / 16, 0],
              rotationXyzw: [0, 0, 0, 1],
              scale: [1, 1, 1],
            },
          },
        },
      };
    },
  });
}

function makeScene() {
  return defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'benchmark',
    sceneProfile: 'benchmark.profile',
    rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: {
        position: [0, 80, 160],
        rotationXyzw: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', near: 0.1, far: 1_000, fovYDegrees: 50 },
      }],
    }],
    prefabInstances: [],
  });
}

function initialTransform(index) {
  return Object.freeze({
    position: Object.freeze([(index % 25) * 2, 0, Math.floor(index / 25) * 2]),
    rotationXyzw: IDENTITY.rotationXyzw,
    scale: IDENTITY.scale,
  });
}

function liveTransform(index, tick, ordinal) {
  return Object.freeze({
    position: Object.freeze([
      (index % 25) * 2 + ((tick + ordinal) % 13) / 32,
      ((tick * 3 + ordinal) % 19) / 32,
      Math.floor(index / 25) * 2,
    ]),
    rotationXyzw: IDENTITY.rotationXyzw,
    scale: IDENTITY.scale,
  });
}

function createModel() {
  return Array.from({ length: AUTHORITY_ROOTS }, (_, index) => ({
    name: `py/benchmark-${index}`,
    parentName: 'sys/authority-root',
    transform: initialTransform(index),
    visible: true,
    phase: 0,
  }));
}

function buildCommands(tick, model) {
  const commands = [];
  for (let ordinal = 0; ordinal < 20; ordinal += 1) {
    const index = INITIAL_ROOTS + ordinal;
    const transform = liveTransform(index, tick, ordinal);
    commands.push({ kind: 'transform', name: model[index].name, transform });
    model[index].transform = transform;
  }
  for (let ordinal = 0; ordinal < 10; ordinal += 1) {
    const index = INITIAL_ROOTS + 20 + ordinal;
    const phase = tick + ordinal;
    commands.push({ kind: 'state', name: model[index].name, state: { phase } });
    model[index].phase = phase;
  }
  for (let ordinal = 0; ordinal < 8; ordinal += 1) {
    const index = INITIAL_ROOTS + 30 + ordinal;
    const visible = ((tick + ordinal) & 1) === 0;
    commands.push({ kind: 'visible', name: model[index].name, visible });
    model[index].visible = visible;
  }
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const index = INITIAL_ROOTS + 38 + ordinal;
    const parentIndex = INITIAL_ROOTS + 40 + ordinal;
    const parentName = (tick & 1) === 0 ? model[parentIndex].name : null;
    commands.push({ kind: 'parent', name: model[index].name, parentName });
    model[index].parentName = parentName ?? 'sys/authority-root';
  }
  if (commands.length !== COMMANDS_PER_TICK) throw new Error('benchmark command count drift');
  return commands;
}

function applyCommand(authority, command) {
  switch (command.kind) {
    case 'transform': authority.setNodeTransform({ name: command.name, transform: command.transform }); break;
    case 'state': authority.setNodeState({ name: command.name, state: command.state }); break;
    case 'visible': authority.setNodeVisible({ name: command.name, visible: command.visible }); break;
    case 'parent': authority.setNodeParent({ name: command.name, parentName: command.parentName }); break;
    default: throw new Error(`unknown benchmark command: ${command.kind}`);
  }
}

function createMetrics(totalTicks) {
  return {
    commandApplyUs: new Float64Array(totalTicks),
    transformFlushUs: new Float64Array(totalTicks),
    renderPrepareUs: new Float64Array(totalTicks),
    backendPrepareUs: new Float64Array(totalTicks),
    framePredrawUs: new Float64Array(totalTicks),
    frameTotalUs: new Float64Array(totalTicks),
    totalCpuPredrawUs: new Float64Array(totalTicks),
    commandBytes: new Uint32Array(totalTicks),
  };
}

function microseconds(start, end = process.hrtime.bigint()) {
  return Number(end - start) / 1_000;
}

function instrumentRuntime(runtime, metrics, current) {
  const graph = runtime._nodeGraph;
  const flush = graph.flushWorldTransforms.bind(graph);
  graph.flushWorldTransforms = (...args) => {
    const started = process.hrtime.bigint();
    const result = flush(...args);
    if (current.index >= 0) metrics.transformFlushUs[current.index] += microseconds(started);
    return result;
  };

  const renderSystem = runtime._renderSystem;
  const prepare = renderSystem.prepareFrame.bind(renderSystem);
  renderSystem.prepareFrame = (...args) => {
    const started = process.hrtime.bigint();
    const result = prepare(...args);
    if (current.index >= 0) metrics.renderPrepareUs[current.index] += microseconds(started);
    return result;
  };

  const nodeIndex = runtime._nodeIndex;
  const values = nodeIndex.values.bind(nodeIndex);
  const get = nodeIndex.get.bind(nodeIndex);
  nodeIndex.values = (...args) => {
    if (current.measuredPath) current.fullTreeScans += 1;
    return values(...args);
  };
  nodeIndex.get = (...args) => {
    if (current.measuredPath) current.directLookups += 1;
    return get(...args);
  };
}

function instrumentBackend(backend, metrics, current) {
  const prepare = backend.prepareFrame.bind(backend);
  backend.prepareFrame = (...args) => {
    const started = process.hrtime.bigint();
    const result = prepare(...args);
    if (current.index >= 0) metrics.backendPrepareUs[current.index] += microseconds(started);
    return result;
  };
  const render = backend.render.bind(backend);
  backend.render = (...args) => {
    if (current.index >= 0 && current.frameStarted !== null) {
      metrics.framePredrawUs[current.index] = microseconds(current.frameStarted);
    }
    return render(...args);
  };
}

function assertFixture(runtime, backend) {
  const view = runtime.currentView();
  const snapshot = view.snapshot();
  const authorityRoots = snapshot.nodes.filter((node) => node.name.startsWith('py/')).length;
  const prefabLocalNodes = snapshot.nodes.filter((node) => node.name.startsWith('prefab/')).length;
  const diagnostics = backend.diagnostics();
  const componentCount = [...runtime._nodeIndex.values()]
    .reduce((count, node) => count + node.components.length, 0);
  const schedulerHandlers = runtime._scheduler._registered.size;
  const fixture = {
    authorityRoots,
    initialAuthorityRoots: INITIAL_ROOTS,
    liveAuthorityRoots: AUTHORITY_ROOTS - INITIAL_ROOTS,
    prefabLocalNodes,
    nodeIndexCount: view.nodeCount,
    componentCount,
    schedulerHandlerCount: schedulerHandlers,
    renderBindingCount: diagnostics.bindingCount,
    backendNodeBindingCount: diagnostics.nodeBindingCount,
    batchCount: diagnostics.batchCount,
    batchInstanceCount: diagnostics.instanceCount,
    resourceCount: diagnostics.resourceCount,
    resourceLeaseCount: diagnostics.resourceLeaseCount,
  };
  const expected = {
    authorityRoots: AUTHORITY_ROOTS,
    initialAuthorityRoots: INITIAL_ROOTS,
    liveAuthorityRoots: AUTHORITY_ROOTS - INITIAL_ROOTS,
    prefabLocalNodes: AUTHORITY_ROOTS * PREFAB_LOCAL_NODES_PER_ROOT,
    nodeIndexCount: 1_503,
    schedulerHandlerCount: BEHAVIOUR_ROOTS,
    renderBindingCount: 501,
    backendNodeBindingCount: 501,
    batchCount: 1,
    batchInstanceCount: 500,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (fixture[key] !== value) throw new Error(`fixture ${key}: expected ${value}, got ${fixture[key]}`);
  }
  return fixture;
}

function validateRuntime(runtime, model, expectedCursor) {
  const view = runtime.currentView();
  if (view.nodeCount !== 1_503) throw new Error(`NodeIndex drift at tick ${expectedCursor.sourceTick}`);
  if (JSON.stringify(view.cursor) !== JSON.stringify(expectedCursor)) {
    throw new Error(`cursor drift at tick ${expectedCursor.sourceTick}`);
  }
  for (let index = 0; index < model.length; index += 1) {
    const expected = model[index];
    const node = view.getNode(expected.name);
    if (!node) throw new Error(`missing authority node ${expected.name}`);
    if (node.parentName !== expected.parentName
        || node.visibleSelf !== expected.visible
        || JSON.stringify(node.localTransform) !== JSON.stringify(expected.transform)) {
      throw new Error(`authority state drift for ${expected.name}`);
    }
    const visual = view.getNode(`prefab/${expected.name}/visual`);
    if (!visual || visual.parentName !== expected.name
        || visual.localTransform.position[1] !== (expected.phase % 17) / 16
        || view.getAuthorityOwner(visual.name) !== expected.name) {
      throw new Error(`prefab-local state drift for ${expected.name}`);
    }
  }
  return view;
}

function semanticRecord(view) {
  return {
    cursor: view.cursor,
    nodes: view.snapshot().nodes
      .filter((node) => node.name.startsWith('py/') || node.name.startsWith('prefab/'))
      .map((node) => ({
        name: node.name,
        parentName: node.parentName,
        localTransform: node.localTransform,
        visibleSelf: node.visibleSelf,
        componentKeys: node.componentKeys,
        authorityOwnerName: node.authorityOwnerName,
      })),
  };
}

function expectedSemanticRecord(model, cursor) {
  const nodes = [];
  for (let index = 0; index < model.length; index += 1) {
    const item = model[index];
    nodes.push({
      name: item.name,
      parentName: item.parentName,
      localTransform: item.transform,
      visibleSelf: item.visible,
      componentKeys: ['authority'],
      authorityOwnerName: item.name,
    });
    nodes.push({
      name: `prefab/${item.name}/visual`,
      parentName: item.name,
      localTransform: {
        position: [0, (item.phase % 17) / 16, 0],
        rotationXyzw: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      visibleSelf: true,
      componentKeys: ['mesh'],
      authorityOwnerName: item.name,
    });
    nodes.push({
      name: `prefab/${item.name}/${index < BEHAVIOUR_ROOTS ? 'behaviour' : 'marker'}`,
      parentName: item.name,
      localTransform: IDENTITY,
      visibleSelf: true,
      componentKeys: index < BEHAVIOUR_ROOTS ? ['tick'] : [],
      authorityOwnerName: item.name,
    });
  }
  // Runtime insertion order is all nodes for each authority root, so this array already
  // matches the canonical NodeIndex traversal order used by DisplayView.
  return { cursor, nodes };
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function forceGc() {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('formal Display benchmark requires node --expose-gc');
  }
  for (let index = 0; index < 3; index += 1) globalThis.gc();
}

function memorySnapshot(tick) {
  forceGc();
  const value = process.memoryUsage();
  return {
    tick,
    heapUsedBytes: value.heapUsed,
    heapTotalBytes: value.heapTotal,
    rssBytes: value.rss,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))];
}

function summary(values) {
  const samples = Array.from(values);
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    samples: samples.length,
    minimumMs: round(percentile(sorted, 0) / 1_000),
    p50Ms: round(percentile(sorted, 0.50) / 1_000),
    p95Ms: round(percentile(sorted, 0.95) / 1_000),
    p99Ms: round(percentile(sorted, 0.99) / 1_000),
    maximumMs: round(percentile(sorted, 1) / 1_000),
    meanMs: round(total / Math.max(1, samples.length) / 1_000),
  };
}

function commandSizeSummary(values) {
  const samples = Array.from(values);
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: samples.length,
    minimumBytes: percentile(sorted, 0),
    p50Bytes: percentile(sorted, 0.50),
    p95Bytes: percentile(sorted, 0.95),
    p99Bytes: percentile(sorted, 0.99),
    maximumBytes: percentile(sorted, 1),
    totalBytes: samples.reduce((sum, value) => sum + value, 0),
  };
}

function secondWindows(metrics, start, length) {
  const result = [];
  for (let offset = 0; offset < length; offset += 60) {
    const from = start + offset;
    const to = Math.min(start + length, from + 60);
    result.push({
      second: Math.floor(offset / 60),
      ticks: to - from,
      commandApply: summary(metrics.commandApplyUs.subarray(from, to)),
      transformFlush: summary(metrics.transformFlushUs.subarray(from, to)),
      renderPrepare: summary(metrics.renderPrepareUs.subarray(from, to)),
      totalCpuPredraw: summary(metrics.totalCpuPredrawUs.subarray(from, to)),
    });
  }
  return result;
}

function longestConsecutiveOver(values, thresholdUs) {
  let longest = 0;
  let current = 0;
  for (const value of values) {
    if (value > thresholdUs) {
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  return longest;
}

function topSlowTicks(values, startTick, count = 20) {
  return Array.from(values, (microsecondsValue, index) => ({
    tick: startTick + index,
    milliseconds: round(microsecondsValue / 1_000),
  })).sort((left, right) => right.milliseconds - left.milliseconds).slice(0, count);
}

function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }

async function sourceIdentity() {
  const targets = [
    'js/packages/display/src',
    'js/packages/renderer-three/src',
    'scripts/benchmark_display_runtime_500.mjs',
  ];
  const entries = [];
  for (const target of targets) {
    const absolute = path.join(ROOT, target);
    const metadata = await stat(absolute);
    const files = (metadata.isDirectory() ? await walk(absolute) : [absolute]).sort();
    for (const file of files) {
      const relative = path.relative(ROOT, file);
      entries.push([relative, await readFile(file)]);
    }
  }
  const hash = createHash('sha256');
  for (const [relative, bytes] of entries) hash.update(relative).update('\0').update(bytes).update('\0');
  let gitCommit = null;
  let gitDirty = null;
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    gitDirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).length > 0;
  } catch { /* source hash remains authoritative for an unpacked source tree */ }
  return { sha256: hash.digest('hex'), fileCount: entries.length, gitCommit, gitDirty };
}

async function walk(target) {
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function hardware() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpuModel: cpus[0]?.model ?? null,
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    v8Version: process.versions.v8,
  };
}

async function run({ quick }) {
  const validationTicks = quick ? QUICK_VALIDATION_TICKS : FORMAL_VALIDATION_TICKS;
  const soakTicks = quick ? QUICK_SOAK_TICKS : FORMAL_SOAK_TICKS;
  const totalTicks = validationTicks + soakTicks;
  const metrics = createMetrics(totalTicks);
  const current = {
    index: -1,
    frameStarted: null,
    measuredPath: false,
    directLookups: 0,
    fullTreeScans: 0,
    summaryCalls: 0,
  };
  const frames = new FrameAdapter();
  const renderers = [];
  const backends = [];
  let observerDisconnectCount = 0;
  const componentRegistry = createComponentRegistry();
  componentRegistry.register({ ComponentClass: BenchmarkBehaviour });
  const regular = prefab({ gameplayType: 'benchmark.regular', withBehaviour: false });
  const ticking = prefab({ gameplayType: 'benchmark.ticking', withBehaviour: true });
  const sceneRegistry = createSceneRegistry([makeScene()]);
  const prefabRegistry = createPrefabRegistry([regular, ticking]);
  const resourceRegistry = createResourceRegistry(RESOURCES);
  const hostElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1_280, height: 720 }) };
  const canvas = { getContext: () => ({}), toDataURL: () => 'data:image/png;base64,benchmark' };
  const createRenderBackend = (options) => {
    const renderer = new EvidenceRenderer();
    const backend = new ThreeRenderBackend(options, {
      ...DEFAULT_THREE_IMPLEMENTATION,
      createRenderer: () => renderer,
      createResizeObserver: () => ({
        observe() {},
        disconnect() { observerDisconnectCount += 1; },
      }),
      devicePixelRatio: () => 1,
      loadResource: loadThreeResource,
      disposeResource: disposeThreeResource,
    });
    instrumentBackend(backend, metrics, current);
    renderers.push(renderer);
    backends.push(backend);
    return backend;
  };
  const healthEvents = [];
  const runtime = createDisplayRuntime({
    hostElement,
    canvas,
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    createRenderBackend,
    frameAdapter: frames,
    onHealth: (event) => healthEvents.push(event),
  });
  runtime.installScene({ sceneName: 'benchmark' });
  const model = createModel();
  for (let index = 0; index < AUTHORITY_ROOTS; index += 1) {
    runtime.authority.createNode({
      name: model[index].name,
      parentName: null,
      prefabId: index < BEHAVIOUR_ROOTS ? ticking.id : regular.id,
      transformMode: index < INITIAL_ROOTS ? 'initial' : 'live',
      transform: model[index].transform,
      visible: true,
      state: { phase: 0 },
    });
  }
  runtime.activate({ commitSeq: 0, sourceTick: 0, lastCommandSeq: 0 });
  runtime.start();
  await runtime.whenReady();
  if (frames.step() !== 1) throw new Error('fixture did not schedule exactly one DisplayRuntime RAF');
  const backend = backends[0];
  const fixture = assertFixture(runtime, backend);
  instrumentRuntime(runtime, metrics, current);
  behaviourTicks = 0;
  const memory = [memorySnapshot(0)];
  let lastCommandSeq = 0;
  const startedAt = new Date().toISOString();
  const wallStarted = process.hrtime.bigint();

  for (let ordinal = 0; ordinal < totalTicks; ordinal += 1) {
    const tick = ordinal + 1;
    const commands = buildCommands(tick, model);
    metrics.commandBytes[ordinal] = Buffer.byteLength(JSON.stringify(commands));
    const cursor = {
      commitSeq: tick,
      sourceTick: tick,
      lastCommandSeq: lastCommandSeq + commands.length,
    };
    current.index = ordinal;
    current.measuredPath = true;
    const commandStarted = process.hrtime.bigint();
    runtime.commitGate.begin(cursor);
    for (const command of commands) applyCommand(runtime.authority, command);
    runtime.commitGate.seal(cursor);
    const displaySummary = runtime.summary();
    current.summaryCalls += 1;
    if (displaySummary.nodeCount !== 1_503
        || displaySummary.cursor.commitSeq !== cursor.commitSeq
        || displaySummary.cursor.sourceTick !== cursor.sourceTick
        || displaySummary.cursor.lastCommandSeq !== cursor.lastCommandSeq) {
      throw new Error(`Display summary drift at tick ${tick}`);
    }
    metrics.commandApplyUs[ordinal] = microseconds(commandStarted);
    current.frameStarted = process.hrtime.bigint();
    const callbacks = frames.step();
    metrics.frameTotalUs[ordinal] = microseconds(current.frameStarted);
    metrics.totalCpuPredrawUs[ordinal] = metrics.commandApplyUs[ordinal]
      + metrics.framePredrawUs[ordinal];
    current.frameStarted = null;
    current.measuredPath = false;
    current.index = -1;
    lastCommandSeq = cursor.lastCommandSeq;
    if (callbacks !== 1) throw new Error(`tick ${tick} scheduled ${callbacks} RAF callbacks`);
    if (ordinal < validationTicks || tick % 600 === 0 || tick === totalTicks) {
      validateRuntime(runtime, model, cursor);
    }
    if (tick === validationTicks || tick === totalTicks
        || (tick > validationTicks && (tick - validationTicks) % 600 === 0)) {
      memory.push(memorySnapshot(tick));
    }
  }

  const wallDurationSeconds = Number(process.hrtime.bigint() - wallStarted) / 1e9;
  const finalView = validateRuntime(runtime, model, {
    commitSeq: totalTicks,
    sourceTick: totalTicks,
    lastCommandSeq,
  });
  const runtimeHash = sha256(semanticRecord(finalView));
  const expectedHash = sha256(expectedSemanticRecord(model, finalView.cursor));
  const finalDiagnostics = backend.diagnostics();
  const validationRange = [0, validationTicks];
  const soakRange = [validationTicks, totalTicks];
  const phaseReport = (range) => ({
    ticks: range[1] - range[0],
    commandApply: summary(metrics.commandApplyUs.subarray(...range)),
    transformFlush: summary(metrics.transformFlushUs.subarray(...range)),
    renderSystemPrepare: summary(metrics.renderPrepareUs.subarray(...range)),
    backendPrepare: summary(metrics.backendPrepareUs.subarray(...range)),
    frameCpuPredraw: summary(metrics.framePredrawUs.subarray(...range)),
    totalCpuPredraw: summary(metrics.totalCpuPredrawUs.subarray(...range)),
    frameTotalCpu: summary(metrics.frameTotalUs.subarray(...range)),
    commandPayload: commandSizeSummary(metrics.commandBytes.subarray(...range)),
  });
  const soakTotal = metrics.totalCpuPredrawUs.subarray(...soakRange);
  const afterValidation = memory.find((entry) => entry.tick === validationTicks);
  const afterSoak = memory.at(-1);
  const heapGrowthBytes = afterSoak.heapUsedBytes - afterValidation.heapUsedBytes;
  const gates = {
    formalTickCounts: !quick && validationTicks === FORMAL_VALIDATION_TICKS
      && soakTicks === FORMAL_SOAK_TICKS,
    structure: fixture.authorityRoots === 500
      && fixture.prefabLocalNodes >= 1_000 && fixture.prefabLocalNodes <= 1_500
      && fixture.renderBindingCount >= 500
      && fixture.schedulerHandlerCount >= 10 && fixture.schedulerHandlerCount <= 50,
    exactRafOwner: frames.pendingCount === 0 && finalView.snapshot().cursor.sourceTick === totalTicks,
    commandStreamAt60Hz: lastCommandSeq === totalTicks * COMMANDS_PER_TICK,
    directNodeIndexOnly: current.directLookups > 0 && current.fullTreeScans === 0,
    summaryIsConstantPath: current.summaryCalls === totalTicks && current.fullTreeScans === 0,
    correctnessHash: runtimeHash === expectedHash,
    behaviourTicks: behaviourTicks === totalTicks * BEHAVIOUR_ROOTS,
    renderPrepareP95Under8Ms: summary(metrics.renderPrepareUs.subarray(...soakRange)).p95Ms
      < PREPARE_P95_TARGET_MS,
    noSustainedFrameBudgetOverrun: longestConsecutiveOver(soakTotal, FRAME_BUDGET_MS * 1_000)
      <= MAX_CONSECUTIVE_FRAME_OVERRUNS,
    heapGrowthBounded: heapGrowthBytes <= HEAP_GROWTH_LIMIT_BYTES,
    stableCardinality: finalView.nodeCount === fixture.nodeIndexCount
      && finalDiagnostics.bindingCount === fixture.renderBindingCount
      && finalDiagnostics.resourceLeaseCount === fixture.resourceLeaseCount
      && finalDiagnostics.pendingBindingCount === 0
      && finalDiagnostics.pendingResourceCount === 0,
    noHealthFailures: healthEvents.length === 0,
  };
  if (quick) gates.formalTickCounts = null;
  const report = {
    schema: 'scene-engine-js-display-runtime-acceptance@1',
    status: Object.values(gates).every((value) => value === true || value === null) ? (quick ? 'QUICK PASS' : 'READY') : 'NOT READY',
    generatedAt: new Date().toISOString(),
    startedAt,
    mode: quick ? 'quick' : 'formal',
    source: await sourceIdentity(),
    hardware: hardware(),
    parameters: {
      authoritativeRateHz: 60,
      validationTicks,
      validationLogicalSeconds: validationTicks / 60,
      soakTicks,
      soakLogicalSeconds: soakTicks / 60,
      totalCommittedTicks: totalTicks,
      commandsPerTick: COMMANDS_PER_TICK,
      totalCommands: lastCommandSeq,
      wallDurationSeconds: round(wallDurationSeconds),
      timingSamplesExcluded: 0,
    },
    fixture,
    validation: phaseReport(validationRange),
    soak: {
      ...phaseReport(soakRange),
      longestConsecutiveTotalCpuPredrawOver16_67Ms: longestConsecutiveOver(
        soakTotal,
        FRAME_BUDGET_MS * 1_000,
      ),
      totalCpuPredrawTicksOver16_67Ms: Array.from(soakTotal)
        .filter((value) => value > FRAME_BUDGET_MS * 1_000).length,
      slowestTotalCpuPredrawTicks: topSlowTicks(soakTotal, validationTicks + 1),
      perLogicalSecond: secondWindows(metrics, validationTicks, soakTicks),
    },
    memory: {
      collection: 'three forced V8 GCs outside timed tick paths',
      checkpoints: memory,
      heapGrowthAfterValidationBytes: heapGrowthBytes,
      heapSlopeBytesPerSoakTick: round(heapGrowthBytes / soakTicks),
      heapGrowthLimitBytes: HEAP_GROWTH_LIMIT_BYTES,
    },
    lookupDiagnostics: {
      directNodeIndexLookupsInMeasuredPath: current.directLookups,
      fullNodeIndexTraversalsInMeasuredPath: current.fullTreeScans,
      displaySummaryCallsInMeasuredPath: current.summaryCalls,
    },
    correctness: {
      algorithm: 'sha256 canonical JSON',
      runtimeSemanticHash: runtimeHash,
      independentlyTrackedExpectedHash: expectedHash,
      match: runtimeHash === expectedHash,
    },
    finalRuntime: {
      cursor: finalView.cursor,
      nodeIndexCount: finalView.nodeCount,
      behaviourTickCalls: behaviourTicks,
      backend: finalDiagnostics,
      pendingRafCount: frames.pendingCount,
      healthEvents,
    },
    gates,
  };
  const disposalRefs = {
    nodeIndex: runtime._nodeIndex,
    scheduler: runtime._scheduler,
    renderSystem: runtime._renderSystem,
    sceneLoader: runtime._sceneLoader,
    prefabInstantiator: runtime._prefabInstantiator,
  };
  await runtime.dispose();
  const disposedDiagnostics = backend.diagnostics();
  report.disposalBaseline = {
    nodeIndexCount: disposalRefs.nodeIndex.size,
    componentCount: [...disposalRefs.nodeIndex.values()]
      .reduce((count, node) => count + node.components.length, 0),
    schedulerHandlerCount: disposalRefs.scheduler._registered.size,
    renderSystemEntryCount: disposalRefs.renderSystem._entries.size,
    sceneLoaderScopeCount: disposalRefs.sceneLoader._scopes.length,
    prefabScopeCount: disposalRefs.prefabInstantiator._scopes.size,
    renderBindingCount: disposedDiagnostics.bindingCount,
    backendNodeBindingCount: disposedDiagnostics.nodeBindingCount,
    resourceCount: disposedDiagnostics.resourceCount,
    resourceLeaseCount: disposedDiagnostics.resourceLeaseCount,
    pendingBindingCount: disposedDiagnostics.pendingBindingCount,
    pendingResourceCount: disposedDiagnostics.pendingResourceCount,
    pendingRafCount: frames.pendingCount,
    resizeObserverDisconnectCount: observerDisconnectCount,
    rendererDisposed: renderers.every((renderer) => renderer.disposed),
  };
  report.gates.disposalReturnedToZero = Object.entries(report.disposalBaseline)
    .filter(([key]) => key.endsWith('Count') && key !== 'resizeObserverDisconnectCount')
    .every(([, value]) => value === 0)
    && observerDisconnectCount === backends.length
    && report.disposalBaseline.rendererDisposed;
  if (!report.gates.disposalReturnedToZero) report.status = 'NOT READY';
  return report;
}

function parseArguments(argv) {
  let quick = false;
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--quick') quick = true;
    else if (argument === '--output') {
      output = argv[index + 1] ?? null;
      index += 1;
    } else throw new Error(`unknown benchmark option: ${argument}`);
  }
  if (!quick && output === null) output = DEFAULT_FORMAL_OUTPUT;
  return { quick, output };
}

try {
  if (typeof globalThis.gc !== 'function') {
    execFileSync(process.execPath, [
      '--expose-gc',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ], { cwd: process.cwd(), stdio: 'inherit' });
    process.exit(0);
  }
  const options = parseArguments(process.argv.slice(2));
  const report = await run(options);
  if (options.output !== null) {
    const target = path.resolve(process.cwd(), options.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(
    `${report.schema} ${report.status} roots=${report.fixture.authorityRoots} `
    + `local=${report.fixture.prefabLocalNodes} ticks=${report.parameters.totalCommittedTicks} `
    + `prepare-p95=${report.soak.renderSystemPrepare.p95Ms}ms `
    + `total-p95=${report.soak.totalCpuPredraw.p95Ms}ms\n`,
  );
  if (report.status === 'NOT READY') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
