import { cloneAndFreeze } from '../internal.js';
import { copyWorldTransform } from '../math/transform.js';
import { Node } from '../node/node.js';
import { joinPrefabNodeName } from '../node/node-name.js';
import { NodeGraph } from '../node/node-graph.js';
import { NodeIndex } from '../node/node-index.js';
import { createInternalComponentContext } from './component-context.js';
import { fail } from './health.js';

function componentPath(localPath, key) { return `${localPath ?? '$root'}/${key}`; }

export class PrefabInstantiator {
  constructor({ scene, componentContext }) {
    this._scene = scene;
    this._componentContext = componentContext;
    this._scopes = new Map();
    this._disposed = false;
    this._disposeErrors = null;
  }

  getScope(root) { return this._scopes.get(root) ?? null; }

  prepareExistingRoot({ root, compiled, initialState = {}, authorityOwnerName = null,
    attach = true, componentContext = this._componentContext, validatedPatch = null }) {
    if (this._scopes.has(root)) fail('display-prefab-scope-duplicate');
    const scope = this._prepare({
      root,
      compiled,
      initialState,
      authorityOwnerName,
      nodeIndex: this._scene.nodeIndex,
      nodeGraph: this._scene.nodeGraph,
      componentContext,
      registerRoot: false,
      validatedPatch,
    });
    if (attach) this.attachScope(scope, componentContext);
    this._scopes.set(root, scope);
    return scope;
  }

  attachScope(scope, componentContext = this._componentContext) {
    if (scope.attached) return;
    const attached = [];
    try {
      for (const node of [scope.root, ...scope.nodes]) {
        for (const component of scope.componentsByNode.get(node) ?? []) {
          component.attach(node, componentContext);
          attached.push(component);
        }
      }
      scope.attached = true;
    } catch (error) {
      for (const component of attached.reverse()) component.dispose('attach-rollback');
      this._rollbackPrepared(scope);
      throw error;
    }
  }

  resolveAndValidateState(compiled, state, scope = null, displayState = {}) {
    const patch = compiled.definition.resolveState(state, {
      authorityState: state,
      sceneContext: { sceneName: this._scene.name, sceneProfile: this._scene.compiledDefinition?.sceneProfile ?? null },
      displayState,
    });
    const currentProperties = scope === null ? null : new Map(
      [...scope.componentByPath].map(([path, component]) => [path, component.properties]),
    );
    return compiled.definition.validatePatch(patch, compiled, currentProperties);
  }

  applyValidatedPatch(scope, patch) {
    for (const [path, nodePatch] of Object.entries(patch.nodes)) {
      const node = scope.nodeByPath.get(path);
      if (Object.hasOwn(nodePatch, 'transform')) node.setLocalTransform(nodePatch.transform);
      if (Object.hasOwn(nodePatch, 'visible')) node.setVisible(nodePatch.visible);
    }
    for (const [path, properties] of Object.entries(patch.components)) {
      const component = scope.componentByPath.get(path);
      scope.compiled.componentRegistry.patchComponentProperties({
        component,
        patch: properties,
        resourceRegistry: scope.compiled.resourceRegistry,
      });
    }
  }

  applyState(scope, state, displayState = {}) {
    const patch = this.resolveAndValidateState(scope.compiled, state, scope, displayState);
    this.applyValidatedPatch(scope, patch);
    scope.state = cloneAndFreeze(state, 'display-prefab-state-invalid');
    return patch;
  }

  disposeScope(scope, reason = 'prefab-disposed') {
    if (!scope || scope.disposed) return Object.freeze([]);
    scope.disposed = true;
    const errors = [];
    const nodes = [scope.root, ...scope.nodes];
    for (const node of [...nodes].reverse()) {
      const components = scope.componentsByNode.get(node) ?? [];
      for (const component of [...components].reverse()) errors.push(...component.dispose(reason));
      for (const component of [...components].reverse()) {
        if (node._components.get(component.key) === component) node._components.delete(component.key);
      }
    }
    for (const node of [...scope.nodes].reverse()) {
      if (node._graph) node._graph.detach(node);
      if (scope.nodeIndex.get(node.name) === node) scope.nodeIndex.unregister(node);
      node._markDisposed();
    }
    if (scope.removeRootOnDispose) {
      if (scope.root._graph) scope.root._graph.detach(scope.root);
      if (scope.nodeIndex.get(scope.root.name) === scope.root) scope.nodeIndex.unregister(scope.root);
      scope.root._markDisposed();
    }
    this._scopes.delete(scope.root);
    return Object.freeze(errors);
  }

  dispose(reason = 'prefab-instantiator-disposed') {
    if (this._disposeErrors !== null) return this._disposeErrors;
    this._disposed = true;
    const errors = [];
    for (const scope of [...this._scopes.values()].reverse()) {
      try { errors.push(...this.disposeScope(scope, reason)); } catch (error) { errors.push(error); }
    }
    this._scopes.clear();
    this._scene = null;
    this._componentContext = null;
    this._disposeErrors = Object.freeze(errors);
    return this._disposeErrors;
  }

  createShadow({ target, compiled, state, authorityComponent, validatedPatch }) {
    const shadowIndex = new NodeIndex();
    const shadowGraph = new NodeGraph({ nodeIndex: shadowIndex, maximumDepth: 128 });
    this._scene.nodeGraph.flushWorldTransforms();
    const liveParent = target.parent;
    if (liveParent === null) fail('display-authority-parent-invalid');
    const shadowParent = new Node({
      name: liveParent.name,
      sceneToken: target._sceneToken,
      transform: {
        position: liveParent._worldTransform.position,
        rotationXyzw: liveParent._worldTransform.rotationXyzw,
        scale: liveParent._worldTransform.scale,
      },
      visible: liveParent.visibleInHierarchy,
    });
    const shadowRoot = new Node({
      name: target.name,
      sceneToken: target._sceneToken,
      transform: target.localTransform,
      visible: target.visibleSelf,
      label: target.label,
    });
    try {
      shadowIndex.register(shadowParent);
      shadowGraph.attach(shadowParent, null);
      shadowGraph.flushWorldTransforms();
      copyWorldTransform(liveParent._worldTransform, shadowParent._worldTransform);
      shadowIndex.register(shadowRoot);
      shadowGraph.attach(shadowRoot, shadowParent);
      const shadowContext = this._createShadowContext(shadowIndex, shadowGraph);
      shadowRoot.addComponent(authorityComponent);
      authorityComponent.attach(shadowRoot, shadowContext);
      const scope = this._prepare({
        root: shadowRoot,
        compiled,
        initialState: state,
        authorityOwnerName: target.name,
        nodeIndex: shadowIndex,
        nodeGraph: shadowGraph,
        componentContext: shadowContext,
        registerRoot: false,
        validatedPatch,
      });
      this.attachScope(scope, shadowContext);
      scope.authorityComponent = authorityComponent;
      scope.shadowParent = shadowParent;
      return scope;
    } catch (error) {
      authorityComponent.dispose('shadow-rollback');
      shadowRoot._components.delete(authorityComponent.key);
      if (shadowRoot._graph && shadowRoot._children.length === 0) shadowGraph.detach(shadowRoot);
      if (shadowIndex.get(shadowRoot.name) === shadowRoot) shadowIndex.unregister(shadowRoot);
      shadowRoot._markDisposed();
      if (shadowParent._graph && shadowParent._children.length === 0) shadowGraph.detach(shadowParent);
      if (shadowIndex.get(shadowParent.name) === shadowParent) shadowIndex.unregister(shadowParent);
      shadowParent._markDisposed();
      throw error;
    }
  }

  validateShadowPlacement(scope, parent) {
    this._scene.nodeGraph.validateSubtreePlacement(parent, scope.nodeGraph.subtreeHeight(scope.root));
  }

  adoptShadow(scope, parent, liveContext = this._componentContext) {
    const shadowGraph = scope.nodeGraph;
    for (const node of [...scope.nodes].reverse()) shadowGraph.detach(node);
    shadowGraph.detach(scope.root);
    shadowGraph.detach(scope.shadowParent);
    scope.nodeIndex.unregister(scope.root);
    for (const node of scope.nodes) scope.nodeIndex.unregister(node);
    scope.nodeIndex.unregister(scope.shadowParent);
    scope.shadowParent._markDisposed();
    scope.nodeIndex = this._scene.nodeIndex;
    scope.nodeGraph = this._scene.nodeGraph;
    this._scene.nodeIndex.register(scope.root);
    for (const node of scope.nodes) this._scene.nodeIndex.register(node);
    this._scene.nodeGraph.attach(scope.root, parent);
    for (const definition of scope.compiled.nodes) {
      const node = scope.nodeByPath.get(definition.localPath);
      const nodeParent = definition.parentLocalPath === null
        ? scope.root : scope.nodeByPath.get(definition.parentLocalPath);
      this._scene.nodeGraph.attach(node, nodeParent);
    }
    scope.authorityComponent._adoptContext(liveContext);
    for (const component of scope.components) component._adoptContext(liveContext);
    this._scopes.set(scope.root, scope);
  }

  disposeShadow(scope, reason = 'shadow-disposed') {
    if (!scope) return Object.freeze([]);
    const errors = [...this.disposeScope(scope, reason)];
    errors.push(...scope.authorityComponent.dispose(reason));
    scope.root._components.delete(scope.authorityComponent.key);
    if (scope.root._graph && scope.root._children.length === 0) scope.root._graph.detach(scope.root);
    if (scope.nodeIndex.get(scope.root.name) === scope.root) scope.nodeIndex.unregister(scope.root);
    scope.root._markDisposed();
    if (scope.shadowParent?._graph && scope.shadowParent._children.length === 0) {
      scope.shadowParent._graph.detach(scope.shadowParent);
    }
    if (scope.shadowParent && scope.nodeIndex.get(scope.shadowParent.name) === scope.shadowParent) {
      scope.nodeIndex.unregister(scope.shadowParent);
      scope.shadowParent._markDisposed();
    }
    return Object.freeze(errors);
  }

  _prepare({ root, compiled, initialState, authorityOwnerName, nodeIndex, nodeGraph,
    componentContext, registerRoot, validatedPatch = null }) {
    const scope = {
      root,
      compiled,
      state: cloneAndFreeze(initialState, 'display-prefab-state-invalid'),
      nodeIndex,
      nodeGraph,
      nodes: [],
      nodeByPath: new Map(),
      componentByPath: new Map(),
      componentsByNode: new Map(),
      components: [],
      attached: false,
      disposed: false,
      removeRootOnDispose: false,
    };
    try {
      root._setAuthorityOwner(authorityOwnerName);
      if (registerRoot) { nodeIndex.register(root); nodeGraph.attach(root, null); }
      for (const definition of compiled.nodes) {
        const node = new Node({
          name: joinPrefabNodeName(root.name, definition.localPath),
          sceneToken: root._sceneToken,
          transform: definition.transform,
          visible: definition.visible,
          label: definition.label,
        });
        node._setAuthorityOwner(authorityOwnerName);
        nodeIndex.register(node);
        scope.nodes.push(node);
        scope.nodeByPath.set(definition.localPath, node);
      }
      for (const definition of compiled.nodes) {
        const node = scope.nodeByPath.get(definition.localPath);
        const parent = definition.parentLocalPath === null
          ? root : scope.nodeByPath.get(definition.parentLocalPath);
        nodeGraph.attach(node, parent);
      }
      this._prepareComponents(scope, root, compiled.root.components, null);
      for (const definition of compiled.nodes) {
        this._prepareComponents(scope, scope.nodeByPath.get(definition.localPath),
          definition.components, definition.localPath);
      }
      const patch = validatedPatch ?? this.resolveAndValidateState(compiled, initialState, scope);
      this.applyValidatedPatch(scope, patch);
      return scope;
    } catch (error) {
      this._rollbackPrepared(scope);
      throw error;
    }
  }

  _prepareComponents(scope, node, definitions, localPath) {
    const components = [];
    for (const definition of definitions) {
      const component = scope.compiled.componentRegistry.create(definition);
      node.addComponent(component);
      components.push(component);
      scope.components.push(component);
      scope.componentByPath.set(componentPath(localPath, component.key), component);
    }
    scope.componentsByNode.set(node, components);
  }

  _rollbackPrepared(scope) {
    for (const component of [...scope.components].reverse()) component.dispose('scope-rollback');
    for (const [node, components] of scope.componentsByNode) {
      for (const component of components) {
        if (node._components.get(component.key) === component) node._components.delete(component.key);
      }
    }
    for (const node of [...scope.nodes].reverse()) {
      if (node._graph) node._graph.detach(node);
      if (scope.nodeIndex.get(node.name) === node) scope.nodeIndex.unregister(node);
      node._markDisposed();
    }
  }

  _createShadowContext(nodeIndex, nodeGraph) {
    const live = this._componentContext;
    const graphView = Object.freeze({
      flushWorldTransforms() {
        live.nodeGraph.flushWorldTransforms();
        return nodeGraph.flushWorldTransforms();
      },
    });
    const overlayIndex = Object.freeze({
      get(name) { return nodeIndex.get(name) ?? live.nodeIndex.get(name); },
      require(name) { return nodeIndex.get(name) ?? live.nodeIndex.require(name); },
      has(name) { return nodeIndex.has(name) || live.nodeIndex.has(name); },
    });
    return createInternalComponentContext({
      scene: live.scene,
      nodeIndex: overlayIndex,
      nodeGraph: graphView,
      componentAttached() {},
      componentEnabledChanged() {},
      componentPropertiesChanged() {},
      componentDetaching() {},
    });
  }
}
