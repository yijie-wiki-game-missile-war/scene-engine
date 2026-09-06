import * as THREE from 'three';
import { unprojectUpperFieldY } from '@scene-engine/display';
import { fail } from './errors.js';

export const UPPER_FIELD_FORWARD_GLSL = `
float se_projectUpperFieldY(float y, float s, float k) {
  if (y <= s || k == 0.0) return y;
  float d = y - s;
  return s + d / (1.0 + k * d);
}`;

// Uniform CSS sampling, including at output DPR > 1. F' <= 1: a source texel
// spans at most one CSS pixel after resampling. This is an explicit resolution
// contract, not a silent attempt to allocate a smaller buffer on failure.
export const UPPER_FIELD_MAX_SOURCE_PIXELS = 16 * 1024 * 1024;
export function upperFieldSourceLayout(width, height, profile, maxTextureSize = 8192) {
  const top = unprojectUpperFieldY(1, profile);
  const span = top + 1;
  const sourceWidth = Math.ceil(width);
  const sourceHeight = Math.ceil(height * span / 2);
  if (!Number.isFinite(span) || sourceWidth < 1 || sourceHeight < 1
      || sourceWidth > maxTextureSize || sourceHeight > maxTextureSize
      || sourceWidth * sourceHeight > UPPER_FIELD_MAX_SOURCE_PIXELS)
    fail('three-upper-field-budget-exceeded');
  return Object.freeze({ width: sourceWidth, height: sourceHeight, top, span,
    estimatedColorDepthBytes: sourceWidth * sourceHeight * 12,
    maximumSourcePixels: UPPER_FIELD_MAX_SOURCE_PIXELS,
    sourcePixelsPerCssPixel: 1, maximumTexelDisplacementCssPixels: Math.SQRT1_2 });
}

// Expand the *same* camera's linear frustum to [-1,G(1)] in original NDC.
// Its clip depth and w remain untouched; native clipping/rasterization therefore
// handles giant triangles and near/eye crossings exactly before the terminal.
export function expandUpperFieldCamera(camera, layout) {
  const original = camera.projectionMatrix.clone();
  const elements = camera.projectionMatrix.elements;
  const scale = 2 / layout.span;
  const offset = (1 - layout.top) / layout.span;
  for (let column = 0; column < 4; column += 1) {
    const row = column * 4;
    elements[row + 1] = scale * original.elements[row + 1] + offset * original.elements[row + 3];
  }
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  return () => {
    camera.projectionMatrix.copy(original);
    camera.projectionMatrixInverse.copy(original).invert();
  };
}

export class UpperFieldTerminal {
  constructor(scene) {
    this.scene = scene;
    this.target = null;
    this.layout = null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0, 3,-1,0, -1,3,0], 3));
    this.material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: true,
      uniforms: { source: { value: null }, startNdcY: { value: 0 }, strength: { value: 0 },
        sourceSpan: { value: 2 } },
      vertexShader: 'varying vec2 terminalUv; void main() { terminalUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }',
      fragmentShader: `
        uniform sampler2D source;
        uniform float startNdcY;
        uniform float strength;
        uniform float sourceSpan;
        varying vec2 terminalUv;
        void main() {
          float q = terminalUv.y * 2.0 - 1.0;
          float d = max(0.0, q - startNdcY);
          // The whole viewport was validated with a >= .01 inverse margin.
          float y = q <= startNdcY ? q : startNdcY + d / (1.0 - strength * d);
          gl_FragColor = texture2D(source, vec2(terminalUv.x, (y + 1.0) / sourceSpan));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.object = new THREE.Mesh(geometry, this.material);
    this.object.name = 'SceneEngineUpperFieldTerminal';
    this.object.frustumCulled = false;
    this.object.visible = false;
    scene.add(this.object);
  }

  prepare(renderer, width, height, profile) {
    if (typeof renderer.setRenderTarget !== 'function'
        || typeof renderer.getRenderTarget !== 'function'
        || renderer.extensions?.has?.('EXT_color_buffer_float') !== true)
      fail('three-upper-field-device-unsupported');
    const layout = upperFieldSourceLayout(width, height, profile, renderer.capabilities.maxTextureSize);
    if (this.target === null || this.target.width !== layout.width || this.target.height !== layout.height) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(layout.width, layout.height, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: true, stencilBuffer: false, generateMipmaps: false,
        colorSpace: THREE.LinearSRGBColorSpace,
      });
    }
    this.layout = layout;
    this.material.uniforms.source.value = this.target.texture;
    this.material.uniforms.startNdcY.value = profile.startNdcY;
    this.material.uniforms.strength.value = profile.strength;
    this.material.uniforms.sourceSpan.value = layout.span;
    return layout;
  }

  render(renderer, camera, roots, renderWorld) {
    const originalTarget = renderer.getRenderTarget();
    const originalBackground = this.scene.background;
    const originalAutoClear = renderer.autoClear;
    const originalMask = camera.layers.mask;
    const visibility = roots.map((root) => root.visible);
    const shadowMap = renderer.shadowMap;
    const shadowAutoUpdate = shadowMap?.autoUpdate;
    const shadowNeedsUpdate = shadowMap?.needsUpdate;
    const restoreCamera = expandUpperFieldCamera(camera, this.layout);
    try {
      renderer.setRenderTarget(this.target);
      renderWorld(this.layout);
      restoreCamera();
      // This final pass uses the same Scene and camera, and cannot touch shadows
      // or step any frame/time sample a second time.
      roots.forEach((root) => { root.visible = false; });
      this.scene.background = null;
      this.object.visible = true;
      camera.layers.mask = 1;
      if (shadowMap) { shadowMap.autoUpdate = false; shadowMap.needsUpdate = false; }
      renderer.autoClear = true;
      renderer.setRenderTarget(originalTarget);
      renderer.render(this.scene, camera);
    } finally {
      restoreCamera();
      this.object.visible = false;
      roots.forEach((root, index) => { root.visible = visibility[index]; });
      this.scene.background = originalBackground;
      renderer.autoClear = originalAutoClear;
      camera.layers.mask = originalMask;
      if (shadowMap) { shadowMap.autoUpdate = shadowAutoUpdate; shadowMap.needsUpdate = shadowNeedsUpdate; }
      renderer.setRenderTarget(originalTarget);
    }
  }

  dispose() {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.material.dispose();
    this.target?.dispose();
    this.target = null;
    this.layout = null;
  }
}
