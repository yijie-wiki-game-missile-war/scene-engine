#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SceneEngineClient, readEnginePacket } from '../js/packages/client/src/index.js';
import { DISPLAY_CODEC, encodePacket } from '../js/packages/client/src/wire.js';
import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  TICKS_PER_SECOND,
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  defineScene,
} from '../js/packages/display/src/index.js';
import { createFakeRenderBackend } from '../js/packages/display/src/testing/fake-render-backend.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const AUTHORITY_ROOTS = 500;
const PREFAB_CHILDREN_PER_ROOT = 2;
const EXPECTED_NODE_COUNT = 1_503;
const FORMAL_COMMITS = 10_000;
const QUICK_COMMITS = 500;
const P95_LIMIT_MS = 8;
const P99_LIMIT_MS = 1_000 / TICKS_PER_SECOND;
const HEAP_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024;
const HEAP_SLOPE_LIMIT_BYTES_PER_COMMIT = 512;
const STREAM_ID = '00000000-0000-4000-8000-000000000500';
const WORLD_CODEC = 'benchmark-world-state@1';
const AUTHORITY_STATE_SCHEMAS = Object.freeze([Object.freeze({
  gameplayType: 'benchmark.authority-unit',
  schemaId: 'benchmark.authority-unit.state@1',
  revision: 1,
})]);
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

class BenchmarkFrameAdapter {
  constructor() {
    this._next = 1;
    this._callbacks = new Map();
  }

  request(callback) {
    const identity = this._next;
    this._next += 1;
    this._callbacks.set(identity, callback);
    return identity;
  }

  cancel(identity) { this._callbacks.delete(identity); }
  now() { return 0; }
  get pendingCount() { return this._callbacks.size; }
}

function transform(index, commitSeq = 0) {
  return {
    position: [index % 25 + (commitSeq % 17) / 32, 0, Math.floor(index / 25)],
    rotationXyzw: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

function benchmarkPrefab() {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'benchmark.authority-unit',
    gameplayType: 'benchmark.authority-unit',
    root: {
      components: [],
      children: [{
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
      }, {
        localName: 'marker',
        transform: IDENTITY,
        visible: true,
        components: [],
        children: [],
      }],
    },
  });
}

function benchmarkScene() {
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
        properties: {
          projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 1_000,
        },
      }],
    }],
    prefabInstances: [],
  });
}

function resources() {
  return [{
    id: 'benchmark/mesh',
    kind: 'mesh',
    positions: [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
  }, {
    id: 'benchmark/material',
    kind: 'material',
    family: 'material.standard',
    properties: {
      tintRgba: 0xffff_ffff,
      opacity: 1,
      emissive: 0,
      alphaMode: 'opaque',
      alphaCutoff: 0,
    },
  }];
}

function benchmarkCatalogIdentity() {
  const sceneRegistry = createSceneRegistry([benchmarkScene()]);
  const prefabRegistry = createPrefabRegistry([benchmarkPrefab()]);
  const resourceRegistry = createResourceRegistry(resources());
  const componentRegistry = createComponentRegistry();
  return computeDisplayCatalogIdentity(buildDisplayCatalogManifest({
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas: AUTHORITY_STATE_SCHEMAS,
  }));
}

const CATALOG_IDENTITY = benchmarkCatalogIdentity();

function baselineNodes() {
  return Array.from({ length: AUTHORITY_ROOTS }, (_, index) => ({
    name: `py/benchmark-${index}`,
    parent_name: null,
    prefab_id: 'benchmark.authority-unit',
    transform_mode: 'live',
    transform: transform(index),
    visible: true,
    state: { index },
  }));
}

function checkpointPacket() {
  return encodePacket('engine.checkpoint', {
    schema: 'scene-engine-wire@2',
    type: 'engine.checkpoint',
    stream_id: STREAM_ID,
    commit_seq: 0,
    source_tick: 0,
    world_revision: 0,
    last_command_seq: 0,
    world_codec: WORLD_CODEC,
    display_codec: DISPLAY_CODEC,
  }, [{
    kind: 'world_snapshot',
    encoding: 'json',
    value: { tick: 0, world_revision: 0 },
  }, {
    kind: 'display_checkpoint',
    encoding: 'json',
    value: {
      schema: 'scene-engine-display-checkpoint@3',
      scene_name: 'benchmark',
      scene_catalog_hash: CATALOG_IDENTITY.sceneCatalogHash,
      prefab_catalog_hash: CATALOG_IDENTITY.prefabCatalogHash,
      state_schema_hash: CATALOG_IDENTITY.stateSchemaHash,
      last_command_seq: 0,
      nodes: baselineNodes(),
    },
  }]);
}

function commitPacket(commitSeq) {
  const index = (commitSeq - 1) % AUTHORITY_ROOTS;
  const command = {
    schema: 'scene-engine-node-command@3',
    command_seq: commitSeq,
    source_tick: commitSeq,
    kind: 'node-set-transform',
    name: `py/benchmark-${index}`,
    transform: transform(index, commitSeq),
  };
  return encodePacket('engine.commit', {
    schema: 'scene-engine-wire@2',
    type: 'engine.commit',
    stream_id: STREAM_ID,
    commit_seq: commitSeq,
    source_tick: commitSeq,
    world_revision: commitSeq,
    cause: 'tick',
    causation_id: null,
    last_command_seq: commitSeq,
    world_codec: WORLD_CODEC,
    display_codec: DISPLAY_CODEC,
  }, [{
    kind: 'world_patch',
    encoding: 'json',
    value: {
      schema: 'scene-engine-json-tree@1',
      changes: [
        { op: 'set', path: ['tick'], value: commitSeq },
        { op: 'set', path: ['world_revision'], value: commitSeq },
      ],
    },
  }, {
    kind: 'display_command_stream',
    encoding: 'json',
    value: {
      schema: 'scene-engine-display-command-stream@3',
      base_command_seq: commitSeq - 1,
      last_command_seq: commitSeq,
      commands: [command],
    },
  }]);
}

function createDisplaySessionFactory(probeState) {
  return (metadata) => {
    if (metadata.sceneName !== 'benchmark'
        || metadata.sceneCatalogHash !== CATALOG_IDENTITY.sceneCatalogHash
        || metadata.prefabCatalogHash !== CATALOG_IDENTITY.prefabCatalogHash
        || metadata.stateSchemaHash !== CATALOG_IDENTITY.stateSchemaHash) {
      throw new Error('benchmark session metadata mismatch');
    }
    const prefab = benchmarkPrefab();
    const frames = new BenchmarkFrameAdapter();
    const fakeBackends = [];
    const runtime = createDisplayRuntime({
      sceneRegistry: createSceneRegistry([benchmarkScene()]),
      prefabRegistry: createPrefabRegistry([prefab]),
      resourceRegistry: createResourceRegistry(resources()),
      componentRegistry: createComponentRegistry(),
      authorityStateSchemas: AUTHORITY_STATE_SCHEMAS,
      createRenderBackend() {
        const fake = createFakeRenderBackend();
        fakeBackends.push(fake);
        return fake.backend;
      },
      frameAdapter: frames,
    });
    const runtimeSummary = runtime.summary.bind(runtime);
    const runtimeCurrentView = runtime.currentView.bind(runtime);
    const runtimeWhenReady = runtime.whenReady.bind(runtime);
    runtime.summary = () => {
      probeState.summaryCalls += 1;
      const value = runtimeSummary();
      probeState.lastSummary = value;
      return value;
    };
    runtime.currentView = () => {
      probeState.displayViewMaterializations += 1;
      return runtimeCurrentView();
    };
    runtime.whenReady = (...args) => {
      probeState.whenReadyCalls += 1;
      return runtimeWhenReady(...args);
    };
    probeState.runtime = runtime;
    probeState.frames = frames;
    probeState.fakeBackends = fakeBackends;
    return {
      runtime,
      authorityPort: runtime.authority,
      commitGate: runtime.commitGate,
      dispose: () => runtime.dispose(),
    };
  };
}

function forceGc() {
  for (let iteration = 0; iteration < 3; iteration += 1) globalThis.gc();
}

function memorySnapshot(commitSeq) {
  forceGc();
  const value = process.memoryUsage();
  return {
    commitSeq,
    heapUsedBytes: value.heapUsed,
    rssBytes: value.rss,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function timingSummary(nanoseconds) {
  const samples = Array.from(nanoseconds, (value) => value / 1e6);
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: samples.length,
    minimumMs: round(percentile(sorted, 0)),
    p50Ms: round(percentile(sorted, 0.50)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
    maximumMs: round(percentile(sorted, 1)),
    meanMs: round(samples.reduce((total, value) => total + value, 0) / samples.length),
  };
}

function linearSlope(points) {
  const count = points.length;
  const meanX = points.reduce((total, point) => total + point.commitSeq, 0) / count;
  const meanY = points.reduce((total, point) => total + point.heapUsedBytes, 0) / count;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const x = point.commitSeq - meanX;
    numerator += x * (point.heapUsedBytes - meanY);
    denominator += x * x;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function memorySummary(checkpoints) {
  const stableWindow = checkpoints.length > 3 ? checkpoints.slice(2) : checkpoints;
  const first = stableWindow[0];
  const last = stableWindow.at(-1);
  const heapGrowthBytes = last.heapUsedBytes - first.heapUsedBytes;
  const heapSlopeBytesPerCommit = linearSlope(stableWindow);
  const strictlyMonotonicIncrease = stableWindow.slice(1).every(
    (point, index) => point.heapUsedBytes > stableWindow[index].heapUsedBytes,
  );
  return {
    collection: 'three forced V8 GCs outside timed Client-to-ACK paths',
    checkpoints,
    stableWindowStartCommit: first.commitSeq,
    heapGrowthBytes,
    heapSlopeBytesPerCommit: round(heapSlopeBytesPerCommit),
    strictlyMonotonicIncrease,
    heapGrowthLimitBytes: HEAP_GROWTH_LIMIT_BYTES,
    heapSlopeLimitBytesPerCommit: HEAP_SLOPE_LIMIT_BYTES_PER_COMMIT,
    stable: !strictlyMonotonicIncrease
      && heapGrowthBytes <= HEAP_GROWTH_LIMIT_BYTES
      && heapSlopeBytesPerCommit <= HEAP_SLOPE_LIMIT_BYTES_PER_COMMIT,
  };
}

function parseOptions(args) {
  let quick = false;
  let commits = null;
  for (const argument of args) {
    if (argument === '--quick') {
      quick = true;
      continue;
    }
    const match = /^--commits=(\d+)$/u.exec(argument);
    if (match) {
      commits = Number(match[1]);
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  const commitCount = commits ?? (quick ? QUICK_COMMITS : FORMAL_COMMITS);
  if (!Number.isSafeInteger(commitCount) || commitCount <= 0) {
    throw new Error('commit count must be a positive safe integer');
  }
  return { quick, commitCount };
}

function round(value) { return Math.round(value * 1_000_000) / 1_000_000; }

async function runBenchmark(options) {
  const probeState = {
    summaryCalls: 0,
    displayViewMaterializations: 0,
    whenReadyCalls: 0,
    lastSummary: null,
    runtime: null,
    frames: null,
    fakeBackends: null,
  };
  const client = new SceneEngineClient({
    createDisplaySession: createDisplaySessionFactory(probeState),
  });
  const checkpointBytes = checkpointPacket();
  const checkpointStarted = process.hrtime.bigint();
  const checkpointOutcome = client.applyPacket(checkpointBytes);
  const checkpointApplyNs = Number(process.hrtime.bigint() - checkpointStarted);
  if (!(checkpointOutcome.ackPacket instanceof Uint8Array)) {
    throw new Error('checkpoint did not synchronously return ACK bytes');
  }

  const samples = new Float64Array(options.commitCount);
  const memory = [memorySnapshot(0)];
  const memoryInterval = Math.max(100, Math.floor(options.commitCount / 10));
  let ackBytesMinimum = Number.POSITIVE_INFINITY;
  let ackBytesMaximum = 0;
  let ackBytesTotal = 0;
  let lastAckPacket = checkpointOutcome.ackPacket;
  for (let commitSeq = 1; commitSeq <= options.commitCount; commitSeq += 1) {
    const packet = commitPacket(commitSeq);
    const started = process.hrtime.bigint();
    const outcome = client.applyPacket(packet);
    samples[commitSeq - 1] = Number(process.hrtime.bigint() - started);
    if (!(outcome.ackPacket instanceof Uint8Array)) {
      throw new Error(`commit ${commitSeq} did not synchronously return ACK bytes`);
    }
    const ackBytes = outcome.ackPacket.byteLength;
    ackBytesMinimum = Math.min(ackBytesMinimum, ackBytes);
    ackBytesMaximum = Math.max(ackBytesMaximum, ackBytes);
    ackBytesTotal += ackBytes;
    lastAckPacket = outcome.ackPacket;
    if (commitSeq % memoryInterval === 0 || commitSeq === options.commitCount) {
      memory.push(memorySnapshot(commitSeq));
    }
  }

  const timing = timingSummary(samples);
  const memoryResult = memorySummary(memory);
  const finalAck = readEnginePacket(lastAckPacket);
  const finalSummary = probeState.lastSummary;
  const expectedSummaryCalls = options.commitCount + 1;
  const structureMatches = AUTHORITY_ROOTS === 500
    && PREFAB_CHILDREN_PER_ROOT === 2
    && finalSummary?.nodeCount === EXPECTED_NODE_COUNT;
  const gates = {
    formalCommitCount: options.quick ? null : options.commitCount === FORMAL_COMMITS,
    realFixtureCardinality: structureMatches,
    cumulativeAckCursor: finalAck.header.commit_seq === options.commitCount
      && finalAck.header.last_command_seq === options.commitCount,
    finalWorldCursor: client.currentCommit().commitSeq === options.commitCount
      && client.currentWorldState().tick === options.commitCount,
    oneSynchronousSummaryPerApply: probeState.summaryCalls === expectedSummaryCalls,
    zeroDisplayViewMaterializations: probeState.displayViewMaterializations === 0,
    ackIndependentOfReadyAndDraw: probeState.whenReadyCalls === 0
      && probeState.fakeBackends[0]?.draws === 0
      && probeState.frames.pendingCount === 1,
    p95Under8Ms: timing.p95Ms < P95_LIMIT_MS,
    p99UnderOneTick: timing.p99Ms < P99_LIMIT_MS,
    noMonotonicRetainedGrowth: memoryResult.stable,
  };
  const passed = Object.values(gates).every((value) => value === true || value === null);
  const report = {
    schema: 'scene-engine-client-ack-500@1',
    status: passed ? (options.quick ? 'QUICK PASS' : 'READY') : 'NOT READY',
    mode: options.quick ? 'quick' : 'formal',
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      explicitGc: typeof globalThis.gc === 'function',
    },
    parameters: {
      authorityRoots: AUTHORITY_ROOTS,
      prefabChildrenPerRoot: PREFAB_CHILDREN_PER_ROOT,
      expectedTotalNodes: EXPECTED_NODE_COUNT,
      commits: options.commitCount,
      commandKind: 'node-set-transform',
      fakeRenderBackend: true,
    },
    checkpoint: {
      packetBytes: checkpointBytes.byteLength,
      applyToAckMs: round(checkpointApplyNs / 1e6),
      ackBytes: checkpointOutcome.ackPacket.byteLength,
    },
    commits: {
      clientToAck: timing,
      ackBytes: {
        minimum: ackBytesMinimum,
        maximum: ackBytesMaximum,
        total: ackBytesTotal,
      },
    },
    display: {
      summaryCalls: probeState.summaryCalls,
      expectedSummaryCalls,
      displayViewMaterializations: probeState.displayViewMaterializations,
      whenReadyCalls: probeState.whenReadyCalls,
      finalSummary,
      pendingFrameCallbacks: probeState.frames.pendingCount,
      fakeBackendDraws: probeState.fakeBackends[0]?.draws ?? null,
      fakeBackendBindings: probeState.fakeBackends[0]?.bindings.size ?? null,
    },
    memory: memoryResult,
    gates,
  };

  client.dispose();
  await probeState.runtime.dispose();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  console.log(serialized.trimEnd());
  if (!passed) process.exitCode = 1;
}

if (typeof globalThis.gc !== 'function') {
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', SCRIPT_PATH, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  await runBenchmark(parseOptions(process.argv.slice(2)));
}
