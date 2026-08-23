const TREE_SCHEMA = 'scene-engine-json-tree@1';
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const DELETE = Symbol('delete');
const MISSING = Symbol('missing');

export class JsonTreeClientError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'JsonTreeClientError';
    this.code = code;
  }
}

/** Clone, validate, and deeply freeze a checkpoint snapshot exactly once. */
export function prepareJsonSnapshot(value, limits) {
  if (!isRecord(value)) fail('world-snapshot-object-required');
  return cloneFreeze(value, new WeakSet(), 0, limits.maximumJsonDepth);
}

/**
 * Apply a validated non-overlapping patch with structural sharing. Existing
 * subtrees that no change touches are never traversed and retain identity.
 */
export function applyJsonPatch(root, patch, limits) {
  if (!isRecord(root)) fail('world-state-object-required');
  if (!isRecord(patch) || !exactKeys(patch, ['schema', 'changes'])
      || patch.schema !== TREE_SCHEMA || !Array.isArray(patch.changes)) {
    fail('world-patch-shape-invalid');
  }
  if (patch.changes.length > limits.maximumWorldPatchChanges) {
    fail('world-patch-change-limit');
  }

  const normalized = [];
  let previousPath = null;
  for (const value of patch.changes) {
    if (!isRecord(value) || !['set', 'unset', 'append'].includes(value.op)) {
      fail('world-patch-change-invalid');
    }
    const fields = value.op === 'set'
      ? ['op', 'path', 'value']
      : value.op === 'append' ? ['op', 'path', 'values'] : ['op', 'path'];
    if (!exactKeys(value, fields)) fail('world-patch-change-fields-invalid');
    const path = validatePath(value.path, limits.maximumJsonPathSegments);
    if (previousPath !== null && comparePaths(previousPath, path) >= 0) {
      fail('world-patch-path-order-invalid');
    }
    for (const prior of normalized) {
      if (prefix(prior.path, path) || prefix(path, prior.path)) {
        fail('world-patch-path-overlap');
      }
    }
    const change = { op: value.op, path };
    if (value.op === 'set') {
      validateJsonValue(value.value, new WeakSet(), 0, limits.maximumJsonDepth);
      change.value = value.value;
    } else if (value.op === 'append') {
      if (!Array.isArray(value.values) || value.values.length === 0) {
        fail('world-patch-append-values-invalid');
      }
      validateJsonValue(value.values, new WeakSet(), 0, limits.maximumJsonDepth);
      change.values = value.values;
    }
    validateTarget(root, change);
    normalized.push(change);
    previousPath = path;
  }

  if (normalized.length === 0) return root;
  const trie = trieNode();
  for (const change of normalized) {
    let node = trie;
    for (const segment of change.path) {
      if (!node.children.has(segment)) node.children.set(segment, trieNode());
      node = node.children.get(segment);
    }
    node.change = change;
  }
  const result = applyTrie(root, trie, limits.maximumJsonDepth, 0);
  if (result === DELETE || !isRecord(result)) fail('world-patch-root-invalid');
  return result;
}

function validateTarget(root, change) {
  let cursor = root;
  for (let index = 0; index < change.path.length - 1; index += 1) {
    cursor = childAt(cursor, change.path[index]);
  }
  const segment = change.path.at(-1);
  if (change.op === 'set') {
    if (Array.isArray(cursor)) {
      if (!Number.isSafeInteger(segment) || segment < 0 || segment >= cursor.length) {
        fail('world-patch-set-target-invalid');
      }
    } else if (!isRecord(cursor) || typeof segment !== 'string') {
      fail('world-patch-set-target-invalid');
    }
    return;
  }
  const target = childAt(cursor, segment);
  if (change.op === 'append' && !Array.isArray(target)) {
    fail('world-patch-append-target-invalid');
  }
}

function childAt(parent, segment) {
  if (Array.isArray(parent) && Number.isSafeInteger(segment)
      && segment >= 0 && segment < parent.length) return parent[segment];
  if (isRecord(parent) && typeof segment === 'string' && Object.hasOwn(parent, segment)) {
    return parent[segment];
  }
  fail('world-patch-path-missing');
}

function applyTrie(current, trie, maximumDepth, depth) {
  if (trie.change) {
    if (trie.change.op === 'unset') return DELETE;
    if (trie.change.op === 'set') {
      return cloneFreeze(trie.change.value, new WeakSet(), depth, maximumDepth);
    }
    const additions = trie.change.values.map(
      (item) => cloneFreeze(item, new WeakSet(), depth + 1, maximumDepth),
    );
    return Object.freeze([...current, ...additions]);
  }
  if (Array.isArray(current)) {
    const candidate = current.slice();
    const children = [...trie.children.entries()].sort((left, right) => right[0] - left[0]);
    for (const [segment, child] of children) {
      const result = applyTrie(current[segment], child, maximumDepth, depth + 1);
      if (result === DELETE) candidate.splice(segment, 1);
      else candidate[segment] = result;
    }
    return Object.freeze(candidate);
  }
  if (!isRecord(current)) fail('world-patch-container-invalid');
  const candidate = cloneRecordShallow(current);
  for (const [segment, child] of trie.children) {
    const present = Object.hasOwn(current, segment);
    const result = applyTrie(present ? current[segment] : MISSING, child, maximumDepth, depth + 1);
    if (result === DELETE) delete candidate[segment];
    else defineData(candidate, segment, result);
  }
  return Object.freeze(candidate);
}

function cloneFreeze(value, active, depth, maximumDepth) {
  if (depth > maximumDepth) fail('json-depth-limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('json-number-nonfinite');
    return value;
  }
  if (!value || typeof value !== 'object' || active.has(value)) fail('json-value-invalid');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('json-array-invalid');
      const candidate = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('json-array-sparse');
        candidate.push(cloneFreeze(value[index], active, depth + 1, maximumDepth));
      }
      return Object.freeze(candidate);
    }
    if (!isRecord(value)) fail('json-object-invalid');
    const candidate = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || FORBIDDEN.has(key)) fail('json-object-key-invalid');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        fail('json-property-invalid');
      }
      defineData(candidate, key, cloneFreeze(descriptor.value, active, depth + 1, maximumDepth));
    }
    return Object.freeze(candidate);
  } finally {
    active.delete(value);
  }
}

function validateJsonValue(value, active, depth, maximumDepth) {
  cloneFreeze(value, active, depth, maximumDepth);
}

function validatePath(value, maximumSegments) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumSegments) {
    fail('world-patch-path-invalid');
  }
  return Object.freeze(value.map((segment) => {
    if (typeof segment === 'string') {
      if (!segment || FORBIDDEN.has(segment)) fail('world-patch-path-segment-invalid');
      return segment;
    }
    if (!Number.isSafeInteger(segment) || segment < 0) {
      fail('world-patch-path-segment-invalid');
    }
    return segment;
  }));
}

function comparePaths(left, right) {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = compareSegments(left[index], right[index]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function compareSegments(left, right) {
  if (typeof left !== typeof right) return typeof left === 'string' ? -1 : 1;
  if (typeof left === 'number') return left - right;
  const encoder = new TextEncoder();
  const a = encoder.encode(left); const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function prefix(left, right) {
  return left.length <= right.length && left.every((item, index) => item === right[index]);
}
function trieNode() { return { change: null, children: new Map() }; }
function cloneRecordShallow(value) {
  const result = {};
  for (const key of Object.keys(value)) defineData(result, key, value[key]);
  return result;
}
function defineData(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true, enumerable: true, value, writable: true,
  });
}
function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, expected) {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key));
}
function fail(code) { throw new JsonTreeClientError(code); }

export const JSON_TREE_SCHEMA = TREE_SCHEMA;
