export const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function canonicalFloat32(value) {
  const rounded = Math.fround(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function composeMatrix4(
  position = [0, 0, 0],
  rotationXyzw = [0, 0, 0, 1],
  scale = [1, 1, 1],
) {
  const length = Math.hypot(...rotationXyzw);
  if (!Number.isFinite(length) || length === 0) throw new TypeError('rotation must be finite and nonzero');
  const [x, y, z, w] = rotationXyzw.map((value) => value / length);
  const [sx, sy, sz] = scale;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return Object.freeze([
    canonicalFloat32((1 - (yy + zz)) * sx),
    canonicalFloat32((xy + wz) * sx),
    canonicalFloat32((xz - wy) * sx),
    0,
    canonicalFloat32((xy - wz) * sy),
    canonicalFloat32((1 - (xx + zz)) * sy),
    canonicalFloat32((yz + wx) * sy),
    0,
    canonicalFloat32((xz + wy) * sz),
    canonicalFloat32((yz - wx) * sz),
    canonicalFloat32((1 - (xx + yy)) * sz),
    0,
    canonicalFloat32(position[0]),
    canonicalFloat32(position[1]),
    canonicalFloat32(position[2]),
    1,
  ]);
}

export function matrix4AlmostEqual(left, right, epsilon = 1e-6) {
  return left.length === 16 && right.length === 16
    && left.every((value, index) => Math.abs(value - right[index]) <= epsilon);
}

export function matrix4Bytes(matrix) {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 16; index += 1) view.setFloat32(index * 4, matrix[index], true);
  return bytes;
}
