const NODE_VISIBLE = 1;

export class SceneDisplayEngineError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SceneDisplayEngineError';
    this.code = code;
  }
}

export const DEFAULT_SCENE_TREE_LIMITS = Object.freeze({
  maximumNodes: 10_000,
  maximumTreeDepth: 64,
  maximumFramesPerBatch: 8,
});

const MAXIMUM_AGGREGATE_DEPTH = 256;
const MAXIMUM_AGGREGATE_VALUES = 1_000_000;
const AGGREGATE_CODEC_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/**
 * The sole installed presentation tree.
 *
 * Node state is retained in dense struct-of-arrays stores. There are no
 * resident per-node records or pose arrays; node and payload views are made
 * only when a caller asks for a specific slot. A bounded store pool lets a
 * whole frame batch be prepared without mutating the live store.
 */
class PresentationSceneTree {
  constructor({ limits = {} } = {}) {
    this.limits = normalizeLimits(limits);
    this.state = null;
    this.dynamicPool = null;
    this.pending = false;
    this.disposed = false;
  }

  installBootstrap(bootstrap) {
    this.requireOpen();
    if (this.state) throw new SceneDisplayEngineError('bootstrap-already-installed');
    const installed = buildInstalledState(bootstrap, this.limits, 1);
    this.state = installed.state;
    this.dynamicPool = installed.dynamicPool;
    return bootstrapPlan(this.state);
  }

  prepareFrames(frames) {
    this.requireReady();
    if (this.pending) throw new SceneDisplayEngineError('frame-prepare-in-flight');
    if (!Array.isArray(frames)) throw new SceneDisplayEngineError('frame-batch-invalid');
    if (frames.length === 0) throw new SceneDisplayEngineError('frame-batch-empty');
    if (frames.length > this.limits.maximumFramesPerBatch) {
      throw new SceneDisplayEngineError('frame-batch-limit-exceeded');
    }

    const expected = this.state;
    const available = this.dynamicPool.filter((store) => store !== expected.dynamicStore);
    const steps = [];
    let previous = expected;
    try {
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        const target = available[index % available.length];
        const candidate = prepareFrameCandidate(
          previous,
          target,
          frame,
          this.limits,
        );
        const plan = framePlan(previous, candidate);
        steps.push(Object.freeze({
          events: materializeEvents(frame),
          plan,
          // Step views borrow the already-validated complete frame. This keeps
          // transient lifecycle observable without retaining N dense stores
          // for an N-frame correlation.
          view: new PresentationSceneView(candidate, frame),
        }));
        previous = candidate;
      }
    } catch (error) {
      for (const store of available) store.releaseBorrowedPayloads();
      throw error;
    }

    const finalState = previous;
    for (const store of available) {
      if (store !== finalState.dynamicStore) store.releaseBorrowedPayloads();
    }
    const frozenSteps = Object.freeze(steps);
    let status = 'prepared';
    this.pending = true;
    return Object.freeze({
      steps: frozenSteps,
      assertCommittable: () => {
        if (status !== 'prepared') {
          throw new SceneDisplayEngineError('frame-batch-token-not-prepared');
        }
        if (this.disposed) throw new SceneDisplayEngineError('scene-tree-disposed');
        if (!this.pending || this.state !== expected) {
          throw new SceneDisplayEngineError('frame-batch-token-stale');
        }
        status = 'validated';
      },
      abort: () => {
        if (status === 'aborted') return;
        if (status === 'committed') {
          throw new SceneDisplayEngineError('frame-batch-token-settled');
        }
        status = 'aborted';
        this.pending = false;
        for (const store of available) store.releaseBorrowedPayloads();
      },
      commitValidated: () => {
        if (status !== 'validated') {
          throw new SceneDisplayEngineError('frame-batch-token-not-validated');
        }
        status = 'committed';
        this.pending = false;
        // Validation and planning completed before the synchronous barrier.
        // This method intentionally performs only the live pointer swap.
        this.state = finalState;
      },
    });
  }

  currentView() {
    this.requireReady();
    return new PresentationSceneView(this.state);
  }

  getNode(displayId) {
    this.requireReady();
    return nodeById(this.state, displayId);
  }

  getWorldPose(displayId, out) {
    this.requireReady();
    const located = locateNode(this.state, positiveBigInt(displayId, 'displayId'));
    if (!located) return false;
    located.store.readWorldPose(located.slot, out);
    return true;
  }

  getInteraction(displayId) {
    this.requireReady();
    const located = locateNode(this.state, positiveBigInt(displayId, 'displayId'));
    return located ? located.store.payloadAt(located.slot, 'interaction') : null;
  }

  getProfile(displayId) {
    this.requireReady();
    const located = locateNode(this.state, positiveBigInt(displayId, 'displayId'));
    return located ? located.store.payloadAt(located.slot, 'profile') : null;
  }

  getSceneMetadata(metadataTypeId) {
    this.requireReady();
    return metadataByType(this.state.metadata, metadataTypeId);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = false;
    this.state = null;
    this.dynamicPool = null;
  }

  requireOpen() {
    if (this.disposed) throw new SceneDisplayEngineError('scene-tree-disposed');
  }

  requireReady() {
    this.requireOpen();
    if (!this.state) throw new SceneDisplayEngineError('bootstrap-missing');
  }
}

export class SceneDisplayEngine {
  #aggregate;
  #captureHook;
  #captureScheduled;
  #commit;
  #disposed;
  #metrics;
  #tree;

  constructor(options = {}) {
    const { captureHook, limits } = normalizeEngineOptions(options);
    this.#tree = new PresentationSceneTree({ limits });
    this.#captureHook = captureHook;
    this.#captureScheduled = false;
    this.#aggregate = null;
    this.#commit = null;
    this.#disposed = false;
    this.#metrics = {
      committedAggregates: 0,
      committedFrames: 0,
      committedFrameBatches: 0,
      prepareFailures: 0,
    };
  }

  installBootstrap(bootstrap) {
    const plan = this.#tree.installBootstrap(bootstrap);
    this.schedulePostCommitCapture();
    return plan;
  }

  /**
   * Prepare one complete Engine commit. An opaque, product-validated aggregate
   * and the presentation-tree candidate share one synchronous pointer barrier.
   * The Engine owns ordering and immutable retention but never interprets the
   * aggregate codec or product fields.
   * An empty frame batch is legal for additional authority publications that
   * refer to an already-installed Engine commit.
   */
  prepareCommit({ aggregateCandidate, engineCommit, frames = [] } = {}) {
    if (!Array.isArray(frames)) {
      throw new SceneDisplayEngineError('engine-commit-frames-invalid');
    }
    let treePrepared = null;
    try {
      this.#tree.requireReady();
      const normalized = validateAggregateCommitCandidate(
        aggregateCandidate,
        engineCommit,
        this.#aggregate,
        this.#commit,
      );
      validateFrameCommitTicks(frames, normalized.engineCommit);
      validateFrameCommitPolicy(frames, normalized, this.#commit);
      if (frames.length > 0) treePrepared = this.#tree.prepareFrames(frames);
      return this.#wrapCommitPrepared({
        treePrepared,
        frameCount: frames.length,
        normalized,
      });
    } catch (error) {
      try { treePrepared?.abort?.(); } catch { /* preserve the primary failure */ }
      this.#metrics.prepareFailures += 1;
      throw error;
    }
  }

  /** Presentation-only compatibility path for isolated package fixtures. */
  prepareFrames(frames) {
    let prepared;
    try {
      prepared = this.#tree.prepareFrames(frames);
    } catch (error) {
      this.#metrics.prepareFailures += 1;
      throw error;
    }
    return this.#wrapPreparedFrames(prepared, frames.length);
  }

  #wrapCommitPrepared({ treePrepared, frameCount, normalized }) {
    const expectedAggregate = this.#aggregate;
    const expectedCommit = this.#commit;
    let status = 'prepared';
    const result = {
      aggregate: normalized.aggregate,
      engineCommit: normalized.engineCommit,
      steps: treePrepared?.steps ?? Object.freeze([]),
      assertCommittable: () => {
        if (status !== 'prepared') {
          throw new SceneDisplayEngineError('engine-commit-token-not-prepared');
        }
        if (this.#disposed) throw new SceneDisplayEngineError('scene-display-engine-disposed');
        if (
          this.#aggregate !== expectedAggregate
          || this.#commit !== expectedCommit
        ) {
          throw new SceneDisplayEngineError('engine-commit-token-stale');
        }
        treePrepared?.assertCommittable();
        status = 'validated';
      },
      abort: () => {
        if (status === 'aborted') return;
        if (status === 'committed') {
          throw new SceneDisplayEngineError('engine-commit-token-settled');
        }
        status = 'aborted';
        treePrepared?.abort();
      },
      commitValidated: () => {
        if (status !== 'validated') {
          throw new SceneDisplayEngineError('engine-commit-token-not-validated');
        }
        // No callback or await is permitted inside this barrier. The data
        // pointer and the sole presentation tree move together.
        treePrepared?.commitValidated();
        this.#aggregate = normalized.aggregate;
        this.#commit = normalized.engineCommit;
        status = 'committed';
        this.#metrics.committedFrames += frameCount;
        if (frameCount > 0) this.#metrics.committedFrameBatches += 1;
        if (normalized.advancesCommit) this.#metrics.committedAggregates += 1;
      },
    };
    return Object.freeze(result);
  }

  #wrapPreparedFrames(prepared, frameCount) {
    let status = 'prepared';
    const result = {
      steps: prepared.steps,
      assertCommittable: () => {
        if (status !== 'prepared') {
          throw new SceneDisplayEngineError('frame-batch-token-not-prepared');
        }
        prepared.assertCommittable();
        status = 'validated';
      },
      abort: () => {
        if (status === 'aborted') return;
        if (status === 'committed') {
          throw new SceneDisplayEngineError('frame-batch-token-settled');
        }
        status = 'aborted';
        prepared.abort();
      },
      commitValidated: () => {
        if (status !== 'validated') {
          throw new SceneDisplayEngineError('frame-batch-token-not-validated');
        }
        prepared.commitValidated();
        status = 'committed';
        this.#metrics.committedFrames += frameCount;
        this.#metrics.committedFrameBatches += 1;
      },
    };
    return Object.freeze(result);
  }

  currentAggregate() {
    if (this.#disposed) throw new SceneDisplayEngineError('scene-display-engine-disposed');
    return this.#aggregate;
  }

  currentCommit() {
    if (this.#disposed) throw new SceneDisplayEngineError('scene-display-engine-disposed');
    return this.#commit;
  }

  currentView() { return this.#tree.currentView(); }
  getNode(displayId) { return this.#tree.getNode(displayId); }
  getWorldPose(displayId, out) { return this.#tree.getWorldPose(displayId, out); }
  getInteraction(displayId) { return this.#tree.getInteraction(displayId); }
  getProfile(displayId) { return this.#tree.getProfile(displayId); }
  getSceneMetadata(metadataTypeId) { return this.#tree.getSceneMetadata(metadataTypeId); }

  capture() {
    const state = this.#tree.state;
    return Object.freeze({
      generation: state?.generation ?? 0,
      nodeCount: state ? state.staticStore.count + state.dynamicStore.count : 0,
      staticNodeCount: state?.staticStore.count ?? 0,
      dynamicNodeCount: state?.dynamicStore.count ?? 0,
      maxSeenDisplayId: state?.maxSeenDisplayId ?? 0n,
      lastFrameSeq: state?.lastFrameSeq ?? null,
      lastSourceTick: state?.lastSourceTick ?? null,
      aggregateCodecIdentity: this.#aggregate?.codecIdentity ?? null,
      aggregateRevision: this.#aggregate?.revision ?? null,
      aggregateSourceTick: this.#aggregate?.sourceTick ?? null,
      engineGenerationId: this.#commit?.generation_id ?? null,
      engineCommitSeq: this.#commit?.commit_seq ?? null,
      denseDynamicStoreCount: this.#tree.dynamicPool?.length ?? 0,
      dynamicStoreCapacity: state?.dynamicStore.capacity ?? 0,
      residentNodeObjectCount: 0,
      residentPoseObjectCount: 0,
      metrics: Object.freeze({ ...this.#metrics }),
    });
  }

  /**
   * Schedule the protected capture observer after an external pointer barrier.
   *
   * Prepared token commitValidated() deliberately never calls this method: a
   * product coordinator must first swap every jointly-owned pointer, then ask
   * the Engine to enqueue this observer outside that synchronous barrier.
   */
  schedulePostCommitCapture() {
    if (!this.#captureHook || this.#captureScheduled || this.#disposed) return;
    this.#captureScheduled = true;
    try {
      queueMicrotask(() => {
        this.#captureScheduled = false;
        if (this.#disposed) return;
        try { this.#captureHook(this.capture()); } catch {
          // Capture observers never alter committed Engine or product state.
        }
      });
    } catch {
      // Scheduling failure is diagnostic-only and cannot roll state back.
      this.#captureScheduled = false;
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#captureScheduled = false;
    this.#aggregate = null;
    this.#commit = null;
    this.#tree.dispose();
  }
}

class PresentationSceneView {
  #borrowedDynamicView;
  #state;

  constructor(state, borrowedDynamicView = null) {
    this.#state = state;
    this.#borrowedDynamicView = borrowedDynamicView;
    this.generation = state.generation;
    this.sceneEpoch = state.sceneEpoch;
    this.bootstrapId = state.bootstrapId;
    this.profileId = state.profileId;
    this.nodeCount = state.staticStore.count
      + (borrowedDynamicView?.nodeCount ?? state.dynamicStore.count);
    this.staticNodeCount = state.staticStore.count;
    this.dynamicNodeCount = borrowedDynamicView?.nodeCount ?? state.dynamicStore.count;
    this.frameSeq = state.lastFrameSeq;
    this.sourceTick = state.lastSourceTick;
    this.projectionId = state.lastProjectionId;
    this.sceneMetadataCount = state.metadata.count;
    Object.freeze(this);
  }

  nodeAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.nodeCount) {
      throw new SceneDisplayEngineError('node-index-invalid');
    }
    if (index < this.staticNodeCount) {
      return new PresentationNodeSlotView(this.#state.staticStore, index);
    }
    if (this.#borrowedDynamicView) {
      return new BorrowedFrameNodeSlotView(
        this.#borrowedDynamicView,
        index - this.staticNodeCount,
      );
    }
    return new PresentationNodeSlotView(
      this.#state.dynamicStore,
      index - this.staticNodeCount,
    );
  }

  getNode(displayId) {
    const id = positiveBigInt(displayId, 'displayId');
    const staticSlot = this.#state.staticStore.index.get(id);
    if (staticSlot !== -1) {
      return new PresentationNodeSlotView(this.#state.staticStore, staticSlot);
    }
    if (!this.#borrowedDynamicView) return nodeById(this.#state, id);
    const slot = borrowedNodeSlot(this.#borrowedDynamicView, id);
    return slot === -1
      ? null
      : new BorrowedFrameNodeSlotView(this.#borrowedDynamicView, slot);
  }

  getInteraction(displayId) {
    if (this.#borrowedDynamicView) return this.getNode(displayId)?.interaction ?? null;
    const located = locateNode(this.#state, positiveBigInt(displayId, 'displayId'));
    return located ? located.store.payloadAt(located.slot, 'interaction') : null;
  }

  getProfile(displayId) {
    if (this.#borrowedDynamicView) return this.getNode(displayId)?.profile ?? null;
    const located = locateNode(this.#state, positiveBigInt(displayId, 'displayId'));
    return located ? located.store.payloadAt(located.slot, 'profile') : null;
  }

  sceneMetadataAt(index) {
    return metadataAt(this.#state.metadata, index);
  }

  getSceneMetadata(metadataTypeId) {
    return metadataByType(this.#state.metadata, metadataTypeId);
  }

  getWorldPose(displayId, out) {
    if (this.#borrowedDynamicView) {
      return readBorrowedWorldPose(
        this.#state,
        this.#borrowedDynamicView,
        displayId,
        out,
      );
    }
    const located = locateNode(this.#state, positiveBigInt(displayId, 'displayId'));
    if (!located) return false;
    located.store.readWorldPose(located.slot, out);
    return true;
  }

  *[Symbol.iterator]() {
    for (let index = 0; index < this.nodeCount; index += 1) yield this.nodeAt(index);
  }
}

class PresentationNodeSlotView {
  #slot;
  #store;

  constructor(store, slot) {
    this.#store = store;
    this.#slot = slot;
    Object.freeze(this);
  }

  get displayId() { return this.#store.displayIds[this.#slot]; }
  get parentDisplayId() { return this.#store.parentDisplayIds[this.#slot]; }
  get visualTypeId() { return this.#store.visualTypeIds[this.#slot]; }
  get flags() { return this.#store.flags[this.#slot]; }
  get isStatic() { return this.#store.isStatic; }
  get localPosition() { return tupleView(this.#store.localPositions, this.#slot, 3); }
  get localRotationXyzw() { return tupleView(this.#store.localRotations, this.#slot, 4); }
  get localScale() { return tupleView(this.#store.localScales, this.#slot, 3); }
  get animationStateId() { return this.#store.animationStateIds[this.#slot]; }
  get animationStartTick() { return this.#store.animationStartTicks[this.#slot]; }
  get animationFlags() { return this.#store.animationFlags[this.#slot]; }
  get profile() { return this.#store.payloadAt(this.#slot, 'profile'); }
  get interaction() { return this.#store.payloadAt(this.#slot, 'interaction'); }
}

class BorrowedFrameNodeSlotView {
  #slot;
  #view;

  constructor(view, slot) {
    this.#view = view;
    this.#slot = slot;
    Object.freeze(this);
  }

  get displayId() { return this.#view.displayIdAt(this.#slot); }
  get parentDisplayId() { return this.#view.parentDisplayIdAt(this.#slot); }
  get visualTypeId() { return this.#view.visualTypeIdAt(this.#slot); }
  get flags() { return this.#view.flagsAt(this.#slot); }
  get isStatic() { return false; }
  get localPosition() { return readBorrowedLocalTuple(this.#view, this.#slot, 'position'); }
  get localRotationXyzw() { return readBorrowedLocalTuple(this.#view, this.#slot, 'rotation'); }
  get localScale() { return readBorrowedLocalTuple(this.#view, this.#slot, 'scale'); }
  get animationStateId() { return this.#view.animationStateIdAt(this.#slot); }
  get animationStartTick() { return this.#view.animationStartTickAt(this.#slot); }
  get animationFlags() { return this.#view.animationFlagsAt(this.#slot); }
  get profile() { return borrowedPayloadAt(this.#view, this.#slot, 'profile'); }
  get interaction() { return borrowedPayloadAt(this.#view, this.#slot, 'interaction'); }
}

export function samplePresentationAnimation({
  animationStateId = 0,
  animationStartTick,
  durationTicks,
  flags = 0,
  sourceTick,
} = {}) {
  const stateId = uint32(animationStateId, 'animationStateId');
  const animationFlags = uint32(flags, 'animationFlags');
  if (animationFlags & ~7) throw new SceneDisplayEngineError('animationFlags-invalid');
  const start = nonnegativeBigInt(animationStartTick, 'animationStartTick');
  const source = nonnegativeBigInt(sourceTick, 'sourceTick');
  const duration = positiveBigInt(durationTicks, 'durationTicks');
  if (source < start) throw new SceneDisplayEngineError('animation-before-start');
  const elapsed = source - start;
  const sampled = animationFlags & 1
    ? elapsed % duration
    : (elapsed > duration ? duration : elapsed);
  return Object.freeze({
    animationStateId: stateId,
    elapsedTicks: elapsed,
    flags: animationFlags,
    phase: Number(sampled) / Number(duration),
    sourceTick: source,
  });
}

class DenseNodeStore {
  constructor(capacity, isStatic) {
    this.capacity = capacity;
    this.isStatic = isStatic;
    this.count = 0;
    this.sourceRaw = null;
    this.displayIds = new BigUint64Array(capacity);
    this.parentDisplayIds = new BigUint64Array(capacity);
    this.visualTypeIds = new Uint32Array(capacity);
    this.flags = new Uint32Array(capacity);
    this.localPositions = new Float32Array(capacity * 3);
    this.localRotations = new Float32Array(capacity * 4);
    this.localScales = new Float32Array(capacity * 3);
    this.animationStateIds = new Uint32Array(capacity);
    this.animationStartTicks = new BigUint64Array(capacity);
    this.animationFlags = new Uint32Array(capacity);
    this.profileTypeIds = new Uint32Array(capacity);
    this.profileFlags = new Uint32Array(capacity);
    this.profileBytes = new Array(capacity).fill(null);
    this.interactionTypeIds = new Uint32Array(capacity);
    this.interactionFlags = new Uint32Array(capacity);
    this.interactionBytes = new Array(capacity).fill(null);
    this.depths = new Uint16Array(capacity);
    this.worldPositions = new Float64Array(capacity * 3);
    this.worldRotations = new Float64Array(capacity * 4);
    this.worldScales = new Float64Array(capacity * 3);
    this.index = new DenseIdIndex(capacity);
  }

  reset(view) {
    this.releaseBorrowedPayloads();
    this.count = 0;
    this.sourceRaw = view?.raw ?? view?.data ?? null;
    this.index.clear();
  }

  releaseBorrowedPayloads() {
    for (let index = 0; index < this.count; index += 1) {
      this.profileBytes[index] = null;
      this.interactionBytes[index] = null;
    }
    this.sourceRaw = null;
  }

  payloadAt(slot, kind) {
    const profile = kind === 'profile';
    const typeId = (profile ? this.profileTypeIds : this.interactionTypeIds)[slot];
    if (typeId === 0) return null;
    return Object.freeze({
      typeId,
      flags: (profile ? this.profileFlags : this.interactionFlags)[slot],
      bytes: (profile ? this.profileBytes : this.interactionBytes)[slot],
    });
  }

  readWorldPose(slot, out) {
    validatePoseOut(out);
    copyTuple(this.worldPositions, slot * 3, out.position, 3);
    copyTuple(this.worldRotations, slot * 4, out.rotationXyzw, 4);
    copyTuple(this.worldScales, slot * 3, out.scale, 3);
    return out;
  }
}

class DenseIdIndex {
  constructor(capacity) {
    let size = 4;
    while (size < capacity * 2) size *= 2;
    this.keys = new BigUint64Array(size);
    this.slots = new Int32Array(size);
    this.mask = size - 1;
  }

  clear() { this.keys.fill(0n); }

  get(id) {
    let bucket = hashId(id, this.mask);
    for (;;) {
      const key = this.keys[bucket];
      if (key === 0n) return -1;
      if (key === id) return this.slots[bucket];
      bucket = (bucket + 1) & this.mask;
    }
  }

  set(id, slot) {
    let bucket = hashId(id, this.mask);
    for (;;) {
      const key = this.keys[bucket];
      if (key === 0n) {
        this.keys[bucket] = id;
        this.slots[bucket] = slot;
        return;
      }
      if (key === id) throw new SceneDisplayEngineError('display-id-duplicate');
      bucket = (bucket + 1) & this.mask;
    }
  }
}

function buildInstalledState(bootstrap, limits, generation) {
  assertBootstrapView(bootstrap);
  if (bootstrap.nodeCount > limits.maximumNodes) {
    throw new SceneDisplayEngineError('bootstrap-node-count-invalid');
  }
  const maximumDynamicNodes = uint32(
    Number(bootstrap.header.maximumDynamicNodes),
    'maximumDynamicNodes',
  );
  if (maximumDynamicNodes > limits.maximumNodes - bootstrap.nodeCount) {
    throw new SceneDisplayEngineError('bootstrap-dynamic-limit-invalid');
  }
  const visuals = new Map();
  for (let index = 0; index < bootstrap.visualTypeCount; index += 1) {
    const item = bootstrap.visualTypeAt(index);
    uint32(item.flags, 'visualFlags');
    visuals.set(positiveUint32(item.visualTypeId, 'visualTypeId'), Object.freeze({
      profileTypeId: uint32(item.profileTypeId, 'profileTypeId'),
      interactionTypeId: uint32(item.interactionTypeId, 'interactionTypeId'),
    }));
  }
  const animations = new Set();
  for (let index = 0; index < bootstrap.animationStateCount; index += 1) {
    const animation = bootstrap.animationStateAt(index);
    uint32(animation.flags, 'animationFlags');
    positiveUint32(animation.durationTicks, 'durationTicks');
    animations.add(positiveUint32(
      animation.animationStateId,
      'animationStateId',
    ));
  }
  const registry = Object.freeze({ visuals, animations });
  const metadata = buildMetadataStore(bootstrap);
  const staticStore = new DenseNodeStore(bootstrap.nodeCount, true);
  fillStore(staticStore, bootstrap, registry, null, limits.maximumTreeDepth, null);
  const dynamicPool = Array.from(
    // live + two alternating scratch stores are sufficient for any bounded
    // batch because step views borrow each complete input frame.
    { length: 3 },
    () => new DenseNodeStore(maximumDynamicNodes, false),
  );
  const dynamicStore = dynamicPool[0];
  dynamicStore.reset(null);
  const maximumStaticDisplayId = staticStore.count
    ? staticStore.displayIds[staticStore.count - 1] : 0n;
  return {
    dynamicPool,
    state: Object.freeze({
      generation,
      sceneEpoch: positiveBigInt(bootstrap.header.sceneEpoch, 'sceneEpoch'),
      bootstrapId: positiveBigInt(bootstrap.header.bootstrapId, 'bootstrapId'),
      profileId: canonicalText(bootstrap.identity?.profileId, 'profileId'),
      viewerScope: canonicalText(bootstrap.identity?.viewerScope, 'viewerScope'),
      maximumDynamicNodes,
      maximumStaticDisplayId,
      maxSeenDisplayId: maximumStaticDisplayId,
      staticStore,
      dynamicStore,
      registry,
      metadata,
      lastFrameSeq: 0n,
      lastSourceTick: null,
      lastProjectionId: null,
    }),
  };
}

function prepareFrameCandidate(previous, target, frame, limits) {
  const header = normalizeFrameHeader(frame?.header);
  if (header.sceneEpoch !== previous.sceneEpoch || header.bootstrapId !== previous.bootstrapId) {
    throw new SceneDisplayEngineError('frame-bootstrap-identity-mismatch');
  }
  if (header.frameSeq !== previous.lastFrameSeq + 1n) {
    throw new SceneDisplayEngineError('frame-sequence-gap');
  }
  if (previous.lastSourceTick != null && header.sourceTick !== previous.lastSourceTick
      && header.sourceTick !== previous.lastSourceTick + 1n) {
    throw new SceneDisplayEngineError('frame-source-tick-gap');
  }
  assertNodeView(frame);
  if (frame.nodeCount > previous.maximumDynamicNodes) {
    throw new SceneDisplayEngineError('frame-node-count-invalid');
  }
  fillStore(
    target,
    frame,
    previous.registry,
    previous.staticStore,
    limits.maximumTreeDepth,
    header.sourceTick,
  );
  if (target.count && target.displayIds[0] <= previous.maximumStaticDisplayId) {
    throw new SceneDisplayEngineError('dynamic-id-overlaps-static-range');
  }
  const maxSeenDisplayId = validateIdLifetime(
    previous.dynamicStore,
    target,
    previous.maxSeenDisplayId,
  );
  return Object.freeze({
    ...previous,
    dynamicStore: target,
    maxSeenDisplayId,
    lastFrameSeq: header.frameSeq,
    lastSourceTick: header.sourceTick,
    lastProjectionId: header.projectionId,
  });
}

function fillStore(store, view, registry, staticStore, maximumDepth, sourceTick) {
  if (view.nodeCount > store.capacity) throw new SceneDisplayEngineError('frame-node-count-invalid');
  store.reset(view);
  const pose = {
    localPosition: new Float32Array(3),
    localRotationXyzw: new Float32Array(4),
    localScale: new Float32Array(3),
  };
  const profile = {};
  const interaction = {};
  let previousId = 0n;
  for (let slot = 0; slot < view.nodeCount; slot += 1) {
    const displayId = positiveBigInt(view.displayIdAt(slot), 'displayId');
    const parentDisplayId = nonnegativeBigInt(view.parentDisplayIdAt(slot), 'parentDisplayId');
    if (displayId <= previousId || (parentDisplayId !== 0n && parentDisplayId >= displayId)) {
      throw new SceneDisplayEngineError('node-order-or-parent-invalid');
    }
    if (staticStore && staticStore.index.get(displayId) !== -1) {
      throw new SceneDisplayEngineError('dynamic-id-overlaps-static-range');
    }
    const visualTypeId = positiveUint32(view.visualTypeIdAt(slot), 'visualTypeId');
    const visual = registry.visuals.get(visualTypeId);
    if (!visual) throw new SceneDisplayEngineError('visual-type-unknown');
    const flags = uint32(view.flagsAt(slot), 'flags');
    if (flags & ~NODE_VISIBLE) throw new SceneDisplayEngineError('node-flags-invalid');
    const animationStateId = uint32(
      view.animationStateIdAt(slot),
      'animationStateId',
    );
    if (animationStateId !== 0 && !registry.animations.has(animationStateId)) {
      throw new SceneDisplayEngineError('animation-state-unknown');
    }
    const animationStartTick = nonnegativeBigInt(
      view.animationStartTickAt(slot),
      'animationStartTick',
    );
    if (sourceTick != null && animationStartTick > sourceTick) {
      throw new SceneDisplayEngineError('animation-before-frame');
    }
    const animationFlags = uint32(
      view.animationFlagsAt(slot),
      'animationFlags',
    );
    if (animationFlags & ~7) throw new SceneDisplayEngineError('animation-flags-invalid');
    view.readLocalPose(slot, pose);
    validateLocalPose(pose);
    const hasProfile = view.readProfileStateAt(slot, profile);
    const hasInteraction = view.readInteractionAt(slot, interaction);
    if (Number(hasProfile ? profile.typeId : 0) !== visual.profileTypeId) {
      throw new SceneDisplayEngineError('profile-type-mismatch');
    }
    if (Number(hasInteraction ? interaction.typeId : 0) !== visual.interactionTypeId) {
      throw new SceneDisplayEngineError('interaction-type-mismatch');
    }

    store.displayIds[slot] = displayId;
    store.parentDisplayIds[slot] = parentDisplayId;
    store.visualTypeIds[slot] = visualTypeId;
    store.flags[slot] = flags;
    copyInto(store.localPositions, slot * 3, pose.localPosition, 3);
    copyInto(store.localRotations, slot * 4, pose.localRotationXyzw, 4);
    copyInto(store.localScales, slot * 3, pose.localScale, 3);
    store.animationStateIds[slot] = animationStateId;
    store.animationStartTicks[slot] = animationStartTick;
    store.animationFlags[slot] = animationFlags;
    writePayload(store, slot, 'profile', hasProfile ? profile : null);
    writePayload(store, slot, 'interaction', hasInteraction ? interaction : null);
    deriveWorldPose(store, slot, parentDisplayId, staticStore, maximumDepth);
    store.index.set(displayId, slot);
    store.count = slot + 1;
    previousId = displayId;
  }
}

function deriveWorldPose(store, slot, parentDisplayId, staticStore, maximumDepth) {
  if (parentDisplayId === 0n) {
    store.depths[slot] = 1;
    copyTuple(store.localPositions, slot * 3, store.worldPositions.subarray(slot * 3), 3);
    copyTuple(store.localRotations, slot * 4, store.worldRotations.subarray(slot * 4), 4);
    copyTuple(store.localScales, slot * 3, store.worldScales.subarray(slot * 3), 3);
    return;
  }
  let parentStore = store;
  let parentSlot = store.index.get(parentDisplayId);
  if (parentSlot === -1 && staticStore) {
    parentStore = staticStore;
    parentSlot = staticStore.index.get(parentDisplayId);
  }
  if (parentSlot === -1) throw new SceneDisplayEngineError('dangling-parent');
  const depth = parentStore.depths[parentSlot] + 1;
  if (depth > maximumDepth) throw new SceneDisplayEngineError('tree-depth-exceeded');
  store.depths[slot] = depth;
  composeWorldPose(parentStore, parentSlot, store, slot);
}

function composeWorldPose(parent, parentSlot, child, childSlot) {
  const pp = parentSlot * 3;
  const pr = parentSlot * 4;
  const ps = parentSlot * 3;
  const cp = childSlot * 3;
  const cr = childSlot * 4;
  const cs = childSlot * 3;
  const sx = parent.worldScales[ps] * child.localPositions[cp];
  const sy = parent.worldScales[ps + 1] * child.localPositions[cp + 1];
  const sz = parent.worldScales[ps + 2] * child.localPositions[cp + 2];
  const x = parent.worldRotations[pr];
  const y = parent.worldRotations[pr + 1];
  const z = parent.worldRotations[pr + 2];
  const w = parent.worldRotations[pr + 3];
  const tx = 2 * (y * sz - z * sy);
  const ty = 2 * (z * sx - x * sz);
  const tz = 2 * (x * sy - y * sx);
  child.worldPositions[cp] = parent.worldPositions[pp] + sx + w * tx + (y * tz - z * ty);
  child.worldPositions[cp + 1] = parent.worldPositions[pp + 1] + sy + w * ty + (z * tx - x * tz);
  child.worldPositions[cp + 2] = parent.worldPositions[pp + 2] + sz + w * tz + (x * ty - y * tx);
  multiplyQuaternionAt(parent.worldRotations, pr, child.localRotations, cr,
    child.worldRotations, cr);
  child.worldScales[cs] = parent.worldScales[ps] * child.localScales[cs];
  child.worldScales[cs + 1] = parent.worldScales[ps + 1] * child.localScales[cs + 1];
  child.worldScales[cs + 2] = parent.worldScales[ps + 2] * child.localScales[cs + 2];
}

function validateIdLifetime(oldStore, nextStore, initialMaxSeen) {
  let oldIndex = 0;
  let nextIndex = 0;
  let maxSeen = initialMaxSeen;
  while (nextIndex < nextStore.count) {
    const nextId = nextStore.displayIds[nextIndex];
    while (oldIndex < oldStore.count && oldStore.displayIds[oldIndex] < nextId) oldIndex += 1;
    const exists = oldIndex < oldStore.count && oldStore.displayIds[oldIndex] === nextId;
    if (!exists) {
      if (nextId <= maxSeen) throw new SceneDisplayEngineError('display-id-reused');
      maxSeen = nextId;
    }
    nextIndex += 1;
  }
  return maxSeen;
}

function framePlan(previous, candidate) {
  const oldStore = previous.dynamicStore;
  const nextStore = candidate.dynamicStore;
  const creates = [];
  const removals = [];
  const reparent = [];
  const localPose = [];
  const visibility = [];
  const visualReplace = [];
  const profile = [];
  const animation = [];
  const interaction = [];
  let oldIndex = 0;
  let nextIndex = 0;
  while (oldIndex < oldStore.count || nextIndex < nextStore.count) {
    const oldId = oldIndex < oldStore.count ? oldStore.displayIds[oldIndex] : null;
    const nextId = nextIndex < nextStore.count ? nextStore.displayIds[nextIndex] : null;
    if (nextId == null || (oldId != null && oldId < nextId)) {
      removals.push(oldIndex);
      oldIndex += 1;
      continue;
    }
    if (oldId == null || nextId < oldId) {
      creates.push(nextId);
      nextIndex += 1;
      continue;
    }
    if (oldStore.parentDisplayIds[oldIndex] !== nextStore.parentDisplayIds[nextIndex]) {
      reparent.push(nextId);
    }
    if (!poseAtEquals(oldStore, oldIndex, nextStore, nextIndex)) localPose.push(nextId);
    if ((oldStore.flags[oldIndex] & NODE_VISIBLE) !== (nextStore.flags[nextIndex] & NODE_VISIBLE)) {
      visibility.push(nextId);
    }
    if (oldStore.visualTypeIds[oldIndex] !== nextStore.visualTypeIds[nextIndex]) {
      visualReplace.push(nextId);
    }
    if (!payloadAtEquals(oldStore, oldIndex, nextStore, nextIndex, 'profile')) profile.push(nextId);
    if (!payloadAtEquals(oldStore, oldIndex, nextStore, nextIndex, 'interaction')) {
      interaction.push(nextId);
    }
    if (oldStore.animationStateIds[oldIndex] !== nextStore.animationStateIds[nextIndex]
        || oldStore.animationStartTicks[oldIndex] !== nextStore.animationStartTicks[nextIndex]
        || oldStore.animationFlags[oldIndex] !== nextStore.animationFlags[nextIndex]) {
      animation.push(nextId);
    }
    oldIndex += 1;
    nextIndex += 1;
  }
  removals.sort((left, right) => oldStore.depths[right] - oldStore.depths[left]
    || (oldStore.displayIds[left] < oldStore.displayIds[right] ? 1 : -1));
  return freezePlan({
    kind: 'frame',
    generation: candidate.generation,
    createIds: creates,
    removeIds: removals.map((slot) => oldStore.displayIds[slot]),
    reparentIds: reparent,
    localPoseDirtyIds: localPose,
    visibilityDirtyIds: visibility,
    visualReplaceIds: visualReplace,
    profileStateDirtyIds: profile,
    animationDirtyIds: animation,
    interactionDirtyIds: interaction,
    frameSeq: candidate.lastFrameSeq,
    sourceTick: candidate.lastSourceTick,
  });
}

function bootstrapPlan(state) {
  const createIds = [];
  for (let slot = 0; slot < state.staticStore.count; slot += 1) {
    createIds.push(state.staticStore.displayIds[slot]);
  }
  return freezePlan({
    kind: 'bootstrap',
    generation: state.generation,
    createIds,
    removeIds: [],
    reparentIds: [],
    localPoseDirtyIds: [],
    visibilityDirtyIds: [],
    visualReplaceIds: [],
    profileStateDirtyIds: [],
    animationDirtyIds: [],
    interactionDirtyIds: [],
    frameSeq: null,
    sourceTick: null,
  });
}

function materializeEvents(frame) {
  if (!Number.isInteger(frame.eventCount) || frame.eventCount < 0
      || typeof frame.eventAt !== 'function') {
    throw new SceneDisplayEngineError('frame-events-invalid');
  }
  const events = [];
  for (let index = 0; index < frame.eventCount; index += 1) {
    const event = frame.eventAt(index);
    events.push(Object.freeze({
      eventId: positiveBigInt(event.eventId, 'eventId'),
      eventTypeId: positiveUint32(event.eventTypeId, 'eventTypeId'),
      flags: eventFlags(event.flags),
      sourceDisplayId: nonnegativeBigInt(event.sourceDisplayId, 'sourceDisplayId'),
      targetDisplayId: nonnegativeBigInt(event.targetDisplayId, 'targetDisplayId'),
      startTick: nonnegativeBigInt(event.startTick, 'startTick'),
      // Event delivery may outlive the borrowed frame and consumers may keep
      // or mutate the bytes. Own the exact view range for every normalized
      // event so neither the source frame nor a sibling event can be changed.
      payload: new Uint8Array(borrowedBytes(event.payload)),
    }));
  }
  return Object.freeze(events);
}

function locateNode(state, displayId) {
  let slot = state.staticStore.index.get(displayId);
  if (slot !== -1) return { store: state.staticStore, slot };
  slot = state.dynamicStore.index.get(displayId);
  return slot === -1 ? null : { store: state.dynamicStore, slot };
}

function borrowedNodeSlot(view, displayId) {
  let low = 0;
  let high = view.nodeCount - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = view.displayIdAt(middle);
    if (candidate === displayId) return middle;
    if (candidate < displayId) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

function borrowedPayloadAt(view, slot, kind) {
  const value = {};
  const present = kind === 'profile'
    ? view.readProfileStateAt(slot, value)
    : view.readInteractionAt(slot, value);
  return present ? Object.freeze({
    typeId: value.typeId,
    flags: value.flags,
    bytes: value.bytes,
  }) : null;
}

function readBorrowedLocalTuple(view, slot, kind) {
  const pose = {
    localPosition: new Float32Array(3),
    localRotationXyzw: new Float32Array(4),
    localScale: new Float32Array(3),
  };
  view.readLocalPose(slot, pose);
  if (kind === 'position') return pose.localPosition;
  if (kind === 'rotation') return pose.localRotationXyzw;
  return pose.localScale;
}

function readBorrowedWorldPose(state, view, displayId, out) {
  validatePoseOut(out);
  const id = positiveBigInt(displayId, 'displayId');
  const staticSlot = state.staticStore.index.get(id);
  if (staticSlot !== -1) {
    state.staticStore.readWorldPose(staticSlot, out);
    return true;
  }
  let slot = borrowedNodeSlot(view, id);
  if (slot === -1) return false;
  const chain = [];
  let based = false;
  while (slot !== -1) {
    chain.push(slot);
    const parentId = view.parentDisplayIdAt(slot);
    if (parentId === 0n) {
      setIdentityPose(out);
      based = true;
      break;
    }
    const parentStaticSlot = state.staticStore.index.get(parentId);
    if (parentStaticSlot !== -1) {
      state.staticStore.readWorldPose(parentStaticSlot, out);
      based = true;
      break;
    }
    const parentSlot = borrowedNodeSlot(view, parentId);
    if (parentSlot === -1 || parentSlot >= slot) {
      throw new SceneDisplayEngineError('dangling-parent');
    }
    slot = parentSlot;
  }
  if (!based) throw new SceneDisplayEngineError('dangling-parent');
  const local = {
    localPosition: new Float32Array(3),
    localRotationXyzw: new Float32Array(4),
    localScale: new Float32Array(3),
  };
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    view.readLocalPose(chain[index], local);
    composePoseOutput(out, local);
  }
  return true;
}

function setIdentityPose(out) {
  out.position[0] = 0; out.position[1] = 0; out.position[2] = 0;
  out.rotationXyzw[0] = 0; out.rotationXyzw[1] = 0;
  out.rotationXyzw[2] = 0; out.rotationXyzw[3] = 1;
  out.scale[0] = 1; out.scale[1] = 1; out.scale[2] = 1;
}

function composePoseOutput(parent, local) {
  const px = parent.position[0]; const py = parent.position[1];
  const pz = parent.position[2];
  const qx = parent.rotationXyzw[0]; const qy = parent.rotationXyzw[1];
  const qz = parent.rotationXyzw[2]; const qw = parent.rotationXyzw[3];
  const sx = parent.scale[0]; const sy = parent.scale[1]; const sz = parent.scale[2];
  const lx = sx * local.localPosition[0];
  const ly = sy * local.localPosition[1];
  const lz = sz * local.localPosition[2];
  const tx = 2 * (qy * lz - qz * ly);
  const ty = 2 * (qz * lx - qx * lz);
  const tz = 2 * (qx * ly - qy * lx);
  parent.position[0] = px + lx + qw * tx + (qy * tz - qz * ty);
  parent.position[1] = py + ly + qw * ty + (qz * tx - qx * tz);
  parent.position[2] = pz + lz + qw * tz + (qx * ty - qy * tx);
  const rx = local.localRotationXyzw[0]; const ry = local.localRotationXyzw[1];
  const rz = local.localRotationXyzw[2]; const rw = local.localRotationXyzw[3];
  parent.rotationXyzw[0] = qw * rx + qx * rw + qy * rz - qz * ry;
  parent.rotationXyzw[1] = qw * ry - qx * rz + qy * rw + qz * rx;
  parent.rotationXyzw[2] = qw * rz + qx * ry - qy * rx + qz * rw;
  parent.rotationXyzw[3] = qw * rw - qx * rx - qy * ry - qz * rz;
  parent.scale[0] = sx * local.localScale[0];
  parent.scale[1] = sy * local.localScale[1];
  parent.scale[2] = sz * local.localScale[2];
}

function buildMetadataStore(bootstrap) {
  if (!Number.isInteger(bootstrap.metadataCount) || bootstrap.metadataCount < 0
      || typeof bootstrap.metadataAt !== 'function') {
    throw new SceneDisplayEngineError('scene-metadata-view-invalid');
  }
  const typeIds = new Uint32Array(bootstrap.metadataCount);
  const flags = new Uint32Array(bootstrap.metadataCount);
  const byteRefs = new Array(bootstrap.metadataCount);
  let previous = 0;
  for (let index = 0; index < bootstrap.metadataCount; index += 1) {
    const item = bootstrap.metadataAt(index);
    const typeId = positiveUint32(item.typeId, 'metadataTypeId');
    if (typeId <= previous) throw new SceneDisplayEngineError('scene-metadata-order-invalid');
    typeIds[index] = typeId;
    flags[index] = uint32(item.flags, 'metadataFlags');
    if (flags[index] !== 0) throw new SceneDisplayEngineError('metadata-flags-invalid');
    byteRefs[index] = borrowedBytes(item.bytes);
    if (byteRefs[index].byteLength === 0) {
      throw new SceneDisplayEngineError('metadata-bytes-invalid');
    }
    previous = typeId;
  }
  return Object.freeze({ count: bootstrap.metadataCount, typeIds, flags, byteRefs });
}

function metadataAt(store, index) {
  if (!Number.isInteger(index) || index < 0 || index >= store.count) {
    throw new SceneDisplayEngineError('scene-metadata-index-invalid');
  }
  return Object.freeze({
    typeId: store.typeIds[index],
    flags: store.flags[index],
    bytes: store.byteRefs[index],
  });
}

function metadataByType(store, metadataTypeId) {
  const typeId = positiveUint32(metadataTypeId, 'metadataTypeId');
  let low = 0;
  let high = store.count - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = store.typeIds[middle];
    if (candidate === typeId) return metadataAt(store, middle);
    if (candidate < typeId) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

function nodeById(state, displayId) {
  const located = locateNode(state, positiveBigInt(displayId, 'displayId'));
  return located ? new PresentationNodeSlotView(located.store, located.slot) : null;
}

function writePayload(store, slot, kind, payload) {
  const profile = kind === 'profile';
  const typeIds = profile ? store.profileTypeIds : store.interactionTypeIds;
  const flags = profile ? store.profileFlags : store.interactionFlags;
  const byteRefs = profile ? store.profileBytes : store.interactionBytes;
  if (!payload) {
    typeIds[slot] = 0;
    flags[slot] = 0;
    byteRefs[slot] = null;
    return;
  }
  typeIds[slot] = positiveUint32(payload.typeId, `${kind}TypeId`);
  flags[slot] = uint32(payload.flags, `${kind}Flags`);
  if (flags[slot] !== 0) throw new SceneDisplayEngineError(`${kind}-flags-invalid`);
  byteRefs[slot] = borrowedBytes(payload.bytes);
  if (byteRefs[slot].byteLength === 0) {
    throw new SceneDisplayEngineError(`${kind}-bytes-invalid`);
  }
}

function poseAtEquals(left, leftSlot, right, rightSlot) {
  return tupleAtEquals(left.localPositions, leftSlot * 3, right.localPositions, rightSlot * 3, 3)
    && tupleAtEquals(left.localRotations, leftSlot * 4, right.localRotations, rightSlot * 4, 4)
    && tupleAtEquals(left.localScales, leftSlot * 3, right.localScales, rightSlot * 3, 3);
}

function payloadAtEquals(left, leftSlot, right, rightSlot, kind) {
  const profile = kind === 'profile';
  const leftTypes = profile ? left.profileTypeIds : left.interactionTypeIds;
  const rightTypes = profile ? right.profileTypeIds : right.interactionTypeIds;
  const leftFlags = profile ? left.profileFlags : left.interactionFlags;
  const rightFlags = profile ? right.profileFlags : right.interactionFlags;
  const leftBytes = profile ? left.profileBytes : left.interactionBytes;
  const rightBytes = profile ? right.profileBytes : right.interactionBytes;
  return leftTypes[leftSlot] === rightTypes[rightSlot]
    && leftFlags[leftSlot] === rightFlags[rightSlot]
    && bytesEqual(leftBytes[leftSlot], rightBytes[rightSlot]);
}

function freezePlan(value) {
  const result = { ...value };
  for (const field of ['createIds', 'removeIds', 'reparentIds', 'localPoseDirtyIds',
    'visibilityDirtyIds', 'visualReplaceIds', 'profileStateDirtyIds',
    'animationDirtyIds', 'interactionDirtyIds']) {
    result[field] = Object.freeze([...(value[field] ?? [])]);
  }
  return Object.freeze(result);
}

function validateLocalPose(pose) {
  for (const value of pose.localPosition) finite(value, 'localPosition');
  let norm = 0;
  for (const value of pose.localRotationXyzw) {
    finite(value, 'localRotationXyzw');
    norm += value * value;
  }
  for (const value of pose.localScale) {
    if (finite(value, 'localScale') <= 0) throw new SceneDisplayEngineError('node-scale-invalid');
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) {
    throw new SceneDisplayEngineError('node-quaternion-invalid');
  }
}

function assertBootstrapView(value) {
  if (!value?.header || !value?.identity || !Number.isInteger(value.nodeCount)
      || !Number.isInteger(value.visualTypeCount) || !Number.isInteger(value.animationStateCount)
      || typeof value.displayIdAt !== 'function' || typeof value.visualTypeAt !== 'function'
      || typeof value.animationStateAt !== 'function') {
    throw new SceneDisplayEngineError('bootstrap-view-invalid');
  }
}

function assertNodeView(value) {
  for (const method of ['displayIdAt', 'parentDisplayIdAt', 'visualTypeIdAt', 'flagsAt',
    'animationStateIdAt', 'animationStartTickAt', 'animationFlagsAt', 'readLocalPose',
    'readProfileStateAt', 'readInteractionAt']) {
    if (!value || typeof value[method] !== 'function') {
      throw new SceneDisplayEngineError('frame-view-invalid');
    }
  }
  if (!Number.isInteger(value.nodeCount) || value.nodeCount < 0) {
    throw new SceneDisplayEngineError('frame-view-invalid');
  }
}

function normalizeFrameHeader(header) {
  if (!header) throw new SceneDisplayEngineError('frame-header-invalid');
  return Object.freeze({
    bootstrapId: positiveBigInt(header.bootstrapId, 'bootstrapId'),
    frameSeq: positiveBigInt(header.frameSeq, 'frameSeq'),
    projectionId: positiveBigInt(header.projectionId, 'projectionId'),
    sceneEpoch: positiveBigInt(header.sceneEpoch, 'sceneEpoch'),
    sourceTick: nonnegativeBigInt(header.sourceTick, 'sourceTick'),
  });
}

function validateAggregateCommitCandidate(
  aggregateCandidate,
  engineCommit,
  currentAggregate,
  currentCommit,
) {
  requireOptionsRecord(aggregateCandidate, 'aggregate-candidate-invalid');
  assertExactKeys(
    aggregateCandidate,
    new Set(['codecIdentity', 'revision', 'sourceTick', 'value']),
    'aggregate-candidate-field-unknown',
  );
  const codecIdentity = aggregateCodecIdentity(aggregateCandidate.codecIdentity);
  const sourceTick = nonnegativeSafeInteger(
    aggregateCandidate.sourceTick,
    'aggregate-source-tick-invalid',
  );
  const revision = nonnegativeSafeInteger(
    aggregateCandidate.revision,
    'aggregate-revision-invalid',
  );
  if (aggregateCandidate.value === null || typeof aggregateCandidate.value !== 'object') {
    throw new SceneDisplayEngineError('aggregate-value-invalid');
  }

  requireOptionsRecord(engineCommit, 'engine-commit-identity-invalid');
  assertExactKeys(
    engineCommit,
    new Set([
      'generation_id',
      'commit_seq',
      'source_tick',
      'world_revision',
      'cause',
      'causation_id',
    ]),
    'engine-commit-field-unknown',
  );
  const normalizedCommit = Object.freeze({
    generation_id: positiveSafeInteger(
      engineCommit.generation_id,
      'engine-generation-id-invalid',
    ),
    commit_seq: nonnegativeSafeInteger(
      engineCommit.commit_seq,
      'engine-commit-seq-invalid',
    ),
    source_tick: nonnegativeSafeInteger(
      engineCommit.source_tick,
      'engine-source-tick-invalid',
    ),
    world_revision: nonnegativeSafeInteger(
      engineCommit.world_revision,
      'engine-world-revision-invalid',
    ),
    cause: typeof engineCommit.cause === 'string' && engineCommit.cause.length > 0
      ? engineCommit.cause
      : invalidEngineCommitCause(),
    causation_id: engineCommit.causation_id === null
      ? null
      : nonemptyText(engineCommit.causation_id, 'engine-causation-id-invalid'),
  });
  if (
    normalizedCommit.source_tick !== sourceTick
    || normalizedCommit.world_revision !== revision
  ) {
    throw new SceneDisplayEngineError('engine-aggregate-identity-mismatch');
  }

  if (currentCommit === null) {
    if (
      normalizedCommit.commit_seq !== 0
      || normalizedCommit.cause !== 'checkpoint'
      || normalizedCommit.causation_id !== null
    ) {
      throw new SceneDisplayEngineError('engine-initial-commit-not-checkpoint');
    }
    return Object.freeze({
      aggregate: ownAggregateCandidate(
        codecIdentity,
        sourceTick,
        revision,
        aggregateCandidate.value,
      ),
      advancesCommit: true,
      engineCommit: normalizedCommit,
    });
  }
  if (currentAggregate === null) {
    throw new SceneDisplayEngineError('engine-aggregate-owner-inconsistent');
  }

  const sameIdentity = (
    normalizedCommit.generation_id === currentCommit.generation_id
    && normalizedCommit.commit_seq === currentCommit.commit_seq
  );
  if (sameIdentity) {
    if (
      normalizedCommit.source_tick !== currentCommit.source_tick
      || normalizedCommit.world_revision !== currentCommit.world_revision
      || normalizedCommit.cause !== currentCommit.cause
      || normalizedCommit.causation_id !== currentCommit.causation_id
      || codecIdentity !== currentAggregate.codecIdentity
      || sourceTick !== currentAggregate.sourceTick
      || revision !== currentAggregate.revision
      || aggregateCandidate.value !== currentAggregate.value
    ) {
      throw new SceneDisplayEngineError('engine-commit-identity-reused');
    }
    // One Engine commit can have several compatibility authority publications.
    // They all resolve to the already-installed canonical data pointer.
    return Object.freeze({
      aggregate: currentAggregate,
      advancesCommit: false,
      engineCommit: currentCommit,
    });
  }

  const sequentialInGeneration = (
    normalizedCommit.generation_id === currentCommit.generation_id
    && normalizedCommit.commit_seq === currentCommit.commit_seq + 1
  );
  const nextCheckpointGeneration = (
    normalizedCommit.generation_id === currentCommit.generation_id + 1
    && normalizedCommit.commit_seq === 0
  );
  if (!sequentialInGeneration && !nextCheckpointGeneration) {
    throw new SceneDisplayEngineError('engine-commit-sequence-gap');
  }
  if (sequentialInGeneration && (
    normalizedCommit.source_tick < currentCommit.source_tick
    || normalizedCommit.source_tick > currentCommit.source_tick + 1
    || normalizedCommit.world_revision !== currentCommit.world_revision + 1
  )) {
    throw new SceneDisplayEngineError('engine-commit-state-sequence-invalid');
  }
  if (nextCheckpointGeneration && (
    normalizedCommit.cause !== 'checkpoint'
    || normalizedCommit.causation_id !== null
    || normalizedCommit.source_tick !== currentCommit.source_tick
    || normalizedCommit.world_revision !== currentCommit.world_revision
  )) {
    throw new SceneDisplayEngineError('engine-checkpoint-identity-invalid');
  }
  return Object.freeze({
    aggregate: ownAggregateCandidate(
      codecIdentity,
      sourceTick,
      revision,
      aggregateCandidate.value,
    ),
    advancesCommit: true,
    engineCommit: normalizedCommit,
  });
}

function validateFrameCommitTicks(frames, engineCommit) {
  const expected = BigInt(engineCommit.source_tick);
  for (const frame of frames) {
    if (frame?.header?.sourceTick !== expected) {
      throw new SceneDisplayEngineError('engine-frame-source-tick-mismatch');
    }
  }
}

function validateFrameCommitPolicy(frames, normalized, currentCommit) {
  if (!normalized.advancesCommit) return;
  if (currentCommit === null && frames.length === 0) {
    throw new SceneDisplayEngineError('engine-initial-commit-frame-missing');
  }
  if (
    currentCommit !== null
    && normalized.engineCommit.source_tick > currentCommit.source_tick
    && frames.length === 0
  ) {
    throw new SceneDisplayEngineError('engine-advanced-tick-frame-missing');
  }
  if (
    currentCommit !== null
    && normalized.engineCommit.generation_id !== currentCommit.generation_id
    && frames.length === 0
  ) {
    throw new SceneDisplayEngineError('engine-checkpoint-frame-missing');
  }
}

function aggregateCodecIdentity(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 160
    || !AGGREGATE_CODEC_IDENTITY_PATTERN.test(value)
  ) {
    throw new SceneDisplayEngineError('aggregate-codec-identity-invalid');
  }
  return value;
}

function ownAggregateCandidate(codecIdentity, sourceTick, revision, value) {
  const budget = { values: 0 };
  freezeJsonTree(value, new WeakSet(), budget, 0);
  return Object.freeze({ codecIdentity, revision, sourceTick, value });
}

function invalidEngineCommitCause() {
  throw new SceneDisplayEngineError('engine-commit-cause-invalid');
}

function nonemptyText(value, code) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SceneDisplayEngineError(code);
  }
  return value;
}

function nonnegativeSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SceneDisplayEngineError(code);
  }
  return value;
}

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SceneDisplayEngineError(code);
  }
  return value;
}

function freezeJsonTree(value, active, budget, depth) {
  budget.values += 1;
  if (budget.values > MAXIMUM_AGGREGATE_VALUES) {
    throw new SceneDisplayEngineError('aggregate-value-limit-exceeded');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SceneDisplayEngineError('aggregate-json-invalid');
    return value;
  }
  if (typeof value !== 'object') {
    throw new SceneDisplayEngineError('aggregate-json-invalid');
  }
  if (depth >= MAXIMUM_AGGREGATE_DEPTH) {
    throw new SceneDisplayEngineError('aggregate-depth-limit-exceeded');
  }
  if (active.has(value)) throw new SceneDisplayEngineError('aggregate-cycle');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new SceneDisplayEngineError('aggregate-json-invalid');
      }
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => (
        key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key))
      ))) {
        throw new SceneDisplayEngineError('aggregate-json-invalid');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new SceneDisplayEngineError('aggregate-json-invalid');
        }
        assertJsonDataProperty(value, String(index));
        freezeJsonTree(value[index], active, budget, depth + 1);
      }
    } else {
      requireOptionsRecord(value, 'aggregate-json-invalid');
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') {
          throw new SceneDisplayEngineError('aggregate-json-invalid');
        }
        assertJsonDataProperty(value, key);
        freezeJsonTree(value[key], active, budget, depth + 1);
      }
    }
  } catch (error) {
    if (error instanceof SceneDisplayEngineError) throw error;
    throw new SceneDisplayEngineError('aggregate-json-invalid');
  } finally {
    active.delete(value);
  }
  if (!Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function assertJsonDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new SceneDisplayEngineError('aggregate-json-invalid');
  }
}

function normalizeEngineOptions(value) {
  requireOptionsRecord(value, 'scene-display-engine-options-invalid');
  assertExactKeys(value, new Set(['captureHook', 'limits']), 'scene-display-engine-option-unknown');
  const captureHook = value.captureHook ?? null;
  if (captureHook !== null && typeof captureHook !== 'function') {
    throw new SceneDisplayEngineError('capture-hook-invalid');
  }
  return Object.freeze({
    captureHook,
    limits: value.limits === undefined ? {} : value.limits,
  });
}

function normalizeLimits(changes) {
  requireOptionsRecord(changes, 'scene-tree-limits-invalid');
  assertExactKeys(
    changes,
    new Set(['maximumFramesPerBatch', 'maximumNodes', 'maximumTreeDepth']),
    'scene-tree-limit-unknown',
  );
  const limits = { ...DEFAULT_SCENE_TREE_LIMITS, ...changes };
  for (const [field, value] of Object.entries(limits)) positiveInteger(value, field);
  if (limits.maximumTreeDepth > 0xffff) {
    throw new SceneDisplayEngineError('maximumTreeDepth-invalid');
  }
  return Object.freeze(limits);
}

function requireOptionsRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SceneDisplayEngineError(code);
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch {
    throw new SceneDisplayEngineError(code);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SceneDisplayEngineError(code);
  }
}

function assertExactKeys(value, allowed, code) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new SceneDisplayEngineError(code, `${code}: ${String(key)}`);
    }
  }
}

function validatePoseOut(out) {
  if (!out || !out.position || !out.rotationXyzw || !out.scale) {
    throw new SceneDisplayEngineError('world-pose-output-invalid');
  }
  if (out.position.length < 3 || out.rotationXyzw.length < 4 || out.scale.length < 3) {
    throw new SceneDisplayEngineError('world-pose-output-invalid');
  }
}

function tupleView(values, slot, stride) {
  const offset = slot * stride;
  return values.subarray(offset, offset + stride);
}

function copyInto(target, offset, source, count) {
  for (let index = 0; index < count; index += 1) target[offset + index] = source[index];
}

function copyTuple(source, offset, target, count) {
  for (let index = 0; index < count; index += 1) target[index] = source[offset + index];
}

function tupleAtEquals(left, leftOffset, right, rightOffset, count) {
  for (let index = 0; index < count; index += 1) {
    if (left[leftOffset + index] !== right[rightOffset + index]) return false;
  }
  return true;
}

function bytesEqual(left, right) {
  if (left == null || right == null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function multiplyQuaternionAt(left, leftOffset, right, rightOffset, target, targetOffset) {
  const ax = left[leftOffset]; const ay = left[leftOffset + 1];
  const az = left[leftOffset + 2]; const aw = left[leftOffset + 3];
  const bx = right[rightOffset]; const by = right[rightOffset + 1];
  const bz = right[rightOffset + 2]; const bw = right[rightOffset + 3];
  target[targetOffset] = aw * bx + ax * bw + ay * bz - az * by;
  target[targetOffset + 1] = aw * by - ax * bz + ay * bw + az * bx;
  target[targetOffset + 2] = aw * bz + ax * by - ay * bx + az * bw;
  target[targetOffset + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

function hashId(id, mask) {
  return Number((id ^ (id >> 32n)) & BigInt(mask));
}

function borrowedBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new SceneDisplayEngineError('payload-bytes-invalid');
}

function canonicalText(value, field) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new SceneDisplayEngineError(`${field}-invalid`);
  }
  return value;
}

function finite(value, field) {
  if (!Number.isFinite(value)) throw new SceneDisplayEngineError(`${field}-invalid`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SceneDisplayEngineError(`${field}-invalid`);
  }
  return value;
}

function uint32(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new SceneDisplayEngineError(`${field}-invalid`);
  }
  return value;
}

function positiveUint32(value, field) {
  const result = uint32(value, field);
  if (result === 0) throw new SceneDisplayEngineError(`${field}-invalid`);
  return result;
}

function eventFlags(value) {
  const result = uint32(value, 'eventFlags');
  if (result & ~1) throw new SceneDisplayEngineError('eventFlags-invalid');
  return result;
}

function nonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SceneDisplayEngineError(`${field}-invalid`);
  }
  return value;
}

function positiveBigInt(value, field) {
  const result = nonnegativeBigInt(value, field);
  if (result === 0n) throw new SceneDisplayEngineError(`${field}-invalid`);
  return result;
}

function nonnegativeBigInt(value, field) {
  try {
    const result = BigInt(value);
    if (result < 0n || result > (1n << 64n) - 1n) throw new Error('range');
    return result;
  } catch {
    throw new SceneDisplayEngineError(`${field}-invalid`);
  }
}
