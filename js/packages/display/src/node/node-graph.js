import { composeWorldTransform } from '../math/transform.js';
import { AUTHORITY_PREFIX, AUTHORITY_ROOT_NAME, SCENE_ROOT_NAME } from './node-name.js';
import { fail } from '../runtime/health.js';

const DETACHED_FORESTS = new WeakSet();

function sameNodeSequence(left, right) {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

export class NodeGraph {
  constructor({ nodeIndex, maximumDepth = 128, onDirty = null,
    onWorldTransform = null, onVisibility = null }) {
    this._nodeIndex = nodeIndex;
    this._maximumDepth = maximumDepth;
    this._transformDirtyRoots = new Set();
    this._visibilityDirtyRoots = new Set();
    this._onDirty = onDirty;
    this._onWorldTransform = onWorldTransform;
    this._onVisibility = onVisibility;
  }

  setCallbacks({ onDirty = this._onDirty, onWorldTransform = this._onWorldTransform,
    onVisibility = this._onVisibility } = {}) {
    this._onDirty = onDirty;
    this._onWorldTransform = onWorldTransform;
    this._onVisibility = onVisibility;
  }

  attach(node, parent = null) {
    this._requireRegistered(node);
    if (node._graph !== null || node.parent !== null) fail('display-node-already-attached');
    if (parent !== null) {
      this._requireRegistered(parent);
      this._validateSameScene(node, parent);
      if (this._depth(parent) + 1 > this._maximumDepth) fail('display-node-depth-limit');
      this._validateAuthorityParent(node, parent);
      parent._children.push(node);
    }
    node._setParent(parent);
    node._setGraph(this);
    this.markTransformDirty(node);
    this.markVisibilityDirty(node);
  }

  reparent(node, parent) {
    this._requireAttached(node);
    this._requireAttached(parent);
    if (node.parent === null || node.name === SCENE_ROOT_NAME || node.name === AUTHORITY_ROOT_NAME) {
      fail('display-node-reparent-forbidden');
    }
    this._validateSameScene(node, parent);
    if (node === parent || this._isAncestor(node, parent)) fail('display-node-cycle');
    this._validateAuthorityParent(node, parent);
    const targetDepth = this._depth(parent) + 1;
    if (targetDepth + this._subtreeHeight(node) - 1 > this._maximumDepth) {
      fail('display-node-depth-limit');
    }
    if (node.parent === parent) return;
    const oldParent = node.parent;
    oldParent._children.splice(oldParent._children.indexOf(node), 1);
    parent._children.push(node);
    node._setParent(parent);
    this.markTransformDirty(node);
    this.markVisibilityDirty(node);
  }

  /** Package-private rollback helper; only reorders one unchanged attached child set. */
  restoreChildOrder(parent, children) {
    this._requireAttached(parent);
    if (!Array.isArray(children) || children.length !== parent._children.length) {
      fail('display-node-forest-invalid');
    }
    const expected = new Set(children);
    if (expected.size !== children.length) fail('display-node-forest-invalid');
    for (const child of children) {
      this._requireAttached(child);
      if (child.parent !== parent) fail('display-node-forest-invalid');
    }
    if (parent._children.some((child) => !expected.has(child))) {
      fail('display-node-forest-invalid');
    }
    parent._children.splice(0, parent._children.length, ...children);
  }

  detach(node) {
    this._requireAttached(node);
    if (node._children.length !== 0) fail('display-node-has-children');
    if (node.parent !== null) {
      const siblings = node.parent._children;
      siblings.splice(siblings.indexOf(node), 1);
    }
    node._setParent(null);
    node._setGraph(null);
    this._transformDirtyRoots.delete(node);
    this._visibilityDirtyRoots.delete(node);
  }

  /** Package-private transactional detach for a complete Node forest. */
  detachForest(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) fail('display-node-forest-invalid');
    const forest = new Set(nodes);
    if (forest.size !== nodes.length) fail('display-node-forest-invalid');
    const originalParents = new Map();
    const parentChildren = new Map();
    for (const node of nodes) {
      this._requireAttached(node);
      if (node.parent === null) fail('display-node-forest-invalid');
      for (const child of node._children) {
        if (!forest.has(child)) fail('display-node-forest-invalid');
      }
      originalParents.set(node, node.parent);
      if (!parentChildren.has(node.parent)) {
        parentChildren.set(node.parent, [...node.parent._children]);
      }
    }
    const token = {
      graph: this,
      nodes: [...nodes],
      forest,
      originalParents,
      parentChildren,
      transformDirtyRoots: new Set(this._transformDirtyRoots),
      visibilityDirtyRoots: new Set(this._visibilityDirtyRoots),
      active: true,
    };
    DETACHED_FORESTS.add(token);

    for (const [parent, children] of parentChildren) {
      parent._children.splice(0, parent._children.length,
        ...children.filter((child) => !forest.has(child)));
    }
    for (const node of nodes) {
      node._setParent(null);
      node._setGraph(null);
      this._transformDirtyRoots.delete(node);
      this._visibilityDirtyRoots.delete(node);
    }
    return token;
  }

  restoreForest(token) {
    this._requireForestToken(token);
    for (const node of token.nodes) {
      this._requireRegistered(node);
      if (node._graph !== null || node.parent !== null) fail('display-node-forest-invalid');
    }
    for (const [parent, children] of token.parentChildren) {
      if (token.forest.has(parent)) {
        this._requireRegistered(parent);
        if (parent._graph !== null || parent.parent !== null) fail('display-node-forest-invalid');
      } else {
        this._requireAttached(parent);
      }
      const remaining = children.filter((child) => !token.forest.has(child));
      if (!sameNodeSequence(parent._children, remaining)) fail('display-node-forest-invalid');
    }

    for (const [parent, children] of token.parentChildren) {
      parent._children.splice(0, parent._children.length, ...children);
    }
    for (const node of token.nodes) {
      node._setParent(token.originalParents.get(node));
      node._setGraph(this);
    }
    this._transformDirtyRoots = new Set(token.transformDirtyRoots);
    this._visibilityDirtyRoots = new Set(token.visibilityDirtyRoots);
    token.active = false;
  }

  commitDetachedForest(token) {
    this._requireForestToken(token);
    token.active = false;
  }

  markTransformDirty(node) {
    this._requireAttached(node);
    this._mergeDirtyRoot(this._transformDirtyRoots, node);
    this._onDirty?.('transform', node);
  }

  markVisibilityDirty(node) {
    this._requireAttached(node);
    this._mergeDirtyRoot(this._visibilityDirtyRoots, node);
    this._onDirty?.('visibility', node);
  }

  flushWorldTransforms() {
    const roots = this._takeDirtyRoots(this._transformDirtyRoots);
    for (const root of roots) this._flushTransformSubtree(root);
    const visibilityRoots = this._takeDirtyRoots(this._visibilityDirtyRoots);
    for (const root of visibilityRoots) this._flushVisibilitySubtree(root);
    return Object.freeze({ transformCount: roots.length, visibilityCount: visibilityRoots.length });
  }

  childBeforeParent(node) {
    this._requireAttached(node);
    const result = [];
    const visit = (current) => {
      for (const child of current._children) visit(child);
      result.push(current);
    };
    visit(node);
    return result;
  }

  validateSubtreePlacement(parent, subtreeHeight) {
    this._requireAttached(parent);
    if (!Number.isSafeInteger(subtreeHeight) || subtreeHeight < 1) {
      fail('display-node-depth-limit');
    }
    if (this._depth(parent) + subtreeHeight > this._maximumDepth) {
      fail('display-node-depth-limit');
    }
  }

  subtreeHeight(node) {
    this._requireAttached(node);
    return this._subtreeHeight(node);
  }

  release() {
    this._transformDirtyRoots.clear();
    this._visibilityDirtyRoots.clear();
    this._onDirty = null;
    this._onWorldTransform = null;
    this._onVisibility = null;
    this._nodeIndex = null;
  }

  _flushTransformSubtree(node) {
    composeWorldTransform(node.parent?._worldTransform ?? null, node._localTransform, node._worldTransform);
    this._onWorldTransform?.(node);
    for (const child of node._children) this._flushTransformSubtree(child);
  }

  _flushVisibilitySubtree(node) {
    const next = node._visibleSelf && (node.parent?._visibleInHierarchy ?? true);
    node._setVisibleInHierarchy(next);
    this._onVisibility?.(node);
    for (const child of node._children) this._flushVisibilitySubtree(child);
  }

  _mergeDirtyRoot(set, node) {
    for (let current = node.parent; current !== null; current = current.parent) {
      if (set.has(current)) return;
    }
    set.add(node);
  }

  _takeDirtyRoots(set) {
    const roots = [];
    for (const candidate of set) {
      let covered = false;
      for (let current = candidate.parent; current !== null; current = current.parent) {
        if (set.has(current)) {
          covered = true;
          break;
        }
      }
      if (!covered) roots.push(candidate);
    }
    set.clear();
    return roots;
  }

  _requireRegistered(node) {
    if (!node || this._nodeIndex.get(node.name) !== node) fail('display-node-not-registered');
  }
  _requireAttached(node) {
    this._requireRegistered(node);
    if (node._graph !== this) fail('display-node-detached');
  }
  _requireForestToken(token) {
    if (!token || !DETACHED_FORESTS.has(token) || token.graph !== this || !token.active) {
      fail('display-node-forest-invalid');
    }
  }
  _validateSameScene(left, right) {
    if (left._sceneToken !== right._sceneToken) fail('display-node-scene-mismatch');
  }
  _isAncestor(ancestor, node) {
    for (let current = node.parent; current !== null; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }
  _depth(node) {
    let result = 1;
    for (let current = node.parent; current !== null; current = current.parent) result += 1;
    return result;
  }
  _subtreeHeight(node) {
    let result = 1;
    for (const child of node._children) result = Math.max(result, 1 + this._subtreeHeight(child));
    return result;
  }
  _validateAuthorityParent(node, parent) {
    if (!node.name.startsWith(AUTHORITY_PREFIX)) return;
    if (parent.name !== AUTHORITY_ROOT_NAME && !parent.name.startsWith(AUTHORITY_PREFIX)) {
      fail('display-authority-parent-invalid');
    }
  }
}
