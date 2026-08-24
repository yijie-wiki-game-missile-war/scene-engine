import { DISPLAY_CODEC, encodePacket } from '../src/wire.js';

export const STREAM_ID = '00000000-0000-4000-8000-000000000002';
export const WORLD_CODEC = 'example-world@2';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);

export function transform(x = 0) {
  return {
    position: [x, 0, 0],
    rotationXyzw: [0, 0, 0, 1],
    scale: [1, 1, 1],
  };
}

export function baselineNode(name = 'py/unit-1', parentName = null) {
  return {
    name,
    parent_name: parentName,
    prefab_type: 'unit.example',
    transform_mode: 'live',
    transform: transform(),
    visible: true,
    state: { mode: 'idle' },
  };
}

export function checkpointPacket({
  commitSeq = 0,
  sourceTick = 0,
  worldRevision = 0,
  lastCommandSeq = 0,
  worldSnapshot = { tick: sourceTick, world_revision: worldRevision, value: 0 },
  nodes = [baselineNode()],
} = {}) {
  return encodePacket('engine.checkpoint', {
    schema: 'scene-engine-wire@2',
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
      encoding: 'json',
      value: {
        schema: 'scene-engine-display-checkpoint@2',
        scene_name: 'main',
        scene_catalog_hash: HASH_A,
        prefab_catalog_hash: HASH_B,
        state_schema_hash: HASH_C,
        last_command_seq: lastCommandSeq,
        nodes,
      },
    },
  ]);
}

export function command(kind, commandSeq, sourceTick, fields = {}) {
  return {
    schema: 'scene-engine-node-command@2',
    command_seq: commandSeq,
    source_tick: sourceTick,
    kind,
    name: fields.name ?? 'py/unit-1',
    ...fields,
  };
}

export function commitPacket({
  commitSeq = 1,
  sourceTick = 1,
  worldRevision = 1,
  baseCommandSeq = 0,
  commands = [],
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
  const lastCommandSeq = baseCommandSeq + commands.length;
  return encodePacket('engine.commit', {
    schema: 'scene-engine-wire@2',
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
      encoding: 'json',
      value: {
        schema: 'scene-engine-display-command-stream@2',
        base_command_seq: baseCommandSeq,
        last_command_seq: lastCommandSeq,
        commands,
      },
    },
  ]);
}

export function createMockDisplayFactory({ failMethod = null, asyncMethod = null } = {}) {
  const sessions = [];
  const factory = (metadata) => {
    const id = sessions.length + 1;
    const log = [];
    const view = Object.freeze({ sessionId: id });
    const invoke = (method, value) => {
      log.push([method, value]);
      if (method === failMethod) throw new Error(`failed:${method}`);
      if (method === asyncMethod) return Promise.resolve();
      return undefined;
    };
    const authorityPort = Object.fromEntries([
      'createNode', 'setNodeTransform', 'setNodeParent', 'setNodeVisible',
      'setNodeState', 'replaceNodePrefab', 'removeNode',
    ].map((method) => [method, (value) => invoke(method, value)]));
    const session = {
      runtime: {
        installScene: (value) => invoke('installScene', value),
        activate: (cursor) => invoke('activate', cursor),
        start: () => invoke('start'),
      },
      authorityPort,
      displayViewProvider: () => view,
      commitGate: {
        begin: (cursor) => invoke('begin', cursor),
        seal: (cursor) => invoke('seal', cursor),
        fail: (error) => invoke('fail', error),
      },
      dispose: () => invoke('dispose'),
    };
    sessions.push({ id, metadata, log, session, view });
    return session;
  };
  return { factory, sessions };
}
