import { exactKeys, finiteNumber } from '../internal.js';
import { fail } from '../runtime/health.js';

export const UPPER_FIELD_INVERSE_MARGIN = 0.01;
const PROFILE_ERROR = 'display-projection-profile-invalid';

export function normalizeProjectionProfile(value) {
  if (value === null || value === undefined) return null;
  const record = exactKeys(value, ['mode', 'startNdcY', 'strength'], [], PROFILE_ERROR);
  const startNdcY = finiteNumber(record.startNdcY, PROFILE_ERROR);
  const strength = finiteNumber(record.strength, PROFILE_ERROR);
  if (record.mode !== 'upper-field' || startNdcY <= -1 || startNdcY >= 1 || strength < 0
      || 1 - strength * (1 - startNdcY) < UPPER_FIELD_INVERSE_MARGIN) fail(PROFILE_ERROR);
  return Object.freeze({ mode: 'upper-field', startNdcY, strength });
}

export function projectUpperFieldY(y, profile) {
  if (!Number.isFinite(y)) fail('display-projection-domain');
  if (profile === null || y <= profile.startNdcY || profile.strength === 0) return y;
  const delta = y - profile.startNdcY;
  // Dividing before multiplying keeps finite, very large inputs finite.
  return profile.startNdcY + 1 / (1 / delta + profile.strength);
}

export function unprojectUpperFieldY(y, profile) {
  if (!Number.isFinite(y)) fail('display-projection-domain');
  if (profile === null || y <= profile.startNdcY || profile.strength === 0) return y;
  const delta = y - profile.startNdcY;
  const denominator = 1 - profile.strength * delta;
  if (denominator <= 0) fail('display-projection-domain');
  const result = profile.startNdcY + delta / denominator;
  if (!Number.isFinite(result)) fail('display-projection-domain');
  return result;
}

export function deriveUpperFieldProjection(value) {
  const record = exactKeys(value, ['pitchDegrees', 'fovYDegrees', 'startNdcY', 'targetNdcY'],
    [], PROFILE_ERROR);
  for (const entry of Object.values(record)) finiteNumber(entry, PROFILE_ERROR);
  const { pitchDegrees, fovYDegrees, startNdcY, targetNdcY } = record;
  if (pitchDegrees <= 0 || pitchDegrees >= 90 || fovYDegrees <= 0 || fovYDegrees >= 180)
    fail(PROFILE_ERROR);
  const horizon = Math.tan(pitchDegrees * Math.PI / 180) / Math.tan(fovYDegrees * Math.PI / 360);
  if (!(startNdcY < targetNdcY && targetNdcY < horizon)) fail(PROFILE_ERROR);
  return normalizeProjectionProfile({ mode: 'upper-field', startNdcY,
    strength: 1 / (targetNdcY - startNdcY) - 1 / (horizon - startNdcY) });
}
