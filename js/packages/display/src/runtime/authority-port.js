import { AuthorityComponent } from '../component/authority-component.js';
import { BehaviourComponent } from '../component/behaviour-component.js';
import { dispatchComponentEvent } from '../component/component.js';
import {
  cloneAndFreezeJson,
  exactKeys,
  plainRecord,
  protocolName,
  safeInteger,
} from '../internal.js';
import { Node } from '../node/node.js';
import { AUTHORITY_PREFIX } from '../node/node-name.js';
import { AuthorityMatrixPool, authorityNodeId, authorityNodeName } from './authority-matrix-pool.js';
import { fail } from './health.js';

export class AuthorityPort {
  #authorityEntries = [];

  constructor({ scene, prefabInstantiator, componentContext, onMutation, onCleanupErrors,
    assertMutable, onDiagnostic }) {
    this._scene = scene;
    this._prefabInstantiator = prefabInstantiator;
    this._componentContext = componentContext;
    this._onMutation = onMutation;
    this._onCleanupErrors = onCleanupErrors;
    this._assertMutable = assertMutable;
    this._onDiagnostic = onDiagnostic;
    this._matrixPool = new AuthorityMatrixPool();
    this._gaps = new Map();
  }

  installNodeMatrixPool(value) {
    this._assertMutable?.();
    const record = exactKeys(value, ['poolSize', 'matrices'], [],
      'display-authority-matrix-pool-invalid');
    this._matrixPool.install(record);
  }

  applyNodeTransformBatch(value) {
    this._assertMutable?.();
    const record = exactKeys(value, ['poolSize', 'nodeIds', 'matrices'], [],
      'display-authority-transform-batch-invalid');
    if (!(record.nodeIds instanceof Uint32Array)) {
      fail('display-authority-transform-batch-invalid');
    }
    this._matrixPool.applyBatch(record);
  }

  createNode(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'parentNodeId', 'displayKindId', 'transformMode',
      'visible', 'state'], [], 'display-authority-command-invalid');
    const nodeId = authorityNodeId(record.nodeId);
    const name = authorityNodeName(nodeId);
    const parent = this._resolveParent(record.parentNodeId);
    return this._createNode({
      name,
      parent,
      displayKindId: record.displayKindId,
      transformMode: record.transformMode,
      visible: record.visible,
      state: record.state,
      nodeId,
    });
  }

  _createNode({ name, parent, displayKindId, transformMode, visible, state: stateValue, nodeId }) {
    if (this._scene.nodeIndex.has(name)) fail('display-node-name-duplicate');
    const state = cloneAndFreezeJson(stateValue, 'display-authority-state-invalid');
    const resolution = this._resolveDisplayKind(displayKindId, state, nodeId);
    let validatedPatch = null;
    if (resolution.compiled !== null) {
      // Selector and Prefab resolver/schema validation happen before live mutation.
      validatedPatch = this._prefabInstantiator.resolveAndValidateState(
        resolution.compiled,
        state,
        null,
        {},
        { ownerName: name, parentNode: parent },
      );
      this._scene.nodeGraph.validateSubtreePlacement(parent, validatedPatch.graphHeight);
    }
    const authority = new AuthorityComponent({
      displayKindId,
      prefabId: resolution.prefabId,
      transformMode,
      state,
    });
    this._matrixPool.claim(nodeId);
    let root = null;
    let scope = null;
    try {
      root = new Node({
        name,
        sceneToken: this._scene.sceneToken,
        authorityMatrixPool: this._matrixPool,
        authorityNodeId: nodeId,
        visible,
      });
      root.addComponent(authority);
      root._setAuthorityOwner(name);
      this._scene.nodeIndex.register(root);
      this._scene.nodeGraph.attach(root, parent);
      authority.attach(root, this._componentContext);
      if (resolution.compiled !== null) {
        scope = this._prefabInstantiator.prepareExistingRoot({
          root,
          compiled: resolution.compiled,
          initialState: state,
          authorityOwnerName: name,
          validatedPatch,
        });
      }
      this._scene.nodeGraph.flushWorldTransforms();
      this._onMutation?.();
      this.#authorityEntries[nodeId] = { node: root, authority };
      this._setGap(nodeId, resolution.gap);
      return nodeId;
    } catch (error) {
      if (scope) this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope, 'create-rollback'));
      this._onCleanupErrors?.(authority.dispose('create-rollback'));
      root?._components.delete(authority.key);
      if (root?._graph && root._children.length === 0) root._graph.detach(root);
      if (root !== null && this._scene.nodeIndex.get(name) === root) {
        this._scene.nodeIndex.unregister(root);
      }
      root?._markDisposed();
      if (this._matrixPool.has(nodeId)) this._matrixPool.release(nodeId);
      this.#authorityEntries[nodeId] = null;
      throw error;
    }
  }

  setNodeTransforms(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeIds'], [], 'display-authority-command-invalid');
    if (!(record.nodeIds instanceof Uint32Array) || record.nodeIds.length === 0) {
      fail('display-authority-transform-batch-invalid');
    }
    const entries = [];
    for (const nodeId of record.nodeIds) {
      const entry = this._requireAuthority(authorityNodeId(nodeId));
      if (entry.authority.transformMode !== 'live') {
        fail('display-authority-transform-initial');
      }
      entries.push(entry);
    }
    this._matrixPool.consumeMany(record.nodeIds);
    for (const { node, nodeId } of entries) {
      node._markAuthorityTransformChanged(this._matrixPool, nodeId);
    }
    this._onMutation?.();
  }

  setNodeParent(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'parentNodeId'], [],
      'display-authority-command-invalid');
    const { node, authority } = this._requireAuthority(record.nodeId);
    if (authority.transformMode !== 'live') fail('display-authority-transform-initial');
    const parent = this._resolveParent(record.parentNodeId);
    this._scene.nodeGraph.reparent(node, parent);
    this._onMutation?.();
  }

  setNodeVisible(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'visible'], [],
      'display-authority-command-invalid');
    const { node } = this._requireAuthority(record.nodeId);
    if (typeof record.visible !== 'boolean') fail('display-node-visibility-invalid');
    node.setVisible(record.visible);
    this._onMutation?.();
  }

  setNodeState(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'state'], [],
      'display-authority-command-invalid');
    return this._setNodeState(record.nodeId, record.state);
  }

  setNodeProperty(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'propertyName', 'value'], [],
      'display-authority-command-invalid');
    const propertyName = protocolName(record.propertyName, 'display-property-name-invalid');
    const value = cloneAndFreezeJson(record.value, 'display-property-value-invalid', 255);
    const { authority } = this._requireAuthority(record.nodeId);
    const candidate = { ...authority.state };
    Object.defineProperty(candidate, propertyName, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return this._setNodeState(record.nodeId,
      cloneAndFreezeJson(candidate, 'display-authority-state-invalid'));
  }

  unsetNodeProperty(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'propertyName'], [],
      'display-authority-command-invalid');
    const propertyName = protocolName(record.propertyName, 'display-property-name-invalid');
    const { authority } = this._requireAuthority(record.nodeId);
    if (!Object.hasOwn(authority.state, propertyName)) {
      fail('display-authority-property-missing');
    }
    const candidate = { ...authority.state };
    delete candidate[propertyName];
    return this._setNodeState(record.nodeId,
      cloneAndFreezeJson(candidate, 'display-authority-state-invalid'));
  }

  emitNodeEvent(command) {
    this._assertMutable?.();
    const record = exactKeys(command, [
      'nodeId', 'eventName', 'payload', 'commandSeq', 'sourceTick',
    ], [], 'display-authority-command-invalid');
    const eventName = protocolName(record.eventName, 'display-event-name-invalid');
    const payload = cloneAndFreezeJson(
      plainRecord(record.payload, 'display-event-payload-invalid'),
      'display-event-payload-invalid',
    );
    const event = Object.freeze({
      eventName,
      payload,
      commandSeq: safeInteger(record.commandSeq, 'display-event-command-seq-invalid', {
        minimum: 0,
      }),
      sourceTick: safeInteger(record.sourceTick, 'display-event-source-tick-invalid', {
        minimum: 0,
      }),
    });
    const { node, authority } = this._requireAuthority(record.nodeId);
    if (authority.prefabId === null) {
      // A known or unknown visual gap has no event surface. The ordered event is a
      // successful empty delivery so missing art cannot withhold the Engine ACK.
      this._onMutation?.();
      return;
    }
    const rootRecord = this._prefabInstantiator.requireRootRecord(node);
    if (!rootRecord.compiled.definition.events.includes(eventName)) {
      fail('display-authority-event-unknown');
    }
    // Resolve the complete target set before invoking user code. Nested Prefab records
    // are deliberately excluded: one authority Node addresses only its outer Prefab.
    const targets = [...rootRecord.componentByPath.values()]
      .filter((component) => {
        if (!(component instanceof BehaviourComponent)
            || component.disposed || !component.enabled) return false;
        const descriptor = rootRecord.compiled.componentRegistry.require(
          component.constructor.typeId,
        );
        return descriptor.eventNames.includes(eventName);
      });
    for (const component of targets) dispatchComponentEvent(component, event);
    this._onMutation?.();
  }

  _setNodeState(reference, stateValue) {
    const { authority } = this._requireAuthority(reference);
    return this._setNodeDisplayKindAndState(reference, authority.displayKindId, stateValue);
  }

  setNodeDisplayKind(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'displayKindId', 'state'], [],
      'display-authority-command-invalid');
    return this._setNodeDisplayKindAndState(
      record.nodeId,
      record.displayKindId,
      record.state,
    );
  }

  _setNodeDisplayKindAndState(reference, displayKindId, stateValue) {
    const { node, authority, nodeId } = this._requireAuthority(reference);
    const state = cloneAndFreezeJson(stateValue, 'display-authority-state-invalid');
    const resolution = this._resolveDisplayKind(displayKindId, state, nodeId);
    const currentScope = this._prefabInstantiator.getScope(node);
    if (resolution.compiled === null) {
      if (currentScope !== null) {
        this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(
          currentScope,
          'display-kind-unmaterialized',
        ));
      }
      authority._setDisplayKind(displayKindId, null, state);
      this._setGap(nodeId, resolution.gap);
      this._scene.nodeGraph.flushWorldTransforms();
      this._onMutation?.();
      return;
    }
    if (authority.prefabId === resolution.prefabId && currentScope !== null) {
      this._prefabInstantiator.reconcileState(currentScope, state);
      authority._setDisplayKind(displayKindId, resolution.prefabId, state);
      this._setGap(nodeId, null);
      this._onMutation?.();
      return;
    }
    if (currentScope === null) {
      const validatedPatch = this._prefabInstantiator.resolveAndValidateState(
        resolution.compiled,
        state,
        null,
        {},
        { ownerName: node.name, parentNode: node.parent },
      );
      this._scene.nodeGraph.validateSubtreePlacement(node.parent, validatedPatch.graphHeight);
      this._prefabInstantiator.prepareExistingRoot({
        root: node,
        compiled: resolution.compiled,
        initialState: state,
        authorityOwnerName: node.name,
        validatedPatch,
      });
      authority._setDisplayKind(displayKindId, resolution.prefabId, state);
      this._setGap(nodeId, null);
      this._scene.nodeGraph.flushWorldTransforms();
      this._onMutation?.();
      return;
    }
    this._replaceMaterialization({
      node,
      authority,
      nodeId,
      displayKindId,
      state,
      prefabId: resolution.prefabId,
      compiled: resolution.compiled,
    });
  }

  _replaceMaterialization({ node, authority, nodeId, displayKindId, state,
    prefabId, compiled }) {
    const validatedPatch = this._prefabInstantiator.resolveAndValidateState(
      compiled,
      state,
      null,
      {},
      { ownerName: node.name, parentNode: node.parent },
    );
    const replacementAuthority = new AuthorityComponent({
      displayKindId,
      prefabId,
      transformMode: authority.transformMode,
      state,
    });
    const authorityChildren = node._children.filter((child) => child.name.startsWith(AUTHORITY_PREFIX));
    const originalChildren = [...node._children];
    const shadow = this._prefabInstantiator.createShadow({
      target: node,
      compiled,
      state,
      authorityComponent: replacementAuthority,
      validatedPatch,
      preservedAuthorityChildNames: authorityChildren.map((child) => child.name),
    });
    const oldScope = this._prefabInstantiator.getScope(node);
    const oldParent = node.parent;
    try {
      this._prefabInstantiator.validateShadowPlacement(shadow, oldParent);
    } catch (error) {
      this._onCleanupErrors?.(this._prefabInstantiator.disposeShadow(shadow,
        'shadow-placement-rejected'));
      throw error;
    }
    let suspended = null;
    try {
      for (const child of authorityChildren) {
        this._scene.nodeGraph.reparent(child, this._scene.authorityRootNode);
      }
      suspended = this._prefabInstantiator.suspendLiveScope(oldScope);
      this._prefabInstantiator.adoptShadow(shadow, oldParent, this._componentContext);
      shadow.root._bindAuthorityMatrixPool(this._matrixPool, nodeId);
    } catch (error) {
      if (suspended?.active) {
        try { this._prefabInstantiator.restoreSuspendedScope(suspended); } catch {
          /* preserve the adoption error */
        }
      }
      for (const child of authorityChildren) {
        if (child.parent === this._scene.authorityRootNode && node._graph === this._scene.nodeGraph) {
          try { this._scene.nodeGraph.reparent(child, node); } catch { /* preserve adoption error */ }
        }
      }
      if (node._graph === this._scene.nodeGraph) {
        try { this._scene.nodeGraph.restoreChildOrder(node, originalChildren); } catch {
          /* preserve the adoption error */
        }
      }
      this._onCleanupErrors?.(this._prefabInstantiator.disposeShadow(shadow,
        'shadow-adoption-rejected'));
      throw error;
    }

    this._prefabInstantiator.finalizeSuspendedScope(suspended);
    this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(oldScope, 'prefab-replaced'));
    this._onCleanupErrors?.(authority.dispose('prefab-replaced'));
    node._components.delete(authority.key);
    node._markDisposed();
    this.#authorityEntries[nodeId] = {
      node: shadow.root,
      authority: replacementAuthority,
    };
    this._setGap(nodeId, null);
    for (const child of authorityChildren) this._scene.nodeGraph.reparent(child, shadow.root);
    this._scene.nodeGraph.flushWorldTransforms();
    this._onMutation?.();
  }

  removeNode(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId'], [], 'display-authority-command-invalid');
    return this._removeNode(record.nodeId);
  }

  _removeNode(reference) {
    const { node, authority, nodeId } = this._requireAuthority(reference);
    if (this._hasAuthorityDescendant(node)) fail('display-authority-descendant-exists');
    const scope = this._prefabInstantiator.getScope(node);
    this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope, 'authority-removed'));
    this._onCleanupErrors?.(authority.dispose('authority-removed'));
    node._components.delete(authority.key);
    this._scene.nodeGraph.detach(node);
    this._scene.nodeIndex.unregister(node);
    this._matrixPool.release(nodeId);
    node._markDisposed();
    this.#authorityEntries[nodeId] = null;
    this._setGap(nodeId, null);
    this._onMutation?.();
  }

  _requireAuthority(reference) {
    const nodeId = authorityNodeId(reference);
    const entry = this.#authorityEntries[nodeId];
    if (entry === undefined || entry === null) {
      // Preserve the public missing-node error while keeping the common numeric
      // lookup independent of canonical-name construction and string indexing.
      this._scene.nodeIndex.require(authorityNodeName(nodeId));
      fail('display-authority-matrix-node-invalid');
    }
    if (!this._matrixPool.has(nodeId)
        || entry.node.disposed
        || entry.authority.disposed
        || entry.node._authorityMatrixPool !== this._matrixPool
        || entry.node._authorityNodeId !== nodeId) {
      fail('display-authority-matrix-node-invalid');
    }
    const { node, authority } = entry;
    return { node, authority, nodeId };
  }
  _resolveParent(reference) {
    if (reference === null) return this._scene.authorityRootNode;
    return this._requireAuthority(authorityNodeId(reference)).node;
  }
  _resolveDisplayKind(displayKindId, state, nodeId) {
    const definition = this._scene.registries.displayKindRegistry.get(displayKindId);
    if (definition === null) {
      return {
        prefabId: null,
        compiled: null,
        gap: this._gap(nodeId, displayKindId,
          'display-kind-unknown-requirement', 'warning'),
      };
    }
    if (definition.authorityPrefabIds.length === 0) {
      return {
        prefabId: null,
        compiled: null,
        gap: this._gap(nodeId, displayKindId,
          'display-kind-unimplemented', 'warning'),
      };
    }
    const prefabId = definition.resolvePrefab(state);
    if (prefabId === null) {
      return {
        prefabId: null,
        compiled: null,
        gap: this._gap(nodeId, displayKindId,
          'display-kind-selection-unresolved', 'error'),
      };
    }
    return {
      prefabId,
      compiled: this._scene.registries.compiledPrefabCatalog.require(prefabId),
      gap: null,
    };
  }

  _gap(nodeId, displayKindId, code, severity) {
    return Object.freeze({ nodeId, displayKindId, code, severity });
  }

  _setGap(nodeId, current) {
    const previous = this._gaps.get(nodeId) ?? null;
    if (previous?.code === current?.code
        && previous?.displayKindId === current?.displayKindId) return;
    if (current === null) this._gaps.delete(nodeId);
    else this._gaps.set(nodeId, current);
    try {
      this._onDiagnostic?.(Object.freeze({ nodeId, previous, current }));
    } catch { /* diagnostics observers are best-effort */ }
  }

  currentDiagnostics() {
    const gaps = Object.freeze([...this._gaps.values()]
      .sort((left, right) => left.nodeId - right.nodeId));
    return Object.freeze({
      schema: 'scene-engine-display-diagnostics@1',
      warningCount: gaps.filter((entry) => entry.severity === 'warning').length,
      errorCount: gaps.filter((entry) => entry.severity === 'error').length,
      gaps,
    });
  }
  _hasAuthorityDescendant(node) {
    const visit = (current) => current._children.some((child) => child.name.startsWith(AUTHORITY_PREFIX) || visit(child));
    return visit(node);
  }

  _assertMatrixPoolSettled() { this._matrixPool.assertSettled(); }
  _release() {
    this._matrixPool.releaseOwner();
    this.#authorityEntries.length = 0;
    this._gaps.clear();
  }
}
