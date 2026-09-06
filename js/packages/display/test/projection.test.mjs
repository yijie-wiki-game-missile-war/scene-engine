import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProjectionProfile, deriveUpperFieldProjection,
  projectUpperFieldY as F, unprojectUpperFieldY as G } from '../src/index.js';
const profile = deriveUpperFieldProjection({ pitchDegrees: 35, fovYDegrees: 34,
  startNdcY: 0.1, targetNdcY: 0.79 });
test('upper-field target horizon, continuity, monotonicity and full viewport inverse', () => {
  assert.ok(Math.abs(profile.strength - 0.9927118263504608) < 1e-12);
  const horizon = Math.tan(35 * Math.PI / 180) / Math.tan(17 * Math.PI / 180);
  assert.ok(Math.abs(F(horizon, profile) - 0.79) < 1e-12);
  let previous = -Infinity;
  for (let index = 0; index <= 4000; index += 1) {
    const q = -1 + index / 2000;
    const y = G(q, profile);
    assert.ok(y > previous);
    assert.ok(Math.abs(F(y, profile) - q) < 1e-12);
    previous = y;
  }
  const s = profile.startNdcY, epsilon = 1e-7;
  assert.equal(F(s, profile), s);
  assert.ok(Math.abs((F(s + epsilon, profile) - F(s, profile)) / epsilon - 1) < 1e-6);
  assert.equal(F(-2, profile), -2);
  assert.equal(F(100, normalizeProjectionProfile({ ...profile, strength: 0 })), 100);
});
test('projection rejects unsafe domain and unknown or malformed configurations', () => {
  for (const value of [{ ...profile, strength: NaN }, { ...profile, startNdcY: 1 },
    { ...profile, strength: -1 }, { ...profile, strength: 1.11 },
    { ...profile, extra: true }, { mode: 'target-horizon', targetNdcY: 0.79 }]) {
    assert.throws(() => normalizeProjectionProfile(value), { code: 'display-projection-profile-invalid' });
  }
  for (const y of [NaN, Infinity, profile.startNdcY + 1 / profile.strength, 100]) {
    assert.throws(() => G(y, profile), { code: 'display-projection-domain' });
  }
  assert.equal(normalizeProjectionProfile(null), null);
  assert.throws(() => deriveUpperFieldProjection({ pitchDegrees: 0, fovYDegrees: 34,
    startNdcY: 0.1, targetNdcY: 0.79 }), { code: 'display-projection-profile-invalid' });
});
