import { NodeView } from '../node/node-view.js';
import { fail } from './health.js';

/**
 * Build the read-only capability surface exposed to BehaviourComponent hooks.
 * Raw NodeIndex/NodeGraph/Authority/RenderSystem objects stay package-private.
 */
export function createPublicDisplayContext({ scene, nodeIndex, nodeGraph }) {
  const views = new WeakMap();
  const viewFor = (node) => {
    let view = views.get(node);
    if (view === undefined) {
      view = new NodeView(node, nodeGraph);
      views.set(node, view);
    }
    return view;
  };
  const nodes = Object.freeze({
    get(name) {
      const node = nodeIndex.get(name);
      return node === null ? null : viewFor(node);
    },
    require(name) { return viewFor(nodeIndex.require(name)); },
    has(name) { return nodeIndex.has(name); },
  });
  const sceneView = {};
  Object.defineProperties(sceneView, {
    name: { enumerable: true, get: () => scene.name },
    activeCameraName: { enumerable: true, get: () => scene.activeCameraName },
  });
  Object.freeze(sceneView);
  return Object.freeze({
    scene: sceneView,
    nodes,
    getNode: (name) => nodes.get(name),
    requireNode: (name) => nodes.require(name),
    getWorldTransform(name, out = null) {
      const node = nodes.get(name);
      return node === null ? false : node.getWorldTransform(out);
    },
  });
}

export function createInternalComponentContext({
  scene,
  nodeIndex,
  nodeGraph,
  animationSystem = null,
  publicDisplay = null,
  componentAttached = null,
  componentSuspending = null,
  componentEnabledChanged = null,
  componentPropertiesChanged = null,
  componentDetaching = null,
  validateComponent = null,
}) {
  const display = publicDisplay ?? createPublicDisplayContext({ scene, nodeIndex, nodeGraph });
  const views = new WeakMap();
  const nodeViewFor = (node) => {
    let view = views.get(node);
    if (view === undefined) {
      view = new NodeView(node, nodeGraph);
      views.set(node, view);
    }
    return view;
  };
  const context = {
    scene,
    nodeIndex,
    nodeGraph,
    publicDisplay: display,
    nodeViewFor,
    setDrivenLocalTransform(component, node, transform) {
      if (!component.drivesTransform) {
        fail('display-component-transform-driver-required');
      }
      if (node._authorityOwnerName === node.name) {
        fail('display-authority-transform-driver-forbidden');
      }
      node.setLocalTransform(transform);
    },
    componentAttached,
    componentSuspending,
    componentEnabledChanged,
    componentPropertiesChanged,
    componentDetaching,
    validateComponent,
  };
  if (animationSystem !== null) {
    // Live contexts apply immediately. Prefab candidate contexts provide a private
    // queueing adapter and replay only after the complete staged bundle is adopted.
    context.setAnimation = (requester, operation, playerKey, animationId) =>
      animationSystem.applyCommand(requester, operation, playerKey, animationId);
  }
  return context;
}
