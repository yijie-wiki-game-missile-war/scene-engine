import { AuthorityComponent } from '../component/authority-component.js';
import { cloneAndFreeze, exactKeys } from '../internal.js';
import { normalizeTransform } from '../math/transform.js';
import { Node } from '../node/node.js';
import { AUTHORITY_PREFIX, assertNodePrefix } from '../node/node-name.js';
import { fail } from './health.js';

export class AuthorityPort {
  constructor({ scene, prefabInstantiator, componentContext, onMutation, onCleanupErrors,
    assertMutable }) {
    this._scene = scene;
    this._prefabInstantiator = prefabInstantiator;
    this._componentContext = componentContext;
    this._onMutation = onMutation;
    this._onCleanupErrors = onCleanupErrors;
    this._assertMutable = assertMutable;
  }

  createNode(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name', 'parentName', 'prefabId', 'transformMode',
      'transform', 'visible', 'state'], [], 'display-authority-command-invalid');
    const name = assertNodePrefix(record.name, 'py');
    if (this._scene.nodeIndex.has(name)) fail('display-node-name-duplicate');
    const parent = this._resolveParent(record.parentName);
    const definition = this._resolvePrefab(record.prefabId);
    const compiled = definition.compile(this._scene.registries);
    const transform = normalizeTransform(record.transform);
    if (typeof record.visible !== 'boolean') fail('display-node-visibility-invalid');
    const state = cloneAndFreeze(record.state, 'display-authority-state-invalid');
    // Resolver/schema validation occurs before the first live mutation.
    const validatedPatch = this._prefabInstantiator.resolveAndValidateState(compiled, state);
    const root = new Node({ name, sceneToken: this._scene.sceneToken,
      transform, visible: record.visible });
    const authority = new AuthorityComponent({
      prefabId: definition.id,
      transformMode: record.transformMode,
      state,
    });
    root.addComponent(authority);
    let scope = null;
    try {
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
      return name;
    } catch (error) {
      if (scope) this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope, 'create-rollback'));
      this._onCleanupErrors?.(authority.dispose('create-rollback'));
      root._components.delete(authority.key);
      if (root._graph && root._children.length === 0) root._graph.detach(root);
      if (this._scene.nodeIndex.get(name) === root) this._scene.nodeIndex.unregister(root);
      root._markDisposed();
      throw error;
    }
  }

  setNodeTransform(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name', 'transform'], [], 'display-authority-command-invalid');
    const { node, authority } = this._requireAuthority(record.name);
    if (authority.transformMode !== 'live') fail('display-authority-transform-initial');
    const transform = normalizeTransform(record.transform);
    node.setLocalTransform(transform);
    this._onMutation?.();
  }

  setNodeParent(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name', 'parentName'], [], 'display-authority-command-invalid');
    const { node, authority } = this._requireAuthority(record.name);
    if (authority.transformMode !== 'live') fail('display-authority-transform-initial');
    const parent = this._resolveParent(record.parentName);
    this._scene.nodeGraph.reparent(node, parent);
    this._onMutation?.();
  }

  setNodeVisible(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name', 'visible'], [], 'display-authority-command-invalid');
    const { node } = this._requireAuthority(record.name);
    if (typeof record.visible !== 'boolean') fail('display-node-visibility-invalid');
    node.setVisible(record.visible);
    this._onMutation?.();
  }

  setNodeState(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name', 'state'], [], 'display-authority-command-invalid');
    const { node, authority } = this._requireAuthority(record.name);
    const state = cloneAndFreeze(record.state, 'display-authority-state-invalid');
    const scope = this._prefabInstantiator.getScope(node);
    if (!scope) fail('display-prefab-scope-missing');
    const patch = this._prefabInstantiator.resolveAndValidateState(scope.compiled, state, scope);
    this._prefabInstantiator.applyValidatedPatch(scope, patch);
    scope.state = state;
    authority._setState(state);
    this._onMutation?.();
  }

  replaceNodePrefab(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name', 'prefabId', 'state'], [],
      'display-authority-command-invalid');
    const { node, authority } = this._requireAuthority(record.name);
    const definition = this._resolvePrefab(record.prefabId);
    const compiled = definition.compile(this._scene.registries);
    const state = cloneAndFreeze(record.state, 'display-authority-state-invalid');
    const validatedPatch = this._prefabInstantiator.resolveAndValidateState(compiled, state);
    const replacementAuthority = new AuthorityComponent({
      prefabId: definition.id,
      transformMode: authority.transformMode,
      state,
    });
    const shadow = this._prefabInstantiator.createShadow({
      target: node,
      compiled,
      state,
      authorityComponent: replacementAuthority,
      validatedPatch,
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
    const authorityChildren = node._children.filter((child) => child.name.startsWith(AUTHORITY_PREFIX));

    for (const child of authorityChildren) this._scene.nodeGraph.reparent(child, this._scene.authorityRootNode);
    this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(oldScope, 'prefab-replaced'));
    this._onCleanupErrors?.(authority.dispose('prefab-replaced'));
    node._components.delete(authority.key);
    this._scene.nodeGraph.detach(node);
    this._scene.nodeIndex.unregister(node);
    node._markDisposed();

    this._prefabInstantiator.adoptShadow(shadow, oldParent, this._componentContext);
    for (const child of authorityChildren) this._scene.nodeGraph.reparent(child, shadow.root);
    this._scene.nodeGraph.flushWorldTransforms();
    this._onMutation?.();
  }

  removeNode(command) {
    this._assertMutable?.();
    const record = exactKeys(command, ['name'], [], 'display-authority-command-invalid');
    const { node, authority } = this._requireAuthority(record.name);
    if (this._hasAuthorityDescendant(node)) fail('display-authority-descendant-exists');
    const scope = this._prefabInstantiator.getScope(node);
    this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope, 'authority-removed'));
    this._onCleanupErrors?.(authority.dispose('authority-removed'));
    node._components.delete(authority.key);
    this._scene.nodeGraph.detach(node);
    this._scene.nodeIndex.unregister(node);
    node._markDisposed();
    this._onMutation?.();
  }

  _requireAuthority(name) {
    const canonical = assertNodePrefix(name, 'py');
    const node = this._scene.nodeIndex.require(canonical);
    return { node, authority: node.requireComponent(AuthorityComponent) };
  }
  _resolveParent(name) {
    if (name === null) return this._scene.authorityRootNode;
    return this._scene.nodeIndex.require(assertNodePrefix(name, 'py'));
  }
  _resolvePrefab(prefabId) {
    return this._scene.registries.prefabRegistry.require(prefabId);
  }
  _hasAuthorityDescendant(node) {
    const visit = (current) => current._children.some((child) => child.name.startsWith(AUTHORITY_PREFIX) || visit(child));
    return visit(node);
  }
}
