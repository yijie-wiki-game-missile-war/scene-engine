import { fail } from '../runtime/health.js';

export const TEXTURE_MIN_FILTERS = Object.freeze([
  'nearest', 'linear', 'nearest-mipmap-nearest', 'nearest-mipmap-linear',
  'linear-mipmap-nearest', 'linear-mipmap-linear',
]);

export function needsProgramTextureSampling(descriptor) {
  return descriptor?.alphaEncoding === 'premultiplied'
    || descriptor?.alphaSampling === 'premultiplied';
}

export function validateTextureSampling(descriptor) {
  const invalid = () => fail('display-resource-texture-sampling-invalid');
  if (descriptor.filter !== undefined && !['linear', 'nearest'].includes(descriptor.filter)) invalid();
  if (descriptor.filter !== undefined && (descriptor.minFilter !== undefined || descriptor.magFilter !== undefined)) invalid();
  if (descriptor.minFilter !== undefined && !TEXTURE_MIN_FILTERS.includes(descriptor.minFilter)) invalid();
  if (descriptor.magFilter !== undefined && !['linear', 'nearest'].includes(descriptor.magFilter)) invalid();
  if (descriptor.mipmaps !== undefined && typeof descriptor.mipmaps !== 'boolean') invalid();
  if (descriptor.mipmaps === false && descriptor.minFilter?.includes('mipmap')) invalid();
  if (descriptor.alphaEncoding !== undefined && !['straight', 'premultiplied'].includes(descriptor.alphaEncoding)) invalid();
  if (descriptor.alphaSampling !== undefined && !['straight', 'premultiplied'].includes(descriptor.alphaSampling)) invalid();
  if (descriptor.alphaEncoding === 'premultiplied' && descriptor.alphaSampling === 'straight') invalid();
  if (needsProgramTextureSampling(descriptor) && descriptor.colorSpace !== 'srgb') invalid();
}

export function requireOrdinaryTextureSampling(descriptor) {
  if (needsProgramTextureSampling(descriptor)) fail('display-texture-program-sampling-required');
}

// Premultiplied storage is exposed to modules as straight linear RGBA. Limit
// these samplers to named texture2D calls so passing one through an arbitrary
// sampler helper cannot silently bypass the Engine's normalization.
export function validateProgramTextureSampling(program, name, descriptor) {
  if (!needsProgramTextureSampling(descriptor)) return;
  let source = program.source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  source = source.replace(new RegExp('\\btexture2D\\s*\\(\\s*t_' + name + '\\s*,', 'g'), '(');
  if (new RegExp('\\bt_' + name + '\\b').test(source)) fail('display-program-texture-sampling-invalid');
}
