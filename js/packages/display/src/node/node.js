import { cloneAndFreeze, nonemptyString } from '../internal.js';
import { createLocalTransform, createMutableWorldTransform, IDENTITY_TRANSFORM,
  snapshotWorldTransform } from '../math/transform.js';
import { fail } from '../runtime/health.js';
import { assertNodeName } from './node-name.js';

export class Node {
  constructor({ name, sceneToken, transform, visible = true, label = null }) {
    this._name = assertNodeName(name);
    if (sceneToken === null || (typeof sceneToken !== 'object' && typeof sceneToken !== 'function')) {
      fail('display-node-scene-invalid');
    }
    this._sceneToken = sceneToken;
    this._parent = null;
    this._children = [];
    this._localTransform = createLocalTransform(
      transform === undefined ? IDENTITY_TRANSFORM : transform,
    );
    this._worldTransform = createMutableWorldTransform();
    this._visibleSelf = visible;
    if (typeof visible !== 'boolean') fail('display-node-visibility-invalid');
    this._visibleInHierarchy = visible;
    this._components = new Map();
    this._graph = null;
    this._disposed = false;
    this._label = label === null ? null : nonemptyString(label, 'display-node-label-invalid');
    this._authorityOwnerName = null;
  }

  get name() { return this._name; }
  get label() { return this._label; }
  get parent() { return this._parent; }
  get children() { return Object.freeze([...this._children]); }
  get localTransform() { return Object.freeze(Array.from(this._localTransform)); }
  get worldTransform() { return snapshotWorldTransform(this._worldTransform); }
  get visibleSelf() { return this._visibleSelf; }
  get visibleInHierarchy() { return this._visibleInHierarchy; }
  get components() { return Object.freeze([...this._components.values()]); }
  get disposed() { return this._disposed; }

  setLocalTransform(next) {
    this._assertMutable();
    this._localTransform = createLocalTransform(next);
    this._graph?.markTransformDirty(this);
  }

  setVisible(next) {
    this._assertMutable();
    if (typeof next !== 'boolean') fail('display-node-visibility-invalid');
    if (next === this._visibleSelf) return;
    this._visibleSelf = next;
    this._graph?.markVisibilityDirty(this);
  }

  reparentTo(parent) {
    this._assertMutable();
    if (!this._graph) fail('display-node-detached');
    this._graph.reparent(this, parent);
  }

  addComponent(component) {
    this._assertMutable();
    if (!component || typeof component !== 'object' || typeof component.key !== 'string') {
      fail('display-component-invalid');
    }
    if (this._components.has(component.key)) fail('display-component-key-duplicate');
    if (!component.constructor.allowMultiple) {
      for (const existing of this._components.values()) {
        if (existing.constructor.typeId === component.constructor.typeId) {
          fail('display-component-type-duplicate');
        }
      }
    }
    if (component.drivesTransform) {
      for (const existing of this._components.values()) {
        if (existing.drivesTransform) fail('display-transform-driver-conflict');
      }
    }
    this._components.set(component.key, component);
  }

  removeComponent(key) {
    this._assertMutable();
    const component = this._components.get(key);
    if (!component) fail('display-component-missing');
    if (!component.disposed && component.node !== null) component.dispose('removed');
    this._components.delete(key);
    return component;
  }

  getComponent(typeOrKey) {
    if (typeof typeOrKey === 'string' && this._components.has(typeOrKey)) {
      return this._components.get(typeOrKey);
    }
    const typeId = typeof typeOrKey === 'string' ? typeOrKey : typeOrKey?.typeId;
    for (const component of this._components.values()) {
      if (component.constructor.typeId === typeId
          || (typeof typeOrKey === 'function' && component instanceof typeOrKey)) return component;
    }
    return null;
  }

  requireComponent(typeOrKey) {
    const component = this.getComponent(typeOrKey);
    if (!component) fail('display-component-missing');
    return component;
  }

  _assertMutable() {
    if (this._disposed) fail('display-node-disposed');
  }

  _setGraph(graph) { this._graph = graph; }
  _setParent(parent) { this._parent = parent; }
  _setVisibleInHierarchy(value) { this._visibleInHierarchy = value; }
  _markDisposed() { this._disposed = true; this._graph = null; }
  _setAuthorityOwner(name) { this._authorityOwnerName = name; }
  _snapshotComponentState(key) {
    const component = this._components.get(key);
    if (!component) return null;
    return cloneAndFreeze({
      key: component.key,
      type: component.constructor.typeId,
      enabled: component.enabled,
      properties: component.properties,
    });
  }
}
