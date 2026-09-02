import * as THREE from 'three';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayKindRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineFrameAnimation,
  defineDisplayKind,
  definePrefab,
  defineScene,
} from '../../display/src/index.js';
import { ThreeRenderBackend } from '../src/backend.js';
import {
  DEFAULT_THREE_IMPLEMENTATION,
  disposeThreeResource,
  loadThreeResource,
} from '../src/resources.js';
import {
  IDENTITY_MATRIX,
  composeMatrix4,
} from '../../../../scripts/support/matrix4.mjs';

export const IDENTITY = IDENTITY_MATRIX;

export const GEOMETRY_PREFAB_ID = 'foundation/geometry';
export const NESTED_PREFAB_ID = 'foundation/nested';

const authorityMatrixPoolSizes = new WeakMap();

const PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x1018_20ff,
  antialias: false,
  alpha: false,
  shadows: true,
  toneMapping: 'none',
});

const RESOURCES = Object.freeze([
  Object.freeze({
    id: 'foundation/mesh',
    kind: 'mesh',
    positions: Object.freeze([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0, 0.5, 0,
    ]),
    indices: Object.freeze([0, 1, 2]),
  }),
  Object.freeze({
    id: 'foundation/material',
    kind: 'material',
    family: 'material.standard',
    properties: Object.freeze({
      tintRgba: 0x66aa_ffff,
      opacity: 1,
      emissive: 0,
      alphaMode: 'opaque',
      alphaCutoff: 0,
    }),
  }),
  Object.freeze({
    id: 'foundation/texture',
    kind: 'texture',
    url: 'memory:foundation-texture',
  }),
  Object.freeze({
    id: 'foundation/atlas',
    kind: 'texture-atlas',
    textureResourceId: 'foundation/texture',
    columns: 4,
    rows: 1,
  }),
  Object.freeze({
    id: 'foundation/model',
    kind: 'model',
    url: 'memory:foundation-model',
  }),
  Object.freeze({
    id: 'foundation/surface',
    kind: 'surface',
    family: 'surface.water',
    geometry: Object.freeze({
      primitive: 'plane',
      width: 2,
      height: 2,
      segmentsX: 1,
      segmentsY: 1,
    }),
    textureResourceIds: Object.freeze([]),
    defaults: Object.freeze({ amplitude: 0.1, speed: 1, foam: 0.25, textureScale: 1 }),
  }),
  Object.freeze({
    id: 'foundation/particle',
    kind: 'particle',
    maximumCapacity: 32,
    textureResourceId: null,
    defaults: Object.freeze({}),
  }),
  defineFrameAnimation({
    id: 'foundation/sprite-cycle',
    target: Object.freeze({ node: 'sprite-node', component: 'sprite' }),
    frames: Object.freeze([0, 1, 2, 3]),
    fps: 10,
    loop: true,
  }),
]);

export class DeterministicFrameAdapter {
  constructor() {
    this._next = 1;
    this._callbacks = new Map();
    this.time = 0;
  }

  request(callback) {
    const id = this._next;
    this._next += 1;
    this._callbacks.set(id, callback);
    return id;
  }

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

export class DeterministicThreeRenderer {
  constructor() {
    this.draws = 0;
    this.disposed = false;
    this.pixelRatio = 1;
    this.width = 1;
    this.height = 1;
    this.info = Object.freeze({
      render: { calls: 0 },
      memory: { geometries: 0, textures: 0 },
    });
  }

  setPixelRatio(value) { this.pixelRatio = value; }
  setSize(width, height) { this.width = width; this.height = height; }
  render(scene) {
    scene.updateMatrixWorld(true);
    this.draws += 1;
    this.info.render.calls += 1;
  }
  dispose() { this.disposed = true; }
}

export function transformAt(position, {
  rotationXyzw = [0, 0, 0, 1],
  scale = [1, 1, 1],
} = {}) {
  return composeMatrix4(position, rotationXyzw, scale);
}

export function createAuthorityNode({
  nodeId,
  displayKindId = GEOMETRY_PREFAB_ID,
  parentNodeId = null,
  visible = true,
  state = {},
}) {
  return {
    nodeId,
    parentNodeId,
    displayKindId,
    transformMode: 'live',
    visible,
    state,
  };
}

export function authorityNodeName(nodeId) { return `py/${nodeId}`; }

function installEmptyAuthorityMatrixPool(runtime) {
  runtime.authority.installNodeMatrixPool({
    poolSize: 0,
    matrices: new Float32Array(),
  });
  authorityMatrixPoolSizes.set(runtime, 0);
}

function stageAuthorityMatrices(runtime, matrixRows) {
  const currentPoolSize = authorityMatrixPoolSizes.get(runtime);
  if (currentPoolSize === undefined) throw new Error('test authority matrix pool is not installed');
  const rows = [...matrixRows].sort(([left], [right]) => left - right);
  const nodeIds = new Uint32Array(rows.length);
  const matrices = new Float32Array(rows.length * 16);
  let previous = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const [nodeId, matrix] = rows[index];
    if (!Number.isSafeInteger(nodeId) || nodeId < 0 || nodeId <= previous) {
      throw new Error(`invalid test authority matrix row: ${nodeId}`);
    }
    if (matrix.length !== 16) throw new Error('test authority matrix must contain 16 values');
    nodeIds[index] = nodeId;
    matrices.set(matrix, index * 16);
    previous = nodeId;
  }
  const poolSize = rows.length === 0
    ? currentPoolSize
    : Math.max(currentPoolSize, nodeIds.at(-1) + 1);
  runtime.authority.applyNodeTransformBatch({ poolSize, nodeIds, matrices });
  authorityMatrixPoolSizes.set(runtime, poolSize);
}

/** Apply one Authority transaction through the same begin/apply/seal boundary as Client. */
export function commitAuthority(runtime, mutate, {
  sourceTickDelta = 1,
  commandCount = 1,
  matrixRows = [],
} = {}) {
  const previous = runtime.summary().cursor;
  const cursor = Object.freeze({
    commitSeq: previous.commitSeq + 1,
    sourceTick: previous.sourceTick + sourceTickDelta,
    lastCommandSeq: previous.lastCommandSeq + commandCount,
  });
  runtime.commitGate.begin(cursor);
  try {
    stageAuthorityMatrices(runtime, matrixRows);
    const result = mutate(cursor);
    runtime.commitGate.seal(cursor);
    return result;
  } catch (error) {
    runtime.commitGate.fail(error);
    throw error;
  }
}

export function backendRecord(backend, nodeName, componentKey) {
  return backend._bindings.get(JSON.stringify([nodeName, componentKey])) ?? null;
}

export async function createFoundationHarness() {
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry(RESOURCES);
  const geometryPrefab = createGeometryPrefab();
  const nestedPrefab = createNestedPrefab();
  const prefabRegistry = createPrefabRegistry([geometryPrefab, nestedPrefab]);
  const displayKindRegistry = createDisplayKindRegistry([
    defineDisplayKind({
      id: geometryPrefab.id,
      gameplayType: geometryPrefab.gameplayType,
      revision: 1,
      authorityPrefabIds: [geometryPrefab.id],
      defaultPrefabId: geometryPrefab.id,
    }),
    defineDisplayKind({
      id: nestedPrefab.id,
      gameplayType: nestedPrefab.gameplayType,
      revision: 1,
      authorityPrefabIds: [nestedPrefab.id],
      defaultPrefabId: nestedPrefab.id,
    }),
  ]);
  const sceneRegistry = createSceneRegistry([createFoundationScene()]);
  const frames = new DeterministicFrameAdapter();
  const backends = [];
  const health = [];
  const hostElement = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
  };
  const canvas = {
    getContext: () => ({}),
    toDataURL: () => 'data:image/png;base64,foundation',
  };
  const createRenderBackend = (options) => {
    const renderer = new DeterministicThreeRenderer();
    let observerDisconnected = false;
    const backend = new ThreeRenderBackend(options, {
      ...DEFAULT_THREE_IMPLEMENTATION,
      createRenderer: () => renderer,
      createResizeObserver: () => ({
        observe() {},
        disconnect() { observerDisconnected = true; },
      }),
      devicePixelRatio: () => 1,
      loadResource: loadMemoryResource,
      disposeResource: disposeThreeResource,
    });
    backends.push({
      backend,
      renderer,
      get observerDisconnected() { return observerDisconnected; },
    });
    return backend;
  };
  const runtime = createDisplayRuntime({
    hostElement,
    canvas,
    sceneRegistry,
    displayKindRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas: [
      { gameplayType: 'foundation.geometry', schemaId: 'foundation.geometry.state', revision: 1 },
      { gameplayType: 'foundation.nested', schemaId: 'foundation.nested.state', revision: 1 },
    ],
    createRenderBackend,
    frameAdapter: frames,
    onHealth: (event) => health.push(event),
  });
  runtime.installScene({ sceneName: 'main' });
  installEmptyAuthorityMatrixPool(runtime);
  runtime.activate();
  runtime.start();
  await runtime.whenReady();
  return { runtime, frames, backends, health };
}

function createGeometryPrefab() {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: GEOMETRY_PREFAB_ID,
    revision: 1,
    gameplayType: 'foundation.geometry',
    root: {
      components: [{
        key: 'animator',
        type: 'animation.player@1',
        properties: { animationId: 'foundation/sprite-cycle' },
      }],
      children: [
        {
          localName: 'mesh-node',
          transform: IDENTITY,
          visible: true,
          components: [{
            key: 'mesh',
            type: 'render.mesh@1',
            properties: {
              meshResourceId: 'foundation/mesh',
              materialResourceId: 'foundation/material',
              pickable: true,
            },
          }],
          children: [],
        },
        {
          localName: 'sprite-node',
          transform: transformAt([1, 0, 0]),
          visible: true,
          components: [{
            key: 'sprite',
            type: 'render.sprite@3',
            properties: {
              textureResourceId: 'foundation/atlas',
              width: 1,
              height: 1,
              frame: 0,
              pickable: true,
            },
          }],
          children: [],
        },
        {
          localName: 'model-node',
          transform: transformAt([2, 0, 0]),
          visible: true,
          components: [{
            key: 'model',
            type: 'render.model@2',
            properties: {
              modelResourceId: 'foundation/model',
              materialOverrides: {},
              pickable: true,
            },
          }],
          children: [],
        },
        {
          localName: 'surface-node',
          transform: transformAt([3, 0, 0]),
          visible: true,
          components: [{
            key: 'surface',
            type: 'render.surface@1',
            properties: {
              surfaceResourceId: 'foundation/surface',
              parameters: {},
              pickable: true,
            },
          }],
          children: [],
        },
        {
          localName: 'particle-node',
          transform: transformAt([4, 0, 0]),
          visible: true,
          components: [{
            key: 'particle',
            type: 'render.particle@2',
            properties: {
              particleResourceId: 'foundation/particle',
              intensity: 1,
              parameters: {
                durationTicks: 60,
                capacity: 16,
                seed: 7,
                rate: 12,
                size: 0.15,
                velocity: [0, 1, 0],
                spread: [0.25, 0.25, 0.25],
                gravity: [0, -1, 0],
                blendMode: 'additive',
              },
            },
          }],
          children: [],
        },
      ],
    },
    resolveState(state) {
      const nodes = {};
      const components = {};
      if (Object.hasOwn(state, 'meshTransform') || Object.hasOwn(state, 'meshVisible')) {
        nodes['mesh-node'] = {
          ...(Object.hasOwn(state, 'meshTransform') ? { transform: state.meshTransform } : {}),
          ...(Object.hasOwn(state, 'meshVisible') ? { visible: state.meshVisible } : {}),
        };
      }
      if (Object.hasOwn(state, 'meshRenderOrder')) {
        components['mesh-node/mesh'] = { renderOrder: state.meshRenderOrder };
      }
      if (Object.hasOwn(state, 'spriteAlpha')) {
        components['sprite-node/sprite'] = { alpha: state.spriteAlpha };
      }
      if (Object.hasOwn(state, 'particleIntensity')) {
        components['particle-node/particle'] = { intensity: state.particleIntensity };
      }
      return { nodes, components };
    },
  });
}

function createNestedPrefab() {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: NESTED_PREFAB_ID,
    revision: 1,
    gameplayType: 'foundation.nested',
    root: {
      components: [],
      children: [{
        localName: 'mount',
        transform: IDENTITY,
        visible: true,
        components: [],
        children: [],
      }],
    },
    prefabInstances: [{
      key: 'fixed',
      parentLocalPath: 'mount',
      prefabId: GEOMETRY_PREFAB_ID,
      transform: transformAt([1, 0, 0]),
      visible: true,
      state: {},
    }],
    prefabSlots: [{
      key: 'units',
      parentLocalPath: 'mount',
      allowedPrefabIds: [GEOMETRY_PREFAB_ID],
      maximumInstances: 4,
    }],
    resolveState(state) {
      const fixed = { state: state.fixedState ?? {} };
      if (Object.hasOwn(state, 'fixedTransform')) fixed.transform = state.fixedTransform;
      if (Object.hasOwn(state, 'fixedVisible')) fixed.visible = state.fixedVisible;
      return {
        nodes: {},
        components: {},
        prefabInstances: { fixed },
        prefabSlots: { units: state.units ?? {} },
      };
    },
  });
}

function createFoundationScene() {
  return defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'foundation',
    rendererProfile: PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [
      {
        localName: 'camera',
        parentLocalName: null,
        transform: transformAt([0, 5, 20]),
        components: [{
          key: 'camera',
          type: 'render.camera@1',
          properties: { projection: 'perspective', fovYDegrees: 60, near: 0.1, far: 1_000 },
        }],
      },
      {
        localName: 'background',
        parentLocalName: null,
        transform: IDENTITY,
        components: [{
          key: 'background',
          type: 'render.background@1',
          properties: { colorRgba: 0x1018_20ff },
        }],
      },
      {
        localName: 'light',
        parentLocalName: null,
        transform: transformAt([0, 8, 4]),
        components: [{
          key: 'light',
          type: 'render.directional-light@1',
          properties: { colorRgba: 0xffff_ffff, intensity: 1.5, castShadow: true },
        }],
      },
    ],
    prefabInstances: [],
  });
}

async function loadMemoryResource(resource, signal, dependencies) {
  if (signal.aborted) throw signal.reason ?? new Error('memory resource load aborted');
  if (resource.kind === 'texture') {
    const texture = new THREE.Texture();
    texture.name = resource.id;
    texture.needsUpdate = true;
    return { kind: 'texture', descriptor: resource, texture, ownsTexture: true };
  }
  if (resource.kind === 'model') {
    const template = new THREE.Group();
    template.name = resource.id;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x88aaff });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'body';
    template.add(mesh);
    return { kind: 'model', descriptor: resource, template, templates: [template] };
  }
  return loadThreeResource(resource, signal, dependencies);
}
