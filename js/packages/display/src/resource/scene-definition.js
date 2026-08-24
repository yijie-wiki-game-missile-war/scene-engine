import { cloneAndFreeze, exactKeys, nonemptyString, safeInteger } from '../internal.js';
import { IDENTITY_TRANSFORM, normalizeTransform } from '../math/transform.js';
import { assertLocalPath } from '../node/node-name.js';
import { fail } from '../runtime/health.js';
import { CameraComponent } from '../render/components.js';
import { Resource } from './resource.js';

export const SCENE_DEFINITION_SCHEMA = 'scene-engine-scene-definition@1';

function normalizeRendererProfile(value) {
  const record = exactKeys(value, ['drawMode', 'maximumPixelRatio', 'clearRgba', 'antialias',
    'alpha', 'shadows', 'toneMapping'], [], 'display-renderer-profile-invalid');
  if (!['requested', 'continuous'].includes(record.drawMode)
      || typeof record.maximumPixelRatio !== 'number' || !Number.isFinite(record.maximumPixelRatio)
      || record.maximumPixelRatio <= 0
      || !Number.isSafeInteger(record.clearRgba) || record.clearRgba < 0 || record.clearRgba > 0xffffffff
      || typeof record.antialias !== 'boolean' || typeof record.alpha !== 'boolean'
      || typeof record.shadows !== 'boolean' || !['none', 'aces-filmic'].includes(record.toneMapping)) {
    fail('display-renderer-profile-invalid');
  }
  return cloneAndFreeze(record);
}

function validateComponentSet(components, componentRegistry) {
  const keys = new Set(); const types = new Map(); let transformDriver = false;
  for (const component of components) {
    if (keys.has(component.key)) fail('display-component-key-duplicate');
    keys.add(component.key);
    const descriptor = componentRegistry.require(component.type);
    const ComponentClass = descriptor.ComponentClass;
    if (!ComponentClass.allowMultiple && types.has(component.type)) fail('display-component-type-duplicate');
    types.set(component.type, true);
    if (ComponentClass.drivesTransform) {
      if (transformDriver) fail('display-transform-driver-conflict');
      transformDriver = true;
    }
  }
}

function orderAndValidateParents(entries, code) {
  const byName = new Map(entries.map((entry) => [entry.localName, entry]));
  const ordered = []; const state = new Map();
  const visit = (entry) => {
    if (state.get(entry.localName) === 1) fail(code);
    if (state.get(entry.localName) === 2) return;
    state.set(entry.localName, 1);
    if (entry.parentLocalName !== null) {
      const parent = byName.get(entry.parentLocalName);
      if (!parent) fail('display-scene-parent-missing');
      visit(parent);
    }
    state.set(entry.localName, 2);
    ordered.push(entry);
  };
  for (const entry of entries) visit(entry);
  return ordered;
}

export class SceneDefinition extends Resource {
  constructor(value) {
    const record = exactKeys(value, ['schema', 'id', 'sceneProfile', 'rendererProfile',
      'activeCameraLocalName', 'nodes', 'prefabInstances'], ['revision'],
    'display-scene-definition-invalid');
    if (record.schema !== SCENE_DEFINITION_SCHEMA || !Array.isArray(record.nodes)
        || !Array.isArray(record.prefabInstances)) fail('display-scene-definition-invalid');
    const descriptor = cloneAndFreeze(record, 'display-scene-definition-invalid');
    super({ id: nonemptyString(record.id, 'display-scene-id-invalid'), schema: record.schema,
      revision: record.revision ?? 0, descriptor });
    Object.freeze(this);
  }

  compile({ componentRegistry, resourceRegistry, prefabRegistry }) {
    resourceRegistry.validateReferences();
    const source = this.describe();
    const sceneProfile = nonemptyString(source.sceneProfile, 'display-scene-profile-invalid');
    const rendererProfile = normalizeRendererProfile(source.rendererProfile);
    const allLocalNames = new Set();
    const nodes = source.nodes.map((value) => {
      const record = exactKeys(value, ['localName', 'parentLocalName', 'components'],
        ['transform', 'visible', 'label'], 'display-scene-node-definition-invalid');
      const localName = assertLocalPath(record.localName);
      if (allLocalNames.has(localName)) fail('display-scene-local-name-duplicate');
      allLocalNames.add(localName);
      const parentLocalName = record.parentLocalName === null ? null : assertLocalPath(record.parentLocalName);
      if (!Array.isArray(record.components)) fail('display-scene-node-definition-invalid');
      const components = record.components.map((component) => componentRegistry.compile(component, resourceRegistry));
      validateComponentSet(components, componentRegistry);
      const visible = Object.hasOwn(record, 'visible') ? record.visible : true;
      if (typeof visible !== 'boolean') fail('display-scene-node-definition-invalid');
      return Object.freeze({
        localName,
        parentLocalName,
        transform: normalizeTransform(record.transform ?? IDENTITY_TRANSFORM),
        visible,
        label: record.label ?? null,
        components: Object.freeze(components),
      });
    });
    const prefabInstances = source.prefabInstances.map((value) => {
      const record = exactKeys(value, ['localName', 'parentLocalName', 'prefabType'],
        ['transform', 'visible', 'state'], 'display-scene-prefab-instance-invalid');
      const localName = assertLocalPath(record.localName);
      if (allLocalNames.has(localName)) fail('display-scene-local-name-duplicate');
      allLocalNames.add(localName);
      const definition = prefabRegistry.require(sceneProfile, record.prefabType);
      const visible = Object.hasOwn(record, 'visible') ? record.visible : true;
      if (typeof visible !== 'boolean') fail('display-scene-prefab-instance-invalid');
      return Object.freeze({
        localName,
        parentLocalName: record.parentLocalName === null ? null : assertLocalPath(record.parentLocalName),
        prefabType: definition.logicalType,
        definition,
        compiledPrefab: definition.compile({ componentRegistry, resourceRegistry }),
        transform: normalizeTransform(record.transform ?? IDENTITY_TRANSFORM),
        visible,
        state: cloneAndFreeze(record.state ?? {}, 'display-prefab-state-invalid'),
      });
    });
    const ordered = orderAndValidateParents([...nodes, ...prefabInstances], 'display-scene-cycle');
    const activeCameraLocalName = assertLocalPath(source.activeCameraLocalName);
    const cameraNode = nodes.find((node) => node.localName === activeCameraLocalName);
    if (!cameraNode || !cameraNode.components.some((component) => component.type === CameraComponent.typeId)) {
      fail('display-active-camera-invalid');
    }
    return Object.freeze({
      definition: this,
      id: this.id,
      sceneProfile,
      rendererProfile,
      activeCameraLocalName,
      nodes: Object.freeze(nodes),
      prefabInstances: Object.freeze(prefabInstances),
      ordered: Object.freeze(ordered),
    });
  }

  instantiate(scene) { return scene.loader.installCompiled(this.compile(scene.registries)); }
}

export function defineScene(value) { return new SceneDefinition(value); }
