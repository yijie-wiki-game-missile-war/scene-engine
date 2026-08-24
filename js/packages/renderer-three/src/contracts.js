import {
  LAYER_SCOPE_NODE_COMPOSITION,
  LAYER_SCOPE_SCENE_LAYERS,
  PIPELINE_IDS,
  RENDER_BATCH_SCHEMA,
  RENDER_COMPOSITION_SCHEMA,
  RENDER_RESOURCE_CATALOG_SCHEMA,
  RENDER_SNAPSHOT_SCHEMA,
} from './constants.js';
import { fail } from './errors.js';

const PIPELINE_RESOURCE_KINDS = Object.freeze({
  'model@2': Object.freeze(new Set(['model-url', 'primitive-model'])),
  'sprite@2': Object.freeze(new Set(['texture', 'texture-atlas'])),
  'surface@2': Object.freeze(new Set(['surface'])),
  'particle@2': Object.freeze(new Set(['particle'])),
  'scene-pass@2': Object.freeze(new Set(['scene-pass'])),
});

const PARAM_FIELDS = Object.freeze({
  'model@2': Object.freeze(new Set([
    'castShadow', 'receiveShadow', 'lodDistances', 'instance', 'clipLoop',
  ])),
  'sprite@2': Object.freeze(new Set([
    'orientation', 'width', 'height', 'atlasCell', 'flipbook',
  ])),
  'surface@2': Object.freeze(new Set([
    'amplitude', 'speed', 'foam', 'textureScale',
  ])),
  'particle@2': Object.freeze(new Set([
    'durationTicks', 'capacity', 'seed', 'rate', 'size', 'velocity', 'spread',
    'gravity', 'blendMode',
  ])),
  'scene-pass@2': Object.freeze(new Set([
    'passKind', 'colorRgba', 'intensity', 'direction',
  ])),
});

const RESOURCE_FIELDS = Object.freeze({
  'model-url': Object.freeze(new Set(['kind', 'url', 'lodUrls', 'clipNames'])),
  'primitive-model': Object.freeze(new Set(['kind', 'parts'])),
  texture: Object.freeze(new Set(['kind', 'url', 'colorSpace', 'wrap'])),
  'texture-atlas': Object.freeze(new Set([
    'kind', 'url', 'columns', 'rows', 'colorSpace', 'wrap',
  ])),
  surface: Object.freeze(new Set([
    'kind', 'family', 'geometry', 'textureResourceIds', 'defaults',
  ])),
  particle: Object.freeze(new Set([
    'kind', 'textureResourceId', 'maximumCapacity',
  ])),
  'scene-pass': Object.freeze(new Set(['kind', 'passKind', 'defaults'])),
});

const PRIMITIVE_SHAPES = Object.freeze(new Set([
  'box', 'sphere', 'cylinder', 'cone', 'plane', 'hex-prism',
]));
const SURFACE_FAMILIES = Object.freeze(new Set([
  'surface.standard',
  'surface.water',
]));
const SCENE_PASS_KINDS = Object.freeze(new Set([
  'background', 'lights',
]));
const FORBIDDEN_EXECUTABLE_DATA_KEYS = Object.freeze(new Set([
  'callback',
  'fragmentShader',
  'glsl',
  'loader',
  'onBeforeCompile',
  'vertexShader',
]));

export function normalizeCameraProfile(value) {
  const record = plainRecord(value, 'render-camera-profile-invalid');
  exactKeys(record, [
    'projection', 'position', 'target', 'up', 'fovYDegrees', 'near', 'far',
    'minDistance', 'maxDistance', 'controls',
  ], 'render-camera-profile-invalid');
  if (record.projection !== 'perspective') fail('render-camera-projection-invalid');
  const near = positiveFinite(record.near, 'render-camera-near-invalid');
  const far = positiveFinite(record.far, 'render-camera-far-invalid');
  const minDistance = nonnegativeFinite(
    record.minDistance,
    'render-camera-min-distance-invalid',
  );
  const maxDistance = positiveFinite(
    record.maxDistance,
    'render-camera-max-distance-invalid',
  );
  if (far <= near || maxDistance < minDistance) fail('render-camera-range-invalid');
  const fovYDegrees = finiteNumber(record.fovYDegrees, 'render-camera-fov-invalid');
  if (fovYDegrees <= 0 || fovYDegrees >= 180) fail('render-camera-fov-invalid');
  return deepFreeze({
    projection: 'perspective',
    position: tuple(record.position, 3, 'render-camera-position-invalid'),
    target: tuple(record.target, 3, 'render-camera-target-invalid'),
    up: tuple(record.up, 3, 'render-camera-up-invalid'),
    fovYDegrees,
    near,
    far,
    minDistance,
    maxDistance,
    controls: normalizeCameraControls(record.controls),
  });
}

function normalizeCameraControls(value) {
  const record = plainRecord(value, 'render-camera-controls-invalid');
  exactKeys(record, [
    'mode', 'dampingFactor', 'panSpeed', 'zoomSpeed', 'panBounds',
  ], 'render-camera-controls-invalid');
  if (record.mode !== 'pan-zoom') fail('render-camera-controls-mode-invalid');
  const dampingFactor = unitFinite(
    record.dampingFactor,
    'render-camera-damping-invalid',
  );
  if (dampingFactor === 1) fail('render-camera-damping-invalid');
  return {
    mode: 'pan-zoom',
    dampingFactor,
    panSpeed: positiveFinite(record.panSpeed, 'render-camera-pan-speed-invalid'),
    zoomSpeed: positiveFinite(record.zoomSpeed, 'render-camera-zoom-speed-invalid'),
    panBounds: record.panBounds === null
      ? null
      : normalizePanBounds(record.panBounds),
  };
}

function normalizePanBounds(value) {
  const record = plainRecord(value, 'render-camera-pan-bounds-invalid');
  exactKeys(record, ['minX', 'maxX', 'minZ', 'maxZ'], 'render-camera-pan-bounds-invalid');
  const result = {
    minX: finiteNumber(record.minX, 'render-camera-pan-bounds-invalid'),
    maxX: finiteNumber(record.maxX, 'render-camera-pan-bounds-invalid'),
    minZ: finiteNumber(record.minZ, 'render-camera-pan-bounds-invalid'),
    maxZ: finiteNumber(record.maxZ, 'render-camera-pan-bounds-invalid'),
  };
  if (result.minX > result.maxX || result.minZ > result.maxZ) {
    fail('render-camera-pan-bounds-invalid');
  }
  return result;
}

export function normalizeRendererProfile(value) {
  const record = plainRecord(value, 'render-renderer-profile-invalid');
  exactKeys(record, [
    'drawMode', 'maximumPixelRatio', 'clearRgba', 'antialias', 'alpha', 'shadows',
    'toneMapping',
  ], 'render-renderer-profile-invalid');
  return deepFreeze({
    drawMode: enumValue(
      record.drawMode,
      ['requested', 'continuous'],
      'render-draw-mode-invalid',
    ),
    maximumPixelRatio: positiveFinite(
      record.maximumPixelRatio,
      'render-maximum-pixel-ratio-invalid',
    ),
    clearRgba: uint32(record.clearRgba, 'render-clear-rgba-invalid'),
    antialias: booleanValue(record.antialias, 'render-antialias-invalid'),
    alpha: booleanValue(record.alpha, 'render-alpha-invalid'),
    shadows: booleanValue(record.shadows, 'render-shadows-invalid'),
    toneMapping: enumValue(
      record.toneMapping,
      ['none', 'aces-filmic'],
      'render-tone-mapping-invalid',
    ),
  });
}

export function normalizeResourceCatalog(value) {
  const catalog = plainRecord(value, 'render-resource-catalog-invalid');
  exactKeys(catalog, ['schema', 'resources'], 'render-resource-catalog-invalid');
  if (catalog.schema !== RENDER_RESOURCE_CATALOG_SCHEMA) {
    fail('render-resource-catalog-schema-invalid');
  }
  const records = plainRecord(catalog.resources, 'render-resource-map-invalid');
  if (Reflect.ownKeys(records).length !== Object.keys(records).length) {
    fail('render-resource-map-invalid');
  }
  const resources = Object.create(null);
  for (const [resourceId, raw] of Object.entries(records)) {
    opaqueId(resourceId, 'render-resource-id-invalid');
    resources[resourceId] = normalizeResource(resourceId, raw);
  }
  validateCatalogReferences(resources);
  return deepFreeze({ schema: RENDER_RESOURCE_CATALOG_SCHEMA, resources });
}

function normalizeResource(resourceId, value) {
  const record = plainRecord(value, 'render-resource-invalid');
  const fields = RESOURCE_FIELDS[record.kind];
  if (!fields) fail('render-resource-kind-invalid', `Unknown resource kind for ${resourceId}.`);
  allowedKeys(record, fields, 'render-resource-field-unknown');
  switch (record.kind) {
    case 'model-url':
      return {
        kind: record.kind,
        url: browserUrl(record.url, 'render-resource-url-invalid'),
        ...(record.lodUrls === undefined ? {} : {
          lodUrls: urlArray(record.lodUrls, 'render-model-lod-urls-invalid'),
        }),
        ...(record.clipNames === undefined ? {} : {
          clipNames: stringArray(record.clipNames, 'render-model-clip-names-invalid'),
        }),
      };
    case 'primitive-model': {
      if (!Array.isArray(record.parts) || record.parts.length === 0) {
        fail('render-primitive-parts-invalid');
      }
      return {
        kind: record.kind,
        parts: record.parts.map((part) => normalizePrimitivePart(part)),
      };
    }
    case 'texture':
      return normalizeTextureResource(record, false);
    case 'texture-atlas': {
      const resource = {
        ...normalizeTextureResource(record, true),
        columns: positiveInteger(record.columns, 'render-atlas-columns-invalid'),
        rows: positiveInteger(record.rows, 'render-atlas-rows-invalid'),
      };
      atlasCellCount(resource);
      return resource;
    }
    case 'surface':
      exactKeys(record, [
        'kind', 'family', 'geometry', 'textureResourceIds', 'defaults',
      ], 'render-resource-field-invalid');
      {
        const family = enumValue(
          record.family,
          [...SURFACE_FAMILIES],
          'render-surface-family-invalid',
        );
        const textureResourceIds = stringArray(
          record.textureResourceIds,
          'render-surface-textures-invalid',
        );
        if (textureResourceIds.length > 1) fail('render-surface-textures-invalid');
        assertUnique(textureResourceIds, 'render-surface-textures-invalid');
        const resource = {
          kind: record.kind,
          family,
          geometry: normalizeSurfaceGeometry(record.geometry),
          textureResourceIds,
        };
        return {
          ...resource,
          defaults: normalizeParams('surface@2', record.defaults, resource, true),
        };
      }
    case 'particle':
      exactKeys(record, [
        'kind', 'textureResourceId', 'maximumCapacity',
      ], 'render-resource-field-invalid');
      return {
        kind: record.kind,
        textureResourceId: record.textureResourceId === null
          ? null
          : opaqueId(record.textureResourceId, 'render-particle-texture-invalid'),
        maximumCapacity: positiveInteger(
          record.maximumCapacity,
          'render-particle-capacity-invalid',
        ),
      };
    case 'scene-pass': {
      exactKeys(record, ['kind', 'passKind', 'defaults'], 'render-resource-field-invalid');
      const passKind = enumValue(
        record.passKind,
        [...SCENE_PASS_KINDS],
        'render-scene-pass-kind-invalid',
      );
      const resource = { kind: record.kind, passKind };
      return {
        ...resource,
        defaults: normalizeParams('scene-pass@2', record.defaults, resource, true),
      };
    }
    default:
      fail('render-resource-kind-invalid');
  }
}

function normalizeSurfaceGeometry(value) {
  const record = plainRecord(value, 'render-surface-geometry-invalid');
  if (Object.hasOwn(record, 'primitive')) {
    allowedKeys(
      record,
      new Set(['primitive', 'width', 'height', 'segmentsX', 'segmentsY']),
      'render-surface-geometry-field-unknown',
    );
    if (record.primitive !== 'plane') fail('render-surface-primitive-invalid');
    return {
      primitive: 'plane',
      width: positiveFinite(record.width, 'render-surface-width-invalid'),
      height: positiveFinite(record.height, 'render-surface-height-invalid'),
      segmentsX: positiveInteger(record.segmentsX, 'render-surface-segments-x-invalid'),
      segmentsY: positiveInteger(record.segmentsY, 'render-surface-segments-y-invalid'),
    };
  }
  allowedKeys(
    record,
    new Set(['positions', 'normals', 'uvs', 'indices']),
    'render-surface-geometry-field-unknown',
  );
  const positions = finiteSequence(record.positions, 'render-surface-positions-invalid');
  if (positions.length < 9 || positions.length % 3 !== 0) {
    fail('render-surface-positions-invalid');
  }
  const vertexCount = positions.length / 3;
  const result = { positions };
  if (record.normals !== undefined) {
    const normals = finiteSequence(record.normals, 'render-surface-normals-invalid');
    if (normals.length !== positions.length) fail('render-surface-normals-invalid');
    result.normals = normals;
  }
  if (record.uvs !== undefined) {
    const uvs = finiteSequence(record.uvs, 'render-surface-uvs-invalid');
    if (uvs.length !== vertexCount * 2) fail('render-surface-uvs-invalid');
    result.uvs = uvs;
  }
  if (record.indices !== undefined) {
    const indices = integerSequence(record.indices, 'render-surface-indices-invalid');
    if (indices.length < 3 || indices.length % 3 !== 0
        || indices.some((item) => item >= vertexCount)) {
      fail('render-surface-indices-invalid');
    }
    result.indices = indices;
  }
  return result;
}

function normalizeTextureResource(record, atlas) {
  return {
    kind: record.kind,
    url: browserUrl(record.url, 'render-resource-url-invalid'),
    ...(record.colorSpace === undefined ? {} : {
      colorSpace: enumValue(
        record.colorSpace,
        ['srgb', 'linear'],
        'render-texture-color-space-invalid',
      ),
    }),
    ...(record.wrap === undefined ? {} : {
      wrap: normalizeWrap(record.wrap),
    }),
    ...(atlas ? {} : {}),
  };
}

function normalizeWrap(value) {
  if (typeof value === 'string') {
    return enumValue(value, ['clamp', 'repeat', 'mirror'], 'render-texture-wrap-invalid');
  }
  const record = plainRecord(value, 'render-texture-wrap-invalid');
  exactKeys(record, ['s', 't'], 'render-texture-wrap-invalid');
  return {
    s: enumValue(record.s, ['clamp', 'repeat', 'mirror'], 'render-texture-wrap-invalid'),
    t: enumValue(record.t, ['clamp', 'repeat', 'mirror'], 'render-texture-wrap-invalid'),
  };
}

function normalizePrimitivePart(value) {
  const record = plainRecord(value, 'render-primitive-part-invalid');
  allowedKeys(record, new Set(['shape', 'dimensions', 'transform', 'material']),
    'render-primitive-part-field-unknown');
  const shape = enumValue(record.shape, [...PRIMITIVE_SHAPES], 'render-primitive-shape-invalid');
  if (record.dimensions === undefined || record.material === undefined) {
    fail('render-primitive-part-invalid');
  }
  return {
    shape,
    dimensions: primitiveDimensions(shape, record.dimensions),
    ...(record.transform === undefined ? {} : {
      transform: normalizeTransform(record.transform),
    }),
    material: normalizeSourceMaterial(record.material),
  };
}

function validateCatalogReferences(resources) {
  const requireReference = (sourceId, targetId, kinds) => {
    const target = resources[targetId];
    if (!target || !kinds.has(target.kind)) {
      fail('render-resource-reference-invalid', `${sourceId} references ${targetId}.`);
    }
  };
  for (const [resourceId, resource] of Object.entries(resources)) {
    if (resource.kind === 'surface') {
      for (const targetId of resource.textureResourceIds ?? []) {
        requireReference(resourceId, targetId, new Set(['texture']));
      }
    }
    if (resource.kind === 'particle' && resource.textureResourceId !== undefined
        && resource.textureResourceId !== null) {
      requireReference(
        resourceId,
        resource.textureResourceId,
        new Set(['texture']),
      );
    }
  }
}

export function normalizeSnapshot(value, catalog) {
  const record = plainRecord(value, 'render-snapshot-invalid');
  exactKeys(record, [
    'schema', 'generation', 'commitSeq', 'sourceTick', 'compositions', 'sceneLayers',
  ], 'render-snapshot-invalid');
  if (record.schema !== RENDER_SNAPSHOT_SCHEMA) fail('render-snapshot-schema-invalid');
  if (!Array.isArray(record.compositions) || !Array.isArray(record.sceneLayers)) {
    fail('render-snapshot-collections-invalid');
  }
  const compositions = record.compositions.map((item) => normalizeComposition(item, catalog));
  assertUnique(compositions.map((item) => item.displayId), 'render-composition-duplicate');
  const sceneLayers = normalizeLayers(
    record.sceneLayers,
    catalog,
    LAYER_SCOPE_SCENE_LAYERS,
  );
  return deepFreeze({
    schema: RENDER_SNAPSHOT_SCHEMA,
    generation: nonnegativeInteger(record.generation, 'render-generation-invalid'),
    commitSeq: nonnegativeInteger(record.commitSeq, 'render-commit-seq-invalid'),
    sourceTick: nonnegativeInteger(record.sourceTick, 'render-source-tick-invalid'),
    compositions,
    sceneLayers,
  });
}

export function normalizeBatch(value, catalog) {
  const record = plainRecord(value, 'render-batch-invalid');
  exactKeys(record, [
    'schema', 'generation', 'commitSeq', 'sourceTick', 'changed',
    'removedDisplayIds', 'sceneLayers',
  ], 'render-batch-invalid');
  if (record.schema !== RENDER_BATCH_SCHEMA) fail('render-batch-schema-invalid');
  if (!Array.isArray(record.changed) || !Array.isArray(record.removedDisplayIds)
      || (record.sceneLayers !== null && !Array.isArray(record.sceneLayers))) {
    fail('render-batch-collections-invalid');
  }
  const changed = record.changed.map((item) => normalizeComposition(item, catalog));
  const removedDisplayIds = record.removedDisplayIds.map((item) => displayId(item));
  assertUnique(changed.map((item) => item.displayId), 'render-composition-duplicate');
  assertUnique(removedDisplayIds, 'render-removed-display-id-duplicate');
  const changedIds = new Set(changed.map((item) => item.displayId));
  if (removedDisplayIds.some((item) => changedIds.has(item))) {
    fail('render-batch-display-id-conflict');
  }
  return deepFreeze({
    schema: RENDER_BATCH_SCHEMA,
    generation: nonnegativeInteger(record.generation, 'render-generation-invalid'),
    commitSeq: nonnegativeInteger(record.commitSeq, 'render-commit-seq-invalid'),
    sourceTick: nonnegativeInteger(record.sourceTick, 'render-source-tick-invalid'),
    changed,
    removedDisplayIds,
    sceneLayers: record.sceneLayers === null
      ? null
      : normalizeLayers(record.sceneLayers, catalog, LAYER_SCOPE_SCENE_LAYERS),
  });
}

function normalizeComposition(value, catalog) {
  const record = plainRecord(value, 'render-composition-invalid');
  exactKeys(record, ['schema', 'displayId', 'renderRevision', 'layers'],
    'render-composition-invalid');
  if (record.schema !== RENDER_COMPOSITION_SCHEMA) {
    fail('render-composition-schema-invalid');
  }
  if (!Array.isArray(record.layers)) fail('render-composition-layers-invalid');
  return {
    schema: RENDER_COMPOSITION_SCHEMA,
    displayId: displayId(record.displayId),
    renderRevision: nonnegativeInteger(
      record.renderRevision,
      'render-revision-invalid',
    ),
    layers: normalizeLayers(record.layers, catalog, LAYER_SCOPE_NODE_COMPOSITION),
  };
}

function normalizeLayers(values, catalog, scope) {
  if (scope !== LAYER_SCOPE_NODE_COMPOSITION && scope !== LAYER_SCOPE_SCENE_LAYERS) {
    fail('render-layer-scope-invalid');
  }
  const result = values.map((value) => normalizeLayer(value, catalog, scope));
  const sceneLevel = scope === LAYER_SCOPE_SCENE_LAYERS;
  assertUnique(result.map((item) => item.key), sceneLevel
    ? 'render-scene-layer-key-duplicate'
    : 'render-layer-key-duplicate');
  if (sceneLevel) {
    const singletonKinds = result
      .filter((item) => item.pipelineId === 'scene-pass@2')
      .map((item) => catalog.resources[item.resourceId].passKind);
    assertUnique(singletonKinds, 'render-scene-pass-singleton-duplicate');
  }
  return result;
}

function normalizeLayer(value, catalog, scope) {
  const record = plainRecord(value, 'render-layer-invalid');
  exactKeys(record, [
    'key', 'pipelineId', 'resourceId', 'transform', 'material', 'animation',
    'params', 'batchKey', 'pickable', 'renderOrder',
  ], 'render-layer-invalid');
  const pipelineId = enumValue(record.pipelineId, PIPELINE_IDS, 'render-pipeline-id-invalid');
  const resourceId = opaqueId(record.resourceId, 'render-resource-id-invalid');
  const resource = catalog.resources[resourceId];
  if (!resource) fail('render-resource-unknown');
  if (!PIPELINE_RESOURCE_KINDS[pipelineId].has(resource.kind)) {
    fail('render-pipeline-resource-mismatch');
  }
  if (scope === LAYER_SCOPE_NODE_COMPOSITION && pipelineId === 'scene-pass@2') {
    fail('render-scene-pass-scope-invalid');
  }
  const key = opaqueId(record.key, scope === LAYER_SCOPE_SCENE_LAYERS
    ? 'render-scene-layer-key-invalid'
    : 'render-layer-key-invalid');
  const params = normalizeParams(pipelineId, record.params, resource);
  const animation = record.animation === null ? null : normalizeAnimation(record.animation);
  const material = normalizeMaterial(record.material, pipelineId);
  if (pipelineId === 'model@2') {
    if (params.clipLoop !== undefined && animation === null) {
      fail('render-model-clip-loop-without-animation');
    }
    if (resource.kind === 'model-url') {
      if (params.lodDistances !== undefined
          && params.lodDistances.length !== (resource.lodUrls?.length ?? 0)) {
        fail('render-model-lod-count-mismatch');
      }
      if (animation && resource.clipNames
          && !resource.clipNames.includes(animation.clipId)) {
        fail('render-model-clip-unknown');
      }
    } else if (params.lodDistances !== undefined) {
      fail('render-model-lod-resource-invalid');
    }
  }
  if (pipelineId === 'model@2' && resource.kind === 'primitive-model'
      && animation !== null) {
    fail('render-model-animation-resource-invalid');
  }
  if (pipelineId === 'sprite@2') validateSpriteTimeline(params, resource, animation);
  if (pipelineId === 'particle@2' && animation === null) {
    fail('render-particle-animation-required');
  }
  if ((pipelineId === 'surface@2' || pipelineId === 'scene-pass@2')
      && animation !== null) {
    fail('render-pipeline-animation-unsupported');
  }
  return {
    key,
    pipelineId,
    resourceId,
    transform: normalizeTransform(record.transform),
    material,
    animation,
    params,
    batchKey: record.batchKey === null
      ? null
      : nonemptyString(record.batchKey, 'render-batch-key-invalid'),
    pickable: booleanValue(record.pickable, 'render-pickable-invalid'),
    renderOrder: safeInteger(record.renderOrder, 'render-order-invalid'),
  };
}

function normalizeTransform(value) {
  const record = plainRecord(value, 'render-transform-invalid');
  exactKeys(record, ['position', 'rotationXyzw', 'scale'], 'render-transform-invalid');
  return {
    position: tuple(record.position, 3, 'render-position-invalid'),
    rotationXyzw: tuple(record.rotationXyzw, 4, 'render-rotation-invalid'),
    scale: tuple(record.scale, 3, 'render-scale-invalid'),
  };
}

function normalizeMaterial(value, pipelineId) {
  const record = plainRecord(value, 'render-material-invalid');
  exactKeys(record, [
    'tintRgba', 'opacity', 'emissive', 'alphaMode', 'alphaCutoff',
  ], 'render-material-invalid');
  const opacity = finiteNumber(record.opacity, 'render-opacity-invalid');
  if (opacity < 0 || opacity > 1) fail('render-opacity-invalid');
  const allowedAlphaModes = {
    'model@2': ['inherit', 'opaque', 'mask', 'blend'],
    'sprite@2': ['opaque', 'mask', 'blend'],
    'surface@2': ['opaque', 'mask', 'blend'],
    'particle@2': ['blend'],
    'scene-pass@2': ['opaque'],
  }[pipelineId];
  if (!allowedAlphaModes) fail('render-pipeline-id-invalid');
  const alphaMode = enumValue(
    record.alphaMode,
    allowedAlphaModes,
    'render-material-alpha-mode-invalid',
  );
  const alphaCutoff = unitFinite(record.alphaCutoff, 'render-material-alpha-cutoff-invalid');
  if (alphaMode !== 'mask' && alphaCutoff !== 0) {
    fail('render-material-alpha-cutoff-invalid');
  }
  const emissive = nonnegativeFinite(record.emissive, 'render-emissive-invalid');
  const tintRgba = uint32(record.tintRgba, 'render-tint-invalid');
  if (pipelineId === 'scene-pass@2'
      && (opacity !== 1 || emissive !== 0 || (tintRgba & 0xff) !== 0xff)) {
    fail('render-scene-pass-material-invalid');
  }
  return {
    tintRgba,
    opacity,
    emissive,
    alphaMode,
    alphaCutoff,
  };
}

function normalizeSourceMaterial(value) {
  const record = plainRecord(value, 'render-source-material-invalid');
  exactKeys(record, ['tintRgba', 'opacity', 'emissive'], 'render-source-material-invalid');
  return {
    tintRgba: uint32(record.tintRgba, 'render-source-material-invalid'),
    opacity: unitFinite(record.opacity, 'render-source-material-invalid'),
    emissive: nonnegativeFinite(record.emissive, 'render-source-material-invalid'),
  };
}

function normalizeAnimation(value) {
  const record = plainRecord(value, 'render-animation-invalid');
  exactKeys(record, ['stateId', 'clipId', 'startTick', 'flags', 'clock'],
    'render-animation-invalid');
  return {
    stateId: nonnegativeInteger(record.stateId, 'render-animation-state-invalid'),
    clipId: nonemptyString(record.clipId, 'render-animation-clip-invalid'),
    startTick: nonnegativeBigInt(record.startTick, 'render-animation-start-tick-invalid'),
    flags: nonnegativeInteger(record.flags, 'render-animation-flags-invalid'),
    clock: enumValue(
      record.clock,
      ['simulation', 'visual'],
      'render-animation-clock-invalid',
    ),
  };
}

function normalizeParams(pipelineId, value, resource, defaults = false) {
  const record = plainRecord(value, 'render-pipeline-params-invalid');
  allowedKeys(record, PARAM_FIELDS[pipelineId], 'render-pipeline-param-unknown');
  switch (pipelineId) {
    case 'model@2':
      return {
        ...(record.castShadow === undefined ? {} : {
          castShadow: booleanValue(record.castShadow, 'render-model-shadow-invalid'),
        }),
        ...(record.receiveShadow === undefined ? {} : {
          receiveShadow: booleanValue(record.receiveShadow, 'render-model-shadow-invalid'),
        }),
        ...(record.lodDistances === undefined ? {} : {
          lodDistances: increasingNumbers(record.lodDistances, 'render-model-lod-invalid'),
        }),
        ...(record.instance === undefined ? {} : {
          instance: booleanValue(record.instance, 'render-model-instance-invalid'),
        }),
        ...(record.clipLoop === undefined ? {} : {
          clipLoop: booleanValue(record.clipLoop, 'render-model-clip-loop-invalid'),
        }),
      };
    case 'sprite@2':
      return {
        ...(record.orientation === undefined ? {} : {
          orientation: enumValue(
            record.orientation,
            ['fixed', 'billboard', 'y-billboard', 'ground'],
            'render-sprite-orientation-invalid',
          ),
        }),
        ...(record.width === undefined ? {} : {
          width: positiveFinite(record.width, 'render-sprite-width-invalid'),
        }),
        ...(record.height === undefined ? {} : {
          height: positiveFinite(record.height, 'render-sprite-height-invalid'),
        }),
        ...(record.atlasCell === undefined ? {} : {
          atlasCell: nonnegativeInteger(record.atlasCell, 'render-atlas-cell-invalid'),
        }),
        ...(record.flipbook === undefined ? {} : {
          flipbook: normalizeFlipbook(record.flipbook),
        }),
      };
    case 'surface@2': {
      if (resource.family === 'surface.standard'
          && ['amplitude', 'speed', 'foam'].some((key) => record[key] !== undefined)) {
        fail('render-surface-param-family-invalid');
      }
      const result = {
        ...optionalNonnegative(record, 'amplitude', 'render-surface-amplitude-invalid'),
        ...optionalFinite(record, 'speed', 'render-surface-speed-invalid'),
        ...(record.foam === undefined ? {} : {
          foam: unitFinite(record.foam, 'render-surface-foam-invalid'),
        }),
        ...optionalPositive(record, 'textureScale', 'render-surface-texture-scale-invalid'),
      };
      if (!defaults && resource.family === 'surface.water') {
        const effective = { ...(resource.defaults ?? {}), ...result };
        for (const key of ['amplitude', 'speed', 'foam', 'textureScale']) {
          if (effective[key] === undefined) fail('render-surface-water-param-missing');
        }
      }
      if (resource.family === 'surface.standard' && result.textureScale !== undefined
          && resource.textureResourceIds.length === 0) {
        fail('render-surface-texture-scale-resource-invalid');
      }
      return result;
    }
    case 'particle@2': {
      const durationTicks = positiveInteger(
        record.durationTicks,
        'render-particle-duration-invalid',
      );
      const capacity = positiveInteger(record.capacity, 'render-particle-capacity-invalid');
      if (resource.maximumCapacity !== undefined && capacity > resource.maximumCapacity) {
        fail('render-particle-capacity-exceeded');
      }
      return {
        durationTicks,
        capacity,
        seed: nonnegativeInteger(record.seed, 'render-particle-seed-invalid'),
        rate: nonnegativeFinite(record.rate, 'render-particle-rate-invalid'),
        size: positiveFinite(record.size, 'render-particle-size-invalid'),
        velocity: tuple(record.velocity, 3, 'render-particle-velocity-invalid'),
        spread: tuple(record.spread, 3, 'render-particle-spread-invalid'),
        gravity: tuple(record.gravity, 3, 'render-particle-gravity-invalid'),
        blendMode: enumValue(
          record.blendMode,
          ['normal', 'additive'],
          'render-particle-blend-mode-invalid',
        ),
      };
    }
    case 'scene-pass@2': {
      const passKind = record.passKind === undefined
        ? resource.passKind
        : enumValue(record.passKind, [...SCENE_PASS_KINDS], 'render-scene-pass-kind-invalid');
      if (passKind !== resource.passKind) fail('render-scene-pass-kind-mismatch');
      if (passKind === 'background'
          && (record.intensity !== undefined || record.direction !== undefined)) {
        fail('render-scene-pass-param-kind-invalid');
      }
      const result = {
        ...(record.passKind === undefined ? {} : { passKind }),
        ...(record.colorRgba === undefined ? {} : {
          colorRgba: uint32(record.colorRgba, 'render-pass-color-invalid'),
        }),
        ...optionalNonnegative(record, 'intensity', 'render-pass-intensity-invalid'),
        ...(record.direction === undefined ? {} : {
          direction: nonzeroTuple(record.direction, 3, 'render-pass-direction-invalid'),
        }),
      };
      if (!defaults) {
        const effective = { ...(resource.defaults ?? {}), ...result };
        const required = passKind === 'background'
          ? ['colorRgba']
          : ['colorRgba', 'intensity', 'direction'];
        for (const key of required) {
          if (effective[key] === undefined) fail('render-scene-pass-param-missing');
        }
      }
      return result;
    }
    default:
      fail('render-pipeline-id-invalid');
  }
}

function validateSpriteTimeline(params, resource, animation) {
  const usesAtlas = params.atlasCell !== undefined || params.flipbook !== undefined;
  if (usesAtlas && resource.kind !== 'texture-atlas') {
    fail('render-sprite-atlas-resource-invalid');
  }
  if (resource.kind === 'texture-atlas') {
    const cellCount = atlasCellCount(resource);
    if (params.atlasCell !== undefined && params.atlasCell >= cellCount) {
      fail('render-atlas-cell-range-invalid');
    }
    if (params.flipbook !== undefined
        && params.flipbook.startCell + params.flipbook.frameCount > cellCount) {
      fail('render-flipbook-range-invalid');
    }
  }
  if ((params.flipbook !== undefined) !== (animation !== null)) {
    fail('render-sprite-animation-mismatch');
  }
}

function atlasCellCount(resource) {
  const count = resource.columns * resource.rows;
  if (!Number.isSafeInteger(count)) fail('render-atlas-cell-count-invalid');
  return count;
}

function normalizeFlipbook(value) {
  const record = plainRecord(value, 'render-flipbook-invalid');
  exactKeys(record, ['startCell', 'frameCount', 'frameTicks', 'loop'],
    'render-flipbook-invalid');
  return {
    startCell: nonnegativeInteger(record.startCell, 'render-flipbook-start-invalid'),
    frameCount: positiveInteger(record.frameCount, 'render-flipbook-count-invalid'),
    frameTicks: positiveInteger(record.frameTicks, 'render-flipbook-rate-invalid'),
    loop: booleanValue(record.loop, 'render-flipbook-loop-invalid'),
  };
}

function primitiveDimensions(shape, value) {
  const lengths = {
    box: 3,
    sphere: 1,
    cylinder: 4,
    cone: 4,
    plane: 2,
    'hex-prism': 2,
  };
  const result = tuple(value, lengths[shape], 'render-primitive-dimensions-invalid');
  if (shape === 'cylinder') {
    if (result[0] <= 0 || result[1] <= 0 || result[2] <= 0
        || !Number.isSafeInteger(result[3]) || result[3] < 3) {
      fail('render-primitive-dimensions-invalid');
    }
    return result;
  }
  if (shape === 'cone') {
    if (result[0] < 0 || result[1] <= 0 || result[2] <= 0
        || !Number.isSafeInteger(result[3]) || result[3] < 3) {
      fail('render-primitive-dimensions-invalid');
    }
    return result;
  }
  if (result.some((item) => item <= 0)) fail('render-primitive-dimensions-invalid');
  return result;
}

export function assertView(value) {
  if (!value || !Number.isSafeInteger(value.nodeCount) || value.nodeCount < 0
      || typeof value.nodeAt !== 'function' || typeof value.getNode !== 'function') {
    fail('render-view-invalid');
  }
  return cursorOf(value);
}

export function assertPlan(value) {
  const record = plainRecord(value, 'render-plan-invalid');
  if (record.kind !== 'frame') fail('render-frame-plan-invalid');
  const cursor = cursorOf(record);
  for (const field of [
    'animationDirtyIds', 'createIds', 'interactionDirtyIds', 'localPoseDirtyIds',
    'profileStateDirtyIds', 'removeIds', 'reparentIds', 'visibilityDirtyIds',
    'visualReplaceIds',
  ]) {
    if (!Array.isArray(record[field])) fail('render-plan-invalid');
    for (const identity of record[field]) displayId(identity);
  }
  return cursor;
}

export function cursorOf(value) {
  return Object.freeze({
    generation: nonnegativeInteger(value?.generation, 'render-generation-invalid'),
    commitSeq: nonnegativeInteger(value?.commitSeq, 'render-commit-seq-invalid'),
    sourceTick: nonnegativeInteger(value?.sourceTick, 'render-source-tick-invalid'),
  });
}

export function sameCursor(left, right) {
  return left.generation === right.generation
    && left.commitSeq === right.commitSeq
    && left.sourceTick === right.sourceTick;
}

export function emptyBatch(batch) {
  return batch.changed.length === 0
    && batch.removedDisplayIds.length === 0
    && batch.sceneLayers === null;
}

export function nodeSnapshot(node) {
  if (!node) fail('render-view-node-missing');
  return Object.freeze({
    displayId: displayId(node.displayId),
    parentDisplayId: parentDisplayId(node.parentDisplayId),
    localPosition: tuple(node.localPosition, 3, 'render-node-position-invalid'),
    localRotationXyzw: tuple(
      node.localRotationXyzw,
      4,
      'render-node-rotation-invalid',
    ),
    localScale: tuple(node.localScale, 3, 'render-node-scale-invalid'),
    flags: nonnegativeInteger(node.flags, 'render-node-flags-invalid'),
  });
}

export function layerFingerprint(layer) {
  return stableStringify(layer);
}

export function batchFingerprint(layer) {
  if (layer.pipelineId === 'model@2' && layer.params.instance !== true) return null;
  if (layer.pipelineId !== 'model@2' && layer.pipelineId !== 'sprite@2') return null;
  const tintAlpha = (layer.material.tintRgba & 0xff) / 255;
  if (layer.animation !== null || layer.material.alphaMode === 'blend'
      || layer.material.opacity * tintAlpha !== 1) return null;
  if (layer.pipelineId === 'model@2' && layer.params.lodDistances !== undefined) return null;
  const relevant = {
    pipelineId: layer.pipelineId,
    resourceId: layer.resourceId,
    material: layer.material,
    batchKey: layer.batchKey,
    pickable: layer.pickable,
    renderOrder: layer.renderOrder,
    params: layer.params,
  };
  return stableStringify(relevant);
}

export function displayId(value) {
  const result = nonnegativeBigInt(value, 'render-display-id-invalid');
  if (result === 0n) fail('render-display-id-invalid');
  return result;
}

export function parentDisplayId(value) {
  return nonnegativeBigInt(value, 'render-parent-display-id-invalid');
}

function clonePlainData(value, code, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteNumber(value, code);
  if (typeof value === 'bigint') return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return value.slice ? value.slice() : new value.constructor(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(code);
    seen.add(value);
    const result = value.map((item) => clonePlainData(item, code, seen));
    seen.delete(value);
    return result;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) fail(code);
    seen.add(value);
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_EXECUTABLE_DATA_KEYS.has(key)) fail(code);
      result[key] = clonePlainData(item, code, seen);
    }
    seen.delete(value);
    return result;
  }
  fail(code);
}

function stringArray(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value.map((item) => opaqueId(item, code));
}

function urlArray(value, code) {
  if (!Array.isArray(value)) fail(code);
  return value.map((item) => browserUrl(item, code));
}

function browserUrl(value, code) {
  const result = opaqueId(value, code);
  let parsed;
  try {
    parsed = new URL(result, 'https://scene-engine.invalid/');
  } catch {
    fail(code);
  }
  if (!['blob:', 'data:', 'file:', 'http:', 'https:'].includes(parsed.protocol)) fail(code);
  return result;
}

function finiteSequence(value, code) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value instanceof DataView) {
    fail(code);
  }
  return Array.from(value, (item) => finiteNumber(item, code));
}

function integerSequence(value, code) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value instanceof DataView) {
    fail(code);
  }
  return Array.from(value, (item) => nonnegativeInteger(item, code));
}

function increasingNumbers(value, code) {
  if (!Array.isArray(value)) fail(code);
  const result = value.map((item) => nonnegativeFinite(item, code));
  for (let index = 1; index < result.length; index += 1) {
    if (result[index] <= result[index - 1]) fail(code);
  }
  return result;
}

function tuple(value, count, code) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== count) {
    fail(code);
  }
  return Array.from(value, (item) => finiteNumber(item, code));
}

function nonzeroTuple(value, count, code) {
  const result = tuple(value, count, code);
  if (result.every((item) => item === 0)) fail(code);
  return result;
}

function exactKeys(record, keys, code) {
  if (Object.keys(record).length !== keys.length) fail(code);
  allowedKeys(record, new Set(keys), code);
  for (const key of keys) if (!Object.hasOwn(record, key)) fail(code);
}

function allowedKeys(record, keys, code) {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string'
        || !Object.prototype.propertyIsEnumerable.call(record, key)
        || !keys.has(key)) fail(code);
  }
}

function plainRecord(value, code) {
  if (!isPlainRecord(value)) fail(code);
  return value;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enumValue(value, choices, code) {
  if (!choices.includes(value)) fail(code);
  return value;
}

function nonemptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function opaqueId(value, code) {
  const result = nonemptyString(value, code);
  if (result.trim() !== result || result.length === 0) fail(code);
  return result;
}

function booleanValue(value, code) {
  if (typeof value !== 'boolean') fail(code);
  return value;
}

function finiteNumber(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code);
  return value;
}

function positiveFinite(value, code) {
  const result = finiteNumber(value, code);
  if (result <= 0) fail(code);
  return result;
}

function nonnegativeFinite(value, code) {
  const result = finiteNumber(value, code);
  if (result < 0) fail(code);
  return result;
}

function unitFinite(value, code) {
  const result = finiteNumber(value, code);
  if (result < 0 || result > 1) fail(code);
  return result;
}

function safeInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(code);
  return value;
}

function nonnegativeInteger(value, code) {
  const result = safeInteger(value, code);
  if (result < 0) fail(code);
  return result;
}

function positiveInteger(value, code) {
  const result = safeInteger(value, code);
  if (result <= 0) fail(code);
  return result;
}

function uint32(value, code) {
  const result = safeInteger(value, code);
  if (result < 0 || result > 0xffff_ffff) fail(code);
  return result;
}

function nonnegativeBigInt(value, code) {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    fail(code);
  }
  return value;
}

function optionalFinite(record, key, code) {
  return record[key] === undefined ? {} : { [key]: finiteNumber(record[key], code) };
}

function optionalPositive(record, key, code) {
  return record[key] === undefined ? {} : { [key]: positiveFinite(record[key], code) };
}

function optionalNonnegative(record, key, code) {
  return record[key] === undefined ? {} : { [key]: nonnegativeFinite(record[key], code) };
}

function assertUnique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function stableStringify(value) {
  if (typeof value === 'bigint') return `"${value}n"`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}
