import { AuthorityComponent } from '../component/authority-component.js';
import { cloneAndFreeze, exactKeys } from '../internal.js';
import { Node } from '../node/node.js';
import { AUTHORITY_PREFIX } from '../node/node-name.js';
import { AuthorityMatrixPool, authorityNodeId, authorityNodeName } from './authority-matrix-pool.js';
import { fail } from './health.js';

export class AuthorityPort {
  #authorityEntries = [];

  constructor({ scene, prefabInstantiator, componentContext, onMutation, onCleanupErrors,
    assertMutable }) {
    this._scene = scene;
    this._prefabInstantiator = prefabInstantiator;
    this._componentContext = componentContext;
    this._onMutation = onMutation;
    this._onCleanupErrors = onCleanupErrors;
    this._assertMutable = assertMutable;
    this._matrixPool = new AuthorityMatrixPool();
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
    const record = exactKeys(command, ['nodeId', 'parentNodeId', 'prefabId', 'transformMode',
      'visible', 'state'], [], 'display-authority-command-invalid');
    const nodeId = authorityNodeId(record.nodeId);
    const name = authorityNodeName(nodeId);
    const parent = this._resolveParent(record.parentNodeId);
    return this._createNode({
      name,
      parent,
      prefabId: record.prefabId,
      transformMode: record.transformMode,
      visible: record.visible,
      state: record.state,
      nodeId,
    });
  }

  _createNode({ name, parent, prefabId, transformMode, visible, state: stateValue, nodeId }) {
    if (this._scene.nodeIndex.has(name)) fail('display-node-name-duplicate');
    const definition = this._resolvePrefab(prefabId);
    const compiled = this._scene.registries.compiledPrefabCatalog.require(definition.id);
    const state = cloneAndFreeze(stateValue, 'display-authority-state-invalid');
    // Resolver/schema validation occurs before the first live mutation.
    const validatedPatch = this._prefabInstantiator.resolveAndValidateState(
      compiled,
      state,
      null,
      {},
      { ownerName: name },
    );
    this._scene.nodeGraph.validateSubtreePlacement(parent, validatedPatch.graphHeight);
    const authority = new AuthorityComponent({
      prefabId: definition.id,
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
      this._scene.nodeIndex.register(root);
      this._scene.nodeGraph.attach(root, parent);
      authority.attach(root, this._componentContext);
      scope = this._prefabInstantiator.prepareExistingRoot({
        root,
        compiled,
        initialState: state,
        authorityOwnerName: name,
        validatedPatch,
      });
      this._scene.nodeGraph.flushWorldTransforms();
      this._onMutation?.();
      this.#authorityEntries[nodeId] = { node: root, authority };
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

  setNodeTransform(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId'], [], 'display-authority-command-invalid');
    const nodeId = authorityNodeId(record.nodeId);
    const { node, authority } = this._requireAuthority(nodeId);
    if (authority.transformMode !== 'live') fail('display-authority-transform-initial');
    this._matrixPool.consume(nodeId);
    node._markAuthorityTransformChanged(this._matrixPool, nodeId);
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

  _setNodeState(reference, stateValue) {
    const { node, authority } = this._requireAuthority(reference);
    const state = cloneAndFreeze(stateValue, 'display-authority-state-invalid');
    const scope = this._prefabInstantiator.getScope(node);
    if (!scope) fail('display-prefab-scope-missing');
    this._prefabInstantiator.reconcileState(scope, state);
    authority._setState(state);
    this._onMutation?.();
  }

  replaceNodePrefab(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['nodeId', 'prefabId', 'state'], [],
      'display-authority-command-invalid');
    return this._replaceNodePrefab(record.nodeId, record.prefabId, record.state);
  }

  _replaceNodePrefab(reference, prefabId, stateValue) {
    const { node, authority, nodeId } = this._requireAuthority(reference);
    const definition = this._resolvePrefab(prefabId);
    const compiled = this._scene.registries.compiledPrefabCatalog.require(definition.id);
    const state = cloneAndFreeze(stateValue, 'display-authority-state-invalid');
    const validatedPatch = this._prefabInstantiator.resolveAndValidateState(
      compiled,
      state,
      null,
      {},
      { ownerName: node.name },
    );
    const replacementAuthority = new AuthorityComponent({
      prefabId: definition.id,
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
  _resolvePrefab(prefabId) {
    return this._scene.registries.prefabRegistry.require(prefabId);
  }
  _hasAuthorityDescendant(node) {
    const visit = (current) => current._children.some((child) => child.name.startsWith(AUTHORITY_PREFIX) || visit(child));
    return visit(node);
  }

  _assertMatrixPoolSettled() { this._matrixPool.assertSettled(); }
  _release() {
    this._matrixPool.releaseOwner();
    this.#authorityEntries.length = 0;
  }
}
