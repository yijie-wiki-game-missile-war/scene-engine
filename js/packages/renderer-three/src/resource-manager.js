import { fail } from './errors.js';
import { GENERATED_TEXTURE_LIMITS } from '@scene-engine/display';

export class ResourceManager {
  constructor({ registry, load, dispose, onFailure, generatedTextureSource = null, renderer = null }) {
    this.registry = registry;
    this.load = load;
    this.disposeAsset = dispose;
    this.onFailure = onFailure;
    this.loadContext = { generatedTextureSource, renderer };
    this.generatedUploadedBytes = 0;
    this.generatedUploadCursor = 0;
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
      this._releaseEntry(entry, signal?.reason);
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

  prepareGeneratedTextures() {
    let remaining = GENERATED_TEXTURE_LIMITS.maximumUploadBytesPerFrame, pending = false;
    const entries = [...this.entries.values()].filter(entry => entry.asset?.prepareGeneratedTexture);
    const start = this.generatedUploadCursor % Math.max(1, entries.length);
    this.generatedUploadCursor = start + 1;
    // First uploads unblock drawing. Rotate ties each frame so a frequently
    // updated texture cannot consume the budget ahead of the same peers forever.
    const ordered = [...entries.slice(start), ...entries.slice(0, start)]
      .sort((a, b) => Number(a.asset.generatedInitialized) - Number(b.asset.generatedInitialized));
    for (const entry of ordered) {
      if (entry.generatedFailure) throw entry.generatedFailure;
      let result;
      try { result = entry.asset.prepareGeneratedTexture(remaining); }
      catch (error) {
        entry.generatedFailure = error;
        this.loadContext.generatedTextureSource?.failed(entry.resourceId, error.code ?? 'three-generated-texture-upload-failed');
        this.onFailure(entry.resourceId, error); throw error;
      }
      remaining -= result.uploadedBytes; pending ||= result.pending;
    }
    this.generatedUploadedBytes += GENERATED_TEXTURE_LIMITS.maximumUploadBytesPerFrame - remaining;
    return pending;
  }

  hasUninitializedGeneratedTextures() {
    for (const entry of this.entries.values()) if (entry.generatedFailure) throw entry.generatedFailure;
    return [...this.entries.values()].some(entry => entry.asset?.generatedInitialized === false);
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
      generatedUploadedBytes: this.generatedUploadedBytes,
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
      .then((dependencies) => this.load(descriptor, entry.abortController.signal, dependencies, this.loadContext))
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
            && !entry.abortController.signal.aborted) {
          this.loadContext.generatedTextureSource?.failed(resourceId, error.code ?? 'three-resource-load-failed');
          this.onFailure(resourceId, error);
        }
        throw error;
      });
    let tracked;
    tracked = operation.finally(() => this.pending.delete(tracked));
    tracked.catch(() => {});
    this.pending.add(tracked);
    entry.promise = tracked;
    return entry;
  }

  _releaseEntry(entry, reason = null) {
    if (entry.references > 0) entry.references -= 1;
    if (entry.references !== 0 || entry.retired) return;
    entry.retired = true;
    if (this.entries.get(entry.resourceId) === entry) this.entries.delete(entry.resourceId);
    entry.abortController.abort(reason === 'backend-disposed' ? 'backend-disposed' : 'resource-unreferenced');
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
    case 'material': return descriptor.family === 'material.program'
      ? [descriptor.programResourceId, ...Object.keys(descriptor.textures ?? {}).sort().map((name) => descriptor.textures[name])]
      : descriptor.textureResourceIds ?? [];
    case 'surface': return descriptor.textureResourceIds ?? [];
    case 'particle': return descriptor.textureResourceId ? [descriptor.textureResourceId] : [];
    default: return [];
  }
}
