import { exactKeys, nonemptyString, safeInteger } from '../internal.js';
import { fail } from './health.js';
import { GENERATED_TEXTURE_LIMITS, generatedTextureByteLength } from '../resource/generated-texture-resource.js';

const ERROR = 'display-generated-texture-update-invalid';
// CPU source state belongs to one DisplayRuntime, never to the immutable catalog
// or a GPU handle. Renderer leases expose copies, not mutable source storage.
export class GeneratedTextureStore {
  constructor(registry, requestDraw) {
    this.entries = new Map(); this.closed = false; this.requestDraw = requestDraw;
    let bytes = 0;
    for (const resource of registry.values()) {
      const d = resource.describe(); if (d.kind !== 'generated-texture') continue;
      bytes += generatedTextureByteLength(d);
      if (bytes > GENERATED_TEXTURE_LIMITS.maximumTotalTextureBytes || this.entries.size >= GENERATED_TEXTURE_LIMITS.maximumResources)
        fail('display-generated-texture-budget-exceeded');
      this.entries.set(d.id, { descriptor: d, data: null, generation: 0, revision: 0, sourceRevision: null,
        task: null, leases: new Set(), waiters: new Set(), cancelled: false, failure: null });
    }
    this.publicPort = Object.freeze({ begin: this.begin.bind(this), status: this.status.bind(this), whenReady: this.whenReady.bind(this) });
    this.sourcePort = Object.freeze({ acquire: this.acquire.bind(this), failed: (id, code) => {
      const e = this.entries.get(id); if (!e || this.closed) return;
      e.failure = String(code).slice(0, 128); this.settle(e);
    } });
  }
  require(id) {
    if (this.closed) fail('display-generated-texture-disposed');
    const e = this.entries.get(id); if (!e) fail('display-generated-texture-missing'); return e;
  }
  allocate(e) {
    if (e.data) return;
    const Type = e.descriptor.format === 'rgba32float' ? Float32Array : Uint8Array;
    e.data = new Type(e.descriptor.width * e.descriptor.height * 4);
    for (let i = 0; i < e.data.length; i += 4) e.data.set(e.descriptor.initialValue, i);
  }
  begin(id, value) {
    const e = this.require(id), r = exactKeys(value, ['sourceRevision'], [], ERROR);
    nonemptyString(r.sourceRevision, ERROR); if (r.sourceRevision.length > 256) fail(ERROR);
    if (e.generation === Number.MAX_SAFE_INTEGER) fail('display-generated-texture-generation-exhausted');
    this.cancelTask(e, 'superseded');
    const task = { generation: ++e.generation, sourceRevision: r.sourceRevision, controller: new AbortController(), committed: false };
    e.task = task; e.cancelled = false; this.settle(e);
    return Object.freeze({ generation: task.generation, sourceRevision: task.sourceRevision, signal: task.controller.signal,
      commit: value => this.commit(e, task, value), cancel: () => {
        if (this.closed || e.task !== task || task.committed) return false;
        this.cancelTask(e, 'cancelled'); e.cancelled = true; this.settle(e); return true;
      } });
  }
  cancelTask(e, reason) { if (e.task) e.task.controller.abort(reason); e.task = null; }
  commit(e, task, value) {
    if (this.closed || task.controller.signal.aborted || e.task !== task) return Object.freeze({ status: 'discarded', generation: task.generation });
    if (task.committed) fail('display-generated-texture-already-committed');
    const r = exactKeys(value, ['regions'], [], ERROR), d = e.descriptor;
    if (!Array.isArray(r.regions) || r.regions.length < 1 || r.regions.length > d.budget.maxRegions) fail(ERROR);
    const Type = d.format === 'rgba32float' ? Float32Array : Uint8Array;
    let bytes = 0;
    const patches = r.regions.map(region => {
      const p = exactKeys(region, ['x', 'y', 'width', 'height', 'data'], [], ERROR);
      for (const key of ['x', 'y']) safeInteger(p[key], ERROR, { minimum: 0 });
      for (const key of ['width', 'height']) safeInteger(p[key], ERROR, { minimum: 1 });
      if (p.x + p.width > d.width || p.y + p.height > d.height || !(p.data instanceof Type)
          || p.data.length !== p.width * p.height * 4 || !(p.data.buffer instanceof ArrayBuffer)) fail(ERROR);
      bytes += p.data.byteLength;
      if (bytes > d.budget.maxUpdateBytes) fail('display-generated-texture-budget-exceeded');
      if (d.format === 'rgba32float' && p.data.some(v => !Number.isFinite(v))) fail(ERROR);
      return { ...p, data: p.data.slice() };
    });
    this.allocate(e);
    // No callbacks or async boundaries between validation and the complete copy.
    // Overlapping regions have explicit submission-order last-writer semantics.
    for (const p of patches) for (let row = 0; row < p.height; row++) {
      const start = ((p.y + row) * d.width + p.x) * 4;
      e.data.set(p.data.subarray(row * p.width * 4, (row + 1) * p.width * 4), start);
      for (const lease of e.leases) lease.dirty(p.y + row, p.x, p.x + p.width);
    }
    e.revision = task.generation; e.sourceRevision = task.sourceRevision; task.committed = true;
    this.requestDraw();
    return Object.freeze({ status: 'staged', generation: task.generation });
  }
  status(id) {
    const e = this.require(id), uploaded = [...e.leases].some(lease => lease.uploaded === e.revision);
    return Object.freeze({ resourceId: id, generation: e.generation, sourceRevision: e.task?.sourceRevision ?? e.sourceRevision,
      committedGeneration: e.revision, committedSourceRevision: e.sourceRevision,
      status: e.failure ? 'failed' : e.cancelled ? 'cancelled' : e.task && !e.task.committed ? 'generating' : uploaded ? 'ready' : 'pending-upload',
      errorCode: e.failure,
      sampleable: [...e.leases].some(lease => lease.uploaded >= 0), byteLength: generatedTextureByteLength(e.descriptor) });
  }
  whenReady(id) {
    const e = this.require(id), current = this.status(id);
    if (['ready', 'cancelled', 'failed'].includes(current.status)) return Promise.resolve(current);
    const existing = [...e.waiters].find(waiter => waiter.generation === e.generation);
    if (existing) return existing.promise;
    const waiter = { generation: e.generation, resolve: null, promise: null };
    waiter.promise = new Promise(resolve => { waiter.resolve = resolve; }); e.waiters.add(waiter); return waiter.promise;
  }
  settle(e, removed = false) {
    for (const waiter of e.waiters) {
      let result;
      if (this.closed) result = Object.freeze({ status: 'disposed', generation: waiter.generation });
      else if (removed || waiter.generation !== e.generation || e.cancelled) result = Object.freeze({ status: 'discarded', generation: waiter.generation });
      else { const s = this.status(e.descriptor.id); if (s.status === 'ready' || s.status === 'failed') result = s; }
      if (result) { e.waiters.delete(waiter); waiter.resolve(result); }
    }
  }
  acquire(id) {
    const e = this.require(id); this.allocate(e); const d = e.descriptor; e.failure = null;
    let released = false;
    const rows = new Map();
    const lease = { uploaded: -1, dirty(y, start, end) {
      const old = rows.get(y); rows.set(y, old ? [Math.min(old[0], start), Math.max(old[1], end)] : [start, end]);
    } };
    for (let y = 0; y < d.height; y++) lease.dirty(y, 0, d.width);
    e.leases.add(lease);
    return Object.freeze({
      update: (budget = Infinity) => {
        if (released || this.closed || rows.size === 0) return null;
        const byteLength = [...rows.values()].reduce((sum, [start, end]) => sum + (end - start) * 4 * e.data.BYTES_PER_ELEMENT, 0);
        if (byteLength > budget) return { deferred: true, byteLength };
        const regions = [...rows].sort(([a], [b]) => a - b).map(([y, [start, end]]) => ({
          start: (y * d.width + start) * 4, count: (end - start) * 4,
          data: e.data.slice((y * d.width + start) * 4, (y * d.width + end) * 4),
        }));
        return { generation: e.revision, sourceRevision: e.sourceRevision, regions, byteLength };
      },
      submitted: generation => { if (!released && generation === e.revision) rows.clear(); },
      uploaded: generation => { if (!released && !this.closed) { lease.uploaded = generation; this.settle(e); } },
      release: reason => {
        if (released) return; released = true; e.leases.delete(lease); rows.clear();
        if (e.leases.size === 0 && reason !== 'backend-disposed' && !this.closed) {
          if (e.task && !e.task.committed) {
            this.cancelTask(e, 'resource-unreferenced'); e.cancelled = true;
          }
          this.settle(e, true);
        }
      },
    });
  }
  dispose() {
    if (this.closed) return; this.closed = true;
    for (const e of this.entries.values()) { this.cancelTask(e, 'runtime-disposed'); this.settle(e); e.data = null; e.leases.clear(); }
    this.entries.clear(); this.requestDraw = () => {};
  }
}
