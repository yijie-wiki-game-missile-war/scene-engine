import {
  booleanValue,
  enumValue,
  exactKeys,
  finiteNumber,
  nonemptyString,
  plainRecord,
  safeInteger,
  tuple,
} from '../internal.js';
import { TICKS_PER_SECOND } from '../constants.js';
import { fail } from '../runtime/health.js';
import { RenderComponent } from './render-component.js';

const PROPERTY_ERROR = 'display-component-properties-invalid';
const MATERIAL_FIELDS = Object.freeze([
  'tintRgba', 'opacity', 'emissive', 'alphaMode', 'alphaCutoff',
  'depthTest', 'depthWrite',
]);
const MATERIAL_FIELD_SET = new Set(MATERIAL_FIELDS);

function optional(record, key, normalizer, fallback) {
  return Object.hasOwn(record, key) ? normalizer(record[key]) : fallback;
}
function resourceId(value) { return nonemptyString(value, 'display-resource-reference-invalid'); }
function nonnegative(value) {
  const number = finiteNumber(value, PROPERTY_ERROR);
  if (number < 0) fail(PROPERTY_ERROR);
  return number;
}
function positive(value) {
  const number = finiteNumber(value, PROPERTY_ERROR);
  if (number <= 0) fail(PROPERTY_ERROR);
  return number;
}
function unit(value) {
  const number = finiteNumber(value, PROPERTY_ERROR);
  if (number < 0 || number > 1) fail(PROPERTY_ERROR);
  return number;
}
function positiveInteger(value) {
  return safeInteger(value, PROPERTY_ERROR, { minimum: 1 });
}
function nonnegativeInteger(value) {
  return safeInteger(value, PROPERTY_ERROR, { minimum: 0 });
}
function vector(value) { return tuple(value, 3, PROPERTY_ERROR); }
function color(value) {
  return safeInteger(value, PROPERTY_ERROR, { minimum: 0, maximum: 0xffffffff });
}
function descriptorFor(resourceRegistry, id) {
  return resourceRegistry?.require?.(id)?.describe?.() ?? null;
}

export function normalizeMaterialProperties(value, allowInherit = false, code = PROPERTY_ERROR) {
  const record = exactKeys(value, [], MATERIAL_FIELDS, code);
  const alphaMode = record.alphaMode
    ?? (allowInherit ? 'inherit' : 'opaque');
  const modes = allowInherit
    ? ['opaque', 'mask', 'blend', 'inherit'] : ['opaque', 'mask', 'blend'];
  enumValue(alphaMode, modes, code);
  const normalizeUnit = (entry) => {
    const number = finiteNumber(entry, code);
    if (number < 0 || number > 1) fail(code);
    return number;
  };
  const alphaCutoff = optional(record, 'alphaCutoff', normalizeUnit, 0);
  if (alphaMode !== 'mask' && alphaCutoff !== 0) fail(code);
  const inheritsDepth = allowInherit && alphaMode === 'inherit';
  const depthTest = optional(record, 'depthTest', (entry) => booleanValue(entry, code),
    inheritsDepth ? 'inherit' : true);
  const depthWrite = optional(record, 'depthWrite', (entry) => booleanValue(entry, code),
    depthTest === false ? false : inheritsDepth ? 'inherit' : alphaMode !== 'blend');
  if (depthWrite === true && depthTest !== true) fail(code);
  return {
    tintRgba: optional(record, 'tintRgba', (entry) => safeInteger(
      entry, code, { minimum: 0, maximum: 0xffffffff },
    ), 0xffffffff),
    opacity: optional(record, 'opacity', normalizeUnit, 1),
    emissive: optional(record, 'emissive', (entry) => {
      const number = finiteNumber(entry, code);
      if (number < 0) fail(code);
      return number;
    }, 0),
    alphaMode,
    alphaCutoff,
    depthTest,
    depthWrite,
  };
}

function normalizeModelOverrides(value) {
  const record = plainRecord(value, PROPERTY_ERROR);
  const keys = Object.keys(record);
  if (keys.some((key) => MATERIAL_FIELD_SET.has(key))) {
    return normalizeMaterialProperties(record, true);
  }
  return Object.fromEntries(keys.map((name) => [
    nonemptyString(name, PROPERTY_ERROR),
    normalizeMaterialProperties(record[name], true),
  ]));
}

function normalizeModel(value, resourceRegistry) {
  const record = exactKeys(value, ['modelResourceId'], [
    'materialOverrides', 'castShadow', 'receiveShadow', 'renderOrder', 'pickable',
  ], PROPERTY_ERROR);
  const modelResourceId = resourceId(record.modelResourceId);
  descriptorFor(resourceRegistry, modelResourceId);
  return {
    modelResourceId,
    materialOverrides: optional(record, 'materialOverrides', normalizeModelOverrides, {}),
    castShadow: optional(record, 'castShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    receiveShadow: optional(record, 'receiveShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    renderOrder: optional(record, 'renderOrder', (entry) => safeInteger(entry, PROPERTY_ERROR), 0),
    pickable: optional(record, 'pickable', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
  };
}

function normalizeMesh(value) {
  const record = exactKeys(value, ['meshResourceId', 'materialResourceId'], [
    'castShadow', 'receiveShadow', 'renderOrder', 'pickable',
  ], PROPERTY_ERROR);
  return {
    meshResourceId: resourceId(record.meshResourceId),
    materialResourceId: resourceId(record.materialResourceId),
    castShadow: optional(record, 'castShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    receiveShadow: optional(record, 'receiveShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    renderOrder: optional(record, 'renderOrder', (entry) => safeInteger(entry, PROPERTY_ERROR), 0),
    pickable: optional(record, 'pickable', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
  };
}

function validateAtlasFrame(descriptor, frame) {
  if (descriptor === null) return;
  if (descriptor.kind === 'texture-atlas') {
    if (frame >= descriptor.columns * descriptor.rows) fail(PROPERTY_ERROR);
  } else if (frame !== 0) {
    fail(PROPERTY_ERROR);
  }
}

function normalizeSprite(value, resourceRegistry) {
  const record = exactKeys(value, ['textureResourceId', 'width', 'height'], [
    'material', 'alpha', 'frame', 'renderOrder', 'pickable',
  ], PROPERTY_ERROR);
  const textureResourceId = resourceId(record.textureResourceId);
  const descriptor = descriptorFor(resourceRegistry, textureResourceId);
  const frame = optional(record, 'frame', nonnegativeInteger, 0);
  validateAtlasFrame(descriptor, frame);
  return {
    textureResourceId,
    width: positive(record.width),
    height: positive(record.height),
    material: normalizeMaterialProperties(record.material ?? {}, false),
    alpha: optional(record, 'alpha', unit, 1),
    frame,
    renderOrder: optional(record, 'renderOrder', (entry) => safeInteger(entry, PROPERTY_ERROR), 0),
    pickable: optional(record, 'pickable', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
  };
}

function normalizeSurfaceParameters(value, descriptor) {
  const parameters = {
    ...(descriptor?.defaults === undefined ? {} : plainRecord(descriptor.defaults, PROPERTY_ERROR)),
    ...plainRecord(value, PROPERTY_ERROR),
  };
  if (descriptor?.family === 'surface.water') {
    const record = exactKeys(parameters, [], ['amplitude', 'speed', 'foam', 'textureScale'], PROPERTY_ERROR);
    return {
      amplitude: optional(record, 'amplitude', nonnegative, 0),
      speed: optional(record, 'speed', (entry) => finiteNumber(entry, PROPERTY_ERROR), 0),
      foam: optional(record, 'foam', unit, 0),
      textureScale: optional(record, 'textureScale', positive, 1),
    };
  }
  if (descriptor !== null && descriptor.family !== 'surface.standard') {
    fail('display-surface-family-invalid');
  }
  const record = exactKeys(parameters, [], ['textureScale'], PROPERTY_ERROR);
  return { textureScale: optional(record, 'textureScale', positive, 1) };
}

function normalizeSurface(value, resourceRegistry) {
  const record = exactKeys(value, ['surfaceResourceId'], [
    'material', 'parameters', 'renderOrder', 'pickable',
  ], PROPERTY_ERROR);
  const surfaceResourceId = resourceId(record.surfaceResourceId);
  const descriptor = descriptorFor(resourceRegistry, surfaceResourceId);
  return {
    surfaceResourceId,
    material: normalizeMaterialProperties(record.material ?? {}, false),
    parameters: normalizeSurfaceParameters(record.parameters ?? {}, descriptor),
    renderOrder: optional(record, 'renderOrder', (entry) => safeInteger(entry, PROPERTY_ERROR), 0),
    pickable: optional(record, 'pickable', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
  };
}

function normalizeParticleParameters(value, descriptor) {
  const params = {
    ...(descriptor?.defaults === undefined ? {} : plainRecord(descriptor.defaults, PROPERTY_ERROR)),
    ...plainRecord(value, PROPERTY_ERROR),
  };
  const record = exactKeys(params, [], [
    'durationTicks', 'capacity', 'seed', 'rate', 'size', 'velocity', 'spread', 'gravity',
    'blendMode', 'tintRgba', 'opacity',
  ], PROPERTY_ERROR);
  const maximumCapacity = descriptor?.maximumCapacity ?? null;
  const capacity = Object.hasOwn(record, 'capacity')
    ? positiveInteger(record.capacity)
    : maximumCapacity === null ? fail(PROPERTY_ERROR) : positiveInteger(maximumCapacity);
  if (maximumCapacity !== null && capacity > maximumCapacity) {
    fail('display-particle-capacity-invalid');
  }
  return {
    durationTicks: optional(record, 'durationTicks', positiveInteger, TICKS_PER_SECOND),
    capacity,
    seed: optional(record, 'seed', nonnegativeInteger, 0),
    rate: optional(record, 'rate', nonnegative, 0),
    size: optional(record, 'size', positive, 1),
    velocity: optional(record, 'velocity', vector, [0, 0, 0]),
    spread: optional(record, 'spread', vector, [0, 0, 0]),
    gravity: optional(record, 'gravity', vector, [0, 0, 0]),
    blendMode: optional(record, 'blendMode', (entry) => enumValue(
      entry, ['normal', 'additive'], PROPERTY_ERROR), 'normal'),
    tintRgba: optional(record, 'tintRgba', color, 0xffffffff),
    opacity: optional(record, 'opacity', unit, 1),
  };
}

function normalizeParticle(value, resourceRegistry) {
  const record = exactKeys(value, ['particleResourceId'], [
    'intensity', 'parameters', 'renderOrder',
  ], PROPERTY_ERROR);
  const particleResourceId = resourceId(record.particleResourceId);
  const descriptor = descriptorFor(resourceRegistry, particleResourceId);
  return {
    particleResourceId,
    intensity: optional(record, 'intensity', nonnegative, 1),
    parameters: normalizeParticleParameters(record.parameters ?? {}, descriptor),
    renderOrder: optional(record, 'renderOrder', (entry) => safeInteger(entry, PROPERTY_ERROR), 0),
  };
}

function normalizeCamera(value) {
  const record = exactKeys(value, ['projection', 'near', 'far'], ['fovYDegrees', 'orthoHeight'],
    PROPERTY_ERROR);
  const projection = enumValue(record.projection, ['perspective', 'orthographic'], PROPERTY_ERROR);
  const near = positive(record.near); const far = positive(record.far);
  if (far <= near) fail(PROPERTY_ERROR);
  const result = { projection, near, far };
  if (projection === 'perspective') {
    const fov = Object.hasOwn(record, 'fovYDegrees') ? positive(record.fovYDegrees) : 50;
    if (fov >= 180 || Object.hasOwn(record, 'orthoHeight')) fail(PROPERTY_ERROR);
    result.fovYDegrees = fov;
  } else {
    if (Object.hasOwn(record, 'fovYDegrees')) fail(PROPERTY_ERROR);
    result.orthoHeight = Object.hasOwn(record, 'orthoHeight') ? positive(record.orthoHeight) : 10;
  }
  return result;
}

function normalizeBackground(value) {
  const record = exactKeys(value, [], ['colorRgba', 'textureResourceId', 'environmentResourceId'],
    PROPERTY_ERROR);
  if (!Object.hasOwn(record, 'colorRgba') && !Object.hasOwn(record, 'textureResourceId')) {
    fail(PROPERTY_ERROR);
  }
  return {
    colorRgba: optional(record, 'colorRgba', color, null),
    textureResourceId: optional(record, 'textureResourceId', resourceId, null),
    environmentResourceId: optional(record, 'environmentResourceId', resourceId, null),
  };
}

function normalizeLight(value, directional = false, spot = false) {
  const optionalKeys = ['colorRgba', 'intensity', 'castShadow', 'range', 'angleDegrees', 'penumbra'];
  const record = exactKeys(value, [], optionalKeys, PROPERTY_ERROR);
  if (!spot && (Object.hasOwn(record, 'angleDegrees') || Object.hasOwn(record, 'penumbra'))) {
    fail(PROPERTY_ERROR);
  }
  const result = {
    colorRgba: optional(record, 'colorRgba', color, 0xffffffff),
    intensity: optional(record, 'intensity', nonnegative, 1),
    castShadow: optional(record, 'castShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
  };
  if (!directional) result.range = optional(record, 'range', nonnegative, 0);
  if (spot) {
    result.angleDegrees = optional(record, 'angleDegrees', positive, 45);
    result.penumbra = optional(record, 'penumbra', unit, 0);
  }
  return result;
}

export class ModelRendererComponent extends RenderComponent { static typeId = 'render.model@2'; }
export class MeshRendererComponent extends RenderComponent { static typeId = 'render.mesh@1'; }
export class SpriteRendererComponent extends RenderComponent { static typeId = 'render.sprite@3'; }
export class SurfaceRendererComponent extends RenderComponent { static typeId = 'render.surface@1'; }
export class ParticleRendererComponent extends RenderComponent { static typeId = 'render.particle@2'; }
export class CameraComponent extends RenderComponent { static typeId = 'render.camera@1'; static allowMultiple = false; }
export class BackgroundComponent extends RenderComponent { static typeId = 'render.background@1'; static allowMultiple = false; }
export class AmbientLightComponent extends RenderComponent { static typeId = 'render.ambient-light@1'; }
export class DirectionalLightComponent extends RenderComponent { static typeId = 'render.directional-light@1'; }
export class PointLightComponent extends RenderComponent { static typeId = 'render.point-light@1'; }
export class SpotLightComponent extends RenderComponent { static typeId = 'render.spot-light@1'; }

export const RENDER_COMPONENT_DESCRIPTORS = Object.freeze([
  { ComponentClass: ModelRendererComponent, normalizeProperties: normalizeModel,
    resourceReferences: (properties) => [{ id: properties.modelResourceId, kinds: ['model'] }] },
  { ComponentClass: MeshRendererComponent, normalizeProperties: normalizeMesh,
    resourceReferences: (properties) => [
      { id: properties.meshResourceId, kinds: ['mesh'] },
      { id: properties.materialResourceId, kinds: ['material'] },
    ] },
  { ComponentClass: SpriteRendererComponent, normalizeProperties: normalizeSprite,
    resourceReferences: (properties) => [{
      id: properties.textureResourceId, kinds: ['texture', 'texture-atlas'],
    }] },
  { ComponentClass: SurfaceRendererComponent, normalizeProperties: normalizeSurface,
    resourceReferences: (properties) => [{ id: properties.surfaceResourceId, kinds: ['surface'] }] },
  { ComponentClass: ParticleRendererComponent, normalizeProperties: normalizeParticle,
    resourceReferences: (properties) => [{ id: properties.particleResourceId, kinds: ['particle'] }] },
  { ComponentClass: CameraComponent, normalizeProperties: normalizeCamera, resourceReferences: () => [] },
  { ComponentClass: BackgroundComponent, normalizeProperties: normalizeBackground,
    resourceReferences: (properties) => [properties.textureResourceId, properties.environmentResourceId]
      .filter(Boolean).map((id) => ({ id, kinds: ['texture', 'texture-atlas'] })) },
  { ComponentClass: AmbientLightComponent, normalizeProperties: (properties) => normalizeLight(properties, true),
    resourceReferences: () => [] },
  { ComponentClass: DirectionalLightComponent, normalizeProperties: (properties) => normalizeLight(properties, true),
    resourceReferences: () => [] },
  { ComponentClass: PointLightComponent, normalizeProperties: (properties) => normalizeLight(properties),
    resourceReferences: () => [] },
  { ComponentClass: SpotLightComponent, normalizeProperties: (properties) => normalizeLight(properties, false, true),
    resourceReferences: () => [] },
]);
