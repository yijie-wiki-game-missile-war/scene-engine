import assert from 'node:assert/strict';
import test from 'node:test';

import { BehaviourComponent } from '../src/component/behaviour-component.js';
import { Component } from '../src/component/component.js';
import { ComponentScheduler } from '../src/component/component-scheduler.js';
import { ComponentRegistry } from '../src/component/component-registry.js';
import { NodeGraph } from '../src/node/node-graph.js';
import { NodeIndex } from '../src/node/node-index.js';
import { Node } from '../src/node/node.js';
import { RenderComponent } from '../src/render/render-component.js';
import { createResourceRegistry } from '../src/resource/resource-registry.js';
import { createInternalComponentContext } from '../src/runtime/component-context.js';
import { IDENTITY } from './helpers.mjs';


function componentContext(node, callbacks = {}) {
  const nodeIndex = new NodeIndex();
  const nodeGraph = new NodeGraph({ nodeIndex });
  nodeIndex.register(node);
  nodeGraph.attach(node);
  return createInternalComponentContext({
    scene: { name: 'main', activeCameraName: null },
    nodeIndex,
    nodeGraph,
    ...callbacks,
  });
}

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
  const context = componentContext(node, {
    componentAttached: (value) => scheduler.register(value),
    componentEnabledChanged: (value) => scheduler.setEnabled(value, value.enabled),
    componentDetaching: (value) => scheduler.unregister(value),
  });
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
  assert.throws(() => component.attach(node, componentContext(node)),
    { code: 'display-component-async-handler' });
  assert.equal(component.node, null);
  assert.equal(disposed, 1);
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('a component disposed inside onAttach is never resurrected or registered', () => {
  let registrations = 0;
  const disposalReasons = [];
  class SelfDisposingBehaviour extends BehaviourComponent {
    static typeId = 'test.self-disposing@1';
    onAttach() { this.dispose('inside-attach'); }
    onDispose(_display, reason) { disposalReasons.push(reason); }
  }
  const component = new SelfDisposingBehaviour({ key: 'self-disposing', properties: {} });
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(component);
  const context = componentContext(node, {
    componentAttached() { registrations += 1; },
  });

  assert.throws(() => component.attach(node, context), { code: 'display-component-disposed' });
  assert.equal(component.disposed, true);
  assert.equal(component.node, null);
  assert.equal(registrations, 0);
  assert.deepEqual(disposalReasons, ['attach-rollback']);
});

test('Behaviour hooks receive only read-only Display and Node views', () => {
  let received = null;
  class CapabilityProbe extends BehaviourComponent {
    static typeId = 'test.capability-probe@1';
    onAttach(display) { received = display; }
  }
  const component = new CapabilityProbe({ key: 'probe', properties: {} });
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(component);
  component.attach(node, componentContext(node));

  assert.equal(Object.isFrozen(received), true);
  assert.equal('nodeIndex' in received, false);
  assert.equal('nodeGraph' in received, false);
  assert.equal('authority' in received, false);
  assert.equal('renderSystem' in received, false);
  assert.equal(Object.isFrozen(component.node), true);
  assert.equal(component.node.name, node.name);
  assert.equal(component.node.setVisible, undefined);
  assert.equal(component.node.setLocalTransform, undefined);
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
  class EventRender extends RenderComponent {
    static typeId = 'render.test-event@1';
    static eventNames = ['hit'];
  }
  class HandlerRender extends RenderComponent {
    static typeId = 'render.test-event-handler@1';
    onEvent() {}
  }
  class PlainEventComponent extends Component {
    static typeId = 'test.plain-event@1';
    static eventNames = ['hit'];
  }
  const registry = new ComponentRegistry();
  assert.throws(() => registry.register({ ComponentClass: FinalOverride }),
    { code: 'display-component-final-method-override' });
  assert.throws(() => registry.register({ ComponentClass: BadRender }),
    { code: 'display-render-component-handler-forbidden' });
  assert.throws(() => registry.register({ ComponentClass: EventRender }),
    { code: 'display-render-component-handler-forbidden' });
  assert.throws(() => registry.register({ ComponentClass: HandlerRender }),
    { code: 'display-render-component-handler-forbidden' });
  assert.throws(() => registry.register({ ComponentClass: PlainEventComponent }),
    { code: 'display-component-event-handler-forbidden' });
});

test('Registry normalizes Behaviour event subscriptions into catalog identity', () => {
  class EventBehaviour extends BehaviourComponent {
    static typeId = 'test.events@1';
    static eventNames = ['zeta', 'event.with.dot', 'alpha'];
  }
  const registry = new ComponentRegistry();
  registry.register({ ComponentClass: EventBehaviour });
  const descriptor = registry.require(EventBehaviour.typeId);
  assert.deepEqual(descriptor.eventNames, ['alpha', 'event.with.dot', 'zeta']);
  assert.equal(Object.isFrozen(descriptor.eventNames), true);
  assert.deepEqual(registry.catalogEntries(), [{
    typeId: EventBehaviour.typeId,
    allowMultiple: false,
    tickPhase: null,
    drivesTransform: false,
    eventNames: ['alpha', 'event.with.dot', 'zeta'],
  }]);

  for (const eventNames of [
    null,
    'hit',
    ['same', 'same'],
    [''],
    ['has space'],
    ['line\nfeed'],
    ['zero\u200bwidth'],
    ['__proto__'],
    ['x'.repeat(193)],
  ]) {
    class InvalidEvents extends BehaviourComponent {
      static typeId = `test.invalid-events-${String(eventNames)}@1`;
      static eventNames = eventNames;
    }
    assert.throws(
      () => new ComponentRegistry().register({ ComponentClass: InvalidEvents }),
      { code: 'display-component-event-names-invalid' },
    );
  }
});

test('final Component methods reject class fields, constructor shadows, and runtime assignment', () => {
  class FieldShadow extends BehaviourComponent {
    static typeId = 'test.field-shadow@1';
    setAnimation = () => 'bypass';
  }
  assert.throws(() => new FieldShadow({ key: 'field', properties: {} }), TypeError);

  class ConstructorShadow extends BehaviourComponent {
    static typeId = 'test.constructor-shadow@1';
    constructor(options) {
      super(options);
      Object.defineProperty(this, 'attach', { value() {} });
    }
  }
  assert.throws(() => new ConstructorShadow({ key: 'constructor', properties: {} }), TypeError);

  const component = new ProbeBehaviour({ key: 'locked', properties: {} });
  for (const name of ['attach', 'setEnabled', 'setAnimation', 'dispose']) {
    const descriptor = Object.getOwnPropertyDescriptor(component, name);
    assert.equal(descriptor.writable, false, name);
    assert.equal(descriptor.configurable, false, name);
    assert.throws(() => Object.defineProperty(component, name, { value() {} }), TypeError, name);
  }
  assert.equal(Object.isFrozen(Object.getPrototypeOf(Object.getPrototypeOf(
    Object.getPrototypeOf(component)))), true,
    'the shared Component prototype is immutable');
});

test('setEnabled restores the prior value when its registration callback rejects', () => {
  const failure = new Error('registration rejected');
  const observed = [];
  const component = new ProbeBehaviour({ key: 'probe', properties: {} });
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(component);
  component.attach(node, componentContext(node, {
    componentEnabledChanged(value) {
      observed.push(value.enabled);
      if (!value.enabled) throw failure;
    },
  }));

  assert.throws(() => component.setEnabled(false), (error) => error === failure);
  assert.equal(component.enabled, true);
  assert.deepEqual(observed, [false, true]);
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

test('Component properties have one resource-validated atomic Registry mutation path', () => {
  class ResourceBehaviour extends BehaviourComponent { static typeId = 'test.resource@1'; }
  const registry = new ComponentRegistry();
  registry.register({
    ComponentClass: ResourceBehaviour,
    normalizeProperties(value) { return { modelResourceId: value.modelResourceId }; },
    resourceReferences(properties) {
      return [{ id: properties.modelResourceId, kinds: ['model'] }];
    },
  });
  const resources = createResourceRegistry([
    { id: 'model/first', kind: 'model', url: './first.glb' },
    { id: 'model/second', kind: 'model', url: './second.glb' },
    { id: 'texture/wrong', kind: 'texture', url: './wrong.png' },
  ]);
  const component = registry.create(registry.compile({
    key: 'resource', type: ResourceBehaviour.typeId,
    properties: { modelResourceId: 'model/first' },
  }, resources));
  const node = new Node({ name: 'scene/main/node', sceneToken: {}, transform: IDENTITY });
  node.addComponent(component);
  let changed = 0;
  component.attach(node, componentContext(node, {
    componentPropertiesChanged() { changed += 1; },
  }));

  assert.equal(component.patchProperties, undefined);
  assert.equal(component._replaceNormalizedProperties, undefined);
  const initial = component.properties;
  assert.throws(() => registry.patchComponentProperties({
    component, patch: { modelResourceId: 'model/missing' }, resourceRegistry: resources,
  }), { code: 'display-resource-missing' });
  assert.strictEqual(component.properties, initial);
  assert.equal(changed, 0);
  assert.throws(() => registry.patchComponentProperties({
    component, patch: { modelResourceId: 'texture/wrong' }, resourceRegistry: resources,
  }), { code: 'display-resource-reference-kind-invalid' });
  assert.strictEqual(component.properties, initial);
  assert.equal(changed, 0);

  registry.patchComponentProperties({
    component, patch: { modelResourceId: 'model/second' }, resourceRegistry: resources,
  });
  assert.equal(component.properties.modelResourceId, 'model/second');
  assert.equal(Object.isFrozen(component.properties), true);
  assert.equal(changed, 1);
});

test('Component package-private property mutation rejects callers without its token', () => {
  const component = new ProbeBehaviour({ key: 'probe', properties: { value: 1 } });
  let prototype = component;
  let mutation = null;
  while (prototype !== null && mutation === null) {
    prototype = Object.getPrototypeOf(prototype);
    mutation = Object.getOwnPropertySymbols(prototype ?? {}).find((symbol) =>
      symbol.description === 'scene-engine.component.replace-properties') ?? null;
  }
  assert.notEqual(mutation, null);
  assert.throws(() => component[mutation](null, Object.freeze({ value: 2 })),
    { code: 'display-component-properties-readonly' });
  assert.deepEqual(component.properties, { value: 1 });
});
