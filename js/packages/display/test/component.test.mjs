import assert from 'node:assert/strict';
import test from 'node:test';

import { BehaviourComponent } from '../src/component/behaviour-component.js';
import { ComponentScheduler } from '../src/component/component-scheduler.js';
import { ComponentRegistry } from '../src/component/component-registry.js';
import { Node } from '../src/node/node.js';
import { RenderComponent } from '../src/render/render-component.js';
import { IDENTITY } from './helpers.mjs';

class ProbeBehaviour extends BehaviourComponent {
  static typeId = 'test.probe@1';
  static tickPhase = 'update';
  onAttach() { this.events = ['attach']; }
  tick() { this.events.push('tick'); }
  onDispose(_context, reason) { this.events.push(`dispose:${reason}`); }
}

test('Component attach/tick/dispose is synchronous, ordered, and idempotent', () => {
  const scheduler = new ComponentScheduler();
  const component = new ProbeBehaviour({ key: 'probe', properties: {} });
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(component);
  const context = {
    componentAttached: (value) => scheduler.register(value),
    componentEnabledChanged: (value) => scheduler.setEnabled(value, value.enabled),
    componentDetaching: (value) => scheduler.unregister(value),
  };
  component.attach(node, context); scheduler.runUpdate({});
  component.setEnabled(false); scheduler.runUpdate({});
  assert.deepEqual(component.events, ['attach', 'tick']);
  assert.deepEqual(component.dispose('test'), []);
  assert.deepEqual(component.dispose('again'), []);
  assert.deepEqual(component.events, ['attach', 'tick', 'dispose:test']);
});

test('Promise-returning handlers fail attach, consume rejection, and do not stay attached', async () => {
  let disposed = 0;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  class AsyncBehaviour extends BehaviourComponent {
    static typeId = 'test.async@1';
    onAttach() { return Promise.reject(new Error('late rejection')); }
    onDispose() { disposed += 1; }
  }
  const component = new AsyncBehaviour({ key: 'async', properties: {} });
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(component);
  assert.throws(() => component.attach(node, {}), { code: 'display-component-async-handler' });
  assert.equal(component.node, null);
  assert.equal(disposed, 1);
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('Scheduler snapshot makes additions next-round and removals immediate', () => {
  const scheduler = new ComponentScheduler(); const events = [];
  class Dynamic extends BehaviourComponent {
    static typeId = 'test.dynamic@1'; static tickPhase = 'update'; static allowMultiple = true;
    constructor(key, action = null) { super({ key, properties: {} }); this.action = action; }
    tick() { events.push(this.key); this.action?.(); }
  }
  const first = new Dynamic('first'); const second = new Dynamic('second'); const added = new Dynamic('added');
  first.action = () => { scheduler.unregister(second); scheduler.register(added); };
  scheduler.register(first); scheduler.register(second);
  scheduler.runUpdate({});
  assert.deepEqual(events, ['first']);
  first.action = null; scheduler.runUpdate({});
  assert.deepEqual(events, ['first', 'first', 'added']);
});

test('Registry rejects final overrides and RenderComponent handlers', () => {
  class FinalOverride extends BehaviourComponent {
    static typeId = 'test.final@1';
    attach() {}
  }
  class BadRender extends RenderComponent {
    static typeId = 'render.test-bad@1';
    tick() {}
  }
  const registry = new ComponentRegistry();
  assert.throws(() => registry.register({ ComponentClass: FinalOverride }),
    { code: 'display-component-final-method-override' });
  assert.throws(() => registry.register({ ComponentClass: BadRender }),
    { code: 'display-render-component-handler-forbidden' });
});

test('one Node rejects two transform-driving components', () => {
  class Driver extends BehaviourComponent {
    static typeId = 'test.driver@1'; static allowMultiple = true; static drivesTransform = true;
  }
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(new Driver({ key: 'a', properties: {} }));
  assert.throws(() => node.addComponent(new Driver({ key: 'b', properties: {} })),
    { code: 'display-transform-driver-conflict' });
});
