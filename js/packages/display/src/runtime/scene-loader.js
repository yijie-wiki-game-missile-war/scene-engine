import { Node } from '../node/node.js';
import { joinSceneNodeName } from '../node/node-name.js';
import { fail } from './health.js';

export class SceneLoader {
  constructor({ scene, componentContext, prefabInstantiator, onCleanupErrors = null }) {
    this._scene = scene;
    this._componentContext = componentContext;
    this._prefabInstantiator = prefabInstantiator;
    this._onCleanupErrors = onCleanupErrors;
    this._directComponents = [];
    this._scopes = [];
  }

  installCompiled(compiled) {
    if (this._scene.state !== 'creating') fail('display-scene-install-state-invalid');
    const index = this._scene.nodeIndex; const graph = this._scene.nodeGraph;
    const created = [];
    try {
      const root = new Node({
        name: 'sys/scene-root',
        sceneToken: this._scene.sceneToken,
        transform: undefined,
      });
      const authorityRoot = new Node({
        name: 'sys/authority-root',
        sceneToken: this._scene.sceneToken,
        transform: undefined,
      });
      index.register(root); created.push(root); graph.attach(root, null);
      index.register(authorityRoot); created.push(authorityRoot); graph.attach(authorityRoot, root);

      const nodeByLocalName = new Map();
      for (const entry of compiled.ordered) {
        const node = new Node({
          name: joinSceneNodeName(compiled.id, entry.localName),
          sceneToken: this._scene.sceneToken,
          transform: entry.transform,
          visible: entry.visible,
          label: entry.label ?? null,
        });
        index.register(node); created.push(node); nodeByLocalName.set(entry.localName, node);
      }
      for (const entry of compiled.ordered) {
        const node = nodeByLocalName.get(entry.localName);
        const parent = entry.parentLocalName === null ? root : nodeByLocalName.get(entry.parentLocalName);
        graph.attach(node, parent);
      }

      const activeCameraName = joinSceneNodeName(compiled.id, compiled.activeCameraLocalName);
      this._scene.install({
        definition: compiled.definition,
        compiledDefinition: compiled,
        rootNode: root,
        authorityRootNode: authorityRoot,
        activeCameraName,
      });
      this._scene.renderSystem.setActiveCamera(activeCameraName);

      for (const definition of compiled.nodes) {
        const node = nodeByLocalName.get(definition.localName);
        for (const componentDefinition of definition.components) {
          const component = this._scene.registries.componentRegistry.create(componentDefinition);
          node.addComponent(component);
          this._directComponents.push(component);
        }
      }
      for (const instance of compiled.prefabInstances) {
        const rootNode = nodeByLocalName.get(instance.localName);
        const scope = this._prefabInstantiator.prepareExistingRoot({
          root: rootNode,
          compiled: instance.compiledPrefab,
          initialState: instance.state,
          authorityOwnerName: null,
          attach: false,
        });
        this._scopes.push(scope);
      }

      this._attachPreorder(root);
      graph.flushWorldTransforms();
      return this._scene;
    } catch (error) {
      this._onCleanupErrors?.(this._rollback(created));
      throw error;
    }
  }

  unload(reason = 'scene-disposed') {
    if (this._scene === null || !this._scene.beginDispose()) return Object.freeze([]);
    const errors = [];
    try {
      if (this._scene.rootNode) {
        for (const node of this._scene.nodeGraph.childBeforeParent(this._scene.rootNode)) {
          for (const component of [...node._components.values()].reverse()) {
            errors.push(...component.dispose(reason));
            node._components.delete(component.key);
          }
        }
        for (const node of this._scene.nodeGraph.childBeforeParent(this._scene.rootNode)) {
          try {
            this._scene.nodeGraph.detach(node);
            this._scene.nodeIndex.unregister(node);
            node._markDisposed();
          } catch (error) { errors.push(error); }
        }
      }
      try { this._scene.renderSystem.setActiveCamera(null); } catch (error) { errors.push(error); }
      this._scene.activeCameraName = null;
      this._scene.finishDispose();
    } finally {
      this._directComponents.length = 0;
      this._scopes.length = 0;
    }
    return Object.freeze(errors);
  }

  release() {
    this._directComponents.length = 0;
    this._scopes.length = 0;
    this._scene = null;
    this._componentContext = null;
    this._prefabInstantiator = null;
    this._onCleanupErrors = null;
  }

  _attachPreorder(node) {
    for (const component of node._components.values()) {
      if (component.node === null) component.attach(node, this._componentContext);
    }
    for (const child of node._children) this._attachPreorder(child);
    for (const scope of this._scopes) {
      if (scope.root === node) scope.attached = true;
    }
  }

  _rollback(created) {
    const errors = [];
    const root = created.find((node) => node.name === 'sys/scene-root');
    const ordered = root?._graph === this._scene.nodeGraph
      ? this._scene.nodeGraph.childBeforeParent(root) : [...created].reverse();
    for (const node of ordered) {
      for (const component of [...node._components.values()].reverse()) {
        errors.push(...component.dispose('scene-attach-rollback'));
        node._components.delete(component.key);
      }
    }
    this._directComponents.length = 0;
    for (const scope of [...this._scopes].reverse()) {
      errors.push(...this._prefabInstantiator.disposeScope(scope, 'scene-attach-rollback'));
    }
    this._scopes.length = 0;
    const remaining = root?._graph === this._scene.nodeGraph
      ? this._scene.nodeGraph.childBeforeParent(root) : [...created].reverse();
    for (const node of remaining) {
      if (node._graph && node._children.length === 0) node._graph.detach(node);
      if (this._scene.nodeIndex.get(node.name) === node) this._scene.nodeIndex.unregister(node);
      node._markDisposed();
    }
    for (const node of created) {
      if (node._graph && node._children.length === 0) node._graph.detach(node);
      if (this._scene.nodeIndex.get(node.name) === node) this._scene.nodeIndex.unregister(node);
      if (!node.disposed) node._markDisposed();
    }
    this._scene.state = 'disposed';
    return Object.freeze(errors);
  }
}
