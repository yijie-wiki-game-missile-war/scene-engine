import { objectHasOwnMethod } from '../internal.js';
import { fail } from '../runtime/health.js';
import { PrefabDefinition, assertPrefabId } from './prefab-definition.js';
import { SceneDefinition } from './scene-definition.js';
import {
  DisplayKindDefinition,
  assertDisplayKindId,
} from './display-kind-definition.js';

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
    assertFinalDefinition(definition, SceneDefinition, ['compile']);
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
  values() { return this._definitions.values(); }
}

export class PrefabRegistry {
  constructor() { this._definitions = new Map(); this._sealed = false; }
  register(definition) {
    if (this._sealed) fail('display-registry-sealed');
    assertFinalDefinition(definition, PrefabDefinition, ['compile', '_compileBase', 'validatePatch']);
    const id = assertPrefabId(definition.id);
    if (this._definitions.has(id)) fail('display-prefab-id-duplicate');
    this._definitions.set(id, definition);
    return definition;
  }
  seal() { this._sealed = true; return this; }
  get(prefabId) {
    return this._definitions.get(assertPrefabId(prefabId)) ?? null;
  }
  require(prefabId) {
    const result = this.get(prefabId);
    if (!result) fail('display-prefab-missing');
    return result;
  }
  values() { return this._definitions.values(); }
}

export class DisplayKindRegistry {
  constructor() { this._definitions = new Map(); this._sealed = false; }
  register(definition) {
    if (this._sealed) fail('display-registry-sealed');
    assertFinalDefinition(definition, DisplayKindDefinition, ['describe', 'resolvePrefab']);
    const id = assertDisplayKindId(definition.id);
    if (this._definitions.has(id)) fail('display-kind-id-duplicate');
    this._definitions.set(id, definition);
    return definition;
  }
  seal() { this._sealed = true; return this; }
  get(displayKindId) {
    return this._definitions.get(assertDisplayKindId(displayKindId)) ?? null;
  }
  require(displayKindId) {
    const result = this.get(displayKindId);
    if (!result) fail('display-kind-missing');
    return result;
  }
  values() { return this._definitions.values(); }
  validatePrefabImplementations(prefabRegistry) {
    if (typeof prefabRegistry?.require !== 'function') fail('display-kind-registry-invalid');
    for (const definition of this._definitions.values()) {
      for (const prefabId of definition.authorityPrefabIds) {
        const prefab = prefabRegistry.require(prefabId);
        if (prefab.gameplayType !== definition.gameplayType) {
          fail('display-kind-prefab-gameplay-type-mismatch');
        }
      }
    }
    return this;
  }
}

export function createSceneRegistry(initial = []) {
  const registry = new SceneRegistry();
  for (const definition of initial) registry.register(definition);
  return registry;
}
export function createPrefabRegistry(initial = []) {
  const registry = new PrefabRegistry();
  for (const definition of initial) registry.register(definition);
  return registry;
}
export function createDisplayKindRegistry(initial = []) {
  const registry = new DisplayKindRegistry();
  for (const definition of initial) registry.register(definition);
  return registry;
}
