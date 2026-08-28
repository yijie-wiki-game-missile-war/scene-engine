import { cloneAndFreeze } from '../internal.js';
import { writeWorldTransform } from '../math/transform.js';

export class NodeView {
  #node;
  #graph;
  constructor(node, graph) {
    this.#node = node;
    this.#graph = graph;
    Object.freeze(this);
  }
  get name() { return this.#node.name; }
  get label() { return this.#node.label; }
  get parentName() { return this.#node.parent?.name ?? null; }
  get childNames() { return Object.freeze(this.#node._children.map((child) => child.name)); }
  get localTransform() { return this.#node.localTransform; }
  get visibleSelf() { return this.#node.visibleSelf; }
  get visibleInHierarchy() { this.#graph.flushWorldTransforms(); return this.#node.visibleInHierarchy; }
  get componentKeys() { return Object.freeze([...this.#node._components.keys()]); }
  getWorldTransform(out = null) {
    this.#graph.flushWorldTransforms();
    if (out !== null) return writeWorldTransform(this.#node._worldTransform, out);
    return this.#node.worldTransform;
  }
  getComponentState(key) { return cloneAndFreeze(this.#node._snapshotComponentState(key)); }
}
