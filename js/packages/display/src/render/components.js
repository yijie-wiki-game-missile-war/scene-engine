import { booleanValue, cloneAndFreeze, enumValue, exactKeys, finiteNumber,
  nonemptyString, safeInteger } from '../internal.js';
import { fail } from '../runtime/health.js';
import { RenderComponent } from './render-component.js';

function optional(record, key, normalizer, fallback) {
  return Object.hasOwn(record, key) ? normalizer(record[key]) : fallback;
}
function resourceId(value) { return nonemptyString(value, 'display-resource-reference-invalid'); }
function nonnegative(value) {
  const number = finiteNumber(value, 'display-component-properties-invalid');
  if (number < 0) fail('display-component-properties-invalid');
  return number;
}
function positive(value) {
  const number = finiteNumber(value, 'display-component-properties-invalid');
  if (number <= 0) fail('display-component-properties-invalid');
  return number;
}
function color(value) {
  return safeInteger(value, 'display-component-properties-invalid', { minimum: 0, maximum: 0xffffffff });
}
function plainProperties(value) {
  return cloneAndFreeze(value, 'display-component-properties-invalid');
}

function normalizeModel(value) {
  const record = exactKeys(value, ['modelResourceId'], [
    'materialOverrides', 'castShadow', 'receiveShadow', 'renderOrder', 'pickable', 'animation',
  ], 'display-component-properties-invalid');
  return {
    modelResourceId: resourceId(record.modelResourceId),
    materialOverrides: optional(record, 'materialOverrides', plainProperties, {}),
    castShadow: optional(record, 'castShadow', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
    receiveShadow: optional(record, 'receiveShadow', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
    renderOrder: optional(record, 'renderOrder', (v) => safeInteger(v, 'display-component-properties-invalid'), 0),
    pickable: optional(record, 'pickable', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
    animation: optional(record, 'animation', plainProperties, null),
  };
}

function normalizeMesh(value) {
  const record = exactKeys(value, ['meshResourceId', 'materialResourceId'], [
    'castShadow', 'receiveShadow', 'renderOrder', 'pickable',
  ], 'display-component-properties-invalid');
  return {
    meshResourceId: resourceId(record.meshResourceId),
    materialResourceId: resourceId(record.materialResourceId),
    castShadow: optional(record, 'castShadow', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
    receiveShadow: optional(record, 'receiveShadow', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
    renderOrder: optional(record, 'renderOrder', (v) => safeInteger(v, 'display-component-properties-invalid'), 0),
    pickable: optional(record, 'pickable', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
  };
}

function normalizeSprite(value) {
  const record = exactKeys(value, ['textureResourceId', 'width', 'height'], [
    'material', 'alpha', 'frame', 'flipbook', 'renderOrder', 'pickable',
  ], 'display-component-properties-invalid');
  const alpha = optional(record, 'alpha', (v) => finiteNumber(v, 'display-component-properties-invalid'), 1);
  if (alpha < 0 || alpha > 1) fail('display-component-properties-invalid');
  return {
    textureResourceId: resourceId(record.textureResourceId),
    width: positive(record.width),
    height: positive(record.height),
    material: optional(record, 'material', plainProperties, {}),
    alpha,
    frame: optional(record, 'frame', (v) => safeInteger(v, 'display-component-properties-invalid', { minimum: 0 }), 0),
    flipbook: optional(record, 'flipbook', plainProperties, null),
    renderOrder: optional(record, 'renderOrder', (v) => safeInteger(v, 'display-component-properties-invalid'), 0),
    pickable: optional(record, 'pickable', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
  };
}

function normalizeSurface(value) {
  const record = exactKeys(value, ['surfaceResourceId'], ['material', 'parameters', 'renderOrder', 'pickable'],
    'display-component-properties-invalid');
  return {
    surfaceResourceId: resourceId(record.surfaceResourceId),
    material: optional(record, 'material', plainProperties, {}),
    parameters: optional(record, 'parameters', plainProperties, {}),
    renderOrder: optional(record, 'renderOrder', (v) => safeInteger(v, 'display-component-properties-invalid'), 0),
    pickable: optional(record, 'pickable', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
  };
}

function normalizeParticle(value) {
  const record = exactKeys(value, ['particleResourceId'], ['intensity', 'parameters', 'animation', 'renderOrder'],
    'display-component-properties-invalid');
  return {
    particleResourceId: resourceId(record.particleResourceId),
    intensity: optional(record, 'intensity', nonnegative, 1),
    parameters: optional(record, 'parameters', plainProperties, {}),
    animation: optional(record, 'animation', plainProperties, null),
    renderOrder: optional(record, 'renderOrder', (v) => safeInteger(v, 'display-component-properties-invalid'), 0),
  };
}

function normalizeCamera(value) {
  const record = exactKeys(value, ['projection', 'near', 'far'], ['fovYDegrees', 'orthoHeight'],
    'display-component-properties-invalid');
  const projection = enumValue(record.projection, ['perspective', 'orthographic'], 'display-component-properties-invalid');
  const near = positive(record.near); const far = positive(record.far);
  if (far <= near) fail('display-component-properties-invalid');
  const result = { projection, near, far };
  if (projection === 'perspective') {
    const fov = Object.hasOwn(record, 'fovYDegrees') ? positive(record.fovYDegrees) : 50;
    if (fov >= 180 || Object.hasOwn(record, 'orthoHeight')) fail('display-component-properties-invalid');
    result.fovYDegrees = fov;
  } else {
    if (Object.hasOwn(record, 'fovYDegrees')) fail('display-component-properties-invalid');
    result.orthoHeight = Object.hasOwn(record, 'orthoHeight') ? positive(record.orthoHeight) : 10;
  }
  return result;
}

function normalizeBackground(value) {
  const record = exactKeys(value, [], ['colorRgba', 'textureResourceId', 'environmentResourceId'],
    'display-component-properties-invalid');
  if (!Object.hasOwn(record, 'colorRgba') && !Object.hasOwn(record, 'textureResourceId')) {
    fail('display-component-properties-invalid');
  }
  return {
    colorRgba: optional(record, 'colorRgba', color, null),
    textureResourceId: optional(record, 'textureResourceId', resourceId, null),
    environmentResourceId: optional(record, 'environmentResourceId', resourceId, null),
  };
}

function normalizeLight(value, directional = false, spot = false) {
  const optionalKeys = ['colorRgba', 'intensity', 'castShadow', 'range', 'angleDegrees', 'penumbra'];
  const record = exactKeys(value, [], optionalKeys, 'display-component-properties-invalid');
  const result = {
    colorRgba: optional(record, 'colorRgba', color, 0xffffffff),
    intensity: optional(record, 'intensity', nonnegative, 1),
    castShadow: optional(record, 'castShadow', (v) => booleanValue(v, 'display-component-properties-invalid'), false),
  };
  if (!directional) result.range = optional(record, 'range', nonnegative, 0);
  if (spot) {
    result.angleDegrees = optional(record, 'angleDegrees', positive, 45);
    result.penumbra = optional(record, 'penumbra', (v) => {
      const n = finiteNumber(v, 'display-component-properties-invalid');
      if (n < 0 || n > 1) fail('display-component-properties-invalid');
      return n;
    }, 0);
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
    resourceReferences: (p) => [{ id: p.modelResourceId, kinds: ['model'] }] },
  { ComponentClass: MeshRendererComponent, normalizeProperties: normalizeMesh,
    resourceReferences: (p) => [
      { id: p.meshResourceId, kinds: ['mesh'] },
      { id: p.materialResourceId, kinds: ['material'] },
    ] },
  { ComponentClass: SpriteRendererComponent, normalizeProperties: normalizeSprite,
    resourceReferences: (p) => [{ id: p.textureResourceId, kinds: ['texture', 'texture-atlas'] }] },
  { ComponentClass: SurfaceRendererComponent, normalizeProperties: normalizeSurface,
    resourceReferences: (p) => [{ id: p.surfaceResourceId, kinds: ['surface'] }] },
  { ComponentClass: ParticleRendererComponent, normalizeProperties: normalizeParticle,
    resourceReferences: (p) => [{ id: p.particleResourceId, kinds: ['particle'] }] },
  { ComponentClass: CameraComponent, normalizeProperties: normalizeCamera, resourceReferences: () => [] },
  { ComponentClass: BackgroundComponent, normalizeProperties: normalizeBackground,
    resourceReferences: (p) => [p.textureResourceId, p.environmentResourceId].filter(Boolean)
      .map((id) => ({ id, kinds: ['texture', 'texture-atlas'] })) },
  { ComponentClass: AmbientLightComponent, normalizeProperties: (p) => normalizeLight(p, true), resourceReferences: () => [] },
  { ComponentClass: DirectionalLightComponent, normalizeProperties: (p) => normalizeLight(p, true), resourceReferences: () => [] },
  { ComponentClass: PointLightComponent, normalizeProperties: (p) => normalizeLight(p), resourceReferences: () => [] },
  { ComponentClass: SpotLightComponent, normalizeProperties: (p) => normalizeLight(p, false, true), resourceReferences: () => [] },
]);
