import { fail } from './errors.js';

export class ResourceManager {
  constructor({ adapter, catalog, onFailure }) {
    this.adapter = adapter;
    this.catalog = catalog;
    this.onFailure = onFailure;
    this.entries = new Map();
    this.pending = new Set();
    this.closed = false;
  }

  acquire(resourceId, signal) {
    if (this.closed) fail('render-resource-manager-disposed');
    const descriptor = this.catalog.resources[resourceId];
    if (!descriptor) fail('render-resource-unknown');
    let entry = this.entries.get(resourceId);
    if (entry?.status === 'failed') {
      entry.retired = true;
      entry = null;
    }
    if (!entry) {
      entry = this.#createEntry(resourceId, descriptor);
      this.entries.set(resourceId, entry);
    }
    entry.references += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener?.('abort', release);
      this.#releaseEntry(entry);
    };
    signal?.addEventListener?.('abort', release, { once: true });
    if (signal?.aborted) release();
    return Object.freeze({
      get value() { return entry.status === 'ready' ? entry.asset : null; },
      ready: entry.promise,
      release,
    });
  }

  async whenIdle() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  capture() {
    return Object.freeze({
      pendingJobCount: this.pending.size,
      resourceCount: this.entries.size,
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.resourceId);
      entry.retired = true;
      entry.references = 0;
      entry.abortController.abort('renderer-disposed');
      this.#disposeReadyEntry(entry);
    }
  }

  #createEntry(resourceId, descriptor) {
    const entry = {
      abortController: new AbortController(),
      asset: null,
      dependencies: [],
      dependenciesReleased: false,
      descriptor,
      disposed: false,
      promise: null,
      references: 0,
      resourceId,
      retired: false,
      status: 'loading',
    };
    const dependencyIds = descriptor.kind === 'surface'
      ? (descriptor.textureResourceIds ?? [])
      : (descriptor.kind === 'particle' && descriptor.textureResourceId
        ? [descriptor.textureResourceId]
        : []);
    entry.dependencies = dependencyIds.map(
      (identity) => this.acquire(identity, entry.abortController.signal),
    );
    const operation = Promise.all(entry.dependencies.map((lease) => lease.ready))
      .then((dependencies) => this.adapter.createResource(
        descriptor,
        entry.abortController.signal,
        dependencies,
      ))
      .then((asset) => {
        if (!asset || typeof asset !== 'object') throw new Error('Resource loader returned no asset.');
        entry.asset = asset;
        entry.status = 'ready';
        if (entry.retired || this.closed || entry.references === 0) {
          this.#disposeReadyEntry(entry);
        }
        return asset;
      })
      .catch((error) => {
        entry.status = 'failed';
        this.#releaseDependencies(entry);
        if (!entry.retired && !this.closed && entry.references > 0
            && !entry.abortController.signal.aborted) {
          this.onFailure(resourceId, error);
        }
        throw error;
      });
    const tracked = operation.finally(() => this.pending.delete(tracked));
    // Consumers always receive and observe the rejection through `ready`.
    tracked.catch(() => {});
    this.pending.add(tracked);
    entry.promise = tracked;
    return entry;
  }

  #releaseEntry(entry) {
    if (entry.references > 0) entry.references -= 1;
    if (entry.references !== 0 || entry.retired) return;
    entry.retired = true;
    if (this.entries.get(entry.resourceId) === entry) this.entries.delete(entry.resourceId);
    entry.abortController.abort('resource-unreferenced');
    this.#disposeReadyEntry(entry);
  }

  #disposeReadyEntry(entry) {
    if (!entry.disposed && entry.asset) {
      entry.disposed = true;
      try { this.adapter.disposeResource(entry.asset); } catch (error) {
        if (!this.closed) this.onFailure(entry.resourceId, error);
      }
    }
    this.#releaseDependencies(entry);
  }

  #releaseDependencies(entry) {
    if (entry.dependenciesReleased) return;
    entry.dependenciesReleased = true;
    for (const lease of entry.dependencies) lease.release();
    entry.dependencies.length = 0;
  }
}
