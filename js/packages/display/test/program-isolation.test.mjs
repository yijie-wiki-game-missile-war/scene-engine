import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeRenderBackend } from '../src/testing/fake-render-backend.js';
import { IDENTITY, commitAuthority, createHarness } from './helpers.mjs';

test('an isolated program diagnostic retains shared runtime health and accepts the next Authority ACK', async (t) => {
  const fake = createFakeRenderBackend(), events = []; let report;
  const { runtime } = await createHarness({ backendFactory(options) { report = options.onHealth; return fake.backend; },
    onHealth(event) { events.push(event); } });
  t.after(() => runtime.dispose());
  const before = runtime.summary().cursor;
  report({ phase: 'render', nodeName: 'py/0', componentKey: 'visual', resourceId: 'program/broken',
    revision: 2, programStage: 'surface', affectedBindingCount: 1, diagnostic: 'bounded compiler message',
    isolation: 'program', errorCode: 'three-program-compile-failed', recoverable: true });
  assert.equal(runtime.summary().health, 'ready');
  assert.equal(events.at(-1).severity, 'warning');
  assert.equal(events.at(-1).revision, 2);
  assert.equal(events.at(-1).diagnostic, 'bounded compiler message');
  commitAuthority(runtime, () => runtime.authority.createNode({ nodeId: 0, parentNodeId: null,
    displayKindId: 'target.test.item', transformMode: 'live', transform: IDENTITY, visible: true, state: {} }),
  { sourceTickDelta: 1, commandCount: 1 });
  assert.equal(runtime.summary().cursor.commitSeq, before.commitSeq + 1);
  assert.notEqual(runtime.currentView().getNode('py/0'), null);
  report({ phase: 'render', errorCode: 'three-upper-field-device-unsupported', recoverable: true });
  assert.equal(runtime.summary().health, 'renderer-unhealthy');
});
