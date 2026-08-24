import { cloneAndFreeze, exactKeys, nonemptyString } from '../internal.js';
import { normalizeTransform } from '../math/transform.js';
import { Node } from '../node/node.js';
import { assertNodePrefix, parseNodeName } from '../node/node-name.js';
import { fail } from './health.js';

export class LocalEditPort {
  constructor({ scene, prefabInstantiator, componentContext, onMutation, onCleanupErrors,
    assertMutable }) {
    this._scene = scene;
    this._prefabInstantiator = prefabInstantiator;
    this._componentContext = componentContext;
    this._onMutation = onMutation;
    this._onCleanupErrors = onCleanupErrors;
    this._assertMutable = assertMutable;
    this._editorScopes = new Map();
    this._disposed = false;
  }

  instantiatePrefab(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'parentName', 'prefabType', 'transform',
      'visible', 'state'], [], 'display-local-edit-command-invalid');
    const name = assertNodePrefix(record.name, 'editor');
    if (this._scene.nodeIndex.has(name)) fail('display-node-name-duplicate');
    const parent = record.parentName === null
      ? this._scene.rootNode : this._requireEditable(record.parentName);
    const definition = this._scene.registries.prefabRegistry.require(
      this._scene.compiledDefinition.sceneProfile,
      nonemptyString(record.prefabType, 'display-prefab-type-invalid'),
    );
    const compiled = definition.compile(this._scene.registries);
    const transform = normalizeTransform(record.transform);
    if (typeof record.visible !== 'boolean') fail('display-node-visibility-invalid');
    const state = cloneAndFreeze(record.state, 'display-prefab-state-invalid');
    const validatedPatch = this._prefabInstantiator.resolveAndValidateState(compiled, state);
    const root = new Node({ name, sceneToken: this._scene.sceneToken, transform,
      visible: record.visible });
    let scope = null;
    try {
      this._scene.nodeIndex.register(root);
      this._scene.nodeGraph.attach(root, parent);
      scope = this._prefabInstantiator.prepareExistingRoot({
        root,
        compiled,
        initialState: state,
        authorityOwnerName: null,
        validatedPatch,
      });
      scope.removeRootOnDispose = true;
      this._editorScopes.set(name, scope);
      this._scene.nodeGraph.flushWorldTransforms();
      this._onMutation?.();
      return name;
    } catch (error) {
      if (scope) this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope,
        'local-edit-create-rollback'));
      if (root._graph && root._children.length === 0) root._graph.detach(root);
      if (this._scene.nodeIndex.get(name) === root) this._scene.nodeIndex.unregister(root);
      if (!root.disposed) root._markDisposed();
      throw error;
    }
  }

  setNodeTransform(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'transform'], [], 'display-local-edit-command-invalid');
    this._requireEditable(record.name).setLocalTransform(normalizeTransform(record.transform));
    this._onMutation?.();
  }

  setNodeVisible(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'visible'], [], 'display-local-edit-command-invalid');
    if (typeof record.visible !== 'boolean') fail('display-node-visibility-invalid');
    this._requireEditable(record.name).setVisible(record.visible);
    this._onMutation?.();
  }

  reparentNode(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'parentName'], [], 'display-local-edit-command-invalid');
    const node = this._requireEditable(record.name);
    if (node.name.startsWith('prefab/')) fail('display-local-edit-prefab-structure-forbidden');
    const parent = record.parentName === null
      ? this._scene.rootNode : this._requireEditable(record.parentName);
    this._scene.nodeGraph.reparent(node, parent);
    this._onMutation?.();
  }

  setComponentProperties(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'componentKey', 'patch'], [],
      'display-local-edit-command-invalid');
    const component = this._requireEditable(record.name).requireComponent(record.componentKey);
    const registry = this._scene.registries.componentRegistry;
    const properties = registry.validatePatch(component, record.patch);
    registry.validateResourceReferences(component.constructor.typeId, properties,
      this._scene.registries.resourceRegistry);
    component._replaceNormalizedProperties(properties);
    this._onMutation?.();
  }

  setComponentEnabled(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'componentKey', 'enabled'], [],
      'display-local-edit-command-invalid');
    if (typeof record.enabled !== 'boolean') fail('display-component-enabled-invalid');
    this._requireEditable(record.name).requireComponent(record.componentKey).setEnabled(record.enabled);
    this._onMutation?.();
  }

  setPrefabState(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name', 'state'], [], 'display-local-edit-command-invalid');
    const node = this._requireEditable(record.name);
    const scope = this._prefabInstantiator.getScope(node);
    if (!scope) fail('display-prefab-scope-missing');
    this._prefabInstantiator.applyState(scope,
      cloneAndFreeze(record.state, 'display-prefab-state-invalid'));
    this._onMutation?.();
  }

  removeNode(command) {
    this._assertOpen();
    const record = exactKeys(command, ['name'], [], 'display-local-edit-command-invalid');
    const name = assertNodePrefix(record.name, 'editor');
    const scope = this._editorScopes.get(name);
    if (!scope) fail('display-local-edit-owned-node-required');
    this._editorScopes.delete(name);
    this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope, 'local-edit-removed'));
    this._onMutation?.();
  }

  capture() {
    this._assertOpen();
    return Object.freeze({ editorRootNames: Object.freeze([...this._editorScopes.keys()].sort()) });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const scope of [...this._editorScopes.values()].reverse()) {
      this._onCleanupErrors?.(this._prefabInstantiator.disposeScope(scope, 'local-edit-port-disposed'));
    }
    this._editorScopes.clear();
  }

  _assertOpen() {
    if (this._disposed) fail('display-local-edit-port-disposed');
    this._assertMutable?.();
  }

  _requireEditable(name) {
    const parsed = parseNodeName(name);
    if (!['scene', 'prefab', 'editor'].includes(parsed.prefix)) {
      fail('display-local-edit-scope-forbidden');
    }
    const node = this._scene.nodeIndex.require(parsed.name);
    if (node._authorityOwnerName !== null) fail('display-local-edit-scope-forbidden');
    return node;
  }
}
