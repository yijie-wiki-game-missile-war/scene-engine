import { cloneAndFreeze } from '../internal.js';
import { AnimationPlayerComponent } from '../animation/animation-player.js';
import {
  AnimationSystem,
  validatePreparedPrefabAnimationBindings,
} from '../animation/animation-system.js';
import {
  adoptComponentContext,
  replaceComponentProperties,
  suspendComponentRegistration,
} from '../component/component.js';
import {
  composeWorldTransform,
  copyWorldTransform,
  IDENTITY_TRANSFORM,
  snapshotWorldTransform,
  writeWorldTransform,
} from '../math/transform.js';
import { Node } from '../node/node.js';
import { joinPrefabNodeName } from '../node/node-name.js';
import { NodeGraph } from '../node/node-graph.js';
import { NodeIndex } from '../node/node-index.js';
import { NodeView } from '../node/node-view.js';
import { createInternalComponentContext } from './component-context.js';
import { fail } from './health.js';

const ROOT_INSTANCE_PATH = '$root';
const MAX_EXPANDED_NODES = 65_536;

function componentPath(localPath, key) { return `${localPath ?? '$root'}/${key}`; }

function joinInstancePath(parentPath, childPath) {
  return parentPath === ROOT_INSTANCE_PATH ? childPath : `${parentPath}/${childPath}`;
}

function nodeLocalPath(instancePath, localPath = null) {
  if (instancePath === ROOT_INSTANCE_PATH) return localPath;
  return localPath === null ? instancePath : `${instancePath}/${localPath}`;
}

function normalizedChildDirectives(patch) {
  const fixed = Array.isArray(patch.prefabInstances) ? patch.prefabInstances : [];
  const slots = Array.isArray(patch.prefabSlots) ? patch.prefabSlots : [];
  return [...fixed, ...slots];
}

function recordComponents(record) {
  return [...record.componentsByNode.values()].flat();
}

function recordNodes(record) {
  return record.ownsRoot ? [record.root, ...record.nodes] : [...record.nodes];
}

function allRecordNodes(record) { return [record.root, ...record.nodes]; }

function recordNodeNames(records) {
  const names = new Set();
  for (const record of records.values()) {
    for (const node of recordNodes(record)) names.add(node.name);
  }
  return names;
}

function actualPlanGraphHeight(plan) {
  const depths = new Map([[null, 1]]);
  let height = 1;
  for (const node of plan.compiled.nodes) {
    const parentDepth = depths.get(node.parentLocalPath);
    if (parentDepth === undefined) fail('display-prefab-instance-parent-missing');
    const depth = parentDepth + 1;
    depths.set(node.localPath, depth);
    height = Math.max(height, depth);
  }
  for (const child of plan.children) {
    const mountDepth = depths.get(child.parentLocalPath);
    if (mountDepth === undefined) fail('display-prefab-instance-parent-missing');
    height = Math.max(height, mountDepth + child.graphHeight);
  }
  return height;
}

function retainedNodeOverrides(diff) {
  const transforms = new WeakMap();
  const visibility = new WeakMap();
  const componentProperties = new WeakMap();
  const placements = new WeakMap();
  for (const [instancePath, record] of diff.retained) {
    const plan = diff.planByPath.get(instancePath);
    if (record.ownsRoot) {
      transforms.set(record.root, plan.transform);
      visibility.set(record.root, plan.visible);
    }
    for (const [localPath, patch] of Object.entries(plan.patch.nodes)) {
      const node = record.nodeByPath.get(localPath);
      if (Object.hasOwn(patch, 'transform')) transforms.set(node, patch.transform);
      if (Object.hasOwn(patch, 'visible')) visibility.set(node, patch.visible);
    }
    for (const [componentPathValue, properties] of Object.entries(plan.patch.components)) {
      const component = record.componentByPath.get(componentPathValue);
      if (!component) fail('display-prefab-patch-target-missing');
      componentProperties.set(component, properties);
    }
  }
  return { transforms, visibility, componentProperties, placements };
}

function emptyNodeOverrides() {
  return {
    transforms: new WeakMap(),
    visibility: new WeakMap(),
    componentProperties: new WeakMap(),
    placements: new WeakMap(),
  };
}

function candidateNodePlacement(node, overrides) {
  const cached = overrides.placements.get(node);
  if (cached) return cached;
  const parent = node.parent === null ? null : candidateNodePlacement(node.parent, overrides);
  const placement = {
    world: composeWorldTransform(parent?.world ?? null,
      overrides.transforms.get(node) ?? node._localTransform),
    visible: (parent?.visible ?? true)
      && (overrides.visibility.get(node) ?? node.visibleSelf),
  };
  overrides.placements.set(node, placement);
  return placement;
}

function candidateRetainedNodeView(node, overrides, childNames) {
  const placement = candidateNodePlacement(node, overrides);
  const localTransform = overrides.transforms.get(node) ?? node.localTransform;
  const visibleSelf = overrides.visibility.get(node) ?? node.visibleSelf;
  const componentKeys = Object.freeze([...node._components.keys()]);
  return Object.freeze({
    get name() { return node.name; },
    get label() { return node.label; },
    get parentName() { return node.parent?.name ?? null; },
    get childNames() { return childNames; },
    get localTransform() { return localTransform; },
    get visibleSelf() { return visibleSelf; },
    get visibleInHierarchy() { return placement.visible; },
    get componentKeys() { return componentKeys; },
    getWorldTransform(out = null) {
      return out === null
        ? snapshotWorldTransform(placement.world)
        : writeWorldTransform(placement.world, out);
    },
    getComponentState(key) {
      const component = node._components.get(key);
      if (!component) return null;
      return cloneAndFreeze({
        key: component.key,
        type: component.constructor.typeId,
        enabled: component.enabled,
        properties: overrides.componentProperties.get(component) ?? component.properties,
      });
    },
  });
}

function candidateNodeViewWithChildNames(view, childNames) {
  return Object.freeze({
    get name() { return view.name; },
    get label() { return view.label; },
    get parentName() { return view.parentName; },
    get childNames() { return childNames; },
    get localTransform() { return view.localTransform; },
    get visibleSelf() { return view.visibleSelf; },
    get visibleInHierarchy() { return view.visibleInHierarchy; },
    get componentKeys() { return view.componentKeys; },
    getWorldTransform(out = null) { return view.getWorldTransform(out); },
    getComponentState(key) { return view.getComponentState(key); },
  });
}

/**
 * Prefab is a definition-time composition boundary only. At runtime every expansion is
 * materialized into the one ordinary NodeGraph. These records are a private flat provenance
 * and diff ledger; parentage, transforms and visibility remain authoritative only on Nodes.
 */
export class PrefabInstantiator {
  constructor({ scene, componentContext, animationSystem = null, onCleanupErrors = null }) {
    this._scene = scene;
    this._componentContext = componentContext;
    this._animationSystem = animationSystem;
    this._onCleanupErrors = onCleanupErrors;
    this._scopes = new Map();
    this._disposeErrors = null;
  }

  getScope(root) { return this._scopes.get(root) ?? null; }

  prepareExistingRoot({ root, compiled, initialState = {}, authorityOwnerName = null,
    attach = true, componentContext = this._componentContext, validatedPatch = null }) {
    if (this._scopes.has(root)) fail('display-prefab-scope-duplicate');
    const plan = validatedPatch ?? this.resolveAndValidateState(compiled, initialState, null, {}, {
      ownerName: root.name,
    });
    const scope = this._prepare({
      root,
      compiled,
      initialState,
      authorityOwnerName,
      nodeIndex: this._scene.nodeIndex,
      nodeGraph: this._scene.nodeGraph,
      componentContext,
      plan,
    });
    if (attach) this.attachScope(scope, componentContext);
    this._scopes.set(root, scope);
    return scope;
  }

  attachScope(scope, componentContext = this._componentContext) {
    if (scope.attached) return;
    const attached = [];
    try {
      for (const record of scope.records.values()) {
        for (const node of [record.root, ...record.nodes]) {
          for (const component of record.componentsByNode.get(node) ?? []) {
            component.attach(node, componentContext);
            attached.push(component);
          }
        }
      }
      scope.attached = true;
    } catch (error) {
      for (const component of attached.reverse()) component.dispose('attach-rollback');
      this._rollbackPrepared(scope);
      throw error;
    }
  }

  resolveAndValidateState(compiled, state, scope = null, displayState = {}, options = {}) {
    const authorityState = cloneAndFreeze(
      options.authorityState ?? state,
      'display-prefab-state-invalid',
    );
    const plan = this._buildPlan({
      compiled,
      state: cloneAndFreeze(state, 'display-prefab-state-invalid'),
      instancePath: ROOT_INSTANCE_PATH,
      parentInstancePath: null,
      sourceKind: 'root',
      sourceKey: ROOT_INSTANCE_PATH,
      slotKey: null,
      parentLocalPath: null,
      transform: null,
      visible: null,
      scope,
      currentEligible: scope !== null,
      authorityState,
      displayState,
      counter: { nodes: 0 },
    });
    if (options.ownerName !== undefined && options.ownerName !== null) {
      this._validatePlanNames(plan, options.ownerName);
    }
    return plan;
  }

  reconcileState(scope, state, displayState = {}) {
    if (!scope || scope.disposed || this._scopes.get(scope.root) !== scope) {
      fail('display-prefab-scope-missing');
    }
    const frozenState = cloneAndFreeze(state, 'display-prefab-state-invalid');
    const plan = this.resolveAndValidateState(scope.compiled, frozenState, scope, displayState, {
      authorityState: frozenState,
      ownerName: scope.ownerName,
    });
    const diff = this._diffPlan(scope, plan);
    const retainedOverrides = retainedNodeOverrides(diff);
    const removedNames = new Set();
    for (const removal of diff.removed) {
      for (const name of recordNodeNames(removal.records)) removedNames.add(name);
    }
    const stages = [];
    try {
      for (const addedPlan of diff.added) {
        const parentRecord = diff.retained.get(addedPlan.parentInstancePath);
        if (!parentRecord) fail('display-prefab-instance-parent-missing');
        const mountNode = addedPlan.parentLocalPath === null
          ? parentRecord.root : parentRecord.nodeByPath.get(addedPlan.parentLocalPath);
        if (!mountNode) fail('display-prefab-instance-parent-missing');
        stages.push(this._stageSubtree(scope, addedPlan, mountNode,
          candidateNodePlacement(mountNode, retainedOverrides)));
      }
      const candidateSurface = this._createCandidateSurface({
        diff,
        stages,
        hiddenLiveNames: removedNames,
        retainedOverrides,
      });
      const candidateAnimationSystem = stages.length === 0
        ? null : this._createCandidateAnimationSystem(stages);
      for (const stage of stages) {
        stage.componentContext = this._createShadowContext(
          candidateSurface,
          candidateAnimationSystem,
        );
        this.attachScope(stage, stage.componentContext);
      }
    } catch (error) {
      for (const stage of stages.reverse()) {
        try { this._disposeStagedBundle(stage, 'prefab-stage-rollback'); } catch {
          /* preserve the staging error */
        }
      }
      throw error;
    }

    const suspended = [];
    const adopted = [];
    const patchUndos = [];
    try {
      if (diff.removed.length > 0) {
        suspended.push(this._suspendRemovalForest(scope, diff.removed));
      }
      for (const stage of stages) adopted.push(this._adoptBundle(stage, stage.liveParent));
      for (const [instancePath, record] of diff.retained) {
        patchUndos.push(this._applyRetainedPlan(record, diff.planByPath.get(instancePath)));
      }

      const stagedRecords = new Map();
      for (const stage of stages) {
        for (const [path, record] of stage.records) stagedRecords.set(path, record);
      }
      const nextRecords = new Map();
      for (const desired of diff.orderedPlans) {
        const record = diff.retained.get(desired.instancePath)
          ?? stagedRecords.get(desired.instancePath);
        if (!record) fail('display-prefab-scope-missing');
        nextRecords.set(desired.instancePath, record);
      }
      scope.records = nextRecords;
      scope.state = frozenState;
      this._rebuildOwnedNodes(scope);
      this._syncScopeAliases(scope);
      for (const stage of stages) {
        stage.adoptedIntoScope = true;
        try { this._disposeShadowParent(stage); } catch (cleanupError) {
          this._onCleanupErrors?.([cleanupError]);
        }
      }
      for (const transaction of suspended) this._disposeSuspended(transaction,
        'prefab-instance-removed');
      for (const transaction of adopted) this._finalizeAdoption(transaction);
      return plan.patch;
    } catch (error) {
      for (const undo of patchUndos.reverse()) {
        try { undo(); } catch { /* preserve the transaction error */ }
      }
      for (const transaction of adopted.reverse()) {
        try { this._returnAdoptedBundle(transaction); } catch { /* preserve the transaction error */ }
      }
      for (const transaction of suspended.reverse()) {
        try { this._restoreSuspended(transaction); } catch { /* preserve the transaction error */ }
      }
      for (const stage of stages) {
        if (!stage.adoptedIntoScope) {
          try { this._disposeStagedBundle(stage, 'prefab-reconcile-rollback'); } catch {
            /* preserve the transaction error */
          }
        }
      }
      throw error;
    }
  }

  disposeScope(scope, reason = 'prefab-disposed') {
    if (!scope || scope.disposed) return Object.freeze([]);
    scope.disposed = true;
    const errors = [];
    for (const record of [...scope.records.values()].reverse()) {
      for (const node of [record.root, ...record.nodes].reverse()) {
        const components = record.componentsByNode.get(node) ?? [];
        for (const component of [...components].reverse()) errors.push(...component.dispose(reason));
        for (const component of [...components].reverse()) {
          if (node._components.get(component.key) === component) node._components.delete(component.key);
        }
      }
      try { this._animationSystem?.unbindPrefabScope(record); } catch (error) { errors.push(error); }
    }
    for (const node of [...scope.ownedNodes].reverse()) {
      try {
        if (node._graph) node._graph.detach(node);
        if (scope.nodeIndex.get(node.name) === node) scope.nodeIndex.unregister(node);
        if (!node.disposed) node._markDisposed();
      } catch (error) { errors.push(error); }
    }
    this._scopes.delete(scope.root);
    return Object.freeze(errors);
  }

  dispose(reason = 'prefab-instantiator-disposed') {
    if (this._disposeErrors !== null) return this._disposeErrors;
    const errors = [];
    for (const scope of [...this._scopes.values()].reverse()) {
      try { errors.push(...this.disposeScope(scope, reason)); } catch (error) { errors.push(error); }
    }
    this._scopes.clear();
    this._scene = null;
    this._componentContext = null;
    this._animationSystem = null;
    this._onCleanupErrors = null;
    this._disposeErrors = Object.freeze(errors);
    return this._disposeErrors;
  }

  createShadow({ target, compiled, state, authorityComponent, validatedPatch,
    preservedAuthorityChildNames = [] }) {
    const shadowIndex = new NodeIndex();
    const shadowGraph = new NodeGraph({ nodeIndex: shadowIndex, maximumDepth: 128 });
    const liveParent = target.parent;
    if (liveParent === null) fail('display-authority-parent-invalid');
    const parentPlacement = candidateNodePlacement(liveParent, emptyNodeOverrides());
    const shadowParent = new Node({
      name: liveParent.name,
      sceneToken: target._sceneToken,
      transform: IDENTITY_TRANSFORM,
      visible: parentPlacement.visible,
    });
    const shadowRoot = new Node({
      name: target.name,
      sceneToken: target._sceneToken,
      transform: target._localTransform,
      visible: target.visibleSelf,
      label: target.label,
    });
    let scope = null;
    try {
      shadowIndex.register(shadowParent);
      shadowGraph.attach(shadowParent, null);
      shadowGraph.flushWorldTransforms();
      copyWorldTransform(parentPlacement.world, shadowParent._worldTransform);
      shadowIndex.register(shadowRoot);
      shadowGraph.attach(shadowRoot, shadowParent);
      const oldScope = this._scopes.get(target) ?? null;
      const hiddenLiveNames = oldScope === null ? new Set() : recordNodeNames(oldScope.records);
      shadowRoot.addComponent(authorityComponent);
      const plan = validatedPatch ?? this.resolveAndValidateState(compiled, state, null, {}, {
        ownerName: target.name,
      });
      scope = this._prepare({
        root: shadowRoot,
        compiled,
        initialState: state,
        authorityOwnerName: target.name,
        nodeIndex: shadowIndex,
        nodeGraph: shadowGraph,
        componentContext: null,
        plan,
      });
      const retainedOverrides = emptyNodeOverrides();
      const candidateSurface = this._createCandidateSurface({
        diff: { retained: new Map() },
        stages: [{ ...scope, ownedNodes: [scope.root, ...scope.ownedNodes] }],
        hiddenLiveNames,
        retainedOverrides,
        stagedAdditionalChildNames: new Map([[target.name, preservedAuthorityChildNames]]),
      });
      const shadowContext = this._createShadowContext(
        candidateSurface,
        this._createCandidateAnimationSystem([scope]),
      );
      scope.componentContext = shadowContext;
      authorityComponent.attach(shadowRoot, shadowContext);
      this.attachScope(scope, shadowContext);
      scope.authorityComponent = authorityComponent;
      scope.shadowParent = shadowParent;
      scope.shadowNodeIndex = shadowIndex;
      return scope;
    } catch (error) {
      if (scope) this._rollbackPrepared(scope);
      authorityComponent.dispose('shadow-rollback');
      shadowRoot._components.delete(authorityComponent.key);
      if (shadowRoot._graph && shadowRoot._children.length === 0) shadowGraph.detach(shadowRoot);
      if (shadowIndex.get(shadowRoot.name) === shadowRoot) shadowIndex.unregister(shadowRoot);
      if (!shadowRoot.disposed) shadowRoot._markDisposed();
      if (shadowParent._graph && shadowParent._children.length === 0) shadowGraph.detach(shadowParent);
      if (shadowIndex.get(shadowParent.name) === shadowParent) shadowIndex.unregister(shadowParent);
      if (!shadowParent.disposed) shadowParent._markDisposed();
      throw error;
    }
  }

  validateShadowPlacement(scope, parent) {
    this._scene.nodeGraph.validateSubtreePlacement(parent, scope.nodeGraph.subtreeHeight(scope.root));
  }

  suspendLiveScope(scope) {
    if (!scope || scope.disposed || scope.nodeGraph !== this._scene.nodeGraph
        || scope.nodeIndex !== this._scene.nodeIndex || scope.root.parent === null) {
      fail('display-prefab-scope-missing');
    }
    return this._suspendBundle(scope, { includeRoot: true });
  }

  restoreSuspendedScope(transaction) {
    if (!transaction?.active) fail('display-prefab-scope-missing');
    this._restoreSuspended(transaction);
  }

  finalizeSuspendedScope(transaction) {
    if (!transaction?.active) fail('display-prefab-scope-missing');
    transaction.detachment.nodeGraph.commitDetachedForest(transaction.detachment.topology);
    transaction.active = false;
  }

  adoptShadow(scope, parent, liveContext = this._componentContext) {
    const transaction = this._adoptBundle(scope, parent, { includeRoot: true, liveContext });
    this._finalizeAdoption(transaction);
    this._disposeShadowParent(scope);
    scope.componentContext = liveContext;
    scope.shadowParent = null;
    scope.shadowNodeIndex = null;
    this._scopes.set(scope.root, scope);
  }

  disposeShadow(scope, reason = 'shadow-disposed') {
    if (!scope) return Object.freeze([]);
    const errors = [...this.disposeScope(scope, reason)];
    errors.push(...scope.authorityComponent.dispose(reason));
    scope.root._components.delete(scope.authorityComponent.key);
    if (scope.root._graph && scope.root._children.length === 0) scope.root._graph.detach(scope.root);
    if (scope.nodeIndex.get(scope.root.name) === scope.root) scope.nodeIndex.unregister(scope.root);
    if (!scope.root.disposed) scope.root._markDisposed();
    try { this._disposeShadowParent(scope); } catch (error) { errors.push(error); }
    return Object.freeze(errors);
  }

  _buildPlan({ compiled, state, instancePath, parentInstancePath, sourceKind, sourceKey,
    slotKey, parentLocalPath, transform, visible, scope, currentEligible, authorityState,
    displayState, counter }) {
    const current = currentEligible ? scope?.records.get(instancePath) ?? null : null;
    const canRetain = current !== null && current.compiled.id === compiled.id;
    const currentProperties = canRetain ? new Map(
      [...current.componentByPath].map(([path, component]) => [path, component.properties]),
    ) : null;
    const resolved = compiled.definition.resolveState(state, {
      authorityState,
      sceneContext: {
        sceneName: this._scene.name,
        sceneProfile: this._scene.compiledDefinition?.sceneProfile ?? null,
      },
      displayState,
    });
    const patch = compiled.definition.validatePatch(resolved, compiled, currentProperties);
    counter.nodes += compiled.nodes.length + 1;
    if (counter.nodes > MAX_EXPANDED_NODES) fail('display-prefab-expanded-node-limit');
    const plan = {
      instancePath,
      parentInstancePath,
      sourceKind,
      sourceKey,
      slotKey,
      parentLocalPath,
      compiled,
      state,
      transform,
      visible,
      patch,
      children: [],
    };
    for (const child of normalizedChildDirectives(patch)) {
      const childInstancePath = joinInstancePath(instancePath, child.instancePath);
      const childCurrent = canRetain && scope?.records.get(childInstancePath)?.compiled.id
        === child.compiledPrefab.id;
      plan.children.push(this._buildPlan({
        compiled: child.compiledPrefab,
        state: child.state,
        instancePath: childInstancePath,
        parentInstancePath: instancePath,
        sourceKind: child.sourceKind,
        sourceKey: child.key,
        slotKey: child.slotKey ?? null,
        parentLocalPath: child.parentLocalPath,
        transform: child.transform,
        visible: child.visible,
        scope,
        currentEligible: childCurrent,
        authorityState,
        displayState,
        counter,
      }));
    }
    plan.children = Object.freeze(plan.children);
    plan.graphHeight = actualPlanGraphHeight(plan);
    return Object.freeze(plan);
  }

  _validatePlanNames(plan, ownerName) {
    const names = new Set();
    const claim = (localPath) => {
      const name = joinPrefabNodeName(ownerName, localPath);
      if (names.has(name)) fail('display-node-name-duplicate');
      names.add(name);
    };
    const visit = (entry) => {
      if (entry.instancePath !== ROOT_INSTANCE_PATH) claim(entry.instancePath);
      for (const node of entry.compiled.nodes) {
        claim(nodeLocalPath(entry.instancePath, node.localPath));
      }
      for (const child of entry.children) visit(child);
    };
    visit(plan);
  }

  _prepare({ root, compiled, initialState, authorityOwnerName, nodeIndex, nodeGraph,
    componentContext, plan }) {
    const scope = {
      root,
      ownerName: root.name,
      authorityOwnerName,
      compiled,
      state: cloneAndFreeze(initialState, 'display-prefab-state-invalid'),
      nodeIndex,
      nodeGraph,
      componentContext,
      records: new Map(),
      ownedNodes: [],
      attached: false,
      disposed: false,
      shadowParent: null,
      adoptedIntoScope: false,
    };
    try {
      root._setAuthorityOwner(authorityOwnerName);
      this._materializePlan(scope, plan, root, false, root.parent);
      this._syncScopeAliases(scope);
      return scope;
    } catch (error) {
      this._rollbackPrepared(scope);
      throw error;
    }
  }

  _materializePlan(bundle, plan, root, ownsRoot, mountNode, rootAlreadyTracked = false) {
    const record = {
      instancePath: plan.instancePath,
      parentInstancePath: plan.parentInstancePath,
      compiled: plan.compiled,
      root,
      mountNode,
      ownsRoot,
      nodeByPath: new Map(),
      componentByPath: new Map(),
      componentsByNode: new Map(),
      nodes: [],
      bound: false,
    };
    if (ownsRoot && !rootAlreadyTracked) bundle.ownedNodes.push(root);
    bundle.records.set(plan.instancePath, record);
    root._setAuthorityOwner(bundle.authorityOwnerName);
    for (const definition of plan.compiled.nodes) {
      const node = new Node({
        name: joinPrefabNodeName(bundle.ownerName,
          nodeLocalPath(plan.instancePath, definition.localPath)),
        sceneToken: root._sceneToken,
        transform: definition.transform,
        visible: definition.visible,
        label: definition.label,
      });
      node._setAuthorityOwner(bundle.authorityOwnerName);
      bundle.nodeIndex.register(node);
      bundle.ownedNodes.push(node);
      record.nodes.push(node);
      record.nodeByPath.set(definition.localPath, node);
    }
    for (const definition of plan.compiled.nodes) {
      const node = record.nodeByPath.get(definition.localPath);
      const parent = definition.parentLocalPath === null
        ? root : record.nodeByPath.get(definition.parentLocalPath);
      bundle.nodeGraph.attach(node, parent);
    }
    this._prepareComponents(record, root, plan.compiled.root.components, null);
    for (const definition of plan.compiled.nodes) {
      this._prepareComponents(record, record.nodeByPath.get(definition.localPath),
        definition.components, definition.localPath);
    }
    this._applyDirectPatch(record, plan.patch);
    this._animationSystem?.bindPrefabScope(record);
    record.bound = true;
    validatePreparedPrefabAnimationBindings(record, plan.compiled.resourceRegistry);
    for (const childPlan of plan.children) {
      const childRoot = new Node({
        name: joinPrefabNodeName(bundle.ownerName, childPlan.instancePath),
        sceneToken: root._sceneToken,
        transform: childPlan.transform,
        visible: childPlan.visible,
      });
      const childMount = childPlan.parentLocalPath === null
        ? root : record.nodeByPath.get(childPlan.parentLocalPath);
      if (!childMount) fail('display-prefab-instance-parent-missing');
      // Track the child root before either registration or placement can fail so the
      // enclosing preparation rollback always disposes the candidate identity.
      bundle.ownedNodes.push(childRoot);
      bundle.nodeIndex.register(childRoot);
      bundle.nodeGraph.attach(childRoot, childMount);
      this._materializePlan(bundle, childPlan, childRoot, true, childMount, true);
    }
    return record;
  }

  _prepareComponents(record, node, definitions, localPath) {
    const components = [];
    // Publish ownership before construction so a later constructor/add failure still
    // leaves every earlier Component reachable by the enclosing preparation rollback.
    record.componentsByNode.set(node, components);
    for (const definition of definitions) {
      const component = record.compiled.componentRegistry.create(definition);
      components.push(component);
      node.addComponent(component);
      record.componentByPath.set(componentPath(localPath, component.key), component);
    }
  }

  _applyDirectPatch(record, patch) {
    for (const [path, nodePatch] of Object.entries(patch.nodes)) {
      const node = record.nodeByPath.get(path);
      if (Object.hasOwn(nodePatch, 'transform')) node.setLocalTransform(nodePatch.transform);
      if (Object.hasOwn(nodePatch, 'visible')) node.setVisible(nodePatch.visible);
    }
    for (const [path, properties] of Object.entries(patch.components)) {
      const component = record.componentByPath.get(path);
      record.compiled.componentRegistry.patchComponentProperties({
        component,
        patch: properties,
        resourceRegistry: record.compiled.resourceRegistry,
      });
    }
  }

  _applyRetainedPlan(record, plan) {
    const undos = [];
    const setTransform = (node, value) => {
      const previous = node._localTransform;
      node.setLocalTransform(value);
      undos.push(() => node.setLocalTransform(previous));
    };
    const setVisible = (node, value) => {
      const previous = node.visibleSelf;
      node.setVisible(value);
      undos.push(() => node.setVisible(previous));
    };
    try {
      if (record.ownsRoot) {
        setTransform(record.root, plan.transform);
        setVisible(record.root, plan.visible);
      }
      for (const [path, nodePatch] of Object.entries(plan.patch.nodes)) {
        const node = record.nodeByPath.get(path);
        if (Object.hasOwn(nodePatch, 'transform')) setTransform(node, nodePatch.transform);
        if (Object.hasOwn(nodePatch, 'visible')) setVisible(node, nodePatch.visible);
      }
      for (const [path, properties] of Object.entries(plan.patch.components)) {
        const component = record.componentByPath.get(path);
        const previous = component.properties;
        record.compiled.componentRegistry.patchComponentProperties({
          component,
          patch: properties,
          resourceRegistry: record.compiled.resourceRegistry,
        });
        undos.push(() => replaceComponentProperties(component, previous));
      }
    } catch (error) {
      for (const undo of undos.reverse()) {
        try { undo(); } catch { /* preserve the patch error */ }
      }
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const undo of undos.reverse()) undo();
    };
  }

  _diffPlan(scope, plan) {
    const retained = new Map();
    const added = [];
    const planByPath = new Map();
    const orderedPlans = [];
    const visit = (entry, parentRetained) => {
      planByPath.set(entry.instancePath, entry);
      orderedPlans.push(entry);
      const current = scope.records.get(entry.instancePath);
      const keep = entry.instancePath === ROOT_INSTANCE_PATH
        ? current?.compiled.id === entry.compiled.id
        : parentRetained && current?.compiled.id === entry.compiled.id;
      if (keep) {
        retained.set(entry.instancePath, current);
        for (const child of entry.children) visit(child, true);
      } else {
        added.push(entry);
        const collect = (descendant) => {
          planByPath.set(descendant.instancePath, descendant);
          orderedPlans.push(descendant);
          for (const child of descendant.children) collect(child);
        };
        for (const child of entry.children) collect(child);
      }
    };
    visit(plan, true);
    if (!retained.has(ROOT_INSTANCE_PATH)) fail('display-prefab-scope-missing');
    const removedRoots = [];
    const removedChildren = new Map();
    for (const record of scope.records.values()) {
      if (retained.has(record.instancePath) || record.instancePath === ROOT_INSTANCE_PATH) continue;
      if (retained.has(record.parentInstancePath)) removedRoots.push(record);
      let children = removedChildren.get(record.parentInstancePath);
      if (children === undefined) {
        children = [];
        removedChildren.set(record.parentInstancePath, children);
      }
      children.push(record);
    }
    const removed = removedRoots.map((root) => {
      const records = new Map();
      const collect = (record) => {
        records.set(record.instancePath, record);
        for (const child of removedChildren.get(record.instancePath) ?? []) collect(child);
      };
      collect(root);
      return { root, records };
    });
    return { retained, added, removed, planByPath, orderedPlans };
  }

  _stageSubtree(scope, plan, liveParent, candidateParent = null) {
    const shadowIndex = new NodeIndex();
    const shadowGraph = new NodeGraph({ nodeIndex: shadowIndex, maximumDepth: 128 });
    const parentWorld = candidateParent?.world ?? liveParent._worldTransform;
    const parentVisible = candidateParent?.visible ?? liveParent.visibleInHierarchy;
    const shadowParent = new Node({
      name: liveParent.name,
      sceneToken: liveParent._sceneToken,
      transform: IDENTITY_TRANSFORM,
      visible: parentVisible,
    });
    const root = new Node({
      name: joinPrefabNodeName(scope.ownerName, plan.instancePath),
      sceneToken: liveParent._sceneToken,
      transform: plan.transform,
      visible: plan.visible,
    });
    const bundle = {
      root,
      ownerName: scope.ownerName,
      authorityOwnerName: scope.authorityOwnerName,
      compiled: plan.compiled,
      state: plan.state,
      nodeIndex: shadowIndex,
      nodeGraph: shadowGraph,
      componentContext: null,
      records: new Map(),
      ownedNodes: [],
      attached: false,
      disposed: false,
      shadowParent,
      shadowNodeIndex: shadowIndex,
      liveParent,
      adoptedIntoScope: false,
    };
    try {
      shadowIndex.register(shadowParent);
      shadowGraph.attach(shadowParent, null);
      shadowGraph.flushWorldTransforms();
      copyWorldTransform(parentWorld, shadowParent._worldTransform);
      bundle.ownedNodes.push(root);
      shadowIndex.register(root);
      shadowGraph.attach(root, shadowParent);
      this._materializePlan(bundle, plan, root, true, shadowParent, true);
      this._syncScopeAliases(bundle);
      this._scene.nodeGraph.validateSubtreePlacement(liveParent,
        shadowGraph.subtreeHeight(root));
      return bundle;
    } catch (error) {
      try { this._disposeStagedBundle(bundle, 'prefab-stage-rollback'); } catch {
        /* preserve the staging error */
      }
      throw error;
    }
  }

  _suspendRemovalForest(scope, removals) {
    const removedPaths = new Set();
    for (const removal of removals) {
      for (const instancePath of removal.records.keys()) removedPaths.add(instancePath);
    }
    const records = new Map();
    for (const [instancePath, record] of scope.records) {
      if (removedPaths.has(instancePath)) records.set(instancePath, record);
    }
    const topRecord = removals[0].root;
    const bundle = {
      root: topRecord.root,
      records,
      ownedNodes: [...records.values()].flatMap(recordNodes),
      nodeIndex: scope.nodeIndex,
      nodeGraph: scope.nodeGraph,
      componentContext: scope.componentContext,
      shadowParent: null,
    };
    return this._suspendBundle(bundle, { includeRoot: false });
  }

  _suspendBundle(bundle, { includeRoot }) {
    const resumeRegistrations = [];
    try {
      for (const record of bundle.records.values()) {
        for (const component of recordComponents(record)) {
          resumeRegistrations.push(suspendComponentRegistration(component));
        }
      }
      const detachment = this._detachBundleTree(bundle, { includeRoot });
      return { bundle, detachment, resumeRegistrations, active: true };
    } catch (error) {
      for (const resume of resumeRegistrations.reverse()) {
        try { resume(); } catch { /* preserve the suspension error */ }
      }
      throw error;
    }
  }

  _restoreSuspended(transaction) {
    if (!transaction.active) fail('display-prefab-scope-missing');
    this._restoreDetachedBundle(transaction.detachment);
    for (const resume of transaction.resumeRegistrations) resume();
    transaction.active = false;
  }

  _disposeSuspended(transaction, reason) {
    if (!transaction.active) return;
    transaction.detachment.nodeGraph.commitDetachedForest(transaction.detachment.topology);
    transaction.active = false;
    const errors = [];
    for (const record of [...transaction.bundle.records.values()].reverse()) {
      for (const node of [record.root, ...record.nodes].reverse()) {
        const components = record.componentsByNode.get(node) ?? [];
        for (const component of [...components].reverse()) errors.push(...component.dispose(reason));
        for (const component of components) node._components.delete(component.key);
      }
      try { this._animationSystem?.unbindPrefabScope(record); } catch (error) { errors.push(error); }
    }
    for (const node of [...transaction.bundle.ownedNodes].reverse()) {
      if (!node.disposed) node._markDisposed();
    }
    this._onCleanupErrors?.(errors);
  }

  _adoptBundle(bundle, parent, { includeRoot = false,
    liveContext = this._componentContext } = {}) {
    const sourceIndex = bundle.nodeIndex;
    const sourceGraph = bundle.nodeGraph;
    const sourceParent = bundle.root.parent;
    if (sourceParent === null) fail('display-prefab-scope-missing');
    const topRecord = bundle.records.values().next().value;
    const sourceMountNode = topRecord.mountNode;
    const sourceDetachment = this._detachBundleTree(bundle, { includeRoot });
    bundle.nodeIndex = this._scene.nodeIndex;
    bundle.nodeGraph = this._scene.nodeGraph;
    const undoContexts = [];
    try {
      this._attachBundleTree(bundle, parent, {
        includeRoot,
        nodeIndex: this._scene.nodeIndex,
        nodeGraph: this._scene.nodeGraph,
      });
      if (includeRoot && bundle.authorityComponent) {
        undoContexts.push(adoptComponentContext(bundle.authorityComponent, liveContext));
      }
      for (const record of bundle.records.values()) {
        for (const component of recordComponents(record)) {
          undoContexts.push(adoptComponentContext(component, liveContext));
        }
      }
      const stagedAnimationCommands = bundle.componentContext.stagedAnimationCommands ?? [];
      if (stagedAnimationCommands.length > 0 && this._animationSystem === null) {
        fail('display-animation-system-unavailable');
      }
      for (const command of stagedAnimationCommands) {
        this._animationSystem.applyCommand(
          command.requester,
          command.operation,
          command.playerKey,
          command.animationId,
        );
      }
      if (topRecord.ownsRoot) topRecord.mountNode = parent;
    } catch (error) {
      for (const undo of undoContexts.reverse()) {
        try { undo(); } catch { /* preserve the adoption error */ }
      }
      let rejectedDetachment = null;
      const firstNode = includeRoot ? bundle.root : bundle.ownedNodes[0];
      if (firstNode?._graph === this._scene.nodeGraph) {
        try { rejectedDetachment = this._detachBundleTree(bundle, { includeRoot }); } catch {
          /* preserve the adoption error */
        }
      }
      bundle.nodeIndex = sourceIndex;
      bundle.nodeGraph = sourceGraph;
      topRecord.mountNode = sourceMountNode;
      try { this._restoreDetachedBundle(sourceDetachment); } catch { /* preserve adoption */ }
      if (rejectedDetachment?.topology.active) {
        rejectedDetachment.nodeGraph.commitDetachedForest(rejectedDetachment.topology);
      }
      throw error;
    }
    return {
      bundle,
      parent,
      includeRoot,
      sourceIndex,
      sourceGraph,
      sourceParent,
      sourceMountNode,
      sourceDetachment,
      undoContexts,
      active: true,
    };
  }

  _returnAdoptedBundle(transaction) {
    if (!transaction.active) return;
    for (const undo of transaction.undoContexts.reverse()) undo();
    const rejectedDetachment = this._detachBundleTree(transaction.bundle, {
      includeRoot: transaction.includeRoot,
    });
    transaction.bundle.nodeIndex = transaction.sourceIndex;
    transaction.bundle.nodeGraph = transaction.sourceGraph;
    const topRecord = transaction.bundle.records.values().next().value;
    topRecord.mountNode = transaction.sourceMountNode;
    this._restoreDetachedBundle(transaction.sourceDetachment);
    rejectedDetachment.nodeGraph.commitDetachedForest(rejectedDetachment.topology);
    transaction.active = false;
  }

  _finalizeAdoption(transaction) {
    if (!transaction.active) return;
    transaction.sourceDetachment.nodeGraph.commitDetachedForest(
      transaction.sourceDetachment.topology,
    );
    transaction.active = false;
  }

  _detachBundleTree(bundle, { includeRoot }) {
    const nodes = includeRoot ? [bundle.root, ...bundle.ownedNodes] : bundle.ownedNodes;
    const topology = bundle.nodeGraph.detachForest(nodes);
    const unregistered = [];
    try {
      for (const node of nodes) {
        bundle.nodeIndex.unregister(node);
        unregistered.push(node);
      }
    } catch (error) {
      for (const node of unregistered) {
        try { bundle.nodeIndex.register(node); } catch { /* preserve the index error */ }
      }
      try { bundle.nodeGraph.restoreForest(topology); } catch { /* preserve the index error */ }
      throw error;
    }
    return { nodes, nodeIndex: bundle.nodeIndex, nodeGraph: bundle.nodeGraph, topology };
  }

  _restoreDetachedBundle(detachment) {
    const registered = [];
    try {
      for (const node of detachment.nodes) {
        detachment.nodeIndex.register(node);
        registered.push(node);
      }
      detachment.nodeGraph.restoreForest(detachment.topology);
    } catch (error) {
      for (const node of registered.reverse()) {
        if (detachment.nodeIndex.get(node.name) === node) {
          try { detachment.nodeIndex.unregister(node); } catch { /* preserve restore error */ }
        }
      }
      throw error;
    }
  }

  _attachBundleTree(bundle, parent, { includeRoot, nodeIndex, nodeGraph }) {
    const nodes = includeRoot ? [bundle.root, ...bundle.ownedNodes] : bundle.ownedNodes;
    try {
      for (const node of nodes) nodeIndex.register(node);
      const topRecord = bundle.records.values().next().value;
      if (includeRoot) nodeGraph.attach(bundle.root, parent);
      for (const record of bundle.records.values()) {
        if (record.ownsRoot) {
          nodeGraph.attach(record.root, record === topRecord ? parent : record.mountNode);
        }
        for (const definition of record.compiled.nodes) {
          const node = record.nodeByPath.get(definition.localPath);
          const nodeParent = definition.parentLocalPath === null
            ? record.root : record.nodeByPath.get(definition.parentLocalPath);
          nodeGraph.attach(node, nodeParent);
        }
      }
    } catch (error) {
      for (const node of [...nodes].reverse()) {
        if (node._graph === nodeGraph && node._children.length === 0) {
          try { nodeGraph.detach(node); } catch { /* preserve the placement error */ }
        }
      }
      for (const node of [...nodes].reverse()) {
        if (nodeIndex.get(node.name) === node) {
          try { nodeIndex.unregister(node); } catch { /* preserve the placement error */ }
        }
      }
      throw error;
    }
  }

  _disposeStagedBundle(bundle, reason) {
    if (bundle.adoptedIntoScope) return;
    this._rollbackPrepared(bundle, reason);
    this._disposeShadowParent(bundle);
  }

  _disposeShadowParent(bundle) {
    const parent = bundle.shadowParent;
    if (!parent || parent.disposed) return;
    if (parent._graph && parent._children.length === 0) parent._graph.detach(parent);
    const shadowIndex = bundle.shadowNodeIndex ?? bundle.nodeIndex;
    if (shadowIndex.get(parent.name) === parent) shadowIndex.unregister(parent);
    parent._markDisposed();
  }

  _rollbackPrepared(bundle, reason = 'scope-rollback') {
    if (!bundle || bundle.disposed) return;
    bundle.disposed = true;
    for (const record of [...bundle.records.values()].reverse()) {
      for (const node of [record.root, ...record.nodes].reverse()) {
        const components = record.componentsByNode.get(node) ?? [];
        for (const component of [...components].reverse()) component.dispose(reason);
        for (const component of components) {
          if (node._components.get(component.key) === component) node._components.delete(component.key);
        }
      }
      if (record.bound) this._animationSystem?.unbindPrefabScope(record);
      record.bound = false;
    }
    for (const node of [...bundle.ownedNodes].reverse()) {
      if (node._graph) node._graph.detach(node);
      if (bundle.nodeIndex.get(node.name) === node) bundle.nodeIndex.unregister(node);
      if (!node.disposed) node._markDisposed();
    }
  }

  _rebuildOwnedNodes(scope) {
    scope.ownedNodes = [];
    for (const record of scope.records.values()) scope.ownedNodes.push(...recordNodes(record));
  }

  _syncScopeAliases(scope) {
    const rootRecord = scope.records.values().next().value;
    if (!rootRecord) fail('display-prefab-scope-missing');
    scope.compiled = rootRecord.compiled;
    scope.nodeByPath = rootRecord.nodeByPath;
  }

  _createCandidateSurface({ diff, stages, hiddenLiveNames, retainedOverrides,
    stagedAdditionalChildNames = new Map() }) {
    const live = this._componentContext;
    const stagedByName = new Map();
    const stageGraphs = new Set();
    for (const stage of stages) {
      stageGraphs.add(stage.nodeGraph);
      for (const node of stage.ownedNodes) {
        if (stagedByName.has(node.name)) fail('display-node-name-duplicate');
        stagedByName.set(node.name, node);
      }
    }

    const retainedByName = new Map();
    for (const record of diff.retained.values()) {
      for (const node of allRecordNodes(record)) {
        const existing = retainedByName.get(node.name);
        if (existing && existing !== node) fail('display-node-name-duplicate');
        retainedByName.set(node.name, node);
      }
    }

    const stagedChildrenByParent = new Map();
    for (const node of stagedByName.values()) {
      const parentName = node.parent?.name ?? null;
      if (parentName === null || !retainedByName.has(parentName)) continue;
      let names = stagedChildrenByParent.get(parentName);
      if (names === undefined) {
        names = [];
        stagedChildrenByParent.set(parentName, names);
      }
      names.push(node.name);
    }

    const retainedViews = new Map();
    for (const [name, node] of retainedByName) {
      const names = new Set();
      for (const child of node._children) {
        if (!hiddenLiveNames.has(child.name)) names.add(child.name);
      }
      for (const childName of stagedChildrenByParent.get(name) ?? []) names.add(childName);
      retainedViews.set(name, candidateRetainedNodeView(
        node,
        retainedOverrides,
        Object.freeze([...names]),
      ));
    }

    const graphView = Object.freeze({
      flushWorldTransforms() {
        for (const graph of stageGraphs) graph.flushWorldTransforms();
        return Object.freeze({ transformCount: 0, visibilityCount: 0 });
      },
    });
    const stagedViews = new WeakMap();
    const stagedView = (node) => {
      let view = stagedViews.get(node);
      if (view === undefined) {
        const base = new NodeView(node, graphView);
        const additional = stagedAdditionalChildNames.get(node.name) ?? [];
        view = additional.length === 0 ? base : candidateNodeViewWithChildNames(
          base,
          Object.freeze([...new Set([...base.childNames, ...additional])]),
        );
        stagedViews.set(node, view);
      }
      return view;
    };
    const nodeForName = (name) => {
      const staged = stagedByName.get(name);
      if (staged) return staged;
      const retained = retainedByName.get(name);
      if (retained) return retained;
      return hiddenLiveNames.has(name) ? null : live.nodeIndex.get(name);
    };
    const viewForName = (name) => {
      const staged = stagedByName.get(name);
      if (staged) return stagedView(staged);
      const retained = retainedViews.get(name);
      if (retained) return retained;
      return hiddenLiveNames.has(name) ? null : live.publicDisplay.nodes.get(name);
    };
    const nodeIndex = Object.freeze({
      get: nodeForName,
      require(name) {
        const node = nodeForName(name);
        if (node === null) fail('display-node-missing');
        return node;
      },
      has(name) { return nodeForName(name) !== null; },
    });
    const nodes = Object.freeze({
      get: viewForName,
      require(name) {
        const view = viewForName(name);
        if (view === null) fail('display-node-missing');
        return view;
      },
      has(name) { return viewForName(name) !== null; },
    });
    const publicDisplay = Object.freeze({
      scene: live.publicDisplay.scene,
      nodes,
      getNode: (name) => nodes.get(name),
      requireNode: (name) => nodes.require(name),
      getWorldTransform(name, out = null) {
        const view = nodes.get(name);
        return view === null ? false : view.getWorldTransform(out);
      },
    });
    return Object.freeze({ graphView, nodeIndex, publicDisplay });
  }

  _createCandidateAnimationSystem(bundles) {
    const records = bundles.flatMap((bundle) => [...bundle.records.values()]);
    const firstRecord = records[0];
    if (!firstRecord) fail('display-prefab-scope-missing');
    const system = new AnimationSystem({
      resourceRegistry: firstRecord.compiled.resourceRegistry,
      renderSystem: Object.freeze({
        setAnimationOverride() {},
        clearAnimationOverride() {},
      }),
    });
    for (const record of records) system.bindPrefabScope(record);
    return system;
  }

  _createShadowContext(candidateSurface, candidateAnimationSystem) {
    const live = this._componentContext;
    if (!candidateSurface?.graphView || !candidateSurface?.nodeIndex
        || !candidateSurface?.publicDisplay || !candidateAnimationSystem) {
      fail('display-prefab-scope-missing');
    }
    const stagedAnimationCommands = [];
    const stagedAnimationSystem = Object.freeze({
      applyCommand(requester, operation, playerKey, animationId) {
        candidateAnimationSystem.applyCommand(requester, operation, playerKey, animationId);
        stagedAnimationCommands.push(Object.freeze({
          requester,
          operation,
          playerKey,
          animationId,
        }));
      },
    });
    const context = createInternalComponentContext({
      scene: live.scene,
      nodeIndex: candidateSurface.nodeIndex,
      nodeGraph: candidateSurface.graphView,
      publicDisplay: candidateSurface.publicDisplay,
      animationSystem: stagedAnimationSystem,
      componentAttached(component) {
        if (component instanceof AnimationPlayerComponent) {
          candidateAnimationSystem.register(component);
        }
      },
      componentEnabledChanged(component) {
        if (component instanceof AnimationPlayerComponent) {
          candidateAnimationSystem.setEnabled(component);
        }
      },
      componentPropertiesChanged(component) {
        if (component instanceof AnimationPlayerComponent) {
          candidateAnimationSystem.propertiesChanged(component);
        }
      },
      componentDetaching(component) {
        if (component instanceof AnimationPlayerComponent) {
          candidateAnimationSystem.unregister(component);
        }
      },
    });
    context.stagedAnimationCommands = stagedAnimationCommands;
    return context;
  }
}
