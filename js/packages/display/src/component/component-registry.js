import {
  cloneAndFreeze,
  exactKeys,
  nonemptyString,
  objectHasOwnMethod,
  plainRecord,
  protocolNameSet,
} from '../internal.js';
import { fail } from '../runtime/health.js';
import { BillboardComponent, BILLBOARD_COMPONENT_DESCRIPTOR } from '../behaviours/billboard.js';
import { LookAtComponent, LOOK_AT_COMPONENT_DESCRIPTOR } from '../behaviours/look-at.js';
import { ANIMATION_PLAYER_COMPONENT_DESCRIPTOR } from '../animation/animation-player.js';
import { AuthorityComponent } from './authority-component.js';
import { BehaviourComponent } from './behaviour-component.js';
import { Component, replaceComponentProperties } from './component.js';
import { RenderComponent } from '../render/render-component.js';
import { RENDER_COMPONENT_DESCRIPTORS } from '../render/components.js';
import { POINTER_TARGET_COMPONENT_DESCRIPTOR } from '../interaction/pointer-target-component.js';

const FINAL_METHODS = ['attach', 'setEnabled', 'setDrivenLocalTransform', 'setAnimation',
  'playAnimation', 'stopAnimation', '_animationCommand', '_adoptContext',
  'patchProperties', 'dispose'];
const FORBIDDEN_TRANSFORM_FIELDS = new Set([
  'position', 'rotation', 'rotationXyzw', 'scale', 'transform', 'matrix', 'worldMatrix',
  'localTransform',
]);
const PREPARED_PROPERTY_PATCHES = new WeakMap();

function assertNoComponentTransform(properties) {
  for (const key of Object.keys(properties)) {
    if (FORBIDDEN_TRANSFORM_FIELDS.has(key)) fail('display-component-transform-forbidden');
  }
}

function validateReference(resourceRegistry, reference) {
  if (typeof reference === 'string') {
    resourceRegistry.require(reference);
    return;
  }
  const record = exactKeys(reference, ['id', 'kinds'], [], 'display-component-resource-validator-invalid');
  if (!Array.isArray(record.kinds) || record.kinds.length === 0
      || record.kinds.some((kind) => typeof kind !== 'string')) {
    fail('display-component-resource-validator-invalid');
  }
  const resource = resourceRegistry.require(record.id);
  if (!record.kinds.includes(resource.describe().kind)) {
    fail('display-resource-reference-kind-invalid');
  }
}

function requireResourceRegistry(resourceRegistry) {
  if (!resourceRegistry || typeof resourceRegistry.require !== 'function') {
    fail('display-component-resource-registry-invalid');
  }
  return resourceRegistry;
}

function componentType(component) {
  if (!component || component.disposed) fail('display-component-invalid');
  return nonemptyString(component.constructor?.typeId, 'display-component-type-invalid');
}

/**
 * Package-private transaction preflight used by PrefabDefinition.  The returned object is
 * normalized and resource-validated, and its identity carries a one-shot proof consumed by
 * ComponentRegistry.patchComponentProperties().  It is deliberately not re-exported by the
 * package entry point.
 */
export function prepareComponentPropertiesPatch(registry, {
  typeId,
  currentProperties,
  patch,
  resourceRegistry,
}) {
  if (!(registry instanceof ComponentRegistry)) fail('display-component-registry-invalid');
  const resources = requireResourceRegistry(resourceRegistry);
  const current = plainRecord(currentProperties, 'display-component-properties-invalid');
  const delta = plainRecord(patch, 'display-component-properties-invalid');
  const properties = registry.normalizeProperties(typeId, { ...current, ...delta }, resources);
  registry.validateResourceReferences(typeId, properties, resources);
  PREPARED_PROPERTY_PATCHES.set(properties, Object.freeze({
    registry,
    typeId,
    currentProperties,
    resourceRegistry: resources,
  }));
  return properties;
}

export class ComponentRegistry {
  constructor() { this._types = new Map(); this._sealed = false; }

  register({ ComponentClass, normalizeProperties = (value) => cloneAndFreeze(value),
    resourceReferences = () => [] }) {
    if (this._sealed) fail('display-registry-sealed');
    if (typeof ComponentClass !== 'function' || !(ComponentClass.prototype instanceof Component)) {
      fail('display-component-class-invalid');
    }
    const typeId = nonemptyString(ComponentClass.typeId, 'display-component-type-invalid');
    if (this._types.has(typeId)) fail('display-component-type-duplicate');
    const eventNames = protocolNameSet(
      ComponentClass.eventNames === undefined ? [] : ComponentClass.eventNames,
      'display-component-event-names-invalid',
    );
    for (let prototype = ComponentClass.prototype; prototype && prototype !== Component.prototype;
      prototype = Object.getPrototypeOf(prototype)) {
      const override = objectHasOwnMethod(prototype, FINAL_METHODS);
      if (override) fail('display-component-final-method-override');
    }
    if (ComponentClass.prototype instanceof RenderComponent) {
      if (eventNames.length !== 0) fail('display-render-component-handler-forbidden');
      for (let prototype = ComponentClass.prototype; prototype && prototype !== RenderComponent.prototype;
        prototype = Object.getPrototypeOf(prototype)) {
        if (objectHasOwnMethod(prototype, ['onAttach', 'tick', 'onDispose', 'onEvent'])) {
          fail('display-render-component-handler-forbidden');
        }
      }
    }
    if (!(ComponentClass.prototype instanceof BehaviourComponent)) {
      if (eventNames.length !== 0) fail('display-component-event-handler-forbidden');
      for (let prototype = ComponentClass.prototype;
        prototype && prototype !== Component.prototype;
        prototype = Object.getPrototypeOf(prototype)) {
        if (objectHasOwnMethod(prototype, ['onEvent'])) {
          fail('display-component-event-handler-forbidden');
        }
      }
    }
    const phase = ComponentClass.tickPhase;
    if (![null, 'update', 'before-render'].includes(phase)) fail('display-component-tick-phase-invalid');
    this._types.set(typeId, Object.freeze({
      ComponentClass,
      eventNames,
      normalizeProperties,
      resourceReferences,
    }));
    return this;
  }

  seal() { this._sealed = true; return this; }

  has(typeId) { return this._types.has(typeId); }
  catalogEntries() {
    return Object.freeze([...this._types].map(([typeId, descriptor]) => Object.freeze({
      typeId,
      allowMultiple: descriptor.ComponentClass.allowMultiple === true,
      tickPhase: descriptor.ComponentClass.tickPhase ?? null,
      drivesTransform: descriptor.ComponentClass.drivesTransform === true,
      eventNames: descriptor.eventNames,
    })).sort((left, right) => left.typeId < right.typeId ? -1 : left.typeId > right.typeId ? 1 : 0));
  }
  require(typeId) {
    const descriptor = this._types.get(typeId);
    if (!descriptor) fail('display-component-type-missing');
    return descriptor;
  }

  compile(definition, resourceRegistry = null) {
    const record = exactKeys(definition, ['key', 'type'], ['enabled', 'properties'],
      'display-component-definition-invalid');
    const typeId = nonemptyString(record.type, 'display-component-type-invalid');
    if (typeId === AuthorityComponent.typeId) fail('display-authority-component-definition-forbidden');
    const descriptor = this.require(typeId);
    const key = nonemptyString(record.key, 'display-component-key-invalid');
    const enabled = Object.hasOwn(record, 'enabled') ? record.enabled : true;
    if (typeof enabled !== 'boolean') fail('display-component-enabled-invalid');
    const properties = this.normalizeProperties(typeId, record.properties ?? {}, resourceRegistry);
    this.validateResourceReferences(typeId, properties, resourceRegistry);
    return cloneAndFreeze({ key, type: typeId, enabled, properties });
  }

  create(compiled) {
    const descriptor = this.require(compiled.type);
    const component = new descriptor.ComponentClass({
      key: compiled.key,
      enabled: compiled.enabled,
      properties: compiled.properties,
    });
    // Component constructors defensively clone arbitrary caller data.  Registry-created
    // instances can safely adopt the already compiled, deeply frozen identity; this also lets
    // a transaction preflight be consumed without normalizing the same patch twice.
    replaceComponentProperties(component, compiled.properties);
    return component;
  }

  patchComponentProperties(value) {
    const record = exactKeys(value, ['component', 'patch', 'resourceRegistry'], [],
      'display-component-property-patch-invalid');
    const typeId = componentType(record.component);
    const descriptor = this.require(typeId);
    if (!(record.component instanceof descriptor.ComponentClass)) fail('display-component-invalid');
    const resources = requireResourceRegistry(record.resourceRegistry);
    const patch = plainRecord(record.patch, 'display-component-properties-invalid');
    const prepared = PREPARED_PROPERTY_PATCHES.get(patch);
    let properties;
    if (prepared?.registry === this && prepared.typeId === typeId
        && prepared.currentProperties === record.component.properties
        && prepared.resourceRegistry === resources) {
      PREPARED_PROPERTY_PATCHES.delete(patch);
      properties = patch;
    } else {
      properties = prepareComponentPropertiesPatch(this, {
        typeId,
        currentProperties: record.component.properties,
        patch,
        resourceRegistry: resources,
      });
      PREPARED_PROPERTY_PATCHES.delete(properties);
    }
    return replaceComponentProperties(record.component, properties);
  }

  normalizeProperties(typeId, value, resourceRegistry = null) {
    const descriptor = this.require(typeId);
    const properties = cloneAndFreeze(
      descriptor.normalizeProperties(value, resourceRegistry),
      'display-component-properties-invalid',
    );
    assertNoComponentTransform(properties);
    return properties;
  }

  validateResourceReferences(typeId, properties, resourceRegistry) {
    const references = this.require(typeId).resourceReferences(properties);
    if (!Array.isArray(references)) fail('display-component-resource-validator-invalid');
    if (resourceRegistry) {
      for (const reference of references) validateReference(resourceRegistry, reference);
    }
    return references;
  }
}

export function createComponentRegistry({ includeBuiltIns = true } = {}) {
  const registry = new ComponentRegistry();
  if (includeBuiltIns) {
    for (const descriptor of RENDER_COMPONENT_DESCRIPTORS) registry.register(descriptor);
    registry.register(ANIMATION_PLAYER_COMPONENT_DESCRIPTOR);
    registry.register(BILLBOARD_COMPONENT_DESCRIPTOR);
    registry.register(LOOK_AT_COMPONENT_DESCRIPTOR);
    registry.register(POINTER_TARGET_COMPONENT_DESCRIPTOR);
  }
  return registry;
}

export { BillboardComponent, LookAtComponent, BehaviourComponent };
