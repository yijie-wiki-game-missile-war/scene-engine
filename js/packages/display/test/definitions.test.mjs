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
import { IDENTITY, RENDERER_PROFILE, emptyPrefab,
  matrixPosition, matrixTransform } from './helpers.mjs';
import { assertNodeName } from '../src/node/node-name.js';
import { compilePrefabCatalog } from '../src/resource/prefab-compiler.js';

function nestingPrefab({ id, gameplayType = id.replaceAll('/', '.'), childName = null,
  prefabInstances = [], prefabSlots = [], resolveState = undefined } = {}) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    gameplayType,
    root: {
      components: [],
      children: childName === null ? [] : [{ localName: childName, components: [], children: [] }],
    },
    prefabInstances,
    prefabSlots,
    ...(resolveState === undefined ? {} : { resolveState }),
  });
}

test('Billboard v2 defaults to fixed world facing and rejects ambiguous camera settings', () => {
  const registry = createComponentRegistry();
  const definition = { key: 'facing', type: 'behavior.billboard@2',
    properties: { mode: 'continuous', axisMode: 'y-axis' } };
  assert.deepEqual(registry.compile(definition).properties, {
    mode: 'continuous', axisMode: 'y-axis', facing: 'fixed', cameraName: null,
  });
  assert.equal(registry.compile({ ...definition, properties: {
    ...definition.properties, facing: 'camera', cameraName: 'scene/main/camera',
  } }).properties.facing, 'camera');
  for (const patch of [{ facing: null }, { facing: 'other' }, { cameraName: 'scene/main/camera' }]) {
    assert.throws(() => registry.compile({ ...definition,
      properties: { ...definition.properties, ...patch } }),
    { code: 'display-component-properties-invalid' });
  }
  assert.throws(() => registry.compile({ ...definition, type: 'behavior.billboard@1' }),
    { code: 'display-component-type-missing' });
});

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
      components: [{ key: 'model', type: 'render.model@2', properties: { modelResourceId: 'missing' } }],
    }],
    prefabInstances: [],
  });
  assert.throws(() => invalid.compile({ componentRegistry: components, resourceRegistry: resources,
    prefabRegistry: prefabs }), { code: 'display-resource-missing' });
  assert.throws(() => defineScene({ ...invalid.describe(), unknown: true }),
    { code: 'display-scene-definition-invalid' });
  assert.throws(() => defineScene({
    ...invalid.describe(), schema: 'scene-engine-scene-definition@1',
  }), { code: 'display-scene-definition-invalid' });
});

test('Prefab compile rejects non-identity root, duplicate local paths, and unknown fields', () => {
  const components = createComponentRegistry(); const resources = createResourceRegistry();
  const movedRoot = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'bad', gameplayType: 'bad',
    root: { transform: matrixTransform({ position: [1, 0, 0] }), components: [], children: [] },
  });
  assert.throws(() => movedRoot.compile({ componentRegistry: components, resourceRegistry: resources }),
    { code: 'display-prefab-root-transform-invalid' });
  for (const transform of [null, {
    position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1],
  }]) {
    const legacy = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA, id: 'legacy', gameplayType: 'legacy',
      root: { transform, components: [], children: [] },
    });
    assert.throws(() => legacy.compile({ componentRegistry: components,
      resourceRegistry: resources }), { code: 'display-transform-invalid' });
  }
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

test('Prefab schema 4 fails closed on schema 3 and normalizes fixed and dynamic declarations', () => {
  assert.equal(PREFAB_DEFINITION_SCHEMA, 'scene-engine-prefab-definition@4');
  assert.throws(() => definePrefab({
    schema: 'scene-engine-prefab-definition@3',
    id: 'nested/legacy',
    gameplayType: 'nested.legacy',
    root: { components: [], children: [] },
  }), { code: 'display-prefab-definition-invalid' });

  const components = createComponentRegistry();
  const resources = createResourceRegistry();
  const leaf = nestingPrefab({ id: 'nested/leaf' });
  const middle = nestingPrefab({
    id: 'nested/middle',
    childName: 'mount',
    prefabInstances: [{
      key: 'leaf', parentLocalPath: 'mount', prefabId: leaf.id,
      transform: matrixTransform({ position: [2, 0, 0] }), visible: false, state: { value: 3 },
    }],
  });
  const outer = nestingPrefab({
    id: 'nested/outer',
    prefabInstances: [
      { key: 'middle', parentLocalPath: null, prefabId: middle.id },
      { key: 'shared', parentLocalPath: null, prefabId: leaf.id },
    ],
    prefabSlots: [{
      key: 'units', parentLocalPath: null,
      allowedPrefabIds: [leaf.id, middle.id], maximumInstances: 2,
    }],
  });
  const prefabRegistry = createPrefabRegistry([outer, leaf, middle]);
  const catalog = compilePrefabCatalog({ prefabRegistry, componentRegistry: components,
    resourceRegistry: resources });
  assert.strictEqual(compilePrefabCatalog({ prefabRegistry, componentRegistry: components,
    resourceRegistry: resources }), catalog);
  const compiled = catalog.require(outer.id);
  assert.strictEqual(compiled.prefabInstances[0].compiledPrefab,
    catalog.require(middle.id));
  assert.strictEqual(compiled.prefabInstances[1].compiledPrefab,
    catalog.require(leaf.id));
  assert.strictEqual(compiled.prefabInstances[0].compiledPrefab.prefabInstances[0].compiledPrefab,
    catalog.require(leaf.id));
  assert.deepEqual(compiled.prefabSlots[0].allowedPrefabIds, [leaf.id, middle.id]);
  assert.strictEqual(compiled.prefabSlots[0].allowedPrefabs[0].compiledPrefab,
    catalog.require(leaf.id));
  assert.equal(compiled.maximumGraphHeight, 4);
  assert.equal(compiled.maximumExpandedNodeCount, 11);
  assert.deepEqual([...catalog.values()].map((entry) => entry.id),
    ['nested/leaf', 'nested/middle', 'nested/outer']);
  prefabRegistry.register(nestingPrefab({ id: 'nested/registered-later' }));
  const refreshed = compilePrefabCatalog({ prefabRegistry, componentRegistry: components,
    resourceRegistry: resources });
  assert.notStrictEqual(refreshed, catalog);
  assert.equal(refreshed.size, 4);
});

test('Prefab catalog rejects missing, cyclic, invalid mount, key, policy, and path declarations', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry();
  const missing = nestingPrefab({ id: 'nested/missing-owner', prefabInstances: [{
    key: 'missing', parentLocalPath: null, prefabId: 'nested/not-registered',
  }] });
  assert.throws(() => missing.compile({ componentRegistry: components, resourceRegistry: resources,
    prefabRegistry: createPrefabRegistry([missing]) }), { code: 'display-prefab-missing' });

  const self = nestingPrefab({ id: 'nested/self', prefabInstances: [{
    key: 'self', parentLocalPath: null, prefabId: 'nested/self',
  }] });
  assert.throws(() => self.compile({ componentRegistry: components, resourceRegistry: resources,
    prefabRegistry: createPrefabRegistry([self]) }), { code: 'display-prefab-cycle' });

  const mutualA = nestingPrefab({ id: 'nested/mutual-a', prefabSlots: [{
    key: 'children', parentLocalPath: null,
    allowedPrefabIds: ['nested/mutual-b'], maximumInstances: 1,
  }] });
  const mutualB = nestingPrefab({ id: 'nested/mutual-b', prefabInstances: [{
    key: 'a', parentLocalPath: null, prefabId: mutualA.id,
  }] });
  const mutualRegistry = createPrefabRegistry([mutualB, mutualA]);
  assert.throws(() => mutualA.compile({ componentRegistry: components,
    resourceRegistry: resources, prefabRegistry: mutualRegistry }), { code: 'display-prefab-cycle' });

  const leaf = nestingPrefab({ id: 'nested/policy-leaf' });
  const invalidCases = [
    [nestingPrefab({ id: 'nested/bad-mount', prefabInstances: [{
      key: 'leaf', parentLocalPath: 'missing', prefabId: leaf.id,
    }] }), 'display-prefab-instance-parent-missing'],
    [nestingPrefab({ id: 'nested/bad-key', prefabInstances: [{
      key: 'bad/key', parentLocalPath: null, prefabId: leaf.id,
    }] }), 'display-prefab-instance-key-invalid'],
    [nestingPrefab({ id: 'nested/duplicate-key', prefabInstances: [{
      key: 'same', parentLocalPath: null, prefabId: leaf.id,
    }], prefabSlots: [{
      key: 'same', parentLocalPath: null, allowedPrefabIds: [leaf.id], maximumInstances: 1,
    }] }), 'display-prefab-instance-key-duplicate'],
    [nestingPrefab({ id: 'nested/empty-policy', prefabSlots: [{
      key: 'empty', parentLocalPath: null, allowedPrefabIds: [], maximumInstances: 1,
    }] }), 'display-prefab-dynamic-policy-invalid'],
    [nestingPrefab({ id: 'nested/zero-policy', prefabSlots: [{
      key: 'empty', parentLocalPath: null, allowedPrefabIds: [leaf.id], maximumInstances: 0,
    }] }), 'display-prefab-dynamic-policy-invalid'],
    [nestingPrefab({ id: 'nested/static-collision', childName: 'leaf', prefabInstances: [{
      key: 'leaf', parentLocalPath: null, prefabId: leaf.id,
    }] }), 'display-prefab-instance-key-duplicate'],
    [nestingPrefab({ id: 'nested/slot-collision', childName: 'units/one', prefabSlots: [{
      key: 'units', parentLocalPath: null, allowedPrefabIds: [leaf.id], maximumInstances: 1,
    }] }), 'display-prefab-instance-key-duplicate'],
  ];
  for (const [invalid, code] of invalidCases) {
    const registry = createPrefabRegistry([invalid, leaf]);
    assert.throws(() => invalid.compile({ componentRegistry: components,
      resourceRegistry: resources, prefabRegistry: registry }), { code });
  }
});

test('Prefab patch normalization produces complete fixed baselines and sorted slot desired state', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry();
  const leafA = nestingPrefab({ id: 'nested/state-a' });
  const leafB = nestingPrefab({ id: 'nested/state-b' });
  const owner = nestingPrefab({
    id: 'nested/state-owner',
    prefabInstances: [{
      key: 'fixed', parentLocalPath: null, prefabId: leafA.id,
      transform: matrixTransform({ position: [3, 0, 0] }), visible: false,
      state: { baseline: true },
    }],
    prefabSlots: [{
      key: 'units', parentLocalPath: null,
      allowedPrefabIds: [leafA.id, leafB.id], maximumInstances: 2,
    }],
  });
  const registry = createPrefabRegistry([owner, leafB, leafA]);
  const compiled = owner.compile({ componentRegistry: components, resourceRegistry: resources,
    prefabRegistry: registry });
  const baseline = owner.validatePatch({}, compiled);
  assert.equal(baseline.prefabInstances.length, 1);
  assert.deepEqual(matrixPosition(baseline.prefabInstances[0].transform), [3, 0, 0]);
  assert.equal(baseline.prefabInstances[0].visible, false);
  assert.deepEqual(baseline.prefabInstances[0].state, { baseline: true });
  assert.deepEqual(baseline.prefabSlots, []);

  const desired = owner.validatePatch({
    prefabInstances: { fixed: { visible: true, state: { baseline: false } } },
    prefabSlots: { units: {
      zed: { prefabId: leafB.id, state: { value: 2 } },
      alpha: { prefabId: leafA.id, transform: matrixTransform({ position: [1, 0, 0] }) },
    } },
  }, compiled);
  assert.equal(Object.isFrozen(desired.prefabInstances), true);
  assert.equal(Object.isFrozen(desired.prefabSlots), true);
  assert.deepEqual(desired.prefabSlots.map((entry) => entry.instancePath),
    ['units/alpha', 'units/zed']);
  assert.strictEqual(desired.prefabSlots[0].compiledPrefab,
    compiled.prefabSlots[0].allowedPrefabs[0].compiledPrefab);
  assert.deepEqual(matrixPosition(desired.prefabInstances[0].transform), [3, 0, 0]);

  assert.throws(() => owner.validatePatch({ prefabInstances: { missing: {} } }, compiled),
    { code: 'display-prefab-patch-target-missing' });
  assert.throws(() => owner.validatePatch({ prefabSlots: { missing: {} } }, compiled),
    { code: 'display-prefab-patch-target-missing' });
  assert.throws(() => owner.validatePatch({ prefabSlots: { units: {
    a: { prefabId: leafA.id }, b: { prefabId: leafA.id }, c: { prefabId: leafA.id },
  } } }, compiled), { code: 'display-prefab-instance-count-limit' });
  assert.throws(() => owner.validatePatch({ prefabSlots: { units: {
    a: { prefabId: owner.id },
  } } }, compiled), { code: 'display-prefab-instance-id-not-allowed' });
  assert.throws(() => owner.validatePatch({ prefabSlots: { units: {
    'bad/key': { prefabId: leafA.id },
  } } }, compiled), { code: 'display-prefab-instance-key-invalid' });
});

test('Prefab catalog accepts 128 nested roots and rejects a possible depth of 129', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry();
  const definitions = (count) => {
    const result = [nestingPrefab({ id: 'nested/depth-0' })];
    for (let index = 1; index < count; index += 1) {
      result.push(nestingPrefab({
        id: `nested/depth-${index}`,
        prefabInstances: [{
          key: 'child', parentLocalPath: null, prefabId: result[index - 1].id,
        }],
      }));
    }
    return result;
  };
  const accepted = definitions(128);
  const acceptedCatalog = compilePrefabCatalog({ prefabRegistry: createPrefabRegistry(accepted),
    componentRegistry: components, resourceRegistry: resources });
  assert.equal(acceptedCatalog.require(accepted.at(-1).id).maximumGraphHeight, 128);
  assert.throws(() => compilePrefabCatalog({ prefabRegistry: createPrefabRegistry(definitions(129)),
    componentRegistry: components, resourceRegistry: resources }),
  { code: 'display-node-depth-limit' });
});

test('Prefab catalog accepts 65,536 possible expanded nodes and rejects 65,537', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry();
  const leaf = nestingPrefab({ id: 'nested/count-leaf' });
  const owner = (maximumInstances) => nestingPrefab({
    id: `nested/count-owner-${maximumInstances}`,
    prefabSlots: [{
      key: 'children', parentLocalPath: null,
      allowedPrefabIds: [leaf.id], maximumInstances,
    }],
  });
  const accepted = owner(65_535);
  const acceptedCatalog = compilePrefabCatalog({
    prefabRegistry: createPrefabRegistry([leaf, accepted]),
    componentRegistry: components,
    resourceRegistry: resources,
  });
  assert.equal(acceptedCatalog.require(accepted.id).maximumExpandedNodeCount, 65_536);

  const rejected = owner(65_536);
  assert.throws(() => compilePrefabCatalog({
    prefabRegistry: createPrefabRegistry([leaf, rejected]),
    componentRegistry: components,
    resourceRegistry: resources,
  }), { code: 'display-prefab-expanded-node-limit' });
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
  const descriptor = { id: 'model/a', kind: 'model', url: './a.glb' };
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
    key: 'model', type: 'render.model@2', properties: { modelResourceId: 'asset/wrong' },
  }, resources), { code: 'display-resource-reference-kind-invalid' });
});

test('built-in renderer nested properties are closed before a backend sees them', () => {
  const components = createComponentRegistry();
  const resources = createResourceRegistry([
    { id: 'model/animated', kind: 'model', url: './animated.glb' },
    { id: 'texture/plain', kind: 'texture', url: './plain.png' },
    { id: 'particle/smoke', kind: 'particle', textureResourceId: 'texture/plain', maximumCapacity: 8 },
  ]);

  assert.throws(() => components.compile({
    key: 'model', type: 'render.model@2', properties: {
      modelResourceId: 'model/animated', animation: { clipId: 'idle', startTick: 0 },
    },
  }, resources), { code: 'display-component-properties-invalid' });
  assert.throws(() => components.compile({
    key: 'sprite', type: 'render.sprite@3', properties: {
      textureResourceId: 'texture/plain', width: 1, height: 1,
      flipbook: { frameCount: 2, frameTicks: 1 },
    },
  }, resources), { code: 'display-component-properties-invalid' });
  assert.throws(() => components.compile({
    key: 'particle', type: 'render.particle@2', properties: {
      particleResourceId: 'particle/smoke', animation: { startTick: 3, clock: 'visual' },
    },
  }, resources), { code: 'display-component-properties-invalid' });
  assert.throws(() => components.compile({
    key: 'particle', type: 'render.particle@2', properties: {
      particleResourceId: 'particle/smoke', parameters: { capacity: 9 },
    },
  }, resources), { code: 'display-particle-capacity-invalid' });
  assert.throws(() => components.compile({
    key: 'sun', type: 'render.directional-light@1', properties: { angleDegrees: 45 },
  }, resources), { code: 'display-component-properties-invalid' });
});

test('editor Node prefix is not part of the runtime name grammar', () => {
  assert.throws(() => assertNodeName(['editor', 'session', 'node'].join('/')),
    { code: 'display-node-name-invalid' });
});
