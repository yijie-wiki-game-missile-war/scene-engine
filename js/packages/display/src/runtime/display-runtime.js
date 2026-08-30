import { ComponentScheduler } from '../component/component-scheduler.js';
import {
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
} from '../catalog/identity.js';
import { createInternalComponentContext } from './component-context.js';
import { assertSynchronous, cloneAndFreeze, exactKeys, safeInteger } from '../internal.js';
import { NodeGraph } from '../node/node-graph.js';
import { NodeIndex } from '../node/node-index.js';
import { RenderSystem } from '../render/render-system.js';
import { RenderComponent } from '../render/render-component.js';
import { AnimationPlayerComponent } from '../animation/animation-player.js';
import { AnimationSystem } from '../animation/animation-system.js';
import { BillboardComponent } from '../behaviours/billboard.js';
import { attachedComponentNode } from '../component/component.js';
import { compilePrefabCatalog } from '../resource/prefab-compiler.js';
import { AuthorityPort } from './authority-port.js';
import { DisplayView } from './display-view.js';
import { DisplayRuntimeError, fail, healthEvent } from './health.js';
import { PrefabInstantiator } from './prefab-instantiator.js';
import { Scene } from './scene.js';
import { SceneLoader } from './scene-loader.js';

export const DISPLAY_RUNTIME_SCHEMA = 'scene-engine-display-node@5';
export const DISPLAY_SUMMARY_SCHEMA = 'scene-engine-display-summary@1';
const ZERO_CURSOR = Object.freeze({ commitSeq: 0, sourceTick: 0, lastCommandSeq: 0 });
const DISPLAY_OPTION_KEYS = Object.freeze({
  required: Object.freeze([
    'sceneRegistry',
    'prefabRegistry',
    'resourceRegistry',
    'componentRegistry',
    'createRenderBackend',
    'authorityStateSchemas',
  ]),
  optional: Object.freeze(['hostElement', 'canvas', 'frameAdapter', 'onHealth']),
});

function normalizeCursor(value) {
  const record = exactKeys(value, ['commitSeq', 'sourceTick', 'lastCommandSeq'], [],
    'display-cursor-invalid');
  return Object.freeze({
    commitSeq: safeInteger(record.commitSeq, 'display-cursor-invalid', { minimum: 0 }),
    sourceTick: safeInteger(record.sourceTick, 'display-cursor-invalid', { minimum: 0 }),
    lastCommandSeq: safeInteger(record.lastCommandSeq, 'display-cursor-invalid', { minimum: 0 }),
  });
}

function sameCursor(left, right) {
  return left.commitSeq === right.commitSeq && left.sourceTick === right.sourceTick
    && left.lastCommandSeq === right.lastCommandSeq;
}

function defaultFrameAdapter() {
  const request = typeof globalThis.requestAnimationFrame === 'function'
    ? (callback) => globalThis.requestAnimationFrame(callback)
    : (callback) => setTimeout(() => callback(performance.now()), 16);
  const cancel = typeof globalThis.cancelAnimationFrame === 'function'
    ? (identity) => globalThis.cancelAnimationFrame(identity)
    : (identity) => clearTimeout(identity);
  return { request, cancel, now: () => performance.now() };
}

function validateFrameAdapter(value) {
  const adapter = value ?? defaultFrameAdapter();
  if (typeof adapter.request !== 'function' || typeof adapter.cancel !== 'function'
      || typeof adapter.now !== 'function') fail('display-frame-adapter-invalid');
  return adapter;
}

export class DisplayRuntime {
  constructor(options) {
    const record = exactKeys(
      options,
      DISPLAY_OPTION_KEYS.required,
      DISPLAY_OPTION_KEYS.optional,
      'display-options-invalid',
    );
    const {
      sceneRegistry,
      prefabRegistry,
      resourceRegistry,
      componentRegistry,
      createRenderBackend,
      authorityStateSchemas,
    } = record;
    const hostElement = record.hostElement ?? null;
    const canvas = record.canvas ?? null;
    const frameAdapter = record.frameAdapter ?? null;
    const onHealth = record.onHealth ?? null;
    if (!sceneRegistry || !prefabRegistry || !resourceRegistry || !componentRegistry
        || typeof createRenderBackend !== 'function' || !Array.isArray(authorityStateSchemas)
        || (onHealth !== null && typeof onHealth !== 'function')) {
      fail('display-options-invalid');
    }
    this._hostElement = hostElement;
    this._canvas = canvas;
    this._createRenderBackend = createRenderBackend;
    this._frameAdapter = validateFrameAdapter(frameAdapter);
    this._onHealth = onHealth;
    this._nodeIndex = new NodeIndex();
    this._revision = 0;
    this._cursor = ZERO_CURSOR;
    this._pendingCursor = null;
    this._drawGateOpen = true;
    this._health = 'initializing';
    this._installed = false;
    this._active = false;
    this._running = false;
    this._disposed = false;
    this._rafId = null;
    this._drawRequested = false;
    this._visualOrigin = null;
    this._sceneName = null;
    this._lastFrameTime = null;
    this._frameIndex = 0;
    this._rebuildPromise = null;
    this._disposePromise = null;
    this._lifecycleAbortController = new AbortController();

    this._catalogManifest = buildDisplayCatalogManifest({
      sceneRegistry,
      prefabRegistry,
      resourceRegistry,
      componentRegistry,
      authorityStateSchemas,
    });
    this._catalogIdentity = computeDisplayCatalogIdentity(this._catalogManifest);
    const compiledPrefabCatalog = compilePrefabCatalog({
      prefabRegistry,
      componentRegistry,
      resourceRegistry,
    });

    for (const registry of [sceneRegistry, prefabRegistry, resourceRegistry, componentRegistry]) {
      if (typeof registry.seal !== 'function') fail('display-options-invalid');
      registry.seal();
    }

    this._scheduler = new ComponentScheduler({
      onError: ({ error, component, phase }) => this._failRuntime(
        'display-component-tick-failed', error, { nodeName: component.node?.name ?? null,
          componentType: component.constructor.typeId, phase }),
    });
    this._renderSystem = new RenderSystem({
      resourceRegistry,
      onHealth: (event) => this._handleRenderHealth(event),
      onNeedsDraw: () => this.requestDraw(),
    });
    this._animationSystem = new AnimationSystem({
      resourceRegistry,
      renderSystem: this._renderSystem,
      onNeedsDraw: () => this.requestDraw(),
    });
    this._nodeGraph = new NodeGraph({
      nodeIndex: this._nodeIndex,
      maximumDepth: 128,
      onDirty: () => this.requestDraw(),
      onWorldTransform: (node) => this._renderSystem.markNodeDirty(node),
      onVisibility: (node) => this._renderSystem.markNodeDirty(node),
    });
    const registries = Object.freeze({
      sceneRegistry,
      prefabRegistry,
      resourceRegistry,
      componentRegistry,
      compiledPrefabCatalog,
    });
    this._scene = new Scene({
      registries,
      nodeIndex: this._nodeIndex,
      nodeGraph: this._nodeGraph,
      scheduler: this._scheduler,
      renderSystem: this._renderSystem,
      sceneToken: Object.freeze({}),
    });
    this._componentContext = createInternalComponentContext({
      scene: this._scene,
      nodeIndex: this._nodeIndex,
      nodeGraph: this._nodeGraph,
      animationSystem: this._animationSystem,
      componentAttached: (component) => this._componentAttached(component),
      componentSuspending: (component) => this._componentSuspending(component),
      componentEnabledChanged: (component) => this._componentEnabledChanged(component),
      componentPropertiesChanged: (component) => this._componentPropertiesChanged(component),
      componentDetaching: (component) => this._componentDetaching(component),
    });
    this._prefabInstantiator = new PrefabInstantiator({
      scene: this._scene,
      componentContext: this._componentContext,
      animationSystem: this._animationSystem,
      onCleanupErrors: (errors) => this._reportCleanupErrors(errors),
    });
    this.authority = Object.freeze(new AuthorityPort({
      scene: this._scene,
      prefabInstantiator: this._prefabInstantiator,
      componentContext: this._componentContext,
      onMutation: () => this._mutated(),
      onCleanupErrors: (errors) => this._reportCleanupErrors(errors),
      assertMutable: () => this._assertAuthorityMutable(),
    }));
    this._sceneLoader = new SceneLoader({
      scene: this._scene,
      componentContext: this._componentContext,
      prefabInstantiator: this._prefabInstantiator,
      onCleanupErrors: (errors) => this._reportCleanupErrors(errors),
    });
    this._scene.loader = this._sceneLoader;
    this.commitGate = Object.freeze({
      begin: (cursor) => this._beginCommit(cursor),
      seal: (cursor) => this._sealCommit(cursor),
      fail: (error) => this._failCommit(error),
    });
  }

  installScene({ sceneName }) {
    this._assertNotDisposed();
    if (this._installed) fail('display-scene-already-installed');
    const definition = this._scene.registries.sceneRegistry.require(sceneName);
    const compiled = definition.compile(this._scene.registries);
    const backend = assertSynchronous(this._createRenderBackend({
      hostElement: this._hostElement,
      canvas: this._canvas,
      rendererProfile: compiled.rendererProfile,
      resourceRegistry: this._scene.registries.resourceRegistry,
      signal: this._lifecycleAbortController.signal,
      onHealth: (event) => this._handleRenderHealth(event),
    }), 'display-render-backend-factory-async');
    this._renderSystem.setBackend(backend);
    this._sceneLoader.installCompiled(compiled);
    this._sceneName = compiled.id;
    this._installed = true;
    this._revision += 1;
    return this;
  }

  catalogIdentity() { this._assertNotDisposed(); return this._catalogIdentity; }

  activate(cursor = ZERO_CURSOR) {
    this._assertNotDisposed();
    if (!this._installed || this._active) fail('display-activate-state-invalid');
    if (this._health !== 'initializing') fail('display-unhealthy');
    // Bootstrap property patches do not pass through a commit gate. Validate and
    // reconcile their final animation bindings before the runtime becomes drawable.
    this._animationSystem.validateAndApplyPendingChanges();
    this._cursor = normalizeCursor(cursor);
    this._scene.activate();
    this._active = true;
    this._health = 'ready';
    this.requestDraw();
  }

  start() {
    this._assertHealthy();
    if (!this._active) fail('display-not-active');
    if (this._running) return;
    this._running = true;
    this.requestDraw();
  }

  stop() {
    if (this._disposed) return;
    this._running = false;
    this._cancelFrame();
  }

  requestDraw() {
    if (this._disposed) return;
    this._drawRequested = true;
    this._scheduleFrame();
  }

  async whenReady() { this._assertNotDisposed(); await this._renderSystem.whenIdle(); }
  summary() {
    return Object.freeze({
      schema: DISPLAY_SUMMARY_SCHEMA,
      sceneName: this._sceneName,
      revision: this._revision,
      cursor: this._cursor,
      nodeCount: this._nodeIndex?.size ?? 0,
      health: this._health,
    });
  }
  currentView() { this._assertNotDisposed(); return new DisplayView(this); }
  pick(query) { this._assertNotDisposed(); return this._renderSystem.pick(query); }
  projectWorldPoint(point) {
    this._assertNotDisposed(); return this._renderSystem.projectWorldPoint(point);
  }
  focusWorldPoint(target) {
    this._assertNotDisposed(); return this._renderSystem.focusWorldPoint(target);
  }
  capture() {
    this._assertNotDisposed();
    return cloneAndFreeze({
      schema: DISPLAY_RUNTIME_SCHEMA,
      cursor: this._cursor,
      revision: this._revision,
      health: this._health,
      gateOpen: this._drawGateOpen,
      frameIndex: this._frameIndex,
      render: this._renderSystem.capture(),
    });
  }

  rebuildRenderBackend() {
    this._assertNotDisposed();
    if (!this._installed) fail('display-scene-not-installed');
    if (this._rebuildPromise !== null) return this._rebuildPromise;
    const wasRunning = this._running;
    this.stop();
    let operation;
    operation = (async () => {
      let candidate = null;
      try {
        candidate = await this._createRenderBackend({
          hostElement: this._hostElement,
          canvas: this._canvas,
          rendererProfile: this._scene.compiledDefinition.rendererProfile,
          resourceRegistry: this._scene.registries.resourceRegistry,
          signal: this._lifecycleAbortController.signal,
          onHealth: (event) => this._handleRenderHealth(event),
        });
        if (this._disposed) {
          const orphan = candidate; candidate = null;
          await this._disposeDetachedBackend(orphan);
          fail('display-disposed');
        }
        await this._renderSystem.rebuildBackend(candidate);
        candidate = null;
        if (this._disposed) return;
        if (this._health !== 'projection-invalid') this._health = 'ready';
        if (wasRunning) this.start();
      } catch (error) {
        if (candidate !== null && !this._renderSystem.hasOwnedBackend(candidate)) {
          const orphan = candidate; candidate = null;
          try { await this._disposeDetachedBackend(orphan); } catch (cleanupError) {
            this._reportCleanupErrors([cleanupError]);
          }
        }
        if (!this._disposed) {
          this._handleRenderHealth({
            code: 'display-render-backend-rebuild-failed',
            message: error?.message ?? 'display-render-backend-rebuild-failed',
          });
        }
        throw error;
      } finally {
        if (this._rebuildPromise === operation) this._rebuildPromise = null;
      }
    })();
    this._rebuildPromise = operation;
    return operation;
  }

  dispose() {
    if (this._disposePromise !== null) return this._disposePromise;
    this.stop();
    this._drawGateOpen = false;
    this._pendingCursor = null;
    this._disposed = true;
    this._health = 'disposing';
    this._lifecycleAbortController.abort();
    const rebuild = this._rebuildPromise;
    this._disposePromise = Promise.resolve().then(async () => {
      const cleanupErrors = [];
      const scene = this._scene;
      const sceneLoader = this._sceneLoader;
      const prefabInstantiator = this._prefabInstantiator;
      const renderSystem = this._renderSystem;
      const scheduler = this._scheduler;
      const nodeIndex = this._nodeIndex;
      const nodeGraph = this._nodeGraph;
      try {
        try { cleanupErrors.push(...sceneLoader.unload('runtime-disposed')); } catch (error) {
          cleanupErrors.push(error);
        }
        try { cleanupErrors.push(...prefabInstantiator.dispose('runtime-disposed')); } catch (error) {
          cleanupErrors.push(error);
        }
        // Animation players must drop ownership and transient overrides before the
        // RenderSystem and its backend disappear.
        try { this._animationSystem.clear(); } catch (error) { cleanupErrors.push(error); }
        let renderDisposal = null;
        try { renderDisposal = renderSystem.dispose(); } catch (error) { cleanupErrors.push(error); }
        try { scheduler.clear(); } catch (error) { cleanupErrors.push(error); }
        if (nodeIndex.size !== 0) {
          cleanupErrors.push(new DisplayRuntimeError(
            'display-node-index-not-empty-after-dispose',
            `Display NodeIndex retained ${nodeIndex.size} nodes after scene unload`,
          ));
          nodeIndex.clear();
        }
        try { nodeGraph.release(); } catch (error) { cleanupErrors.push(error); }
        sceneLoader.release();
        if (rebuild !== null) {
          try { await rebuild; } catch { /* disposal owns the final teardown */ }
        }
        if (renderDisposal !== null) {
          try { await renderDisposal; } catch (error) { cleanupErrors.push(error); }
        }
      } finally {
        try { scene.release(); } catch (error) { cleanupErrors.push(error); }
        this._reportCleanupErrors(cleanupErrors);
        this._hostElement = null;
        this._canvas = null;
        this._createRenderBackend = null;
        this._frameAdapter = null;
        this._onHealth = null;
        this._nodeIndex = null;
        this._scheduler = null;
        this._renderSystem = null;
        this._animationSystem = null;
        this._nodeGraph = null;
        this._scene = null;
        this._componentContext = null;
        this._prefabInstantiator = null;
        this._sceneLoader = null;
        this._catalogManifest = null;
        this._catalogIdentity = null;
        this._lifecycleAbortController = null;
        this._rebuildPromise = null;
        this._health = 'disposed';
      }
    });
    return this._disposePromise;
  }

  _beginCommit(cursor) {
    this._assertHealthy();
    if (!this._active || this._pendingCursor !== null) fail('display-commit-gate-state-invalid');
    const next = normalizeCursor(cursor);
    if (next.commitSeq !== this._cursor.commitSeq + 1
        || (next.sourceTick !== this._cursor.sourceTick && next.sourceTick !== this._cursor.sourceTick + 1)
        || next.lastCommandSeq < this._cursor.lastCommandSeq) fail('display-cursor-progression-invalid');
    this._pendingCursor = next;
    this._drawGateOpen = false;
    this._cancelFrame();
  }

  _sealCommit(cursor) {
    this._assertHealthy();
    const next = normalizeCursor(cursor);
    if (this._pendingCursor === null || !sameCursor(next, this._pendingCursor)) {
      fail('display-commit-gate-cursor-mismatch');
    }
    // Cross-component animation/resource validity belongs to the synchronous ACK
    // barrier. This sees the transaction's final properties, independent of resolver
    // patch order, and applies player ownership only after every candidate validates.
    this._animationSystem.validateAndApplyPendingChanges();
    this._nodeGraph.flushWorldTransforms();
    this._cursor = next;
    this._pendingCursor = null;
    this._drawGateOpen = true;
    this._revision += 1;
    this.requestDraw();
  }

  _failCommit(error) {
    this._assertNotDisposed();
    const cause = error instanceof Error ? error : new DisplayRuntimeError('display-commit-failed', String(error));
    this._pendingCursor = null;
    this._drawGateOpen = false;
    this._running = false;
    this._scheduler.halt();
    this._cancelFrame();
    this._health = 'projection-invalid';
    this._emitHealth('display-commit-failed', cause);
  }

  _componentAttached(component) {
    if (component instanceof AnimationPlayerComponent) this._animationSystem.register(component);
    else if (component instanceof RenderComponent) this._renderSystem.register(component);
    else {
      this._scheduler.register(component);
      this._panelAnchorSourceChanged(component);
    }
  }
  _componentSuspending(component) {
    return component instanceof AnimationPlayerComponent
      ? this._animationSystem.suspend(component) : null;
  }
  _componentEnabledChanged(component) {
    if (component instanceof AnimationPlayerComponent) this._animationSystem.setEnabled(component);
    else if (component instanceof RenderComponent) this._renderSystem.setEnabled(component);
    else {
      this._scheduler.setEnabled(component, component.enabled);
      this._panelAnchorSourceChanged(component);
    }
    this.requestDraw();
  }
  _componentPropertiesChanged(component) {
    if (component instanceof AnimationPlayerComponent) this._animationSystem.propertiesChanged(component);
    else if (component instanceof RenderComponent) {
      this._animationSystem.targetPropertiesChanged(component);
      this._renderSystem.markComponentDirty(component);
    } else this._panelAnchorSourceChanged(component);
    this.requestDraw();
  }
  _componentDetaching(component) {
    if (component instanceof AnimationPlayerComponent) this._animationSystem.unregister(component);
    else if (component instanceof RenderComponent) this._renderSystem.unregister(component);
    else {
      this._scheduler.unregister(component);
      this._panelAnchorSourceChanged(component);
    }
  }

  _panelAnchorSourceChanged(component) {
    if (!(component instanceof BillboardComponent)) return;
    const node = attachedComponentNode(component);
    if (node !== null) this._renderSystem.markPanelAnchorSubtreeDirty(node);
  }

  _mutated() { this._revision += 1; this.requestDraw(); }

  _scheduleFrame() {
    if (!this._running || !this._active || !this._drawGateOpen || this._health !== 'ready'
        || this._rafId !== null) return;
    const continuous = this._scene.compiledDefinition?.rendererProfile.drawMode === 'continuous'
      || this._animationSystem.requiresContinuousDraw
      || this._renderSystem.requiresContinuousDraw;
    if (!this._drawRequested && !continuous) return;
    this._rafId = this._frameAdapter.request((time) => this._runFrame(time));
  }

  _runFrame(time) {
    this._rafId = null;
    if (!this._running || !this._drawGateOpen || this._health !== 'ready') return;
    const now = typeof time === 'number' && Number.isFinite(time) ? time : this._frameAdapter.now();
    if (this._visualOrigin === null) this._visualOrigin = now;
    const deltaSeconds = this._lastFrameTime === null ? 0 : Math.max(0, (now - this._lastFrameTime) / 1000);
    this._lastFrameTime = now;
    this._drawRequested = false;
    if (!this._renderSystem.frameReady) return;
    const frame = Object.freeze({
      sourceTick: this._cursor.sourceTick,
      visualSeconds: Math.max(0, (now - this._visualOrigin) / 1000),
      deltaSeconds,
      frameIndex: this._frameIndex,
      display: this._componentContext.publicDisplay,
    });
    try {
      this._scheduler.runUpdate(frame);
      this._animationSystem.sample(frame);
      this._nodeGraph.flushWorldTransforms();
      this._scheduler.runBeforeRender(frame);
      this._nodeGraph.flushWorldTransforms();
      if (!this._renderSystem.prepareFrame(frame)) return;
      this._renderSystem.render();
      this._frameIndex += 1;
    } catch (error) {
      if (this._health === 'ready') this._failRuntime('display-frame-failed', error);
      return;
    }
    const continuous = this._scene.compiledDefinition.rendererProfile.drawMode === 'continuous'
      || this._animationSystem.requiresContinuousDraw
      || this._renderSystem.requiresContinuousDraw;
    if (continuous) this._drawRequested = true;
    this._scheduleFrame();
  }

  _cancelFrame() {
    if (this._rafId === null) return;
    this._frameAdapter.cancel(this._rafId);
    this._rafId = null;
  }

  _handleRenderHealth(event) {
    const code = event?.code ?? event?.errorCode ?? 'display-render-backend-health-invalid';
    const message = event?.message ?? event?.errorCode ?? code;
    if (!this._disposed && this._health !== 'projection-invalid' && this._health !== 'disposed') {
      this._health = 'renderer-unhealthy';
      this._cancelFrame();
    }
    this._emitHealth(code, new DisplayRuntimeError(code, message), {
      phase: event?.phase ?? null,
      nodeName: event?.nodeName ?? null,
      componentKey: event?.componentKey ?? null,
      resourceId: event?.resourceId ?? null,
      recoverable: event?.recoverable === true,
    });
  }
  _failRuntime(code, error, details = {}) {
    this._health = 'unhealthy';
    this._running = false;
    this._drawGateOpen = false;
    this._scheduler.halt();
    this._cancelFrame();
    this._emitHealth(code, error, details);
  }
  _emitHealth(code, error, details = {}) {
    try {
      this._onHealth?.(healthEvent({ severity: 'error', code,
        message: error?.message ?? code, ...details }));
    } catch { /* health observers are best-effort */ }
  }
  _reportCleanupErrors(errors) {
    for (const error of errors ?? []) {
      try {
        this._onHealth?.(healthEvent({
          severity: 'warning', code: 'display-cleanup-failed', message: error?.message ?? String(error),
        }));
      } catch { /* health observers are best-effort */ }
    }
  }
  async _disposeDetachedBackend(backend) {
    if (backend && typeof backend.dispose === 'function') await backend.dispose();
  }
  _assertAuthorityMutable() {
    this._assertHealthy();
    if (!this._installed) fail('display-scene-not-installed');
    if (this._active && this._pendingCursor === null) {
      fail('display-authority-outside-commit');
    }
  }
  _assertNotDisposed() { if (this._disposed) fail('display-disposed'); }
  _assertHealthy() {
    this._assertNotDisposed();
    if (this._health === 'unhealthy' || this._health === 'renderer-unhealthy'
        || this._health === 'projection-invalid') {
      fail('display-unhealthy');
    }
  }
}

export function createDisplayRuntime(options) { return new DisplayRuntime(options); }
