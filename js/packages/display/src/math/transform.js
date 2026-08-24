import { tuple } from '../internal.js';
import { fail } from '../runtime/health.js';
import { composeMatrix4, copyMatrix4, inverseTransformDirectionMatrix4,
  multiplyMatrix4 } from './matrix4.js';
import { multiplyQuaternion, normalizeQuaternion, rotateVector } from './quaternion.js';

export const IDENTITY_TRANSFORM = Object.freeze({
  position: Object.freeze([0, 0, 0]),
  rotationXyzw: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
});

export function normalizeTransform(value = IDENTITY_TRANSFORM,
  code = 'display-transform-invalid') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'position' || keys[1] !== 'rotationXyzw'
      || keys[2] !== 'scale') fail(code);
  const position = Object.freeze(tuple(value.position, 3, code));
  const rotationXyzw = normalizeQuaternion(value.rotationXyzw, code);
  const scale = tuple(value.scale, 3, code);
  if (scale.some((entry) => entry <= 0)) fail(code);
  return Object.freeze({ position, rotationXyzw, scale: Object.freeze(scale) });
}

export function createMutableWorldTransform() {
  const result = {
    position: [0, 0, 0],
    rotationXyzw: [0, 0, 0, 1],
    scale: [1, 1, 1],
    matrix: new Float64Array(16),
    localMatrixScratch: new Float64Array(16),
  };
  composeMatrix4(result, result.matrix);
  return result;
}

export function copyTransform(source, out) {
  for (let index = 0; index < 3; index += 1) {
    out.position[index] = source.position[index];
    out.scale[index] = source.scale[index];
  }
  for (let index = 0; index < 4; index += 1) {
    out.rotationXyzw[index] = source.rotationXyzw[index];
  }
  if (out.matrix) composeMatrix4(out, out.matrix);
  return out;
}

export function composeWorldTransform(parentWorld, local, out = createMutableWorldTransform()) {
  if (parentWorld === null) return copyTransform(local, out);
  const scaled = [
    local.position[0] * parentWorld.scale[0],
    local.position[1] * parentWorld.scale[1],
    local.position[2] * parentWorld.scale[2],
  ];
  const rotated = rotateVector(parentWorld.rotationXyzw, scaled);
  for (let index = 0; index < 3; index += 1) {
    out.position[index] = parentWorld.position[index] + rotated[index];
    out.scale[index] = parentWorld.scale[index] * local.scale[index];
  }
  multiplyQuaternion(parentWorld.rotationXyzw, local.rotationXyzw, out.rotationXyzw);
  const parentMatrix = parentWorld.matrix ?? composeMatrix4(parentWorld);
  const localMatrix = composeMatrix4(local, out.localMatrixScratch ?? new Float64Array(16));
  multiplyMatrix4(parentMatrix, localMatrix, out.matrix);
  out.position[0] = out.matrix[12];
  out.position[1] = out.matrix[13];
  out.position[2] = out.matrix[14];
  return out;
}

export function copyWorldTransform(source, out) {
  for (let index = 0; index < 3; index += 1) {
    out.position[index] = source.position[index];
    out.scale[index] = source.scale[index];
  }
  for (let index = 0; index < 4; index += 1) {
    out.rotationXyzw[index] = source.rotationXyzw[index];
  }
  copyMatrix4(source.matrix, out.matrix);
  return out;
}

export function snapshotWorldTransform(world) {
  return Object.freeze({
    position: Object.freeze([...world.position]),
    rotationXyzw: Object.freeze([...world.rotationXyzw]),
    scale: Object.freeze([...world.scale]),
    matrix: Object.freeze(Array.from(world.matrix)),
  });
}

export function writeWorldTransform(world, out) {
  if (!out?.position || !out?.rotationXyzw || !out?.scale
      || out.position.length < 3 || out.rotationXyzw.length < 4 || out.scale.length < 3) {
    fail('display-transform-output-invalid');
  }
  for (let index = 0; index < 3; index += 1) {
    out.position[index] = world.position[index];
    out.scale[index] = world.scale[index];
  }
  for (let index = 0; index < 4; index += 1) out.rotationXyzw[index] = world.rotationXyzw[index];
  if (out.matrix) {
    if (out.matrix.length < 16) fail('display-transform-output-invalid');
    for (let index = 0; index < 16; index += 1) out.matrix[index] = world.matrix[index];
  }
  return out;
}

export function isIdentityTransform(transform) {
  return transform.position.every((entry) => entry === 0)
    && transform.rotationXyzw[0] === 0
    && transform.rotationXyzw[1] === 0
    && transform.rotationXyzw[2] === 0
    && Math.abs(transform.rotationXyzw[3]) === 1
    && transform.scale.every((entry) => entry === 1);
}

export function localDirectionForWorldFacing(parentWorld, direction, axisMode) {
  const desired = axisMode === 'y-axis' ? [direction[0], 0, direction[2]] : direction;
  return parentWorld === null
    ? desired : inverseTransformDirectionMatrix4(parentWorld.matrix, desired);
}
