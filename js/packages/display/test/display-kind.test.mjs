import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineDisplayKind,
} from '../src/index.js';
import {
  IDENTITY,
  commitAuthority,
  createHarness,
  emptyPrefab,
} from './helpers.mjs';

const GAMEPLAY_TYPE = 'test.display-kind';

function authorityNode(nodeId, displayKindId, state, parentNodeId = null) {
  return {
    nodeId,
    parentNodeId,
    displayKindId,
    transformMode: 'live',
    transform: IDENTITY,
    visible: true,
    state,
  };
}

function definitions() {
  const alpha = emptyPrefab({
    id: 'visual/alpha',
    gameplayType: GAMEPLAY_TYPE,
    childName: 'alpha',
  });
  const beta = emptyPrefab({
    id: 'visual/beta',
    gameplayType: GAMEPLAY_TYPE,
    childName: 'beta',
  });
  const multi = defineDisplayKind({
    id: 'display.test/item@1',
    gameplayType: GAMEPLAY_TYPE,
    revision: 1,
    authorityPrefabIds: [beta.id, alpha.id],
    resolvePrefab(state) {
      if (state.mode === 'invalid') throw new TypeError('mode is invalid');
      if (state.mode === 'alpha') return alpha.id;
      if (state.mode === 'beta') return beta.id;
      return null;
    },
  });
  const unimplemented = defineDisplayKind({
    id: 'display.test/not-built@1',
    gameplayType: GAMEPLAY_TYPE,
    revision: 1,
    authorityPrefabIds: [],
  });
  return { alpha, beta, multi, unimplemented };
}

test('unknown and unimplemented kinds retain hierarchy and state with bounded diagnostics',
  async (t) => {
    const { alpha, beta, multi, unimplemented } = definitions();
    const transitions = [];
    const { runtime } = await createHarness({
      prefabEntries: [alpha, beta],
      displayKindEntries: [multi, unimplemented],
      runtimeOptions: { onDiagnostic: (transition) => transitions.push(transition) },
    });
    t.after(() => runtime.dispose());

    commitAuthority(runtime, () => {
      runtime.authority.createNode(authorityNode(
        0,
        'display.test/unknown@1',
        { label: 'parent' },
      ));
      runtime.authority.createNode(authorityNode(1, multi.id, { mode: 'alpha' }, 0));
    }, { commandCount: 2, sourceTickDelta: 1 });

    assert.equal(runtime.currentView().getNode('py/1').parentName, 'py/0');
    assert.notEqual(runtime.currentView().getNode('prefab/py/1/alpha'), null);
    assert.deepEqual(runtime.currentDiagnostics(), {
      schema: 'scene-engine-display-diagnostics@1',
      warningCount: 1,
      errorCount: 0,
      gaps: [{
        nodeId: 0,
        displayKindId: 'display.test/unknown@1',
        code: 'display-kind-unknown-requirement',
        severity: 'warning',
      }],
    });

    commitAuthority(runtime, () => runtime.authority.setNodeProperty({
      nodeId: 0,
      propertyName: 'count',
      value: 2,
    }));
    assert.deepEqual(
      runtime._nodeIndex.require('py/0').requireComponent('authority').state,
      { label: 'parent', count: 2 },
    );
    assert.equal(transitions.length, 1, 'the unchanged current gap is not emitted twice');

    commitAuthority(runtime, (cursor) => runtime.authority.emitNodeEvent({
      nodeId: 0,
      eventName: 'unused',
      payload: {},
      commandSeq: cursor.lastCommandSeq,
      sourceTick: cursor.sourceTick,
    }));

    commitAuthority(runtime, () => runtime.authority.setNodeDisplayKind({
      nodeId: 0,
      displayKindId: unimplemented.id,
      state: { label: 'known' },
    }));
    assert.equal(runtime.currentDiagnostics().gaps[0].code, 'display-kind-unimplemented');
    assert.equal(runtime.currentView().getNode('py/1').parentName, 'py/0');
    assert.equal(transitions.length, 2);
  });

test('state and property replacement can select, replace, lose, and regain materialization',
  async (t) => {
    const { alpha, beta, multi, unimplemented } = definitions();
    const { runtime } = await createHarness({
      prefabEntries: [alpha, beta],
      displayKindEntries: [multi, unimplemented],
    });
    t.after(() => runtime.dispose());

    commitAuthority(runtime, () => runtime.authority.createNode(
      authorityNode(0, multi.id, { mode: 'alpha' }),
    ));
    const originalRoot = runtime._nodeIndex.require('py/0');
    assert.notEqual(runtime._nodeIndex.get('prefab/py/0/alpha'), null);

    commitAuthority(runtime, () => runtime.authority.setNodeProperty({
      nodeId: 0,
      propertyName: 'mode',
      value: 'beta',
    }));
    const betaRoot = runtime._nodeIndex.require('py/0');
    assert.notStrictEqual(betaRoot, originalRoot);
    assert.equal(runtime._nodeIndex.get('prefab/py/0/alpha'), null);
    assert.notEqual(runtime._nodeIndex.get('prefab/py/0/beta'), null);

    commitAuthority(runtime, () => runtime.authority.unsetNodeProperty({
      nodeId: 0,
      propertyName: 'mode',
    }));
    assert.equal(runtime._nodeIndex.get('prefab/py/0/beta'), null);
    assert.deepEqual(runtime.currentDiagnostics().gaps, [{
      nodeId: 0,
      displayKindId: multi.id,
      code: 'display-kind-selection-unresolved',
      severity: 'error',
    }]);
    assert.deepEqual(
      runtime._nodeIndex.require('py/0').requireComponent('authority').state,
      {},
    );

    commitAuthority(runtime, () => runtime.authority.setNodeState({
      nodeId: 0,
      state: { mode: 'alpha' },
    }));
    assert.notEqual(runtime._nodeIndex.get('prefab/py/0/alpha'), null);
    assert.deepEqual(runtime.currentDiagnostics().gaps, []);
  });

test('selector exceptions fail closed without replacing current state or materialization',
  async (t) => {
    const { alpha, beta, multi, unimplemented } = definitions();
    const { runtime } = await createHarness({
      prefabEntries: [alpha, beta],
      displayKindEntries: [multi, unimplemented],
    });
    t.after(() => runtime.dispose());
    commitAuthority(runtime, () => runtime.authority.createNode(
      authorityNode(0, multi.id, { mode: 'alpha' }),
    ));
    const root = runtime._nodeIndex.require('py/0');

    assert.throws(() => commitAuthority(runtime, () => runtime.authority.setNodeState({
      nodeId: 0,
      state: { mode: 'invalid' },
    })), TypeError);
    assert.strictEqual(runtime._nodeIndex.require('py/0'), root);
    assert.notEqual(runtime._nodeIndex.get('prefab/py/0/alpha'), null);
    assert.deepEqual(root.requireComponent('authority').state, { mode: 'alpha' });
  });

test('Display Kind definitions require explicit deterministic selection policy', () => {
  assert.throws(() => defineDisplayKind({
    id: 'display.test/bad@1',
    gameplayType: GAMEPLAY_TYPE,
    revision: 1,
    authorityPrefabIds: ['visual/alpha'],
  }), { code: 'display-kind-selection-invalid' });
  assert.throws(() => defineDisplayKind({
    id: 'display.test/bad@1',
    gameplayType: GAMEPLAY_TYPE,
    revision: 1,
    authorityPrefabIds: [],
    defaultPrefabId: 'visual/alpha',
  }), { code: 'display-kind-selection-invalid' });
});
