import { cloneAndFreeze, exactKeys, isPlainRecord, nonemptyString, safeInteger } from '../internal.js';
import { fail } from '../runtime/health.js';
import { compilePrefabCatalog } from '../resource/prefab-compiler.js';

export const DISPLAY_CATALOG_MANIFEST_SCHEMA = 'scene-engine-display-catalog-manifest@1';
const SCENE_CATALOG_HASH_SCHEMA = 'scene-engine-scene-catalog-input@1';
const PREFAB_CATALOG_HASH_SCHEMA = 'scene-engine-prefab-catalog-input@1';
const STATE_SCHEMA_HASH_SCHEMA = 'scene-engine-state-schema-input@1';
const HASH = /^[0-9a-f]{64}$/u;

function compareIdentifier(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('display-catalog-manifest-invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || seen.has(value)) fail('display-catalog-manifest-invalid');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => canonicalValue(entry, seen));
  } else {
    if (!isPlainRecord(value)) fail('display-catalog-manifest-invalid');
    result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalDisplayCatalogJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sortEntries(values, key, code) {
  if (!Array.isArray(values)) fail(code);
  const entries = values.map((value) => {
    if (!isPlainRecord(value)) fail(code);
    nonemptyString(value[key], code);
    return cloneAndFreeze(value, code);
  }).sort((left, right) => compareIdentifier(left[key], right[key]));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1][key] === entries[index][key]) fail(code);
  }
  return Object.freeze(entries);
}

function normalizeAuthorityStateSchemas(values) {
  if (!Array.isArray(values)) fail('display-authority-state-schemas-invalid');
  const entries = values.map((value) => {
    const record = exactKeys(value, ['gameplayType', 'schemaId', 'revision'], [],
      'display-authority-state-schema-invalid');
    return Object.freeze({
      gameplayType: nonemptyString(record.gameplayType, 'display-authority-state-schema-invalid'),
      schemaId: nonemptyString(record.schemaId, 'display-authority-state-schema-invalid'),
      revision: safeInteger(record.revision, 'display-authority-state-schema-invalid', { minimum: 0 }),
    });
  }).sort((left, right) => compareIdentifier(left.gameplayType, right.gameplayType));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].gameplayType === entries[index].gameplayType) {
      fail('display-authority-state-schema-duplicate');
    }
  }
  return Object.freeze(entries);
}

export function defineDisplayCatalogManifest(value) {
  const record = exactKeys(value, [
    'schema', 'scenes', 'prefabs', 'resources', 'components', 'authorityStateSchemas',
  ], [], 'display-catalog-manifest-invalid');
  if (record.schema !== DISPLAY_CATALOG_MANIFEST_SCHEMA) {
    fail('display-catalog-manifest-schema-invalid');
  }
  const manifest = {
    schema: DISPLAY_CATALOG_MANIFEST_SCHEMA,
    scenes: sortEntries(record.scenes, 'id', 'display-catalog-scenes-invalid'),
    prefabs: sortEntries(record.prefabs, 'id', 'display-catalog-prefabs-invalid'),
    resources: sortEntries(record.resources, 'id', 'display-catalog-resources-invalid'),
    components: sortEntries(record.components, 'typeId', 'display-catalog-components-invalid'),
    authorityStateSchemas: normalizeAuthorityStateSchemas(record.authorityStateSchemas),
  };
  const gameplayTypes = new Set(manifest.prefabs.map((entry) => entry.gameplayType));
  const schemaTypes = new Set(manifest.authorityStateSchemas.map((entry) => entry.gameplayType));
  if (gameplayTypes.size !== schemaTypes.size
      || [...gameplayTypes].some((entry) => !schemaTypes.has(entry))) {
    fail('display-authority-state-schema-coverage-invalid');
  }
  return cloneAndFreeze(manifest, 'display-catalog-manifest-invalid');
}

export function buildDisplayCatalogManifest({
  sceneRegistry,
  prefabRegistry,
  resourceRegistry,
  componentRegistry,
  authorityStateSchemas,
}) {
  if (typeof sceneRegistry?.values !== 'function'
      || typeof prefabRegistry?.values !== 'function'
      || typeof resourceRegistry?.values !== 'function'
      || typeof componentRegistry?.catalogEntries !== 'function') {
    fail('display-catalog-registry-invalid');
  }
  compilePrefabCatalog({ prefabRegistry, componentRegistry, resourceRegistry });
  return defineDisplayCatalogManifest({
    schema: DISPLAY_CATALOG_MANIFEST_SCHEMA,
    scenes: [...sceneRegistry.values()].map((definition) => definition.describe()),
    prefabs: [...prefabRegistry.values()].map((definition) => definition.describe()),
    resources: [...resourceRegistry.values()].map((resource) => resource.describe()),
    components: componentRegistry.catalogEntries(),
    authorityStateSchemas,
  });
}

export function computeDisplayCatalogIdentity(value) {
  const manifest = defineDisplayCatalogManifest(value);
  return Object.freeze({
    sceneCatalogHash: sha256Hex(canonicalDisplayCatalogJson({
      schema: SCENE_CATALOG_HASH_SCHEMA,
      scenes: manifest.scenes,
    })),
    prefabCatalogHash: sha256Hex(canonicalDisplayCatalogJson({
      schema: PREFAB_CATALOG_HASH_SCHEMA,
      prefabs: manifest.prefabs,
      resources: manifest.resources,
      components: manifest.components,
    })),
    stateSchemaHash: sha256Hex(canonicalDisplayCatalogJson({
      schema: STATE_SCHEMA_HASH_SCHEMA,
      authorityStateSchemas: manifest.authorityStateSchemas,
    })),
  });
}

export function normalizeDisplayCatalogIdentity(value) {
  const record = exactKeys(value, [
    'sceneCatalogHash', 'prefabCatalogHash', 'stateSchemaHash',
  ], [], 'display-catalog-identity-invalid');
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'string' || !HASH.test(entry)) fail('display-catalog-identity-invalid');
  }
  return Object.freeze({ ...record });
}

/** JSON record written beside an Arts build and loaded by Python. */
export function toDisplayCatalogIdentityRecord(value) {
  const identity = normalizeDisplayCatalogIdentity(value);
  return Object.freeze({
    scene_catalog_hash: identity.sceneCatalogHash,
    prefab_catalog_hash: identity.prefabCatalogHash,
    state_schema_hash: identity.stateSchemaHash,
  });
}

export function sameDisplayCatalogIdentity(left, right) {
  const a = normalizeDisplayCatalogIdentity(left);
  const b = normalizeDisplayCatalogIdentity(right);
  return a.sceneCatalogHash === b.sceneCatalogHash
    && a.prefabCatalogHash === b.prefabCatalogHash
    && a.stateSchemaHash === b.stateSchemaHash;
}

function sha256Hex(text) {
  const input = new TextEncoder().encode(text);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7)
        ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17)
        ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return [...state].map((entry) => entry.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
