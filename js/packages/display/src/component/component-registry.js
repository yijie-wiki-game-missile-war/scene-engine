import { cloneAndFreeze, exactKeys, nonemptyString, objectHasOwnMethod } from '../internal.js';
import { fail } from '../runtime/health.js';
import { BillboardComponent, BILLBOARD_COMPONENT_DESCRIPTOR } from '../behaviours/billboard.js';
import { LookAtComponent, LOOK_AT_COMPONENT_DESCRIPTOR } from '../behaviours/look-at.js';
import { AuthorityComponent } from './authority-component.js';
import { BehaviourComponent } from './behaviour-component.js';
import { Component } from './component.js';
import { RenderComponent } from '../render/render-component.js';
import { RENDER_COMPONENT_DESCRIPTORS } from '../render/components.js';

const FINAL_METHODS = ['attach', 'setEnabled', 'patchProperties', 'dispose'];
const FORBIDDEN_TRANSFORM_FIELDS = new Set([
  'position', 'rotation', 'rotationXyzw', 'scale', 'transform', 'matrix', 'worldMatrix',
  'localTransform',
]);

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
    for (let prototype = ComponentClass.prototype; prototype && prototype !== Component.prototype;
      prototype = Object.getPrototypeOf(prototype)) {
      const override = objectHasOwnMethod(prototype, FINAL_METHODS);
      if (override) fail('display-component-final-method-override');
    }
    if (ComponentClass.prototype instanceof RenderComponent) {
      for (let prototype = ComponentClass.prototype; prototype && prototype !== RenderComponent.prototype;
        prototype = Object.getPrototypeOf(prototype)) {
        if (objectHasOwnMethod(prototype, ['onAttach', 'tick', 'onDispose'])) {
          fail('display-render-component-handler-forbidden');
        }
      }
    }
    const phase = ComponentClass.tickPhase;
    if (![null, 'update', 'before-render'].includes(phase)) fail('display-component-tick-phase-invalid');
    this._types.set(typeId, Object.freeze({ ComponentClass, normalizeProperties, resourceReferences }));
    return this;
  }

  seal() { this._sealed = true; return this; }

  has(typeId) { return this._types.has(typeId); }
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
    const properties = this.normalizeProperties(typeId, record.properties ?? {});
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
    component._setNormalizer((value) => this.normalizeProperties(compiled.type, value));
    return component;
  }

  validatePatch(component, patch) {
    if (!component || component.disposed) fail('display-component-invalid');
    return this.normalizeProperties(component.constructor.typeId,
      { ...component.properties, ...patch });
  }

  normalizeProperties(typeId, value) {
    const descriptor = this.require(typeId);
    const properties = descriptor.normalizeProperties(value);
    assertNoComponentTransform(properties);
    return cloneAndFreeze(properties);
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
    registry.register(BILLBOARD_COMPONENT_DESCRIPTOR);
    registry.register(LOOK_AT_COMPONENT_DESCRIPTOR);
  }
  return registry;
}

export { BillboardComponent, LookAtComponent, BehaviourComponent };
