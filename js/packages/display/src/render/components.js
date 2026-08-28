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

function normalizeMaterial(value, allowInherit) {
  const record = exactKeys(value, [], MATERIAL_FIELDS, PROPERTY_ERROR);
  const alphaMode = record.alphaMode
    ?? (allowInherit ? 'inherit' : 'opaque');
  const modes = allowInherit
    ? ['opaque', 'mask', 'blend', 'inherit'] : ['opaque', 'mask', 'blend'];
  enumValue(alphaMode, modes, PROPERTY_ERROR);
  const alphaCutoff = optional(record, 'alphaCutoff', unit, 0);
  if (alphaMode !== 'mask' && alphaCutoff !== 0) fail(PROPERTY_ERROR);
  return {
    tintRgba: optional(record, 'tintRgba', color, 0xffffffff),
    opacity: optional(record, 'opacity', unit, 1),
    emissive: optional(record, 'emissive', nonnegative, 0),
    alphaMode,
    alphaCutoff,
  };
}

function normalizeModelOverrides(value) {
  const record = plainRecord(value, PROPERTY_ERROR);
  const keys = Object.keys(record);
  if (keys.some((key) => MATERIAL_FIELD_SET.has(key))) {
    return normalizeMaterial(record, true);
  }
  return Object.fromEntries(keys.map((name) => [
    nonemptyString(name, PROPERTY_ERROR),
    normalizeMaterial(record[name], true),
  ]));
}

function normalizeModelAnimation(value, descriptor) {
  if (value === null) return null;
  const record = exactKeys(value, ['clipId'], ['startTick', 'clock', 'loop'], PROPERTY_ERROR);
  const animation = {
    clipId: nonemptyString(record.clipId, PROPERTY_ERROR),
    startTick: optional(record, 'startTick', nonnegativeInteger, 0),
    clock: optional(record, 'clock', (entry) => enumValue(
      entry, ['simulation', 'visual'], PROPERTY_ERROR), 'simulation'),
    loop: optional(record, 'loop', (entry) => booleanValue(entry, PROPERTY_ERROR), true),
  };
  if (descriptor !== null) {
    if ((descriptor.lodUrls?.length ?? 0) > 0) fail('display-model-lod-animation-unsupported');
    if (!Array.isArray(descriptor.clipNames)) fail('display-model-animation-catalog-required');
    if (!descriptor.clipNames.includes(animation.clipId)) fail('display-model-animation-clip-invalid');
  }
  return animation;
}

function normalizeModel(value, resourceRegistry) {
  const record = exactKeys(value, ['modelResourceId'], [
    'materialOverrides', 'castShadow', 'receiveShadow', 'renderOrder', 'pickable', 'animation',
  ], PROPERTY_ERROR);
  const modelResourceId = resourceId(record.modelResourceId);
  const descriptor = descriptorFor(resourceRegistry, modelResourceId);
  return {
    modelResourceId,
    materialOverrides: optional(record, 'materialOverrides', normalizeModelOverrides, {}),
    castShadow: optional(record, 'castShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    receiveShadow: optional(record, 'receiveShadow', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    renderOrder: optional(record, 'renderOrder', (entry) => safeInteger(entry, PROPERTY_ERROR), 0),
    pickable: optional(record, 'pickable', (entry) => booleanValue(entry, PROPERTY_ERROR), false),
    animation: normalizeModelAnimation(record.animation ?? null, descriptor),
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

function normalizeFlipbook(value, descriptor) {
  if (value === null) return null;
  if (descriptor !== null && descriptor.kind !== 'texture-atlas') {
    fail('display-sprite-flipbook-atlas-required');
  }
  const record = exactKeys(value, ['frameCount', 'frameTicks'], [
    'startFrame', 'loop', 'clock', 'startTick',
  ], PROPERTY_ERROR);
  const result = {
    startFrame: optional(record, 'startFrame', nonnegativeInteger, 0),
    frameCount: positiveInteger(record.frameCount),
    frameTicks: positiveInteger(record.frameTicks),
    loop: optional(record, 'loop', (entry) => booleanValue(entry, PROPERTY_ERROR), true),
    clock: optional(record, 'clock', (entry) => enumValue(
      entry, ['simulation', 'visual'], PROPERTY_ERROR), 'simulation'),
    startTick: optional(record, 'startTick', nonnegativeInteger, 0),
  };
  if (descriptor !== null
      && result.startFrame + result.frameCount > descriptor.columns * descriptor.rows) {
    fail(PROPERTY_ERROR);
  }
  return result;
}

function normalizeSprite(value, resourceRegistry) {
  const record = exactKeys(value, ['textureResourceId', 'width', 'height'], [
    'material', 'alpha', 'frame', 'flipbook', 'renderOrder', 'pickable',
  ], PROPERTY_ERROR);
  const textureResourceId = resourceId(record.textureResourceId);
  const descriptor = descriptorFor(resourceRegistry, textureResourceId);
  const frame = optional(record, 'frame', nonnegativeInteger, 0);
  validateAtlasFrame(descriptor, frame);
  return {
    textureResourceId,
    width: positive(record.width),
    height: positive(record.height),
    material: normalizeMaterial(record.material ?? {}, false),
    alpha: optional(record, 'alpha', unit, 1),
    frame,
    flipbook: normalizeFlipbook(record.flipbook ?? null, descriptor),
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
    material: normalizeMaterial(record.material ?? {}, false),
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

function normalizeParticleAnimation(value) {
  if (value === null || value === undefined) return { startTick: 0, clock: 'visual' };
  const record = exactKeys(value, [], ['startTick', 'clock'], PROPERTY_ERROR);
  return {
    startTick: optional(record, 'startTick', nonnegativeInteger, 0),
    clock: optional(record, 'clock', (entry) => enumValue(
      entry, ['simulation', 'visual'], PROPERTY_ERROR), 'visual'),
  };
}

function normalizeParticle(value, resourceRegistry) {
  const record = exactKeys(value, ['particleResourceId'], [
    'intensity', 'parameters', 'animation', 'renderOrder',
  ], PROPERTY_ERROR);
  const particleResourceId = resourceId(record.particleResourceId);
  const descriptor = descriptorFor(resourceRegistry, particleResourceId);
  return {
    particleResourceId,
    intensity: optional(record, 'intensity', nonnegative, 1),
    parameters: normalizeParticleParameters(record.parameters ?? {}, descriptor),
    animation: normalizeParticleAnimation(record.animation),
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

export class ModelRendererComponent extends RenderComponent { static typeId = 'render.model@1'; }
export class MeshRendererComponent extends RenderComponent { static typeId = 'render.mesh@1'; }
export class SpriteRendererComponent extends RenderComponent { static typeId = 'render.sprite@1'; }
export class SurfaceRendererComponent extends RenderComponent { static typeId = 'render.surface@1'; }
export class ParticleRendererComponent extends RenderComponent { static typeId = 'render.particle@1'; }
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
