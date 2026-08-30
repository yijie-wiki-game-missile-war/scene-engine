import { exactKeys, finiteNumber, tuple } from '../internal.js';
import { fail } from '../runtime/health.js';
import { composeMatrix4FromQuaternion } from './matrix4.js';
import { IDENTITY_TRANSFORM, normalizeTransform } from './transform.js';

const ERROR = 'display-transform-invalid';
const SINGULAR_ERROR = 'display-transform-singular';
const ZERO3 = Object.freeze([0, 0, 0]);
const ONE3 = Object.freeze([1, 1, 1]);
const IDENTITY_QUATERNION = Object.freeze([0, 0, 0, 1]);

function normalizedBasis(matrix, code = ERROR) {
  const values = [
    matrix[0], matrix[4], matrix[8],
    matrix[1], matrix[5], matrix[9],
    matrix[2], matrix[6], matrix[10],
  ];
  const maximum = Math.max(...values.map(Math.abs));
  if (!Number.isFinite(maximum) || maximum === 0) fail(code);
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = values.map(
    (entry) => entry / maximum,
  );
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
  if (!Number.isFinite(determinant) || determinant <= 0) fail(code);
  return {
    maximum,
    determinant,
    inverse: [
      inverse00, inverse01, inverse02,
      inverse10, inverse11, inverse12,
      inverse20, inverse21, inverse22,
    ],
  };
}

function matrixInput(value, code = ERROR) {
  const numericArray = Array.isArray(value)
    || (ArrayBuffer.isView(value) && !(value instanceof DataView));
  if (!numericArray || value.length !== 16) fail(code);
  for (let index = 0; index < 16; index += 1) {
    if (typeof value[index] !== 'number' || !Number.isFinite(value[index])) fail(code);
  }
  if (value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1) fail(code);
  normalizedBasis(value, code);
  return value;
}

function positiveVec3(value, code = ERROR) {
  const result = tuple(value, 3, code);
  if (result.some((entry) => entry <= 0)) fail(code);
  return result;
}

function normalizedVector(value, length, code = ERROR) {
  const vector = tuple(value, length, code);
  const maximum = Math.max(...vector.map(Math.abs));
  if (maximum === 0) fail(code);
  const scaled = vector.map((entry) => entry / maximum);
  const magnitude = Math.sqrt(scaled.reduce((sum, entry) => sum + entry * entry, 0));
  return scaled.map((entry) => entry / magnitude);
}

function canonicalMatrix(value) {
  return normalizeTransform(value, ERROR);
}

function frozenVec3(values, code = ERROR) {
  if (values.some((entry) => !Number.isFinite(entry))) fail(code);
  return Object.freeze(values.map((entry) => (Object.is(entry, -0) ? 0 : entry)));
}

function basisProduct(left, right, translation) {
  const result = new Float64Array(16);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      let value = 0;
      for (let index = 0; index < 3; index += 1) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      result[column * 4 + row] = value;
    }
  }
  result[12] = translation[0];
  result[13] = translation[1];
  result[14] = translation[2];
  result[15] = 1;
  return canonicalMatrix(result);
}

function matrixProduct(left, right) {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      if (!Number.isFinite(value)) fail(ERROR);
      result[column * 4 + row] = value;
    }
  }
  return result;
}

function axisRotation(axis, radians) {
  const [x, y, z] = normalizedVector(axis, 3);
  const angle = finiteNumber(radians, ERROR);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const remainder = 1 - cosine;
  return [
    remainder * x * x + cosine,
    remainder * x * y + sine * z,
    remainder * x * z - sine * y,
    0,
    remainder * x * y - sine * z,
    remainder * y * y + cosine,
    remainder * y * z + sine * x,
    0,
    remainder * x * z + sine * y,
    remainder * y * z - sine * x,
    remainder * z * z + cosine,
    0,
    0, 0, 0, 1,
  ];
}

function inverseBasisVector(matrix, vector) {
  const { maximum, determinant, inverse } = normalizedBasis(matrix, SINGULAR_ERROR);
  const reciprocalScale = 1 / maximum;
  const [x, y, z] = vector;
  return frozenVec3([
    ((inverse[0] * x + inverse[1] * y + inverse[2] * z) / determinant)
      * reciprocalScale,
    ((inverse[3] * x + inverse[4] * y + inverse[5] * z) / determinant)
      * reciprocalScale,
    ((inverse[6] * x + inverse[7] * y + inverse[8] * z) / determinant)
      * reciprocalScale,
  ], SINGULAR_ERROR);
}

function identity() {
  return canonicalMatrix(IDENTITY_TRANSFORM);
}

function fromTRS(value = {}) {
  const record = exactKeys(
    value,
    [],
    ['position', 'rotationXyzw', 'scale'],
    ERROR,
  );
  const position = Object.hasOwn(record, 'position') ? tuple(record.position, 3, ERROR) : ZERO3;
  const rotation = Object.hasOwn(record, 'rotationXyzw')
    ? normalizedVector(record.rotationXyzw, 4) : IDENTITY_QUATERNION;
  const scale = Object.hasOwn(record, 'scale') ? positiveVec3(record.scale) : ONE3;
  return canonicalMatrix(composeMatrix4FromQuaternion(rotation, scale, position));
}

function compose(parent, local) {
  const checkedParent = matrixInput(parent);
  const checkedLocal = matrixInput(local);
  return canonicalMatrix(matrixProduct(checkedParent, checkedLocal));
}

function withTranslation(matrix, position) {
  const source = matrixInput(matrix);
  const [x, y, z] = tuple(position, 3, ERROR);
  const result = Array.from(source);
  result[12] = x;
  result[13] = y;
  result[14] = z;
  return canonicalMatrix(result);
}

function withScale(matrix, scale) {
  const source = matrixInput(matrix);
  const targets = positiveVec3(scale);
  const result = Array.from(source);
  for (let column = 0; column < 3; column += 1) {
    const offset = column * 4;
    const maximum = Math.max(
      Math.abs(source[offset]),
      Math.abs(source[offset + 1]),
      Math.abs(source[offset + 2]),
    );
    if (!Number.isFinite(maximum) || maximum === 0) fail(ERROR);
    const length = Math.hypot(
      source[offset] / maximum,
      source[offset + 1] / maximum,
      source[offset + 2] / maximum,
    );
    for (let row = 0; row < 3; row += 1) {
      result[offset + row] = (source[offset + row] / maximum / length) * targets[column];
    }
  }
  return canonicalMatrix(result);
}

function translatedSelf(matrix, translation) {
  const source = matrixInput(matrix);
  const [x, y, z] = tuple(translation, 3, ERROR);
  const result = Array.from(source);
  result[12] = source[12] + source[0] * x + source[4] * y + source[8] * z;
  result[13] = source[13] + source[1] * x + source[5] * y + source[9] * z;
  result[14] = source[14] + source[2] * x + source[6] * y + source[10] * z;
  return canonicalMatrix(result);
}

function translatedParent(matrix, translation) {
  const source = matrixInput(matrix);
  const [x, y, z] = tuple(translation, 3, ERROR);
  const result = Array.from(source);
  result[12] = source[12] + x;
  result[13] = source[13] + y;
  result[14] = source[14] + z;
  return canonicalMatrix(result);
}

function rotatedSelf(matrix, axis, radians) {
  const source = matrixInput(matrix);
  const rotation = axisRotation(axis, radians);
  return basisProduct(source, rotation, source.slice(12, 15));
}

function rotatedParent(matrix, axis, radians) {
  const source = matrixInput(matrix);
  const rotation = axisRotation(axis, radians);
  return basisProduct(rotation, source, source.slice(12, 15));
}

function scaledSelf(matrix, scale) {
  const source = matrixInput(matrix);
  const factors = positiveVec3(scale);
  const result = Array.from(source);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) result[column * 4 + row] *= factors[column];
  }
  return canonicalMatrix(result);
}

function scaledParent(matrix, scale) {
  const source = matrixInput(matrix);
  const factors = positiveVec3(scale);
  const result = Array.from(source);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) result[column * 4 + row] *= factors[row];
  }
  return canonicalMatrix(result);
}

function transformPoint(matrix, point) {
  const source = matrixInput(matrix);
  const [x, y, z] = tuple(point, 3, ERROR);
  return frozenVec3([
    source[0] * x + source[4] * y + source[8] * z + source[12],
    source[1] * x + source[5] * y + source[9] * z + source[13],
    source[2] * x + source[6] * y + source[10] * z + source[14],
  ]);
}

function inverseTransformPoint(matrix, point) {
  const source = matrixInput(matrix);
  const [x, y, z] = tuple(point, 3, ERROR);
  return inverseBasisVector(source, [x - source[12], y - source[13], z - source[14]]);
}

function transformVector(matrix, vector) {
  const source = matrixInput(matrix);
  const [x, y, z] = tuple(vector, 3, ERROR);
  return frozenVec3([
    source[0] * x + source[4] * y + source[8] * z,
    source[1] * x + source[5] * y + source[9] * z,
    source[2] * x + source[6] * y + source[10] * z,
  ]);
}

function inverseTransformVector(matrix, vector) {
  const source = matrixInput(matrix);
  return inverseBasisVector(source, tuple(vector, 3, ERROR));
}

export const DisplayTransform = Object.freeze({
  identity,
  fromTRS,
  compose,
  withTranslation,
  withScale,
  translatedSelf,
  translatedParent,
  rotatedSelf,
  rotatedParent,
  scaledSelf,
  scaledParent,
  transformPoint,
  inverseTransformPoint,
  transformVector,
  inverseTransformVector,
});
