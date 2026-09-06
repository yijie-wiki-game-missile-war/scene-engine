import * as THREE from 'three';
import { fail } from './errors.js';

const MAX_NORMALIZED_PIXELS = 4_194_304;
export function usesPremultipliedSampling(descriptor) {
  return descriptor.alphaEncoding === 'premultiplied' || descriptor.alphaSampling === 'premultiplied';
}
const toLinear = (v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
const toSrgb = (v) => v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055;

// Normalize before sRGB GPU decode/filtering: stored RGB is sRGB-encoded
// (linear straight RGB * alpha). Sampling and mipmaps therefore interpolate
// associated linear color, independent of the file's alpha convention.
export function associateColorPixels(bytes, width, height, sourceEncoding = 'straight') {
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray)
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width * height > MAX_NORMALIZED_PIXELS || bytes.length !== width * height * 4
      || !['straight', 'premultiplied'].includes(sourceEncoding)) fail('three-texture-alpha-normalization-invalid');
  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) {
      const encoded = alpha === 0 ? 0 : Math.min(1, bytes[i + c] / 255
        / (sourceEncoding === 'premultiplied' ? alpha : 1));
      output[i + c] = Math.round(toSrgb(toLinear(encoded) * alpha) * 255);
    }
    output[i + 3] = bytes[i + 3];
  }
  return output;
}

export function normalizedProgramTexture(image, descriptor) {
  if (image.width * image.height > MAX_NORMALIZED_PIXELS) fail('three-texture-alpha-normalization-budget');
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(image.width, image.height)
    : globalThis.document?.createElement?.('canvas');
  if (!canvas) fail('three-texture-alpha-normalization-unavailable');
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!context) fail('three-texture-alpha-normalization-unavailable');
  context.globalCompositeOperation = 'copy'; context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const data = associateColorPixels(pixels, image.width, image.height, descriptor.alphaEncoding ?? 'straight');
  const texture = new THREE.DataTexture(data, image.width, image.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.userData.sceneEngineAlphaSampling = 'premultiplied-linear';
  texture.flipY = false;
  return texture;
}

export function programTextureSampling(program, textures) {
  // Match the validator's token view, including comments between call tokens.
  let source = program.source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const helpers = [];
  for (const name of Object.keys(program.textureSlots)) {
    if (textures[name]?.userData.sceneEngineAlphaSampling !== 'premultiplied-linear') continue;
    source = source.replace(new RegExp('\\btexture2D\\s*\\(\\s*t_' + name + '\\s*,', 'g'), 'se_sample_' + name + '(');
    const decode = 'return vec4(s.a>0.000001 ? s.rgb/s.a : vec3(0.0),s.a);';
    helpers.push('vec4 se_sample_' + name + '(vec2 uv){vec4 s=texture2D(t_' + name + ',uv);' + decode + '}',
      'vec4 se_sample_' + name + '(vec2 uv,float bias){vec4 s=texture2D(t_' + name + ',uv,bias);' + decode + '}');
  }
  return { source, helpers: helpers.join('\n') };
}
