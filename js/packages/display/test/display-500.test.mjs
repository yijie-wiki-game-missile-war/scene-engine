import assert from 'node:assert/strict';
import test from 'node:test';

import { IDENTITY, createHarness } from './helpers.mjs';

test('500 authority roots share one index and preserve exact canonical identity', async (t) => {
  const { runtime } = await createHarness(); t.after(() => runtime.dispose());
  for (let index = 0; index < 500; index += 1) {
    runtime.authority.createNode({
      name: `py/node-${index}`,
      parentName: null,
      prefabType: 'test.item',
      transformMode: 'live',
      transform: { ...IDENTITY, position: [index, 0, 0] },
      visible: true,
      state: {},
    });
  }
  const view = runtime.currentView();
  assert.equal(view.nodeCount, 1003);
  assert.deepEqual(view.getNode('py/node-499').localTransform.position, [499, 0, 0]);
  assert.equal(view.getNode('prefab/py/node-499/body').parentName, 'py/node-499');
  assert.equal(view.getAuthorityOwner('prefab/py/node-499/body'), 'py/node-499');
});
