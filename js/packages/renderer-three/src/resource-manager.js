import { fail } from './errors.js';

export class ResourceManager {
  constructor({ registry, load, dispose, onFailure }) {
    this.registry = registry;
    this.load = load;
    this.disposeAsset = dispose;
    this.onFailure = onFailure;
    this.entries = new Map();
    this.pending = new Set();
    this.closed = false;
  }

  acquire(resourceId, signal = null) {
    if (this.closed) fail('three-resource-manager-disposed');
    const resource = this.registry.require(resourceId);
    const descriptor = resource?.describe?.();
    if (!descriptor || typeof descriptor !== 'object') fail('three-resource-descriptor-invalid');
    let entry = this.entries.get(resourceId);
    if (entry?.status === 'failed') {
      entry.retired = true;
      if (this.entries.get(resourceId) === entry) this.entries.delete(resourceId);
      entry = null;
    }
    if (!entry) {
      entry = this._createEntry(resourceId, descriptor);
      this.entries.set(resourceId, entry);
    }
    entry.references += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener?.('abort', release);
      this._releaseEntry(entry);
    };
    signal?.addEventListener?.('abort', release, { once: true });
    if (signal?.aborted) release();
    return Object.freeze({
      resourceId,
      descriptor,
      get value() { return entry.status === 'ready' ? entry.asset : null; },
      ready: entry.promise,
      release,
    });
  }

  async whenIdle() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  diagnostics() {
    let leaseCount = 0;
    let readyCount = 0;
    for (const entry of this.entries.values()) {
      leaseCount += entry.references;
      if (entry.status === 'ready') readyCount += 1;
    }
    return Object.freeze({
      resourceCount: this.entries.size,
      readyResourceCount: readyCount,
      resourceLeaseCount: leaseCount,
      pendingResourceCount: this.pending.size,
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.resourceId);
      entry.retired = true;
      entry.references = 0;
      entry.abortController.abort('backend-disposed');
      this._disposeReadyEntry(entry);
    }
  }

  _createEntry(resourceId, descriptor) {
    const entry = {
      resourceId,
      descriptor,
      abortController: new AbortController(),
      asset: null,
      dependencies: [],
      dependenciesReleased: false,
      disposed: false,
      references: 0,
      retired: false,
      status: 'loading',
      promise: null,
    };
    try {
      for (const identity of dependencyIds(descriptor)) {
        entry.dependencies.push(this.acquire(identity, entry.abortController.signal));
      }
    } catch (error) {
      entry.status = 'failed';
      this._releaseDependencies(entry);
      tagResource(error, resourceId);
      entry.promise = Promise.reject(error);
      entry.promise.catch(() => {});
      return entry;
    }
    const operation = Promise.all(entry.dependencies.map((lease) => lease.ready))
      .then((dependencies) => this.load(descriptor, entry.abortController.signal, dependencies))
      .then((asset) => {
        if (!asset || typeof asset !== 'object') fail('three-resource-loader-result-invalid');
        entry.asset = asset;
        entry.status = 'ready';
        if (entry.retired || this.closed || entry.references === 0) this._disposeReadyEntry(entry);
        return asset;
      })
      .catch((error) => {
        entry.status = 'failed';
        this._releaseDependencies(entry);
        tagResource(error, resourceId);
        if (!entry.retired && !this.closed && entry.references > 0
            && !entry.abortController.signal.aborted) this.onFailure(resourceId, error);
        throw error;
      });
    let tracked;
    tracked = operation.finally(() => this.pending.delete(tracked));
    tracked.catch(() => {});
    this.pending.add(tracked);
    entry.promise = tracked;
    return entry;
  }

  _releaseEntry(entry) {
    if (entry.references > 0) entry.references -= 1;
    if (entry.references !== 0 || entry.retired) return;
    entry.retired = true;
    if (this.entries.get(entry.resourceId) === entry) this.entries.delete(entry.resourceId);
    entry.abortController.abort('resource-unreferenced');
    this._disposeReadyEntry(entry);
  }

  _disposeReadyEntry(entry) {
    if (!entry.disposed && entry.asset) {
      entry.disposed = true;
      try { this.disposeAsset(entry.asset); } catch (error) {
        if (!this.closed) this.onFailure(entry.resourceId, error);
      }
    }
    this._releaseDependencies(entry);
  }

  _releaseDependencies(entry) {
    if (entry.dependenciesReleased) return;
    entry.dependenciesReleased = true;
    for (const lease of entry.dependencies) lease.release();
    entry.dependencies.length = 0;
  }
}

function tagResource(error, resourceId) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')
      || Object.hasOwn(error, 'resourceId')) return;
  try { Object.defineProperty(error, 'resourceId', { value: resourceId, enumerable: true }); }
  catch { /* frozen third-party errors still have the ResourceManager health event */ }
}

function dependencyIds(descriptor) {
  switch (descriptor.kind) {
    case 'texture-atlas': return descriptor.textureResourceId ? [descriptor.textureResourceId] : [];
    case 'material': return descriptor.textureResourceIds ?? [];
    case 'surface': return descriptor.textureResourceIds ?? [];
    case 'particle': return descriptor.textureResourceId ? [descriptor.textureResourceId] : [];
    default: return [];
  }
}
