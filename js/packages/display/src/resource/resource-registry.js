import { cloneAndFreeze, exactKeys, nonemptyString, plainRecord, safeInteger } from '../internal.js';
import { fail } from '../runtime/health.js';
import { Resource } from './resource.js';

export const RESOURCE_REGISTRY_SCHEMA = 'scene-engine-resource-registry@1';

const SHAPES = Object.freeze({
  model: { required: ['url'], optional: ['lodUrls', 'clipNames'] },
  mesh: { required: [], optional: ['url', 'positions', 'normals', 'uvs', 'indices'] },
  texture: { required: ['url'], optional: ['colorSpace', 'wrap'] },
  'texture-atlas': { required: ['columns', 'rows'], optional: ['url', 'textureResourceId', 'colorSpace', 'wrap'] },
  material: { required: ['family'], optional: ['properties', 'textureResourceIds'] },
  animation: { required: ['clips'], optional: [] },
  surface: { required: ['family', 'geometry'], optional: ['textureResourceIds', 'defaults'] },
  particle: { required: ['maximumCapacity'], optional: ['textureResourceId', 'defaults'] },
});

function validateUrl(value) {
  const url = nonemptyString(value, 'display-resource-url-invalid');
  try { new URL(url, 'https://scene-engine.invalid/'); } catch { fail('display-resource-url-invalid'); }
  return url;
}

function normalizeDescriptor(value) {
  const header = exactKeys(value, ['id', 'kind'], ['schema', 'revision', 'hash',
    ...Object.values(SHAPES).flatMap(({ required, optional }) => [...required, ...optional])],
  'display-resource-definition-invalid');
  const kind = nonemptyString(header.kind, 'display-resource-kind-invalid');
  const shape = SHAPES[kind];
  if (!shape) fail('display-resource-kind-invalid');
  const permitted = ['id', 'kind', 'schema', 'revision', 'hash', ...shape.required, ...shape.optional];
  for (const key of Object.keys(header)) if (!permitted.includes(key)) fail('display-resource-definition-invalid');
  for (const key of shape.required) if (!Object.hasOwn(header, key)) fail('display-resource-definition-invalid');
  const descriptor = cloneAndFreeze(header, 'display-resource-definition-invalid');
  if (Object.hasOwn(descriptor, 'url')) validateUrl(descriptor.url);
  if (Object.hasOwn(descriptor, 'revision')) {
    safeInteger(descriptor.revision, 'display-resource-revision-invalid', { minimum: 0 });
  }
  if (Object.hasOwn(descriptor, 'hash')
      && (typeof descriptor.hash !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.hash))) {
    fail('display-resource-hash-invalid');
  }
  if (Object.hasOwn(descriptor, 'lodUrls')) {
    if (!Array.isArray(descriptor.lodUrls)) fail('display-resource-definition-invalid');
    for (const url of descriptor.lodUrls) validateUrl(url);
  }
  if (Object.hasOwn(descriptor, 'clipNames')) {
    if (!Array.isArray(descriptor.clipNames)) fail('display-resource-definition-invalid');
    const names = new Set();
    for (const name of descriptor.clipNames) {
      nonemptyString(name, 'display-resource-definition-invalid');
      if (names.has(name)) fail('display-resource-definition-invalid');
      names.add(name);
    }
  }
  if (kind === 'mesh' && !Object.hasOwn(descriptor, 'url') && !Object.hasOwn(descriptor, 'positions')) {
    fail('display-resource-definition-invalid');
  }
  if (kind === 'texture-atlas') {
    safeInteger(descriptor.columns, 'display-resource-definition-invalid', { minimum: 1 });
    safeInteger(descriptor.rows, 'display-resource-definition-invalid', { minimum: 1 });
    const sourceCount = Number(Object.hasOwn(descriptor, 'url'))
      + Number(Object.hasOwn(descriptor, 'textureResourceId'));
    if (sourceCount !== 1) fail('display-resource-definition-invalid');
  }
  if (kind === 'particle') {
    safeInteger(descriptor.maximumCapacity, 'display-resource-definition-invalid', { minimum: 1 });
  }
  return descriptor;
}

export class ResourceRegistry {
  constructor() { this._resources = new Map(); this._sealed = false; }
  get size() { return this._resources.size; }
  register(value) {
    if (this._sealed) fail('display-registry-sealed');
    const descriptor = normalizeDescriptor(value);
    const id = descriptor.id;
    if (this._resources.has(id)) fail('display-resource-id-duplicate');
    const resource = new Resource({
      id,
      schema: descriptor.schema ?? `scene-engine-${descriptor.kind}-resource@1`,
      revision: descriptor.revision ?? 0,
      descriptor,
    });
    Object.freeze(resource);
    this._resources.set(id, resource);
    return resource;
  }
  seal() { this._sealed = true; return this; }
  get(id) { return this._resources.get(id) ?? null; }
  has(id) { return this._resources.has(id); }
  require(id) {
    const resource = this.get(id);
    if (!resource) fail('display-resource-missing');
    return resource;
  }
  values() { return this._resources.values(); }
  validateReferences() {
    const requireKind = (id, allowed) => {
      const resource = this.require(id);
      if (!allowed.includes(resource.describe().kind)) fail('display-resource-reference-kind-invalid');
    };
    for (const resource of this._resources.values()) {
      const descriptor = resource.describe();
      if (descriptor.kind === 'texture-atlas' && descriptor.textureResourceId) {
        requireKind(descriptor.textureResourceId, ['texture']);
      }
      if (descriptor.kind === 'particle' && descriptor.textureResourceId) {
        requireKind(descriptor.textureResourceId, ['texture']);
      }
      if (descriptor.kind === 'material') {
        for (const id of descriptor.textureResourceIds ?? []) requireKind(id, ['texture', 'texture-atlas']);
      }
      if (descriptor.kind === 'surface') {
        for (const id of descriptor.textureResourceIds ?? []) requireKind(id, ['texture', 'texture-atlas']);
      }
    }
    return this;
  }
  snapshot() {
    return cloneAndFreeze({
      schema: RESOURCE_REGISTRY_SCHEMA,
      resources: Object.fromEntries([...this._resources].map(([id, resource]) => [id, resource.describe()])),
    });
  }
}

export function defineResources(value) {
  const record = exactKeys(value, ['schema', 'resources'], [], 'display-resource-registry-invalid');
  if (record.schema !== RESOURCE_REGISTRY_SCHEMA || !Array.isArray(record.resources)) {
    fail('display-resource-registry-invalid');
  }
  return cloneAndFreeze({ schema: RESOURCE_REGISTRY_SCHEMA,
    resources: record.resources.map(normalizeDescriptor) });
}

export function createResourceRegistry(initial = []) {
  const registry = new ResourceRegistry();
  const entries = Array.isArray(initial) ? initial : plainRecord(initial, 'display-resource-registry-invalid').resources;
  if (!Array.isArray(entries)) fail('display-resource-registry-invalid');
  for (const entry of entries) registry.register(entry);
  return registry.validateReferences();
}
