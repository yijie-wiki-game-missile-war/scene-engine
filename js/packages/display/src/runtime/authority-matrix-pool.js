import { safeInteger } from '../internal.js';
import { matrix4Determinant3x3 } from '../math/matrix4.js';
import { fail } from './health.js';

const MATRIX_LENGTH = 16;
const MAXIMUM_NODE_ID = 0xfffffffe;
const MAXIMUM_POOL_SIZE = 0xffffffff;

function poolSize(value) {
  return safeInteger(value, 'display-authority-matrix-pool-size-invalid', {
    minimum: 0,
    maximum: MAXIMUM_POOL_SIZE,
  });
}

function exactOwnedFloat32(value, length, code) {
  if (!(value instanceof Float32Array) || value.length !== length
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail(code);
  }
  return value;
}

function exactOwnedUint32(value, code) {
  if (!(value instanceof Uint32Array)
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail(code);
  }
  return value;
}

function isZeroRow(matrices, offset) {
  for (let index = 0; index < MATRIX_LENGTH; index += 1) {
    if (!Object.is(matrices[offset + index], 0)) return false;
  }
  return true;
}

function validateMatrix(matrices, offset) {
  for (let index = 0; index < MATRIX_LENGTH; index += 1) {
    const value = matrices[offset + index];
    if (!Number.isFinite(value)) fail('display-transform-invalid');
    if (Object.is(value, -0)) matrices[offset + index] = 0;
  }
  if (matrices[offset + 3] !== 0 || matrices[offset + 7] !== 0
      || matrices[offset + 11] !== 0 || matrices[offset + 15] !== 1) {
    fail('display-transform-invalid');
  }
  const matrix = matrices.subarray(offset, offset + MATRIX_LENGTH);
  const determinant = matrix4Determinant3x3(matrix);
  if (!Number.isFinite(determinant) || determinant <= 0) {
    fail('display-transform-invalid');
  }
}

function allocateMatrices(size) {
  try {
    return new Float32Array(size * MATRIX_LENGTH);
  } catch (error) {
    if (error instanceof RangeError) fail('display-authority-matrix-pool-size-invalid');
    throw error;
  }
}

function allocateStagedRows(size) {
  try {
    return new Int32Array(size);
  } catch (error) {
    if (error instanceof RangeError) fail('display-authority-matrix-pool-size-invalid');
    throw error;
  }
}

/** Package-private sole local-Matrix4 owner for Python authority roots. */
export class AuthorityMatrixPool {
  constructor() {
    this._matrices = null;
    this._size = 0;
    this._capacity = 0;
    this._rowViews = [];
    this._activeIds = new Set();
    this._pendingClaims = new Set();
    this._retiredIds = new Set();
    this._stagedIds = null;
    this._stagedMatrices = null;
    this._stagedRows = new Int32Array(0);
    this._consumedCount = 0;
  }

  get installed() { return this._matrices !== null; }
  get size() { return this._size; }
  get capacity() { return this._capacity; }

  install({ poolSize, matrices }) {
    if (this.installed) fail('display-authority-matrix-pool-already-installed');
    const size = poolSizeValue(poolSize);
    const owner = exactOwnedFloat32(
      matrices,
      size * MATRIX_LENGTH,
      'display-authority-matrix-pool-invalid',
    );
    const stagedRows = allocateStagedRows(size);
    const pending = new Set();
    const retired = new Set();
    for (let nodeId = 0; nodeId < size; nodeId += 1) {
      const offset = nodeId * MATRIX_LENGTH;
      if (isZeroRow(owner, offset)) {
        owner.fill(0, offset, offset + MATRIX_LENGTH);
        retired.add(nodeId);
        continue;
      }
      validateMatrix(owner, offset);
      pending.add(nodeId);
    }
    this._matrices = owner;
    this._size = size;
    this._capacity = size;
    this._rowViews = [];
    this._pendingClaims = pending;
    this._retiredIds = retired;
    this._stagedRows = stagedRows;
  }

  applyBatch({ poolSize, nodeIds, matrices }) {
    this._requireInstalled();
    if (this._stagedIds !== null) fail('display-authority-transform-batch-active');
    const size = poolSizeValue(poolSize);
    if (size < this.size) fail('display-authority-matrix-pool-shrink-invalid');
    const ids = exactOwnedUint32(nodeIds, 'display-authority-transform-batch-invalid');
    const values = exactOwnedFloat32(
      matrices,
      ids.length * MATRIX_LENGTH,
      'display-authority-transform-batch-invalid',
    );
    let previous = -1;
    for (let index = 0; index < ids.length; index += 1) {
      const nodeId = ids[index];
      if (nodeId > MAXIMUM_NODE_ID || nodeId >= size || nodeId <= previous
          || this._retiredIds.has(nodeId)) {
        fail('display-authority-transform-batch-invalid');
      }
      validateMatrix(values, index * MATRIX_LENGTH);
      previous = nodeId;
    }

    // Every newly-addressable row must be paid for by one matrix in this packet.
    // Since IDs are strictly sorted, the complete appended range must be the tail.
    const growth = size - this.size;
    if (growth > ids.length) fail('display-authority-transform-batch-invalid');
    for (let offset = 0; offset < growth; offset += 1) {
      if (ids[ids.length - growth + offset] !== this.size + offset) {
        fail('display-authority-transform-batch-invalid');
      }
    }

    let owner = this._matrices;
    let stagedRows = this._stagedRows;
    if (size > this.capacity) {
      const doubled = this.capacity === 0 ? 1 : Math.min(MAXIMUM_POOL_SIZE, this.capacity * 2);
      const capacity = Math.max(size, doubled);
      const grown = allocateMatrices(capacity);
      const grownStagedRows = allocateStagedRows(capacity);
      grown.set(owner);
      owner = grown;
      stagedRows = grownStagedRows;
      this._capacity = capacity;
      this._rowViews = [];
    }
    this._matrices = owner;
    this._stagedRows = stagedRows;
    this._size = size;
    this._stagedIds = ids;
    this._stagedMatrices = values;
    for (let index = 0; index < ids.length; index += 1) {
      this._stagedRows[ids[index]] = index + 1;
    }
    this._consumedCount = 0;
  }

  claim(nodeId) {
    this._requireInstalled();
    const id = authorityNodeId(nodeId);
    if (id >= this.size || this._activeIds.has(id) || this._retiredIds.has(id)) {
      fail('display-authority-matrix-node-invalid');
    }
    if (!this._pendingClaims.delete(id)) this._consumeStaged(id);
    this._activeIds.add(id);
  }

  consume(nodeId) {
    this._requireInstalled();
    const id = authorityNodeId(nodeId);
    if (!this._activeIds.has(id)) fail('display-authority-matrix-node-invalid');
    this._consumeStaged(id);
  }

  release(nodeId) {
    this._requireInstalled();
    const id = authorityNodeId(nodeId);
    if (!this._activeIds.delete(id)) fail('display-authority-matrix-node-invalid');
    this._matrices.fill(0, id * MATRIX_LENGTH, (id + 1) * MATRIX_LENGTH);
    this._retiredIds.add(id);
  }

  has(nodeId) {
    return this._activeIds.has(nodeId);
  }

  matrix(nodeId) {
    this._requireInstalled();
    const id = authorityNodeId(nodeId);
    if (!this._activeIds.has(id)) fail('display-authority-matrix-node-invalid');
    const offset = id * MATRIX_LENGTH;
    let row = this._rowViews[id];
    if (row === undefined) {
      row = this._matrices.subarray(offset, offset + MATRIX_LENGTH);
      this._rowViews[id] = row;
    }
    return row;
  }

  assertSettled() {
    if (this.installed && (this._pendingClaims.size !== 0
        || (this._stagedIds !== null && this._consumedCount !== this._stagedIds.length))) {
      fail('display-authority-matrix-pool-unclaimed');
    }
    if (this._stagedIds !== null) {
      for (const nodeId of this._stagedIds) this._stagedRows[nodeId] = 0;
    }
    this._stagedIds = null;
    this._stagedMatrices = null;
    this._consumedCount = 0;
  }

  releaseOwner() {
    this._matrices = null;
    this._size = 0;
    this._capacity = 0;
    this._rowViews = [];
    this._activeIds.clear();
    this._pendingClaims.clear();
    this._retiredIds.clear();
    this._stagedIds = null;
    this._stagedMatrices = null;
    this._stagedRows = new Int32Array(0);
    this._consumedCount = 0;
  }

  _consumeStaged(nodeId) {
    const encodedIndex = this._stagedRows[nodeId] ?? 0;
    if (encodedIndex <= 0) {
      fail('display-authority-transform-batch-unavailable');
    }
    const index = encodedIndex - 1;
    const sourceOffset = index * MATRIX_LENGTH;
    const targetOffset = nodeId * MATRIX_LENGTH;
    for (let offset = 0; offset < MATRIX_LENGTH; offset += 1) {
      this._matrices[targetOffset + offset] = this._stagedMatrices[sourceOffset + offset];
    }
    this._stagedRows[nodeId] = -encodedIndex;
    this._consumedCount += 1;
  }

  _requireInstalled() {
    if (!this.installed) fail('display-authority-matrix-pool-missing');
  }
}

function poolSizeValue(value) { return poolSize(value); }

export function authorityNodeId(value) {
  return safeInteger(value, 'display-authority-node-id-invalid', {
    minimum: 0,
    maximum: MAXIMUM_NODE_ID,
  });
}

export function authorityNodeName(value) {
  return `py/${authorityNodeId(value)}`;
}
