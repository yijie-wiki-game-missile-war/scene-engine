import {
  assertSynchronous,
  cloneAndFreeze,
  exactKeys,
  plainRecord,
  safeInteger,
} from '../internal.js';
import { IDENTITY_TRANSFORM, isIdentityTransform, normalizeTransform } from '../math/transform.js';
import { assertLocalPath } from '../node/node-name.js';
import { fail } from '../runtime/health.js';
import { validateCompiledPrefabAnimationBindings } from '../animation/animation-system.js';
import { AnimationPlayerComponent } from '../animation/animation-player.js';
import { Resource } from './resource.js';
import { prepareComponentPropertiesPatch } from '../component/component-registry.js';
import { compilePrefabCatalog } from './prefab-compiler.js';

export const PREFAB_DEFINITION_SCHEMA = 'scene-engine-prefab-definition@3';
const EMPTY_PATCH = Object.freeze({ nodes: Object.freeze({}), components: Object.freeze({}) });
const ENCODER = new TextEncoder();
const PREFAB_ID = /^[a-z0-9][a-z0-9._@-]*(?:\/[a-z0-9][a-z0-9._@-]*)*$/u;
const GAMEPLAY_TYPE = /^[a-z0-9][a-z0-9._-]*$/u;
const INSTANCE_KEY = /^[a-z0-9][a-z0-9._-]*$/u;

export function assertPrefabId(value) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !PREFAB_ID.test(value)) fail('display-prefab-id-invalid');
  return value;
}

function gameplayType(value) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !GAMEPLAY_TYPE.test(value)) fail('display-prefab-gameplay-type-invalid');
  return value;
}

export function assertPrefabInstanceKey(value) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !INSTANCE_KEY.test(value)) fail('display-prefab-instance-key-invalid');
  return value;
}

function prefabState(value) {
  return cloneAndFreeze(plainRecord(value, 'display-prefab-state-invalid'),
    'display-prefab-state-invalid');
}

function instanceParent(value, ownNodePaths) {
  if (value === null) return null;
  const parentLocalPath = assertLocalPath(value, 'display-prefab-instance-parent-missing');
  if (!ownNodePaths.has(parentLocalPath)) fail('display-prefab-instance-parent-missing');
  return parentLocalPath;
}

function validateComponentSet(components, componentRegistry) {
  const keys = new Set(); const types = new Set(); let drives = false;
  for (const component of components) {
    if (keys.has(component.key)) fail('display-component-key-duplicate');
    keys.add(component.key);
    const ComponentClass = componentRegistry.require(component.type).ComponentClass;
    if (!ComponentClass.allowMultiple && types.has(component.type)) fail('display-component-type-duplicate');
    types.add(component.type);
    if (ComponentClass.drivesTransform) {
      if (drives) fail('display-transform-driver-conflict');
      drives = true;
    }
  }
}

export class PrefabDefinition extends Resource {
  constructor(value) {
    const record = exactKeys(value, ['schema', 'id', 'gameplayType', 'root'], [
      'revision', 'resolveState', 'prefabInstances', 'prefabSlots',
    ], 'display-prefab-definition-invalid');
    if (record.schema !== PREFAB_DEFINITION_SCHEMA) fail('display-prefab-definition-invalid');
    if (Object.hasOwn(record, 'resolveState') && typeof record.resolveState !== 'function') {
      fail('display-prefab-resolver-invalid');
    }
    if ((Object.hasOwn(record, 'prefabInstances') && !Array.isArray(record.prefabInstances))
        || (Object.hasOwn(record, 'prefabSlots') && !Array.isArray(record.prefabSlots))) {
      fail('display-prefab-definition-invalid');
    }
    const { resolveState, ...plain } = record;
    plain.prefabInstances = record.prefabInstances ?? [];
    plain.prefabSlots = record.prefabSlots ?? [];
    super({ id: assertPrefabId(record.id), schema: record.schema,
      revision: record.revision ?? 0, descriptor: plain });
    this._gameplayType = gameplayType(record.gameplayType);
    this._resolver = resolveState ?? (() => EMPTY_PATCH);
    Object.freeze(this);
  }
  get gameplayType() { return this._gameplayType; }

  compile({ componentRegistry, resourceRegistry, prefabRegistry = null,
    compiledPrefabCatalog = null }) {
    if (compiledPrefabCatalog !== null) {
      if (typeof compiledPrefabCatalog?.require !== 'function') {
        fail('display-prefab-compile-registry-invalid');
      }
      const compiled = compiledPrefabCatalog.require(this.id);
      if (compiled.definition !== this) fail('display-prefab-compile-registry-invalid');
      return compiled;
    }
    const base = this._compileBase({ componentRegistry, resourceRegistry });
    if (base.prefabInstances.length === 0 && base.prefabSlots.length === 0) return base;
    if (prefabRegistry === null) fail('display-prefab-missing');
    return compilePrefabCatalog({ prefabRegistry, componentRegistry, resourceRegistry }).require(this.id);
  }

  _compileBase({ componentRegistry, resourceRegistry, validateResourceReferences = true }) {
    if (validateResourceReferences) resourceRegistry.validateReferences();
    const source = this.describe();
    const paths = new Set(); const nodes = [];
    const compileNode = (value, parentPath, isRoot = false) => {
      const record = exactKeys(value, ['components', 'children'], ['localName', 'transform', 'visible', 'label'],
        'display-prefab-node-definition-invalid');
      if (!Array.isArray(record.components) || !Array.isArray(record.children)) {
        fail('display-prefab-node-definition-invalid');
      }
      let localPath = null;
      if (!isRoot) {
        const localName = assertLocalPath(record.localName);
        localPath = parentPath === null ? localName : `${parentPath}/${localName}`;
        assertLocalPath(localPath);
        if (paths.has(localPath)) fail('display-prefab-local-name-duplicate');
        paths.add(localPath);
      } else if (Object.hasOwn(record, 'localName')) {
        fail('display-prefab-root-invalid');
      }
      const transform = normalizeTransform(record.transform ?? IDENTITY_TRANSFORM);
      if (isRoot && !isIdentityTransform(transform)) fail('display-prefab-root-transform-invalid');
      const components = record.components.map((component) => componentRegistry.compile(component, resourceRegistry));
      if (!isRoot) {
        for (const component of components) {
          if (component.type === AnimationPlayerComponent.typeId) {
            fail('display-animation-player-placement-invalid',
              'Animation players are only allowed on the Prefab root node.');
          }
        }
      }
      validateComponentSet(components, componentRegistry);
      const visible = Object.hasOwn(record, 'visible') ? record.visible : true;
      if (typeof visible !== 'boolean') fail('display-prefab-node-definition-invalid');
      const compiled = Object.freeze({
        localPath,
        parentLocalPath: parentPath,
        transform,
        visible,
        label: record.label ?? null,
        components: Object.freeze(components),
      });
      if (!isRoot) nodes.push(compiled);
      for (const child of record.children) compileNode(child, localPath, false);
      return compiled;
    };
    const root = compileNode(source.root, null, true);
    validateCompiledPrefabAnimationBindings({ root, nodes }, resourceRegistry);
    const ownNodePaths = new Set(nodes.map((node) => node.localPath));
    const instanceKeys = new Set();
    const takeKey = (value) => {
      const key = assertPrefabInstanceKey(value);
      if (instanceKeys.has(key)) fail('display-prefab-instance-key-duplicate');
      instanceKeys.add(key);
      return key;
    };
    const prefabInstances = source.prefabInstances.map((value) => {
      const record = exactKeys(value, ['key', 'parentLocalPath', 'prefabId'], [
        'transform', 'visible', 'state',
      ], 'display-prefab-instance-definition-invalid');
      const visible = Object.hasOwn(record, 'visible') ? record.visible : true;
      if (typeof visible !== 'boolean') fail('display-prefab-instance-definition-invalid');
      return Object.freeze({
        key: takeKey(record.key),
        parentLocalPath: instanceParent(record.parentLocalPath, ownNodePaths),
        prefabId: assertPrefabId(record.prefabId),
        transform: normalizeTransform(record.transform ?? IDENTITY_TRANSFORM),
        visible,
        state: prefabState(record.state ?? {}),
      });
    });
    const prefabSlots = source.prefabSlots.map((value) => {
      const record = exactKeys(value, [
        'key', 'parentLocalPath', 'allowedPrefabIds', 'maximumInstances',
      ], [], 'display-prefab-dynamic-policy-invalid');
      if (!Array.isArray(record.allowedPrefabIds) || record.allowedPrefabIds.length === 0) {
        fail('display-prefab-dynamic-policy-invalid');
      }
      const allowedPrefabIds = record.allowedPrefabIds.map((id) => assertPrefabId(id));
      if (new Set(allowedPrefabIds).size !== allowedPrefabIds.length) {
        fail('display-prefab-dynamic-policy-invalid');
      }
      return Object.freeze({
        key: takeKey(record.key),
        parentLocalPath: instanceParent(record.parentLocalPath, ownNodePaths),
        allowedPrefabIds: Object.freeze(allowedPrefabIds),
        maximumInstances: safeInteger(record.maximumInstances,
          'display-prefab-dynamic-policy-invalid', { minimum: 1 }),
      });
    });
    return Object.freeze({ definition: this, id: this.id, gameplayType: this.gameplayType, root,
      nodes: Object.freeze(nodes),
      prefabInstances: Object.freeze(prefabInstances),
      prefabSlots: Object.freeze(prefabSlots),
      componentRegistry,
      resourceRegistry,
    });
  }

  resolveState(state, context = {}) {
    const frozenState = cloneAndFreeze(state, 'display-prefab-state-invalid');
    const frozenContext = cloneAndFreeze(context, 'display-prefab-state-context-invalid');
    const result = assertSynchronous(this._resolver(frozenState, frozenContext), 'display-prefab-resolver-async');
    return result == null ? EMPTY_PATCH : cloneAndFreeze(result, 'display-prefab-patch-invalid');
  }

  validatePatch(patch, compiled, currentProperties = null) {
    const record = exactKeys(patch, [], [
      'nodes', 'components', 'prefabInstances', 'prefabSlots',
    ], 'display-prefab-patch-invalid');
    const nodesPatch = plainRecord(record.nodes ?? {}, 'display-prefab-patch-invalid');
    const componentsPatch = plainRecord(record.components ?? {}, 'display-prefab-patch-invalid');
    const instancesPatch = plainRecord(record.prefabInstances ?? {}, 'display-prefab-patch-invalid');
    const slotsPatch = plainRecord(record.prefabSlots ?? {}, 'display-prefab-patch-invalid');
    const byPath = new Map(compiled.nodes.map((node) => [node.localPath, node]));
    const componentByPath = new Map();
    for (const node of [compiled.root, ...compiled.nodes]) {
      for (const component of node.components) {
        const prefix = node.localPath === null ? '$root' : node.localPath;
        componentByPath.set(`${prefix}/${component.key}`, component);
      }
    }
    const normalizedNodes = {};
    for (const [path, value] of Object.entries(nodesPatch)) {
      if (!byPath.has(path)) fail('display-prefab-patch-target-missing');
      const nodePatch = exactKeys(value, [], ['visible', 'transform'], 'display-prefab-patch-invalid');
      if (Object.hasOwn(nodePatch, 'visible') && typeof nodePatch.visible !== 'boolean') {
        fail('display-prefab-patch-invalid');
      }
      normalizedNodes[path] = {
        ...(Object.hasOwn(nodePatch, 'visible') ? { visible: nodePatch.visible } : {}),
        ...(Object.hasOwn(nodePatch, 'transform') ? { transform: normalizeTransform(nodePatch.transform) } : {}),
      };
    }
    const normalizedComponents = {};
    for (const [path, value] of Object.entries(componentsPatch)) {
      const base = componentByPath.get(path);
      if (!base) fail('display-prefab-patch-target-missing');
      const current = currentProperties?.get(path) ?? base.properties;
      normalizedComponents[path] = prepareComponentPropertiesPatch(compiled.componentRegistry, {
        typeId: base.type,
        currentProperties: current,
        patch: plainRecord(value, 'display-prefab-patch-invalid'),
        resourceRegistry: compiled.resourceRegistry,
      });
    }
    const fixedByKey = new Map(compiled.prefabInstances.map((instance) => [instance.key, instance]));
    for (const key of Object.keys(instancesPatch)) {
      if (!fixedByKey.has(key)) fail('display-prefab-patch-target-missing');
    }
    const prefabInstances = compiled.prefabInstances.map((instance) => {
      const value = instancesPatch[instance.key] ?? {};
      const override = exactKeys(value, [], ['transform', 'visible', 'state'],
        'display-prefab-patch-invalid');
      if (Object.hasOwn(override, 'visible') && typeof override.visible !== 'boolean') {
        fail('display-prefab-patch-invalid');
      }
      return Object.freeze({
        sourceKind: 'fixed',
        instancePath: instance.key,
        key: instance.key,
        parentLocalPath: instance.parentLocalPath,
        prefabId: instance.prefabId,
        definition: instance.definition,
        compiledPrefab: instance.compiledPrefab,
        transform: Object.hasOwn(override, 'transform')
          ? normalizeTransform(override.transform) : instance.transform,
        visible: Object.hasOwn(override, 'visible') ? override.visible : instance.visible,
        state: Object.hasOwn(override, 'state') ? prefabState(override.state) : instance.state,
      });
    });
    const slotByKey = new Map(compiled.prefabSlots.map((slot) => [slot.key, slot]));
    for (const key of Object.keys(slotsPatch)) {
      if (!slotByKey.has(key)) fail('display-prefab-patch-target-missing');
    }
    const prefabSlots = [];
    for (const slot of compiled.prefabSlots) {
      const desired = plainRecord(slotsPatch[slot.key] ?? {}, 'display-prefab-patch-invalid');
      const keys = Object.keys(desired).sort();
      if (keys.length > slot.maximumInstances) fail('display-prefab-instance-count-limit');
      const allowed = new Map(slot.allowedPrefabs.map((entry) => [entry.prefabId, entry]));
      for (const keyValue of keys) {
        const key = assertPrefabInstanceKey(keyValue);
        const value = exactKeys(desired[keyValue], ['prefabId'], ['transform', 'visible', 'state'],
          'display-prefab-patch-invalid');
        const selected = allowed.get(value.prefabId);
        if (!selected) fail('display-prefab-instance-id-not-allowed');
        const visible = Object.hasOwn(value, 'visible') ? value.visible : true;
        if (typeof visible !== 'boolean') fail('display-prefab-patch-invalid');
        prefabSlots.push(Object.freeze({
          sourceKind: 'slot',
          instancePath: `${slot.key}/${key}`,
          slotKey: slot.key,
          key,
          parentLocalPath: slot.parentLocalPath,
          prefabId: selected.prefabId,
          definition: selected.definition,
          compiledPrefab: selected.compiledPrefab,
          transform: normalizeTransform(value.transform ?? IDENTITY_TRANSFORM),
          visible,
          state: prefabState(value.state ?? {}),
        }));
      }
    }
    // Do not clone the normalized component values here. Their object identities carry a
    // package-private, one-shot validation proof into the atomic apply phase.
    return Object.freeze({
      nodes: Object.freeze(Object.fromEntries(Object.entries(normalizedNodes)
        .map(([path, value]) => [path, cloneAndFreeze(value)]))),
      components: Object.freeze(normalizedComponents),
      prefabInstances: Object.freeze(prefabInstances),
      prefabSlots: Object.freeze(prefabSlots),
    });
  }

}

export function definePrefab(value) { return new PrefabDefinition(value); }
