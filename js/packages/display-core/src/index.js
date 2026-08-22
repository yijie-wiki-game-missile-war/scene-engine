export class SceneDisplayEngineError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SceneDisplayEngineError';
    this.code = code;
  }
}

export const DEFAULT_DISPLAY_CORE_LIMITS = Object.freeze({
  maximumEntities: 10_000,
  maximumFramesPerCommit: 256,
  maximumPendingJobs: 10_000,
});

export class SceneDisplayEngineCore {
  constructor({
    renderer,
    limits = {},
    captureHook = null,
    allowCheckpointCorrelationStart = false,
  } = {}) {
    if (!renderer || typeof renderer.prepare !== 'function') {
      throw new SceneDisplayEngineError('renderer-port-invalid');
    }
    if (captureHook != null && typeof captureHook !== 'function') {
      throw new SceneDisplayEngineError('capture-hook-invalid');
    }
    if (typeof allowCheckpointCorrelationStart !== 'boolean') {
      throw new SceneDisplayEngineError('checkpoint-correlation-policy-invalid');
    }
    this.renderer = renderer;
    this.limits = normalizeLimits(limits);
    this.captureHook = captureHook;
    this.allowCheckpointCorrelationStart = allowCheckpointCorrelationStart;
    this.bootstrap = null;
    this.entities = new Map();
    this.retired = new Set();
    this.generation = 0;
    this.lastFrameSeq = null;
    this.lastSourceTick = null;
    this.lastCorrelationSeq = 0n;
    this.pendingJobs = new Set();
    this.disposed = false;
    this.fatal = null;
    this.metrics = {
      committedFrames: 0,
      committedTransactions: 0,
      prepareFailures: 0,
      rendererCommitFailures: 0,
      resets: 0,
    };
  }

  installBootstrap({ bootstrap, identity, staticInstaller = null } = {}) {
    this.requireHealthy();
    if (this.bootstrap) throw new SceneDisplayEngineError('bootstrap-already-installed');
    if (!bootstrap || !identity) throw new SceneDisplayEngineError('bootstrap-invalid');
    const normalizedIdentity = normalizeIdentity(identity);
    if (staticInstaller != null && typeof staticInstaller.install !== 'function') {
      throw new SceneDisplayEngineError('static-installer-invalid');
    }
    const staticInstallation = staticInstaller?.install(
      bootstrap,
      Object.freeze({
        generation: this.generation + 1,
        identity: normalizedIdentity,
      }),
    ) ?? null;
    if (staticInstallation?.then) {
      throw new SceneDisplayEngineError('static-installer-must-be-synchronous');
    }
    const visualOwnerTypes = new Map(
      (bootstrap.visualRegistry ?? []).map((visual) => [
        Number(visual.visualTypeId),
        Number(visual.ownerTypeId),
      ]),
    );
    this.bootstrap = Object.freeze({
      bootstrap,
      identity: normalizedIdentity,
      staticInstaller,
      visualOwnerTypes,
    });
    this.generation += 1;
    return this.bootstrap;
  }

  async prepareCommit({ frames, correlationSeq, businessPrepared = null } = {}) {
    this.requireReady();
    if (!Array.isArray(frames)
        || frames.length > this.limits.maximumFramesPerCommit) {
      throw new SceneDisplayEngineError('frame-batch-invalid');
    }
    const sequence = positiveBigInt(correlationSeq, 'correlationSeq');
    const checkpointStart = (
      this.allowCheckpointCorrelationStart
      && this.metrics.committedTransactions === 0
      && this.lastCorrelationSeq === 0n
    );
    if (!checkpointStart && sequence !== this.lastCorrelationSeq + 1n) {
      throw new SceneDisplayEngineError('correlation-sequence-gap');
    }
    if (businessPrepared != null
        && typeof businessPrepared.commitNoThrow !== 'function') {
      throw new SceneDisplayEngineError('business-commit-port-invalid');
    }
    const candidate = this.buildCandidate(frames);
    const plan = Object.freeze({
      correlationSeq: sequence,
      frameSteps: Object.freeze(candidate.steps),
      generation: this.generation,
      finalEntities: readonlyMap(candidate.entities),
      retiredDisplayIds: Object.freeze([...candidate.retired]),
      sourceTick: candidate.lastSourceTick,
    });
    let rendererPrepared;
    try {
      rendererPrepared = await this.renderer.prepare(plan, Object.freeze({
        bootstrap: this.bootstrap.bootstrap,
        generation: this.generation,
        identity: this.bootstrap.identity,
        isGenerationActive: (generation) => (
          !this.disposed && !this.fatal && this.generation === generation
        ),
        trackJob: (job) => this.trackJob(job),
      }));
    } catch (error) {
      this.metrics.prepareFailures += 1;
      throw new SceneDisplayEngineError(
        'renderer-prepare-failed',
        error?.message ?? 'renderer prepare failed',
      );
    }
    if (!rendererPrepared || typeof rendererPrepared.commitNoThrow !== 'function'
        || typeof rendererPrepared.abort !== 'function') {
      await rendererPrepared?.abort?.();
      throw new SceneDisplayEngineError('renderer-prepared-commit-invalid');
    }
    let settled = false;
    const expectedGeneration = this.generation;
    return Object.freeze({
      abort: async () => {
        if (settled) return;
        settled = true;
        await rendererPrepared.abort();
      },
      commitNoThrow: () => {
        if (settled) return false;
        if (this.disposed || this.generation !== expectedGeneration || this.fatal) {
          settled = true;
          void rendererPrepared.abort();
          return false;
        }
        settled = true;
        try {
          businessPrepared?.commitNoThrow();
          this.entities = candidate.entities;
          this.retired = candidate.retired;
          this.lastFrameSeq = candidate.lastFrameSeq;
          this.lastSourceTick = candidate.lastSourceTick;
          this.lastCorrelationSeq = sequence;
          rendererPrepared.commitNoThrow();
        } catch (error) {
          this.metrics.rendererCommitFailures += 1;
          this.fatal = error instanceof Error ? error : new Error(String(error));
          return false;
        }
        this.metrics.committedFrames += frames.length;
        this.metrics.committedTransactions += 1;
        this.captureHook?.(this.capture());
        return true;
      },
      plan,
    });
  }

  buildCandidate(frames) {
    let entities = new Map(this.entities);
    const retired = new Set(this.retired);
    let previousFrameSeq = this.lastFrameSeq;
    let previousTick = this.lastSourceTick;
    const steps = [];
    for (const frame of frames) {
      const header = normalizeFrameHeader(frame?.header);
      if (header.sceneEpoch !== this.bootstrap.identity.sceneEpoch
          || header.bootstrapId !== this.bootstrap.identity.bootstrapId) {
        throw new SceneDisplayEngineError('frame-bootstrap-identity-mismatch');
      }
      if (previousFrameSeq != null && header.frameSeq !== previousFrameSeq + 1n) {
        throw new SceneDisplayEngineError('frame-sequence-gap');
      }
      if (previousTick != null && header.sourceTick !== previousTick
          && header.sourceTick !== previousTick + 1n) {
        throw new SceneDisplayEngineError('frame-source-tick-gap');
      }
      if (!Array.isArray(frame.entities) || frame.entities.length > this.limits.maximumEntities) {
        throw new SceneDisplayEngineError('frame-entity-count-invalid');
      }
      const next = new Map();
      let previousId = 0n;
      const creates = [];
      const updates = [];
      for (let index = 0; index < frame.entities.length; index += 1) {
        const rawEntity = frame.entities[index];
        const entity = normalizeEntity(
          rawEntity,
          frame.ownerStates?.[index],
          header,
          this.bootstrap.visualOwnerTypes.get(Number(rawEntity?.visualTypeId)),
        );
        const displayId = entity.displayId;
        if (displayId <= previousId) {
          throw new SceneDisplayEngineError('frame-display-id-order-invalid');
        }
        if (retired.has(displayId) && !entities.has(displayId)) {
          throw new SceneDisplayEngineError('display-id-reused');
        }
        next.set(displayId, entity);
        if (entities.has(displayId)) updates.push(entity);
        else creates.push(entity);
        previousId = displayId;
      }
      const removes = [];
      for (const displayId of entities.keys()) {
        if (!next.has(displayId)) {
          removes.push(displayId);
          retired.add(displayId);
        }
      }
      steps.push(Object.freeze({
        creates: Object.freeze(creates),
        events: Object.freeze([...(frame.events ?? [])]),
        frameSeq: header.frameSeq,
        removes: Object.freeze(removes),
        sourceTick: header.sourceTick,
        updates: Object.freeze(updates),
      }));
      entities = next;
      previousFrameSeq = header.frameSeq;
      previousTick = header.sourceTick;
    }
    return {
      entities,
      retired,
      steps,
      lastFrameSeq: previousFrameSeq,
      lastSourceTick: previousTick,
    };
  }

  async reset({ bootstrap, identity, staticInstaller = null } = {}) {
    this.requireHealthy();
    const nextIdentity = normalizeIdentity(identity);
    const nextGeneration = this.generation + 1;
    const prepared = typeof this.renderer.prepareReset === 'function'
      ? await this.renderer.prepareReset(Object.freeze({
        bootstrap,
        generation: nextGeneration,
        identity: nextIdentity,
        staticInstaller,
      }))
      : null;
    if (prepared && (typeof prepared.commitNoThrow !== 'function'
        || typeof prepared.abort !== 'function')) {
      await prepared?.abort?.();
      throw new SceneDisplayEngineError('renderer-reset-commit-invalid');
    }
    this.generation = nextGeneration;
    this.bootstrap = Object.freeze({
      bootstrap,
      identity: nextIdentity,
      staticInstaller,
      visualOwnerTypes: new Map(
        (bootstrap.visualRegistry ?? []).map((visual) => [
          Number(visual.visualTypeId),
          Number(visual.ownerTypeId),
        ]),
      ),
    });
    this.entities = new Map();
    this.retired = new Set();
    this.lastFrameSeq = null;
    this.lastSourceTick = null;
    this.lastCorrelationSeq = 0n;
    prepared?.commitNoThrow();
    this.metrics.resets += 1;
  }

  sampleAnimation({ animationStartTick, durationTicks, flags = 0, sourceTick }) {
    return samplePresentationAnimation({
      animationStartTick,
      durationTicks,
      flags,
      sourceTick,
    });
  }

  trackJob(job) {
    this.requireHealthy();
    if (!job || typeof job.then !== 'function') {
      throw new SceneDisplayEngineError('async-job-invalid');
    }
    if (this.pendingJobs.size >= this.limits.maximumPendingJobs) {
      throw new SceneDisplayEngineError('async-job-overflow');
    }
    const tracked = Promise.resolve(job).finally(() => this.pendingJobs.delete(tracked));
    this.pendingJobs.add(tracked);
    return tracked;
  }

  async whenIdle() {
    while (this.pendingJobs.size > 0) {
      await Promise.allSettled([...this.pendingJobs]);
    }
  }

  capture() {
    return Object.freeze({
      entityCount: this.entities.size,
      generation: this.generation,
      identity: this.bootstrap?.identity ?? null,
      lastCorrelationSeq: this.lastCorrelationSeq,
      lastFrameSeq: this.lastFrameSeq,
      lastSourceTick: this.lastSourceTick,
      metrics: Object.freeze({ ...this.metrics }),
      retiredCount: this.retired.size,
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    await this.renderer.dispose?.();
    await this.whenIdle();
    this.entities.clear();
    this.retired.clear();
  }

  requireReady() {
    this.requireHealthy();
    if (!this.bootstrap) throw new SceneDisplayEngineError('bootstrap-missing');
  }

  requireHealthy() {
    if (this.disposed) throw new SceneDisplayEngineError('display-core-disposed');
    if (this.fatal) throw new SceneDisplayEngineError('display-core-fatal', this.fatal.message);
  }
}

export function samplePresentationAnimation({
  animationStartTick,
  durationTicks,
  flags = 0,
  sourceTick,
} = {}) {
  const start = nonnegativeBigInt(animationStartTick, 'animationStartTick');
  const source = nonnegativeBigInt(sourceTick, 'sourceTick');
  const duration = positiveBigInt(durationTicks, 'durationTicks');
  if (source < start) throw new SceneDisplayEngineError('animation-before-start');
  const elapsed = source - start;
  const looping = Boolean(flags & 1);
  const sampled = looping
    ? elapsed % duration
    : (elapsed > duration ? duration : elapsed);
  return Object.freeze({
    elapsedSeconds: Number(elapsed) / 60,
    elapsedTicks: elapsed,
    phase: Number(sampled) / Number(duration),
    sourceTick: source,
  });
}

function normalizeFrameHeader(header) {
  if (!header) throw new SceneDisplayEngineError('frame-header-invalid');
  return Object.freeze({
    bootstrapId: positiveBigInt(header.bootstrapId, 'bootstrapId'),
    frameSeq: positiveBigInt(header.frameSeq, 'frameSeq'),
    sceneEpoch: positiveBigInt(header.sceneEpoch, 'sceneEpoch'),
    sourceTick: nonnegativeBigInt(header.sourceTick, 'sourceTick'),
  });
}

function normalizeEntity(value, ownerState, header, registryOwnerTypeId) {
  if (!value) throw new SceneDisplayEngineError('frame-entity-invalid');
  return Object.freeze({
    animationFlags: Number(value.animationFlags ?? 0),
    animationStartTick: nonnegativeBigInt(value.animationStartTick ?? 0, 'animationStartTick'),
    animationStateId: Number(value.animationStateId ?? 0),
    displayId: positiveBigInt(value.displayId, 'displayId'),
    flags: Number(value.flags ?? 0),
    ownerState: ownerState ?? null,
    ownerTypeId: Number(
      registryOwnerTypeId ?? value.ownerTypeId ?? ownerState?.ownerTypeId ?? 0,
    ),
    position: tuple(value.position, 3, 'position'),
    projectionId: positiveBigInt(value.projectionId ?? header.frameSeq, 'projectionId'),
    rotationXyzw: tuple(value.rotationXyzw, 4, 'rotationXyzw'),
    scale: tuple(value.scale, 3, 'scale'),
    sourceTick: header.sourceTick,
    visualTypeId: Number(value.visualTypeId),
  });
}

function tuple(value, length, field) {
  if (!value || value.length !== length) throw new SceneDisplayEngineError(`${field}-invalid`);
  const result = Array.from(value, Number);
  if (!result.every(Number.isFinite)) throw new SceneDisplayEngineError(`${field}-invalid`);
  return Object.freeze(result);
}

function normalizeIdentity(value) {
  return Object.freeze({
    bootstrapId: positiveBigInt(value.bootstrapId, 'bootstrapId'),
    profileId: canonicalText(value.profileId, 'profileId'),
    sceneEpoch: positiveBigInt(value.sceneEpoch, 'sceneEpoch'),
    viewerScope: canonicalText(value.viewerScope, 'viewerScope'),
  });
}

function normalizeLimits(changes) {
  const limits = { ...DEFAULT_DISPLAY_CORE_LIMITS, ...changes };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SceneDisplayEngineError(`${field}-invalid`);
    }
  }
  return Object.freeze(limits);
}

function readonlyMap(source) {
  const copy = new Map(source);
  return Object.freeze({
    get size() { return copy.size; },
    get: (key) => copy.get(key),
    has: (key) => copy.has(key),
    entries: () => copy.entries(),
    keys: () => copy.keys(),
    values: () => copy.values(),
    [Symbol.iterator]: () => copy[Symbol.iterator](),
  });
}

function canonicalText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
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
    if (result < 0n) throw new Error('negative');
    return result;
  } catch {
    throw new SceneDisplayEngineError(`${field}-invalid`);
  }
}
