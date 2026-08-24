import { fail } from './health.js';

export class Scene {
  constructor({ registries, nodeIndex, nodeGraph, scheduler, renderSystem, sceneToken }) {
    this.registries = registries;
    this.nodeIndex = nodeIndex;
    this.nodeGraph = nodeGraph;
    this.scheduler = scheduler;
    this.renderSystem = renderSystem;
    this.sceneToken = sceneToken;
    this.rootNode = null;
    this.authorityRootNode = null;
    this.definition = null;
    this.compiledDefinition = null;
    this.activeCameraName = null;
    this.state = 'creating';
    this.loader = null;
  }

  get name() { return this.definition?.id ?? null; }

  install({ definition, compiledDefinition, rootNode, authorityRootNode, activeCameraName }) {
    if (this.state !== 'creating') fail('display-scene-install-state-invalid');
    this.definition = definition;
    this.compiledDefinition = compiledDefinition;
    this.rootNode = rootNode;
    this.authorityRootNode = authorityRootNode;
    this.activeCameraName = activeCameraName;
    this.state = 'attached';
  }

  activate() {
    if (this.state !== 'attached') fail('display-scene-activate-state-invalid');
    this.state = 'active';
  }

  beginDispose() {
    if (this.state === 'disposed') return false;
    this.state = 'disposing';
    return true;
  }
  finishDispose() { this.state = 'disposed'; }
}
