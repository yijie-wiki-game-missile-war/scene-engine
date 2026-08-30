import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  DISPLAY_CATALOG_MANIFEST_SCHEMA,
  PREFAB_DEFINITION_SCHEMA,
  buildDisplayCatalogManifest,
  canonicalDisplayCatalogJson,
  computeDisplayCatalogIdentity,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineDisplayCatalogManifest,
  definePrefab,
  defineScene,
  toDisplayCatalogIdentityRecord,
} from '../src/index.js';

const fixtureDirectory = new URL('../../../../fixtures/display-catalog-v2/', import.meta.url);
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
  assert.throws(() => defineDisplayCatalogManifest({
    ...manifest, schema: 'scene-engine-display-catalog-manifest@1',
  }), { code: 'display-catalog-manifest-schema-invalid' });
});

test('checked-in Display catalog definitions compile through the public registries', () => {
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry(manifest.resources);
  const prefabDefinitions = manifest.prefabs.map((value) => definePrefab(value));
  const prefabRegistry = createPrefabRegistry(prefabDefinitions);
  const sceneDefinitions = manifest.scenes.map((value) => defineScene(value));
  const sceneRegistry = createSceneRegistry(sceneDefinitions);
  for (const definition of prefabDefinitions) {
    definition.compile({ componentRegistry, resourceRegistry, prefabRegistry });
  }
  for (const definition of sceneDefinitions) {
    definition.compile({ componentRegistry, prefabRegistry, resourceRegistry });
  }
  assert.deepEqual(buildDisplayCatalogManifest({
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas: manifest.authorityStateSchemas,
  }), defineDisplayCatalogManifest(manifest));
});

test('catalog build precompiles nested Prefab dependencies and hashes composition policy', () => {
  const build = (maximumInstances, reverse = false) => {
    const leaf = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'catalog/nested-leaf',
      gameplayType: 'catalog.leaf',
      root: { components: [], children: [] },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'catalog/nested-owner',
      gameplayType: 'catalog.owner',
      root: { components: [], children: [] },
      prefabInstances: [{
        key: 'fixed', parentLocalPath: null, prefabId: leaf.id, state: { value: 1 },
      }],
      prefabSlots: [{
        key: 'units', parentLocalPath: null,
        allowedPrefabIds: [leaf.id], maximumInstances,
      }],
    });
    return buildDisplayCatalogManifest({
      sceneRegistry: createSceneRegistry(),
      prefabRegistry: createPrefabRegistry(reverse ? [owner, leaf] : [leaf, owner]),
      resourceRegistry: createResourceRegistry(),
      componentRegistry: createComponentRegistry(),
      authorityStateSchemas: [
        { gameplayType: 'catalog.owner', schemaId: 'catalog.owner.state', revision: 1 },
        { gameplayType: 'catalog.leaf', schemaId: 'catalog.leaf.state', revision: 1 },
      ],
    });
  };
  const baseline = build(2);
  const reordered = build(2, true);
  const changed = build(3);
  assert.deepEqual(computeDisplayCatalogIdentity(reordered),
    computeDisplayCatalogIdentity(baseline));
  const baselineIdentity = computeDisplayCatalogIdentity(baseline);
  const changedIdentity = computeDisplayCatalogIdentity(changed);
  assert.equal(changedIdentity.sceneCatalogHash, baselineIdentity.sceneCatalogHash);
  assert.notEqual(changedIdentity.prefabCatalogHash, baselineIdentity.prefabCatalogHash);
  assert.equal(changedIdentity.stateSchemaHash, baselineIdentity.stateSchemaHash);
});

test('catalog build fails closed on a cycle through a dynamic Prefab allowlist', () => {
  const left = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'catalog/cycle-left',
    gameplayType: 'catalog.left',
    root: { components: [], children: [] },
    prefabSlots: [{
      key: 'right', parentLocalPath: null,
      allowedPrefabIds: ['catalog/cycle-right'], maximumInstances: 1,
    }],
  });
  const right = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'catalog/cycle-right',
    gameplayType: 'catalog.right',
    root: { components: [], children: [] },
    prefabInstances: [{ key: 'left', parentLocalPath: null, prefabId: left.id }],
  });
  assert.throws(() => buildDisplayCatalogManifest({
    sceneRegistry: createSceneRegistry(),
    prefabRegistry: createPrefabRegistry([right, left]),
    resourceRegistry: createResourceRegistry(),
    componentRegistry: createComponentRegistry(),
    authorityStateSchemas: [
      { gameplayType: 'catalog.left', schemaId: 'catalog.left.state', revision: 1 },
      { gameplayType: 'catalog.right', schemaId: 'catalog.right.state', revision: 1 },
    ],
  }), { code: 'display-prefab-cycle' });
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
