import assert from 'node:assert/strict';
import test from 'node:test';

import { IDENTITY, createHarness } from './helpers.mjs';

test('local edit port is opt-in and never edits authority-owned nodes', async (t) => {
  const production = await createHarness();
  t.after(() => production.runtime.dispose());
  assert.equal(production.runtime.localEdit, null);

  const { runtime } = await createHarness({ authoringMode: true });
  t.after(() => runtime.dispose());
  runtime.authority.createNode({
    name: 'py/owned', parentName: null, prefabType: 'test.item', transformMode: 'live',
    transform: IDENTITY, visible: true, state: {},
  });
  assert.throws(() => runtime.localEdit.setNodeVisible({ name: 'py/owned', visible: false }),
    { code: 'display-local-edit-scope-forbidden' });
  assert.throws(() => runtime.localEdit.setNodeVisible({
    name: 'prefab/py/owned/body', visible: false,
  }), { code: 'display-local-edit-scope-forbidden' });
});

test('local edit port instantiates an editor prefab and uses final node methods', async (t) => {
  const { runtime } = await createHarness({ authoringMode: true });
  t.after(() => runtime.dispose());
  runtime.localEdit.instantiatePrefab({
    name: 'editor/session/subject', parentName: null, prefabType: 'test.item',
    transform: IDENTITY, visible: true, state: {},
  });
  assert.equal(runtime.currentView().getNode('editor/session/subject').parentName, 'sys/scene-root');
  assert.equal(runtime.currentView().getNode('prefab/editor/session/subject/body').parentName,
    'editor/session/subject');
  runtime.localEdit.setNodeTransform({
    name: 'editor/session/subject',
    transform: { ...IDENTITY, position: [4, 2, -1] },
  });
  runtime.localEdit.setNodeVisible({
    name: 'prefab/editor/session/subject/body', visible: false,
  });
  assert.deepEqual(runtime.currentView().getNode('editor/session/subject').localTransform.position,
    [4, 2, -1]);
  assert.equal(runtime.currentView().getNode('prefab/editor/session/subject/body').visibleSelf, false);
  assert.deepEqual(runtime.localEdit.capture().editorRootNames, ['editor/session/subject']);
  runtime.localEdit.removeNode({ name: 'editor/session/subject' });
  assert.equal(runtime.currentView().getNode('editor/session/subject'), null);
  assert.equal(runtime.currentView().getNode('prefab/editor/session/subject/body'), null);
});

test('local edit component patches share registry validation', async (t) => {
  const { runtime } = await createHarness({ authoringMode: true });
  t.after(() => runtime.dispose());
  runtime.localEdit.setComponentProperties({
    name: 'scene/main/camera', componentKey: 'camera', patch: { fovYDegrees: 65 },
  });
  assert.equal(runtime.currentView().getComponentState('scene/main/camera', 'camera')
    .properties.fovYDegrees, 65);
  runtime.localEdit.setComponentEnabled({
    name: 'scene/main/camera', componentKey: 'camera', enabled: false,
  });
  assert.equal(runtime.currentView().getComponentState('scene/main/camera', 'camera').enabled, false);
});
