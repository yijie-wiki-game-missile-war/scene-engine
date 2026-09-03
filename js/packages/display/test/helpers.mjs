import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayKindRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  defineDisplayKind,
  defineScene,
} from '../src/index.js';
import { createFakeRenderBackend } from '../src/testing/fake-render-backend.js';

export function matrixTransform({
  position = [0, 0, 0],
  rotationXyzw = [0, 0, 0, 1],
  scale = [1, 1, 1],
} = {}) {
  let [x, y, z, w] = rotationXyzw;
  const quaternionLength = Math.hypot(x, y, z, w);
  x /= quaternionLength; y /= quaternionLength; z /= quaternionLength; w /= quaternionLength;
  const [sx, sy, sz] = scale;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return Object.freeze([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    position[0], position[1], position[2], 1,
  ].map((value) => {
    const result = Math.fround(value);
    return Object.is(result, -0) ? 0 : result;
  }));
}

export const IDENTITY = matrixTransform();

export function matrixPosition(matrix) { return matrix.slice(12, 15); }

function ownedMatrixTensor(matrix) { return new Float32Array(matrix); }

function createNumericAuthorityTestAdapter(authority) {
  let poolSize = 0;
  authority.installNodeMatrixPool({ poolSize, matrices: new Float32Array() });

  const stage = (nodeId, matrix, nextPoolSize) => {
    authority.applyNodeTransformBatch({
      poolSize: nextPoolSize,
      nodeIds: new Uint32Array([nodeId]),
      matrices: ownedMatrixTensor(matrix),
    });
    poolSize = nextPoolSize;
  };

  return {
    installNodeMatrixPool: (record) => authority.installNodeMatrixPool(record),
    applyNodeTransformBatch(record) {
      authority.applyNodeTransformBatch(record);
      poolSize = record.poolSize;
    },
    createNode(command) {
      const { transform = IDENTITY, ...record } = command;
      if (!Number.isSafeInteger(record.nodeId) || record.nodeId !== poolSize) {
        throw new Error(`test authority node IDs must append densely: ${record.nodeId}`);
      }
      stage(record.nodeId, transform, poolSize + 1);
      const result = authority.createNode(record);
      authority._assertMatrixPoolSettled();
      return result;
    },
    setNodeTransforms(command) {
      const nodeIds = new Uint32Array(command.nodeIds);
      const matrices = ownedMatrixTensor(command.matrices);
      authority.applyNodeTransformBatch({ poolSize, nodeIds, matrices });
      const result = authority.setNodeTransforms({ nodeIds });
      authority._assertMatrixPoolSettled();
      return result;
    },
    setNodeParent: (record) => authority.setNodeParent(record),
    setNodeVisible: (record) => authority.setNodeVisible(record),
    setNodeState: (record) => authority.setNodeState(record),
    setNodeProperty: (record) => authority.setNodeProperty(record),
    unsetNodeProperty: (record) => authority.unsetNodeProperty(record),
    emitNodeEvent: (record) => authority.emitNodeEvent(record),
    setNodeDisplayKind: (record) => authority.setNodeDisplayKind(record),
    currentDiagnostics: () => authority.currentDiagnostics(),
    removeNode: (record) => authority.removeNode(record),
    _assertMatrixPoolSettled: () => authority._assertMatrixPoolSettled(),
    _release: () => authority._release(),
  };
}

export const RENDERER_PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x000000ff,
  antialias: false,
  alpha: false,
  shadows: false,
  toneMapping: 'none',
});

export class FakeFrameAdapter {
  constructor() { this._next = 1; this._callbacks = new Map(); this.time = 0; }
  request(callback) { const id = this._next++; this._callbacks.set(id, callback); return id; }
  cancel(id) { this._callbacks.delete(id); }
  now() { return this.time; }
  get pending() { return this._callbacks.size; }
  step(milliseconds = 16) {
    this.time += milliseconds;
    const callbacks = [...this._callbacks.values()];
    this._callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }
}

export function emptyPrefab({ id = 'target.test.item', gameplayType = 'test.item',
  events = [], childName = 'body', resolveState = undefined, childComponents = [] } = {}) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    gameplayType,
    events,
    root: {
      components: [],
      children: childName === null ? [] : [{
        localName: childName,
        transform: IDENTITY,
        visible: true,
        components: childComponents,
        children: [],
      }],
    },
    ...(resolveState ? { resolveState } : {}),
  });
}

export async function createHarness({ prefabEntries = null, resources = [], sceneNodes = [],
  prefabInstances = [], backendFactory = null, onHealth = null, configureComponents = null,
  bootstrapAuthority = null, runtimeOptions = {}, rawAuthority = false,
  displayKindEntries = null, compositionPlan = null,
} = {}) {
  const componentRegistry = createComponentRegistry();
  configureComponents?.(componentRegistry);
  const resourceRegistry = createResourceRegistry(resources);
  const defaultPrefab = emptyPrefab();
  const entries = prefabEntries ?? [defaultPrefab];
  const prefabRegistry = createPrefabRegistry(entries);
  const kinds = displayKindEntries ?? entries.map((entry) => defineDisplayKind({
    id: entry.id,
    gameplayType: entry.gameplayType,
    revision: 1,
    authorityPrefabIds: [entry.id],
    defaultPrefabId: entry.id,
  }));
  const displayKindRegistry = createDisplayKindRegistry(kinds);
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE,
    compositionPlan,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: IDENTITY,
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 },
      }],
    }, ...sceneNodes],
    prefabInstances,
  });
  const sceneRegistry = createSceneRegistry([scene]);
  const frames = new FakeFrameAdapter();
  const fakeBackends = [];
  const createBackend = backendFactory ?? (() => {
    const fake = createFakeRenderBackend(); fakeBackends.push(fake); return fake.backend;
  });
  const runtime = createDisplayRuntime({
    sceneRegistry,
    displayKindRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas: [...new Set(entries.map((entry) => entry.gameplayType))].map(
      (gameplayType) => ({ gameplayType, schemaId: `${gameplayType}.state`, revision: 1 }),
    ),
    createRenderBackend: createBackend,
    frameAdapter: frames,
    onHealth,
    ...runtimeOptions,
  });
  const installReturn = runtime.installScene({ sceneName: 'main' });
  if (!rawAuthority) {
    runtime.authority = Object.freeze(createNumericAuthorityTestAdapter(runtime.authority));
  }
  bootstrapAuthority?.(runtime.authority);
  runtime.activate();
  return { runtime, frames, fakeBackends, componentRegistry, resourceRegistry,
    displayKindRegistry, prefabRegistry, sceneRegistry, installReturn };
}

/** Apply one synchronous Authority transaction using the same begin/apply/seal boundary as Client. */
export function commitAuthority(runtime, mutate, {
  sourceTickDelta = 0,
  commandCount = 1,
} = {}) {
  const previous = runtime.summary().cursor;
  const cursor = Object.freeze({
    commitSeq: previous.commitSeq + 1,
    sourceTick: previous.sourceTick + sourceTickDelta,
    lastCommandSeq: previous.lastCommandSeq + commandCount,
  });
  runtime.commitGate.begin(cursor);
  try {
    const result = mutate(cursor);
    runtime.commitGate.seal(cursor);
    return result;
  } catch (error) {
    runtime.commitGate.fail(error);
    throw error;
  }
}
