import * as THREE from 'three';
import { projectUpperFieldY, unprojectUpperFieldY, normalizeProjectionProfile } from '@scene-engine/display';
import { UpperFieldTerminal } from './upper-field.js';

import { COMPOSED_COMPONENT_TYPES, THREE_RENDER_BACKEND_SCHEMA } from './constants.js';
import { ThreeRenderBackendError, fail } from './errors.js';
import { compensatePanelViewPoint } from './panel-projection.js';
import { anchorExtentBounds } from './anchor-extent.js';
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
  normalizeProximity,
  normalizeScreenPoint,
  normalizeUpdatePatch,
  stableData,
} from './validation.js';

const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const BOX_EDGES = Object.freeze([
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
].map((edge) => Object.freeze(edge)));

export class ThreeRenderBackend {
  constructor(options, implementation = DEFAULT_THREE_IMPLEMENTATION) {
    const normalized = normalizeOptions(options);
    this._hostElement = normalized.hostElement;
    this._canvas = normalized.canvas;
    this._profile = normalized.rendererProfile;
    this._compositionPlan = normalized.compositionPlan;
    this._composition = compileComposition(normalized.compositionPlan);
    this._registry = normalized.resourceRegistry;
    this._onHealth = normalized.onHealth;
    this._implementation = Object.freeze({ ...DEFAULT_THREE_IMPLEMENTATION, ...implementation });
    this._disposed = false;
    this._failure = null;
    this._isolatedPrograms = new Set();
    this._drawCount = 0;
    this._renderCpuSamples = [];
    this._resizeCount = 0;
    this._width = 1;
    this._height = 1;
    this._pixelRatio = 1;
    this._bindings = new Map();
    this._records = new WeakMap();
    this._allRecords = new Set();
    this._recordSignalHubs = new Map();
    this._reservations = new Set();
    this._nodes = new Map();
    this._pending = new Set();
    this._backgroundKey = null;
    this._activeCamera = null;
    this._upperFieldTerminal = null;
    this._batches = [];
    this._batchDirty = true;
    this._dirtyBatchRecords = new Set();
    this._continuousRecords = new Set();
    this._nodeRootCleanupScheduled = false;
    this._batchWorldMatrix = new THREE.Matrix4();
    this._batchFinalMatrix = new THREE.Matrix4();
    this._batchInstanceSphere = new THREE.Sphere();

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
      generatedTextureSource: normalized.generatedTextureSource,
      renderer: this._renderer,
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
    this._assertCompositionGroup(descriptor.componentType, descriptor.compositionGroup);
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
      batchable: descriptor.batchable,
      compositionGroup: descriptor.compositionGroup,
      resourceIds,
      leases: [],
      handle: null,
      nodeRoot: null,
      visible: true,
      batched: false,
      batch: null,
      batchIndex: -1,
      panelAnchorWorld: null,
      worldMatrix: Object.freeze([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]),
      controller: new AbortController(),
      pendingReplacement: null,
      generation: 0,
      destroyed: false,
      unlinkSignal: null,
    };
    this._allRecords.add(record);
    record.unlinkSignal = this._linkRecordSignal(descriptor.signal, record.controller);
    const operation = this._completeBinding(record).catch((error) => {
      this._reservations.delete(key);
      if (this._backgroundKey === key && !this._bindings.has(key)) this._backgroundKey = null;
      this._allRecords.delete(record);
      record.unlinkSignal?.(); record.unlinkSignal = null;
      record.controller.abort('binding-create-failed');
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
    const patch = normalizeUpdatePatch(value, record.identity, record.componentType);
    this._assertCompositionGroup(record.componentType, patch.compositionGroup);
    if (patch.panelAnchorWorld !== null && record.componentType !== 'render.sprite@3') {
      fail('three-backend-panel-anchor-invalid');
    }
    if (patch.panelAnchorWorld !== null && patch.properties.projectionSemantics === 'anchor-extent') {
      fail('three-sprite-projection-combination-invalid');
    }
    record.worldMatrix = patch.worldMatrix;
    record.panelAnchorWorld = patch.panelAnchorWorld;
    record.visible = patch.visible;
    if (record.nodeRoot) {
      record.nodeRoot.matrix.fromArray(patch.worldMatrix);
      record.nodeRoot.matrixWorldNeedsUpdate = true;
    }
    this._applyRecordVisibility(record);
    if (record.batched) this._dirtyBatchRecords.add(record);
    const compositionChanged = patch.compositionGroup !== record.compositionGroup;
    if (compositionChanged && record.batched) this._disposeBatches();
    record.compositionGroup = patch.compositionGroup;
    this._applyRecordComposition(record);
    if (compositionChanged && record.batchable) this._batchDirty = true;
    const eligibilityChanged = patch.batchable !== record.batchable;
    if (eligibilityChanged) {
      // Eligibility is part of the latest logical binding state even while a
      // resource replacement is loading. Leave/rebuild batches immediately so
      // an animated binding is never represented by a stale static instance.
      this._disposeBatches();
      record.batchable = patch.batchable;
    }
    const nextResourceIds = resourceIdsForComponent(record.componentType, patch.properties);
    const nextResourceKey = stableData(nextResourceIds);
    if (nextResourceKey !== stableData(record.resourceIds)) {
      const pending = record.pendingReplacement;
      if (pending?.resourceKey === nextResourceKey) {
        // A full patch is emitted whenever world or animation state changes.
        // Keep one load for the same target resources and let its completion
        // install the newest normalized properties.
        pending.properties = patch.properties;
      } else {
        this._scheduleReplacement(record, patch.properties, nextResourceIds, nextResourceKey);
      }
      return;
    }
    this._cancelReplacement(record, 'binding-replacement-reverted');
    const propertiesChanged = stableData(record.properties) !== stableData(patch.properties);
    if (!propertiesChanged) {
      record.handle.setPanelAnchor?.(patch.panelAnchorWorld);
      return;
    }
    // Animated (non-batchable) frame flips update only this handle and never touch
    // batches. Eligibility changes and static fingerprint updates leave or reshape a
    // batch and dispose the current batches at most once per change. A program
    // parameter-only patch preserves membership and updates its instance row.
    const preserveBatch = record.batched && record.handle.canUpdateBatchProperties?.(patch.properties) === true;
    if (record.batched && !preserveBatch) this._disposeBatches();
    try {
      record.handle.update(patch.properties);
      record.handle.setPanelAnchor?.(patch.panelAnchorWorld);
      record.properties = patch.properties;
      this._applyRecordVisibility(record);
      if (!preserveBatch && record.batchable && record.handle.batchFingerprint
          && typeof record.handle.createBatch === 'function') this._batchDirty = true;
    } catch (error) {
      const wrapped = wrapError('three-binding-update-failed', error); this._failure = wrapped;
      this._emitHealth({ phase: 'binding-update', record, errorCode: wrapped.code,
        recoverable: true });
      throw wrapped;
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
    const generatedPending = this._resources.prepareGeneratedTextures();
    let activeContinuousRecord = false;
    for (const record of this._continuousRecords) {
      if (!record.visible || record.destroyed || record.programIsolated) continue;
      if (!record.handle.prepareProgramFrame && !continuousRecordIsActive(record)) continue;
      record.handle.sample(frame);
      if (continuousRecordIsActive(record)) activeContinuousRecord = true;
    }
    this._updateBatches();
    // Queries use the declared camera before any render/source-frustum expansion.
    const projectionProfile = this._projectionProfile();
    for (const record of this._bindings.values()) record.handle.prepareAnchorQuery?.(projectionProfile);
    for (const batch of this._batches) batch.prepareAnchorQuery?.(projectionProfile);
    for (const batch of this._batches) if (batch.object.visible) batch.sample?.(frame);
    const requiresContinuousDraw = this._pending.size > 0
      || activeContinuousRecord || generatedPending;
    return Object.freeze({ requiresContinuousDraw });
  }

  render() {
    this._assertOpen();
    if (this._resources.hasUninitializedGeneratedTextures()) return;
    if (!this._activeCamera?.handle.camera) fail('three-active-camera-required');
    const started = globalThis.performance?.now?.() ?? Date.now();
    const collectInfo = typeof this._renderer.info?.reset === 'function' && !Object.isFrozen(this._renderer.info);
    const originalInfoAutoReset = this._renderer.info?.autoReset;
    if (collectInfo) { this._renderer.info.reset(); this._renderer.info.autoReset = false; }
    try {
      const camera = this._activeCamera.handle.camera;
      const profile = this._projectionProfile();
      const rect = viewportRect(this._hostElement);
      const renderWorld = (layout = null) => {
        camera.updateWorldMatrix(true, false);
        const programFrame = {
          camera, width: layout?.width ?? this._width, height: layout?.height ?? this._height,
          pixelRatio: layout ? 1 : this._pixelRatio, projectionProfile: profile,
          sourceSpan: layout?.span ?? 2, finalWidth: this._width, finalHeight: this._height,
          finalPixelRatio: this._pixelRatio,
          viewportCssOrigin: { x: rect.left, y: rect.top },
          finalCssWidth: rect.width, finalCssHeight: rect.height,
        };
        const prepare = (handle) => {
          if (!handle.object?.visible) return;
          handle.prepareAnchorFrame?.(programFrame);
          handle.prepareProgramFrame?.(programFrame);
          this._prepareProgramCompile(handle, camera);
        };
        for (const record of this._bindings.values()) prepare(record.handle);
        for (const batch of this._batches) prepare(batch);
        if (this._composition === null) this._renderer.render(this._scene, camera);
        else this._renderComposition(camera);
      };
      if (profile !== null && profile.strength > 0) {
        this._upperFieldTerminal ??= new UpperFieldTerminal(this._scene);
        this._upperFieldTerminal.prepare(this._renderer, this._width, this._height, profile);
        this._upperFieldTerminal.render(this._renderer, camera, [this._root, this._batchRoot], renderWorld);
      } else {
        this._upperFieldTerminal?.dispose();
        this._upperFieldTerminal = null;
        renderWorld();
      }
      this._drawCount += 1;
      this._renderCpuSamples.push((globalThis.performance?.now?.() ?? Date.now()) - started);
      if (this._renderCpuSamples.length > 120) this._renderCpuSamples.shift();
    } catch (error) {
      const wrapped = wrapError('three-render-failed', error); this._failure = wrapped;
      const context = error.programContext;
      this._emitHealth({ phase: 'render', errorCode: wrapped.code, recoverable: true,
        record: context?.bindingToken ? this._records.get(context.bindingToken) : null,
        identity: context?.batchIdentity ?? undefined, resourceId: context?.metadata.resourceId ?? null,
        programDiagnostic: context ? { revision: context.metadata.revision,
          programStage: context.metadata.programStage, affectedBindingCount: context.affectedBindingCount,
          diagnostic: wrapped.message.slice(0, 4096) } : null });
      throw wrapped;
    } finally {
      if (collectInfo) this._renderer.info.autoReset = originalInfoAutoReset;
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

  _prepareProgramCompile(handle, camera) {
    try { handle.prepareProgramCompile?.(this._renderer, this._scene, camera, handle.object); }
    catch (error) {
      const context = error.programContext;
      if (error.code !== 'three-program-compile-failed' || !context) throw error;
      const key = JSON.stringify(context.metadata);
      if (this._isolatedPrograms.has(key)) return;
      this._isolatedPrograms.add(key);
      let affectedBindingCount = 0;
      for (const record of this._bindings.values()) {
        this._applyRecordVisibility(record);
        if (record.programIsolated && JSON.stringify(record.handle.object.material?.userData.sceneEngineProgram) === key)
          affectedBindingCount += 1;
      }
      for (const batch of this._batches) {
        if (JSON.stringify(batch.object.material?.userData.sceneEngineProgram) === key) batch.object.visible = false;
      }
      this._batchDirty = true;
      this._emitHealth({ phase: 'render', record: context.bindingToken ? this._records.get(context.bindingToken) : null,
        identity: context.batchIdentity ?? undefined, resourceId: context.metadata.resourceId,
        errorCode: error.code, recoverable: true, programDiagnostic: { revision: context.metadata.revision,
          programStage: context.metadata.programStage, affectedBindingCount, isolation: 'program',
          diagnostic: error.message.slice(0, 4096) } });
    }
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
    try { pointer.y = unprojectUpperFieldY(pointer.y, this._projectionProfile()); }
    catch (error) { if (error.code === 'display-projection-domain') return null; throw error; }
    const raycaster = new THREE.Raycaster();
    const candidates = [];
    for (const record of this._bindings.values()) {
      if (record.visible && !record.programIsolated && record.handle.pickable && !record.batched && record.handle.object) {
        candidates.push(record.handle.object);
      }
    }
    for (const batch of this._batches) if (batch.pickable && batch.object.visible) candidates.push(batch.object);
    camera.updateWorldMatrix(true, false);
    for (const candidate of candidates) candidate.updateWorldMatrix(true, true);
    raycaster.setFromCamera(pointer, camera);
    if (this._composition !== null) raycaster.layers.mask = this._composition.allGroupMask;
    const logicalHits = [];
    for (const hit of raycaster.intersectObjects(candidates, true)) {
      // Raycaster's radial near/far distance does not match the camera's view-
      // space clipping planes away from the optical axis. Test the actual hit
      // point against the same depth interval used by GPU projection instead.
      if (!pointWithinCameraDepth(hit.point, camera)) continue;
      let record = null;
      let activeRepresentation = false;
      if (hit.object?.userData?.threeBatchRecords && Number.isInteger(hit.instanceId)) {
        record = hit.object.userData.threeBatchRecords[hit.instanceId] ?? null;
        activeRepresentation = record?.batched === true;
      } else {
        let cursor = hit.object;
        while (cursor && !cursor.userData?.threeBindingToken) cursor = cursor.parent;
        if (cursor?.userData?.threeBindingToken) record = this._records.get(cursor.userData.threeBindingToken);
        activeRepresentation = record?.batched === false;
      }
      if (record && activeRepresentation && record.visible && !record.programIsolated && !record.destroyed) {
        logicalHits.push({ record, hit });
        if (this._composition === null) break;
      }
    }
    if (logicalHits.length === 0) return null;
    const selected = this._composition === null
      ? logicalHits[0] : selectCompositionHit(logicalHits, this._composition);
    if (selected === null) return null;
    return Object.freeze({
      nodeName: selected.record.identity.nodeName,
      componentKey: selected.record.identity.componentKey,
      point: Object.freeze([selected.hit.point.x, selected.hit.point.y, selected.hit.point.z]),
      distance: selected.hit.distance,
    });
  }

  screenPointToWorldRay(value) {
    this._assertOpen();
    const query = normalizeScreenPoint(value);
    const camera = this._activeCamera?.handle.camera;
    if (!camera) fail('three-active-camera-required');
    const rect = viewportRect(this._hostElement);
    camera.updateWorldMatrix(true, false);
    const raycaster = new THREE.Raycaster();
    const pointer = clientPointToNdc(query, rect);
    pointer.y = unprojectUpperFieldY(pointer.y, this._projectionProfile());
    raycaster.setFromCamera(pointer, camera);
    const origin = raycaster.ray.origin.toArray();
    const direction = raycaster.ray.direction.normalize().toArray();
    if (!origin.every(Number.isFinite) || !direction.every(Number.isFinite)
        || Math.abs(new THREE.Vector3(...direction).length() - 1) > 1e-12) {
      fail('three-backend-world-ray-invalid');
    }
    return Object.freeze({
      origin: Object.freeze(origin),
      direction: Object.freeze(direction),
    });
  }

  pickProximity(value) {
    this._assertOpen();
    const query = normalizeProximity(value);
    const camera = this._activeCamera?.handle.camera;
    if (!camera) fail('three-active-camera-required');
    camera.updateWorldMatrix(true, false);

    // A zero-radius query is the exact renderer pick, not a projected-bounds
    // approximation. This keeps its target semantics identical to pick().
    if (query.radiusPixels === 0) {
      const hit = this.pick({ clientX: query.clientX, clientY: query.clientY });
      if (hit === null) return null;
      const depth = new THREE.Vector3(...hit.point).project(camera).z;
      if (!Number.isFinite(depth)) return null;
      return Object.freeze({
        nodeName: hit.nodeName,
        componentKey: hit.componentKey,
        screenDistancePixels: 0,
        depth,
      });
    }

    if (this._composition !== null) {
      const exact = this.pick({ clientX: query.clientX, clientY: query.clientY });
      if (exact !== null) {
        const depth = new THREE.Vector3(...exact.point).project(camera).z;
        if (Number.isFinite(depth)) return Object.freeze({
          nodeName: exact.nodeName,
          componentKey: exact.componentKey,
          screenDistancePixels: 0,
          depth,
        });
      }
    }

    const rect = viewportRect(this._hostElement);
    const candidates = [];
    for (const record of this._bindings.values()) {
      if (!record.visible || record.programIsolated || !record.handle.pickable || !record.handle.object
          || record.destroyed) continue;
      const bounds = projectedBindingBounds(record, camera, rect, this._projectionProfile());
      if (bounds === null) continue;
      const screenDistancePixels = distanceToBounds(
        query.clientX, query.clientY, bounds,
      );
      if (screenDistancePixels > query.radiusPixels) continue;
      candidates.push({
        record,
        screenDistancePixels,
        depth: bounds.depth,
        compositionRank: this._composition?.groupRanks.get(record.compositionGroup) ?? 0,
      });
    }
    if (this._composition !== null) rejectProximityBehindProtected(candidates, this._composition);
    candidates.sort(compareProximityCandidates);
    const selected = candidates[0];
    if (!selected) return null;
    return Object.freeze({
      nodeName: selected.record.identity.nodeName,
      componentKey: selected.record.identity.componentKey,
      screenDistancePixels: selected.screenDistancePixels,
      depth: selected.depth,
    });
  }

  projectWorldPoint(value) {
    this._assertOpen();
    const { position } = normalizePoint(value);
    const camera = this._activeCamera?.handle.camera;
    if (!camera) fail('three-active-camera-required');
    camera.updateWorldMatrix(true, false);
    const point = new THREE.Vector3(...position);
    const viewDepth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    if (!Number.isFinite(viewDepth) || viewDepth < camera.near || viewDepth > camera.far)
      return Object.freeze({ clientX: null, clientY: null, depth: null, visible: false });
    const vector = point.project(camera);
    if (![vector.x, vector.y, vector.z].every(Number.isFinite))
      return Object.freeze({ clientX: null, clientY: null, depth: null, visible: false });
    vector.y = projectUpperFieldY(vector.y, this._projectionProfile());
    const rect = this._hostElement.getBoundingClientRect();
    return Object.freeze({
      clientX: rect.left + (vector.x + 1) * rect.width / 2,
      clientY: rect.top + (1 - vector.y) * rect.height / 2,
      visible: vector.z >= -1 && vector.z <= 1 && Math.abs(vector.x) <= 1 && Math.abs(vector.y) <= 1,
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
    if (target.halfExtents) {
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      const profile = this._projectionProfile();
      const halfHeight = camera.isPerspectiveCamera ? Math.tan(camera.fov * Math.PI / 360)
        : (camera.top - camera.bottom) / (2 * camera.zoom);
      const halfWidth = camera.isPerspectiveCamera ? halfHeight * camera.aspect
        : (camera.right - camera.left) / (2 * camera.zoom);
      const top = unprojectUpperFieldY(1, profile) * halfHeight;
      const bottom = -unprojectUpperFieldY(-1, profile) * halfHeight;
      let farthest = -Infinity;
      distance = 0;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const corner = new THREE.Vector3(sx * target.halfExtents[0], sy * target.halfExtents[1], sz * target.halfExtents[2]);
        const x = corner.dot(right); const y = corner.dot(up); const z = corner.dot(direction);
        farthest = Math.max(farthest, z);
        distance = Math.max(distance, camera.near - z);
        if (camera.isPerspectiveCamera) {
          distance = Math.max(distance, Math.abs(x) / halfWidth - z,
            (y >= 0 ? y / top : -y / bottom) - z);
        } else if (Math.abs(x) > halfWidth || y > top || -y > bottom) {
          fail('three-focus-bounds-unfit');
        }
      }
      if (distance + farthest > camera.far) fail('three-focus-bounds-unfit');
    }
    if (camera.isPerspectiveCamera && target.radius > 0) {
      const profile = this._projectionProfile();
      const verticalTangent = Math.tan(camera.fov * Math.PI / 360);
      const top = unprojectUpperFieldY(0.9, profile);
      const bottom = -unprojectUpperFieldY(-0.9, profile);
      const halfAngle = Math.atan(Math.min(0.9 * camera.aspect, top, bottom) * verticalTangent);
      distance = Math.max(distance, target.radius / Math.sin(halfAngle));
    }
    if (target.radius > 0) {
      if (camera.isOrthographicCamera) {
        const profile = this._projectionProfile();
        const halfHeight = (camera.top - camera.bottom) / (2 * camera.zoom);
        const halfWidth = (camera.right - camera.left) / (2 * camera.zoom);
        const available = Math.min(0.9 * halfWidth,
          halfHeight * unprojectUpperFieldY(0.9, profile),
          -halfHeight * unprojectUpperFieldY(-0.9, profile));
        if (target.radius > available) fail('three-focus-bounds-unfit');
      }
      distance = Math.max(distance, camera.near + target.radius);
      if (distance + target.radius > camera.far) fail('three-focus-bounds-unfit');
    }
    const suggested = targetVector.clone().addScaledVector(direction, -Math.max(distance, target.radius ?? 0));
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
      projection: this._upperFieldTerminal?.layout ?? null,
      renderer: Object.freeze({ ...rendererInfo(this._renderer) }),
      renderCpuSubmit: renderCpuSummary(this._renderCpuSamples),
      drawCount: this._drawCount,
      bindingCount: this._bindings.size,
      batchCount: this._batches.length,
      instanceCount: this._batches.reduce((count, batch) => count + batch.records.length, 0),
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
      renderTargetCount: this._upperFieldTerminal?.target ? 1 : 0,
      upperFieldSampling: this._upperFieldTerminal?.layout ?? null,
      compositionPlanId: this._compositionPlan?.id ?? null,
      compositionPassCount: this._compositionPlan?.passes.length ?? 1,
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
    for (const record of this._allRecords) record.controller.abort('backend-disposed');
    this._clearRecordSignalHubs();
    // Destruction does not need to restore inactive ordinary representations.
    // Keeping both batches and Node roots detached avoids quadratic parent-array
    // removal while a large backend is being retired or rebuilt.
    this._disposeBatches(false);
    for (const record of [...this._bindings.values()]) this._destroyRecord(record, true);
    this._detachAllNodeRoots();
    this._bindings.clear(); this._reservations.clear(); this._nodes.clear();
    this._allRecords.clear();
    this._dirtyBatchRecords.clear(); this._continuousRecords.clear();
    this._upperFieldTerminal?.dispose(); this._upperFieldTerminal = null;
    this._resources.dispose();
    this._scene.background = null; this._scene.environment = null;
    this._root.removeFromParent(); this._batchRoot.removeFromParent();
    this._renderer.dispose();
    this._isolatedPrograms.clear();
    this._activeCamera = null;
  }

  _projectionProfile() {
    return normalizeProjectionProfile(this._activeCamera?.properties.projectionProfile ?? null);
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
    handle.setPanelAnchor?.(record.panelAnchorWorld);
    record.handle = handle;
    this._applyRecordComposition(record);
    if (handle.requiresContinuousDraw === true) this._continuousRecords.add(record);
    if (handle.object) {
      record.nodeRoot = this._acquireNodeRoot(record.identity.nodeName);
      record.nodeRoot.add(handle.object);
      handle.object.userData.threeBindingToken = record.token;
    }
    this._applyRecordVisibility(record);
    this._records.set(record.token, record);
    this._bindings.set(record.key, record);
    this._reservations.delete(record.key);
    this._batchDirty = true;
    return record.token;
  }

  _scheduleReplacement(record, properties, resourceIds, resourceKey = stableData(resourceIds)) {
    record.generation += 1;
    const generation = record.generation;
    this._cancelReplacement(record, 'binding-superseded', false);
    const controller = new AbortController();
    const unlink = linkSignal(record.controller.signal, controller);
    const replacement = { controller, generation, resourceIds, resourceKey, properties };
    record.pendingReplacement = replacement;
    const operation = (async () => {
      const leases = resourceIds.map((id) => this._resources.acquire(id, controller.signal));
      try {
        assertComponentResourceKinds(record.componentType, leases);
        await Promise.all(leases.map((lease) => lease.ready)); requireNotAborted(controller.signal);
        const latestProperties = replacement.properties;
        const handle = createComponentHandle({ componentType: record.componentType,
          properties: latestProperties, leases, scene: this._scene });
        if (record.destroyed || record.generation !== generation || controller.signal.aborted
            || record.pendingReplacement !== replacement) {
          handle.dispose(); for (const lease of leases) lease.release(); return;
        }
        handle.resize?.(this._width / this._height);
        handle.setPanelAnchor?.(record.panelAnchorWorld);
        this._disposeBatches();
        const previousHandle = record.handle; const previousLeases = record.leases;
        this._continuousRecords.delete(record);
        if (previousHandle.object) previousHandle.object.removeFromParent();
        record.handle = handle; record.leases = leases; record.properties = latestProperties;
        this._applyRecordComposition(record);
        if (handle.requiresContinuousDraw === true) this._continuousRecords.add(record);
        record.resourceIds = resourceIds;
        if (handle.object) {
          record.nodeRoot ??= this._acquireNodeRoot(record.identity.nodeName);
          record.nodeRoot.add(handle.object); handle.object.userData.threeBindingToken = record.token;
        } else if (record.nodeRoot) {
          this._releaseNodeRoot(record.identity.nodeName); record.nodeRoot = null;
        }
        previousHandle.dispose(); for (const lease of previousLeases) lease.release();
        this._applyRecordVisibility(record);
        this._batchDirty = true;
      } catch (error) {
        for (const lease of leases) lease.release();
        if (!isAbort(error) && !record.destroyed && record.generation === generation) {
          const wrapped = wrapError('three-binding-replace-failed', error); this._failure = wrapped;
          this._emitHealth({ phase: 'binding-update', record, resourceId: resourceFromError(error),
            errorCode: wrapped.code, recoverable: true });
        }
      } finally {
        unlink();
        if (record.pendingReplacement === replacement) record.pendingReplacement = null;
      }
    })();
    this._track(operation);
  }

  _cancelReplacement(record, reason, advanceGeneration = true) {
    const pending = record.pendingReplacement;
    if (pending === null) return;
    if (advanceGeneration) record.generation += 1;
    record.pendingReplacement = null;
    pending.controller.abort(reason);
  }

  _destroyRecord(record, disposing = false) {
    if (record.destroyed) return;
    if (!disposing) this._disposeBatches();
    this._dirtyBatchRecords.delete(record);
    this._continuousRecords.delete(record);
    record.destroyed = true; record.generation += 1;
    this._cancelReplacement(record, 'binding-destroyed', false);
    record.unlinkSignal?.(); record.unlinkSignal = null;
    this._allRecords.delete(record);
    this._bindings.delete(record.key); this._reservations.delete(record.key);
    if (this._backgroundKey === record.key) this._backgroundKey = null;
    if (this._activeCamera === record) this._activeCamera = null;
    record.handle?.dispose();
    record.handle = null;
    if (record.nodeRoot && !disposing) this._releaseNodeRoot(record.identity.nodeName);
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
    if (entry.references <= 0) {
      // Logical ownership ends immediately. Leave an empty root in the private
      // Three tree only until one microtask compacts the complete parent array.
      // Sibling destroys in the same turn therefore never splice it one by one.
      this._nodes.delete(nodeName);
      this._scheduleEmptyNodeRootCleanup();
    }
  }

  _scheduleEmptyNodeRootCleanup() {
    if (this._nodeRootCleanupScheduled || this._disposed) return;
    this._nodeRootCleanupScheduled = true;
    queueMicrotask(() => {
      this._nodeRootCleanupScheduled = false;
      if (!this._disposed) this._detachEmptyNodeRoots();
    });
  }

  _updateBatches() {
    if (this._batchDirty) this._rebuildBatches();
    if (this._dirtyBatchRecords.size === 0) return;
    const touched = new Map();
    for (const record of this._dirtyBatchRecords) {
      if (!record.batched || record.batch === null) continue;
      this._writeBatchRecord(record.batch, record.batchIndex, record);
      let indices = touched.get(record.batch);
      if (!indices) { indices = []; touched.set(record.batch, indices); }
      indices.push(record.batchIndex);
    }
    this._dirtyBatchRecords.clear();
    for (const [batch, indices] of touched) {
      addAttributeUpdates(batch.object.instanceMatrix, indices);
      if (batch.panelAnchorAttribute) addAttributeUpdates(batch.panelAnchorAttribute, indices);
    }
  }

  _rebuildBatches() {
    const groups = new Map();
    for (const record of this._bindings.values()) {
      if (!record.batchable || record.programIsolated) continue;
      const fingerprint = record.handle.batchFingerprint;
      if (!fingerprint || typeof record.handle.createBatch !== 'function') continue;
      const key = `${record.componentType}\u0000${record.compositionGroup ?? ''}\u0000${fingerprint}`;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record);
    }
    const eligible = [...groups.entries()].filter(([, records]) => records.length >= 2)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, records]) => {
        const limit = records[0].handle.maximumBatchSize === 'texture-height'
          ? this._renderer.capabilities?.maxTextureSize ?? 2048 : records.length;
        const chunks = [];
        records.sort((left, right) => left.key.localeCompare(right.key));
        for (let offset = 0; offset < records.length; offset += limit) chunks.push([key, records.slice(offset, offset + limit)]);
        return chunks;
      });
    this._disposeBatches();
    for (const [, records] of eligible) {
      records.sort((left, right) => left.key.localeCompare(right.key));
      const created = records[0].handle.createBatch(records.length);
      const batch = { ...created, records, visibleCount: 0, instanceVisibility: new Uint8Array(records.length),
        pickable: records[0].handle.pickable, localMatrix: new THREE.Matrix4().fromArray(created.localMatrix) };
      batch.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      batch.panelAnchorAttribute?.setUsage(THREE.DynamicDrawUsage);
      created.object.userData.threeBatchRecords = records;
      this._applyObjectComposition(created.object, records[0].compositionGroup);
      this._batchRoot.add(created.object); this._batches.push(batch);
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        record.batched = true;
        record.batch = batch;
        record.batchIndex = index;
        this._applyRecordVisibility(record);
        this._writeBatchRecord(batch, index, record);
      }
      batch.object.instanceMatrix.needsUpdate = true;
      if (batch.panelAnchorAttribute) batch.panelAnchorAttribute.needsUpdate = true;
    }
    this._detachEmptyNodeRoots();
    this._dirtyBatchRecords.clear();
    this._batchDirty = false;
  }

  _writeBatchRecord(batch, index, record) {
    const visible = record.visible && !record.programIsolated ? 1 : 0;
    batch.visibleCount += visible - batch.instanceVisibility[index];
    batch.instanceVisibility[index] = visible;
    batch.object.visible = batch.visibleCount > 0;
    if (!visible) {
      batch.object.setMatrixAt(index, ZERO_MATRIX);
      return;
    }
    batch.setPanelAnchorAt?.(index, record.panelAnchorWorld);
    batch.setParametersAt?.(index, record.properties.parameters ?? {});
    this._batchWorldMatrix.fromArray(record.worldMatrix);
    this._batchFinalMatrix.multiplyMatrices(this._batchWorldMatrix, batch.localMatrix);
    batch.object.setMatrixAt(index, this._batchFinalMatrix);
    if (batch.object.frustumCulled && batch.object.boundingSphere !== null) {
      if (batch.object.geometry.boundingSphere === null) batch.object.geometry.computeBoundingSphere();
      this._batchInstanceSphere.copy(batch.object.geometry.boundingSphere)
        .applyMatrix4(this._batchFinalMatrix);
      batch.object.boundingSphere.union(this._batchInstanceSphere);
    }
  }

  _disposeBatches(restoreRecords = true) {
    this._detachAllBatchObjects();
    for (const batch of this._batches) {
      for (const record of batch.records) {
        record.batched = false;
        record.batch = null;
        record.batchIndex = -1;
        if (restoreRecords) this._applyRecordVisibility(record);
      }
      batch.dispose();
    }
    this._batches.length = 0; this._dirtyBatchRecords.clear(); this._batchDirty = true;
  }

  _applyRecordVisibility(record) {
    record.handle?.applyVisibility?.(record.visible);
    const object = record.handle?.object;
    if (!object) return;
    record.programIsolated = this._isolatedPrograms.has(JSON.stringify(object.material?.userData.sceneEngineProgram));
    object.visible = record.visible && !record.batched && !record.programIsolated;
    if (!record.nodeRoot) return;
    if (record.batched) {
      object.removeFromParent();
      return;
    }
    if (record.nodeRoot.parent !== this._root) this._root.add(record.nodeRoot);
    if (object.parent !== record.nodeRoot) record.nodeRoot.add(object);
  }

  _assertCompositionGroup(componentType, group) {
    if (!COMPOSED_COMPONENT_TYPES.has(componentType)) {
      if (group !== null) fail('three-backend-composition-group-invalid');
      return;
    }
    if (this._composition === null) {
      if (group !== null) fail('three-backend-composition-plan-required');
      return;
    }
    if (!this._composition.groupMasks.has(group)) fail('three-backend-composition-group-missing');
  }

  _applyRecordComposition(record) {
    if (!record.handle?.object) return;
    this._applyObjectComposition(record.handle.object, record.compositionGroup);
  }

  _applyObjectComposition(object, group) {
    const mask = this._composition === null || group === null
      ? (this._composition?.allGroupMask ?? 1)
      : (1 | this._composition.groupMasks.get(group));
    object.traverse((child) => { child.layers.mask = mask; });
  }

  _renderComposition(camera) {
    const renderer = this._renderer;
    const previousCameraMask = camera.layers.mask;
    const previousBackground = this._scene.background;
    const previousAutoClear = renderer.autoClear;
    const shadowMap = renderer.shadowMap ?? null;
    const previousShadowAutoUpdate = shadowMap?.autoUpdate;
    let depthMaterials = null;
    const programBackgrounds = [];
    this._scene.traverse((object) => {
      if (object.userData.sceneEngineProgramBackground)
        programBackgrounds.push([object, object.visible]);
    });
    try {
      renderer.autoClear = false;
      renderer.clear(true, true, true);
      camera.layers.mask = this._composition.passMasks[0];
      renderer.render(this._scene, camera);
      if (shadowMap && typeof previousShadowAutoUpdate === 'boolean') shadowMap.autoUpdate = false;

      this._scene.background = null;
      for (const [object] of programBackgrounds) object.visible = false;
      camera.layers.mask = this._composition.passMasks[1];
      renderer.render(this._scene, camera);

      renderer.clearDepth();
      depthMaterials = this._setProtectedColorWrite(false);
      camera.layers.mask = this._composition.passMasks[0];
      renderer.render(this._scene, camera);
      restoreColorWrite(depthMaterials);
      depthMaterials = null;

      camera.layers.mask = this._composition.passMasks[2];
      renderer.render(this._scene, camera);
    } finally {
      if (depthMaterials !== null) restoreColorWrite(depthMaterials);
      for (const [object, visible] of programBackgrounds) object.visible = visible;
      if (shadowMap && typeof previousShadowAutoUpdate === 'boolean') {
        shadowMap.autoUpdate = previousShadowAutoUpdate;
      }
      camera.layers.mask = previousCameraMask;
      this._scene.background = previousBackground;
      renderer.autoClear = previousAutoClear;
    }
  }

  _setProtectedColorWrite(value) {
    const materials = new Map();
    const collect = (object) => object?.traverse((child) => {
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!material || materials.has(material)) continue;
        materials.set(material, material.colorWrite);
        material.colorWrite = value;
      }
    });
    const batches = new Set();
    for (const record of this._bindings.values()) {
      if (!this._composition.protectedGroups.has(record.compositionGroup)) continue;
      if (record.batched && record.batch !== null) batches.add(record.batch);
      else collect(record.handle?.object);
    }
    for (const batch of batches) collect(batch.object);
    return materials;
  }

  _detachEmptyNodeRoots() {
    const children = this._root.children;
    const detached = [];
    let writeIndex = 0;
    for (const child of children) {
      if (child.children.length > 0) {
        children[writeIndex] = child;
        writeIndex += 1;
      } else {
        child.parent = null;
        detached.push(child);
      }
    }
    children.length = writeIndex;
    for (const child of detached) child.dispatchEvent({ type: 'removed' });
  }

  _detachAllNodeRoots() {
    const children = this._root.children;
    const detached = children.slice();
    children.length = 0;
    for (const child of detached) {
      child.parent = null;
      child.dispatchEvent({ type: 'removed' });
    }
  }

  _detachAllBatchObjects() {
    const children = this._batchRoot.children;
    const detached = children.slice();
    children.length = 0;
    for (const child of detached) {
      child.parent = null;
      child.dispatchEvent({ type: 'removed' });
    }
  }

  _linkRecordSignal(signal, controller) {
    if (!signal) return () => {};
    let hub = this._recordSignalHubs.get(signal);
    if (!hub) {
      const controllers = new Set();
      const abort = () => {
        for (const target of controllers) target.abort(signal.reason ?? 'binding-aborted');
      };
      hub = { controllers, abort, listening: true };
      this._recordSignalHubs.set(signal, hub);
      signal.addEventListener('abort', abort, { once: true });
    }
    hub.controllers.add(controller);
    if (signal.aborted) controller.abort(signal.reason ?? 'binding-aborted');
    let linked = true;
    return () => {
      if (!linked) return;
      linked = false;
      hub.controllers.delete(controller);
      if (!hub.listening || hub.controllers.size > 0) return;
      hub.listening = false;
      signal.removeEventListener('abort', hub.abort);
      if (this._recordSignalHubs.get(signal) === hub) this._recordSignalHubs.delete(signal);
    };
  }

  _clearRecordSignalHubs() {
    for (const [signal, hub] of this._recordSignalHubs) {
      if (hub.listening) signal.removeEventListener('abort', hub.abort);
      hub.listening = false;
      hub.controllers.clear();
    }
    this._recordSignalHubs.clear();
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

  _emitHealth({ phase, record = null, identity = record?.identity, resourceId = null, errorCode, recoverable, programDiagnostic = null }) {
    const event = Object.freeze({ phase,
      nodeName: identity?.nodeName ?? null,
      componentKey: identity?.componentKey ?? null,
      resourceId,
      ...(programDiagnostic ?? {}),
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
    'requestResize', 'pick', 'screenPointToWorldRay', 'pickProximity',
    'projectWorldPoint', 'focusWorldPoint', 'capture', 'whenIdle', 'diagnostics', 'dispose',
  ].map((method) => [method, implementation[method].bind(implementation)])));
}

function compileComposition(plan) {
  if (plan === null) return null;
  const groupMasks = new Map();
  let allGroupMask = 0;
  plan.groups.forEach((entry, index) => {
    const mask = 1 << (index + 1);
    groupMasks.set(entry.id, mask);
    allGroupMask |= mask;
  });
  const groupRanks = new Map();
  const passMasks = plan.passes.map((pass, rank) => {
    let mask = 0;
    for (const group of pass.groups) {
      mask |= groupMasks.get(group);
      groupRanks.set(group, rank);
    }
    return mask;
  });
  return Object.freeze({
    groupMasks,
    groupRanks,
    passMasks: Object.freeze(passMasks),
    allGroupMask,
    protectedGroups: new Set(plan.passes[0].groups),
  });
}

function continuousRecordIsActive(record) {
  if (!record.visible || record.programIsolated) return false;
  const predicate = record.handle.isContinuousDrawActive;
  return typeof predicate !== 'function' || predicate.call(record.handle) === true;
}

function restoreColorWrite(materials) {
  for (const [material, value] of materials) material.colorWrite = value;
}

function selectCompositionHit(hits, composition) {
  const nearestByRecord = new Map();
  for (const candidate of hits) {
    const current = nearestByRecord.get(candidate.record);
    if (current === undefined || candidate.hit.distance < current.hit.distance) {
      nearestByRecord.set(candidate.record, candidate);
    }
  }
  const candidates = [...nearestByRecord.values()];
  const protectedDistance = candidates
    .filter((candidate) => composition.protectedGroups.has(candidate.record.compositionGroup))
    .reduce((nearest, candidate) => Math.min(nearest, candidate.hit.distance),
      Number.POSITIVE_INFINITY);
  const visible = candidates.filter((candidate) => (
    composition.protectedGroups.has(candidate.record.compositionGroup)
      || candidate.hit.distance < protectedDistance
  ));
  visible.sort((left, right) => {
    const leftRank = composition.groupRanks.get(left.record.compositionGroup) ?? 0;
    const rightRank = composition.groupRanks.get(right.record.compositionGroup) ?? 0;
    if (leftRank !== rightRank) return rightRank - leftRank;
    if (left.hit.distance !== right.hit.distance) return left.hit.distance - right.hit.distance;
    return compareRecordIdentity(left.record, right.record);
  });
  return visible[0] ?? null;
}

function rejectProximityBehindProtected(candidates, composition) {
  const protectedAtPointer = candidates
    .filter((candidate) => composition.protectedGroups.has(candidate.record.compositionGroup)
      && candidate.screenDistancePixels === 0)
    .reduce((nearest, candidate) => Math.min(nearest, candidate.depth), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(protectedAtPointer)) return;
  let writeIndex = 0;
  for (const candidate of candidates) {
    if (!composition.protectedGroups.has(candidate.record.compositionGroup)
        && candidate.screenDistancePixels === 0 && candidate.depth >= protectedAtPointer) continue;
    candidates[writeIndex] = candidate;
    writeIndex += 1;
  }
  candidates.length = writeIndex;
}

function compareRecordIdentity(left, right) {
  if (left.identity.nodeName !== right.identity.nodeName) {
    return left.identity.nodeName < right.identity.nodeName ? -1 : 1;
  }
  if (left.identity.componentKey === right.identity.componentKey) return 0;
  return left.identity.componentKey < right.identity.componentKey ? -1 : 1;
}

function identityKey(value) { return JSON.stringify([value.nodeName, value.componentKey]); }
function addAttributeUpdates(attribute, itemIndices) {
  const pendingComponents = attribute.updateRanges.reduce(
    (total, range) => total + range.count,
    0,
  );
  if (pendingComponents + itemIndices.length * attribute.itemSize >= attribute.array.length / 4) {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, attribute.array.length);
  } else {
    itemIndices.sort((left, right) => left - right);
    let start = itemIndices[0]; let previous = start;
    for (let offset = 1; offset <= itemIndices.length; offset += 1) {
      const current = itemIndices[offset];
      if (current === previous + 1) { previous = current; continue; }
      attribute.addUpdateRange(
        start * attribute.itemSize,
        (previous - start + 1) * attribute.itemSize,
      );
      start = current; previous = current;
    }
  }
  attribute.needsUpdate = true;
}
function pointWithinCameraDepth(point, camera) {
  const viewPoint = point.clone().applyMatrix4(camera.matrixWorldInverse);
  const depth = -viewPoint.z;
  return Number.isFinite(depth) && depth >= camera.near && depth <= camera.far;
}
function viewportRect(hostElement) {
  let rect;
  try { rect = hostElement.getBoundingClientRect(); } catch {
    fail('three-backend-viewport-invalid');
  }
  const result = {
    left: Number(rect?.left),
    top: Number(rect?.top),
    width: Number(rect?.width),
    height: Number(rect?.height),
  };
  if (!Number.isFinite(result.left) || !Number.isFinite(result.top)
      || !Number.isFinite(result.width) || result.width <= 0
      || !Number.isFinite(result.height) || result.height <= 0) {
    fail('three-backend-viewport-invalid');
  }
  return result;
}
function clientPointToNdc(query, rect) {
  return new THREE.Vector2(
    ((query.clientX - rect.left) / rect.width) * 2 - 1,
    -((query.clientY - rect.top) / rect.height) * 2 + 1,
  );
}
function projectedBindingBounds(record, camera, rect, profile) {
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    depth: Number.POSITIVE_INFINITY,
    count: 0,
  };
  const anchorView = record.panelAnchorWorld === null ? null
    : new THREE.Vector3(...record.panelAnchorWorld).applyMatrix4(camera.matrixWorldInverse);
  const projectGeometry = (geometry, worldMatrix) => {
    if (record.componentType === 'render.sprite@3' && record.properties.projectionSemantics === 'anchor-extent') {
      const sprite = anchorExtentBounds(worldMatrix, record.properties, camera, profile);
      if (!sprite) return;
      bounds.minX = rect.left + (sprite.minX + 1) * rect.width / 2;
      bounds.maxX = rect.left + (sprite.maxX + 1) * rect.width / 2;
      bounds.minY = rect.top + (1 - sprite.maxY) * rect.height / 2;
      bounds.maxY = rect.top + (1 - sprite.minY) * rect.height / 2;
      bounds.depth = sprite.ndcDepth; bounds.count = 4;
      return;
    }
    if (!geometry?.isBufferGeometry) return;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!finiteBox(box) || box.isEmpty()) return;
    const viewCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
    for (let corner = 0; corner < 8; corner += 1) {
      const point = viewCorners[corner].set(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z,
      ).applyMatrix4(worldMatrix).applyMatrix4(camera.matrixWorldInverse);
      if (anchorView !== null) {
        compensatePanelViewPoint(point, anchorView, camera.isPerspectiveCamera, point);
      }
    }
    const projected = new THREE.Vector3();
    const includeViewPoint = (point) => {
      const viewDepth = -point.z;
      if (!Number.isFinite(viewDepth) || viewDepth < camera.near || viewDepth > camera.far) return;
      projected.copy(point).applyMatrix4(camera.projectionMatrix);
      projected.y = projectUpperFieldY(projected.y, profile);
      if (![projected.x, projected.y, projected.z].every(Number.isFinite)) return;
      const clientX = rect.left + (projected.x + 1) * rect.width / 2;
      const clientY = rect.top + (1 - projected.y) * rect.height / 2;
      bounds.minX = Math.min(bounds.minX, clientX);
      bounds.minY = Math.min(bounds.minY, clientY);
      bounds.maxX = Math.max(bounds.maxX, clientX);
      bounds.maxY = Math.max(bounds.maxY, clientY);
      bounds.depth = Math.min(bounds.depth, projected.z);
      bounds.count += 1;
    };
    for (const point of viewCorners) includeViewPoint(point);

    // A visible box can cross both clipping planes while every original
    // corner lies outside the camera depth interval. The clipped convex box
    // gains vertices where its twelve edges meet near or far; include those
    // vertices so the projected proxy cannot disappear at either plane.
    const clipped = new THREE.Vector3();
    for (const [startIndex, endIndex] of BOX_EDGES) {
      const start = viewCorners[startIndex]; const end = viewCorners[endIndex];
      const startDepth = -start.z; const endDepth = -end.z;
      if (!Number.isFinite(startDepth) || !Number.isFinite(endDepth)
          || startDepth === endDepth) continue;
      for (const planeDepth of [camera.near, camera.far]) {
        if ((startDepth < planeDepth && endDepth > planeDepth)
            || (startDepth > planeDepth && endDepth < planeDepth)) {
          clipped.lerpVectors(start, end, (planeDepth - startDepth) / (endDepth - startDepth));
          clipped.z = -planeDepth;
          includeViewPoint(clipped);
        }
      }
    }
  };

  if (record.batched) {
    const batch = record.batch;
    if (!batch || batch.records[record.batchIndex] !== record) return null;
    batch.object.updateWorldMatrix(true, false);
    const instanceMatrix = new THREE.Matrix4();
    batch.object.getMatrixAt(record.batchIndex, instanceMatrix);
    if (instanceMatrix.elements.slice(0, 3).every((entry) => entry === 0)) return null;
    const worldMatrix = new THREE.Matrix4().multiplyMatrices(
      batch.object.matrixWorld, instanceMatrix,
    );
    projectGeometry(batch.object.geometry, worldMatrix);
  } else {
    record.handle.object.updateWorldMatrix(true, true);
    updateVisibleLods(record.handle.object, camera);
    record.handle.object.traverseVisible((object) => {
      projectGeometry(object.geometry, object.matrixWorld);
    });
  }
  return bounds.count === 0 ? null : bounds;
}
function finiteBox(box) {
  return box?.isBox3 === true
    && [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
      .every(Number.isFinite);
}
function updateVisibleLods(object, camera) {
  if (!object.visible) return;
  if (object.isLOD && object.autoUpdate) object.update(camera);
  for (const child of object.children) updateVisibleLods(child, camera);
}
function distanceToBounds(clientX, clientY, bounds) {
  const deltaX = clientX < bounds.minX ? bounds.minX - clientX
    : (clientX > bounds.maxX ? clientX - bounds.maxX : 0);
  const deltaY = clientY < bounds.minY ? bounds.minY - clientY
    : (clientY > bounds.maxY ? clientY - bounds.maxY : 0);
  return Math.hypot(deltaX, deltaY);
}
function compareProximityCandidates(left, right) {
  if (left.screenDistancePixels !== right.screenDistancePixels) {
    return left.screenDistancePixels - right.screenDistancePixels;
  }
  if (left.compositionRank !== right.compositionRank) {
    return right.compositionRank - left.compositionRank;
  }
  if (left.depth !== right.depth) return left.depth - right.depth;
  return compareRecordIdentity(left.record, right.record);
}
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
function requireRenderer(value) { for (const method of [
  'setPixelRatio', 'setSize', 'render', 'clear', 'clearDepth', 'dispose',
]) {
  if (!value || typeof value[method] !== 'function') fail('three-renderer-invalid'); } }
function renderCpuSummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (ratio) => sorted.length ? sorted[Math.ceil(sorted.length * ratio) - 1] : null;
  return Object.freeze({ samples: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    maximumMs: sorted.at(-1) ?? null, measurement: 'cpu-render-submit-only' });
}
function rendererInfo(renderer) { const render = renderer.info?.render; const memory = renderer.info?.memory;
  return render && memory ? { calls: render.calls, triangles: render.triangles ?? 0,
    points: render.points ?? 0, lines: render.lines ?? 0,
    programs: renderer.info.programs?.length ?? 0,
    geometries: memory.geometries, textures: memory.textures } : null; }
