const NODE_VISIBLE = 1;

export const THREE_PRESENTATION_BACKEND_SCHEMA =
  'scene-engine-three-presentation-backend-v3@1';

export class ThreePresentationBackendError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ThreePresentationBackendError';
    this.code = code;
  }
}

/**
 * Rebuildable Three.js projection of the current SceneDisplayEngine view.
 *
 * The backend deliberately retains no presentation node/entity records. Its
 * resident Map contains only renderer mechanics: anchors, visual handles,
 * equality fingerprints and resource request tokens. All hierarchy, pose and
 * current profile/animation values are read from the supplied Engine view.
 */
export class ThreePresentationBackend {
  constructor({
    THREE = null,
    createAnchor = null,
    maximumPendingJobs = 20_000,
    onHealth = null,
    onVisualReady = null,
    resolveFactory,
    resourceServices = {},
    root,
  } = {}) {
    if (!root || typeof root.add !== 'function' || typeof root.remove !== 'function'
        || typeof root.updateMatrixWorld !== 'function') {
      fail('three-root-invalid');
    }
    const anchorFactory = createAnchor ?? (THREE?.Group
      ? () => new THREE.Group()
      : null);
    if (typeof anchorFactory !== 'function') fail('three-anchor-factory-invalid');
    if (typeof resolveFactory !== 'function') fail('three-visual-factory-port-invalid');
    if (!Number.isSafeInteger(maximumPendingJobs) || maximumPendingJobs <= 0) {
      fail('three-pending-job-limit-invalid');
    }
    for (const [name, value] of Object.entries({ onHealth, onVisualReady })) {
      if (value !== null && typeof value !== 'function') fail(`${name}-port-invalid`);
    }

    this.schema = THREE_PRESENTATION_BACKEND_SCHEMA;
    this.root = root;
    this.createAnchorPort = anchorFactory;
    this.resolveFactory = resolveFactory;
    this.resourceServices = Object.freeze({ ...resourceServices });
    this.onHealth = onHealth;
    this.onVisualReady = onVisualReady;
    this.maximumPendingJobs = maximumPendingJobs;
    this.records = new Map();
    this.pendingJobs = new Set();
    this.disposedHandles = new WeakSet();
    this.deferredVisualBatchScheduled = false;
    this.generation = null;
    this.closed = false;
  }

  installBootstrap(plan, view) {
    this.requireOpen();
    assertPlanView(plan, view);
    if (plan.kind !== 'bootstrap') {
      fail('three-bootstrap-plan-invalid');
    }
    this.rebuild(view);
  }

  apply(plan, view) {
    this.requireOpen();
    assertPlanView(plan, view);
    this.requireGeneration(view.generation);
    const dirty = this.applyPlan(plan, view);
    if (dirty) this.finishMatrixBatch();
  }

  /** Apply every ordered frame step with one root matrix pass. */
  applyBatch(steps) {
    this.requireOpen();
    if (!Array.isArray(steps) || steps.length === 0) {
      fail('three-frame-batch-invalid');
    }
    for (const step of steps) {
      if (!step?.plan || !step?.view) fail('three-frame-batch-invalid');
      assertPlanView(step.plan, step.view);
      this.requireGeneration(step.view.generation);
    }
    let dirty = false;
    for (const { plan, view } of steps) dirty = this.applyPlan(plan, view) || dirty;
    if (dirty) this.finishMatrixBatch();
  }

  rebuild(view) {
    this.requireOpen();
    assertSceneView(view);
    let dirty = this.clearRecords('renderer-rebuild');
    this.generation = integerGeneration(view.generation);
    for (let index = 0; index < view.nodeCount; index += 1) {
      const node = view.nodeAt(index);
      const record = this.createRecord(node);
      this.startVisualCreate(record, node, profileFor(view, node));
      dirty = true;
    }
    if (dirty) this.finishMatrixBatch();
  }

  async whenIdle() {
    while (this.pendingJobs.size > 0) {
      await Promise.allSettled([...this.pendingJobs]);
    }
  }

  getAnchor(displayId) {
    return this.records.get(displayIdValue(displayId))?.anchor ?? null;
  }

  capture() {
    let handleCount = 0;
    for (const record of this.records.values()) if (record.handle) handleCount += 1;
    return Object.freeze({
      generation: this.generation,
      handleCount,
      nodeCount: this.records.size,
      pendingJobCount: this.pendingJobs.size,
      schema: this.schema,
    });
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.clearRecords('renderer-disposed');
    // Untrusted resource promises are required to observe AbortSignal, but a
    // broken owner must not make DisplayShell disposal wait forever. Late
    // results still pass through the closed/token check and are disposed.
    this.pendingJobs.clear();
  }

  applyPlan(plan, view) {
    let dirty = false;
    for (const displayId of plan.removeIds) {
      dirty = this.removeRecord(displayId, 'node-removed') || dirty;
    }
    for (const displayId of plan.createIds) {
      const node = requireNode(view, displayId);
      const record = this.createRecord(node);
      this.startVisualCreate(record, node, profileFor(view, node));
      dirty = true;
    }
    for (const displayId of plan.visualReplaceIds) {
      const node = requireNode(view, displayId);
      const record = this.requireRecord(displayId);
      this.replaceVisual(record, node, profileFor(view, node));
      dirty = true;
    }
    for (const displayId of plan.reparentIds) {
      const changed = this.reparent(
        this.requireRecord(displayId),
        requireNode(view, displayId),
      );
      dirty = changed || dirty;
    }
    for (const displayId of plan.localPoseDirtyIds) {
      writeLocalPose(
        this.requireRecord(displayId).anchor,
        requireNode(view, displayId),
      );
      dirty = true;
    }
    for (const displayId of plan.visibilityDirtyIds) {
      const node = requireNode(view, displayId);
      this.requireRecord(displayId).anchor.visible = Boolean(node.flags & NODE_VISIBLE);
      dirty = true;
    }
    for (const displayId of plan.profileStateDirtyIds) {
      const node = requireNode(view, displayId);
      dirty = this.updateProfile(
        this.requireRecord(displayId),
        node,
        profileFor(view, node),
      ) || dirty;
    }
    for (const displayId of plan.animationDirtyIds) {
      const node = requireNode(view, displayId);
      dirty = this.updateAnimation(this.requireRecord(displayId), node) || dirty;
    }
    return dirty;
  }

  createRecord(node) {
    const displayId = displayIdValue(node?.displayId);
    if (this.records.has(displayId)) fail('three-node-duplicate');
    const anchor = this.createAnchorPort();
    assertAnchor(anchor);
    anchor.name = `PresentationAnchor:${displayId}`;
    anchor.matrixAutoUpdate = false;
    writeLocalPose(anchor, node);
    anchor.visible = Boolean(node.flags & NODE_VISIBLE);
    this.resolveParent(node.parentDisplayId).add(anchor);
    const record = {
      abortController: null,
      anchor,
      animationFingerprint: animationFingerprint(node),
      displayId,
      handle: null,
      profileFingerprint: profileFingerprint(node.profile),
      resourceRequestSeq: 0,
      visualTypeId: positiveInteger(node.visualTypeId, 'visualTypeId'),
    };
    this.records.set(displayId, record);
    return record;
  }

  resolveParent(parentDisplayId) {
    const parentId = nonnegativeDisplayId(parentDisplayId ?? 0n);
    if (parentId === 0n) return this.root;
    const parent = this.records.get(parentId)?.anchor;
    if (!parent) fail('three-parent-missing');
    return parent;
  }

  reparent(record, node) {
    const parent = this.resolveParent(node.parentDisplayId);
    if (record.anchor.parent === parent) return false;
    parent.add(record.anchor);
    record.anchor.matrixWorldNeedsUpdate = true;
    return true;
  }

  startVisualCreate(record, node, profile) {
    const visualTypeId = positiveInteger(node.visualTypeId, 'visualTypeId');
    const factory = this.resolveFactory(visualTypeId);
    if (!factory || typeof factory.create !== 'function') {
      fail('three-native-factory-missing');
    }
    this.requireJobCapacity();
    record.visualTypeId = visualTypeId;
    record.profileFingerprint = profileFingerprint(profile);
    record.animationFingerprint = animationFingerprint(node);
    const request = this.beginRequest(record);
    const input = Object.freeze({
      node: snapshotNode(node),
      profile: snapshotPayload(profile),
      services: this.resourceServices,
      signal: request.signal,
    });
    let result;
    try {
      result = factory.create(input);
    } catch (error) {
      this.invalidateRequest(record, 'factory-create-failed');
      throw error;
    }
    if (isThenable(result)) {
      request.deferred = true;
      this.trackJob(Promise.resolve(result).then(
        (handle) => this.completeVisualCreate(record, request, handle),
        (error) => this.handleAsyncFailure(record, request, error),
      ));
      return;
    }
    this.completeVisualCreate(record, request, result);
  }

  completeVisualCreate(record, request, handle) {
    if (!this.isCurrentRequest(record, request)) {
      this.disposeHandle(handle);
      return false;
    }
    assertVisualHandle(handle);
    record.handle = handle;
    record.abortController = null;
    record.anchor.add(handle.object3d);
    record.anchor.matrixWorldNeedsUpdate = true;
    if (request.deferred) this.scheduleDeferredVisualBatch();
    return true;
  }

  handleAsyncFailure(record, request, error) {
    if (!this.isCurrentRequest(record, request)) return;
    record.abortController = null;
    this.report(error);
  }

  replaceVisual(record, node, profile) {
    this.invalidateRequest(record, 'visual-replaced');
    this.disposeRecordHandle(record);
    this.startVisualCreate(record, node, profile);
  }

  updateProfile(record, node, profile) {
    const fingerprint = profileFingerprint(profile);
    if (fingerprint === record.profileFingerprint) return false;
    record.profileFingerprint = fingerprint;
    if (!record.handle) {
      this.invalidateRequest(record, 'profile-changed-before-create');
      this.startVisualCreate(record, node, profile);
      return true;
    }
    if (typeof record.handle.updateProfile !== 'function') return false;
    this.requireJobCapacity();
    const request = this.beginRequest(record);
    const snapshot = snapshotPayload(profile);
    let result;
    try {
      result = record.handle.updateProfile(snapshot, Object.freeze({
        services: this.resourceServices,
        signal: request.signal,
      }));
    } catch (error) {
      this.invalidateRequest(record, 'profile-update-failed');
      throw error;
    }
    if (isThenable(result)) {
      request.deferred = true;
      this.trackJob(Promise.resolve(result).then(
        () => this.completeHandleUpdate(record, request),
        (error) => this.handleAsyncFailure(record, request, error),
      ));
    } else {
      this.completeHandleUpdate(record, request);
    }
    return true;
  }

  updateAnimation(record, node) {
    const fingerprint = animationFingerprint(node);
    if (fingerprint === record.animationFingerprint) return false;
    record.animationFingerprint = fingerprint;
    if (!record.handle) {
      this.invalidateRequest(record, 'animation-changed-before-create');
      this.startVisualCreate(record, node, node.profile ?? null);
      return true;
    }
    if (typeof record.handle.updateAnimation !== 'function') return false;
    this.requireJobCapacity();
    const request = this.beginRequest(record);
    let result;
    try {
      result = record.handle.updateAnimation(animationSnapshot(node), Object.freeze({
        services: this.resourceServices,
        signal: request.signal,
      }));
    } catch (error) {
      this.invalidateRequest(record, 'animation-update-failed');
      throw error;
    }
    if (isThenable(result)) {
      request.deferred = true;
      this.trackJob(Promise.resolve(result).then(
        () => this.completeHandleUpdate(record, request),
        (error) => this.handleAsyncFailure(record, request, error),
      ));
    } else {
      this.completeHandleUpdate(record, request);
    }
    return true;
  }

  completeHandleUpdate(record, request) {
    if (!this.isCurrentRequest(record, request)) return false;
    record.abortController = null;
    record.anchor.matrixWorldNeedsUpdate = true;
    if (request.deferred) this.scheduleDeferredVisualBatch();
    return true;
  }

  beginRequest(record) {
    this.invalidateRequest(record, 'resource-request-superseded');
    const abortController = new AbortController();
    record.abortController = abortController;
    record.resourceRequestSeq += 1;
    return {
      deferred: false,
      generation: this.generation,
      resourceRequestSeq: record.resourceRequestSeq,
      signal: abortController.signal,
      visualTypeId: record.visualTypeId,
    };
  }

  invalidateRequest(record, reason) {
    record.resourceRequestSeq += 1;
    try { record.abortController?.abort(reason); } catch (error) { this.report(error); }
    record.abortController = null;
  }

  isCurrentRequest(record, request) {
    return !this.closed
      && !request.signal.aborted
      && this.generation === request.generation
      && this.records.get(record.displayId) === record
      && record.visualTypeId === request.visualTypeId
      && record.resourceRequestSeq === request.resourceRequestSeq;
  }

  removeRecord(displayId, reason) {
    const key = displayIdValue(displayId);
    const record = this.records.get(key);
    if (!record) return false;
    this.records.delete(key);
    this.invalidateRequest(record, reason);
    try { record.anchor.removeFromParent?.(); } catch (error) { this.report(error); }
    this.disposeRecordHandle(record);
    return true;
  }

  disposeRecordHandle(record) {
    const handle = record.handle;
    record.handle = null;
    this.disposeHandle(handle);
  }

  disposeHandle(handle) {
    if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) return;
    if (this.disposedHandles.has(handle)) return;
    this.disposedHandles.add(handle);
    try { handle.dispose?.(); } catch (error) { this.report(error); }
  }

  clearRecords(reason) {
    const dirty = this.records.size > 0;
    for (const record of [...this.records.values()]) {
      this.removeRecord(record.displayId, reason);
    }
    this.generation = null;
    return dirty;
  }

  trackJob(promise) {
    const guarded = Promise.resolve(promise).catch((error) => this.report(error));
    const tracked = guarded.finally(() => this.pendingJobs.delete(tracked));
    this.pendingJobs.add(tracked);
    return tracked;
  }

  requireJobCapacity() {
    if (this.pendingJobs.size >= this.maximumPendingJobs) {
      fail('three-pending-job-limit-exceeded');
    }
  }

  finishMatrixBatch() {
    this.root.updateMatrixWorld(true);
  }

  scheduleDeferredVisualBatch() {
    if (this.deferredVisualBatchScheduled) return;
    this.deferredVisualBatchScheduled = true;
    queueMicrotask(() => {
      this.deferredVisualBatchScheduled = false;
      if (this.closed) return;
      this.finishMatrixBatch();
      this.publishVisualReady();
    });
  }

  publishVisualReady() {
    try { this.onVisualReady?.(); } catch (error) { this.report(error); }
  }

  report(error) {
    try { this.onHealth?.(error); } catch { /* observers never alter renderer state */ }
  }

  requireRecord(displayId) {
    const record = this.records.get(displayIdValue(displayId));
    if (!record) fail('three-record-missing');
    return record;
  }

  requireGeneration(value) {
    const generation = integerGeneration(value);
    if (this.generation === null) this.generation = generation;
    if (this.generation !== generation) fail('three-generation-mismatch');
  }

  requireOpen() {
    if (this.closed) fail('three-backend-disposed');
  }
}

export function createThreePresentationBackend(options) {
  return new ThreePresentationBackend(options);
}

function assertPlanView(plan, view) {
  assertSceneView(view);
  if (!plan || integerGeneration(plan.generation) !== integerGeneration(view.generation)) {
    fail('three-plan-view-mismatch');
  }
  for (const field of [
    'animationDirtyIds',
    'createIds',
    'interactionDirtyIds',
    'localPoseDirtyIds',
    'profileStateDirtyIds',
    'removeIds',
    'reparentIds',
    'visibilityDirtyIds',
    'visualReplaceIds',
  ]) {
    if (!Array.isArray(plan[field])) fail('three-plan-invalid');
  }
}

function assertSceneView(view) {
  if (!view || !Number.isSafeInteger(view.nodeCount) || view.nodeCount < 0
      || typeof view.nodeAt !== 'function' || typeof view.getNode !== 'function') {
    fail('three-scene-view-invalid');
  }
  integerGeneration(view.generation);
}

function assertAnchor(anchor) {
  if (!anchor || typeof anchor.add !== 'function' || typeof anchor.updateMatrix !== 'function'
      || !anchor.position?.set || !anchor.quaternion?.set || !anchor.scale?.set) {
    fail('three-anchor-invalid');
  }
}

function assertVisualHandle(handle) {
  if (!handle || typeof handle !== 'object' || typeof handle.dispose !== 'function'
      || !handle.object3d || typeof handle.object3d !== 'object') {
    fail('three-native-handle-invalid');
  }
}

function requireNode(view, displayId) {
  const node = view.getNode(displayIdValue(displayId));
  if (!node) fail('three-view-node-missing');
  return node;
}

function profileFor(view, node) {
  return node.profile ?? view.getProfile?.(displayIdValue(node.displayId)) ?? null;
}

function snapshotNode(node) {
  return Object.freeze({
    animationFlags: nonnegativeInteger(node.animationFlags ?? 0, 'animationFlags'),
    animationStartTick: nonnegativeBigInt(node.animationStartTick ?? 0n, 'animationStartTick'),
    animationStateId: nonnegativeInteger(node.animationStateId ?? 0, 'animationStateId'),
    displayId: displayIdValue(node.displayId),
    flags: nonnegativeInteger(node.flags ?? 0, 'flags'),
    isStatic: Boolean(node.isStatic),
    localPosition: frozenTuple(node.localPosition, 3, 'localPosition'),
    localRotationXyzw: frozenTuple(node.localRotationXyzw, 4, 'localRotationXyzw'),
    localScale: frozenTuple(node.localScale, 3, 'localScale'),
    parentDisplayId: nonnegativeDisplayId(node.parentDisplayId),
    visualTypeId: positiveInteger(node.visualTypeId, 'visualTypeId'),
  });
}

function snapshotPayload(payload) {
  if (!payload) return null;
  return Object.freeze({
    bytes: Uint8Array.from(binaryView(payload.bytes)),
    flags: nonnegativeInteger(payload.flags ?? 0, 'payloadFlags'),
    typeId: positiveInteger(payload.typeId, 'payloadTypeId'),
  });
}

function animationSnapshot(node) {
  return Object.freeze({
    flags: nonnegativeInteger(node.animationFlags ?? 0, 'animationFlags'),
    startTick: nonnegativeBigInt(node.animationStartTick ?? 0n, 'animationStartTick'),
    stateId: nonnegativeInteger(node.animationStateId ?? 0, 'animationStateId'),
  });
}

function writeLocalPose(anchor, node) {
  setTuple(anchor.position, node.localPosition, 3, 'position');
  setTuple(anchor.quaternion, node.localRotationXyzw, 4, 'rotation');
  setTuple(anchor.scale, node.localScale, 3, 'scale');
  anchor.updateMatrix();
  anchor.matrixWorldNeedsUpdate = true;
}

function setTuple(target, values, count, field) {
  if (!target?.set || !values || values.length !== count) {
    fail('three-local-pose-invalid', `Invalid ${field} tuple.`);
  }
  target.set(...values);
}

function profileFingerprint(profile) {
  if (!profile) return 'none';
  const bytes = binaryView(profile.bytes);
  let hash = 0x811c9dc5;
  for (const value of bytes) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${Number(profile.typeId)}:${Number(profile.flags)}:${bytes.byteLength}:${hash}`;
}

function animationFingerprint(node) {
  return `${Number(node.animationStateId ?? 0)}:${BigInt(node.animationStartTick ?? 0)}:${Number(node.animationFlags ?? 0)}`;
}

function frozenTuple(values, count, field) {
  if (!values || values.length !== count) fail('three-local-pose-invalid', `Invalid ${field}.`);
  return Object.freeze(Array.from(values, (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) fail('three-local-pose-invalid', `Invalid ${field}.`);
    return number;
  }));
}

function binaryView(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail('three-payload-bytes-invalid');
}

function displayIdValue(value) {
  const result = nonnegativeBigInt(value, 'displayId');
  if (result === 0n) fail('three-display-id-invalid');
  return result;
}

function nonnegativeDisplayId(value) {
  return nonnegativeBigInt(value, 'parentDisplayId');
}

function nonnegativeBigInt(value, field) {
  try {
    const result = BigInt(value);
    if (result < 0n || result > (1n << 64n) - 1n) throw new Error('range');
    return result;
  } catch {
    fail(`three-${field}-invalid`);
  }
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    fail(`three-${field}-invalid`);
  }
  return Number(value);
}

function nonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
    fail(`three-${field}-invalid`);
  }
  return Number(value);
}

function integerGeneration(value) {
  return nonnegativeInteger(value, 'generation');
}

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

function fail(code, message = code) {
  throw new ThreePresentationBackendError(code, message);
}
