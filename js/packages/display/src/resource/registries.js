import { nonemptyString, objectHasOwnMethod } from '../internal.js';
import { fail } from '../runtime/health.js';
import { PrefabDefinition } from './prefab-definition.js';
import { SceneDefinition } from './scene-definition.js';

function assertFinalDefinition(definition, Base, methods) {
  if (!(definition instanceof Base)) fail('display-definition-invalid');
  for (let prototype = definition.constructor.prototype; prototype && prototype !== Base.prototype;
    prototype = Object.getPrototypeOf(prototype)) {
    if (objectHasOwnMethod(prototype, methods)) fail('display-definition-final-method-override');
  }
}

export class SceneRegistry {
  constructor() { this._definitions = new Map(); this._sealed = false; }
  register(definition) {
    if (this._sealed) fail('display-registry-sealed');
    assertFinalDefinition(definition, SceneDefinition, ['compile', 'instantiate']);
    if (this._definitions.has(definition.id)) fail('display-scene-id-duplicate');
    this._definitions.set(definition.id, definition);
    return definition;
  }
  seal() { this._sealed = true; return this; }
  get(id) { return this._definitions.get(id) ?? null; }
  require(id) {
    const result = this.get(id);
    if (!result) fail('display-scene-missing');
    return result;
  }
}

export class PrefabRegistry {
  constructor() { this._definitions = new Map(); this._sealed = false; }
  register({ sceneProfile, logicalType, definition }) {
    if (this._sealed) fail('display-registry-sealed');
    assertFinalDefinition(definition, PrefabDefinition, ['compile', 'instantiate', 'validatePatch']);
    const profile = nonemptyString(sceneProfile, 'display-scene-profile-invalid');
    const type = nonemptyString(logicalType, 'display-prefab-type-invalid');
    if (definition.logicalType !== type) fail('display-prefab-type-mismatch');
    const key = `${profile}\u0000${type}`;
    if (this._definitions.has(key)) fail('display-prefab-type-duplicate');
    this._definitions.set(key, definition);
    return definition;
  }
  seal() { this._sealed = true; return this; }
  get(sceneProfile, logicalType) {
    return this._definitions.get(`${sceneProfile}\u0000${logicalType}`) ?? null;
  }
  require(sceneProfile, logicalType) {
    const result = this.get(sceneProfile, logicalType);
    if (!result) fail('display-prefab-missing');
    return result;
  }
}

export function createSceneRegistry(initial = []) {
  const registry = new SceneRegistry();
  for (const definition of initial) registry.register(definition);
  return registry;
}
export function createPrefabRegistry(initial = []) {
  const registry = new PrefabRegistry();
  for (const entry of initial) registry.register(entry);
  return registry;
}
