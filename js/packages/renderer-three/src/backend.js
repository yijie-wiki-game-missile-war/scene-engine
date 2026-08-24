import * as THREE from 'three';

import { THREE_RENDER_BACKEND_SCHEMA } from './constants.js';
import { ThreeRenderBackendError, fail } from './errors.js';
import { ResourceManager } from './resource-manager.js';
import {
  DEFAULT_THREE_IMPLEMENTATION,
  assertComponentResourceKinds,
  createComponentHandle,
  resourceIdsForComponent,
} from './resources.js';
import {
  normalizeCreateDescriptor,
  normalizeFocus,
  normalizeFrame,
  normalizeOptions,
  normalizePick,
  normalizePoint,
  normalizeUpdatePatch,
  stableData,
} from './validation.js';

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

export class ThreeRenderBackend {
  constructor(options, implementation = DEFAULT_THREE_IMPLEMENTATION) {
    const normalized = normalizeOptions(options);
    this._hostElement = normalized.hostElement;
    this._canvas = normalized.canvas;
    this._profile = normalized.rendererProfile;
    this._registry = normalized.resourceRegistry;
    this._onHealth = normalized.onHealth;
    this._implementation = Object.freeze({ ...DEFAULT_THREE_IMPLEMENTATION, ...implementation });
    this._controller = new AbortController();
    this._disposed = false;
    this._failure = null;
    this._drawCount = 0;
    this._resizeCount = 0;
    this._width = 1;
    this._height = 1;
    this._pixelRatio = 1;
    this._bindings = new Map();
    this._records = new WeakMap();
    this._reservations = new Set();
    this._nodes = new Map();
    this._pending = new Set();
    this._backgroundKey = null;
    this._activeCamera = null;
    this._batches = [];
    this._batchSignature = null;
    this._batchDirty = true;

    this._scene = new THREE.Scene();
    this._root = new THREE.Group();
    this._root.name = 'SceneEngineRenderRoot';
    this._root.matrixAutoUpdate = false;
    this._root.updateMatrix();
    this._batchRoot = new THREE.Group();
    this._batchRoot.name = 'SceneEngineBatchRoot';
    this._batchRoot.matrixAutoUpdate = false;
    this._batchRoot.updateMatrix();
    this._scene.add(this._root, this._batchRoot);
    this._renderer = this._implementation.createRenderer(this._canvas, this._profile);
    requireRenderer(this._renderer);
    this._resources = new ResourceManager({
      registry: this._registry,
      load: this._implementation.loadResource,
      dispose: this._implementation.disposeResource,
      onFailure: (resourceId, error) => {
        const wrapped = wrapError('three-resource-load-failed', error);
        this._failure = wrapped;
        this._emitHealth({ phase: 'resource-load', resourceId,
          errorCode: wrapped.code, recoverable: true });
      },
    });
    this._resizeObserver = this._implementation.createResizeObserver(() => {
      try { this.requestResize(); } catch (error) {
        const wrapped = wrapError('three-resize-failed', error); this._failure = wrapped;
        this._emitHealth({ phase: 'resize', errorCode: wrapped.code, recoverable: true });
      }
    });
    if (!this._resizeObserver || typeof this._resizeObserver.observe !== 'function'
        || typeof this._resizeObserver.disconnect !== 'function') {
      fail('three-resize-observer-invalid');
    }
    this._resizeObserver.observe(this._hostElement);
    this.requestResize();
    this._externalAbort = normalized.signal === null ? null : () => this.dispose();
    normalized.signal?.addEventListener('abort', this._externalAbort, { once: true });
    if (normalized.signal?.aborted) this.dispose();
    this._externalSignal = normalized.signal;
  }

  createBinding(value) {
    this._assertOpen();
    const descriptor = normalizeCreateDescriptor(value, this._registry);
    const resourceIds = resourceIdsForComponent(descriptor.componentType, descriptor.properties);
    const key = identityKey(descriptor);
    if (this._bindings.has(key) || this._reservations.has(key)) fail('three-binding-duplicate');
    if (descriptor.componentType === 'render.background@1' && this._backgroundKey !== null) {
      fail('three-background-duplicate');
    }
    this._reservations.add(key);
    if (descriptor.componentType === 'render.background@1') this._backgroundKey = key;
    const record = {
      key,
      token: Object.freeze({}),
      identity: Object.freeze({ nodeName: descriptor.nodeName, componentKey: descriptor.componentKey }),
      componentType: descriptor.componentType,
      properties: descriptor.properties,
      resourceIds,
      leases: [],
      handle: null,
      nodeRoot: null,
      visible: true,
      worldMatrix: Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      controller: new AbortController(),
      pendingController: null,
      generation: 0,
      destroyed: false,
      unlinkSignal: null,
    };
    const unlinkBackendSignal = linkSignal(this._controller.signal, record.controller);
    const unlinkDescriptorSignal = linkSignal(descriptor.signal, record.controller);
    record.unlinkSignal = () => { unlinkBackendSignal(); unlinkDescriptorSignal(); };
    const operation = this._completeBinding(record).catch((error) => {
      this._reservations.delete(key);
      if (this._backgroundKey === key && !this._bindings.has(key)) this._backgroundKey = null;
      this._releaseRecordResources(record);
      if (!isAbort(error) && !this._disposed) {
        const wrapped = wrapError('three-binding-create-failed', error);
        this._failure = wrapped;
        this._emitHealth({ phase: 'binding-create', record, resourceId: resourceFromError(error),
          errorCode: wrapped.code, recoverable: true });
        throw wrapped;
      }
      throw error;
    });
    return this._track(operation);
  }

  updateBinding(binding, value) {
    this._assertOpen();
    const record = this._requireRecord(binding);
    const patch = normalizeUpdatePatch(value, record.identity);
    record.worldMatrix = patch.worldMatrix;
    record.visible = patch.visible;
    if (record.nodeRoot) {
      record.nodeRoot.matrix.fromArray(patch.worldMatrix);
      record.nodeRoot.matrixWorldNeedsUpdate = true;
    }
    if (record.handle.object) record.handle.object.visible = patch.visible;
    record.handle.applyVisibility?.(patch.visible);
    const nextResourceIds = resourceIdsForComponent(record.componentType, patch.properties);
    if (stableData(nextResourceIds) !== stableData(record.resourceIds)) {
      this._scheduleReplacement(record, patch.properties, nextResourceIds);
    } else {
      if (record.pendingController) {
        record.generation += 1;
        record.pendingController.abort('binding-replacement-reverted');
        record.pendingController = null;
      }
      if (stableData(record.properties) === stableData(patch.properties)) return;
      this._disposeBatches();
      try {
        record.handle.update(patch.properties);
        record.properties = patch.properties;
        record.handle.applyVisibility?.(record.visible);
      } catch (error) {
        const wrapped = wrapError('three-binding-update-failed', error); this._failure = wrapped;
        this._emitHealth({ phase: 'binding-update', record, errorCode: wrapped.code,
          recoverable: true });
        throw wrapped;
      }
    }
  }

  destroyBinding(binding) {
    if (this._disposed) return;
    const record = this._requireRecord(binding);
    this._destroyRecord(record);
  }

  prepareFrame(value) {
    this._assertOpen();
    const frame = normalizeFrame(value);
    const cameraRecord = this._requireRecord(frame.activeCameraBinding);
    if (cameraRecord.componentType !== 'render.camera@1' || !cameraRecord.handle.camera) {
      fail('three-active-camera-invalid');
    }
    this._activeCamera = cameraRecord;
    for (const record of this._bindings.values()) record.handle.sample(frame);
    this._updateBatches();
    const requiresContinuousDraw = this._pending.size > 0
      || [...this._bindings.values()].some((record) => record.handle.requiresContinuousDraw === true);
    return Object.freeze({ requiresContinuousDraw });
  }

  render() {
    this._assertOpen();
    if (!this._activeCamera?.handle.camera) fail('three-active-camera-required');
    try {
      this._renderer.render(this._scene, this._activeCamera.handle.camera);
      this._drawCount += 1;
    } catch (error) {
      const wrapped = wrapError('three-render-failed', error); this._failure = wrapped;
      this._emitHealth({ phase: 'render', errorCode: wrapped.code, recoverable: true });
      throw wrapped;
    }
  }

  requestResize() {
    this._assertOpen();
    const rect = this._hostElement.getBoundingClientRect();
    const width = positiveDimension(rect?.width ?? this._canvas.clientWidth ?? this._canvas.width);
    const height = positiveDimension(rect?.height ?? this._canvas.clientHeight ?? this._canvas.height);
    const deviceRatio = Number(this._implementation.devicePixelRatio());
    const pixelRatio = Math.min(this._profile.maximumPixelRatio,
      Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1);
    this._renderer.setPixelRatio(pixelRatio);
    this._renderer.setSize(width, height, false);
    const aspect = width / height;
    for (const record of this._bindings.values()) record.handle.resize?.(aspect);
    this._width = width; this._height = height; this._pixelRatio = pixelRatio;
    this._resizeCount += 1;
    return Object.freeze({ width, height, pixelRatio });
  }

  pick(value) {
    this._assertOpen();
    const query = normalizePick(value);
    const camera = this._activeCamera?.handle.camera;
    if (!camera) fail('three-active-camera-required');
    const rect = this._hostElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((query.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((query.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    const candidates = [];
    for (const record of this._bindings.values()) {
      if (record.visible && record.handle.pickable && !record.batched && record.handle.object) {
        candidates.push(record.handle.object);
      }
    }
    for (const batch of this._batches) if (batch.pickable) candidates.push(batch.object);
    camera.updateWorldMatrix(true, false);
    for (const candidate of candidates) candidate.updateWorldMatrix(true, true);
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(candidates, true)) {
      let record = null;
      if (hit.object?.userData?.threeBatchRecords && Number.isInteger(hit.instanceId)) {
        record = hit.object.userData.threeBatchRecords[hit.instanceId] ?? null;
      } else {
        let cursor = hit.object;
        while (cursor && !cursor.userData?.threeBindingToken) cursor = cursor.parent;
        if (cursor?.userData?.threeBindingToken) record = this._records.get(cursor.userData.threeBindingToken);
      }
      if (record && !record.destroyed) return Object.freeze({
        nodeName: record.identity.nodeName,
        componentKey: record.identity.componentKey,
        point: Object.freeze([hit.point.x, hit.point.y, hit.point.z]),
        distance: hit.distance,
      });
    }
    return null;
  }

  projectWorldPoint(value) {
    this._assertOpen();
    const { position } = normalizePoint(value);
    const camera = this._activeCamera?.handle.camera;
    if (!camera) fail('three-active-camera-required');
    camera.updateWorldMatrix(true, false);
    const vector = new THREE.Vector3(...position).project(camera);
    const rect = this._hostElement.getBoundingClientRect();
    return Object.freeze({
      clientX: rect.left + (vector.x + 1) * rect.width / 2,
      clientY: rect.top + (1 - vector.y) * rect.height / 2,
      visible: vector.z >= -1 && vector.z <= 1,
      depth: vector.z,
    });
  }

  focusWorldPoint(value) {
    this._assertOpen();
    const target = normalizeFocus(value);
    const record = this._activeCamera;
    const camera = record?.handle.camera;
    if (!camera) fail('three-active-camera-required');
    camera.updateWorldMatrix(true, false);
    const direction = new THREE.Vector3(); camera.getWorldDirection(direction);
    const current = new THREE.Vector3(); camera.getWorldPosition(current);
    const targetVector = new THREE.Vector3(...target.position);
    let distance = current.distanceTo(targetVector);
    if (camera.isPerspectiveCamera && target.radius > 0) {
      distance = Math.max(distance, target.radius / Math.tan(camera.fov * Math.PI / 360));
    }
    const suggested = targetVector.clone().addScaledVector(direction, -Math.max(distance, target.radius));
    return Object.freeze({
      nodeName: record.identity.nodeName,
      componentKey: record.identity.componentKey,
      position: Object.freeze(suggested.toArray()),
      target: target.position,
    });
  }

  capture() {
    this._assertOpen();
    let dataUrl = null;
    try { dataUrl = typeof this._canvas.toDataURL === 'function' ? this._canvas.toDataURL('image/png') : null; }
    catch { dataUrl = null; }
    return Object.freeze({
      schema: THREE_RENDER_BACKEND_SCHEMA,
      width: this._width,
      height: this._height,
      dataUrl,
      drawCount: this._drawCount,
      bindingCount: this._bindings.size,
    });
  }

  async whenIdle() {
    this._assertOpen();
    while (this._pending.size > 0) await Promise.allSettled([...this._pending]);
    await this._resources.whenIdle();
    if (this._failure) throw this._failure;
  }

  diagnostics() {
    const resources = this._resources.diagnostics();
    let lightCount = 0; let cameraCount = 0; let pickableCount = 0;
    for (const record of this._bindings.values()) {
      if (record.handle.light) lightCount += 1;
      if (record.handle.camera) cameraCount += 1;
      if (record.handle.pickable) pickableCount += 1;
    }
    const info = rendererInfo(this._renderer);
    return Object.freeze({
      schema: THREE_RENDER_BACKEND_SCHEMA,
      bindingCount: this._bindings.size,
      nodeBindingCount: this._nodes.size,
      batchCount: this._batches.length,
      instanceCount: this._batches.reduce((count, batch) => count + batch.records.length, 0),
      pickableCount,
      cameraCount,
      lightCount,
      backgroundCount: this._backgroundKey === null ? 0 : 1,
      pendingBindingCount: this._pending.size,
      drawCount: this._drawCount,
      resizeCount: this._resizeCount,
      renderTargetCount: 0,
      rendererCalls: info?.calls ?? 0,
      rendererGeometries: info?.geometries ?? 0,
      rendererTextures: info?.textures ?? 0,
      disposed: this._disposed,
      ...resources,
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._externalSignal?.removeEventListener?.('abort', this._externalAbort);
    this._resizeObserver?.disconnect();
    this._controller.abort('backend-disposed');
    this._disposeBatches();
    for (const record of [...this._bindings.values()]) this._destroyRecord(record, true);
    this._bindings.clear(); this._reservations.clear(); this._nodes.clear();
    this._resources.dispose();
    this._scene.background = null; this._scene.environment = null;
    this._root.removeFromParent(); this._batchRoot.removeFromParent();
    this._renderer.dispose();
    this._activeCamera = null;
  }

  async _completeBinding(record) {
    const leases = record.resourceIds.map((resourceId) => this._resources.acquire(
      resourceId, record.controller.signal,
    ));
    record.leases = leases;
    assertComponentResourceKinds(record.componentType, leases);
    await Promise.all(leases.map((lease) => lease.ready));
    requireNotAborted(record.controller.signal);
    const handle = createComponentHandle({ componentType: record.componentType,
      properties: record.properties, leases, scene: this._scene });
    if (record.controller.signal.aborted || this._disposed) {
      handle.dispose();
      if (this._disposed) fail('three-backend-disposed');
      requireNotAborted(record.controller.signal);
    }
    handle.resize?.(this._width / this._height);
    record.handle = handle;
    if (handle.object) {
      record.nodeRoot = this._acquireNodeRoot(record.identity.nodeName);
      record.nodeRoot.add(handle.object);
      handle.object.userData.threeBindingToken = record.token;
    }
    this._records.set(record.token, record);
    this._bindings.set(record.key, record);
    this._reservations.delete(record.key);
    this._batchDirty = true;
    return record.token;
  }

  _scheduleReplacement(record, properties, resourceIds) {
    record.generation += 1;
    const generation = record.generation;
    record.pendingController?.abort('binding-superseded');
    const controller = new AbortController();
    const unlink = linkSignal(record.controller.signal, controller);
    record.pendingController = controller;
    const operation = (async () => {
      const leases = resourceIds.map((id) => this._resources.acquire(id, controller.signal));
      try {
        assertComponentResourceKinds(record.componentType, leases);
        await Promise.all(leases.map((lease) => lease.ready)); requireNotAborted(controller.signal);
        const handle = createComponentHandle({ componentType: record.componentType,
          properties, leases, scene: this._scene });
        if (record.destroyed || record.generation !== generation || controller.signal.aborted) {
          handle.dispose(); for (const lease of leases) lease.release(); return;
        }
        handle.resize?.(this._width / this._height);
        this._disposeBatches();
        const previousHandle = record.handle; const previousLeases = record.leases;
        if (previousHandle.object) previousHandle.object.removeFromParent();
        record.handle = handle; record.leases = leases; record.properties = properties;
        record.resourceIds = resourceIds;
        if (handle.object) {
          record.nodeRoot ??= this._acquireNodeRoot(record.identity.nodeName);
          record.nodeRoot.add(handle.object); handle.object.userData.threeBindingToken = record.token;
          handle.object.visible = record.visible;
        } else if (record.nodeRoot) {
          this._releaseNodeRoot(record.identity.nodeName); record.nodeRoot = null;
        }
        previousHandle.dispose(); for (const lease of previousLeases) lease.release();
        handle.applyVisibility?.(record.visible);
        this._batchDirty = true;
      } catch (error) {
        for (const lease of leases) lease.release();
        if (!isAbort(error) && !record.destroyed && record.generation === generation) {
          const wrapped = wrapError('three-binding-replace-failed', error); this._failure = wrapped;
          this._emitHealth({ phase: 'binding-update', record, resourceId: resourceFromError(error),
            errorCode: wrapped.code, recoverable: true });
        }
      } finally {
        unlink(); if (record.pendingController === controller) record.pendingController = null;
      }
    })();
    this._track(operation);
  }

  _destroyRecord(record, disposing = false) {
    if (record.destroyed) return;
    record.destroyed = true; record.generation += 1;
    this._disposeBatches();
    record.pendingController?.abort('binding-destroyed');
    record.unlinkSignal?.();
    this._bindings.delete(record.key); this._reservations.delete(record.key);
    if (this._backgroundKey === record.key) this._backgroundKey = null;
    if (this._activeCamera === record) this._activeCamera = null;
    record.handle?.dispose();
    record.handle = null;
    if (record.nodeRoot) this._releaseNodeRoot(record.identity.nodeName);
    record.nodeRoot = null;
    record.controller.abort('binding-destroyed');
    this._releaseRecordResources(record);
    if (!disposing) this._batchDirty = true;
  }

  _releaseRecordResources(record) {
    for (const lease of record.leases) lease.release(); record.leases.length = 0;
  }

  _acquireNodeRoot(nodeName) {
    let entry = this._nodes.get(nodeName);
    if (!entry) {
      const object = new THREE.Group(); object.name = `NodeRenderBinding:${nodeName}`;
      object.matrixAutoUpdate = false; object.updateMatrix(); this._root.add(object);
      entry = { object, references: 0 }; this._nodes.set(nodeName, entry);
    }
    entry.references += 1; return entry.object;
  }

  _releaseNodeRoot(nodeName) {
    const entry = this._nodes.get(nodeName); if (!entry) return;
    entry.references -= 1;
    if (entry.references <= 0) { entry.object.removeFromParent(); this._nodes.delete(nodeName); }
  }

  _updateBatches() {
    const groups = new Map();
    for (const record of this._bindings.values()) {
      const fingerprint = record.handle.batchFingerprint;
      if (!fingerprint || typeof record.handle.createBatch !== 'function') continue;
      const key = `${record.componentType}\u0000${fingerprint}`;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record);
    }
    const eligible = [...groups.entries()].filter(([, records]) => records.length >= 2)
      .sort(([left], [right]) => left.localeCompare(right));
    const signature = stableData(eligible.map(([key, records]) => [key,
      records.map((record) => record.key).sort()]));
    if (this._batchDirty || signature !== this._batchSignature) {
      this._disposeBatches();
      for (const [, records] of eligible) {
        records.sort((left, right) => left.key.localeCompare(right.key));
        const created = records[0].handle.createBatch(records.length);
        const batch = { ...created, records,
          pickable: records[0].handle.pickable, localMatrix: new THREE.Matrix4().fromArray(created.localMatrix) };
        created.object.userData.threeBatchRecords = records;
        this._batchRoot.add(created.object); this._batches.push(batch);
        for (const record of records) { record.batched = true; record.handle.object.visible = false; }
      }
      this._batchSignature = signature; this._batchDirty = false;
    }
    const world = new THREE.Matrix4(); const final = new THREE.Matrix4();
    for (const batch of this._batches) {
      for (let index = 0; index < batch.records.length; index += 1) {
        const record = batch.records[index];
        if (!record.visible) batch.object.setMatrixAt(index, ZERO_MATRIX);
        else { world.fromArray(record.worldMatrix); final.multiplyMatrices(world, batch.localMatrix);
          batch.object.setMatrixAt(index, final); }
      }
      batch.object.instanceMatrix.needsUpdate = true;
    }
  }

  _disposeBatches() {
    for (const batch of this._batches) {
      for (const record of batch.records) {
        record.batched = false;
        if (record.handle?.object) record.handle.object.visible = record.visible;
      }
      batch.dispose();
    }
    this._batches.length = 0; this._batchSignature = null; this._batchDirty = true;
  }

  _requireRecord(binding) {
    const record = this._records.get(binding);
    if (!record || record.destroyed || this._bindings.get(record.key) !== record) fail('three-binding-invalid');
    return record;
  }

  _track(operation) {
    let tracked;
    tracked = Promise.resolve(operation).finally(() => this._pending.delete(tracked));
    tracked.catch(() => {}); this._pending.add(tracked); return tracked;
  }

  _emitHealth({ phase, record = null, resourceId = null, errorCode, recoverable }) {
    const event = Object.freeze({ phase,
      nodeName: record?.identity.nodeName ?? null,
      componentKey: record?.identity.componentKey ?? null,
      resourceId,
      errorCode,
      recoverable });
    try { this._onHealth?.(event); } catch { /* diagnostics observers cannot corrupt cleanup */ }
  }

  _assertOpen() { if (this._disposed) fail('three-backend-disposed'); }
}

export function createThreeRenderBackend(options) {
  const implementation = new ThreeRenderBackend(options);
  return Object.freeze(Object.fromEntries([
    'createBinding', 'updateBinding', 'destroyBinding', 'prepareFrame', 'render',
    'requestResize', 'pick', 'projectWorldPoint', 'focusWorldPoint', 'capture',
    'whenIdle', 'diagnostics', 'dispose',
  ].map((method) => [method, implementation[method].bind(implementation)])));
}

function identityKey(value) { return JSON.stringify([value.nodeName, value.componentKey]); }
function positiveDimension(value) { const number = Number(value); return Number.isFinite(number) && number > 0
  ? Math.max(1, Math.round(number)) : 1; }
function linkSignal(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason ?? 'binding-aborted');
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}
function requireNotAborted(signal) { if (signal.aborted) fail('three-binding-aborted'); }
function isAbort(error) { return error?.name === 'AbortError'
  || ['three-binding-aborted', 'three-resource-load-aborted'].includes(error?.code); }
function wrapError(code, error) { return error instanceof ThreeRenderBackendError ? error
  : new ThreeRenderBackendError(code, error?.message ?? code, { cause: error }); }
function resourceFromError(error) { return error?.resourceId ?? null; }
function requireRenderer(value) { for (const method of ['setPixelRatio', 'setSize', 'render', 'dispose']) {
  if (!value || typeof value[method] !== 'function') fail('three-renderer-invalid'); } }
function rendererInfo(renderer) { const render = renderer.info?.render; const memory = renderer.info?.memory;
  return render && memory ? { calls: render.calls, geometries: memory.geometries, textures: memory.textures } : null; }
