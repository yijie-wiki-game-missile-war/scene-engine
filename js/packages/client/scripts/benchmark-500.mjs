import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SceneTree } from '../src/tree.js';

const STATIC_NODE_COUNT = 632;
const DYNAMIC_NODE_COUNT = 500;
const CHURN_NODE_COUNT = 25;
const NODE_RECORD_BYTES = 80;
const FRAME_HEADER_BYTES = 40;
const FRAME_DIRECTORY_BYTES = 7 * 20;
const INPUT_SCENE_BYTES_ESTIMATE = FRAME_HEADER_BYTES
  + FRAME_DIRECTORY_BYTES + DYNAMIC_NODE_COUNT * NODE_RECORD_BYTES;
const FRAME_BYTES = new Uint8Array(INPUT_SCENE_BYTES_ESTIMATE);
const EMPTY = Object.freeze([]);
const UNIT_ROTATION = Object.freeze([0, 0, 0, 1]);
const UNIT_SCALE = Object.freeze([1, 1, 1]);

const options = parseOptions(process.argv.slice(2));

function sceneNode(displayId, parentDisplayId, position) {
  return Object.freeze({
    animationFlags: 0,
    animationStartTick: 0n,
    animationStateId: 0,
    displayId,
    flags: 1,
    interaction: null,
    localPosition: Object.freeze(position),
    localRotationXyzw: UNIT_ROTATION,
    localScale: UNIT_SCALE,
    parentDisplayId,
    profile: null,
    visualTypeId: 1,
  });
}

const staticNodes = Object.freeze(Array.from(
  { length: STATIC_NODE_COUNT },
  (_, index) => sceneNode(
    BigInt(index + 1),
    0n,
    [index % 32, Math.floor(index / 32), 0],
  ),
));
const visualTypes = Object.freeze([
  Object.freeze({
    visualTypeId: 1,
    flags: 0,
    profileTypeId: 0,
    interactionTypeId: 0,
  }),
]);
const bootstrap = Object.freeze({
  header: Object.freeze({
    maximumDynamicNodes: DYNAMIC_NODE_COUNT,
    maximumFrameBytes: INPUT_SCENE_BYTES_ESTIMATE,
  }),
  staticNodes,
  sceneMetadata: EMPTY,
  visualTypes,
  animationStates: EMPTY,
});

function initialIds() {
  return Array.from(
    { length: DYNAMIC_NODE_COUNT },
    (_, index) => 1_000_001n + BigInt(index),
  );
}

function dynamicNode(displayId, motion) {
  const staticSlot = Number(displayId % BigInt(STATIC_NODE_COUNT));
  return sceneNode(
    displayId,
    BigInt(staticSlot + 1),
    [Number(displayId % 97n) / 10 + motion, Number(displayId % 37n) / 20, 1],
  );
}

function sceneFrame(ids, motion = 0) {
  const sorted = [...ids].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return Object.freeze({
    bytes: FRAME_BYTES,
    nodes: Object.freeze(sorted.map((identity) => dynamicNode(identity, motion))),
    events: EMPTY,
  });
}

function scenario(name) {
  let ids = initialIds();
  let nextId = ids.at(-1) + 1n;
  return {
    checkpoint: sceneFrame(ids),
    next(iteration) {
      if (name === 'churn-25') {
        ids = ids.slice(CHURN_NODE_COUNT);
        for (let index = 0; index < CHURN_NODE_COUNT; index += 1) ids.push(nextId++);
        return sceneFrame(ids);
      }
      if (name === 'motion') {
        return sceneFrame(ids, ((iteration % 120) + 1) / 1000);
      }
      return sceneFrame(ids);
    },
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
  };
}

function runRound(name) {
  const source = scenario(name);
  const tree = new SceneTree();
  let commitSeq = 0;
  tree.commit(tree.prepareCheckpoint(
    bootstrap,
    source.checkpoint,
    Object.freeze({ commitSeq, sourceTick: 0 }),
  ));
  for (let index = 0; index < options.warmup; index += 1) {
    commitSeq += 1;
    const candidate = tree.prepareFrame(
      source.next(index),
      Object.freeze({ commitSeq, sourceTick: commitSeq }),
    );
    tree.commit(candidate);
  }

  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const samples = [];
  let finalPlan = null;
  for (let index = 0; index < options.samples; index += 1) {
    commitSeq += 1;
    const nextFrame = source.next(options.warmup + index);
    const commit = Object.freeze({ commitSeq, sourceTick: commitSeq });
    const started = process.hrtime.bigint();
    const candidate = tree.prepareFrame(nextFrame, commit);
    tree.commit(candidate);
    samples.push(Number(process.hrtime.bigint() - started));
    finalPlan = candidate.plan;
  }
  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  verifyResult(name, tree, finalPlan);
  return {
    samples,
    heap_before_bytes: heapBefore,
    heap_after_bytes: heapAfter,
    heap_delta_bytes: heapAfter - heapBefore,
  };
}

function verifyResult(name, tree, plan) {
  const view = tree.currentView();
  if (view.staticNodeCount !== STATIC_NODE_COUNT
      || view.dynamicNodeCount !== DYNAMIC_NODE_COUNT) {
    throw new Error('benchmark tree cardinality drift');
  }
  const pose = {
    position: new Float64Array(3),
    rotationXyzw: new Float64Array(4),
    scale: new Float64Array(3),
  };
  if (!view.getWorldPose(view.nodeAt(STATIC_NODE_COUNT).displayId, pose)) {
    throw new Error('benchmark dynamic world pose missing');
  }
  if (name === 'steady' && plan.localPoseDirtyIds.length !== 0) {
    throw new Error('steady benchmark unexpectedly changed poses');
  }
  if (name === 'motion' && plan.localPoseDirtyIds.length !== DYNAMIC_NODE_COUNT) {
    throw new Error('motion benchmark did not move every dynamic node');
  }
  if (name === 'churn-25'
      && (plan.createIds.length !== CHURN_NODE_COUNT
        || plan.removeIds.length !== CHURN_NODE_COUNT)) {
    throw new Error('churn benchmark did not replace exactly 25 dynamic nodes');
  }
}

const scenarios = {};
for (const name of ['steady', 'motion', 'churn-25']) {
  const rounds = [];
  const allSamples = [];
  for (let round = 0; round < options.rounds; round += 1) {
    const result = runRound(name);
    rounds.push({
      round: round + 1,
      metrics_ns: statistics(result.samples),
      memory: {
        heap_before_bytes: result.heap_before_bytes,
        heap_after_bytes: result.heap_after_bytes,
        heap_delta_bytes: result.heap_delta_bytes,
      },
    });
    allSamples.push(...result.samples);
  }
  const heapDeltas = rounds
    .map((item) => item.memory.heap_delta_bytes)
    .sort((a, b) => a - b);
  scenarios[name] = {
    sample_count: allSamples.length,
    metrics_ns: statistics(allSamples),
    bytes: {
      input_scene_bytes_estimate_per_frame: INPUT_SCENE_BYTES_ESTIMATE,
      sampled_input_scene_bytes_estimate: INPUT_SCENE_BYTES_ESTIMATE * allSamples.length,
    },
    memory: {
      heap_delta_bytes_p50: percentile(heapDeltas, 0.5),
      heap_delta_bytes_max: heapDeltas.at(-1),
    },
    rounds,
  };
}

const cpuInfo = os.cpus();
const report = {
  schema: 'scene-engine-perf-500@1',
  hardware: {
    platform: os.platform(),
    architecture: os.arch(),
    release: os.release(),
    logical_cpu_count: cpuInfo.length,
    cpu_model: cpuInfo[0]?.model ?? null,
    total_memory_bytes: os.totalmem(),
  },
  runtime: {
    node: process.version,
    v8: process.versions.v8,
    uv: process.versions.uv,
    explicit_gc: typeof globalThis.gc === 'function',
  },
  configuration: {
    static_nodes: STATIC_NODE_COUNT,
    dynamic_nodes: DYNAMIC_NODE_COUNT,
    churn_nodes_per_frame: CHURN_NODE_COUNT,
    warmup_frames_per_round: options.warmup,
    sampled_frames_per_round: options.samples,
    rounds: options.rounds,
  },
  scenarios,
};
const outputPath = options.output === null ? null : path.resolve(options.output);
if (outputPath !== null) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({
  schema: report.schema,
  output: outputPath,
  summary: Object.fromEntries(Object.entries(scenarios).map(([name, value]) => [name, {
    sample_count: value.sample_count,
    p50_ns: value.metrics_ns.p50,
    p95_ns: value.metrics_ns.p95,
    p99_ns: value.metrics_ns.p99,
    max_ns: value.metrics_ns.max,
    heap_delta_bytes_p50: value.memory.heap_delta_bytes_p50,
  }])),
}));

function parseOptions(args) {
  const quick = args.includes('--quick');
  const values = {
    warmup: quick ? 6 : 60,
    samples: quick ? 60 : 600,
    rounds: quick ? 1 : 5,
    output: null,
  };
  for (const argument of args) {
    const match = /^--(warmup|samples|rounds)=(\d+)$/.exec(argument);
    if (match) {
      values[match[1]] = Number(match[2]);
      continue;
    }
    const outputMatch = /^--output=(.+)$/.exec(argument);
    if (outputMatch) {
      values.output = outputMatch[1];
      continue;
    }
    if (argument !== '--quick') throw new Error(`unknown benchmark option: ${argument}`);
  }
  for (const name of ['warmup', 'samples', 'rounds']) {
    const value = values[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (!quick && values.output === null) {
    throw new Error('formal benchmark runs require --output');
  }
  return Object.freeze(values);
}
