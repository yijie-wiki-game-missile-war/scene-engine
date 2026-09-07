import { requireOrdinaryTextureSampling } from '../resource/texture-sampling.js';
import { normalizeProgramParameters, validateProgramTextures } from '../resource/program-resource.js';
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
import { normalizeProjectionProfile } from '../math/projection.js';
import { fail } from '../runtime/health.js';
import { RenderComponent } from './render-component.js';
import { BillboardComponent } from '../behaviours/billboard.js';

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

function normalizeMaterialParameters(material, value, resourceRegistry) {
  const program = descriptorFor(resourceRegistry, material.programResourceId);
  if (program?.kind !== 'program' || program.stage !== 'surface') fail(PROPERTY_ERROR);
  const base = normalizeProgramParameters(program, material.parameters ?? {});
  const dynamic = plainRecord(value ?? {}, PROPERTY_ERROR);
  for (const [key, entry] of Object.entries(dynamic)) {
    const spec = program.parameterSchema[key];
    if (!spec || (!spec.updateable && JSON.stringify(entry) !== JSON.stringify(base[key]))) fail(PROPERTY_ERROR);
  }
  return normalizeProgramParameters(program, { ...base, ...dynamic });
}

function normalizeMesh(value, resourceRegistry) {
  const record = exactKeys(value, ['meshResourceId', 'materialResourceId'], [
    'castShadow', 'receiveShadow', 'renderOrder', 'pickable', 'parameters',
  ], PROPERTY_ERROR);
  const material = descriptorFor(resourceRegistry, record.materialResourceId);
  let parameters;
  if (material?.family === 'material.program') {
    parameters = normalizeMaterialParameters(material, record.parameters, resourceRegistry);
  } else if (record.parameters !== undefined) fail(PROPERTY_ERROR);
  return {
    ...(parameters === undefined ? {} : { parameters }),
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
  const programBranch = Object.hasOwn(plainRecord(value, PROPERTY_ERROR), 'materialResourceId');
  const record = exactKeys(value, ['width', 'height', programBranch ? 'materialResourceId' : 'textureResourceId'], [
    ...(programBranch ? ['parameters'] : ['material', 'alpha', 'frame']),
    'renderOrder', 'pickable', 'projectionSemantics', 'anchorOffset', 'pivot',
  ], PROPERTY_ERROR);
  const projectionSemantics = enumValue(record.projectionSemantics ?? 'geometry', ['geometry', 'anchor-extent'], PROPERTY_ERROR);
  if (projectionSemantics !== 'anchor-extent'
      && (programBranch || Object.hasOwn(record, 'anchorOffset') || Object.hasOwn(record, 'pivot'))) fail(PROPERTY_ERROR);
  let resourceProperties;
  if (programBranch) {
    const materialResourceId = resourceId(record.materialResourceId);
    const material = descriptorFor(resourceRegistry, materialResourceId);
    if (material?.kind !== 'material' || material.family !== 'material.program') fail(PROPERTY_ERROR);
    resourceProperties = { materialResourceId,
      parameters: normalizeMaterialParameters(material, record.parameters, resourceRegistry) };
  } else {
    const textureResourceId = resourceId(record.textureResourceId);
    const descriptor = descriptorFor(resourceRegistry, textureResourceId);
    requireOrdinaryTextureSampling(descriptor);
    const frame = optional(record, 'frame', nonnegativeInteger, 0);
    validateAtlasFrame(descriptor, frame);
    resourceProperties = { textureResourceId, material: normalizeMaterialProperties(record.material ?? {}, false),
      alpha: optional(record, 'alpha', unit, 1), frame };
  }
  return {
    ...resourceProperties,
    ...(record.projectionSemantics === undefined ? {} : { projectionSemantics }),
    ...(projectionSemantics === 'anchor-extent' ? {
      anchorOffset: optional(record, 'anchorOffset', vector, [0,0,0]),
      pivot: optional(record, 'pivot', value => tuple(value, 2, PROPERTY_ERROR).map(unit), [0.5,0.5]),
    } : {}),
    width: positive(record.width),
    height: positive(record.height),
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
  const record = exactKeys(value, ['projection', 'near', 'far'], ['fovYDegrees', 'orthoHeight', 'projectionProfile'],
    PROPERTY_ERROR);
  const projection = enumValue(record.projection, ['perspective', 'orthographic'], PROPERTY_ERROR);
  const near = positive(record.near); const far = positive(record.far);
  if (far <= near) fail(PROPERTY_ERROR);
  const result = { projection, near, far };
  if (Object.hasOwn(record, 'projectionProfile'))
    result.projectionProfile = normalizeProjectionProfile(record.projectionProfile);
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

function normalizeBackground(value, resourceRegistry) {
  if (value?.programResourceId) {
    const record = exactKeys(value, ['programResourceId'], ['textures', 'parameters'], PROPERTY_ERROR);
    const programResourceId = resourceId(record.programResourceId);
    const program = descriptorFor(resourceRegistry, programResourceId);
    if (!program || program.kind !== 'program' || program.stage !== 'background') fail(PROPERTY_ERROR);
    return { programResourceId, textures: validateProgramTextures(program, record.textures ?? {}, resourceRegistry),
      parameters: normalizeProgramParameters(program, record.parameters ?? {}, { dynamic: true }) };
  }
  const record = exactKeys(value, [], ['colorRgba', 'textureResourceId', 'environmentResourceId'],
    PROPERTY_ERROR);
  if (!Object.hasOwn(record, 'colorRgba') && !Object.hasOwn(record, 'textureResourceId')) {
    fail(PROPERTY_ERROR);
  }
  for (const id of [record.textureResourceId, record.environmentResourceId]) {
    if (id) requireOrdinaryTextureSampling(descriptorFor(resourceRegistry, id));
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

// The nearest billboard owns the fixed-panel choice, including a disabled or
// camera-facing billboard that stops inheritance. Shared by candidate validation
// and the renderer-facing projection path.
export function fixedPanelSource(node) {
  for (let ancestor = node; ancestor !== null; ancestor = ancestor.parent) {
    const facing = ancestor.getComponent(BillboardComponent);
    if (facing !== null) return facing.enabled && !facing.disposed && facing.properties.facing === 'fixed'
      ? ancestor : null;
  }
  return null;
}

export function validateSpriteProjectionComponents(components, inheritedFixed = false) {
  const typeOf = component => component.type ?? component.constructor.typeId;
  const facing = components.find(component => typeOf(component) === 'behavior.billboard@2');
  const fixed = facing ? facing.enabled !== false && !facing.disposed && facing.properties.facing === 'fixed' : inheritedFixed;
  if (fixed && components.some(component => typeOf(component) === SpriteRendererComponent.typeId
    && component.properties.projectionSemantics === 'anchor-extent')) fail('display-sprite-projection-combination-invalid');
  return fixed;
}

export const RENDER_COMPONENT_DESCRIPTORS = Object.freeze([
  { ComponentClass: ModelRendererComponent, normalizeProperties: normalizeModel,
    resourceReferences: (properties) => [{ id: properties.modelResourceId, kinds: ['model'] }] },
  { ComponentClass: MeshRendererComponent, normalizeProperties: normalizeMesh,
    resourceReferences: (properties) => [
      { id: properties.meshResourceId, kinds: ['mesh'] },
      { id: properties.materialResourceId, kinds: ['material'] },
    ] },
  { ComponentClass: SpriteRendererComponent, normalizeProperties: normalizeSprite,
    resourceReferences: (properties) => properties.materialResourceId
      ? [{ id: properties.materialResourceId, kinds: ['material'] }]
      : [{ id: properties.textureResourceId, kinds: ['texture', 'texture-atlas'] }] },
  { ComponentClass: SurfaceRendererComponent, normalizeProperties: normalizeSurface,
    resourceReferences: (properties) => [{ id: properties.surfaceResourceId, kinds: ['surface'] }] },
  { ComponentClass: ParticleRendererComponent, normalizeProperties: normalizeParticle,
    resourceReferences: (properties) => [{ id: properties.particleResourceId, kinds: ['particle'] }] },
  { ComponentClass: CameraComponent, normalizeProperties: normalizeCamera, resourceReferences: () => [] },
  { ComponentClass: BackgroundComponent, normalizeProperties: normalizeBackground,
    resourceReferences: (properties) => properties.programResourceId
      ? [{ id: properties.programResourceId, kinds: ['program'] },
        ...Object.values(properties.textures).map((id) => ({ id, kinds: ['texture', 'generated-texture'] }))]
      : [properties.textureResourceId, properties.environmentResourceId]
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
