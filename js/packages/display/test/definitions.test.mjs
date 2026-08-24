import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  definePrefab,
  defineScene,
} from '../src/index.js';
import { IDENTITY, RENDERER_PROFILE, emptyPrefab } from './helpers.mjs';

test('Scene compile is closed and validates active Camera and resource references', () => {
  const components = createComponentRegistry(); const resources = createResourceRegistry();
  const prefab = emptyPrefab();
  const prefabs = createPrefabRegistry([{ sceneProfile: 'test', logicalType: prefab.logicalType, definition: prefab }]);
  const invalid = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main', sceneProfile: 'test', rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'model',
    nodes: [{
      localName: 'model', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'model', type: 'render.model@1', properties: { modelResourceId: 'missing' } }],
    }],
    prefabInstances: [],
  });
  assert.throws(() => invalid.compile({ componentRegistry: components, resourceRegistry: resources,
    prefabRegistry: prefabs }), { code: 'display-resource-missing' });
  assert.throws(() => defineScene({ ...invalid.describe(), unknown: true }),
    { code: 'display-scene-definition-invalid' });
});

test('Prefab compile rejects non-identity root, duplicate local paths, and unknown fields', () => {
  const components = createComponentRegistry(); const resources = createResourceRegistry();
  const movedRoot = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'bad', logicalType: 'bad',
    root: { transform: { ...IDENTITY, position: [1, 0, 0] }, components: [], children: [] },
  });
  assert.throws(() => movedRoot.compile({ componentRegistry: components, resourceRegistry: resources }),
    { code: 'display-prefab-root-transform-invalid' });
  const duplicate = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'duplicate', logicalType: 'duplicate',
    root: { components: [], children: [
      { localName: 'body', components: [], children: [] },
      { localName: 'body', components: [], children: [] },
    ] },
  });
  assert.throws(() => duplicate.compile({ componentRegistry: components, resourceRegistry: resources }),
    { code: 'display-prefab-local-name-duplicate' });
});

test('Resource definitions are immutable closed data', () => {
  const descriptor = { id: 'model/a', kind: 'model', url: './a.glb', clipNames: [] };
  const registry = createResourceRegistry([descriptor]);
  descriptor.url = './changed.glb';
  assert.equal(registry.require('model/a').describe().url, './a.glb');
  assert.throws(() => createResourceRegistry([{ ...descriptor, id: 'bad', callback() {} }]),
    { code: 'display-resource-definition-invalid' });
});

test('Resource registry closes nested references and hash identity', () => {
  assert.throws(() => createResourceRegistry([{ id: 'atlas/a', kind: 'texture-atlas',
    textureResourceId: 'texture/missing', columns: 1, rows: 1 }]),
  { code: 'display-resource-missing' });
  assert.throws(() => createResourceRegistry([{ id: 'model/a', kind: 'model', url: './a.glb',
    hash: 'ABC' }]), { code: 'display-resource-hash-invalid' });
  const registry = createResourceRegistry([
    { id: 'texture/a', kind: 'texture', url: './a.png' },
    { id: 'atlas/a', kind: 'texture-atlas', textureResourceId: 'texture/a', columns: 1, rows: 1 },
  ]);
  assert.equal(registry.size, 2);
});

test('built-in RenderComponents reject an existing resource of the wrong kind', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry([{ id: 'asset/wrong', kind: 'texture', url: './wrong.png' }]);
  assert.throws(() => components.compile({
    key: 'model', type: 'render.model@1', properties: { modelResourceId: 'asset/wrong' },
  }, resources), { code: 'display-resource-reference-kind-invalid' });
});
