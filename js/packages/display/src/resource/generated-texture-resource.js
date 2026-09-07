import { cloneAndFreeze, exactKeys, nonemptyString, safeInteger } from '../internal.js';
import { fail } from '../runtime/health.js';

export const GENERATED_TEXTURE_RESOURCE_SCHEMA = 'scene-engine-generated-texture-resource@1';
export const GENERATED_TEXTURE_LIMITS = Object.freeze({
  maximumDimension: 2048, maximumTextureBytes: 8 * 1024 * 1024,
  maximumTotalTextureBytes: 56 * 1024 * 1024, maximumResources: 256,
  maximumRegions: 64, maximumUploadBytesPerFrame: 8 * 1024 * 1024,
});
const ERROR = 'display-generated-texture-invalid';
export function generatedTextureByteLength(descriptor) {
  return descriptor.width * descriptor.height * 4 * (descriptor.format === 'rgba32float' ? 4 : 1);
}
export function normalizeGeneratedTextureDescriptor(value) {
  const r = exactKeys(value, ['id', 'kind', 'revision', 'width', 'height', 'format', 'usage', 'initialValue', 'budget'],
    ['schema', 'filter', 'wrap'], ERROR);
  nonemptyString(r.id, ERROR);
  if (r.id.length > 256 || r.kind !== 'generated-texture' || r.usage !== 'data'
      || !['rgba8unorm', 'rgba32float'].includes(r.format)
      || (r.schema !== undefined && r.schema !== GENERATED_TEXTURE_RESOURCE_SCHEMA)) fail(ERROR);
  safeInteger(r.revision, ERROR, { minimum: 1 });
  for (const size of [r.width, r.height]) safeInteger(size, ERROR, { minimum: 1, maximum: GENERATED_TEXTURE_LIMITS.maximumDimension });
  if (generatedTextureByteLength(r) > GENERATED_TEXTURE_LIMITS.maximumTextureBytes) fail('display-generated-texture-budget-exceeded');
  if (!Array.isArray(r.initialValue) || r.initialValue.length !== 4
      || r.initialValue.some(v => !Number.isFinite(v) || (r.format === 'rgba8unorm' && (!Number.isInteger(v) || v < 0 || v > 255))
        || (r.format === 'rgba32float' && !Number.isFinite(Math.fround(v))))) fail(ERROR);
  const budget = exactKeys(r.budget, ['maxUpdateBytes', 'maxRegions'], [], ERROR);
  safeInteger(budget.maxUpdateBytes, ERROR, { minimum: 1, maximum: GENERATED_TEXTURE_LIMITS.maximumTextureBytes });
  safeInteger(budget.maxRegions, ERROR, { minimum: 1, maximum: GENERATED_TEXTURE_LIMITS.maximumRegions });
  if (!['nearest', 'linear'].includes(r.filter ?? 'nearest') || !['clamp', 'repeat'].includes(r.wrap ?? 'clamp')) fail(ERROR);
  return cloneAndFreeze({ ...r, schema: GENERATED_TEXTURE_RESOURCE_SCHEMA,
    filter: r.filter ?? 'nearest', wrap: r.wrap ?? 'clamp' }, ERROR);
}
