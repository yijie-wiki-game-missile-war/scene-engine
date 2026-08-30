import assert from 'node:assert/strict';
import test from 'node:test';

import { DisplayTransform } from '../src/index.js';

function assertApprox(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]) <= tolerance,
      `index ${index}: expected ${expected[index]}, received ${value}`,
    );
  });
}

function column(matrix, index) {
  const offset = index * 4;
  return matrix.slice(offset, offset + 3);
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

test('DisplayTransform is one frozen pure facade with frozen canonical float32 construction', () => {
  assert.equal(Object.isFrozen(DisplayTransform), true);
  assert.deepEqual(Object.keys(DisplayTransform), [
    'identity',
    'fromTRS',
    'compose',
    'withTranslation',
    'withScale',
    'translatedSelf',
    'translatedParent',
    'rotatedSelf',
    'rotatedParent',
    'scaledSelf',
    'scaledParent',
    'transformPoint',
    'inverseTransformPoint',
    'transformVector',
    'inverseTransformVector',
  ]);

  const identity = DisplayTransform.identity();
  assert.equal(Object.isFrozen(identity), true);
  assert.notStrictEqual(DisplayTransform.identity(), identity);
  assert.deepEqual(identity, [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);

  const transform = DisplayTransform.fromTRS({
    position: [1.1, -0, 3.3],
    rotationXyzw: [0, 0, 2, 2],
    scale: [2, 3, 4],
  });
  assert.equal(Object.isFrozen(transform), true);
  assert.equal(transform[12], Math.fround(1.1));
  assert.equal(Object.is(transform[13], -0), false);
  assertApprox(DisplayTransform.transformVector(transform, [1, 0, 0]), [0, 2, 0]);
  assert.deepEqual(DisplayTransform.fromTRS({}), identity);
  assert.deepEqual(DisplayTransform.fromTRS(), identity);
  assert.doesNotThrow(() => DisplayTransform.fromTRS({
    rotationXyzw: [0, 0, 1e-300, 1e-300],
  }));
});

test('fromTRS is closed and rejects malformed quaternion, scale, and tuple inputs', () => {
  for (const value of [
    null,
    [],
    { extra: true },
    { position: [0, 0] },
    { position: [0, 0, Number.NaN] },
    { rotationXyzw: [0, 0, 0, 0] },
    { rotationXyzw: [0, 0, 1] },
    { scale: [1, 0, 1] },
    { scale: [1, -1, 1] },
    { scale: [1, 1, Number.POSITIVE_INFINITY] },
  ]) {
    assert.throws(() => DisplayTransform.fromTRS(value), { code: 'display-transform-invalid' });
  }
});

test('compose multiplies parent by local once and returns an independent float32 matrix', () => {
  const parent = new Float64Array([
    2, 0, 0, 0,
    0, 3, 0, 0,
    0, 0, 4, 0,
    10.0000000001, 20, 30, 1,
  ]);
  const local = new Float64Array([
    1, 0, 0, 0,
    0.25, 1, 0, 0,
    0, 0.5, 1, 0,
    1, 2, 3, 1,
  ]);
  const result = DisplayTransform.compose(parent, local);

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, [
    2, 0, 0, 0,
    0.5, 3, 0, 0,
    0, 1.5, 4, 0,
    Math.fround(12.0000000001), 26, 42, 1,
  ]);
  parent[12] = 99;
  local[12] = 99;
  assert.equal(result[12], 12);

  const huge = new Float64Array([
    Number.MAX_VALUE, 0, 0, 0,
    0, Number.MAX_VALUE, 0, 0,
    0, 0, Number.MAX_VALUE, 0,
    0, 0, 0, 1,
  ]);
  const doubled = new Float64Array([
    2, 0, 0, 0,
    0, 2, 0, 0,
    0, 0, 2, 0,
    0, 0, 0, 1,
  ]);
  assert.throws(() => DisplayTransform.compose(huge, doubled),
    { code: 'display-transform-invalid' });
});

test('withTranslation and withScale preserve the other affine matrix information', () => {
  const source = Object.freeze([
    2, 0, 0, 0,
    1, 3, 0, 0,
    0.5, 0.25, 4, 0,
    5, 6, 7, 1,
  ]);
  const moved = DisplayTransform.withTranslation(source, [-2, 8, 9]);
  assert.deepEqual(moved.slice(0, 12), source.slice(0, 12));
  assert.deepEqual(moved.slice(12, 15), [-2, 8, 9]);

  const resized = DisplayTransform.withScale(source, [1, 2, 3]);
  assert.deepEqual(resized.slice(12, 15), [5, 6, 7]);
  for (let index = 0; index < 3; index += 1) {
    assert.ok(Math.abs(Math.hypot(...column(resized, index)) - [1, 2, 3][index]) < 1e-6);
    assertApprox(normalized(column(resized, index)), normalized(column(source, index)));
  }
  const sourceShear = normalized(column(source, 0)).reduce(
    (sum, entry, index) => sum + entry * normalized(column(source, 1))[index],
    0,
  );
  const resizedShear = normalized(column(resized, 0)).reduce(
    (sum, entry, index) => sum + entry * normalized(column(resized, 1))[index],
    0,
  );
  assert.ok(Math.abs(sourceShear - resizedShear) < 1e-6);
});

test('self and parent translations use different frames while retaining the basis', () => {
  const source = Object.freeze([
    2, 0, 0, 0,
    1, 3, 0, 0,
    0.5, 0.25, 4, 0,
    5, 6, 7, 1,
  ]);
  const self = DisplayTransform.translatedSelf(source, [1, 2, 3]);
  const parent = DisplayTransform.translatedParent(source, [1, 2, 3]);
  assert.deepEqual(self.slice(12, 15), [10.5, 12.75, 19]);
  assert.deepEqual(parent.slice(12, 15), [6, 8, 10]);
  assert.deepEqual(self.slice(0, 12), source.slice(0, 12));
  assert.deepEqual(parent.slice(0, 12), source.slice(0, 12));
});

test('self and parent rotations right- and left-multiply only the basis', () => {
  const source = DisplayTransform.fromTRS({ position: [5, 6, 7], scale: [2, 3, 4] });
  const self = DisplayTransform.rotatedSelf(source, [0, 0, 10], Math.PI / 2);
  const parent = DisplayTransform.rotatedParent(source, [0, 0, 10], Math.PI / 2);

  assertApprox(self.slice(0, 12), [
    0, 3, 0, 0,
    -2, 0, 0, 0,
    0, 0, 4, 0,
  ]);
  assertApprox(parent.slice(0, 12), [
    0, 2, 0, 0,
    -3, 0, 0, 0,
    0, 0, 4, 0,
  ]);
  assert.deepEqual(self.slice(12, 15), [5, 6, 7]);
  assert.deepEqual(parent.slice(12, 15), [5, 6, 7]);
});

test('self and parent scaling right- and left-multiply only the basis', () => {
  const source = DisplayTransform.rotatedParent(
    DisplayTransform.fromTRS({ position: [5, 6, 7], scale: [2, 3, 4] }),
    [0, 0, 1],
    Math.PI / 2,
  );
  const self = DisplayTransform.scaledSelf(source, [5, 6, 7]);
  const parent = DisplayTransform.scaledParent(source, [5, 6, 7]);

  assertApprox(self.slice(0, 12), [
    0, 10, 0, 0,
    -18, 0, 0, 0,
    0, 0, 28, 0,
  ]);
  assertApprox(parent.slice(0, 12), [
    0, 12, 0, 0,
    -15, 0, 0, 0,
    0, 0, 28, 0,
  ]);
  assert.deepEqual(self.slice(12, 15), [5, 6, 7]);
  assert.deepEqual(parent.slice(12, 15), [5, 6, 7]);
});

test('point and vector queries preserve f64 input precision and invert arbitrary shear', () => {
  const source = new Float64Array([
    2.0000000001, 0.25, 0, 0,
    1, 3, 0.5, 0,
    0.2, 0.4, 4, 0,
    5.0000000001, 6, 7, 1,
  ]);
  const point = [1.25, -2.5, 0.75];
  const vector = [-3, 2, 1.5];
  const transformedPoint = DisplayTransform.transformPoint(source, point);
  const transformedVector = DisplayTransform.transformVector(source, vector);

  assert.equal(Object.isFrozen(transformedPoint), true);
  assert.equal(Object.isFrozen(transformedVector), true);
  assert.equal(
    DisplayTransform.transformPoint(source, [0, 0, 0])[0],
    5.0000000001,
  );
  assert.notEqual(5.0000000001, Math.fround(5.0000000001));
  assertApprox(DisplayTransform.inverseTransformPoint(source, transformedPoint), point, 1e-12);
  assertApprox(DisplayTransform.inverseTransformVector(source, transformedVector), vector, 1e-12);
  assertApprox(
    transformedPoint.map((entry, index) => entry
      - DisplayTransform.transformVector(source, point)[index]),
    source.slice(12, 15),
    1e-12,
  );

  const exactInteger = new Float64Array(DisplayTransform.identity());
  exactInteger[12] = 2 ** 24 + 1;
  assert.equal(DisplayTransform.transformPoint(exactInteger, [0, 0, 0])[0], 2 ** 24 + 1);
});

test('facade rejects malformed matrices, invalid axes, non-positive scale, and nonfinite results', () => {
  const identity = DisplayTransform.identity();
  const invalidMatrices = [
    identity.slice(0, 15),
    new DataView(new ArrayBuffer(128)),
    [...identity.slice(0, 3), 1, ...identity.slice(4)],
    [...identity.slice(0, 10), Number.NaN, ...identity.slice(11)],
    [
      1, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ],
    [
      -1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ],
  ];
  for (const matrix of invalidMatrices) {
    assert.throws(() => DisplayTransform.transformPoint(matrix, [0, 0, 0]),
      { code: 'display-transform-invalid' });
  }

  for (const scale of [[1, 0, 1], [-1, 1, 1], [1, Number.NaN, 1]]) {
    assert.throws(() => DisplayTransform.withScale(identity, scale),
      { code: 'display-transform-invalid' });
    assert.throws(() => DisplayTransform.scaledSelf(identity, scale),
      { code: 'display-transform-invalid' });
    assert.throws(() => DisplayTransform.scaledParent(identity, scale),
      { code: 'display-transform-invalid' });
  }
  assert.throws(() => DisplayTransform.rotatedSelf(identity, [0, 0, 0], 1),
    { code: 'display-transform-invalid' });
  assert.throws(() => DisplayTransform.rotatedParent(identity, [0, 1, 0], Number.NaN),
    { code: 'display-transform-invalid' });
  assert.throws(() => DisplayTransform.withTranslation(identity, [Number.MAX_VALUE, 0, 0]),
    { code: 'display-transform-invalid' });

  const mutableSource = new Float64Array(identity);
  mutableSource[12] = 2 ** 24 + 1;
  const sourceSnapshot = Array.from(mutableSource);
  for (const [method, value] of [
    ['transformPoint', [0, 0]],
    ['inverseTransformPoint', [0, Number.NaN, 0]],
    ['transformVector', new Float64Array([0, 0, Number.POSITIVE_INFINITY])],
    ['inverseTransformVector', 'not-a-vector'],
  ]) {
    assert.throws(() => DisplayTransform[method](mutableSource, value),
      { code: 'display-transform-invalid' });
    assert.deepEqual(Array.from(mutableSource), sourceSnapshot);
  }

  const inverseOverflow = new Float64Array([
    1e-320, 0, 0, 0,
    0, 1e-320, 0, 0,
    0, 0, 1e-320, 0,
    0, 0, 0, 1,
  ]);
  assert.throws(() => DisplayTransform.inverseTransformVector(inverseOverflow, [1, 0, 0]),
    { code: 'display-transform-singular' });
});
