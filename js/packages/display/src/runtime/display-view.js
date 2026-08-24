import { cloneAndFreeze } from '../internal.js';
import { writeWorldTransform } from '../math/transform.js';

class FrozenNodeView {
  #record;
  constructor(record) { this.#record = record; Object.freeze(this); }
  get name() { return this.#record.name; }
  get label() { return this.#record.label; }
  get parentName() { return this.#record.parentName; }
  get childNames() { return this.#record.childNames; }
  get localTransform() { return this.#record.localTransform; }
  get visibleSelf() { return this.#record.visibleSelf; }
  get visibleInHierarchy() { return this.#record.visibleInHierarchy; }
  get componentKeys() { return this.#record.componentKeys; }
  getWorldTransform(out = null) {
    return out === null ? this.#record.worldTransform
      : writeWorldTransform(this.#record.worldTransform, out);
  }
  getComponentState(key) { return this.#record.componentStates[key] ?? null; }
}

export class DisplayView {
  #sceneName;
  #revision;
  #cursor;
  #health;
  #nodes;
  #authorityOwners;
  #snapshot;

  constructor(runtime) {
    runtime._nodeGraph.flushWorldTransforms();
    this.#sceneName = runtime._scene.name;
    this.#revision = runtime._revision;
    this.#cursor = runtime._cursor;
    this.#health = runtime._health;
    this.#nodes = new Map();
    this.#authorityOwners = new Map();
    const snapshots = [];
    for (const node of runtime._nodeIndex.values()) {
      const componentStates = Object.fromEntries([...node._components].map(([key]) => [
        key, node._snapshotComponentState(key),
      ]));
      const record = cloneAndFreeze({
        name: node.name,
        label: node.label,
        parentName: node.parent?.name ?? null,
        childNames: node._children.map((child) => child.name),
        localTransform: node.localTransform,
        worldTransform: node.worldTransform,
        visibleSelf: node.visibleSelf,
        visibleInHierarchy: node.visibleInHierarchy,
        componentKeys: [...node._components.keys()],
        componentStates,
        authorityOwnerName: node._authorityOwnerName,
      });
      this.#nodes.set(node.name, new FrozenNodeView(record));
      this.#authorityOwners.set(node.name, record.authorityOwnerName);
      snapshots.push({
        name: record.name,
        parentName: record.parentName,
        localTransform: record.localTransform,
        worldTransform: record.worldTransform,
        visibleSelf: record.visibleSelf,
        visibleInHierarchy: record.visibleInHierarchy,
        componentKeys: record.componentKeys,
        authorityOwnerName: record.authorityOwnerName,
      });
    }
    this.#snapshot = cloneAndFreeze({
      sceneName: this.#sceneName,
      revision: this.#revision,
      cursor: this.#cursor,
      nodeCount: this.#nodes.size,
      nodes: snapshots,
    });
    Object.freeze(this);
  }

  get nodeCount() { return this.#nodes.size; }
  get sceneName() { return this.#sceneName; }
  get revision() { return this.#revision; }
  get cursor() { return this.#cursor; }
  get health() { return this.#health; }
  getNode(name) { return this.#nodes.get(name) ?? null; }
  getWorldTransform(name, out = null) {
    const view = this.getNode(name);
    return view === null ? false : view.getWorldTransform(out);
  }
  getComponentState(name, componentKey) {
    return this.getNode(name)?.getComponentState(componentKey) ?? null;
  }
  getAuthorityOwner(name) { return this.#authorityOwners.get(name) ?? null; }
  snapshot() { return this.#snapshot; }
}
