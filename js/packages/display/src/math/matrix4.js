export function composeMatrix4(transform, out = new Float64Array(16)) {
  const [x, y, z, w] = transform.rotationXyzw;
  const [sx, sy, sz] = transform.scale;
  const [px, py, pz] = transform.position;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = px;
  out[13] = py;
  out[14] = pz;
  out[15] = 1;
  return out;
}

export function copyMatrix4(source, out = new Float64Array(16)) {
  for (let index = 0; index < 16; index += 1) out[index] = source[index];
  return out;
}

export function multiplyMatrix4(left, right, out = new Float64Array(16)) {
  const values = out === left || out === right ? new Float64Array(16) : out;
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      values[column * 4 + row] = value;
    }
  }
  return values === out ? out : copyMatrix4(values, out);
}

export function inverseTransformDirectionMatrix4(matrix, direction, out = [0, 0, 0]) {
  const a00 = matrix[0]; const a01 = matrix[4]; const a02 = matrix[8];
  const a10 = matrix[1]; const a11 = matrix[5]; const a12 = matrix[9];
  const a20 = matrix[2]; const a21 = matrix[6]; const a22 = matrix[10];
  const inverse00 = a11 * a22 - a12 * a21;
  const inverse01 = a02 * a21 - a01 * a22;
  const inverse02 = a01 * a12 - a02 * a11;
  const inverse10 = a12 * a20 - a10 * a22;
  const inverse11 = a00 * a22 - a02 * a20;
  const inverse12 = a02 * a10 - a00 * a12;
  const inverse20 = a10 * a21 - a11 * a20;
  const inverse21 = a01 * a20 - a00 * a21;
  const inverse22 = a00 * a11 - a01 * a10;
  const determinant = a00 * inverse00 + a01 * inverse10 + a02 * inverse20;
  if (determinant === 0 || !Number.isFinite(determinant)) fail('display-transform-singular');
  const reciprocal = 1 / determinant;
  const [x, y, z] = direction;
  out[0] = (inverse00 * x + inverse01 * y + inverse02 * z) * reciprocal;
  out[1] = (inverse10 * x + inverse11 * y + inverse12 * z) * reciprocal;
  out[2] = (inverse20 * x + inverse21 * y + inverse22 * z) * reciprocal;
  return out;
}
import { fail } from '../runtime/health.js';
