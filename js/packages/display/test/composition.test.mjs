import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RENDER_COMPOSITION_SCHEMA,
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  definePrefab,
  defineRenderComposition,
  defineScene,
} from '@scene-engine/display';

import { IDENTITY, RENDERER_PROFILE, commitAuthority, createHarness } from './helpers.mjs';

const PLAN = Object.freeze({
  schema: RENDER_COMPOSITION_SCHEMA,
  id: 'gameplay-view',
  revision: 1,
  defaultGroup: 'ordinary-ground',
  groups: Object.freeze([
    Object.freeze({ id: 'terrain' }),
    Object.freeze({ id: 'ordinary-ground' }),
    Object.freeze({ id: 'foreground-subject' }),
  ]),
  passes: Object.freeze([
    Object.freeze({ id: 'base', kind: 'protected-base', groups: Object.freeze(['terrain']) }),
    Object.freeze({ id: 'ordinary', kind: 'ordinary', groups: Object.freeze(['ordinary-ground']) }),
    Object.freeze({ id: 'foreground', kind: 'foreground', groups: Object.freeze(['foreground-subject']) }),
  ]),
});

const RESOURCES = Object.freeze([
  Object.freeze({ id: 'mesh/triangle', kind: 'mesh', positions: Object.freeze([
    -1, -1, 0, 1, -1, 0, 0, 1, 0,
  ]), indices: Object.freeze([0, 1, 2]) }),
  Object.freeze({ id: 'material/standard', kind: 'material', family: 'material.standard',
    properties: Object.freeze({ tintRgba: 0xffff_ffff, opacity: 1, emissive: 0,
      alphaMode: 'opaque', alphaCutoff: 0 }) }),
]);

const MESH = Object.freeze({
  key: 'mesh',
  type: 'render.mesh@1',
  properties: Object.freeze({
    meshResourceId: 'mesh/triangle',
    materialResourceId: 'material/standard',
    castShadow: false,
    receiveShadow: false,
    renderOrder: 0,
    pickable: true,
  }),
});

test('composition plan is closed, ordered, complete, and catalog-safe', () => {
  assert.deepEqual(defineRenderComposition(PLAN), PLAN);
  for (const invalid of [
    { ...PLAN, defaultGroup: 'missing' },
    { ...PLAN, groups: [...PLAN.groups, { id: 'terrain' }] },
    { ...PLAN, passes: [...PLAN.passes].reverse() },
    { ...PLAN, passes: PLAN.passes.map((pass, index) => index === 2
      ? { ...pass, groups: ['ordinary-ground'] } : pass) },
  ]) assert.throws(() => defineRenderComposition(invalid));

  const components = createComponentRegistry();
  const resources = createResourceRegistry(RESOURCES);
  const prefabs = createPrefabRegistry();
  const scene = defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'invalid-membership',
    sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE,
    compositionPlan: PLAN,
    activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'camera', type: 'render.camera@1', properties: {
        projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100,
      } }],
    }, {
      localName: 'bad', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'composition', type: 'render.composition@1',
        properties: { group: 'missing' } }, MESH],
    }],
    prefabInstances: [],
  });
  assert.throws(() => scene.compile({ componentRegistry: components,
    resourceRegistry: resources, prefabRegistry: prefabs }),
  { code: 'display-render-composition-group-missing' });
});

test('nearest enabled membership is inherited by drawable bindings', async () => {
  const { runtime, frames, fakeBackends } = await createHarness({
    resources: RESOURCES,
    compositionPlan: PLAN,
    sceneNodes: [{
      localName: 'subject', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'composition', type: 'render.composition@1',
        properties: { group: 'foreground-subject' } }],
    }, {
      localName: 'body', parentLocalName: 'subject', transform: IDENTITY,
      components: [MESH],
    }, {
      localName: 'shadow', parentLocalName: 'subject', transform: IDENTITY,
      components: [{ key: 'composition', type: 'render.composition@1',
        properties: { group: 'ordinary-ground' } }, { ...MESH, key: 'shadow' }],
    }],
  });
  runtime.start();
  await runtime.whenReady();
  frames.step();
  const body = fakeBackends[0].bindings.get(JSON.stringify(['scene/main/body', 'mesh']));
  const shadow = fakeBackends[0].bindings.get(JSON.stringify(['scene/main/shadow', 'shadow']));
  assert.equal(body.descriptor.compositionGroup, 'foreground-subject');
  assert.equal(body.patch.compositionGroup, 'foreground-subject');
  assert.equal(shadow.descriptor.compositionGroup, 'ordinary-ground');
  assert.equal(shadow.patch.compositionGroup, 'ordinary-ground');
  await runtime.rebuildRenderBackend();
  await runtime.whenReady();
  frames.step();
  const rebuiltBody = fakeBackends[1].bindings.get(JSON.stringify(['scene/main/body', 'mesh']));
  assert.equal(rebuiltBody.descriptor.compositionGroup, 'foreground-subject');
  assert.equal(rebuiltBody.patch.compositionGroup, 'foreground-subject');
  await runtime.dispose();
});

test('dynamic membership changes before draw and unknown groups fail the commit', async () => {
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'subject',
    gameplayType: 'subject',
    root: {
      components: [{ key: 'composition', type: 'render.composition@1',
        properties: { group: 'ordinary-ground' } }],
      children: [{
        localName: 'body', transform: IDENTITY, visible: true, components: [MESH], children: [],
      }],
    },
    resolveState(state) {
      return { nodes: {}, components: { '$root/composition': { group: state.group } } };
    },
  });
  const { runtime, frames, fakeBackends } = await createHarness({
    resources: RESOURCES,
    compositionPlan: PLAN,
    prefabEntries: [prefab],
  });
  commitAuthority(runtime, () => runtime.authority.createNode({
    nodeId: 0,
    parentNodeId: null,
    displayKindId: 'subject',
    transformMode: 'live',
    transform: IDENTITY,
    visible: true,
    state: { group: 'ordinary-ground' },
  }));
  runtime.start();
  await runtime.whenReady();
  frames.step();
  const binding = fakeBackends[0].bindings.get(JSON.stringify(['prefab/py/0/body', 'mesh']));
  assert.equal(binding.patch.compositionGroup, 'ordinary-ground');

  commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0,
    state: { group: 'foreground-subject' },
  }));
  frames.step();
  assert.equal(binding.patch.compositionGroup, 'foreground-subject');

  const cursor = runtime.summary().cursor;
  assert.throws(() => commitAuthority(runtime, () => runtime.authority.setNodeState({
    nodeId: 0,
    state: { group: 'missing' },
  })), { code: 'display-render-composition-group-missing' });
  assert.deepEqual(runtime.summary().cursor, cursor);
  await runtime.dispose();
});
