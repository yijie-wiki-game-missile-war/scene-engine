import { fail } from '../runtime/health.js';
import { copyMatrix4, inverseTransformDirectionMatrix4, matrix4Determinant3x3,
  multiplyMatrix4 } from './matrix4.js';

export const IDENTITY_TRANSFORM = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function writeNormalizedTransform(value, matrix, code) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 16) fail(code);
  for (let index = 0; index < 16; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) fail(code);
    const normalized = Math.fround(entry);
    if (!Number.isFinite(normalized)) fail(code);
    matrix[index] = Object.is(normalized, -0) ? 0 : normalized;
  }
  if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) fail(code);
  const determinant = matrix4Determinant3x3(matrix);
  if (!Number.isFinite(determinant) || determinant <= 0) fail(code);
  return matrix;
}

export function normalizeTransform(value,
  code = 'display-transform-invalid') {
  return Object.freeze(writeNormalizedTransform(value, new Array(16), code));
}

export function createLocalTransform(value,
  code = 'display-transform-invalid') {
  return writeNormalizedTransform(value, new Float32Array(16), code);
}

export function createMutableWorldTransform() {
  return new Float64Array(IDENTITY_TRANSFORM);
}

export function composeWorldTransform(parentWorld, local, out = createMutableWorldTransform()) {
  const world = parentWorld === null
    ? copyMatrix4(local, out) : multiplyMatrix4(parentWorld, local, out);
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(world[index])) fail('display-transform-world-nonfinite');
  }
  return world;
}

export function copyWorldTransform(source, out) {
  return copyMatrix4(source, out);
}

export function snapshotWorldTransform(world) {
  return Object.freeze(Array.from(world));
}

export function writeWorldTransform(world, out) {
  const numericArray = Array.isArray(out)
    || (ArrayBuffer.isView(out) && !(out instanceof DataView));
  if (!numericArray || !Number.isSafeInteger(out.length) || out.length < 16
      || Object.isFrozen(out) || typeof out[0] === 'bigint') {
    fail('display-transform-output-invalid');
  }
  return copyMatrix4(world, out);
}

export function isIdentityTransform(transform) {
  return transform.every((entry, index) => entry === IDENTITY_TRANSFORM[index]);
}

export function localDirectionForWorldFacing(parentWorld, direction, axisMode) {
  const desired = axisMode === 'y-axis' ? [direction[0], 0, direction[2]] : direction;
  return parentWorld === null
    ? desired : inverseTransformDirectionMatrix4(parentWorld, desired);
}
