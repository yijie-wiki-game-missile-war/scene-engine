import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

const MODEL_MATERIAL_BASE = new WeakMap();
const DISPOSED_ASSETS = new WeakSet();
const SCENE_PASS_STATES = new WeakMap();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

class PanZoomControls {
  constructor(camera, element, profile, onChange) {
    this.camera = camera;
    this.element = element;
    this.onChange = onChange;
    this.enabled = true;
    this.minDistance = profile.minDistance;
    this.maxDistance = profile.maxDistance;
    this.target = new THREE.Vector3(...profile.target);
    this.dampingFactor = profile.controls.dampingFactor;
    this.panSpeed = profile.controls.panSpeed;
    this.zoomSpeed = profile.controls.zoomSpeed;
    this.panBounds = profile.controls.panBounds;
    this.listeners = [];
    this.pointers = new Map();
    this.pendingPan = new THREE.Vector3();
    this.pendingZoomLog = 0;
    this.scratchDirection = new THREE.Vector3();
    this.scratchForward = new THREE.Vector3();
    this.scratchRight = new THREE.Vector3();
    this.scratchPan = new THREE.Vector3();
    this.disposed = false;

    this.#listen('contextmenu', (event) => event.preventDefault?.());
    this.#listen('wheel', (event) => {
      if (!this.enabled) return;
      event.preventDefault?.();
      this.#queueZoom(Number(event.deltaY ?? 0) * 0.001 * this.zoomSpeed);
    }, { passive: false });
    this.#listen('pointerdown', (event) => this.#pointerDown(event));
    this.#listen('pointermove', (event) => this.#pointerMove(event));
    this.#listen('pointerup', (event) => this.#pointerUp(event));
    this.#listen('pointercancel', (event) => this.#pointerUp(event));
    camera.lookAt(this.target);
  }

  get listenerCount() {
    return this.disposed ? 0 : this.listeners.length;
  }

  #listen(type, listener, options = undefined) {
    this.element.addEventListener(type, listener, options);
    this.listeners.push({ type, listener, options });
  }

  #pointerDown(event) {
    if (!this.enabled) return;
    const pointerId = Number(event.pointerId ?? 0);
    const pointerType = event.pointerType ?? 'mouse';
    const button = Number(event.button ?? 0);
    if (pointerType === 'mouse' && ![0, 1, 2].includes(button)) return;
    event.preventDefault?.();
    this.element.setPointerCapture?.(pointerId);
    this.pointers.set(pointerId, {
      button,
      pointerType,
      x: Number(event.clientX ?? 0),
      y: Number(event.clientY ?? 0),
    });
  }

  #pointerMove(event) {
    if (!this.enabled) return;
    const pointerId = Number(event.pointerId ?? 0);
    const previous = this.pointers.get(pointerId);
    if (!previous) return;
    event.preventDefault?.();
    const next = {
      ...previous,
      x: Number(event.clientX ?? previous.x),
      y: Number(event.clientY ?? previous.y),
    };
    const before = [...this.pointers.values()];
    this.pointers.set(pointerId, next);
    const after = [...this.pointers.values()];

    if (previous.pointerType === 'touch') {
      if (after.length === 1) {
        this.#queuePan(next.x - previous.x, next.y - previous.y);
      } else if (after.length === 2 && before.length === 2) {
        const oldCentroidX = (before[0].x + before[1].x) / 2;
        const oldCentroidY = (before[0].y + before[1].y) / 2;
        const newCentroidX = (after[0].x + after[1].x) / 2;
        const newCentroidY = (after[0].y + after[1].y) / 2;
        const oldSpan = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
        const newSpan = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
        this.#queuePan(newCentroidX - oldCentroidX, newCentroidY - oldCentroidY);
        if (oldSpan > 0 && newSpan > 0) {
          this.#queueZoom(Math.log(oldSpan / newSpan) * this.zoomSpeed);
        }
      }
      return;
    }

    if (previous.button === 1) {
      this.#queueZoom((next.y - previous.y) * 0.01 * this.zoomSpeed);
    } else {
      this.#queuePan(next.x - previous.x, next.y - previous.y);
    }
  }

  #pointerUp(event) {
    const pointerId = Number(event.pointerId ?? 0);
    this.pointers.delete(pointerId);
    this.element.releasePointerCapture?.(pointerId);
  }

  #queuePan(deltaX, deltaY) {
    const rect = this.element.getBoundingClientRect();
    const height = Math.max(1, Number(rect?.height ?? 1));
    const distance = this.camera.position.distanceTo(this.target);
    const radians = THREE.MathUtils.degToRad(this.camera.fov);
    const worldPerPixel = 2 * distance * Math.tan(radians / 2) / height;
    this.scratchForward.copy(this.target).sub(this.camera.position).setY(0);
    if (this.scratchForward.lengthSq() === 0) this.scratchForward.set(0, 0, -1);
    this.scratchForward.normalize();
    this.scratchRight.crossVectors(this.scratchForward, WORLD_UP).normalize();
    this.scratchPan.copy(this.scratchRight).multiplyScalar(
      -deltaX * worldPerPixel * this.panSpeed,
    ).addScaledVector(
      this.scratchForward,
      deltaY * worldPerPixel * this.panSpeed,
    );
    if (this.dampingFactor > 0) {
      this.pendingPan.add(this.scratchPan);
      this.onChange?.();
    } else {
      this.#applyPan(this.scratchPan);
      this.onChange?.();
    }
  }

  #queueZoom(logScale) {
    if (!Number.isFinite(logScale) || logScale === 0) return;
    if (this.dampingFactor > 0) {
      this.pendingZoomLog += logScale;
      this.onChange?.();
    } else {
      this.#applyZoom(logScale);
      this.onChange?.();
    }
  }

  #applyPan(delta) {
    this.camera.position.add(delta);
    this.target.add(delta);
    this.#clampTarget();
    this.camera.lookAt(this.target);
  }

  #applyZoom(logScale) {
    this.scratchDirection.copy(this.camera.position).sub(this.target);
    const distance = this.scratchDirection.length();
    if (distance === 0) return;
    const next = THREE.MathUtils.clamp(
      distance * Math.exp(logScale),
      this.minDistance,
      this.maxDistance,
    );
    this.camera.position.copy(this.target).add(this.scratchDirection.setLength(next));
    this.camera.lookAt(this.target);
  }

  #clampTarget() {
    if (!this.panBounds) return;
    const nextX = THREE.MathUtils.clamp(
      this.target.x,
      this.panBounds.minX,
      this.panBounds.maxX,
    );
    const nextZ = THREE.MathUtils.clamp(
      this.target.z,
      this.panBounds.minZ,
      this.panBounds.maxZ,
    );
    this.camera.position.x += nextX - this.target.x;
    this.camera.position.z += nextZ - this.target.z;
    this.target.x = nextX;
    this.target.z = nextZ;
  }

  update() {
    if (this.disposed || !this.enabled || this.dampingFactor === 0) return false;
    const factor = this.dampingFactor;
    let changed = false;
    if (this.pendingPan.lengthSq() > 1e-12) {
      this.scratchPan.copy(this.pendingPan).multiplyScalar(factor);
      this.pendingPan.sub(this.scratchPan);
      this.#applyPan(this.scratchPan);
      changed = true;
    } else {
      this.pendingPan.set(0, 0, 0);
    }
    if (Math.abs(this.pendingZoomLog) > 1e-8) {
      const step = this.pendingZoomLog * factor;
      this.pendingZoomLog -= step;
      this.#applyZoom(step);
      changed = true;
    } else {
      this.pendingZoomLog = 0;
    }
    if (changed) this.onChange?.();
    return changed;
  }

  focus(position, radius) {
    const nextTarget = new THREE.Vector3(...position);
    this.scratchDirection.copy(this.camera.position).sub(this.target);
    if (this.scratchDirection.lengthSq() === 0) this.scratchDirection.set(1, 0.7, 1);
    const distance = THREE.MathUtils.clamp(
      Math.max(radius * 2.5, this.minDistance),
      this.minDistance,
      this.maxDistance,
    );
    this.target.copy(nextTarget);
    this.camera.position.copy(this.target).add(this.scratchDirection.setLength(distance));
    this.pendingPan.set(0, 0, 0);
    this.pendingZoomLog = 0;
    this.#clampTarget();
    this.camera.lookAt(this.target);
    this.onChange?.();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { type, listener, options } of this.listeners) {
      this.element.removeEventListener(type, listener, options);
    }
    this.listeners.length = 0;
    this.pointers.clear();
    this.pendingPan.set(0, 0, 0);
    this.pendingZoomLog = 0;
  }
}

class ManagedResizeObserver {
  constructor(callback) {
    this.targets = new Set();
    this.native = typeof ResizeObserver === 'function' ? new ResizeObserver(callback) : null;
  }

  get observerCount() { return this.targets.size; }

  observe(target) {
    if (this.targets.has(target)) return;
    this.targets.add(target);
    this.native?.observe(target);
  }

  unobserve(target) {
    this.targets.delete(target);
    this.native?.unobserve(target);
  }

  disconnect() {
    this.native?.disconnect();
    this.targets.clear();
  }
}

function rgba(value) {
  return {
    color: (value >>> 8) & 0x00ff_ffff,
    alpha: (value & 0xff) / 255,
  };
}

function multiplyRgb(left, right) {
  const channel = (shift) => Math.round(
    ((left >>> shift) & 0xff) * ((right >>> shift) & 0xff) / 255,
  );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function layerOpacity(layer, sourceOpacity = 1) {
  return sourceOpacity * layer.material.opacity * rgba(layer.material.tintRgba).alpha;
}

function applyExplicitAlpha(material, layer, opacity, inherited = null) {
  material.opacity = opacity;
  switch (layer.material.alphaMode) {
    case 'inherit':
      material.alphaTest = inherited?.alphaTest ?? 0;
      material.transparent = opacity < 1 || (inherited?.transparent ?? false);
      material.depthWrite = opacity < 1 ? false : (inherited?.depthWrite ?? true);
      break;
    case 'opaque':
      material.alphaTest = 0;
      material.transparent = false;
      material.depthWrite = true;
      break;
    case 'mask':
      material.alphaTest = layer.material.alphaCutoff;
      material.transparent = false;
      material.depthWrite = true;
      break;
    case 'blend':
      material.alphaTest = 0;
      material.transparent = true;
      material.depthWrite = false;
      break;
    default:
      throw new Error(`Unsupported alpha mode ${layer.material.alphaMode}.`);
  }
  material.needsUpdate = true;
}

function captureModelMaterialBase(material) {
  return {
    alphaTest: material.alphaTest,
    color: material.color?.clone() ?? null,
    depthWrite: material.depthWrite,
    emissive: material.emissive?.clone() ?? null,
    opacity: material.opacity,
    transparent: material.transparent,
  };
}

function applyModelLayer(material, layer) {
  const base = MODEL_MATERIAL_BASE.get(material);
  if (!base) throw new Error('Model material has no immutable source state.');
  const tint = rgba(layer.material.tintRgba);
  if (material.color && base.color) {
    material.color.copy(base.color).multiply(new THREE.Color(tint.color));
  }
  if (material.emissive && base.emissive) {
    material.emissive.copy(base.emissive).add(
      new THREE.Color(tint.color).multiplyScalar(layer.material.emissive),
    );
  }
  applyExplicitAlpha(material, layer, layerOpacity(layer, base.opacity), base);
}

function composeModelMaterial(source, layer) {
  const material = source.clone();
  MODEL_MATERIAL_BASE.set(material, captureModelMaterialBase(source));
  applyModelLayer(material, layer);
  return material;
}

function applySimpleMaterial(material, layer) {
  const tint = rgba(layer.material.tintRgba);
  if (material.color) {
    material.color.setHex(tint.color).multiplyScalar(1 + layer.material.emissive);
  }
  if (material.emissive) {
    material.emissive.setHex(tint.color).multiplyScalar(layer.material.emissive);
  }
  applyExplicitAlpha(material, layer, layerOpacity(layer));
}

function makeSourceMaterial(spec = undefined) {
  const source = spec ?? { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0 };
  const tint = rgba(source.tintRgba ?? 0xffff_ffff);
  const opacity = (source.opacity ?? 1) * tint.alpha;
  return new THREE.MeshStandardMaterial({
    color: tint.color,
    emissive: new THREE.Color(tint.color).multiplyScalar(source.emissive ?? 0),
    opacity,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
  });
}

function makeGeometry(shape, dimensions = undefined) {
  switch (shape) {
    case 'box': {
      const [width, height, depth] = dimensions ?? [1, 1, 1];
      return new THREE.BoxGeometry(width, height, depth);
    }
    case 'sphere': return new THREE.SphereGeometry(dimensions?.[0] ?? 0.5, 24, 16);
    case 'cylinder': {
      const [radiusTop, radiusBottom, height, segments] = dimensions ?? [0.5, 0.5, 1, 16];
      return new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
    }
    case 'cone': {
      const [radiusTop, radiusBottom, height, segments] = dimensions ?? [0, 0.5, 1, 16];
      return new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
    }
    case 'plane': {
      const [width, height] = dimensions ?? [1, 1];
      return new THREE.PlaneGeometry(width, height);
    }
    case 'hex-prism': {
      const [radius, height] = dimensions ?? [0.5, 1];
      return new THREE.CylinderGeometry(radius, radius, height, 6);
    }
    default: throw new Error(`Unsupported primitive ${shape}.`);
  }
}

function applyTransform(object, transform) {
  object.position.set(...transform.position);
  object.quaternion.set(...transform.rotationXyzw);
  object.scale.set(...transform.scale);
  object.updateMatrix();
}

function modelMeshes(object) {
  const meshes = [];
  object.traverse?.((child) => { if (child.isMesh) meshes.push(child); });
  return meshes;
}

function configureModelObject(object, layer, materialMap = new Map()) {
  for (const mesh of modelMeshes(object)) {
    const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materials = sources.map((source) => {
      let material = materialMap.get(source);
      if (!material) {
        material = composeModelMaterial(source, layer);
        materialMap.set(source, material);
      }
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
    mesh.castShadow = layer.params.castShadow ?? false;
    mesh.receiveShadow = layer.params.receiveShadow ?? false;
    mesh.renderOrder = layer.renderOrder;
  }
  return object;
}

function updateModelObject(object, layer) {
  const materials = new Set();
  for (const mesh of modelMeshes(object)) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material && !materials.has(material)) {
        materials.add(material);
        applyModelLayer(material, layer);
      }
    }
    mesh.castShadow = layer.params.castShadow ?? false;
    mesh.receiveShadow = layer.params.receiveShadow ?? false;
    mesh.renderOrder = layer.renderOrder;
  }
}

function baseUrl(url) {
  const absolute = new URL(url, globalThis.document?.baseURI ?? globalThis.location?.href);
  return absolute.href.slice(0, absolute.href.lastIndexOf('/') + 1);
}

async function loadModel(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Model request failed (${response.status}).`);
  const data = await response.arrayBuffer();
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const result = await new GLTFLoader().parseAsync(data, baseUrl(url));
  if (signal.aborted) {
    disposeTemplates([result.scene]);
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  return result;
}

async function loadModelLevels(urls, signal) {
  const results = [];
  try {
    for (const url of urls) results.push(await loadModel(url, signal));
    return results;
  } catch (error) {
    disposeTemplates(results.map((item) => item.scene));
    throw error;
  }
}

async function loadTexture(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Texture request failed (${response.status}).`);
  const blob = await response.blob();
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const image = await createImageBitmap(blob);
  if (signal.aborted) {
    image.close?.();
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  const texture = new THREE.Texture(image);
  texture.needsUpdate = true;
  return texture;
}

function configureTexture(texture, descriptor) {
  texture.colorSpace = descriptor.colorSpace === 'linear'
    ? THREE.LinearSRGBColorSpace
    : THREE.SRGBColorSpace;
  const wrap = typeof descriptor.wrap === 'string'
    ? { s: descriptor.wrap, t: descriptor.wrap }
    : (descriptor.wrap ?? { s: 'clamp', t: 'clamp' });
  const modes = {
    clamp: THREE.ClampToEdgeWrapping,
    repeat: THREE.RepeatWrapping,
    mirror: THREE.MirroredRepeatWrapping,
  };
  texture.wrapS = modes[wrap.s];
  texture.wrapT = modes[wrap.t];
  texture.needsUpdate = true;
}

function setAtlasCell(texture, atlas, cell) {
  const column = cell % atlas.columns;
  const row = Math.floor(cell / atlas.columns);
  texture.repeat.set(1 / atlas.columns, 1 / atlas.rows);
  texture.offset.set(column / atlas.columns, 1 - (row + 1) / atlas.rows);
  texture.updateMatrix();
}

function isNumberSequence(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

function createSurfaceGeometry(descriptor) {
  const geometry = descriptor.geometry;
  if (isNumberSequence(geometry.positions)) {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(geometry.positions, 3));
    if (isNumberSequence(geometry.normals)) {
      result.setAttribute('normal', new THREE.Float32BufferAttribute(geometry.normals, 3));
    } else result.computeVertexNormals();
    if (isNumberSequence(geometry.uvs)) {
      result.setAttribute('uv', new THREE.Float32BufferAttribute(geometry.uvs, 2));
    }
    if (isNumberSequence(geometry.indices)) result.setIndex(geometry.indices);
    return result;
  }
  return new THREE.PlaneGeometry(
    geometry.width,
    geometry.height,
    geometry.segmentsX ?? 1,
    geometry.segmentsY ?? 1,
  );
}

function cloneBindingTexture(asset) {
  const source = asset?.texture ?? null;
  if (!source) return null;
  const texture = source.clone();
  texture.needsUpdate = true;
  return texture;
}

function applyTextureScale(texture, value) {
  if (!texture) return;
  const scale = value ?? 1;
  texture.repeat.set(scale, scale);
  texture.needsUpdate = true;
}

function createStandardSurfaceMaterial(layer, texture) {
  const material = new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide });
  applySimpleMaterial(material, layer);
  applyTextureScale(texture, layer.params.textureScale);
  return material;
}

function createWaterMaterial(layer, texture) {
  const material = new THREE.ShaderMaterial({
    depthTest: true,
    side: THREE.DoubleSide,
    defines: texture ? { USE_WATER_MAP: 1 } : {},
    uniforms: {
      map: { value: texture }, tint: { value: new THREE.Color() },
      emissive: { value: new THREE.Color() }, opacity: { value: 1 },
      time: { value: 0 }, amplitude: { value: 0 }, speed: { value: 0 },
      foam: { value: 0 }, textureScale: { value: 1 },
    },
    vertexShader: `
      uniform float time;
      uniform float amplitude;
      uniform float speed;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        vUv = uv;
        float phase = time * speed;
        float waveA = sin(position.x * 0.19 + position.y * 0.07 + phase);
        float waveB = sin(position.x * -0.11 + position.y * 0.23 + phase * 1.37);
        float waveC = sin(position.x * 0.05 + position.y * -0.31 + phase * 0.73);
        vWave = (waveA * 0.50 + waveB * 0.32 + waveC * 0.18);
        vec3 displaced = position + normal * (vWave * amplitude);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 tint;
      uniform vec3 emissive;
      uniform float opacity;
      uniform float foam;
      uniform float textureScale;
      #ifdef USE_WATER_MAP
      uniform sampler2D map;
      #endif
      varying vec2 vUv;
      varying float vWave;
      void main() {
        vec3 base = tint;
        #ifdef USE_WATER_MAP
        base *= texture2D(map, vUv * textureScale).rgb;
        #endif
        float foamAmount = clamp(max(vWave, 0.0) * foam, 0.0, 1.0);
        gl_FragColor = vec4(mix(base, vec3(1.0), foamAmount) + emissive, opacity);
      }
    `,
  });
  updateWaterMaterial(material, layer);
  return material;
}

function updateWaterMaterial(material, layer) {
  const tint = rgba(layer.material.tintRgba);
  material.uniforms.tint.value.setHex(tint.color);
  material.uniforms.emissive.value.setHex(tint.color).multiplyScalar(layer.material.emissive);
  material.uniforms.opacity.value = layerOpacity(layer);
  material.uniforms.amplitude.value = layer.params.amplitude;
  material.uniforms.speed.value = layer.params.speed;
  material.uniforms.foam.value = layer.params.foam;
  material.uniforms.textureScale.value = layer.params.textureScale ?? 1;
  applyExplicitAlpha(material, layer, layerOpacity(layer));
}

function createParticles(layer, texture, maximumCapacity) {
  const allocation = Math.max(layer.params.capacity, maximumCapacity ?? 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allocation * 3), 3));
  const material = new THREE.PointsMaterial({ map: texture, depthTest: true });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  updateParticleMaterial(material, layer);
  return points;
}

function updateParticleMaterial(material, layer) {
  applySimpleMaterial(material, layer);
  material.size = layer.params.size;
  material.blending = layer.params.blendMode === 'additive'
    ? THREE.AdditiveBlending
    : THREE.NormalBlending;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.needsUpdate = true;
}

function ensureParticleCapacity(points, capacity) {
  const attribute = points.geometry.attributes.position;
  if (attribute.count >= capacity) return;
  points.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
}

function randomUnit(seed) {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0xffff_ffff;
}

function simulationElapsedTicks(tick, startTick = 0n) {
  const source = BigInt(tick);
  return startTick >= source ? 0 : Number(source - startTick);
}

function updateParticles(points, layer, elapsedTicks) {
  ensureParticleCapacity(points, layer.params.capacity);
  const positions = points.geometry.attributes.position.array;
  const { capacity, durationTicks, rate, seed, velocity, spread, gravity } = layer.params;
  const alive = Math.min(capacity, Math.floor(Math.max(0, elapsedTicks) * rate / 60));
  for (let index = 0; index < capacity; index += 1) {
    const offset = index * 3;
    if (index >= alive) {
      positions[offset] = 0; positions[offset + 1] = 0; positions[offset + 2] = 0;
      continue;
    }
    const birthTick = rate === 0 ? 0 : index * 60 / rate;
    const ageTicks = Math.max(0, elapsedTicks - birthTick) % durationTicks;
    const time = ageTicks / 60;
    for (let axis = 0; axis < 3; axis += 1) {
      const noise = randomUnit(seed + index * 7 + axis * 101) * 2 - 1;
      const initial = velocity[axis] + spread[axis] * noise;
      positions[offset + axis] = initial * time + 0.5 * gravity[axis] * time * time;
    }
  }
  points.geometry.setDrawRange(0, alive);
  points.geometry.attributes.position.needsUpdate = true;
}

function materialTextures(material, target) {
  for (const value of Object.values(material ?? {})) if (value?.isTexture) target.add(value);
  for (const uniform of Object.values(material?.uniforms ?? {})) {
    const value = uniform?.value;
    if (value?.isTexture) target.add(value);
    if (Array.isArray(value)) for (const item of value) if (item?.isTexture) target.add(item);
  }
}

function closeTextureImages(texture, images) {
  const source = texture?.source?.data ?? texture?.image;
  for (const item of Array.isArray(source) ? source : [source]) {
    if (item && !images.has(item)) { images.add(item); item.close?.(); }
  }
}

function disposeTemplates(templates) {
  const geometries = new Set();
  const materials = new Set();
  const skeletons = new Set();
  const textures = new Set();
  const images = new Set();
  for (const template of templates) {
    template?.traverse?.((child) => {
      if (child.geometry) geometries.add(child.geometry);
      if (child.skeleton) skeletons.add(child.skeleton);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!material) continue;
        materials.add(material);
        materialTextures(material, textures);
      }
    });
    template?.removeFromParent?.();
  }
  for (const geometry of geometries) geometry.dispose?.();
  for (const skeleton of skeletons) skeleton.dispose?.();
  for (const material of materials) material.dispose?.();
  for (const texture of textures) { closeTextureImages(texture, images); texture.dispose?.(); }
}

function disposeBindingObject(object, { geometry = true, materials = true } = {}) {
  const geometries = new Set();
  const ownedMaterials = new Set();
  const skeletons = new Set();
  object?.traverse?.((child) => {
    if (geometry && child.geometry) geometries.add(child.geometry);
    if (child.skeleton) skeletons.add(child.skeleton);
    if (materials) {
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (material) ownedMaterials.add(material);
      }
    }
  });
  for (const item of geometries) item.dispose?.();
  // WebGLRenderer lazily creates one bone DataTexture for each rendered
  // Skeleton. Materials/geometries do not own it, so every cloned model must
  // retire its Skeleton explicitly or each full rebuild leaks one GPU texture.
  for (const item of skeletons) item.dispose?.();
  for (const item of ownedMaterials) item.dispose?.();
  object?.removeFromParent?.();
}

function hasMorphTargets(mesh) {
  if (mesh.morphTargetInfluences || mesh.morphTargetDictionary) return true;
  return Object.values(mesh.geometry?.morphAttributes ?? {}).some(
    (attributes) => Array.isArray(attributes) && attributes.length > 0,
  );
}

const SPRITE_ORIGIN = new THREE.Vector3();
const SPRITE_X_AXIS = new THREE.Vector3(1, 0, 0);
function spriteBaseMatrix(layer, target) {
  const orientation = layer.params.orientation ?? 'fixed';
  const rotation = new THREE.Quaternion();
  if (orientation === 'ground') rotation.setFromAxisAngle(SPRITE_X_AXIS, -Math.PI / 2);
  target.compose(
    SPRITE_ORIGIN,
    rotation,
    new THREE.Vector3(layer.params.width ?? 1, layer.params.height ?? 1, 1),
  );
}

function createInstanceBatch(pipelineId, asset, initialLayer, context) {
  let layer = initialLayer;
  let geometry;
  let material;
  const baseMatrix = new THREE.Matrix4();
  let ownedGeometry = false;
  let ownedTexture = null;
  let spriteOrientation = null;

  if (pipelineId === 'model@2') {
    if ((asset.templates?.length ?? 1) !== 1 || layer.params.lodDistances?.length
        || layer.animation !== null || (asset.animations?.length ?? 0) > 0) return null;
    asset.template.updateMatrixWorld(true);
    const meshes = modelMeshes(asset.template);
    const mesh = meshes[0];
    if (meshes.length !== 1 || !mesh || mesh.isSkinnedMesh || hasMorphTargets(mesh)
        || Array.isArray(mesh.material) || !mesh.geometry || !mesh.material) return null;
    geometry = mesh.geometry;
    material = composeModelMaterial(mesh.material, layer);
    baseMatrix.copy(mesh.matrixWorld);
  } else if (pipelineId === 'sprite@2') {
    if (layer.params.flipbook || layer.animation !== null) return null;
    spriteOrientation = layer.params.orientation ?? 'fixed';
    geometry = new THREE.PlaneGeometry(1, 1);
    ownedGeometry = true;
    ownedTexture = cloneBindingTexture(asset);
    material = new THREE.MeshBasicMaterial({ map: ownedTexture, side: THREE.DoubleSide, depthTest: true });
    applySimpleMaterial(material, layer);
    if (asset.descriptor.kind === 'texture-atlas') {
      setAtlasCell(ownedTexture, asset.descriptor, layer.params.atlasCell ?? 0);
    }
    spriteBaseMatrix(layer, baseMatrix);
  } else return null;

  const identities = [];
  const members = [];
  const cameraPosition = new THREE.Vector3();
  const cameraQuaternion = new THREE.Quaternion();
  const instanceMatrix = new THREE.Matrix4();
  const worldPosition = new THREE.Vector3();
  const worldQuaternion = new THREE.Quaternion();
  const worldScale = new THREE.Vector3();
  let capacity = 8;
  let object = makeObject(capacity);

  function makeObject(size) {
    const result = new THREE.InstancedMesh(geometry, material, size);
    result.count = 0;
    result.castShadow = layer.params.castShadow ?? false;
    result.receiveShadow = layer.params.receiveShadow ?? false;
    result.renderOrder = layer.renderOrder;
    result.frustumCulled = false;
    result.userData.renderBatchIdentities = identities;
    return result;
  }

  function grow(required) {
    if (required <= capacity) return;
    while (capacity < required) capacity *= 2;
    const previous = object;
    object = makeObject(capacity);
    if (previous.parent) previous.parent.add(object);
    previous.removeFromParent();
    previous.dispose?.();
  }

  function writeMatrices() {
    const cameraDependent = spriteOrientation === 'billboard' || spriteOrientation === 'y-billboard';
    if (cameraDependent) {
      context.camera.updateMatrixWorld(true);
      context.camera.getWorldPosition(cameraPosition);
      context.camera.getWorldQuaternion(cameraQuaternion);
    }
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      member.container.updateWorldMatrix(true, false);
      instanceMatrix.copy(member.container.matrixWorld);
      if (spriteOrientation === 'billboard') {
        instanceMatrix.decompose(worldPosition, worldQuaternion, worldScale);
        instanceMatrix.compose(worldPosition, cameraQuaternion, worldScale);
      } else if (spriteOrientation === 'y-billboard') {
        instanceMatrix.decompose(worldPosition, worldQuaternion, worldScale);
        const deltaX = cameraPosition.x - worldPosition.x;
        const deltaZ = cameraPosition.z - worldPosition.z;
        worldQuaternion.setFromAxisAngle(WORLD_UP, deltaX === 0 && deltaZ === 0 ? 0 : Math.atan2(deltaX, deltaZ));
        instanceMatrix.compose(worldPosition, worldQuaternion, worldScale);
      }
      instanceMatrix.multiply(baseMatrix);
      object.setMatrixAt(index, instanceMatrix);
    }
    object.count = members.length;
    object.instanceMatrix.needsUpdate = true;
  }

  return {
    get object() { return object; },
    update(nextMembers) {
      grow(nextMembers.length);
      members.length = 0; members.push(...nextMembers); identities.length = 0;
      for (const member of members) identities.push(Object.freeze({ displayId: member.displayId, layerKey: member.layerKey }));
      writeMatrices(); object.computeBoundingSphere?.();
    },
    updateLayer(_previousLayer, nextLayer) {
      layer = nextLayer;
      if (pipelineId === 'model@2') {
        applyModelLayer(material, layer);
        object.castShadow = layer.params.castShadow ?? false;
        object.receiveShadow = layer.params.receiveShadow ?? false;
      } else {
        spriteOrientation = layer.params.orientation ?? 'fixed';
        applySimpleMaterial(material, layer);
        if (asset.descriptor.kind === 'texture-atlas') {
          setAtlasCell(ownedTexture, asset.descriptor, layer.params.atlasCell ?? 0);
        }
        spriteBaseMatrix(layer, baseMatrix);
      }
      object.renderOrder = layer.renderOrder;
      writeMatrices();
      return true;
    },
    prepareDraw() {
      if (spriteOrientation === 'billboard' || spriteOrientation === 'y-billboard') writeMatrices();
    },
    dispose() {
      members.length = 0; identities.length = 0; object.removeFromParent(); object.dispose?.();
      material.dispose(); if (ownedGeometry) geometry.dispose(); ownedTexture?.dispose();
    },
  };
}

function createModelHandle(asset, initialLayer) {
  let layer = initialLayer;
  const materialMap = new Map();
  const levels = (asset.templates ?? [asset.template]).map(
    (template) => configureModelObject(cloneSkeleton(template), layer, materialMap),
  );
  let object = levels[0];
  if (layer.params.lodDistances?.length) {
    object = new THREE.LOD(); object.addLevel(levels[0], 0);
    for (let index = 0; index < layer.params.lodDistances.length; index += 1) {
      object.addLevel(levels[index + 1], layer.params.lodDistances[index]);
    }
  }
  let mixer = null;

  function configureAnimation() {
    mixer?.stopAllAction(); mixer = null;
    if (!layer.animation) return;
    const clip = asset.animations.find((item) => item.name === layer.animation.clipId);
    if (!clip) throw new Error(`Model animation clip ${layer.animation.clipId} is missing.`);
    mixer = new THREE.AnimationMixer(levels[0]);
    const action = mixer.clipAction(clip);
    action.loop = layer.params.clipLoop === false ? THREE.LoopOnce : THREE.LoopRepeat;
    action.clampWhenFinished = layer.params.clipLoop === false;
    action.play();
  }

  configureAnimation();
  return {
    object,
    sample(seconds) { mixer?.setTime(Math.max(0, seconds)); },
    update(_previousLayer, nextLayer) {
      const previousAnimation = layer.animation;
      const previousLoop = layer.params.clipLoop;
      layer = nextLayer;
      updateModelObject(object, layer);
      if (object.isLOD && layer.params.lodDistances) {
        for (let index = 0; index < layer.params.lodDistances.length; index += 1) {
          object.levels[index + 1].distance = layer.params.lodDistances[index];
        }
      }
      if (previousAnimation?.clipId !== layer.animation?.clipId
          || previousAnimation?.stateId !== layer.animation?.stateId
          || previousLoop !== layer.params.clipLoop) configureAnimation();
      return true;
    },
    dispose() { mixer?.stopAllAction(); disposeBindingObject(object, { geometry: false, materials: true }); },
  };
}

function createOrientationUpdater(object, camera, getOrientation) {
  const cameraPosition = new THREE.Vector3();
  const cameraQuaternion = new THREE.Quaternion();
  const objectPosition = new THREE.Vector3();
  const parentQuaternion = new THREE.Quaternion();
  const desired = new THREE.Quaternion();
  return () => {
    const orientation = getOrientation();
    if (orientation !== 'billboard' && orientation !== 'y-billboard') return;
    object.parent?.updateWorldMatrix(true, false); camera.updateMatrixWorld(true);
    object.parent?.getWorldQuaternion(parentQuaternion);
    if (orientation === 'billboard') {
      camera.getWorldQuaternion(cameraQuaternion);
      desired.copy(parentQuaternion).invert().multiply(cameraQuaternion);
    } else {
      camera.getWorldPosition(cameraPosition); object.getWorldPosition(objectPosition);
      desired.setFromAxisAngle(WORLD_UP, Math.atan2(cameraPosition.x - objectPosition.x, cameraPosition.z - objectPosition.z));
      desired.premultiply(parentQuaternion.invert());
    }
    object.quaternion.copy(desired); object.updateMatrix();
  };
}

function createSpriteHandle(asset, initialLayer, context) {
  let layer = initialLayer;
  const texture = cloneBindingTexture(asset);
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, depthTest: true });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const object = new THREE.Mesh(geometry, material);
  const atlas = asset.descriptor.kind === 'texture-atlas' ? asset.descriptor : null;
  const updateOrientation = createOrientationUpdater(object, context.camera, () => layer.params.orientation ?? 'fixed');

  function configure() {
    applySimpleMaterial(material, layer);
    object.renderOrder = layer.renderOrder;
    object.scale.set(layer.params.width ?? 1, layer.params.height ?? 1, 1);
    object.rotation.set(0, 0, 0);
    if ((layer.params.orientation ?? 'fixed') === 'ground') object.rotation.x = -Math.PI / 2;
    if (atlas) setAtlasCell(texture, atlas, layer.params.atlasCell ?? 0);
    object.updateMatrix();
  }

  configure();
  return {
    object,
    sample(seconds, tick) {
      updateOrientation();
      if (!atlas) return;
      let cell = layer.params.atlasCell ?? 0;
      const flipbook = layer.params.flipbook;
      if (flipbook) {
        const offset = layer.animation?.clock === 'visual'
          ? seconds * 60
          : simulationElapsedTicks(tick, layer.animation?.startTick ?? 0n);
        const frame = Math.floor(offset / flipbook.frameTicks);
        const limited = flipbook.loop ? frame % flipbook.frameCount : Math.min(frame, flipbook.frameCount - 1);
        cell = flipbook.startCell + limited;
      }
      setAtlasCell(texture, atlas, cell);
    },
    update(_previousLayer, nextLayer) { layer = nextLayer; configure(); return true; },
    dispose() { object.removeFromParent(); geometry.dispose(); material.dispose(); texture.dispose(); },
  };
}

function createSurfaceHandle(asset, initialLayer) {
  let layer = initialLayer;
  let effectiveLayer = {
    ...layer,
    params: { ...(asset.descriptor.defaults ?? {}), ...layer.params },
  };
  const sourceTexture = asset.dependencies.find((item) => item.texture) ?? null;
  const texture = cloneBindingTexture(sourceTexture);
  const water = asset.descriptor.family === 'surface.water';
  const material = water
    ? createWaterMaterial(effectiveLayer, texture)
    : createStandardSurfaceMaterial(effectiveLayer, texture);
  const object = new THREE.Mesh(asset.geometry, material);
  object.receiveShadow = true; object.renderOrder = layer.renderOrder;
  return {
    object,
    sample(seconds) { if (water) material.uniforms.time.value = seconds; },
    update(_previousLayer, nextLayer) {
      layer = nextLayer;
      effectiveLayer = {
        ...layer,
        params: { ...(asset.descriptor.defaults ?? {}), ...layer.params },
      };
      object.renderOrder = layer.renderOrder;
      if (water) updateWaterMaterial(material, effectiveLayer);
      else {
        applySimpleMaterial(material, effectiveLayer);
        applyTextureScale(texture, effectiveLayer.params.textureScale);
      }
      return true;
    },
    dispose() { object.removeFromParent(); material.dispose(); texture?.dispose(); },
  };
}

function createParticleHandle(asset, initialLayer) {
  let layer = initialLayer;
  const texture = asset.dependencies.find((item) => item.texture)?.texture ?? null;
  const object = createParticles(layer, texture, asset.descriptor.maximumCapacity);
  object.renderOrder = layer.renderOrder;
  return {
    object,
    sample(seconds) { updateParticles(object, layer, seconds * 60); },
    update(_previousLayer, nextLayer) {
      layer = nextLayer; ensureParticleCapacity(object, layer.params.capacity);
      updateParticleMaterial(object.material, layer); object.renderOrder = layer.renderOrder;
      return true;
    },
    dispose() { disposeBindingObject(object); },
  };
}

function createScenePassHandle(asset, initialLayer) {
  let layer = initialLayer;
  const object = new THREE.Group(); object.renderOrder = layer.renderOrder;
  return {
    descriptor: asset.descriptor, object, sample() {},
    update(_previousLayer, nextLayer) { layer = nextLayer; object.renderOrder = layer.renderOrder; return true; },
    dispose() { object.removeFromParent(); },
  };
}

function passColor(descriptor, layer) {
  const params = { ...(descriptor.defaults ?? {}), ...layer.params };
  const base = rgba(params.colorRgba ?? 0xffffffff).color;
  return multiplyRgb(base, rgba(layer.material.tintRgba).color);
}

function disposeLightsRoot(root) {
  root?.traverse?.((object) => object.shadow?.dispose?.());
  root?.removeFromParent?.();
}

function replaceScenePassState(scene, entries) {
  let background = null;
  let lightsRoot = null;
  for (const entry of entries) {
    const { descriptor, layer } = entry;
    const params = { ...(descriptor.defaults ?? {}), ...layer.params };
    const color = passColor(descriptor, layer);
    const opacity = layerOpacity(layer);
    if (descriptor.passKind === 'background') {
      background = new THREE.Color(color).multiplyScalar(opacity);
    } else if (descriptor.passKind === 'lights') {
      lightsRoot = new THREE.Group(); lightsRoot.name = 'SceneEngineLights';
      const intensity = (params.intensity ?? 1) * opacity;
      const ambient = new THREE.AmbientLight(color, intensity * 0.35);
      const directional = new THREE.DirectionalLight(color, intensity);
      directional.position.set(...(params.direction ?? [1, 1, 1]));
      directional.castShadow = true;
      lightsRoot.add(ambient, directional);
    }
  }
  const previous = SCENE_PASS_STATES.get(scene) ?? { lightsRoot: null };
  if (lightsRoot) scene.add(lightsRoot);
  scene.background = background;
  // Three owns shadow render targets below each light, not below its parent
  // Object3D. Removing the old light tree does not free those GPU textures.
  disposeLightsRoot(previous.lightsRoot);
  SCENE_PASS_STATES.set(scene, { lightsRoot });
}

export const DEFAULT_THREE_ADAPTER = Object.freeze({
  isHostElement(value) {
    return value != null && typeof value.getBoundingClientRect === 'function'
      && typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';
  },
  isCanvas(value) { return value != null && typeof value.getContext === 'function'; },
  createRenderer(canvas, profile) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: profile.antialias, alpha: profile.alpha });
    renderer.shadowMap.enabled = profile.shadows;
    renderer.toneMapping = profile.toneMapping === 'aces-filmic' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    const clear = rgba(profile.clearRgba); renderer.setClearColor(clear.color, clear.alpha);
    return renderer;
  },
  createScene() { return new THREE.Scene(); },
  createGroup() { return new THREE.Group(); },
  createCamera(profile, aspect) {
    const camera = new THREE.PerspectiveCamera(profile.fovYDegrees, aspect, profile.near, profile.far);
    camera.position.set(...profile.position); camera.up.set(...profile.up); camera.lookAt(...profile.target);
    camera.updateProjectionMatrix(); return camera;
  },
  resizeCamera(camera, _profile, aspect) { camera.aspect = aspect; camera.updateProjectionMatrix(); },
  createControls(camera, element, profile, onChange) { return new PanZoomControls(camera, element, profile, onChange); },
  createResizeObserver(callback) { return new ManagedResizeObserver(callback); },
  requestAnimationFrame(callback) { return globalThis.requestAnimationFrame(callback); },
  cancelAnimationFrame(identity) { globalThis.cancelAnimationFrame(identity); },
  now() { return globalThis.performance?.now?.() ?? Date.now(); },
  devicePixelRatio() { return globalThis.devicePixelRatio ?? 1; },
  setViewport(renderer, camera, profile, width, height, pixelRatio) {
    renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
    this.resizeCamera(camera, profile, width / height);
  },
  render(renderer, scene, camera) { renderer.render(scene, camera); },
  captureRendererInfo(renderer) {
    const info = renderer.info;
    if (!info?.render || !info?.memory) return null;
    return Object.freeze({
      calls: info.render.calls, frame: info.render.frame, geometries: info.memory.geometries,
      lines: info.render.lines, points: info.render.points, textures: info.memory.textures,
      triangles: info.render.triangles,
    });
  },
  resetRendererContext(renderer) {
    const gl = renderer?.getContext?.();
    if (!gl || typeof gl.pixelStorei !== 'function') return;
    // A new WebGLRenderer on an existing canvas receives the same WebGL2
    // context. Its constructor creates default TEXTURE_3D/TEXTURE_2D_ARRAY
    // placeholders before ordinary texture uploads can restore unpack state.
    const defaults = [
      ['UNPACK_FLIP_Y_WEBGL', false],
      ['UNPACK_PREMULTIPLY_ALPHA_WEBGL', false],
      ['UNPACK_ALIGNMENT', 4],
      ['UNPACK_ROW_LENGTH', 0],
      ['UNPACK_IMAGE_HEIGHT', 0],
      ['UNPACK_SKIP_PIXELS', 0],
      ['UNPACK_SKIP_ROWS', 0],
      ['UNPACK_SKIP_IMAGES', 0],
      ['PACK_ALIGNMENT', 4],
      ['PACK_ROW_LENGTH', 0],
      ['PACK_SKIP_PIXELS', 0],
      ['PACK_SKIP_ROWS', 0],
    ];
    for (const [name, value] of defaults) {
      if (typeof gl[name] === 'number') gl.pixelStorei(gl[name], value);
    }
    if (typeof gl.UNPACK_COLORSPACE_CONVERSION_WEBGL === 'number'
        && typeof gl.BROWSER_DEFAULT_WEBGL === 'number') {
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    }
  },
  updateMatrices(root) { root.updateMatrixWorld(true); },
  setTransform(object, transform) { applyTransform(object, transform); object.matrixAutoUpdate = false; },
  setNodePose(object, node) {
    applyTransform(object, { position: node.localPosition, rotationXyzw: node.localRotationXyzw, scale: node.localScale });
    object.matrixAutoUpdate = false;
  },
  async createResource(descriptor, signal, dependencies) {
    if (descriptor.kind === 'model-url') {
      const results = await loadModelLevels([descriptor.url, ...(descriptor.lodUrls ?? [])], signal);
      return {
        kind: descriptor.kind, template: results[0].scene,
        templates: results.map((item) => item.scene), animations: results[0].animations ?? [],
      };
    }
    if (descriptor.kind === 'primitive-model') {
      const template = new THREE.Group();
      for (const part of descriptor.parts) {
        const mesh = new THREE.Mesh(makeGeometry(part.shape, part.dimensions), makeSourceMaterial(part.material));
        if (part.transform) applyTransform(mesh, part.transform);
        template.add(mesh);
      }
      return { kind: descriptor.kind, template, templates: [template], animations: [] };
    }
    if (descriptor.kind === 'texture' || descriptor.kind === 'texture-atlas') {
      const texture = await loadTexture(descriptor.url, signal); configureTexture(texture, descriptor);
      return { kind: descriptor.kind, texture, descriptor };
    }
    if (descriptor.kind === 'surface') {
      return { kind: descriptor.kind, descriptor, dependencies, geometry: createSurfaceGeometry(descriptor) };
    }
    return { kind: descriptor.kind, descriptor, dependencies };
  },
  disposeResource(asset) {
    if (!asset || DISPOSED_ASSETS.has(asset)) return;
    DISPOSED_ASSETS.add(asset);
    if (asset.kind === 'model-url' || asset.kind === 'primitive-model') {
      disposeTemplates(asset.templates ?? [asset.template]);
    } else if (asset.kind === 'texture' || asset.kind === 'texture-atlas') {
      closeTextureImages(asset.texture, new Set()); asset.texture.dispose();
    } else if (asset.kind === 'surface') asset.geometry?.dispose?.();
  },
  createInstanceBatch(pipelineId, asset, layer, context) { return createInstanceBatch(pipelineId, asset, layer, context); },
  createPipelineObject(pipelineId, asset, layer, context) {
    switch (pipelineId) {
      case 'model@2': return createModelHandle(asset, layer);
      case 'sprite@2': return createSpriteHandle(asset, layer, context);
      case 'surface@2': return createSurfaceHandle(asset, layer);
      case 'particle@2': return createParticleHandle(asset, layer);
      case 'scene-pass@2': return createScenePassHandle(asset, layer);
      default: throw new Error(`Unknown fixed pipeline ${pipelineId}.`);
    }
  },
  replaceScenePassState(_renderer, scene, entries) { replaceScenePassState(scene, entries); },
  project(camera, hostElement, position) {
    const vector = new THREE.Vector3(...position).project(camera); const rect = hostElement.getBoundingClientRect();
    return {
      ok: true, clientX: rect.left + (vector.x + 1) * rect.width / 2,
      clientY: rect.top + (1 - vector.y) * rect.height / 2,
      visible: vector.z >= -1 && vector.z <= 1, depth: vector.z,
    };
  },
  pick(camera, hostElement, clientX, clientY, pickables) {
    const rect = hostElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables.map((item) => item.object), true);
    for (const hit of hits) {
      const batchIdentities = hit.object?.userData?.renderBatchIdentities;
      if (batchIdentities && Number.isInteger(hit.instanceId)) {
        const identity = batchIdentities[hit.instanceId];
        if (identity) return {
          hit: true, displayId: identity.displayId, layerKey: identity.layerKey,
          worldPosition: [hit.point.x, hit.point.y, hit.point.z], distance: hit.distance,
        };
      }
      let cursor = hit.object;
      while (cursor && !cursor.userData?.renderPickIdentity) cursor = cursor.parent;
      const identity = cursor?.userData?.renderPickIdentity;
      if (identity) return {
        hit: true, displayId: identity.displayId, layerKey: identity.layerKey,
        worldPosition: [hit.point.x, hit.point.y, hit.point.z], distance: hit.distance,
      };
    }
    return { hit: false };
  },
  markPickIdentity(object, identity) { object.userData.renderPickIdentity = identity; },
  disposeObject(object) { disposeBindingObject(object); },
  disposeRenderer(renderer) { renderer.dispose(); },
});
