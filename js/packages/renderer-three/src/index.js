export class ThreePresentationBackendError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ThreePresentationBackendError';
  }
}

export class ThreePresentationBackend {
  constructor({ root, resolveFactory, onEvents = null, onHealth = null } = {}) {
    if (!root || typeof root.add !== 'function' || typeof root.remove !== 'function') {
      throw new ThreePresentationBackendError('Three root Object3D port is invalid');
    }
    if (typeof resolveFactory !== 'function') {
      throw new ThreePresentationBackendError('resolveFactory port is required');
    }
    if (onEvents != null && typeof onEvents !== 'function') {
      throw new ThreePresentationBackendError('onEvents port must be a function');
    }
    this.root = root;
    this.resolveFactory = resolveFactory;
    this.onHealth = onHealth;
    this.onEvents = onEvents;
    this.records = new Map();
    this.disposedHandles = new WeakSet();
    this.closed = false;
  }

  async prepare(plan, context) {
    this.requireOpen();
    const desired = new Map(plan.finalEntities);
    const preparedCreates = [];
    const preparedUpdates = [];
    const removals = [];
    try {
      for (const [displayId, record] of this.records) {
        if (!desired.has(displayId)) removals.push(record);
      }
      for (const [displayId, entity] of desired) {
        const current = this.records.get(displayId);
        const factory = this.resolveFactory(entity.visualTypeId, entity.ownerTypeId);
        if (!factory || typeof factory.prepareCreate !== 'function') {
          throw new ThreePresentationBackendError(
            `Presentation visual ${entity.visualTypeId} has no activated factory`,
          );
        }
        if (!current || current.visualTypeId !== entity.visualTypeId) {
          if (current) removals.push(current);
          const createResult = factory.prepareCreate(entity, Object.freeze({
            ...context,
            current: null,
          }));
          const prepared = createResult?.then ? await createResult : createResult;
          preparedCreates.push(normalizePreparedCreate({
            displayId,
            entity,
            factory,
            prepared,
          }));
        } else if (typeof factory.prepareUpdate === 'function') {
          const updateResult = factory.prepareUpdate(current.handle, entity, Object.freeze({
            ...context,
            current: current.handle,
          }));
          const prepared = updateResult?.then ? await updateResult : updateResult;
          preparedUpdates.push(normalizePreparedUpdate({ current, entity, prepared }));
        } else {
          preparedUpdates.push(defaultPreparedPoseUpdate(current, entity));
        }
      }
    } catch (error) {
      await abortAll(preparedCreates, preparedUpdates);
      throw error;
    }
    let settled = false;
    return Object.freeze({
      abort: async () => {
        if (settled) return;
        settled = true;
        await abortAll(preparedCreates, preparedUpdates);
      },
      commitNoThrow: () => {
        if (settled) return;
        settled = true;
        for (const record of uniqueRecords(removals)) this.removeRecordNoThrow(record, context);
        for (const prepared of preparedCreates) {
          const { displayId, entity, factory, handle, object3d } = prepared;
          applyAbsolutePose(object3d, entity);
          object3d.visible = Boolean(entity.flags & 1);
          this.root.add(object3d);
          prepared.commitNoThrow();
          const record = { displayId, entity, factory, handle, object3d, visualTypeId: entity.visualTypeId };
          this.records.set(displayId, record);
          trackPending(prepared.pending, record, context, this);
        }
        for (const prepared of preparedUpdates) {
          prepared.commitNoThrow();
          prepared.current.entity = prepared.entity;
          applyAbsolutePose(prepared.current.object3d, prepared.entity);
          prepared.current.object3d.visible = Boolean(prepared.entity.flags & 1);
          trackPending(prepared.pending, prepared.current, context, this);
        }
        for (const step of plan.frameSteps) {
          if (!step.events?.length) continue;
          try {
            this.onEvents?.(step.events, Object.freeze({
              frameSeq: step.frameSeq,
              sourceTick: step.sourceTick,
            }));
          } catch (error) {
            this.report(error);
          }
        }
      },
    });
  }

  async prepareReset(context) {
    this.requireOpen();
    const records = [...this.records.values()];
    return Object.freeze({
      async abort() {},
      commitNoThrow: () => {
        for (const record of records) this.removeRecordNoThrow(record, context);
      },
    });
  }

  removeRecordNoThrow(record, context) {
    if (this.records.get(record.displayId) !== record) return;
    this.records.delete(record.displayId);
    try { this.root.remove(record.object3d); } catch (error) { this.report(error); }
    try { record.handle?.abort?.('entity-removed'); } catch (error) { this.report(error); }
    const cleanup = Promise.resolve().then(() => this.disposeHandleOnce(record.handle));
    try { context?.trackJob?.(cleanup); } catch (error) { this.report(error); }
  }

  disposeHandleOnce(handle) {
    if (!handle || (typeof handle === 'object' && this.disposedHandles.has(handle))) return;
    if (typeof handle === 'object') this.disposedHandles.add(handle);
    try { handle.dispose?.(); } catch (error) { this.report(error); }
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.records.values()]) {
      this.records.delete(record.displayId);
      try { this.root.remove(record.object3d); } catch (error) { this.report(error); }
      this.disposeHandleOnce(record.handle);
    }
  }

  report(error) {
    try { this.onHealth?.(error); } catch { /* health observers cannot break cleanup */ }
  }

  requireOpen() {
    if (this.closed) throw new ThreePresentationBackendError('Three backend is disposed');
  }
}

function normalizePreparedCreate({ displayId, entity, factory, prepared }) {
  const handle = prepared?.handle ?? prepared;
  const object3d = prepared?.object3d ?? handle?.object3d ?? handle?.group_or_object;
  if (!handle || !object3d || typeof object3d !== 'object') {
    throw new ThreePresentationBackendError('factory prepareCreate must return a detached Object3D handle');
  }
  return {
    abort: typeof prepared.abort === 'function' ? () => prepared.abort() : async () => handle.dispose?.(),
    commitNoThrow: typeof prepared.commitNoThrow === 'function'
      ? () => prepared.commitNoThrow()
      : () => {},
    displayId,
    entity,
    factory,
    handle,
    object3d,
    pending: prepared.pending ?? null,
  };
}

function normalizePreparedUpdate({ current, entity, prepared }) {
  if (!prepared || typeof prepared.commitNoThrow !== 'function') {
    throw new ThreePresentationBackendError('factory prepareUpdate must return commitNoThrow');
  }
  return {
    abort: typeof prepared.abort === 'function' ? () => prepared.abort() : async () => {},
    commitNoThrow: () => prepared.commitNoThrow(),
    current,
    entity,
    pending: prepared.pending ?? null,
  };
}

function defaultPreparedPoseUpdate(current, entity) {
  return {
    async abort() {},
    commitNoThrow() {},
    current,
    entity,
    pending: null,
  };
}

function applyAbsolutePose(object3d, entity) {
  setTuple(object3d.position, entity.position, 3, 'position');
  setTuple(object3d.quaternion, entity.rotationXyzw, 4, 'quaternion');
  setTuple(object3d.scale, entity.scale, 3, 'scale');
  object3d.updateMatrix?.();
  object3d.updateMatrixWorld?.(true);
}

function setTuple(target, values, count, label) {
  if (!target || typeof target.set !== 'function' || values.length !== count) {
    throw new ThreePresentationBackendError(`Object3D ${label} port is invalid`);
  }
  target.set(...values);
}

async function abortAll(...groups) {
  await Promise.allSettled(groups.flat().map((prepared) => prepared.abort?.()));
}

function uniqueRecords(values) {
  return [...new Set(values)];
}

function trackPending(pending, record, context, backend) {
  if (!pending || typeof pending.then !== 'function') return;
  const generation = context.generation;
  const tracked = Promise.resolve(pending).then((replacement) => {
    if (!replacement) return;
    if (context.isGenerationActive?.(generation) === false
        || backend.records.get(record.displayId) !== record) {
      backend.disposeHandleOnce(replacement);
      return;
    }
    const nextObject = replacement.object3d ?? replacement.group_or_object;
    if (!nextObject) throw new ThreePresentationBackendError('async resource replacement lacks Object3D');
    applyAbsolutePose(nextObject, record.entity);
    nextObject.visible = Boolean(record.entity.flags & 1);
    backend.root.remove(record.object3d);
    backend.root.add(nextObject);
    backend.disposeHandleOnce(record.handle);
    record.handle = replacement;
    record.object3d = nextObject;
  }).catch((error) => backend.report(error));
  context.trackJob(tracked);
}
