import { assertSynchronous, cloneAndFreeze } from '../internal.js';
import { DisplayRuntimeError, fail } from '../runtime/health.js';
import { CameraComponent } from './components.js';
import { assertRenderBackendPort, bindingIdentity } from './render-backend-port.js';
import { RenderComponent } from './render-component.js';

function identityKey(identity) {
  return JSON.stringify([identity.nodeName, identity.componentKey]);
}

export class RenderSystem {
  constructor({ resourceRegistry, onHealth = null, onNeedsDraw = null }) {
    this._resourceRegistry = resourceRegistry;
    this._onHealth = onHealth;
    this._onNeedsDraw = onNeedsDraw;
    this._backend = null;
    this._backendAbortController = null;
    this._retiredBackends = new WeakSet();
    this._ownedBackends = new WeakSet();
    this._backendDisposals = new WeakMap();
    this._backendCancellation = null;
    this._cancelBackendWait = null;
    this._entries = new Map();
    this._byNode = new Map();
    this._pending = new Set();
    this._identityBarriers = new Map();
    this._generation = 0;
    this._activeCameraName = null;
    this._failure = null;
    this._disposed = false;
    this._disposePromise = null;
    this._requiresContinuousDraw = false;
  }

  get backend() { return this._backend; }
  get requiresContinuousDraw() { return this._requiresContinuousDraw; }
  get frameReady() { return this._findActiveCameraBinding() !== null; }
  hasOwnedBackend(backend) {
    return backend !== null && (typeof backend === 'object' || typeof backend === 'function')
      && this._ownedBackends.has(backend);
  }

  setBackend(backend) {
    this._assertUsable();
    if (this._backend !== null) fail('display-render-backend-already-installed');
    this._backend = assertRenderBackendPort(backend);
    this._ownedBackends.add(this._backend);
    this._backendAbortController = new AbortController();
    this._startBackendWaitCycle();
    this._generation += 1;
    for (const entry of this._entries.values()) this._mount(entry);
  }

  register(component) {
    this._assertUsable();
    if (!(component instanceof RenderComponent) || component.node === null) {
      fail('display-render-component-invalid');
    }
    if (this._entries.has(component)) fail('display-render-component-duplicate');
    const entry = {
      component,
      identity: bindingIdentity(component.node.name, component.key),
      binding: null,
      state: 'unregistered',
      token: null,
      dirty: true,
      generation: this._generation,
    };
    this._entries.set(component, entry);
    let entries = this._byNode.get(component.node);
    if (!entries) { entries = new Set(); this._byNode.set(component.node, entries); }
    entries.add(entry);
    if (this._backend) this._mount(entry);
    this._onNeedsDraw?.();
  }

  unregister(component) {
    const entry = this._entries.get(component);
    if (!entry) return;
    this._entries.delete(component);
    const entries = this._byNode.get(component.node);
    entries?.delete(entry);
    if (entries?.size === 0) this._byNode.delete(component.node);
    entry.token = null;
    entry.state = 'disposed';
    if (entry.binding !== null && this._backend && !this._retiredBackends.has(this._backend)) {
      this._runBackend('display-render-binding-destroy-failed', () => {
        const result = this._backend.destroyBinding(entry.binding);
        this._trackIdentityDestroy(entry.identity, result, this._backend);
      });
    }
    entry.binding = null;
    this._onNeedsDraw?.();
  }

  setEnabled(component) { this.markComponentDirty(component); }

  markComponentDirty(component) {
    const entry = this._entries.get(component);
    if (!entry) return;
    entry.dirty = true;
    this._onNeedsDraw?.();
  }

  markNodeDirty(node) {
    for (const entry of this._byNode.get(node) ?? []) entry.dirty = true;
    if (this._byNode.has(node)) this._onNeedsDraw?.();
  }

  setActiveCamera(nodeName) {
    this._activeCameraName = nodeName;
    this._onNeedsDraw?.();
  }

  prepareFrame(frame) {
    this._assertHealthy();
    if (!this._backend) fail('display-render-backend-missing');
    const activeCameraBinding = this._findActiveCameraBinding();
    if (activeCameraBinding === null) return false;
    const dirtyBindings = [];
    for (const entry of this._entries.values()) {
      if (!entry.dirty || entry.state !== 'ready') continue;
      const component = entry.component;
      const node = component.node;
      const patch = Object.freeze({
        identity: entry.identity,
        worldMatrix: Object.freeze(Array.from(node._worldTransform.matrix)),
        visible: node.visibleInHierarchy && component.enabled,
        properties: component.properties,
      });
      this._runBackend('display-render-binding-update-failed', () => {
        assertSynchronous(
          this._backend.updateBinding(entry.binding, patch),
          'display-render-backend-async-frame-method',
        );
      });
      entry.dirty = false;
      dirtyBindings.push(Object.freeze({ identity: entry.identity, binding: entry.binding }));
    }
    const preparation = this._runBackend('display-render-prepare-failed', () => assertSynchronous(
      this._backend.prepareFrame({
        sourceTick: frame.sourceTick,
        visualSeconds: frame.visualSeconds,
        dirtyBindings: Object.freeze(dirtyBindings),
        activeCameraBinding,
      }),
      'display-render-backend-async-frame-method',
    ));
    this._requiresContinuousDraw = preparation?.requiresContinuousDraw === true;
    return true;
  }

  render(frame) {
    this._assertHealthy();
    return this._runBackend('display-render-draw-failed', () => assertSynchronous(
      this._backend.render(frame),
      'display-render-backend-async-frame-method',
    ));
  }

  requestResize() {
    this._assertHealthy();
    return this._runBackend('display-render-resize-failed', () => this._backend.requestResize());
  }
  pick(query) {
    this._assertHealthy();
    return this._runBackend('display-render-pick-failed', () => this._backend.pick(cloneAndFreeze(query)));
  }
  projectWorldPoint(point) {
    this._assertHealthy();
    return this._runBackend('display-render-project-failed',
      () => this._backend.projectWorldPoint(cloneAndFreeze(point)));
  }
  focusWorldPoint(target) {
    this._assertHealthy();
    return this._runBackend('display-render-focus-failed',
      () => this._backend.focusWorldPoint(cloneAndFreeze(target)));
  }
  capture() {
    this._assertHealthy();
    return this._runBackend('display-render-capture-failed',
      () => cloneAndFreeze(this._backend.capture()));
  }
  diagnostics() { return this._backend ? cloneAndFreeze(this._backend.diagnostics()) : Object.freeze({}); }

  async whenIdle() {
    this._assertUsable();
    const cancellation = this._backendCancellation;
    while (this._pending.size > 0) {
      const completed = await Promise.race([
        Promise.allSettled([...this._pending]).then(() => true),
        cancellation.then(() => false),
      ]);
      if (!completed) fail('display-render-operation-cancelled');
    }
    const backend = this._backend;
    if (backend) {
      try {
        const completed = await Promise.race([
          Promise.resolve(backend.whenIdle()).then(() => true),
          cancellation.then(() => false),
        ]);
        if (!completed) fail('display-render-operation-cancelled');
      } catch (error) {
        this._report('display-render-idle-failed', error);
      }
    }
    this._assertHealthy();
  }

  async rebuildBackend(backend) {
    this._assertUsable();
    const next = assertRenderBackendPort(backend);
    const previous = this._backend;
    this._generation += 1;
    for (const entry of this._entries.values()) {
      entry.token = null;
    }
    this._retireBackend(previous);
    if (previous) {
      try { await this._disposeBackendOnce(previous); } catch (error) {
        this._report('display-render-backend-dispose-failed', error);
      }
    }
    this._assertUsable();
    this._pending.clear();
    this._identityBarriers.clear();
    for (const entry of this._entries.values()) {
      entry.binding = null;
      entry.state = 'unregistered';
      entry.dirty = true;
    }
    this._backend = next;
    this._ownedBackends.add(next);
    this._backendAbortController = new AbortController();
    this._startBackendWaitCycle();
    this._failure = null;
    for (const entry of this._entries.values()) this._mount(entry);
    await this.whenIdle();
    this._onNeedsDraw?.();
  }

  dispose() {
    if (this._disposePromise !== null) return this._disposePromise;
    this._disposed = true;
    const backend = this._backend;
    this._generation += 1;
    for (const entry of this._entries.values()) {
      entry.token = null;
      entry.binding = null;
      entry.state = 'disposed';
    }
    this._retireBackend(backend);
    this._pending.clear();
    this._identityBarriers.clear();
    this._backend = null;
    this._entries.clear(); this._byNode.clear();
    this._activeCameraName = null;
    this._requiresContinuousDraw = false;
    this._disposePromise = Promise.resolve().then(async () => {
      try {
        if (backend) await this._disposeBackendOnce(backend);
      } finally {
        this._resourceRegistry = null;
        this._onHealth = null;
        this._onNeedsDraw = null;
        this._failure = null;
        this._cancelBackendWait = null;
        this._backendCancellation = null;
      }
    });
    return this._disposePromise;
  }

  _mount(entry) {
    if (!this._backend || entry.state === 'disposed') return;
    const barrier = this._identityBarriers.get(identityKey(entry.identity));
    if (barrier) {
      const token = Symbol('render-binding-destroy-barrier');
      entry.token = token;
      entry.state = 'pending';
      const waitJob = barrier.then(() => {
        if (entry.token !== token || entry.state === 'disposed'
            || !this._entries.has(entry.component)) return;
        entry.state = 'unregistered';
        this._mount(entry);
      }).finally(() => this._pending.delete(waitJob));
      this._pending.add(waitJob);
      return;
    }
    const backend = this._backend;
    const token = Symbol('render-binding-generation');
    entry.token = token;
    entry.generation = this._generation;
    entry.state = 'pending';
    let result;
    try {
      result = backend.createBinding({
        nodeName: entry.identity.nodeName,
        componentKey: entry.identity.componentKey,
        componentType: entry.component.constructor.typeId,
        properties: entry.component.properties,
        resourceRegistry: this._resourceRegistry,
        signal: this._backendAbortController.signal,
      });
    } catch (error) {
      entry.state = 'failed'; this._report('display-render-binding-create-failed', error); return;
    }
    if (!result || typeof result.then !== 'function') {
      if (result === null || result === undefined) {
        entry.state = 'failed';
        this._report('display-render-binding-create-failed',
          new DisplayRuntimeError('display-render-binding-create-failed'));
        return;
      }
      if (entry.token !== token || entry.state === 'disposed') {
        backend.destroyBinding(result);
        return;
      }
      entry.binding = result; entry.state = 'ready'; entry.dirty = true; this._onNeedsDraw?.();
      return;
    }
    const job = Promise.resolve(result).then(async (binding) => {
      if (entry.token !== token || entry.state === 'disposed' || entry.generation !== this._generation) {
        if (binding !== null && binding !== undefined && !this._retiredBackends.has(backend)) {
          await backend.destroyBinding(binding);
        }
        return;
      }
      if (binding === null || binding === undefined) {
        entry.state = 'failed';
        this._report('display-render-binding-create-failed',
          new DisplayRuntimeError('display-render-binding-create-failed'));
        return;
      }
      entry.binding = binding; entry.state = 'ready'; entry.dirty = true; this._onNeedsDraw?.();
    }, (error) => {
      if (entry.token === token && entry.state !== 'disposed') {
        entry.state = 'failed'; this._report('display-render-binding-create-failed', error);
      }
    }).catch((error) => {
      if (!this._retiredBackends.has(backend)) {
        this._report('display-render-binding-destroy-failed', error);
      }
    }).finally(() => {
      const key = identityKey(entry.identity);
      if (this._identityBarriers.get(key) === job) this._identityBarriers.delete(key);
      this._pending.delete(job);
    });
    this._identityBarriers.set(identityKey(entry.identity), job);
    this._pending.add(job);
  }

  _trackMaybePromise(value, code) {
    if (!value || typeof value.then !== 'function') return;
    const job = Promise.resolve(value).catch((error) => this._report(code, error))
      .finally(() => this._pending.delete(job));
    this._pending.add(job);
  }

  _trackIdentityDestroy(identity, value, backend) {
    if (!value || typeof value.then !== 'function') return;
    const key = identityKey(identity);
    let job;
    job = Promise.resolve(value).catch((error) => {
      if (!this._retiredBackends.has(backend)) {
        this._report('display-render-binding-destroy-failed', error);
      }
    }).finally(() => {
      if (this._identityBarriers.get(key) === job) this._identityBarriers.delete(key);
      this._pending.delete(job);
    });
    this._identityBarriers.set(key, job);
    this._pending.add(job);
  }

  _retireBackend(backend) {
    this._cancelBackendWait?.();
    this._cancelBackendWait = null;
    this._backendAbortController?.abort();
    this._backendAbortController = null;
    if (backend) this._retiredBackends.add(backend);
  }

  _startBackendWaitCycle() {
    let cancel;
    this._backendCancellation = new Promise((resolve) => { cancel = resolve; });
    this._cancelBackendWait = cancel;
  }

  _disposeBackendOnce(backend) {
    const existing = this._backendDisposals.get(backend);
    if (existing) return existing;
    let result;
    try { result = Promise.resolve(backend.dispose()); } catch (error) { result = Promise.reject(error); }
    this._backendDisposals.set(backend, result);
    return result;
  }

  _findActiveCameraBinding() {
    if (this._activeCameraName === null) return null;
    for (const entry of this._entries.values()) {
      if (entry.identity.nodeName === this._activeCameraName
          && entry.component instanceof CameraComponent && entry.state === 'ready') return entry.binding;
    }
    return null;
  }

  _runBackend(code, operation) {
    try { return operation(); } catch (error) { this._report(code, error); throw error; }
  }
  _report(code, error) {
    const wrapped = error instanceof DisplayRuntimeError ? error
      : new DisplayRuntimeError(code, error?.message ?? code, { cause: error });
    this._failure = wrapped;
    try { this._onHealth?.({ severity: 'error', code, message: wrapped.message }); } catch {
      /* health observers cannot corrupt renderer cleanup or lifecycle state */
    }
  }
  _assertUsable() { if (this._disposed) fail('display-render-system-disposed'); }
  _assertHealthy() { this._assertUsable(); if (this._failure) throw this._failure; }
}
