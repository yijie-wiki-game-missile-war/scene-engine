import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  DISPLAY_CATALOG_MANIFEST_SCHEMA,
  canonicalDisplayCatalogJson,
  computeDisplayCatalogIdentity,
  defineDisplayCatalogManifest,
  toDisplayCatalogIdentityRecord,
} from '../src/index.js';

const fixtureDirectory = new URL('../../../../fixtures/display-catalog-v1/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', fixtureDirectory), 'utf8'));
const expectedRecord = JSON.parse(fs.readFileSync(new URL('identity.json', fixtureDirectory), 'utf8'));
const expected = Object.freeze({
  sceneCatalogHash: expectedRecord.scene_catalog_hash,
  prefabCatalogHash: expectedRecord.prefab_catalog_hash,
  stateSchemaHash: expectedRecord.state_schema_hash,
});

function clone(value) { return structuredClone(value); }

function nodeSha256(value) {
  return createHash('sha256').update(canonicalDisplayCatalogJson(value)).digest('hex');
}

test('catalog identity matches the checked-in Display build artifact', () => {
  assert.equal(manifest.schema, DISPLAY_CATALOG_MANIFEST_SCHEMA);
  assert.deepEqual(computeDisplayCatalogIdentity(manifest), expected);
  assert.deepEqual(toDisplayCatalogIdentityRecord(expected), expectedRecord);
  assert.equal(Object.isFrozen(defineDisplayCatalogManifest(manifest)), true);
});


test('catalog SHA-256 matches the platform implementation', () => {
  const normalized = defineDisplayCatalogManifest(manifest);
  const actual = computeDisplayCatalogIdentity(normalized);
  assert.equal(actual.sceneCatalogHash, nodeSha256({
    schema: 'scene-engine-scene-catalog-input@1',
    scenes: normalized.scenes,
  }));
  assert.equal(actual.prefabCatalogHash, nodeSha256({
    schema: 'scene-engine-prefab-catalog-input@1',
    prefabs: normalized.prefabs,
    resources: normalized.resources,
    components: normalized.components,
  }));
  assert.equal(actual.stateSchemaHash, nodeSha256({
    schema: 'scene-engine-state-schema-input@1',
    authorityStateSchemas: normalized.authorityStateSchemas,
  }));
});

test('catalog registration order does not change identity', () => {
  const reordered = clone(manifest);
  for (const field of ['scenes', 'prefabs', 'resources', 'components', 'authorityStateSchemas']) {
    reordered[field].reverse();
  }
  assert.deepEqual(computeDisplayCatalogIdentity(reordered), expected);
});

test('scene, prefab/resource/component, and authority-state hashes are independent domains', () => {
  const sceneChanged = clone(manifest);
  sceneChanged.scenes[0].rendererProfile.maximumPixelRatio = 1;
  const sceneIdentity = computeDisplayCatalogIdentity(sceneChanged);
  assert.notEqual(sceneIdentity.sceneCatalogHash, expected.sceneCatalogHash);
  assert.equal(sceneIdentity.prefabCatalogHash, expected.prefabCatalogHash);
  assert.equal(sceneIdentity.stateSchemaHash, expected.stateSchemaHash);

  const prefabChanged = clone(manifest);
  prefabChanged.resources[0].url = './unit-v2.glb';
  const prefabIdentity = computeDisplayCatalogIdentity(prefabChanged);
  assert.equal(prefabIdentity.sceneCatalogHash, expected.sceneCatalogHash);
  assert.notEqual(prefabIdentity.prefabCatalogHash, expected.prefabCatalogHash);
  assert.equal(prefabIdentity.stateSchemaHash, expected.stateSchemaHash);

  const componentChanged = clone(manifest);
  componentChanged.components[0].drivesTransform = !componentChanged.components[0].drivesTransform;
  const componentIdentity = computeDisplayCatalogIdentity(componentChanged);
  assert.equal(componentIdentity.sceneCatalogHash, expected.sceneCatalogHash);
  assert.notEqual(componentIdentity.prefabCatalogHash, expected.prefabCatalogHash);
  assert.equal(componentIdentity.stateSchemaHash, expected.stateSchemaHash);

  const stateChanged = clone(manifest);
  stateChanged.authorityStateSchemas[0].revision += 1;
  const stateIdentity = computeDisplayCatalogIdentity(stateChanged);
  assert.equal(stateIdentity.sceneCatalogHash, expected.sceneCatalogHash);
  assert.equal(stateIdentity.prefabCatalogHash, expected.prefabCatalogHash);
  assert.notEqual(stateIdentity.stateSchemaHash, expected.stateSchemaHash);
});

test('catalog identity requires exact authority-state schema coverage', () => {
  const invalid = clone(manifest);
  invalid.authorityStateSchemas = [];
  assert.throws(() => computeDisplayCatalogIdentity(invalid), {
    code: 'display-authority-state-schema-coverage-invalid',
  });
});
