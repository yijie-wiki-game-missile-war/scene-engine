import { assertSynchronous, cloneAndFreeze, exactKeys, plainRecord } from '../internal.js';
import { IDENTITY_TRANSFORM, isIdentityTransform, normalizeTransform } from '../math/transform.js';
import { assertLocalPath } from '../node/node-name.js';
import { fail } from '../runtime/health.js';
import { Resource } from './resource.js';
import { prepareComponentPropertiesPatch } from '../component/component-registry.js';

export const PREFAB_DEFINITION_SCHEMA = 'scene-engine-prefab-definition@2';
const EMPTY_PATCH = Object.freeze({ nodes: Object.freeze({}), components: Object.freeze({}) });
const ENCODER = new TextEncoder();
const PREFAB_ID = /^[a-z0-9][a-z0-9._@-]*(?:\/[a-z0-9][a-z0-9._@-]*)*$/u;
const GAMEPLAY_TYPE = /^[a-z0-9][a-z0-9._-]*$/u;

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
    const record = exactKeys(value, ['schema', 'id', 'gameplayType', 'root'], ['revision', 'resolveState'],
      'display-prefab-definition-invalid');
    if (record.schema !== PREFAB_DEFINITION_SCHEMA) fail('display-prefab-definition-invalid');
    if (Object.hasOwn(record, 'resolveState') && typeof record.resolveState !== 'function') {
      fail('display-prefab-resolver-invalid');
    }
    const { resolveState, ...plain } = record;
    super({ id: assertPrefabId(record.id), schema: record.schema,
      revision: record.revision ?? 0, descriptor: plain });
    this._gameplayType = gameplayType(record.gameplayType);
    this._resolver = resolveState ?? (() => EMPTY_PATCH);
    Object.freeze(this);
  }
  get gameplayType() { return this._gameplayType; }

  compile({ componentRegistry, resourceRegistry }) {
    resourceRegistry.validateReferences();
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
    return Object.freeze({ definition: this, id: this.id, gameplayType: this.gameplayType, root,
      nodes: Object.freeze(nodes), componentRegistry, resourceRegistry });
  }

  resolveState(state, context = {}) {
    const frozenState = cloneAndFreeze(state, 'display-prefab-state-invalid');
    const frozenContext = cloneAndFreeze(context, 'display-prefab-state-context-invalid');
    const result = assertSynchronous(this._resolver(frozenState, frozenContext), 'display-prefab-resolver-async');
    return result == null ? EMPTY_PATCH : cloneAndFreeze(result, 'display-prefab-patch-invalid');
  }

  validatePatch(patch, compiled, currentProperties = null) {
    const record = exactKeys(patch, [], ['nodes', 'components'], 'display-prefab-patch-invalid');
    const nodesPatch = plainRecord(record.nodes ?? {}, 'display-prefab-patch-invalid');
    const componentsPatch = plainRecord(record.components ?? {}, 'display-prefab-patch-invalid');
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
    // Do not clone the normalized component values here. Their object identities carry a
    // package-private, one-shot validation proof into the atomic apply phase.
    return Object.freeze({
      nodes: Object.freeze(Object.fromEntries(Object.entries(normalizedNodes)
        .map(([path, value]) => [path, cloneAndFreeze(value)]))),
      components: Object.freeze(normalizedComponents),
    });
  }

}

export function definePrefab(value) { return new PrefabDefinition(value); }
