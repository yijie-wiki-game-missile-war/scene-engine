import { finiteNumber, tuple } from '../internal.js';
import { fail } from '../runtime/health.js';

const EPSILON = 1e-12;

export function normalizeQuaternion(value, code = 'display-quaternion-invalid') {
  const [x, y, z, w] = tuple(value, 4, code);
  const length = Math.hypot(x, y, z, w);
  if (length <= EPSILON) fail(code);
  return Object.freeze([x / length, y / length, z / length, w / length]);
}

export function multiplyQuaternion(left, right, out = [0, 0, 0, 1]) {
  const [ax, ay, az, aw] = left;
  const [bx, by, bz, bw] = right;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function conjugateQuaternion(value, out = [0, 0, 0, 1]) {
  out[0] = -value[0];
  out[1] = -value[1];
  out[2] = -value[2];
  out[3] = value[3];
  return out;
}

export function rotateVector(rotation, vector, out = [0, 0, 0]) {
  const [x, y, z, w] = rotation;
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

export function invertWorldRotation(parentWorldRotation, desiredWorldRotation,
  out = [0, 0, 0, 1]) {
  const inverseParent = conjugateQuaternion(parentWorldRotation);
  return multiplyQuaternion(inverseParent, desiredWorldRotation, out);
}

export function quaternionFromForward(direction, axisMode = 'full', out = [0, 0, 0, 1]) {
  let [x, y, z] = direction;
  finiteNumber(x, 'display-look-direction-invalid');
  finiteNumber(y, 'display-look-direction-invalid');
  finiteNumber(z, 'display-look-direction-invalid');
  if (axisMode === 'y-axis') y = 0;
  const length = Math.hypot(x, y, z);
  if (length <= EPSILON) fail('display-look-direction-invalid');
  x /= length; y /= length; z /= length;

  // Rotate the canonical +Z forward axis onto the requested direction.
  if (z < -1 + EPSILON) {
    out[0] = 0; out[1] = 1; out[2] = 0; out[3] = 0;
    return out;
  }
  const crossX = -y;
  const crossY = x;
  const scalar = 1 + z;
  const qLength = Math.hypot(crossX, crossY, scalar);
  out[0] = crossX / qLength;
  out[1] = crossY / qLength;
  out[2] = 0;
  out[3] = scalar / qLength;
  return out;
}
