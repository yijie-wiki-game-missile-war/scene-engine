#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineDisplayCatalogManifest,
  definePrefab,
  defineScene,
  toDisplayCatalogIdentityRecord,
} from '../js/packages/display/src/index.js';

const fixtureRoot = new URL('../fixtures/display-catalog-v1/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', fixtureRoot), 'utf8'));
const expectedIdentity = JSON.parse(await readFile(new URL('identity.json', fixtureRoot), 'utf8'));

const componentRegistry = createComponentRegistry();
const resourceRegistry = createResourceRegistry(manifest.resources);
const prefabDefinitions = manifest.prefabs.map((descriptor) => definePrefab(descriptor));
const prefabRegistry = createPrefabRegistry(prefabDefinitions);
const sceneDefinitions = manifest.scenes.map((descriptor) => defineScene(descriptor));
const sceneRegistry = createSceneRegistry(sceneDefinitions);

for (const definition of prefabDefinitions) {
  definition.compile({ componentRegistry, resourceRegistry });
}
for (const definition of sceneDefinitions) {
  definition.compile({ componentRegistry, prefabRegistry, resourceRegistry });
}

const rebuilt = buildDisplayCatalogManifest({
  sceneRegistry,
  prefabRegistry,
  resourceRegistry,
  componentRegistry,
  authorityStateSchemas: manifest.authorityStateSchemas,
});
assert.deepEqual(rebuilt, defineDisplayCatalogManifest(manifest));
assert.deepEqual(
  toDisplayCatalogIdentityRecord(computeDisplayCatalogIdentity(rebuilt)),
  expectedIdentity,
);

console.log('Display catalog fixture semantic compilation passed.');
