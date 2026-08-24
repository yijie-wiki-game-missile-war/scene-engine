import {
  MAXIMUM_PENDING_JOBS,
  NODE_VISIBLE,
  THREE_RENDER_RUNTIME_SCHEMA,
} from './constants.js';
import {
  assertPlan,
  assertView,
  batchFingerprint,
  cursorOf,
  displayId,
  emptyBatch,
  layerFingerprint,
  nodeSnapshot,
  normalizeBatch,
  normalizeCameraProfile,
  normalizeRendererProfile,
  normalizeResourceCatalog,
  normalizeSnapshot,
  sameCursor,
} from './contracts.js';
import { fail } from './errors.js';
import { ResourceManager } from './resource-manager.js';
import { DEFAULT_THREE_ADAPTER } from './three-adapter.js';

const INTERNALS = new WeakMap();
const TEST_TOKEN = Object.freeze({});
const CONSTRUCTOR_FIELDS = Object.freeze(new Set([
  'hostElement',
  'canvas',
  'cameraProfile',
  'rendererProfile',
  'resourceCatalog',
  'onHealth',
]));

export class ThreeRenderRuntime {
  constructor(options, token = null, injectedAdapter = null) {
    if (arguments.length > 1 && token !== TEST_TOKEN) fail('render-constructor-invalid');
    const adapter = token === TEST_TOKEN ? injectedAdapter : DEFAULT_THREE_ADAPTER;
    INTERNALS.set(this, createState(options, adapter));
  }

  install({ view, snapshot } = {}) {
    const runtime = requireOpen(this);
    requireHealthy(runtime);
    if (runtime.cursor !== null) fail('render-runtime-already-installed');
    const prepared = prepareSnapshot(runtime, view, snapshot);
    mutate(runtime, 'render-install-failed', () => {
      installPreparedSnapshot(runtime, prepared);
    });
  }

  apply({ plan, view, batch } = {}) {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    const prepared = prepareSteps(runtime, [{ plan, view, batch }]);
    mutate(runtime, 'render-apply-failed', () => applyPreparedSteps(runtime, prepared));
  }

  applyBatch(steps) {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    if (!Array.isArray(steps) || steps.length === 0) fail('render-apply-batch-invalid');
    const prepared = prepareSteps(runtime, steps);
    mutate(runtime, 'render-apply-batch-failed', () => applyPreparedSteps(runtime, prepared));
  }

  rebuild({ view, snapshot } = {}) {
    const runtime = requireOpen(this);
    const prepared = prepareSnapshot(runtime, view, snapshot);
    const recovery = Object.freeze({
      cursor: prepared.cursor,
      failureVersion: runtime.failureVersion,
      wasUnhealthy: runtime.unhealthy,
    });
    runtime.recovery = recovery;
    try {
      clearProjection(runtime, 'renderer-rebuild');
      if (runtime.rendererTainted) replaceOwnedRenderer(runtime);
      installPreparedSnapshot(runtime, prepared);
    } catch (error) {
      markUnhealthy(runtime, 'render-rebuild-failed', error);
      throw error;
    }
  }

  start() {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    if (runtime.started) return;
    runtime.started = true;
    runtime.visualEpochMs = runtime.adapter.now();
    runtime.drawRequested = true;
    scheduleFrame(runtime);
  }

  stop() {
    const runtime = requireOpen(this);
    runtime.started = false;
    cancelFrame(runtime);
  }

  requestDraw() {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    requestDraw(runtime);
  }

  focusWorldPoint(value) {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    const record = exactRecord(value, ['position', 'radius'], 'render-focus-input-invalid');
    const position = finiteTuple(record.position, 3, 'render-focus-position-invalid');
    const radius = positiveFinite(record.radius, 'render-focus-radius-invalid');
    runtime.controls.focus(position, radius);
    requestDraw(runtime);
    return Object.freeze({ ok: true });
  }

  projectWorldPoint(value) {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    const record = exactRecord(value, ['position'], 'render-project-input-invalid');
    const position = finiteTuple(record.position, 3, 'render-project-position-invalid');
    return freezePlainResult(runtime.adapter.project(
      runtime.camera,
      runtime.hostElement,
      position,
    ), 'render-project-result-invalid');
  }

  pick(value) {
    const runtime = requireInstalled(this);
    requireHealthy(runtime);
    const record = exactRecord(value, ['clientX', 'clientY'], 'render-pick-input-invalid');
    const clientX = finiteNumber(record.clientX, 'render-pick-coordinate-invalid');
    const clientY = finiteNumber(record.clientY, 'render-pick-coordinate-invalid');
    flushMatrices(runtime);
    prepareBatches(runtime);
    const pickables = [];
    forEachBinding(runtime, (binding) => {
      if (binding.displayId !== null && binding.layer.pickable
          && binding.pipelineHandle?.object && isEffectivelyVisible(binding.container)) {
        pickables.push({
          object: binding.pipelineHandle.object,
          displayId: binding.displayId,
          layerKey: binding.layer.key,
        });
      }
    });
    for (const group of runtime.batches.values()) {
      const members = group.visibleMembers.filter((binding) => binding.layer.pickable);
      if (members.length === 0) continue;
      pickables.push({
        object: group.handle.object,
        batchMembers: members.map((binding) => Object.freeze({
          displayId: binding.displayId,
          layerKey: binding.layer.key,
        })),
      });
    }
    return freezePlainResult(runtime.adapter.pick(
      runtime.camera,
      runtime.hostElement,
      clientX,
      clientY,
      pickables,
    ), 'render-pick-result-invalid');
  }

  async whenIdle() {
    let runtime = requireOpen(this);
    while (runtime.pendingJobs.size > 0) {
      await Promise.allSettled([...runtime.pendingJobs]);
    }
    await runtime.resources.whenIdle();
    runtime = requireOpen(this);
    const recovery = runtime.recovery;
    if (recovery && runtime.cursor !== null && sameCursor(recovery.cursor, runtime.cursor)
        && recovery.failureVersion === runtime.failureVersion) {
      runtime.recovery = null;
      if (recovery.wasUnhealthy) {
        runtime.unhealthy = false;
        runtime.healthCause = null;
        runtime.healthFailure = null;
        requestDraw(runtime);
      }
    }
    requireHealthy(runtime);
    if (runtime.cursor) flushMatrices(runtime);
  }

  capture() {
    const runtime = requireInstalled(this);
    let layerCount = 0;
    const renderGroups = new Set();
    forEachBinding(runtime, (binding) => {
      layerCount += 1;
      renderGroups.add(binding.batchGroup?.key ?? binding.identity);
    });
    const resources = runtime.resources.capture();
    const rendererInfo = runtime.adapter.captureRendererInfo?.(runtime.renderer) ?? null;
    return Object.freeze({
      schema: THREE_RENDER_RUNTIME_SCHEMA,
      generation: runtime.cursor.generation,
      commitSeq: runtime.cursor.commitSeq,
      sourceTick: runtime.cursor.sourceTick,
      nodeCount: runtime.records.size,
      layerCount,
      sceneLayerCount: runtime.sceneLayers.size,
      batchCount: renderGroups.size,
      resourceCount: resources.resourceCount,
      pendingJobCount: runtime.pendingJobs.size,
      drawCount: runtime.drawCount,
      lastFrameCpuTimeMs: runtime.lastFrameCpuTimeMs,
      rendererInfo,
      ...(runtime.healthFailure === null ? {} : { healthFailure: runtime.healthFailure }),
      listenerCount: ownedCount(runtime.controls, 'listenerCount', runtime.listenerCount),
      observerCount: ownedCount(runtime.resizeObserver, 'observerCount', 1),
      rafCount: runtime.rafIdentity === null ? 0 : 1,
    });
  }

  dispose() {
    const runtime = INTERNALS.get(this);
    if (!runtime || runtime.closed) return;
    runtime.closed = true;
    runtime.started = false;
    cancelFrame(runtime);
    runtime.resizeObserver.disconnect();
    runtime.controls.dispose();
    clearProjection(runtime, 'renderer-disposed');
    runtime.resources.dispose();
    runtime.pendingJobs.clear();
    runtime.recovery = null;
    runtime.healthCause = null;
    runtime.healthFailure = null;
    for (const group of runtime.batches.values()) group.handle.dispose();
    runtime.batches.clear();
    runtime.batchRoot.removeFromParent?.();
    runtime.root.removeFromParent?.();
    runtime.sceneLayerRoot.removeFromParent?.();
    runtime.adapter.disposeRenderer(runtime.renderer);
    runtime.listenerCount = 0;
    runtime.cursor = null;
  }
}

export function createThreeRenderRuntime(options) {
  return new ThreeRenderRuntime(options);
}

export function createThreeRenderRuntimeForTest(options, adapter) {
  return new ThreeRenderRuntime(options, TEST_TOKEN, adapter);
}

function createState(options, adapter) {
  const record = exactOptions(options);
  if (!adapter || typeof adapter !== 'object') fail('render-adapter-invalid');
  if (!adapter.isHostElement(record.hostElement)) fail('render-host-element-invalid');
  if (!adapter.isCanvas(record.canvas)) fail('render-canvas-invalid');
  if (record.onHealth !== undefined && typeof record.onHealth !== 'function') {
    fail('render-health-port-invalid');
  }
  const cameraProfile = normalizeCameraProfile(record.cameraProfile);
  const rendererProfile = normalizeRendererProfile(record.rendererProfile);
  const resourceCatalog = normalizeResourceCatalog(record.resourceCatalog);
  const rect = record.hostElement.getBoundingClientRect();
  const width = positiveDimension(rect?.width);
  const height = positiveDimension(rect?.height);
  const renderer = adapter.createRenderer(record.canvas, rendererProfile);
  const scene = adapter.createScene();
  const camera = adapter.createCamera(cameraProfile, width / height);
  const root = adapter.createGroup();
  const sceneLayerRoot = adapter.createGroup();
  const batchRoot = adapter.createGroup();
  root.name = 'SceneEngineRenderRoot';
  sceneLayerRoot.name = 'SceneEngineSceneLayers';
  batchRoot.name = 'SceneEngineInstanceBatches';
  scene.add(root);
  scene.add(sceneLayerRoot);
  scene.add(batchRoot);
  const runtime = {
    adapter,
    batchRoot,
    batches: new Map(),
    camera,
    cameraProfile,
    canvas: record.canvas,
    closed: false,
    controls: null,
    cursor: null,
    drawCount: 0,
    drawing: false,
    drawRequested: false,
    hostElement: record.hostElement,
    listenerCount: 1,
    lastFrameCpuTimeMs: null,
    matrixDirty: false,
    nextRequestSeq: 1,
    onHealth: record.onHealth ?? null,
    pendingJobs: new Set(),
    rafIdentity: null,
    recovery: null,
    records: new Map(),
    renderer,
    rendererTainted: false,
    rendererProfile,
    resizeObserver: null,
    resources: null,
    root,
    scene,
    sceneLayerRoot,
    sceneLayers: new Map(),
    started: false,
    failureVersion: 0,
    healthCause: null,
    healthFailure: null,
    unhealthy: false,
    visualEpochMs: adapter.now(),
  };
  runtime.controls = adapter.createControls(camera, record.hostElement, cameraProfile, () => {
    if (!runtime.closed) requestDraw(runtime);
  });
  runtime.resources = new ResourceManager({
    adapter,
    catalog: resourceCatalog,
    onFailure(resourceId, error) {
      markUnhealthy(
        runtime,
        'render-resource-load-failed',
        new Error(`Resource ${resourceId} failed: ${errorMessage(error)}`, { cause: error }),
      );
    },
  });
  runtime.resizeObserver = adapter.createResizeObserver(() => {
    if (runtime.closed) return;
    resize(runtime);
    requestDraw(runtime);
  });
  runtime.resizeObserver.observe(record.hostElement);
  resize(runtime);
  return runtime;
}

function exactOptions(value) {
  if (!isPlainRecord(value)) fail('render-constructor-options-invalid');
  for (const key of Object.keys(value)) {
    if (!CONSTRUCTOR_FIELDS.has(key)) fail('render-constructor-option-unknown');
  }
  for (const key of [
    'hostElement', 'canvas', 'cameraProfile', 'rendererProfile', 'resourceCatalog',
  ]) {
    if (!Object.hasOwn(value, key)) fail('render-constructor-option-missing');
  }
  return value;
}

function prepareSnapshot(runtime, view, snapshotValue) {
  const viewCursor = assertView(view);
  const snapshot = normalizeSnapshot(snapshotValue, runtime.resources.catalog);
  const snapshotCursor = cursorOf(snapshot);
  if (!sameCursor(viewCursor, snapshotCursor)) fail('render-snapshot-view-mismatch');
  const nodes = collectViewNodes(view);
  const nodeIds = new Set(nodes.map((node) => node.displayId));
  if (snapshot.compositions.length !== nodes.length
      || snapshot.compositions.some((item) => !nodeIds.has(item.displayId))) {
    fail('render-snapshot-compositions-incomplete');
  }
  return Object.freeze({ cursor: viewCursor, nodes, snapshot, view });
}

function prepareSteps(runtime, rawSteps) {
  const virtual = {
    cursor: runtime.cursor,
    ids: new Set(runtime.records.keys()),
    revisions: new Map(
      [...runtime.records].map(([identity, record]) => [identity, record.renderRevision]),
    ),
  };
  const prepared = rawSteps.map((raw) => prepareStep(runtime, raw, virtual));
  return Object.freeze(prepared);
}

function prepareStep(runtime, raw, virtual) {
  if (!isPlainRecord(raw)) fail('render-apply-step-invalid');
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !['plan', 'view', 'batch'].every((key) => Object.hasOwn(raw, key))) {
    fail('render-apply-step-invalid');
  }
  const viewCursor = assertView(raw.view);
  const batch = normalizeBatch(raw.batch, runtime.resources.catalog);
  const batchCursor = cursorOf(batch);
  if (!sameCursor(viewCursor, batchCursor)) fail('render-batch-view-mismatch');
  let plan = null;
  if (raw.plan === null) {
    const local = sameCursor(viewCursor, virtual.cursor);
    const engineNoFrame = viewCursor.generation === virtual.cursor.generation
      && viewCursor.commitSeq === virtual.cursor.commitSeq + 1
      && viewCursor.sourceTick >= virtual.cursor.sourceTick
      && viewCursor.sourceTick <= virtual.cursor.sourceTick + 1
      && emptyBatch(batch);
    if (!local && !engineNoFrame) fail('render-null-plan-cursor-invalid');
  } else {
    const planCursor = assertPlan(raw.plan);
    if (!sameCursor(planCursor, viewCursor)) fail('render-plan-view-mismatch');
    if (viewCursor.generation !== virtual.cursor.generation
        || viewCursor.commitSeq !== virtual.cursor.commitSeq + 1
        || viewCursor.sourceTick < virtual.cursor.sourceTick
        || viewCursor.sourceTick > virtual.cursor.sourceTick + 1) {
      fail('render-frame-cursor-not-next');
    }
    plan = raw.plan;
  }
  const nodes = collectViewNodes(raw.view);
  validateStepProjection(plan, nodes, batch, virtual);
  virtual.cursor = viewCursor;
  return Object.freeze({
    batch,
    cursor: viewCursor,
    nodes,
    nodesById: new Map(nodes.map((node) => [node.displayId, node])),
    plan,
  });
}

function validateStepProjection(plan, nodes, batch, virtual) {
  const targetIds = new Set(nodes.map((node) => node.displayId));
  if (plan) {
    const dirtyFields = [
      'animationDirtyIds', 'createIds', 'interactionDirtyIds', 'localPoseDirtyIds',
      'profileStateDirtyIds', 'removeIds', 'reparentIds', 'visibilityDirtyIds',
      'visualReplaceIds',
    ];
    for (const field of dirtyFields) {
      assertIdArrayUnique(plan[field], `render-plan-${field}-duplicate`);
    }
    for (const identity of plan.removeIds) {
      if (targetIds.has(identity) || !virtual.ids.delete(identity)) {
        fail('render-plan-remove-missing');
      }
      virtual.revisions.delete(identity);
    }
    for (const identity of plan.createIds) {
      if (virtual.ids.has(identity) || !targetIds.has(identity)) fail('render-plan-create-invalid');
      virtual.ids.add(identity);
      virtual.revisions.set(identity, -1);
    }
    for (const field of dirtyFields) {
      if (field === 'createIds' || field === 'removeIds') continue;
      for (const identity of plan[field]) {
        if (!virtual.ids.has(identity) || !targetIds.has(identity)) {
          fail('render-plan-dirty-id-invalid');
        }
      }
    }
    if (!setEquals(virtual.ids, targetIds)) fail('render-plan-node-set-mismatch');
    const removed = new Set(batch.removedDisplayIds);
    if (!setEquals(removed, new Set(plan.removeIds))) fail('render-batch-removals-incomplete');
    const changed = new Set(batch.changed.map((item) => item.displayId));
    for (const identity of plan.createIds) {
      if (!changed.has(identity)) fail('render-batch-create-composition-missing');
    }
  } else if (!sameCursor(cursorOf(batch), virtual.cursor) && !emptyBatch(batch)) {
    fail('render-null-plan-batch-invalid');
  }
  for (const identity of batch.removedDisplayIds) {
    if (targetIds.has(identity)) fail('render-batch-remove-still-present');
  }
  for (const composition of batch.changed) {
    if (!targetIds.has(composition.displayId) || !virtual.ids.has(composition.displayId)) {
      fail('render-composition-display-id-invalid');
    }
    const previous = virtual.revisions.get(composition.displayId) ?? -1;
    if (composition.renderRevision <= previous) fail('render-revision-not-newer');
    virtual.revisions.set(composition.displayId, composition.renderRevision);
  }
}

function installPreparedSnapshot(runtime, prepared) {
  runtime.cursor = prepared.cursor;
  const created = [];
  for (const node of prepared.nodes) created.push({ node, record: createRecord(runtime, node) });
  for (const item of created) reparent(runtime, item.record, item.node);
  for (const composition of prepared.snapshot.compositions) {
    installComposition(runtime, composition);
  }
  replaceSceneLayers(runtime, prepared.snapshot.sceneLayers);
  finishMutation(runtime);
}

function applyPreparedSteps(runtime, preparedSteps) {
  let dirty = false;
  for (const step of preparedSteps) dirty = applyPreparedStep(runtime, step) || dirty;
  if (dirty) finishMutation(runtime);
}

function applyPreparedStep(runtime, step) {
  const previousCursor = runtime.cursor;
  runtime.cursor = step.cursor;
  let dirty = step.cursor.sourceTick !== previousCursor.sourceTick;
  if (step.plan) {
    for (const identity of step.plan.removeIds) {
      removeRecord(runtime, identity, 'node-removed');
      dirty = true;
    }
    const created = [];
    for (const identity of step.plan.createIds) {
      const node = requirePreparedNode(step, identity);
      created.push({ node, record: createRecord(runtime, node) });
      dirty = true;
    }
    for (const item of created) reparent(runtime, item.record, item.node);
    for (const identity of step.plan.visualReplaceIds) requireRecord(runtime, identity);
    for (const identity of step.plan.reparentIds) {
      reparent(runtime, requireRecord(runtime, identity), requirePreparedNode(step, identity));
      dirty = true;
    }
    for (const identity of step.plan.localPoseDirtyIds) {
      const record = requireRecord(runtime, identity);
      const node = requirePreparedNode(step, identity);
      runtime.adapter.setNodePose(record.anchor, node);
      runtime.matrixDirty = true;
      dirty = true;
    }
    for (const identity of step.plan.visibilityDirtyIds) {
      const record = requireRecord(runtime, identity);
      const node = requirePreparedNode(step, identity);
      record.anchor.visible = Boolean(node.flags & NODE_VISIBLE);
      runtime.matrixDirty = true;
      dirty = true;
    }
  }
  for (const identity of step.batch.removedDisplayIds) {
    if (runtime.records.has(identity)) removeRecord(runtime, identity, 'composition-removed');
    dirty = true;
  }
  for (const composition of step.batch.changed) {
    installComposition(runtime, composition);
    dirty = true;
  }
  if (step.batch.sceneLayers !== null) {
    replaceSceneLayers(runtime, step.batch.sceneLayers);
    dirty = true;
  }
  return dirty;
}

function collectViewNodes(view) {
  const nodes = [];
  const identities = new Set();
  for (let index = 0; index < view.nodeCount; index += 1) {
    const node = nodeSnapshot(view.nodeAt(index));
    if (identities.has(node.displayId)) fail('render-view-node-duplicate');
    identities.add(node.displayId);
    nodes.push(node);
  }
  for (const node of nodes) {
    if (node.parentDisplayId !== 0n && !identities.has(node.parentDisplayId)) {
      fail('render-view-parent-missing');
    }
  }
  const byId = new Map(nodes.map((node) => [node.displayId, node]));
  const complete = new Set();
  const visiting = new Set();
  const visit = (identity) => {
    if (complete.has(identity)) return;
    if (visiting.has(identity)) fail('render-view-parent-cycle');
    visiting.add(identity);
    const parent = byId.get(identity).parentDisplayId;
    if (parent !== 0n) visit(parent);
    visiting.delete(identity);
    complete.add(identity);
  };
  for (const identity of identities) visit(identity);
  return Object.freeze(nodes);
}

function createRecord(runtime, node) {
  if (runtime.records.has(node.displayId)) fail('render-node-duplicate');
  const anchor = runtime.adapter.createGroup();
  anchor.name = `SceneAnchor:${node.displayId}`;
  runtime.adapter.setNodePose(anchor, node);
  anchor.visible = Boolean(node.flags & NODE_VISIBLE);
  const record = {
    anchor,
    displayId: node.displayId,
    layers: new Map(),
    renderRevision: -1,
  };
  runtime.records.set(node.displayId, record);
  runtime.matrixDirty = true;
  return record;
}

function reparent(runtime, record, node) {
  const parent = node.parentDisplayId === 0n
    ? runtime.root
    : requireRecord(runtime, node.parentDisplayId).anchor;
  if (record.anchor.parent !== parent) {
    parent.add(record.anchor);
    runtime.matrixDirty = true;
  }
}

function installComposition(runtime, composition) {
  const record = requireRecord(runtime, composition.displayId);
  if (composition.renderRevision <= record.renderRevision) fail('render-revision-not-newer');
  const incoming = new Map(composition.layers.map((layer) => [layer.key, layer]));
  for (const [key, binding] of [...record.layers]) {
    if (!incoming.has(key)) {
      disposeBinding(runtime, binding, 'layer-removed');
      record.layers.delete(key);
    }
  }
  for (const layer of composition.layers) {
    const current = record.layers.get(layer.key);
    if (!current) {
      const binding = createBinding(
        runtime,
        record.anchor,
        composition.displayId,
        composition.renderRevision,
        layer,
        false,
      );
      record.layers.set(layer.key, binding);
      continue;
    }
    const fingerprint = layerFingerprint(layer);
    if (fingerprint === current.fingerprint) {
      if (isBindingPending(current)) {
        const replacement = createBinding(
          runtime,
          record.anchor,
          composition.displayId,
          composition.renderRevision,
          layer,
          false,
        );
        record.layers.set(layer.key, replacement);
        disposeBinding(runtime, current, 'render-revision-superseded');
        continue;
      }
      current.renderRevision = composition.renderRevision;
      current.layer = layer;
      continue;
    }
    if (!isBindingPending(current) && updateBinding(
      runtime,
      current,
      composition.renderRevision,
      layer,
    )) {
      continue;
    }
    const replacement = createBinding(
      runtime,
      record.anchor,
      composition.displayId,
      composition.renderRevision,
      layer,
      false,
    );
    record.layers.set(layer.key, replacement);
    disposeBinding(runtime, current, 'layer-replaced');
  }
  record.renderRevision = composition.renderRevision;
}

function replaceSceneLayers(runtime, layers) {
  const incoming = new Map(layers.map((layer) => [layer.key, layer]));
  for (const [key, binding] of [...runtime.sceneLayers]) {
    if (!incoming.has(key)) {
      disposeBinding(runtime, binding, 'scene-layer-removed');
      runtime.sceneLayers.delete(key);
    }
  }
  for (const layer of layers) {
    const current = runtime.sceneLayers.get(layer.key);
    const revision = runtime.cursor.commitSeq;
    if (current && layerFingerprint(layer) === current.fingerprint) {
      if (isBindingPending(current)) {
        const replacement = createBinding(
          runtime,
          runtime.sceneLayerRoot,
          null,
          revision,
          layer,
          true,
        );
        runtime.sceneLayers.set(layer.key, replacement);
        disposeBinding(runtime, current, 'render-revision-superseded');
        continue;
      }
      current.renderRevision = revision;
      current.layer = layer;
      continue;
    }
    if (current && !isBindingPending(current)
        && updateBinding(runtime, current, revision, layer)) {
      continue;
    }
    const replacement = createBinding(
      runtime,
      runtime.sceneLayerRoot,
      null,
      revision,
      layer,
      true,
    );
    runtime.sceneLayers.set(layer.key, replacement);
    if (current) disposeBinding(runtime, current, 'scene-layer-replaced');
  }
}

function updateBinding(runtime, binding, renderRevision, nextLayer) {
  const previousLayer = binding.layer;
  if (previousLayer.pipelineId !== nextLayer.pipelineId
      || previousLayer.resourceId !== nextLayer.resourceId
      || batchFingerprint(previousLayer) !== batchFingerprint(nextLayer)
      || pipelineStructureFingerprint(previousLayer)
        !== pipelineStructureFingerprint(nextLayer)) return false;

  const transformOnly = sameLayerMechanicsExceptTransform(previousLayer, nextLayer);
  if (!transformOnly) {
    const handle = binding.batchGroup?.handle ?? binding.pipelineHandle;
    const update = binding.batchGroup ? handle?.updateLayer : handle?.update;
    if (typeof update !== 'function'
        || update.call(handle, previousLayer, nextLayer, pipelineContext(runtime)) !== true) {
      return false;
    }
  }
  binding.renderRevision = renderRevision;
  binding.layer = nextLayer;
  binding.fingerprint = layerFingerprint(nextLayer);
  binding.batchFingerprint = batchFingerprint(nextLayer);
  runtime.adapter.setTransform(binding.container, nextLayer.transform);
  if (!binding.batchGroup && binding.pipelineHandle?.object) {
    runtime.adapter.markPickIdentity(binding.pipelineHandle.object, Object.freeze({
      displayId: binding.displayId,
      layerKey: nextLayer.key,
    }));
  }
  runtime.matrixDirty = true;
  if (isScenePassBinding(binding)) refreshScenePassState(runtime);
  return true;
}

function pipelineStructureFingerprint(layer) {
  let structure = null;
  if (layer.pipelineId.startsWith('model@')) {
    structure = {
      instance: layer.params.instance ?? false,
      lodEnabled: layer.params.lodDistances !== undefined,
    };
  }
  return layerFingerprint(structure);
}

function pipelineContext(runtime) {
  return Object.freeze({
    camera: runtime.camera,
    renderer: runtime.renderer,
    scene: runtime.scene,
  });
}

function refreshScenePassState(runtime) {
  if (typeof runtime.adapter.replaceScenePassState !== 'function') return;
  const entries = [];
  for (const [key, binding] of runtime.sceneLayers) {
    if (!binding.asset || !binding.pipelineHandle
        || !binding.layer.pipelineId.startsWith('scene-pass@')) continue;
    entries.push(Object.freeze({
      key,
      layer: binding.layer,
      descriptor: binding.asset.descriptor,
    }));
  }
  runtime.adapter.replaceScenePassState(
    runtime.renderer,
    runtime.scene,
    Object.freeze(entries),
  );
}

function createBinding(runtime, parent, displayIdentity, renderRevision, layer, sceneLevel) {
  if (runtime.pendingJobs.size >= MAXIMUM_PENDING_JOBS) {
    fail('render-pending-job-limit-exceeded');
  }
  const container = runtime.adapter.createGroup();
  container.name = sceneLevel
    ? `SceneLayer:${layer.key}`
    : `RenderLayer:${displayIdentity}:${layer.key}`;
  runtime.adapter.setTransform(container, layer.transform);
  parent.add(container);
  const abortController = new AbortController();
  const binding = {
    abortController,
    batchFingerprint: batchFingerprint(layer),
    batchGroup: null,
    container,
    displayId: displayIdentity,
    fingerprint: layerFingerprint(layer),
    identity: `${displayIdentity ?? 'scene'}:${layer.key}`,
    layer,
    lease: null,
    asset: null,
    pipelineHandle: null,
    renderRevision,
    requestSeq: runtime.nextRequestSeq,
    sceneLevel,
  };
  runtime.nextRequestSeq += 1;
  const request = Object.freeze({
    generation: runtime.cursor.generation,
    displayId: displayIdentity,
    layerKey: layer.key,
    renderRevision,
    requestSeq: binding.requestSeq,
  });
  binding.lease = runtime.resources.acquire(layer.resourceId, abortController.signal);
  const operation = binding.lease.ready.then((asset) => {
    if (!isCurrentBinding(runtime, binding, request)) return;
    completeBinding(runtime, binding, request, asset);
  }).catch(() => {
    // ResourceManager owns current-load failure classification. Retired and
    // aborted leases are intentionally non-fatal and need no second report.
  });
  trackJob(runtime, operation);
  runtime.matrixDirty = true;
  return binding;
}

function completeBinding(runtime, binding, request, asset) {
  if (!isCurrentBinding(runtime, binding, request)) return;
  let handle;
  try {
    const context = pipelineContext(runtime);
    binding.asset = asset;
    if (binding.batchFingerprint) {
      const group = attachToBatch(runtime, binding, asset, context);
      if (group) {
        if (isScenePassBinding(binding)) refreshScenePassState(runtime);
        requestDraw(runtime);
        return;
      }
    }
    handle = runtime.adapter.createPipelineObject(
      binding.layer.pipelineId,
      asset,
      binding.layer,
      context,
    );
    assertPipelineHandle(handle);
    runtime.adapter.markPickIdentity(handle.object, Object.freeze({
      displayId: binding.displayId,
      layerKey: binding.layer.key,
    }));
    binding.pipelineHandle = handle;
    binding.container.add(handle.object);
    runtime.matrixDirty = true;
    if (isScenePassBinding(binding)) refreshScenePassState(runtime);
    requestDraw(runtime);
  } catch (error) {
    try { handle?.dispose?.(); } catch { /* preserve original error */ }
    markUnhealthy(runtime, 'render-pipeline-create-failed', error);
  }
}

function attachToBatch(runtime, binding, asset, context) {
  let group = runtime.batches.get(binding.batchFingerprint);
  if (!group) {
    const handle = runtime.adapter.createInstanceBatch?.(
      binding.layer.pipelineId,
      asset,
      binding.layer,
      context,
    );
    if (!handle) return null;
    if (!handle.object || typeof handle.update !== 'function'
        || typeof handle.dispose !== 'function') fail('render-instance-batch-invalid');
    group = {
      handle,
      key: binding.batchFingerprint,
      members: new Map(),
      visibleMembers: [],
    };
    runtime.batches.set(group.key, group);
    runtime.batchRoot.add(handle.object);
  }
  group.members.set(binding.identity, binding);
  binding.batchGroup = group;
  runtime.matrixDirty = true;
  return group;
}

function detachFromBatch(runtime, binding) {
  const group = binding.batchGroup;
  if (!group) return;
  binding.batchGroup = null;
  group.members.delete(binding.identity);
  if (group.members.size === 0) {
    runtime.batches.delete(group.key);
    group.handle.object?.removeFromParent?.();
    try { group.handle.dispose(); } catch (error) {
      reportHealth(runtime, 'warning', 'render-batch-dispose-failed', errorMessage(error));
    }
  } else {
    runtime.matrixDirty = true;
  }
}

function updateBatches(runtime) {
  for (const group of runtime.batches.values()) {
    group.visibleMembers = [...group.members.values()].filter(
      (binding) => isEffectivelyVisible(binding.container),
    );
    group.handle.update(group.visibleMembers.map((binding) => Object.freeze({
      container: binding.container,
      displayId: binding.displayId,
      layerKey: binding.layer.key,
    })));
  }
}

function prepareBatches(runtime) {
  for (const group of runtime.batches.values()) group.handle.prepareDraw?.();
}

function isEffectivelyVisible(object) {
  for (let cursor = object; cursor; cursor = cursor.parent) {
    if (cursor.visible === false) return false;
  }
  return true;
}

function isCurrentBinding(runtime, binding, request) {
  if (runtime.closed || binding.abortController.signal.aborted || !runtime.cursor) return false;
  if (runtime.cursor.generation !== request.generation
      || binding.displayId !== request.displayId
      || binding.layer.key !== request.layerKey
      || binding.renderRevision !== request.renderRevision
      || binding.requestSeq !== request.requestSeq) return false;
  const current = binding.sceneLevel
    ? runtime.sceneLayers.get(binding.layer.key)
    : runtime.records.get(binding.displayId)?.layers.get(binding.layer.key);
  return current === binding;
}

function disposeBinding(runtime, binding, reason) {
  binding.requestSeq += 1;
  detachFromBatch(runtime, binding);
  try { binding.pipelineHandle?.dispose(); } catch (error) {
    reportHealth(runtime, 'warning', 'render-layer-dispose-failed', errorMessage(error));
  }
  binding.pipelineHandle = null;
  binding.asset = null;
  try { binding.abortController.abort(reason); } catch { /* AbortController is best effort */ }
  binding.lease?.release();
  binding.lease = null;
  binding.container.removeFromParent?.();
  runtime.adapter.disposeObject(binding.container);
  runtime.matrixDirty = true;
  if (isScenePassBinding(binding)) refreshScenePassState(runtime);
}

function isScenePassBinding(binding) {
  return binding.sceneLevel && binding.layer.pipelineId === 'scene-pass@2';
}

function removeRecord(runtime, identity, reason) {
  const record = requireRecord(runtime, identity);
  runtime.records.delete(identity);
  for (const binding of record.layers.values()) disposeBinding(runtime, binding, reason);
  record.layers.clear();
  record.anchor.removeFromParent?.();
  runtime.matrixDirty = true;
}

function clearProjection(runtime, reason) {
  for (const record of [...runtime.records.values()]) removeRecord(runtime, record.displayId, reason);
  for (const binding of runtime.sceneLayers.values()) disposeBinding(runtime, binding, reason);
  runtime.sceneLayers.clear();
  for (const group of runtime.batches.values()) {
    group.handle.dispose();
    group.handle.object?.removeFromParent?.();
  }
  runtime.batches.clear();
  runtime.cursor = null;
  runtime.matrixDirty = true;
}

function finishMutation(runtime) {
  flushMatrices(runtime);
  requestDraw(runtime);
}

function flushMatrices(runtime) {
  if (!runtime.matrixDirty) return;
  runtime.adapter.updateMatrices(runtime.scene);
  updateBatches(runtime);
  runtime.matrixDirty = false;
}

function requestDraw(runtime) {
  runtime.drawRequested = true;
  if (runtime.started) scheduleFrame(runtime);
}

function scheduleFrame(runtime) {
  if (runtime.closed || runtime.unhealthy || !runtime.started || runtime.drawing
      || runtime.rafIdentity !== null) {
    return;
  }
  const continuous = runtime.rendererProfile.drawMode === 'continuous' || hasVisualClock(runtime);
  if (!runtime.drawRequested && !continuous) return;
  runtime.rafIdentity = runtime.adapter.requestAnimationFrame((timestamp) => drawFrame(runtime, timestamp));
}

function cancelFrame(runtime) {
  if (runtime.rafIdentity === null) return;
  runtime.adapter.cancelAnimationFrame(runtime.rafIdentity);
  runtime.rafIdentity = null;
}

function drawFrame(runtime, timestamp) {
  runtime.rafIdentity = null;
  if (runtime.closed || !runtime.started || !runtime.cursor || runtime.unhealthy) return;
  runtime.drawing = true;
  let continuous = false;
  let failureCode = 'render-pipeline-sample-failed';
  try {
    continuous = runtime.rendererProfile.drawMode === 'continuous' || hasVisualClock(runtime);
    if (!runtime.drawRequested && !continuous) return;
    const frameStartedAt = runtime.adapter.now();
    runtime.drawRequested = false;

    failureCode = 'render-control-update-failed';
    runtime.controls.update?.();

    failureCode = 'render-pipeline-sample-failed';
    const visualSeconds = Math.max(0, timestamp - runtime.visualEpochMs) / 1000;
    forEachBinding(runtime, (binding) => {
      const animation = binding.layer.animation;
      const seconds = animation?.clock === 'simulation'
        ? simulationElapsedTicks(runtime.cursor.sourceTick, animation.startTick) / 60
        : visualSeconds;
      binding.pipelineHandle?.sample?.(seconds, runtime.cursor.sourceTick);
    });

    failureCode = 'render-batch-prepare-failed';
    flushMatrices(runtime);
    prepareBatches(runtime);

    failureCode = 'render-draw-failed';
    runtime.adapter.render(runtime.renderer, runtime.scene, runtime.camera);

    failureCode = 'render-diagnostics-capture-failed';
    runtime.adapter.captureRendererInfo?.(runtime.renderer);
    const frameCpuTimeMs = Math.max(0, runtime.adapter.now() - frameStartedAt);
    runtime.lastFrameCpuTimeMs = frameCpuTimeMs;
    runtime.drawCount += 1;
  } catch (error) {
    // WebGLRenderer.render() is not exception-safe: an exception raised from
    // inside a shadow/render pass can leave renderer-owned stacks and the
    // active render target partially installed. A projection rebuild cannot
    // make those opaque internals trustworthy again, so the next complete
    // rebuild replaces the owned renderer after retiring every old binding.
    if (failureCode === 'render-draw-failed') runtime.rendererTainted = true;
    markUnhealthy(runtime, failureCode, error);
  } finally {
    runtime.drawing = false;
  }
  if (runtime.unhealthy) return;
  if (continuous) scheduleFrame(runtime);
  else if (runtime.drawRequested) scheduleFrame(runtime);
}

function hasVisualClock(runtime) {
  let result = false;
  forEachBinding(runtime, (binding) => {
    const visualSurface = binding.layer.pipelineId === 'surface@2'
      && runtime.resources.catalog.resources[binding.layer.resourceId].family === 'surface.water';
    if (binding.layer.animation?.clock === 'visual' || visualSurface) {
      result = true;
    }
  });
  return result;
}

function replaceOwnedRenderer(runtime) {
  const previous = runtime.renderer;
  runtime.adapter.disposeRenderer(previous);
  runtime.adapter.resetRendererContext?.(previous);
  runtime.renderer = runtime.adapter.createRenderer(
    runtime.canvas,
    runtime.rendererProfile,
  );
  resize(runtime);
  runtime.rendererTainted = false;
}

function resize(runtime) {
  const rect = runtime.hostElement.getBoundingClientRect();
  const width = positiveDimension(rect?.width);
  const height = positiveDimension(rect?.height);
  const pixelRatio = Math.min(
    runtime.rendererProfile.maximumPixelRatio,
    Math.max(1, runtime.adapter.devicePixelRatio()),
  );
  runtime.adapter.setViewport(
    runtime.renderer,
    runtime.camera,
    runtime.cameraProfile,
    width,
    height,
    pixelRatio,
  );
}

function mutate(runtime, code, operation) {
  try {
    operation();
  } catch (error) {
    markUnhealthy(runtime, code, error);
    throw error;
  }
}

function markUnhealthy(runtime, code, error) {
  if (runtime.closed) return;
  const firstFailureOfRecovery = runtime.recovery !== null
    && runtime.recovery.failureVersion === runtime.failureVersion;
  if (runtime.unhealthy && !firstFailureOfRecovery) return;
  runtime.unhealthy = true;
  runtime.failureVersion += 1;
  const cursor = runtime.cursor === null ? null : Object.freeze({ ...runtime.cursor });
  runtime.healthCause = error;
  runtime.healthFailure = Object.freeze({
    code,
    message: errorMessage(error),
    cursor,
  });
  runtime.drawRequested = false;
  cancelFrame(runtime);
  reportHealth(runtime, 'error', code, errorMessage(error));
}

function reportHealth(runtime, severity, code, message) {
  const event = Object.freeze({
    severity,
    code,
    message,
    generation: runtime.cursor?.generation ?? 0,
    commitSeq: runtime.cursor?.commitSeq ?? 0,
    sourceTick: runtime.cursor?.sourceTick ?? 0,
  });
  try { runtime.onHealth?.(event); } catch { /* health observers cannot alter runtime state */ }
}

function trackJob(runtime, operation) {
  const tracked = Promise.resolve(operation).finally(() => runtime.pendingJobs.delete(tracked));
  tracked.catch(() => {});
  runtime.pendingJobs.add(tracked);
}

function requireOpen(instance) {
  const runtime = INTERNALS.get(instance);
  if (!runtime || runtime.closed) fail('render-runtime-disposed');
  return runtime;
}

function requireInstalled(instance) {
  const runtime = requireOpen(instance);
  if (!runtime.cursor) fail('render-runtime-not-installed');
  return runtime;
}

function requireHealthy(runtime) {
  if (!runtime.unhealthy) return;
  const failure = runtime.healthFailure;
  fail(
    'render-projection-unhealthy',
    failure
      ? `Render projection is unhealthy after ${failure.code}: ${failure.message}`
      : 'Render projection is unhealthy.',
    runtime.healthCause === null ? undefined : { cause: runtime.healthCause },
  );
}

function requireRecord(runtime, identity) {
  const record = runtime.records.get(displayId(identity));
  if (!record) fail('render-node-record-missing');
  return record;
}

function requirePreparedNode(step, identity) {
  const node = step.nodesById.get(displayId(identity));
  if (!node) fail('render-view-node-missing');
  return node;
}

function assertPipelineHandle(value) {
  if (!value || typeof value !== 'object' || !value.object
      || typeof value.dispose !== 'function') fail('render-pipeline-handle-invalid');
}

function sameLayerMechanicsExceptTransform(left, right) {
  return left.pipelineId === right.pipelineId
    && left.resourceId === right.resourceId
    && layerFingerprint({ ...left, transform: null })
      === layerFingerprint({ ...right, transform: null });
}

function isBindingPending(binding) {
  return binding.pipelineHandle === null && binding.batchGroup === null;
}

function forEachBinding(runtime, callback) {
  for (const record of runtime.records.values()) {
    for (const binding of record.layers.values()) callback(binding);
  }
  for (const binding of runtime.sceneLayers.values()) callback(binding);
}

function assertIdArrayUnique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function exactRecord(value, keys, code) {
  if (!isPlainRecord(value) || Object.keys(value).length !== keys.length
      || !keys.every((key) => Object.hasOwn(value, key))) fail(code);
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteTuple(value, count, code) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== count) {
    fail(code);
  }
  return Array.from(value, (item) => finiteNumber(item, code));
}

function finiteNumber(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code);
  return value;
}

function positiveFinite(value, code) {
  const result = finiteNumber(value, code);
  if (result <= 0) fail(code);
  return result;
}

function positiveDimension(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, value)
    : 1;
}

function ownedCount(owner, field, fallback) {
  const value = owner?.[field];
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function simulationElapsedTicks(sourceTick, startTick) {
  const source = BigInt(sourceTick);
  return startTick >= source ? 0 : Number(source - startTick);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function freezePlainResult(value, code) {
  if (!isPlainRecord(value)) fail(code);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
        || typeof item === 'bigint') copy[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) copy[key] = item;
    else if ((Array.isArray(item) || ArrayBuffer.isView(item))
        && [...item].every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
      copy[key] = Object.freeze(Array.from(item));
    } else fail(code);
  }
  return Object.freeze(copy);
}
