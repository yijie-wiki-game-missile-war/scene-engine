import assert from 'node:assert/strict';
import test from 'node:test';
import { BehaviourComponent, definePrefab, PREFAB_DEFINITION_SCHEMA } from '../src/index.js';
import { createHarness, commitAuthority, IDENTITY } from './helpers.mjs';

for (const renderKind of ['mesh', 'sprite']) for (const failurePoint of ['immediate', 'later']) {
test(`${renderKind} failed retained Prefab reconciliation restores program inputs after ${failurePoint} callback failure`, async t => {
  let driver;
  class Driver extends BehaviourComponent {
    static typeId = 'test.program-rollback-driver';
    constructor(options) { super(options); driver = this; }
  }
  const program = id => ({ id, kind: 'program', revision: 1, language: 'glsl-module@1', stage: 'surface',
    source: 'vec4 evaluate(ProgramInput d){return vec4(p_amount);}', textureSlots: {},
    parameterSchema: { amount: { type: 'float', default: .2, min: 0, max: 1, updateable: true } } });
  const material = id => ({ id: `material-${id}`, kind: 'material', family: 'material.program',
    programResourceId: id, textures: {}, parameters: {} });
  const prefab = definePrefab({ schema: PREFAB_DEFINITION_SCHEMA, id: 'test.program-rollback', gameplayType: 'test.program-rollback',
    root: { components: [
      { key: 'visual', type: renderKind === 'mesh' ? 'render.mesh@1' : 'render.sprite@3', properties: {
        ...(renderKind === 'mesh' ? { meshResourceId: 'mesh' }
          : { width: 2, height: 1, projectionSemantics: 'anchor-extent', pivot: [.5, 0] }),
        materialResourceId: 'material-a' } },
      { key: 'driver', type: Driver.typeId, properties: { fail: false } },
    ], children: [] },
    resolveState(state) { return { components: {
      '$root/visual': { materialResourceId: state.replace ? 'material-b' : 'material-a' },
      '$root/driver': { fail: state.replace },
    } }; },
  });
  const h = await createHarness({ prefabEntries: [prefab], configureComponents(r) { r.register({ ComponentClass: Driver }); },
    resources: [program('a'), program('b'), material('a'), material('b'),
      { id: 'mesh', kind: 'mesh', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] });
  t.after(() => h.runtime.dispose());
  commitAuthority(h.runtime, () => h.runtime.authority.createNode({ nodeId: 0, parentNodeId: null,
    displayKindId: prefab.id, transformMode: 'live', transform: IDENTITY, visible: true, state: { replace: false } }));
  await h.runtime.whenReady(); h.runtime.start(); h.frames.step();
  driver.setProgramParameters('visual', { amount: .9 }); h.frames.step();
  // Inject a later live registration callback failure, after a retained render
  // component has switched programs. This exercises the transaction undo path.
  const changed = h.runtime._componentPropertiesChanged.bind(h.runtime);
  h.runtime._componentPropertiesChanged = component => {
    changed(component);
    if ((failurePoint === 'later' && component === driver && component.properties.fail)
      || (failurePoint === 'immediate' && component.key === 'visual'
        && component.properties.materialResourceId === 'material-b')) throw new Error('injected-retained-callback-failure');
  };
  assert.throws(() => commitAuthority(h.runtime, () => h.runtime.authority.setNodeState({ nodeId: 0, state: { replace: true } })),
    /injected-retained-callback-failure/);
  const target = h.runtime._nodeIndex.require('py/0').requireComponent('visual');
  assert.equal(target.properties.materialResourceId, 'material-a');
  const restored = h.runtime._programInputSystem.targets.get(target);
  assert.equal(restored?.requester, driver);
  assert.equal(restored?.values.amount, .9);
});
}
