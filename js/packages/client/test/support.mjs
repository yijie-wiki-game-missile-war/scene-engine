import { DISPLAY_CODEC, encodePacket } from '../src/wire.js';
import {
  encodeDisplayCheckpoint,
  encodeDisplayCommandStream,
} from '../src/display.js';

export const STREAM_ID = '00000000-0000-4000-8000-000000000002';
export const WORLD_CODEC = 'example-world@2';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);

export function transform(x = 0) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, 0, 0, 1,
  ]);
}

export function baselineNode(nodeId = 0, parentNodeId = null) {
  return {
    node_id: nodeId,
    parent_node_id: parentNodeId,
    prefab_id: 'unit.example',
    transform_mode: 'live',
    visible: true,
    state: { mode: 'idle' },
  };
}

function checkpointMatrixPool(nodes, matrixPoolSize, supplied) {
  if (supplied !== null) return supplied;
  const result = new Float32Array(matrixPoolSize * 16);
  for (const node of nodes) result.set(transform(), node.node_id * 16);
  return result;
}

export function checkpointPacket({
  commitSeq = 0,
  sourceTick = 0,
  worldRevision = 0,
  lastCommandSeq = 0,
  worldSnapshot = { tick: sourceTick, world_revision: worldRevision, value: 0 },
  nodes = [baselineNode()],
  matrixPoolSize = nodes.length === 0
    ? 0 : Math.max(...nodes.map((node) => node.node_id)) + 1,
  matrixPool = null,
  sceneCatalogHash = HASH_A,
  prefabCatalogHash = HASH_B,
  stateSchemaHash = HASH_C,
} = {}) {
  return encodePacket('engine.checkpoint', {
    schema: 'scene-engine-wire@3',
    type: 'engine.checkpoint',
    stream_id: STREAM_ID,
    commit_seq: commitSeq,
    source_tick: sourceTick,
    world_revision: worldRevision,
    last_command_seq: lastCommandSeq,
    world_codec: WORLD_CODEC,
    display_codec: DISPLAY_CODEC,
  }, [
    { kind: 'world_snapshot', encoding: 'json', value: worldSnapshot },
    {
      kind: 'display_checkpoint',
      encoding: 'raw',
      value: encodeDisplayCheckpoint({
        schema: 'scene-engine-display-checkpoint@6',
        scene_name: 'main',
        scene_catalog_hash: sceneCatalogHash,
        prefab_catalog_hash: prefabCatalogHash,
        state_schema_hash: stateSchemaHash,
        last_command_seq: lastCommandSeq,
        matrix_pool_size: matrixPoolSize,
        matrix_pool: checkpointMatrixPool(nodes, matrixPoolSize, matrixPool),
        nodes,
      }),
    },
  ]);
}

export function command(kind, commandSeq, sourceTick, fields = {}) {
  return {
    schema: 'scene-engine-node-command@6',
    command_seq: commandSeq,
    source_tick: sourceTick,
    kind,
    node_id: fields.node_id ?? fields.nodeId ?? 0,
    ...fields,
  };
}

function commandMatrix(commandValue) {
  return commandValue.matrix ?? transform(commandValue.node_id);
}

function transportCommand(commandValue) {
  const { matrix: _matrix, nodeId: _nodeId, ...record } = commandValue;
  return record;
}

function matrixBatch(commands, suppliedIds, suppliedMatrices) {
  if (suppliedIds !== null || suppliedMatrices !== null) {
    if (suppliedIds === null || suppliedMatrices === null) {
      throw new Error('dirtyNodeIds and dirtyMatrices must be supplied together');
    }
    return { nodeIds: suppliedIds, matrices: suppliedMatrices };
  }
  const matrixCommands = commands.filter(({ kind }) => (
    kind === 'node-create' || kind === 'node-set-transform'
  )).sort((left, right) => left.node_id - right.node_id);
  const nodeIds = new Uint32Array(matrixCommands.map(({ node_id: id }) => id));
  const matrices = new Float32Array(nodeIds.length * 16);
  matrixCommands.forEach((entry, index) => matrices.set(commandMatrix(entry), index * 16));
  return { nodeIds, matrices };
}

export function commitPacket({
  commitSeq = 1,
  sourceTick = 1,
  worldRevision = 1,
  baseCommandSeq = 0,
  commands = [],
  matrixPoolSize = Math.max(1, ...commands.flatMap((entry) => [
    entry.node_id + 1,
    entry.parent_node_id === null || entry.parent_node_id === undefined
      ? 0 : entry.parent_node_id + 1,
  ])),
  dirtyNodeIds = null,
  dirtyMatrices = null,
  cause = 'tick',
  causationId = null,
  worldPatch = {
    schema: 'scene-engine-json-tree@1',
    changes: [
      { op: 'set', path: ['tick'], value: sourceTick },
      { op: 'set', path: ['world_revision'], value: worldRevision },
    ],
  },
} = {}) {
  const batch = matrixBatch(commands, dirtyNodeIds, dirtyMatrices);
  const lastCommandSeq = baseCommandSeq + commands.length;
  return encodePacket('engine.commit', {
    schema: 'scene-engine-wire@3',
    type: 'engine.commit',
    stream_id: STREAM_ID,
    commit_seq: commitSeq,
    source_tick: sourceTick,
    world_revision: worldRevision,
    cause,
    causation_id: causationId,
    last_command_seq: lastCommandSeq,
    world_codec: WORLD_CODEC,
    display_codec: DISPLAY_CODEC,
  }, [
    { kind: 'world_patch', encoding: 'json', value: worldPatch },
    {
      kind: 'display_command_stream',
      encoding: 'raw',
      value: encodeDisplayCommandStream({
        schema: 'scene-engine-display-command-stream@6',
        base_command_seq: baseCommandSeq,
        last_command_seq: lastCommandSeq,
        matrix_pool_size: matrixPoolSize,
        dirty_node_ids: batch.nodeIds,
        dirty_matrices: batch.matrices,
        commands: commands.map(transportCommand),
      }, { sourceTick }),
    },
  ]);
}

export function createMockDisplayFactory({ failMethod = null, asyncMethod = null } = {}) {
  const sessions = [];
  const factory = (metadata) => {
    const id = sessions.length + 1;
    const log = [];
    const view = Object.freeze({ sessionId: id });
    const metrics = { summaryCalls: 0, currentViewCalls: 0 };
    const nodes = new Set();
    let cursor = null;
    const invoke = (method, value) => {
      log.push([method, value]);
      if (method === failMethod) throw new Error(`failed:${method}`);
      if (method === asyncMethod) return Promise.resolve();
      return undefined;
    };
    const authorityPort = {
      installNodeMatrixPool: (value) => invoke('installNodeMatrixPool', value),
      applyNodeTransformBatch: (value) => invoke('applyNodeTransformBatch', value),
      createNode(value) {
        const result = invoke('createNode', value);
        if (result === undefined) nodes.add(value.nodeId);
        return result;
      },
      setNodeTransform: (value) => invoke('setNodeTransform', value),
      setNodeParent: (value) => invoke('setNodeParent', value),
      setNodeVisible: (value) => invoke('setNodeVisible', value),
      setNodeState: (value) => invoke('setNodeState', value),
      replaceNodePrefab: (value) => invoke('replaceNodePrefab', value),
      removeNode(value) {
        const result = invoke('removeNode', value);
        if (result === undefined) nodes.delete(value.nodeId);
        return result;
      },
    };
    const session = {
      runtime: {
        catalogIdentity() {
          return Object.freeze({
            sceneCatalogHash: metadata.sceneCatalogHash,
            prefabCatalogHash: metadata.prefabCatalogHash,
            stateSchemaHash: metadata.stateSchemaHash,
          });
        },
        installScene: (value) => invoke('installScene', value),
        activate(value) {
          const result = invoke('activate', value);
          if (result === undefined) cursor = value;
          return result;
        },
        start: () => invoke('start'),
        summary() {
          metrics.summaryCalls += 1;
          const result = invoke('summary');
          if (result !== undefined) return result;
          return Object.freeze({
            schema: 'scene-engine-display-summary@1',
            sceneName: metadata.sceneName,
            revision: metrics.summaryCalls,
            cursor,
            nodeCount: nodes.size,
            health: 'ready',
          });
        },
        currentView() {
          metrics.currentViewCalls += 1;
          return view;
        },
      },
      authorityPort,
      commitGate: {
        begin: (cursor) => invoke('begin', cursor),
        seal(value) {
          const result = invoke('seal', value);
          if (result === undefined) cursor = value;
          return result;
        },
        fail: (error) => invoke('fail', error),
      },
      dispose: () => invoke('dispose'),
    };
    sessions.push({ id, metadata, log, metrics, session, view });
    return session;
  };
  return { factory, sessions };
}
