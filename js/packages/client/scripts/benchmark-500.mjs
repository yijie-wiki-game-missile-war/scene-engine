import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SceneEngineClient } from '../src/index.js';
import { encodeDisplayCheckpoint, encodeDisplayCommandStream } from '../src/display.js';
import { DISPLAY_CODEC, encodePacket } from '../src/wire.js';

const NODE_COUNT = 500;
const CHURN_NODE_COUNT = 25;
const STREAM_ID = '00000000-0000-4000-8000-000000000500';
const WORLD_CODEC = 'benchmark-world@2';
const HASHES = Object.freeze({
  scene_catalog_hash: 'a'.repeat(64),
  prefab_catalog_hash: 'b'.repeat(64),
  state_schema_hash: 'c'.repeat(64),
});
const options = parseOptions(process.argv.slice(2));

function transform(x = 0) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, 0, 0, 1,
  ]);
}

function createRecord(nodeId) {
  return {
    node_id: nodeId,
    parent_node_id: null,
    prefab_id: 'benchmark.node',
    transform_mode: 'live',
    visible: true,
    state: {},
  };
}

function matrixTensor(entries) {
  const matrices = new Float32Array(entries.length * 16);
  entries.forEach(({ nodeId, x }, index) => matrices.set(transform(x ?? nodeId), index * 16));
  return matrices;
}

function checkpointPacket(nodes, matrixPoolSize) {
  const matrices = new Float32Array(matrixPoolSize * 16);
  for (const node of nodes) matrices.set(transform(node.node_id), node.node_id * 16);
  return encodePacket('engine.checkpoint', {
    schema: 'scene-engine-wire@3',
    type: 'engine.checkpoint',
    stream_id: STREAM_ID,
    commit_seq: 0,
    source_tick: 0,
    world_revision: 0,
    last_command_seq: 0,
    world_codec: WORLD_CODEC,
    display_codec: DISPLAY_CODEC,
  }, [
    {
      kind: 'world_snapshot',
      encoding: 'json',
      value: { tick: 0, world_revision: 0 },
    },
    {
      kind: 'display_checkpoint',
      encoding: 'raw',
      value: encodeDisplayCheckpoint({
        schema: 'scene-engine-display-checkpoint@6',
        scene_name: 'benchmark',
        ...HASHES,
        last_command_seq: 0,
        matrix_pool_size: matrixPoolSize,
        matrix_pool: matrices,
        nodes,
      }),
    },
  ]);
}

function commitPacket({
  commitSeq,
  baseCommandSeq,
  matrixPoolSize,
  dirtyNodeIds,
  dirtyMatrices,
  commands,
}) {
  const records = commands.map((command, index) => ({
    schema: 'scene-engine-node-command@6',
    command_seq: baseCommandSeq + index + 1,
    source_tick: commitSeq,
    ...command,
  }));
  const lastCommandSeq = baseCommandSeq + records.length;
  return encodePacket('engine.commit', {
    schema: 'scene-engine-wire@3',
    type: 'engine.commit',
    stream_id: STREAM_ID,
    commit_seq: commitSeq,
    source_tick: commitSeq,
    world_revision: commitSeq,
    cause: 'tick',
    causation_id: null,
    last_command_seq: lastCommandSeq,
    world_codec: WORLD_CODEC,
    display_codec: DISPLAY_CODEC,
  }, [
    {
      kind: 'world_patch',
      encoding: 'json',
      value: {
        schema: 'scene-engine-json-tree@1',
        changes: [
          { op: 'set', path: ['tick'], value: commitSeq },
          { op: 'set', path: ['world_revision'], value: commitSeq },
        ],
      },
    },
    {
      kind: 'display_command_stream',
      encoding: 'raw',
      value: encodeDisplayCommandStream({
        schema: 'scene-engine-display-command-stream@6',
        base_command_seq: baseCommandSeq,
        last_command_seq: lastCommandSeq,
        matrix_pool_size: matrixPoolSize,
        dirty_node_ids: dirtyNodeIds,
        dirty_matrices: dirtyMatrices,
        commands: records,
      }, { sourceTick: commitSeq }),
    },
  ]);
}

function createBenchmarkSessionFactory(state) {
  return () => {
    let pendingCursor = null;
    const requireNode = (nodeId) => {
      const node = state.nodes.get(nodeId);
      if (!node) throw new Error(`benchmark node missing: ${nodeId}`);
      return node;
    };
    const authorityPort = {
      installNodeMatrixPool({ poolSize, matrices }) {
        if (matrices.length !== poolSize * 16) throw new Error('benchmark matrix pool invalid');
        state.matrixPool = matrices;
      },
      applyNodeTransformBatch({ poolSize, nodeIds, matrices }) {
        if (nodeIds.length * 16 !== matrices.length) {
          throw new Error('benchmark transform batch invalid');
        }
        if (state.matrixPool.length !== poolSize * 16) {
          const grown = new Float32Array(poolSize * 16);
          grown.set(state.matrixPool);
          state.matrixPool = grown;
        }
        nodeIds.forEach((nodeId, index) => {
          state.matrixPool.set(matrices.subarray(index * 16, (index + 1) * 16), nodeId * 16);
        });
      },
      createNode(record) {
        if (state.nodes.has(record.nodeId)) throw new Error(`benchmark duplicate: ${record.nodeId}`);
        state.nodes.set(record.nodeId, record);
      },
      setNodeTransform(record) {
        requireNode(record.nodeId);
      },
      setNodeParent(record) {
        const node = requireNode(record.nodeId);
        state.nodes.set(record.nodeId, { ...node, parentNodeId: record.parentNodeId });
      },
      setNodeVisible(record) {
        const node = requireNode(record.nodeId);
        state.nodes.set(record.nodeId, { ...node, visible: record.visible });
      },
      setNodeState(record) {
        const node = requireNode(record.nodeId);
        state.nodes.set(record.nodeId, { ...node, state: record.state });
      },
      replaceNodePrefab(record) {
        const node = requireNode(record.nodeId);
        state.nodes.set(record.nodeId, {
          ...node, prefabId: record.prefabId, state: record.state,
        });
      },
      removeNode(record) {
        if (!state.nodes.delete(record.nodeId)) {
          throw new Error(`benchmark node missing: ${record.nodeId}`);
        }
      },
    };
    return {
      runtime: {
        catalogIdentity: () => Object.freeze({
          sceneCatalogHash: HASHES.scene_catalog_hash,
          prefabCatalogHash: HASHES.prefab_catalog_hash,
          stateSchemaHash: HASHES.state_schema_hash,
        }),
        installScene() {},
        activate(cursor) { state.cursor = cursor; },
        start() {},
        summary: () => Object.freeze({
          schema: 'scene-engine-display-summary@1',
          sceneName: 'benchmark',
          revision: state.cursor?.commitSeq ?? 0,
          nodeCount: state.nodes.size,
          cursor: state.cursor,
          health: 'ready',
        }),
        currentView: () => Object.freeze({
          nodeCount: state.nodes.size,
          cursor: state.cursor,
        }),
      },
      authorityPort,
      commitGate: {
        begin(cursor) {
          if (pendingCursor !== null) throw new Error('benchmark gate already closed');
          pendingCursor = cursor;
        },
        seal(cursor) {
          if (pendingCursor !== cursor) throw new Error('benchmark gate cursor mismatch');
          state.cursor = cursor;
          pendingCursor = null;
        },
        fail() { pendingCursor = null; },
      },
      dispose() {},
    };
  };
}

function createScenario(name) {
  let nodeIds = Array.from({ length: NODE_COUNT }, (_, index) => index);
  let nextNodeId = NODE_COUNT;
  return {
    baseline: nodeIds.map((nodeId) => createRecord(nodeId)),
    initialPoolSize: nextNodeId,
    commands(iteration) {
      if (name === 'steady') {
        return {
          commands: [],
          matrixPoolSize: nextNodeId,
          dirtyNodeIds: new Uint32Array(),
          dirtyMatrices: new Float32Array(),
        };
      }
      if (name === 'motion') {
        const dirtyNodeIds = new Uint32Array(nodeIds);
        return {
          commands: nodeIds.map((nodeId) => ({
            kind: 'node-set-transform',
            node_id: nodeId,
          })),
          matrixPoolSize: nextNodeId,
          dirtyNodeIds,
          dirtyMatrices: matrixTensor(nodeIds.map((nodeId) => ({
            nodeId,
            x: nodeId + iteration / 1000,
          }))),
        };
      }
      const removed = nodeIds.splice(0, CHURN_NODE_COUNT);
      const created = Array.from({ length: CHURN_NODE_COUNT }, () => nextNodeId++);
      nodeIds.push(...created);
      return {
        commands: [
          ...removed.map((nodeId) => ({ kind: 'node-remove', node_id: nodeId })),
          ...created.map((nodeId) => ({
            kind: 'node-create',
            ...createRecord(nodeId),
          })),
        ],
        matrixPoolSize: nextNodeId,
        dirtyNodeIds: new Uint32Array(created),
        dirtyMatrices: matrixTensor(created.map((nodeId, index) => ({ nodeId, x: index }))),
      };
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
  const scenario = createScenario(name);
  const state = { nodes: new Map(), matrixPool: new Float32Array(), cursor: null };
  const client = new SceneEngineClient({
    createDisplaySession: createBenchmarkSessionFactory(state),
  });
  client.applyPacket(checkpointPacket(scenario.baseline, scenario.initialPoolSize));
  let commitSeq = 0;
  let commandSeq = 0;
  let sampledBytes = 0;
  const nextPacket = (iteration) => {
    commitSeq += 1;
    const mutation = scenario.commands(iteration);
    const packet = commitPacket({ commitSeq, baseCommandSeq: commandSeq, ...mutation });
    commandSeq += mutation.commands.length;
    return packet;
  };
  for (let index = 0; index < options.warmup; index += 1) {
    client.applyPacket(nextPacket(index));
  }

  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const samples = [];
  for (let index = 0; index < options.samples; index += 1) {
    const packet = nextPacket(options.warmup + index);
    sampledBytes += packet.byteLength;
    const started = process.hrtime.bigint();
    client.applyPacket(packet);
    samples.push(Number(process.hrtime.bigint() - started));
  }
  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  if (state.nodes.size !== NODE_COUNT) throw new Error('benchmark Node cardinality drift');
  if (client.currentCommit().lastCommandSeq !== commandSeq) {
    throw new Error('benchmark command cursor drift');
  }
  client.dispose();
  return {
    samples,
    sampledBytes,
    heapBefore,
    heapAfter,
  };
}

const scenarios = {};
for (const name of ['steady', 'motion', 'churn-25']) {
  const rounds = [];
  const allSamples = [];
  let sampledBytes = 0;
  for (let round = 0; round < options.rounds; round += 1) {
    const result = runRound(name);
    rounds.push({
      round: round + 1,
      metrics_ns: statistics(result.samples),
      memory: {
        heap_before_bytes: result.heapBefore,
        heap_after_bytes: result.heapAfter,
        heap_delta_bytes: result.heapAfter - result.heapBefore,
      },
    });
    allSamples.push(...result.samples);
    sampledBytes += result.sampledBytes;
  }
  const heapDeltas = rounds
    .map((item) => item.memory.heap_delta_bytes)
    .sort((left, right) => left - right);
  scenarios[name] = {
    sample_count: allSamples.length,
    metrics_ns: statistics(allSamples),
    bytes: { sampled_wire_bytes: sampledBytes },
    memory: {
      heap_delta_bytes_p50: percentile(heapDeltas, 0.5),
      heap_delta_bytes_max: heapDeltas.at(-1),
    },
    rounds,
  };
}

const cpuInfo = os.cpus();
const report = {
  schema: 'scene-engine-client-authority-perf-500@3',
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
    authority_nodes: NODE_COUNT,
    churn_nodes_per_commit: CHURN_NODE_COUNT,
    warmup_commits_per_round: options.warmup,
    sampled_commits_per_round: options.samples,
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
    const match = /^--(warmup|samples|rounds)=(\d+)$/u.exec(argument);
    if (match) {
      values[match[1]] = Number(match[2]);
      continue;
    }
    const outputMatch = /^--output=(.+)$/u.exec(argument);
    if (outputMatch) {
      values.output = outputMatch[1];
      continue;
    }
    if (argument !== '--quick') throw new Error(`unknown benchmark option: ${argument}`);
  }
  for (const name of ['warmup', 'samples', 'rounds']) {
    if (!Number.isSafeInteger(values[name]) || values[name] <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (!quick && values.output === null) {
    throw new Error('formal benchmark runs require --output');
  }
  return Object.freeze(values);
}
