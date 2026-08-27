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
import { assertNodeName } from '../src/node/node-name.js';

test('Scene compile is closed and validates active Camera and resource references', () => {
  const components = createComponentRegistry(); const resources = createResourceRegistry();
  const prefab = emptyPrefab();
  const prefabs = createPrefabRegistry([prefab]);
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
    schema: PREFAB_DEFINITION_SCHEMA, id: 'bad', gameplayType: 'bad',
    root: { transform: { ...IDENTITY, position: [1, 0, 0] }, components: [], children: [] },
  });
  assert.throws(() => movedRoot.compile({ componentRegistry: components, resourceRegistry: resources }),
    { code: 'display-prefab-root-transform-invalid' });
  const duplicate = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'duplicate', gameplayType: 'duplicate',
    root: { components: [], children: [
      { localName: 'body', components: [], children: [] },
      { localName: 'body', components: [], children: [] },
    ] },
  });
  assert.throws(() => duplicate.compile({ componentRegistry: components, resourceRegistry: resources }),
    { code: 'display-prefab-local-name-duplicate' });
});

test('Prefab registry is keyed by exact id and allows duplicate gameplay types', () => {
  const fighter = emptyPrefab({
    id: 'product/unit/fighter-a',
    gameplayType: 'unit.aircraft',
    childName: 'fighter',
  });
  const bomber = emptyPrefab({
    id: 'product/unit/bomber@1',
    gameplayType: 'unit.aircraft',
    childName: 'bomber',
  });
  const registry = createPrefabRegistry([fighter, bomber]);
  assert.strictEqual(registry.require('product/unit/fighter-a'), fighter);
  assert.strictEqual(registry.require('product/unit/bomber@1'), bomber);
  assert.throws(() => registry.require('unit.aircraft'), { code: 'display-prefab-missing' });

  const duplicate = emptyPrefab({ id: 'product/unit/fighter-a', gameplayType: 'unit.vehicle' });
  assert.throws(() => registry.register(duplicate), { code: 'display-prefab-id-duplicate' });
  assert.strictEqual(registry.require('product/unit/fighter-a'), fighter);
});

test('Scene static Prefab instances compile by exact prefabId', () => {
  const components = createComponentRegistry(); const resources = createResourceRegistry();
  const fighter = emptyPrefab({
    id: 'product/unit/fighter-a',
    gameplayType: 'unit.aircraft',
    childName: 'fighter',
  });
  const bomber = emptyPrefab({
    id: 'product/unit/bomber@1',
    gameplayType: 'unit.aircraft',
    childName: 'bomber',
  });
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: IDENTITY,
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 },
      }],
    }],
    prefabInstances: [{
      localName: 'preview',
      parentLocalName: null,
      prefabId: 'product/unit/bomber@1',
      state: {},
    }],
  });
  const compiled = scene.compile({
    componentRegistry: components,
    resourceRegistry: resources,
    prefabRegistry: createPrefabRegistry([fighter, bomber]),
  });
  assert.equal(compiled.prefabInstances[0].prefabId, 'product/unit/bomber@1');
  assert.equal(compiled.prefabInstances[0].gameplayType, 'unit.aircraft');
  assert.strictEqual(compiled.prefabInstances[0].definition, bomber);
});

test('Definitions expose no public instantiate shortcut', () => {
  const prefab = emptyPrefab();
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: IDENTITY,
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 },
      }],
    }],
    prefabInstances: [],
  });
  assert.equal('instantiate' in prefab, false);
  assert.equal('instantiate' in scene, false);
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

test('Resource registry rejects non-asset definitions at register boundary', () => {
  const registry = createResourceRegistry();
  const prefab = emptyPrefab();
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
    sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera',
      parentLocalName: null,
      transform: IDENTITY,
      components: [{
        key: 'camera',
        type: 'render.camera@1',
        properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 },
      }],
    }],
    prefabInstances: [],
  });
  for (const [value, code] of [
    [prefab, 'display-resource-definition-invalid'],
    [scene, 'display-resource-definition-invalid'],
    [{ id: 'missing-kind' }, 'display-resource-definition-invalid'],
    [{ id: 'bad-kind', kind: 'scene' }, 'display-resource-kind-invalid'],
  ]) {
    assert.throws(() => registry.register(value), { code });
    assert.equal(registry.size, 0);
    assert.deepEqual([...registry.values()], []);
    assert.deepEqual(registry.snapshot(), {
      schema: 'scene-engine-resource-registry@1',
      resources: {},
    });
  }
});

test('built-in RenderComponents reject an existing resource of the wrong kind', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry([{ id: 'asset/wrong', kind: 'texture', url: './wrong.png' }]);
  assert.throws(() => components.compile({
    key: 'model', type: 'render.model@1', properties: { modelResourceId: 'asset/wrong' },
  }, resources), { code: 'display-resource-reference-kind-invalid' });
});

test('editor Node prefix is not part of the runtime name grammar', () => {
  assert.throws(() => assertNodeName(['editor', 'session', 'node'].join('/')),
    { code: 'display-node-name-invalid' });
});
