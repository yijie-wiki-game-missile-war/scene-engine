import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

import { fail } from './errors.js';
import { TICKS_PER_SECOND } from './constants.js';
import { exactRecord, finiteTuple, isPlainRecord, stableData } from './validation.js';
import { installInstancedPanelProjection, installPanelProjection } from './panel-projection.js';

const DISPOSED_ASSETS = new WeakSet();
const MATERIAL_BASE = new WeakMap();
const MATERIAL_FIELDS = Object.freeze(new Set([
  'tintRgba', 'opacity', 'emissive', 'alphaMode', 'alphaCutoff',
  'depthTest', 'depthWrite',
]));
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export const DEFAULT_THREE_IMPLEMENTATION = Object.freeze({
  createRenderer(canvas, profile) {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: profile.antialias,
      alpha: profile.alpha,
    });
    renderer.shadowMap.enabled = profile.shadows;
    renderer.toneMapping = profile.toneMapping === 'aces-filmic'
      ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    const clear = rgba(profile.clearRgba);
    renderer.setClearColor(clear.color, clear.alpha);
    return renderer;
  },
  createResizeObserver(callback) {
    if (typeof globalThis.ResizeObserver === 'function') return new ResizeObserver(callback);
    return Object.freeze({ observe() {}, disconnect() {} });
  },
  devicePixelRatio() { return globalThis.devicePixelRatio ?? 1; },
  loadResource: loadThreeResource,
  disposeResource: disposeThreeResource,
});

export function resourceIdsForComponent(componentType, properties) {
  switch (componentType) {
    case 'render.model@2': return [requiredId(properties.modelResourceId)];
    case 'render.mesh@1': return [requiredId(properties.meshResourceId),
      requiredId(properties.materialResourceId)];
    case 'render.sprite@3': return [requiredId(properties.textureResourceId)];
    case 'render.surface@1': return [requiredId(properties.surfaceResourceId)];
    case 'render.particle@2': return [requiredId(properties.particleResourceId)];
    case 'render.background@1': return [properties.textureResourceId,
      properties.environmentResourceId].filter((value) => value !== null && value !== undefined)
      .map(requiredId);
    default: return [];
  }
}

export function assertComponentResourceKinds(componentType, leases) {
  const kinds = leases.map((lease) => lease.descriptor.kind);
  const valid = (() => {
    switch (componentType) {
      case 'render.model@2': return kinds.length === 1 && kinds[0] === 'model';
      case 'render.mesh@1': return kinds.length === 2 && kinds[0] === 'mesh' && kinds[1] === 'material';
      case 'render.sprite@3': return kinds.length === 1 && ['texture', 'texture-atlas'].includes(kinds[0]);
      case 'render.surface@1': return kinds.length === 1 && kinds[0] === 'surface';
      case 'render.particle@2': return kinds.length === 1 && kinds[0] === 'particle';
      case 'render.background@1': return kinds.every((kind) => ['texture', 'texture-atlas'].includes(kind));
      default: return kinds.length === 0;
    }
  })();
  if (!valid) fail('three-component-resource-kind-invalid');
}

export function createComponentHandle({ componentType, properties, leases, scene }) {
  const assets = leases.map((lease) => lease.value);
  const descriptors = leases.map((lease) => lease.descriptor);
  switch (componentType) {
    case 'render.model@2': return createModelHandle(assets[0], properties);
    case 'render.mesh@1': return createMeshHandle(assets[0], assets[1], properties);
    case 'render.sprite@3': return createSpriteHandle(assets[0], descriptors[0], properties);
    case 'render.surface@1': return createSurfaceHandle(assets[0], properties);
    case 'render.particle@2': return createParticleHandle(assets[0], properties);
    case 'render.camera@1': return createCameraHandle(properties);
    case 'render.background@1': return createBackgroundHandle(scene, assets, properties);
    case 'render.ambient-light@1': return createLightHandle('ambient', properties);
    case 'render.directional-light@1': return createLightHandle('directional', properties);
    case 'render.point-light@1': return createLightHandle('point', properties);
    case 'render.spot-light@1': return createLightHandle('spot', properties);
    default: fail('three-component-type-invalid');
  }
}

export async function loadThreeResource(descriptor, signal, dependencies) {
  assertNotAborted(signal);
  switch (descriptor.kind) {
    case 'model': {
      requiredId(descriptor.url);
      const results = await loadModelLevels([descriptor.url, ...(descriptor.lodUrls ?? [])], signal);
      return {
        kind: 'model',
        descriptor,
        template: results[0].scene,
        templates: results.map((result) => result.scene),
      };
    }
    case 'mesh': return loadMeshResource(descriptor, signal);
    case 'texture': {
      const texture = await loadTexture(requiredId(descriptor.url), signal);
      configureTexture(texture, descriptor);
      return { kind: 'texture', descriptor, texture, ownsTexture: true };
    }
    case 'texture-atlas': {
      positiveInteger(descriptor.columns); positiveInteger(descriptor.rows);
      if (descriptor.url) {
        const texture = await loadTexture(requiredId(descriptor.url), signal);
        configureTexture(texture, descriptor);
        return { kind: 'texture-atlas', descriptor, texture, ownsTexture: true };
      }
      if (dependencies.length !== 1 || !dependencies[0].texture) {
        fail('three-texture-atlas-source-invalid');
      }
      return { kind: 'texture-atlas', descriptor, texture: dependencies[0].texture, ownsTexture: false };
    }
    case 'material': return createMaterialResource(descriptor, dependencies);
    case 'surface': return createSurfaceResource(descriptor, dependencies);
    case 'particle': {
      positiveInteger(descriptor.maximumCapacity);
      return { kind: 'particle', descriptor, dependencies };
    }
    default: fail('three-resource-kind-invalid');
  }
}

export function disposeThreeResource(asset) {
  if (!asset || DISPOSED_ASSETS.has(asset)) return;
  DISPOSED_ASSETS.add(asset);
  switch (asset.kind) {
    case 'model': disposeTemplates(asset.templates ?? [asset.template]); break;
    case 'mesh': asset.geometry?.dispose?.(); break;
    case 'texture':
    case 'texture-atlas':
      if (asset.ownsTexture) {
        closeTextureImages(asset.texture, new Set());
        asset.texture?.dispose?.();
      }
      break;
    case 'material': asset.material?.dispose?.(); break;
    case 'surface': asset.geometry?.dispose?.(); break;
    default: break;
  }
}

function createModelHandle(asset, initialProperties) {
  let properties = normalizeModelProperties(initialProperties);
  validateModelOverrides(asset.templates ?? [asset.template], properties.materialOverrides);
  const levels = [];
  const ownedMaterials = new Set();
  let object = null;
  try {
    for (const template of asset.templates ?? [asset.template]) levels.push(cloneSkeleton(template));
    object = levels.length === 1 ? levels[0] : new THREE.LOD();
    if (object.isLOD) {
      for (let index = 0; index < levels.length; index += 1) object.addLevel(levels[index], index * 25);
    }
    for (const level of levels) configureModel(level, properties, ownedMaterials);
    return {
      object,
      camera: null,
      pickable: properties.pickable,
      requiresContinuousDraw: false,
      update(nextValue) {
        const next = normalizeModelProperties(nextValue);
        validateModelOverrides(levels, next.materialOverrides);
        properties = next;
        for (const level of levels) updateModel(level, properties);
        this.pickable = properties.pickable;
      },
      sample() {},
      createBatch: null,
      batchFingerprint: null,
      dispose() { disposeModelInstance(object, ownedMaterials); },
    };
  } catch (error) {
    disposeModelInstance(object ?? levels, ownedMaterials);
    throw error;
  }
}

function createMeshHandle(meshAsset, materialAsset, initialProperties) {
  let properties = normalizeMeshProperties(initialProperties);
  // Resource material properties are already applied; each instance owns a clone
  // of that appearance, while mesh updates change only presentation flags.
  const material = materialAsset.material.clone();
  const object = new THREE.Mesh(meshAsset.geometry, material);
  const configure = () => {
    object.castShadow = properties.castShadow;
    object.receiveShadow = properties.receiveShadow;
    object.renderOrder = properties.renderOrder;
  };
  configure();
  const handle = {
    object,
    camera: null,
    pickable: properties.pickable,
    requiresContinuousDraw: false,
    batchFingerprint: meshBatchFingerprint(),
    createBatch(count) {
      const geometry = meshAsset.geometry.clone();
      const batchMaterial = material.clone();
      const batch = new THREE.InstancedMesh(geometry, batchMaterial, count);
      batch.castShadow = properties.castShadow;
      batch.receiveShadow = properties.receiveShadow;
      batch.renderOrder = properties.renderOrder;
      return { object: batch, localMatrix: IDENTITY_MATRIX,
        dispose() { batch.removeFromParent(); geometry.dispose(); batchMaterial.dispose(); } };
    },
    update(nextValue) {
      properties = normalizeMeshProperties(nextValue);
      configure();
      this.pickable = properties.pickable;
      this.batchFingerprint = meshBatchFingerprint();
    },
    sample() {},
    dispose() { object.removeFromParent(); material.dispose(); },
  };
  function meshBatchFingerprint() {
    return stableData({ kind: 'mesh', mesh: meshAsset.descriptor.id,
      material: materialAsset.descriptor.id, properties });
  }
  return handle;
}

function createSpriteHandle(asset, descriptor, initialProperties) {
  let properties = normalizeSpriteProperties(initialProperties, descriptor);
  const texture = asset.texture.clone(); texture.needsUpdate = true;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  rememberMaterialBase(material);
  const object = new THREE.Mesh(geometry, material);
  const setPanelAnchor = installPanelProjection(object, material);
  const configure = () => {
    applyMaterial(material, properties.material, false, properties.alpha);
    object.renderOrder = properties.renderOrder;
    object.scale.set(properties.width, properties.height, 1);
    object.rotation.set(0, 0, 0);
    object.updateMatrix();
    setAtlasFrame(texture, descriptor, properties.frame);
  };
  configure();
  const handle = {
    object,
    setPanelAnchor,
    camera: null,
    pickable: properties.pickable,
    requiresContinuousDraw: false,
    batchFingerprint: spriteBatchFingerprint(),
    createBatch(count) {
      const batchGeometry = new THREE.PlaneGeometry(1, 1);
      const batchTexture = texture.clone(); batchTexture.needsUpdate = true;
      const batchMaterial = material.clone(); batchMaterial.map = batchTexture;
      const batch = new THREE.InstancedMesh(batchGeometry, batchMaterial, count);
      const panelProjection = installInstancedPanelProjection(batch, batchMaterial, count);
      const local = new THREE.Matrix4().makeScale(properties.width, properties.height, 1).toArray();
      batch.renderOrder = properties.renderOrder;
      return { object: batch, localMatrix: local, setPanelAnchorAt: panelProjection.setAt,
        panelAnchorAttribute: panelProjection.attribute,
        dispose() { batch.removeFromParent(); batchGeometry.dispose(); batchMaterial.dispose();
          batchTexture.dispose(); } };
    },
    update(nextValue) {
      properties = normalizeSpriteProperties(nextValue, descriptor);
      configure();
      this.pickable = properties.pickable;
      this.batchFingerprint = spriteBatchFingerprint();
    },
    sample() {},
    dispose() { object.removeFromParent(); geometry.dispose(); material.dispose(); texture.dispose(); },
  };
  function spriteBatchFingerprint() {
    return stableData({ kind: 'sprite', resource: descriptor.id, width: properties.width,
      height: properties.height, material: properties.material, alpha: properties.alpha,
      frame: properties.frame, renderOrder: properties.renderOrder, pickable: properties.pickable });
  }
  return handle;
}

function createSurfaceHandle(asset, initialProperties) {
  let properties = normalizeSurfaceProperties(initialProperties, asset.descriptor);
  const texture = asset.dependencies[0]?.texture?.clone?.() ?? null;
  if (texture) texture.needsUpdate = true;
  const water = asset.descriptor.family === 'surface.water';
  const material = water ? createWaterMaterial(texture, properties) : new THREE.MeshStandardMaterial({
    map: texture, side: THREE.DoubleSide,
  });
  if (!water) {
    rememberMaterialBase(material); applyMaterial(material, properties.material, false);
    applyTextureScale(texture, properties.parameters.textureScale);
  }
  const object = new THREE.Mesh(asset.geometry, material);
  object.receiveShadow = true; object.renderOrder = properties.renderOrder;
  return {
    object,
    camera: null,
    pickable: properties.pickable,
    requiresContinuousDraw: water,
    batchFingerprint: null,
    createBatch: null,
    update(nextValue) {
      properties = normalizeSurfaceProperties(nextValue, asset.descriptor);
      object.renderOrder = properties.renderOrder;
      this.pickable = properties.pickable;
      if (water) updateWaterMaterial(material, properties);
      else {
        applyMaterial(material, properties.material, false);
        applyTextureScale(texture, properties.parameters.textureScale);
      }
    },
    sample(frame) { if (water) material.uniforms.time.value = frame.visualSeconds; },
    dispose() { object.removeFromParent(); material.dispose(); texture?.dispose(); },
  };
}

function createParticleHandle(asset, initialProperties) {
  let properties = normalizeParticleProperties(initialProperties, asset.descriptor);
  const sourceTexture = asset.dependencies[0]?.texture ?? null;
  const texture = sourceTexture?.clone?.() ?? null;
  if (texture) texture.needsUpdate = true;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array(asset.descriptor.maximumCapacity * 3), 3,
  ));
  const material = new THREE.PointsMaterial({ map: texture, depthTest: true });
  const object = new THREE.Points(geometry, material); object.frustumCulled = false;
  const configure = () => {
    const values = properties.parameters;
    material.size = values.size;
    material.color.setHex(rgba(values.tintRgba).color);
    material.opacity = values.opacity;
    material.transparent = true; material.depthWrite = false;
    material.blending = values.blendMode === 'additive'
      ? THREE.AdditiveBlending : THREE.NormalBlending;
    material.needsUpdate = true; object.renderOrder = properties.renderOrder;
  };
  configure();
  // Procedural emitter time is renderer-local: a newly created emitter starts from its
  // own visual zero instead of inheriting the page-wide visualSeconds phase.
  let visualOriginSeconds = null;
  return {
    object,
    camera: null,
    pickable: false,
    requiresContinuousDraw: true,
    batchFingerprint: null,
    createBatch: null,
    update(nextValue) {
      properties = normalizeParticleProperties(nextValue, asset.descriptor); configure();
    },
    sample(frame) {
      if (visualOriginSeconds === null) visualOriginSeconds = frame.visualSeconds;
      sampleParticles(object, properties, Math.max(0, frame.visualSeconds - visualOriginSeconds));
    },
    dispose() { object.removeFromParent(); geometry.dispose(); material.dispose(); texture?.dispose(); },
  };
}

function createCameraHandle(initialProperties) {
  let properties = normalizeCameraProperties(initialProperties);
  let aspect = 1;
  let camera = makeCamera(properties, 1);
  const root = new THREE.Group(); root.add(camera);
  const handle = {
    object: root,
    camera,
    pickable: false,
    requiresContinuousDraw: false,
    batchFingerprint: null,
    createBatch: null,
    update(nextValue) {
      const next = normalizeCameraProperties(nextValue);
      if (next.projection !== properties.projection) {
        camera.removeFromParent(); camera = makeCamera(next, aspect); root.add(camera); this.camera = camera;
      }
      properties = next; updateCameraProjection(camera, properties, aspect);
    },
    resize(nextAspect) { aspect = nextAspect; updateCameraProjection(camera, properties, aspect); },
    sample() {},
    dispose() { camera.removeFromParent(); root.removeFromParent(); },
  };
  return handle;
}

function createBackgroundHandle(scene, assets, initialProperties) {
  let properties = normalizeBackgroundProperties(initialProperties);
  const textures = assets.map((asset) => {
    const texture = asset.texture.clone(); texture.needsUpdate = true; return texture;
  });
  let offset = 0;
  const backgroundTexture = properties.textureResourceId === null ? null : textures[offset++];
  const environmentTexture = properties.environmentResourceId === null ? null : textures[offset++];
  const apply = (visible = true) => {
    if (!visible) { scene.background = null; scene.environment = null; return; }
    const color = properties.colorRgba === null ? null : new THREE.Color(rgba(properties.colorRgba).color);
    scene.background = backgroundTexture ?? color;
    scene.environment = environmentTexture;
  };
  apply();
  return {
    object: null,
    camera: null,
    pickable: false,
    requiresContinuousDraw: false,
    batchFingerprint: null,
    createBatch: null,
    applyVisibility: apply,
    update(nextValue) { properties = normalizeBackgroundProperties(nextValue); apply(); },
    sample() {},
    dispose() { scene.background = null; scene.environment = null;
      for (const texture of textures) texture.dispose(); },
  };
}

function createLightHandle(kind, initialProperties) {
  let properties = normalizeLightProperties(initialProperties, kind);
  const root = new THREE.Group();
  let light;
  if (kind === 'ambient') light = new THREE.AmbientLight();
  if (kind === 'directional') {
    light = new THREE.DirectionalLight();
    light.target.position.set(0, 0, -1); root.add(light.target);
  }
  if (kind === 'point') light = new THREE.PointLight();
  if (kind === 'spot') {
    light = new THREE.SpotLight();
    light.target.position.set(0, 0, -1); root.add(light.target);
  }
  root.add(light);
  const configure = () => {
    light.color.setHex(rgba(properties.colorRgba).color);
    light.intensity = properties.intensity;
    light.castShadow = properties.castShadow;
    if ('distance' in light) light.distance = properties.range;
    if (kind === 'spot') {
      light.angle = properties.angleDegrees * Math.PI / 180;
      light.penumbra = properties.penumbra;
    }
  };
  configure();
  return {
    object: root,
    camera: null,
    light,
    pickable: false,
    requiresContinuousDraw: false,
    batchFingerprint: null,
    createBatch: null,
    update(nextValue) { properties = normalizeLightProperties(nextValue, kind); configure(); },
    sample() {},
    dispose() { light.shadow?.dispose?.(); root.removeFromParent(); },
  };
}

async function loadModel(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) fail('three-model-request-failed', `Model request failed (${response.status}).`);
  const bytes = await response.arrayBuffer(); assertNotAborted(signal);
  const result = await new GLTFLoader().parseAsync(bytes, baseUrl(url));
  if (signal.aborted) {
    disposeTemplates([result.scene]); assertNotAborted(signal);
  }
  return result;
}

async function loadModelLevels(urls, signal) {
  const results = [];
  try {
    for (const url of urls) results.push(await loadModel(url, signal));
    return results;
  } catch (error) {
    disposeTemplates(results.map((result) => result.scene));
    throw error;
  }
}

async function loadMeshResource(descriptor, signal) {
  let geometry;
  if (descriptor.url) {
    const response = await fetch(descriptor.url, { signal });
    if (!response.ok) fail('three-mesh-request-failed');
    const value = await response.json(); assertNotAborted(signal);
    geometry = new THREE.BufferGeometryLoader().parse(value);
  } else {
    if (!descriptor.positions) fail('three-mesh-positions-required');
    geometry = geometryFromArrays(descriptor);
  }
  return { kind: 'mesh', descriptor, geometry };
}

async function loadTexture(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) fail('three-texture-request-failed');
  const blob = await response.blob(); assertNotAborted(signal);
  if (typeof globalThis.createImageBitmap !== 'function') fail('three-image-bitmap-unavailable');
  const image = await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  if (signal.aborted) { image.close?.(); assertNotAborted(signal); }
  const texture = new THREE.Texture(image);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function createMaterialResource(descriptor, dependencies) {
  if (!['material.standard', 'material.unlit'].includes(descriptor.family)) {
    fail('three-material-family-invalid');
  }
  const spec = normalizeMaterial(descriptor.properties ?? {}, false);
  const map = dependencies[0]?.texture ?? null;
  const material = descriptor.family === 'material.unlit'
    ? new THREE.MeshBasicMaterial({ map }) : new THREE.MeshStandardMaterial({ map });
  rememberMaterialBase(material); applyMaterial(material, spec, false);
  return { kind: 'material', descriptor, dependencies, material };
}

function createSurfaceResource(descriptor, dependencies) {
  if (!['surface.standard', 'surface.water'].includes(descriptor.family)) {
    fail('three-surface-family-invalid');
  }
  return { kind: 'surface', descriptor, dependencies, geometry: surfaceGeometry(descriptor.geometry) };
}

function geometryFromArrays(value) {
  const positions = finiteTuple(value.positions, value.positions.length, 'three-mesh-geometry-invalid');
  if (positions.length < 9 || positions.length % 3 !== 0) fail('three-mesh-geometry-invalid');
  const vertexCount = positions.length / 3;
  let indices = null;
  if (value.indices) {
    indices = Array.from(value.indices);
    if (indices.length === 0 || indices.length % 3 !== 0
        || !indices.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry < vertexCount)) {
      fail('three-mesh-geometry-invalid');
    }
  } else if (vertexCount % 3 !== 0) {
    fail('three-mesh-geometry-invalid');
  }
  let normals = null;
  if (value.normals) {
    normals = finiteTuple(value.normals, value.normals.length, 'three-mesh-geometry-invalid');
    if (normals.length !== positions.length) fail('three-mesh-geometry-invalid');
  }
  let uvs = null;
  if (value.uvs) {
    uvs = finiteTuple(value.uvs, value.uvs.length, 'three-mesh-geometry-invalid');
    if (uvs.length !== vertexCount * 2) fail('three-mesh-geometry-invalid');
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (indices) geometry.setIndex(indices);
  if (normals) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

function surfaceGeometry(value) {
  if (!isPlainRecord(value)) fail('three-surface-geometry-invalid');
  if (value.positions) return geometryFromArrays(value);
  const allowed = new Set(['primitive', 'width', 'height', 'segmentsX', 'segmentsY']);
  exactRecord(value, allowed, 'three-surface-geometry-invalid');
  if (value.primitive !== 'plane' || !positive(value.width) || !positive(value.height)) {
    fail('three-surface-geometry-invalid');
  }
  return new THREE.PlaneGeometry(value.width, value.height,
    positiveInteger(value.segmentsX ?? 1), positiveInteger(value.segmentsY ?? 1));
}

function configureTexture(texture, descriptor) {
  texture.colorSpace = descriptor.colorSpace === 'linear'
    ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
  const wrap = typeof descriptor.wrap === 'string'
    ? { s: descriptor.wrap, t: descriptor.wrap } : (descriptor.wrap ?? { s: 'clamp', t: 'clamp' });
  const modes = { clamp: THREE.ClampToEdgeWrapping, repeat: THREE.RepeatWrapping,
    mirror: THREE.MirroredRepeatWrapping };
  if (!modes[wrap.s] || !modes[wrap.t]) fail('three-texture-wrap-invalid');
  texture.wrapS = modes[wrap.s]; texture.wrapT = modes[wrap.t]; texture.needsUpdate = true;
}

function normalizeModelProperties(value) {
  const record = exactRecord(value, new Set(['modelResourceId', 'materialOverrides', 'castShadow',
    'receiveShadow', 'renderOrder', 'pickable']), 'three-model-properties-invalid');
  requiredId(record.modelResourceId);
  return Object.freeze({
    modelResourceId: record.modelResourceId,
    materialOverrides: record.materialOverrides ?? {},
    castShadow: boolean(record.castShadow ?? false), receiveShadow: boolean(record.receiveShadow ?? false),
    renderOrder: integer(record.renderOrder ?? 0), pickable: boolean(record.pickable ?? false),
  });
}

function normalizeMeshProperties(value) {
  const record = exactRecord(value, new Set(['meshResourceId', 'materialResourceId', 'castShadow',
    'receiveShadow', 'renderOrder', 'pickable']), 'three-mesh-properties-invalid');
  return Object.freeze({ meshResourceId: requiredId(record.meshResourceId),
    materialResourceId: requiredId(record.materialResourceId),
    castShadow: boolean(record.castShadow ?? false), receiveShadow: boolean(record.receiveShadow ?? false),
    renderOrder: integer(record.renderOrder ?? 0), pickable: boolean(record.pickable ?? false) });
}

function normalizeSpriteProperties(value, descriptor) {
  const record = exactRecord(value, new Set(['textureResourceId', 'width', 'height', 'material',
    'alpha', 'frame', 'renderOrder', 'pickable']), 'three-sprite-properties-invalid');
  const alpha = unit(record.alpha ?? 1);
  const frame = nonnegativeInteger(record.frame ?? 0);
  validateAtlasFrame(descriptor, frame);
  return Object.freeze({ textureResourceId: requiredId(record.textureResourceId),
    width: positiveNumber(record.width), height: positiveNumber(record.height),
    material: normalizeMaterial(record.material ?? {}, false), alpha, frame,
    renderOrder: integer(record.renderOrder ?? 0), pickable: boolean(record.pickable ?? false) });
}

function normalizeSurfaceProperties(value, descriptor) {
  const record = exactRecord(value, new Set(['surfaceResourceId', 'material', 'parameters',
    'renderOrder', 'pickable']), 'three-surface-properties-invalid');
  const parameters = { ...(descriptor.defaults ?? {}), ...(record.parameters ?? {}) };
  if (descriptor.family === 'surface.water') {
    for (const key of Object.keys(parameters)) {
      if (!['amplitude', 'speed', 'foam', 'textureScale'].includes(key)) fail('three-water-parameters-invalid');
    }
    parameters.amplitude = nonnegative(parameters.amplitude ?? 0);
    parameters.speed = finite(parameters.speed ?? 0);
    parameters.foam = unit(parameters.foam ?? 0);
    parameters.textureScale = positiveNumber(parameters.textureScale ?? 1);
  } else {
    for (const key of Object.keys(parameters)) {
      if (key !== 'textureScale') fail('three-surface-parameters-invalid');
    }
    parameters.textureScale = positiveNumber(parameters.textureScale ?? 1);
  }
  return Object.freeze({ surfaceResourceId: requiredId(record.surfaceResourceId),
    material: normalizeMaterial(record.material ?? {}, false), parameters: Object.freeze(parameters),
    renderOrder: integer(record.renderOrder ?? 0), pickable: boolean(record.pickable ?? false) });
}

function normalizeParticleProperties(value, descriptor) {
  const record = exactRecord(value, new Set(['particleResourceId', 'intensity', 'parameters',
    'renderOrder']), 'three-particle-properties-invalid');
  const params = { ...(descriptor.defaults ?? {}), ...(record.parameters ?? {}) };
  const result = {
    durationTicks: positiveInteger(params.durationTicks ?? TICKS_PER_SECOND),
    capacity: positiveInteger(params.capacity ?? descriptor.maximumCapacity),
    seed: nonnegativeInteger(params.seed ?? 0), rate: nonnegative(params.rate ?? 0),
    size: positiveNumber(params.size ?? 1), velocity: vector(params.velocity ?? [0, 0, 0]),
    spread: vector(params.spread ?? [0, 0, 0]), gravity: vector(params.gravity ?? [0, 0, 0]),
    blendMode: ['normal', 'additive'].includes(params.blendMode ?? 'normal')
      ? (params.blendMode ?? 'normal') : fail('three-particle-blend-invalid'),
    tintRgba: uint32(params.tintRgba ?? 0xffff_ffff), opacity: unit(params.opacity ?? 1),
  };
  if (result.capacity > descriptor.maximumCapacity) fail('three-particle-capacity-invalid');
  return Object.freeze({ particleResourceId: requiredId(record.particleResourceId),
    intensity: nonnegative(record.intensity ?? 1), parameters: Object.freeze(result),
    renderOrder: integer(record.renderOrder ?? 0) });
}

function normalizeCameraProperties(value) {
  const record = exactRecord(value, new Set(['projection', 'near', 'far', 'fovYDegrees', 'orthoHeight']),
    'three-camera-properties-invalid');
  if (!['perspective', 'orthographic'].includes(record.projection)) fail('three-camera-properties-invalid');
  const near = positiveNumber(record.near); const far = positiveNumber(record.far);
  if (far <= near) fail('three-camera-properties-invalid');
  if (record.projection === 'perspective') {
    const fovYDegrees = positiveNumber(record.fovYDegrees ?? 50);
    if (fovYDegrees >= 180 || Object.hasOwn(record, 'orthoHeight')) fail('three-camera-properties-invalid');
    return Object.freeze({ projection: record.projection, near, far, fovYDegrees });
  }
  if (Object.hasOwn(record, 'fovYDegrees')) fail('three-camera-properties-invalid');
  return Object.freeze({ projection: record.projection, near, far,
    orthoHeight: positiveNumber(record.orthoHeight ?? 10) });
}

function normalizeBackgroundProperties(value) {
  const record = exactRecord(value, new Set(['colorRgba', 'textureResourceId', 'environmentResourceId']),
    'three-background-properties-invalid');
  const colorRgba = record.colorRgba === undefined ? null : uint32(record.colorRgba);
  const textureResourceId = record.textureResourceId ?? null;
  const environmentResourceId = record.environmentResourceId ?? null;
  if (colorRgba === null && textureResourceId === null) fail('three-background-properties-invalid');
  if (textureResourceId !== null) requiredId(textureResourceId);
  if (environmentResourceId !== null) requiredId(environmentResourceId);
  return Object.freeze({ colorRgba, textureResourceId, environmentResourceId });
}

function normalizeLightProperties(value, kind) {
  const record = exactRecord(value, new Set(['colorRgba', 'intensity', 'castShadow', 'range',
    'angleDegrees', 'penumbra']), 'three-light-properties-invalid');
  const result = { colorRgba: uint32(record.colorRgba ?? 0xffff_ffff),
    intensity: nonnegative(record.intensity ?? 1), castShadow: boolean(record.castShadow ?? false),
    range: nonnegative(record.range ?? 0), angleDegrees: positiveNumber(record.angleDegrees ?? 45),
    penumbra: unit(record.penumbra ?? 0) };
  if (kind === 'ambient' || kind === 'directional') result.range = 0;
  if (kind !== 'spot' && (Object.hasOwn(record, 'angleDegrees') || Object.hasOwn(record, 'penumbra'))) {
    fail('three-light-properties-invalid');
  }
  return Object.freeze(result);
}

function normalizeMaterial(value, allowInherit) {
  const record = exactRecord(value, MATERIAL_FIELDS, 'three-material-properties-invalid');
  const alphaMode = record.alphaMode ?? (allowInherit ? 'inherit' : 'opaque');
  if (!['opaque', 'mask', 'blend', ...(allowInherit ? ['inherit'] : [])].includes(alphaMode)) {
    fail('three-material-alpha-invalid');
  }
  const alphaCutoff = unit(record.alphaCutoff ?? 0);
  if (alphaMode !== 'mask' && alphaCutoff !== 0) fail('three-material-alpha-invalid');
  const inheritsDepth = allowInherit && alphaMode === 'inherit';
  const depthTest = Object.hasOwn(record, 'depthTest')
    ? boolean(record.depthTest) : inheritsDepth ? 'inherit' : true;
  const depthWrite = Object.hasOwn(record, 'depthWrite')
    ? boolean(record.depthWrite)
    : depthTest === false ? false : inheritsDepth ? 'inherit' : alphaMode !== 'blend';
  if (depthWrite === true && depthTest !== true) fail('three-material-depth-invalid');
  return Object.freeze({ tintRgba: uint32(record.tintRgba ?? 0xffff_ffff),
    opacity: unit(record.opacity ?? 1), emissive: nonnegative(record.emissive ?? 0),
    alphaMode, alphaCutoff, depthTest, depthWrite });
}

function validateModelOverrides(roots, overrides) {
  if (!isPlainRecord(overrides)) fail('three-model-material-overrides-invalid');
  let foundMaterial = false;
  for (const root of roots) root?.traverse?.((child) => {
    if (!child.isMesh) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material) { foundMaterial = true; modelOverride(overrides, material.name); }
    }
  });
  if (!foundMaterial) modelOverride(overrides, '');
}

function configureModel(object, properties, ownedMaterials) {
  object.traverse?.((child) => {
    if (!child.isMesh) return;
    const materials = (Array.isArray(child.material) ? child.material : [child.material]).map((source) => {
      const material = source.clone(); rememberMaterialBase(material);
      applyMaterial(material, modelOverride(properties.materialOverrides, source.name), true);
      ownedMaterials.add(material); return material;
    });
    child.material = Array.isArray(child.material) ? materials : materials[0];
    child.castShadow = properties.castShadow; child.receiveShadow = properties.receiveShadow;
    child.renderOrder = properties.renderOrder;
  });
}

function updateModel(object, properties) {
  object.traverse?.((child) => {
    if (!child.isMesh) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      applyMaterial(material, modelOverride(properties.materialOverrides, material.name), true);
    }
    child.castShadow = properties.castShadow; child.receiveShadow = properties.receiveShadow;
    child.renderOrder = properties.renderOrder;
  });
}

function disposeModelInstance(objectOrRoots, ownedMaterials) {
  const roots = Array.isArray(objectOrRoots) ? objectOrRoots : [objectOrRoots];
  const skeletons = new Set();
  for (const root of roots) root?.traverse?.((child) => {
    if (child.skeleton) skeletons.add(child.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose?.();
  for (const material of ownedMaterials) material.dispose?.();
  for (const root of roots) root?.removeFromParent?.();
}

function modelOverride(value, materialName) {
  if (!isPlainRecord(value)) fail('three-model-material-overrides-invalid');
  if (Object.keys(value).some((key) => MATERIAL_FIELDS.has(key))) return normalizeMaterial(value, true);
  return normalizeMaterial(value[materialName] ?? value['*'] ?? {}, true);
}

function rememberMaterialBase(material) {
  if (MATERIAL_BASE.has(material)) return;
  MATERIAL_BASE.set(material, { color: material.color?.clone?.() ?? null,
    emissive: material.emissive?.clone?.() ?? null, opacity: material.opacity ?? 1,
    transparent: material.transparent ?? false, depthWrite: material.depthWrite ?? true,
    depthTest: material.depthTest ?? true, alphaTest: material.alphaTest ?? 0 });
}

function applyMaterial(material, value, allowInherit, externalOpacity = 1) {
  const spec = value?.alphaMode ? value : normalizeMaterial(value, allowInherit);
  rememberMaterialBase(material); const base = MATERIAL_BASE.get(material); const tint = rgba(spec.tintRgba);
  if (base.color && material.color) material.color.copy(base.color).multiply(new THREE.Color(tint.color));
  if (material.emissive) {
    if (base.emissive) material.emissive.copy(base.emissive);
    else material.emissive.setHex(tint.color);
    material.emissive.multiplyScalar(spec.emissive);
  }
  const opacity = base.opacity * spec.opacity * tint.alpha * externalOpacity;
  material.opacity = opacity;
  if (spec.alphaMode === 'inherit') {
    material.alphaTest = base.alphaTest; material.transparent = base.transparent || opacity < 1;
  } else if (spec.alphaMode === 'opaque') {
    material.alphaTest = 0; material.transparent = false;
  } else if (spec.alphaMode === 'mask') {
    material.alphaTest = spec.alphaCutoff; material.transparent = false;
  } else {
    material.alphaTest = 0; material.transparent = true;
  }
  material.depthTest = spec.depthTest === 'inherit' ? base.depthTest : spec.depthTest;
  material.depthWrite = spec.depthWrite === 'inherit'
    ? (opacity < 1 ? false : base.depthWrite) : spec.depthWrite;
  if (!material.depthTest) material.depthWrite = false;
  material.needsUpdate = true;
}

function createWaterMaterial(texture, properties) {
  const material = new THREE.ShaderMaterial({
    depthTest: true, side: THREE.DoubleSide, transparent: properties.material.alphaMode === 'blend',
    defines: texture ? { USE_WATER_MAP: 1 } : {},
    uniforms: { map: { value: texture }, tint: { value: new THREE.Color() }, opacity: { value: 1 },
      emissive: { value: new THREE.Color() },
      time: { value: 0 }, amplitude: { value: 0 }, speed: { value: 0 }, foam: { value: 0 },
      textureScale: { value: 1 } },
    vertexShader: `uniform float time; uniform float amplitude; uniform float speed; varying vec2 vUv;
      varying float vWave; void main(){vUv=uv; vWave=sin(position.x*.19+time*speed)
      +sin(position.y*.23+time*speed*1.37); vec3 p=position+normal*(vWave*.5*amplitude);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
    fragmentShader: `uniform sampler2D map; uniform vec3 tint; uniform vec3 emissive;
      uniform float opacity; uniform float foam;
      uniform float textureScale; varying vec2 vUv; varying float vWave; void main(){vec3 base=tint;
      #ifdef USE_WATER_MAP
      base*=texture2D(map,vUv*textureScale).rgb;
      #endif
      float f=clamp(max(vWave,0.0)*foam,0.0,1.0);
      gl_FragColor=vec4(mix(base,vec3(1.0),f)+emissive,opacity);}`,
  });
  updateWaterMaterial(material, properties); return material;
}

function updateWaterMaterial(material, properties) {
  const tint = rgba(properties.material.tintRgba);
  material.uniforms.tint.value.setHex(tint.color);
  material.uniforms.emissive.value.setHex(tint.color).multiplyScalar(properties.material.emissive);
  material.uniforms.opacity.value = properties.material.opacity * tint.alpha;
  material.uniforms.amplitude.value = properties.parameters.amplitude;
  material.uniforms.speed.value = properties.parameters.speed;
  material.uniforms.foam.value = properties.parameters.foam;
  material.uniforms.textureScale.value = properties.parameters.textureScale;
  material.transparent = properties.material.alphaMode === 'blend';
  material.alphaTest = properties.material.alphaMode === 'mask'
    ? properties.material.alphaCutoff : 0;
  material.depthTest = properties.material.depthTest;
  material.depthWrite = properties.material.depthWrite;
  material.needsUpdate = true;
}

function applyTextureScale(texture, scale) {
  if (!texture) return;
  texture.repeat.set(scale, scale); texture.needsUpdate = true;
}

function sampleParticles(points, properties, elapsedSeconds) {
  const params = properties.parameters;
  const elapsedTicks = elapsedSeconds * TICKS_PER_SECOND;
  const positions = points.geometry.attributes.position.array;
  const rate = params.rate * properties.intensity;
  const alive = Math.min(params.capacity,
    Math.floor(elapsedTicks * rate / TICKS_PER_SECOND));
  for (let index = 0; index < params.capacity; index += 1) {
    const offset = index * 3;
    if (index >= alive) { positions[offset] = 0; positions[offset + 1] = 0; positions[offset + 2] = 0; continue; }
    const birthTick = rate === 0 ? 0 : index * TICKS_PER_SECOND / rate;
    const time = (Math.max(0, elapsedTicks - birthTick) % params.durationTicks)
      / TICKS_PER_SECOND;
    for (let axis = 0; axis < 3; axis += 1) {
      const noise = randomUnit(params.seed + index * 7 + axis * 101) * 2 - 1;
      const velocity = params.velocity[axis] + params.spread[axis] * noise;
      positions[offset + axis] = velocity * time + 0.5 * params.gravity[axis] * time * time;
    }
  }
  points.geometry.setDrawRange(0, alive); points.geometry.attributes.position.needsUpdate = true;
}

function makeCamera(properties, aspect) {
  if (properties.projection === 'perspective') {
    return new THREE.PerspectiveCamera(properties.fovYDegrees, aspect, properties.near, properties.far);
  }
  const halfHeight = properties.orthoHeight / 2;
  return new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect,
    halfHeight, -halfHeight, properties.near, properties.far);
}

function updateCameraProjection(camera, properties, aspect) {
  if (camera.isPerspectiveCamera) {
    camera.fov = properties.fovYDegrees; camera.near = properties.near;
    camera.far = properties.far; camera.aspect = aspect;
  } else {
    const halfHeight = properties.orthoHeight / 2;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.near = properties.near; camera.far = properties.far;
  }
  camera.updateProjectionMatrix();
}

function setAtlasFrame(texture, descriptor, frame) {
  if (descriptor.kind !== 'texture-atlas') return;
  validateAtlasFrame(descriptor, frame);
  const column = frame % descriptor.columns; const row = Math.floor(frame / descriptor.columns);
  texture.repeat.set(1 / descriptor.columns, 1 / descriptor.rows);
  texture.offset.set(column / descriptor.columns, 1 - (row + 1) / descriptor.rows);
  texture.updateMatrix(); texture.needsUpdate = true;
}

function validateAtlasFrame(descriptor, frame) {
  if (descriptor.kind === 'texture-atlas') {
    if (frame >= descriptor.columns * descriptor.rows) fail('three-sprite-frame-invalid');
  } else if (frame !== 0) fail('three-sprite-frame-invalid');
}

function disposeTemplates(templates) {
  const geometries = new Set(); const materials = new Set(); const textures = new Set();
  const skeletons = new Set(); const images = new Set();
  for (const template of templates) {
    template?.traverse?.((child) => {
      if (child.geometry) geometries.add(child.geometry); if (child.skeleton) skeletons.add(child.skeleton);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!material) continue; materials.add(material); collectMaterialTextures(material, textures);
      }
    });
    template?.removeFromParent?.();
  }
  for (const geometry of geometries) geometry.dispose?.(); for (const skeleton of skeletons) skeleton.dispose?.();
  for (const material of materials) material.dispose?.();
  for (const texture of textures) { closeTextureImages(texture, images); texture.dispose?.(); }
}

function collectMaterialTextures(material, target) {
  for (const value of Object.values(material ?? {})) if (value?.isTexture) target.add(value);
  for (const uniform of Object.values(material?.uniforms ?? {})) {
    const value = uniform?.value;
    if (value?.isTexture) target.add(value);
    if (Array.isArray(value)) for (const item of value) if (item?.isTexture) target.add(item);
  }
}

function closeTextureImages(texture, images) {
  const source = texture?.source?.data ?? texture?.image;
  for (const image of Array.isArray(source) ? source : [source]) {
    if (image && !images.has(image)) { images.add(image); image.close?.(); }
  }
}

function baseUrl(url) {
  const absolute = new URL(url, globalThis.document?.baseURI ?? globalThis.location?.href ?? 'http://localhost/');
  return absolute.href.slice(0, absolute.href.lastIndexOf('/') + 1);
}
function rgba(value) { return { color: (uint32(value) >>> 8) & 0x00ff_ffff, alpha: (value & 0xff) / 255 }; }
function requiredId(value) { if (typeof value !== 'string' || !value || value.trim() !== value) {
  fail('three-resource-id-invalid'); } return value; }
function assertNotAborted(signal) { if (signal?.aborted) fail('three-resource-load-aborted'); }
function boolean(value) { if (typeof value !== 'boolean') fail('three-property-boolean-invalid'); return value; }
function finite(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail('three-property-number-invalid'); return value; }
function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function positiveNumber(value) { value = finite(value); if (value <= 0) fail('three-property-positive-invalid'); return value; }
function nonnegative(value) { value = finite(value); if (value < 0) fail('three-property-nonnegative-invalid'); return value; }
function integer(value) { if (!Number.isSafeInteger(value)) fail('three-property-integer-invalid'); return value; }
function nonnegativeInteger(value) { value = integer(value); if (value < 0) fail('three-property-integer-invalid'); return value; }
function positiveInteger(value) { value = integer(value); if (value <= 0) fail('three-property-integer-invalid'); return value; }
function unit(value) { value = finite(value); if (value < 0 || value > 1) fail('three-property-unit-invalid'); return value; }
function uint32(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
  fail('three-property-color-invalid'); } return value; }
function vector(value) { return Object.freeze(finiteTuple(value, 3, 'three-property-vector-invalid')); }
function randomUnit(seed) { let value = seed >>> 0; value ^= value << 13; value ^= value >>> 17;
  value ^= value << 5; return (value >>> 0) / 0xffff_ffff; }
