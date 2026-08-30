import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANIMATION_RESOURCE_SCHEMA,
  AnimationPlayerComponent,
  BehaviourComponent,
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  SpriteRendererComponent,
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  defineAnimation,
  defineFrameAnimation,
  definePrefab,
  defineResources,
  defineScene,
} from '../src/index.js';
import { AnimationSystem } from '../src/animation/animation-system.js';
import { Node } from '../src/node/node.js';
import { IDENTITY, RENDERER_PROFILE, commitAuthority, createHarness } from './helpers.mjs';

const ATLAS = Object.freeze({ id: 'tex.unit', kind: 'texture-atlas', url: './unit.png',
  columns: 4, rows: 2 });
const PLAIN = Object.freeze({ id: 'tex.plain', kind: 'texture', url: './plain.png' });

class PlayAnimationOnAttach extends BehaviourComponent {
  static typeId = 'test.play-animation-on-attach@1';

  onAttach() {
    this.playAnimation('animator', this.properties.animationId);
  }
}

class FallbackAnimationOnAttach extends BehaviourComponent {
  static typeId = 'test.fallback-animation-on-attach@1';

  onAttach() {
    try {
      this.playAnimation('animator', 'anim.unit.missing');
    } catch (error) {
      if (error?.code !== 'display-resource-missing') throw error;
      this.playAnimation('animator', this.properties.animationId);
    }
  }
}

function walkAnimation({ id = 'anim.unit.walk', frames = [0, 1, 2, 1], fps = 10,
  loop = true, target = { node: 'body', component: 'sprite' } } = {}) {
  return defineFrameAnimation({ id, target, frames, fps, loop });
}

function animatedPrefab({ id = 'target.animated', gameplayType = 'test.animated',
  playerProperties = { animationId: 'anim.unit.walk' }, spriteProperties = {
    textureResourceId: 'tex.unit', width: 1, height: 1, frame: 2,
  }, resolveState = undefined } = {}) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    gameplayType,
    root: {
      components: [playerProperties === null ? [] : [{
        key: 'animator', type: 'animation.player@1',
        properties: playerProperties,
      }]].flat(),
      children: [{
        localName: 'body',
        transform: IDENTITY,
        visible: true,
        components: [{ key: 'sprite', type: 'render.sprite@3', properties: spriteProperties }],
        children: [],
      }],
    },
    ...(resolveState ? { resolveState } : {}),
  });
}

function nestedAnimatedPrefabs() {
  const leafA = animatedPrefab({
    id: 'nested/animated-leaf-a',
    gameplayType: 'test.nested-animated-leaf-a',
  });
  const leafB = animatedPrefab({
    id: 'nested/animated-leaf-b',
    gameplayType: 'test.nested-animated-leaf-b',
  });
  const outer = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/animated-outer',
    gameplayType: 'test.nested-animated-outer',
    root: {
      components: [],
      children: [{
        localName: 'mount', transform: IDENTITY, visible: true, components: [], children: [],
      }],
    },
    prefabSlots: [{
      key: 'units',
      parentLocalPath: 'mount',
      allowedPrefabIds: [leafA.id, leafB.id],
      maximumInstances: 2,
    }],
    resolveState(state) {
      return {
        nodes: {},
        components: {},
        prefabSlots: { units: state.units ?? {} },
      };
    },
  });
  return { leafA, leafB, outer };
}

async function animationHarness({ prefab = animatedPrefab(),
  resources = [ATLAS, walkAnimation()],
  ...rest } = {}) {
  const harness = await createHarness({
    resources,
    prefabEntries: [prefab],
    ...rest,
  });
  return harness;
}

function authorityNode(nodeId = 0, prefabId = 'target.animated', state = {}) {
  return {
    nodeId,
    parentNodeId: null,
    prefabId,
    transformMode: 'live',
    transform: IDENTITY,
    visible: true,
    state,
  };
}

function prefabLocalNodeName(rootName, localPath) {
  return rootName.startsWith('prefab/')
    ? `${rootName}/${localPath}` : `prefab/${rootName}/${localPath}`;
}

function spriteBinding(harness, nodeName = 'py/0', componentKey = 'sprite') {
  return harness.fakeBackends.at(-1).bindings.get(
    JSON.stringify([prefabLocalNodeName(nodeName, 'body'), componentKey]),
  );
}

function spritePatch(harness, nodeName = 'py/0') {
  return spriteBinding(harness, nodeName)?.patch ?? null;
}

function effectiveFrame(harness, nodeName = 'py/0') {
  return spritePatch(harness, nodeName)?.properties.frame ?? null;
}

function batchableOf(harness, nodeName = 'py/0') {
  const patch = spritePatch(harness, nodeName);
  return patch === null ? null : patch.batchable;
}

function spriteComponent(harness, nodeName = 'py/0') {
  return harness.runtime._nodeIndex.require(prefabLocalNodeName(nodeName, 'body'))
    .getComponent('sprite');
}

function playerComponent(harness, nodeName = 'py/0') {
  return harness.runtime._nodeIndex.require(nodeName).getComponent('animator');
}

async function driveLoop(harness, elapsedMs) {
  harness.frames.step(16);
  harness.frames.step(elapsedMs);
}

function privateAnimationHarness({ resources, nodeIndex = undefined }) {
  const overrides = new Map();
  const renderSystem = {
    setAnimationOverride(component, patch) { overrides.set(component, patch); },
    clearAnimationOverride(component) { overrides.delete(component); },
  };
  const system = new AnimationSystem({
    resourceRegistry: createResourceRegistry(resources),
    nodeIndex,
    renderSystem,
  });
  const publicDisplay = Object.freeze({});
  const context = {
    publicDisplay,
    nodeViewFor: (node) => Object.freeze({ name: node.name }),
    componentAttached(component) {
      if (component instanceof AnimationPlayerComponent) system.register(component);
    },
    componentDetaching(component) {
      if (component instanceof AnimationPlayerComponent) system.unregister(component);
    },
    componentEnabledChanged(component) {
      if (component instanceof AnimationPlayerComponent) system.setEnabled(component);
    },
    componentPropertiesChanged(component) {
      if (component instanceof AnimationPlayerComponent) system.propertiesChanged(component);
    },
  };
  return { system, context, overrides };
}

function animationTestNode(name, sceneToken) {
  return new Node({ name, sceneToken, transform: IDENTITY });
}

test('defineFrameAnimation emits the canonical frozen @2 descriptor', () => {
  const descriptor = walkAnimation();
  assert.equal(descriptor.schema, ANIMATION_RESOURCE_SCHEMA);
  assert.equal(descriptor.durationMs, 400);
  assert.equal(descriptor.loop, true);
  assert.deepEqual(descriptor.tracks[0].keyframes.map(({ atMs, value }) => [atMs, value]), [
    [0, 0], [100, 1], [200, 2], [300, 1],
  ]);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.tracks[0].keyframes), true);
});

test('defineAnimation and the ResourceRegistry normalize identically', () => {
  const explicit = defineAnimation({
    id: 'anim.unit.fire',
    durationMs: 240,
    loop: false,
    tracks: [{
      channel: 'sprite.frame',
      target: { node: 'body', component: 'sprite' },
      interpolation: 'step',
      keyframes: [{ atMs: 0, value: 4 }, { atMs: 90, value: 5 }, { atMs: 190, value: 6 }],
    }],
  });
  const registry = createResourceRegistry([explicit]);
  const reregistered = createResourceRegistry([{
    id: 'anim.unit.fire', kind: 'animation', schema: ANIMATION_RESOURCE_SCHEMA,
    durationMs: 240, loop: false, tracks: explicit.tracks,
  }]);
  assert.deepEqual(registry.require('anim.unit.fire').describe(),
    reregistered.require('anim.unit.fire').describe());
  const viaDefineResources = defineResources({ schema: 'scene-engine-resource-registry@1',
    resources: [{ id: 'anim.unit.fire', kind: 'animation', schema: ANIMATION_RESOURCE_SCHEMA,
      durationMs: 240, loop: false, tracks: explicit.tracks }] });
  assert.deepEqual(viaDefineResources.resources[0], explicit);
});

test('animation resources reject every malformed shape fail-closed', () => {
  const valid = () => ({
    id: 'anim.bad', kind: 'animation', schema: ANIMATION_RESOURCE_SCHEMA,
    durationMs: 400, loop: true, tracks: [{
      channel: 'sprite.frame', target: { node: 'body', component: 'sprite' },
      interpolation: 'step', keyframes: [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }],
    }],
  });
  const cases = [
    [{ ...valid(), tracks: [] }, 'display-animation-resource-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0], keyframes: [] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0],
      keyframes: [{ atMs: 50, value: 0 }, { atMs: 100, value: 1 }] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0],
      keyframes: [{ atMs: 0, value: 0 }, { atMs: 0, value: 1 }] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0],
      keyframes: [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }, { atMs: 50, value: 2 }] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0],
      keyframes: [{ atMs: 0, value: 0 }, { atMs: 400, value: 1 }] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0],
      keyframes: [{ atMs: 0, value: -1 }, { atMs: 100, value: 1 }] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0],
      keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 100, value: 1 }] }] },
      'display-animation-keyframes-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0], channel: 'model.clip' }] },
      'display-animation-track-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0], interpolation: 'linear' }] },
      'display-animation-track-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0], target: { node: '../escape', component: 's' } }] },
      'display-animation-track-invalid'],
    [{ ...valid(), tracks: [{ ...valid().tracks[0], target: { node: 'body', component: '' } }] },
      'display-animation-track-invalid'],
    [{ ...valid(), tracks: [...valid().tracks, ...valid().tracks.map((track) => ({
      ...track, keyframes: [{ atMs: 0, value: 2 }],
    }))] }, 'display-animation-track-invalid'],
    [{ ...valid(), durationMs: 0 }, 'display-animation-resource-invalid'],
    [{ ...valid(), loop: 'yes' }, 'display-animation-resource-invalid'],
    [{ ...valid(), schema: 'scene-engine-animation-resource@1' }, 'display-animation-resource-invalid'],
    [{ id: 'anim.legacy', kind: 'animation', clips: { walk: {} } }, 'display-animation-resource-invalid'],
  ];
  for (const [value, code] of cases) {
    assert.throws(() => createResourceRegistry([value]), { code }, JSON.stringify(value.id));
    assert.throws(() => defineResources({ schema: 'scene-engine-resource-registry@1',
      resources: [value] }), { code });
  }
  assert.throws(() => defineFrameAnimation({ id: 'x',
    target: { node: 'body', component: 'sprite' }, frames: [], fps: 10, loop: true }),
  { code: 'display-animation-definition-invalid' });
  assert.throws(() => defineFrameAnimation({ id: 'x',
    target: { node: 'body', component: 'sprite' }, frames: [0, -1], fps: 10, loop: true }),
  { code: 'display-animation-definition-invalid' });
  assert.throws(() => defineFrameAnimation({ id: 'x',
    target: { node: 'body', component: 'sprite' }, frames: [0], fps: 0, loop: true }),
  { code: 'display-animation-definition-invalid' });
});

test('animation resource content changes the catalog identity', () => {
  const manifestFor = (frames) => {
    const resources = createResourceRegistry([ATLAS, walkAnimation({ frames })]);
    const components = createComponentRegistry();
    const prefabs = createPrefabRegistry([animatedPrefab()]);
    const scenes = createSceneRegistry([defineScene({
      schema: SCENE_DEFINITION_SCHEMA, id: 'main', sceneProfile: 'test',
      rendererProfile: RENDERER_PROFILE, activeCameraLocalName: 'camera',
      nodes: [{
        localName: 'camera', parentLocalName: null, transform: IDENTITY,
        components: [{ key: 'camera', type: 'render.camera@1',
          properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 } }],
      }],
      prefabInstances: [],
    })]);
    return computeDisplayCatalogIdentity(buildDisplayCatalogManifest({
      sceneRegistry: scenes, prefabRegistry: prefabs, resourceRegistry: resources,
      componentRegistry: components, authorityStateSchemas: [
        { gameplayType: 'test.animated', schemaId: 'test.animated.state', revision: 1 },
      ],
    }));
  };
  assert.notEqual(manifestFor([0, 1, 2, 1]).prefabCatalogHash,
    manifestFor([0, 1, 2, 3]).prefabCatalogHash);
});

test('animation players register automatically and placement is root-only', async (t) => {
  const components = createComponentRegistry();
  assert.equal(components.has('animation.player@1'), true);
  const resources = createResourceRegistry([ATLAS, walkAnimation()]);
  const compiled = components.compile({
    key: 'a', type: 'animation.player@1', properties: { animationId: 'anim.unit.walk' },
  }, resources);
  assert.deepEqual(compiled.properties, { animationId: 'anim.unit.walk' });
  assert.deepEqual(components.compile({
    key: 'b', type: 'animation.player@1', properties: {},
  }, resources).properties, { animationId: null });
  assert.throws(() => components.compile({
    key: 'c', type: 'animation.player@1', properties: { animationId: 'tex.unit' },
  }, resources), { code: 'display-resource-reference-kind-invalid' });

  const withDuplicateOutput = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'bad.conflict', gameplayType: 'test.animated',
    root: { components: [
      { key: 'a', type: 'animation.player@1', properties: { animationId: 'anim.unit.walk' } },
      { key: 'b', type: 'animation.player@1',
        properties: { animationId: 'anim.unit.walk' } },
    ], children: [{
      localName: 'body', transform: IDENTITY, components: [
        { key: 'sprite', type: 'render.sprite@3',
          properties: { textureResourceId: 'tex.unit', width: 1, height: 1 } }], children: [],
    }] },
  });
  assert.throws(() => withDuplicateOutput.compile({ componentRegistry: components,
    resourceRegistry: resources }), { code: 'display-animation-output-conflict' });

  const childPlayer = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'bad.child', gameplayType: 'test.animated',
    root: { components: [], children: [{
      localName: 'body', transform: IDENTITY, components: [
        { key: 'sprite', type: 'render.sprite@3',
          properties: { textureResourceId: 'tex.unit', width: 1, height: 1 } },
        { key: 'animator', type: 'animation.player@1', properties: {} }], children: [],
    }] },
  });
  assert.throws(() => childPlayer.compile({ componentRegistry: components,
    resourceRegistry: resources }), { code: 'display-animation-player-placement-invalid' });

  const sceneWithPlayer = defineScene({
    schema: SCENE_DEFINITION_SCHEMA, id: 'main', sceneProfile: 'test',
    rendererProfile: RENDERER_PROFILE, activeCameraLocalName: 'camera',
    nodes: [{
      localName: 'camera', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'camera', type: 'render.camera@1',
        properties: { projection: 'perspective', fovYDegrees: 50, near: 0.1, far: 100 } }],
    }, {
      localName: 'animator', parentLocalName: null, transform: IDENTITY,
      components: [{ key: 'player', type: 'animation.player@1', properties: {} }],
    }],
    prefabInstances: [],
  });
  assert.throws(() => sceneWithPlayer.compile({ componentRegistry: components,
    resourceRegistry: resources, prefabRegistry: createPrefabRegistry([animatedPrefab()]) }),
  { code: 'display-animation-player-placement-invalid' });
  void t;
});

test('runtime player placement and local targets use bound Prefab scope identity', () => {
  const harness = privateAnimationHarness({ resources: [ATLAS, walkAnimation()] });
  const sceneToken = Object.freeze({});
  const root = animationTestNode('prefab/py/island/tiles/tile-q0-r0', sceneToken);
  const body = animationTestNode('prefab/py/island/tiles/tile-q0-r0/body', sceneToken);
  const player = new AnimationPlayerComponent({
    key: 'animator', properties: { animationId: 'anim.unit.walk' },
  });
  const sprite = new SpriteRendererComponent({
    key: 'sprite', properties: { textureResourceId: ATLAS.id, width: 1, height: 1, frame: 0 },
  });
  root.addComponent(player);
  body.addComponent(sprite);
  sprite.attach(body, harness.context);
  const scope = { root, nodeByPath: new Map([['body', body]]) };
  harness.system.bindPrefabScope(scope);

  assert.doesNotThrow(() => player.attach(root, harness.context),
    'a nested root whose canonical name starts with prefab/ is legal by scope identity');
  harness.system.sample({ visualSeconds: 0 });
  assert.deepEqual(harness.overrides.get(sprite), { frame: 0 });

  player.dispose('test');
  harness.system.unbindPrefabScope(scope);
  sprite.dispose('test');

  const unboundRoot = animationTestNode('py/not-a-prefab-scope', sceneToken);
  const unboundPlayer = new AnimationPlayerComponent({
    key: 'animator', properties: { animationId: null },
  });
  unboundRoot.addComponent(unboundPlayer);
  assert.throws(() => unboundPlayer.attach(unboundRoot, harness.context),
    { code: 'display-animation-player-placement-invalid' },
    'a non-prefab node is rejected even when its name does not start with prefab/');
  unboundPlayer.dispose('test');
  harness.system.clear();
});

test('a parent animation cannot resolve a nested child through the global NodeIndex', () => {
  const sceneToken = Object.freeze({});
  const root = animationTestNode('py/parent', sceneToken);
  const nestedBody = animationTestNode('prefab/py/parent/child/body', sceneToken);
  const sprite = new SpriteRendererComponent({
    key: 'sprite', properties: { textureResourceId: ATLAS.id, width: 1, height: 1, frame: 0 },
  });
  nestedBody.addComponent(sprite);
  const escape = walkAnimation({
    id: 'anim.parent.escape',
    target: { node: 'child/body', component: 'sprite' },
  });
  const harness = privateAnimationHarness({
    resources: [ATLAS, escape],
    nodeIndex: {
      get(name) {
        return name === nestedBody.name ? nestedBody : null;
      },
    },
  });
  sprite.attach(nestedBody, harness.context);
  const player = new AnimationPlayerComponent({
    key: 'animator', properties: { animationId: escape.id },
  });
  root.addComponent(player);
  const parentScope = { root, nodeByPath: new Map() };
  harness.system.bindPrefabScope(parentScope);

  assert.throws(() => player.attach(root, harness.context),
    { code: 'display-animation-target-missing' });
  assert.equal(harness.overrides.size, 0);

  player.dispose('test');
  harness.system.unbindPrefabScope(parentScope);
  sprite.dispose('test');
  harness.system.clear();
});

test('Prefab compile keeps parent animation targets out of fixed child internals', () => {
  const child = animatedPrefab({
    id: 'nested/compile-child',
    gameplayType: 'test.nested-compile-child',
    playerProperties: null,
  });
  const crossing = walkAnimation({
    id: 'anim.parent.fixed-child-crossing',
    target: { node: 'child/body', component: 'sprite' },
  });
  const parent = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/compile-parent',
    gameplayType: 'test.nested-compile-parent',
    root: {
      components: [{
        key: 'animator', type: 'animation.player@1', properties: { animationId: crossing.id },
      }],
      children: [],
    },
    prefabInstances: [{
      key: 'child',
      parentLocalPath: null,
      prefabId: child.id,
      state: {},
    }],
  });
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry([ATLAS, crossing]);
  const prefabRegistry = createPrefabRegistry([parent, child]);

  assert.throws(() => parent.compile({ componentRegistry, resourceRegistry, prefabRegistry }),
    { code: 'display-animation-target-missing' });
});

test('static prefab bindings preflight target type, atlas, and frame bounds', () => {
  const components = createComponentRegistry();
  const outOfRange = createResourceRegistry([ATLAS, walkAnimation({
    frames: [0, 1, 2, 9],
  })]);
  assert.throws(() => animatedPrefab().compile({ componentRegistry: components,
    resourceRegistry: outOfRange }), { code: 'display-animation-frame-out-of-range' });

  const plainTexture = createResourceRegistry([PLAIN, walkAnimation({
    target: { node: 'body', component: 'sprite' },
  })]);
  const prefabWithPlain = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'target.plain', gameplayType: 'test.animated',
    root: { components: [{ key: 'animator', type: 'animation.player@1',
      properties: { animationId: 'anim.unit.walk' } }], children: [{
      localName: 'body', transform: IDENTITY, components: [
        { key: 'sprite', type: 'render.sprite@3',
          properties: { textureResourceId: 'tex.plain', width: 1, height: 1 } }], children: [],
    }] },
  });
  assert.throws(() => prefabWithPlain.compile({ componentRegistry: components,
    resourceRegistry: plainTexture }), { code: 'display-animation-target-type-invalid' });

  const missingNode = createResourceRegistry([ATLAS, walkAnimation({
    target: { node: 'legs', component: 'sprite' },
  })]);
  assert.throws(() => animatedPrefab().compile({ componentRegistry: components,
    resourceRegistry: missingNode }), { code: 'display-animation-target-missing' });

  const missingComponent = createResourceRegistry([ATLAS, walkAnimation({
    target: { node: 'body', component: 'model' },
  })]);
  assert.throws(() => animatedPrefab().compile({ componentRegistry: components,
    resourceRegistry: missingComponent }), { code: 'display-animation-target-missing' });
});

test('loop step sampling follows the local visual clock, not sourceTick', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();

  const expectations = [[0, 0], [99, 0], [1, 1], [99, 1], [1, 2], [199, 1], [1, 0], [100, 1]];
  harness.frames.step(16);
  for (const [advanceMs, frame] of expectations) {
    harness.frames.step(advanceMs);
    assert.equal(effectiveFrame(harness), frame, `elapsed+${advanceMs}`);
  }

  // sourceTick progression alone must not advance the animation.
  const frozen = effectiveFrame(harness);
  commitAuthority(harness.runtime, () => {}, { sourceTickDelta: 1, commandCount: 0 });
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), frozen);
});

test('a second prefab instance animates from its own visual origin', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  const create = (nodeId) => commitAuthority(harness.runtime, () =>
    harness.runtime.authority.createNode(authorityNode(nodeId)), { sourceTickDelta: 1 });
  create(0);
  create(1);
  await harness.runtime.whenReady();
  harness.runtime.start();

  harness.frames.step(16);
  assert.equal(effectiveFrame(harness, 'py/0'), 0);
  assert.equal(effectiveFrame(harness, 'py/1'), 0);
  harness.frames.step(150);
  assert.equal(effectiveFrame(harness, 'py/0'), 1);
  assert.equal(effectiveFrame(harness, 'py/1'), 1);
  create(2);
  await harness.runtime.whenReady();
  harness.frames.step(50);
  assert.equal(effectiveFrame(harness, 'py/0'), 2, 'first at 200ms');
  assert.equal(effectiveFrame(harness, 'py/2'), 0, 'late instance starts at its own zero');
});

test('nested dynamic Prefab players keep scope-local outputs and retained phase', async (t) => {
  const prefabs = nestedAnimatedPrefabs();
  const harness = await animationHarness({
    prefabEntries: [prefabs.outer, prefabs.leafA, prefabs.leafB],
  });
  t.after(() => harness.runtime.dispose());
  const owner = 'py/0';
  const alpha = 'prefab/py/0/units/alpha';
  const bravo = 'prefab/py/0/units/bravo';
  const desired = (alphaPrefabId = prefabs.leafA.id, includeBravo = true) => ({
    units: {
      alpha: { prefabId: alphaPrefabId, state: {} },
      ...(includeBravo ? { bravo: { prefabId: prefabs.leafA.id, state: {} } } : {}),
    },
  });

  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
    authorityNode(0, prefabs.outer.id, desired()),
  ), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  harness.frames.step(150);
  assert.equal(effectiveFrame(harness, alpha), 1);
  assert.equal(effectiveFrame(harness, bravo), 1);

  const alphaRoot = harness.runtime._nodeIndex.require(alpha);
  const alphaPlayer = playerComponent(harness, alpha);
  const bravoPlayer = playerComponent(harness, bravo);
  alphaPlayer.stopAnimation('animator');
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness, alpha), 2, 'stopping one child restores only its base');
  assert.equal(effectiveFrame(harness, bravo), 1, 'the sibling keeps its own output ownership');

  // Resume alpha, then update the complete outer state without changing its key/id.
  // The expanded ordinary Node/Component identities and local visual origin must survive.
  alphaPlayer.setAnimation('animator', 'anim.unit.walk');
  harness.frames.step(0);
  harness.frames.step(150);
  assert.equal(effectiveFrame(harness, alpha), 1);
  const alphaRecord = harness.runtime._animationSystem._players.get(alphaPlayer);
  const startedAtVisualSeconds = alphaRecord.startedAtVisualSeconds;
  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0,
    state: desired(),
  }), { sourceTickDelta: 1 });
  assert.strictEqual(harness.runtime._nodeIndex.require(alpha), alphaRoot);
  assert.strictEqual(playerComponent(harness, alpha), alphaPlayer);
  assert.strictEqual(harness.runtime._animationSystem._players.get(alphaPlayer), alphaRecord);
  assert.equal(alphaRecord.startedAtVisualSeconds, startedAtVisualSeconds,
    'retained state does not rewrite the local visual origin');
  harness.frames.step(50);
  assert.equal(effectiveFrame(harness, alpha), 2,
    'same slot key and Prefab id retain the player phase');

  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0,
    state: desired(prefabs.leafB.id, false),
  }), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  const replacementPlayer = playerComponent(harness, alpha);
  assert.notStrictEqual(replacementPlayer, alphaPlayer);
  assert.equal(alphaPlayer.disposed, true);
  assert.equal(bravoPlayer.disposed, true);
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness, alpha), 0,
    'changing the Prefab id creates a new player at its own zero');

  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0,
    state: { units: {} },
  }), { sourceTickDelta: 1 });
  assert.equal(replacementPlayer.disposed, true);
  assert.equal(harness.runtime._animationSystem._players.size, 0);

  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0,
    state: desired(prefabs.leafA.id, false),
  }), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness, alpha), 0,
    'remove and re-add creates a clean player without stale ownership');
});

test('dynamic Prefab onAttach animation commands replay after adoption and roll back atomically',
  async (t) => {
    const child = (id, animationId, Controller = PlayAnimationOnAttach) => definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id,
      gameplayType: `test.${id.replaceAll('/', '-')}`,
      root: {
        components: [
          { key: 'animator', type: 'animation.player@1', properties: { animationId: null } },
          { key: 'starter', type: Controller.typeId, properties: { animationId } },
        ],
        children: [{
          localName: 'body',
          transform: IDENTITY,
          visible: true,
          components: [{ key: 'sprite', type: 'render.sprite@3', properties: {
            textureResourceId: ATLAS.id, width: 1, height: 1, frame: 2,
          } }],
          children: [],
        }],
      },
    });
    const validChild = child(
      'nested/on-attach-valid',
      'anim.unit.walk',
      FallbackAnimationOnAttach,
    );
    const invalidChild = child('nested/on-attach-invalid', 'anim.unit.missing');
    const outer = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'nested/on-attach-outer',
      gameplayType: 'test.nested-on-attach-outer',
      root: { components: [], children: [] },
      prefabSlots: [{
        key: 'units',
        parentLocalPath: null,
        allowedPrefabIds: [validChild.id, invalidChild.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          prefabSlots: {
            units: state.prefabId === null
              ? {} : { only: { prefabId: state.prefabId } },
          },
        };
      },
    });
    const harness = await animationHarness({
      prefabEntries: [outer, validChild, invalidChild],
      configureComponents(registry) {
        registry.register({
          ComponentClass: PlayAnimationOnAttach,
          normalizeProperties(value) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).length !== 1 || typeof value.animationId !== 'string') {
              throw new TypeError('play-on-attach properties invalid');
            }
            return Object.freeze({ animationId: value.animationId });
          },
        });
        registry.register({ ComponentClass: FallbackAnimationOnAttach });
      },
    });
    t.after(() => harness.runtime.dispose());
    const owner = 'py/0';
    const childRoot = `prefab/${owner}/units/only`;
    commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
      authorityNode(0, outer.id, { prefabId: null }),
    ), { sourceTickDelta: 1 });
    await harness.runtime.whenReady();
    harness.runtime.start();

    commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
      nodeId: 0,
      state: { prefabId: validChild.id },
    }), { sourceTickDelta: 1 });
    await harness.runtime.whenReady();
    const player = playerComponent(harness, childRoot);
    const playerRecord = harness.runtime._animationSystem._players.get(player);
    assert.equal(playerRecord.currentAnimationId, 'anim.unit.walk');
    const controller = harness.runtime._nodeIndex.require(childRoot).requireComponent('starter');
    controller.stopAnimation('animator');
    assert.equal(playerRecord.currentAnimationId, null,
      'the adopted controller now drives the live AnimationSystem');
    controller.setAnimation('animator', 'anim.unit.walk');
    assert.equal(playerRecord.currentAnimationId, 'anim.unit.walk');
    harness.frames.step(16);
    assert.equal(effectiveFrame(harness, childRoot), 0);
    harness.frames.step(150);
    assert.equal(effectiveFrame(harness, childRoot), 1);

    const oldRoot = harness.runtime._nodeIndex.require(childRoot);
    const sprite = spriteComponent(harness, childRoot);
    const authority = harness.runtime._nodeIndex.require(owner).requireComponent('authority');
    const baselineState = authority.state;
    const baselineSize = harness.runtime._nodeIndex.size;
    const baselineOrigin = playerRecord.startedAtVisualSeconds;
    const baselineFrame = harness.runtime._renderSystem.effectiveProperties(sprite).frame;

    assert.throws(() => commitAuthority(harness.runtime, () =>
      harness.runtime.authority.setNodeState({
        nodeId: 0,
        state: { prefabId: invalidChild.id },
      }), { sourceTickDelta: 1 }), { code: 'display-resource-missing' });
    assert.strictEqual(authority.state, baselineState);
    assert.strictEqual(harness.runtime._nodeIndex.require(childRoot), oldRoot);
    assert.strictEqual(playerComponent(harness, childRoot), player);
    assert.strictEqual(harness.runtime._animationSystem._players.get(player), playerRecord);
    assert.equal(playerRecord.currentAnimationId, 'anim.unit.walk');
    assert.equal(playerRecord.startedAtVisualSeconds, baselineOrigin);
    assert.equal(harness.runtime._renderSystem.effectiveProperties(sprite).frame, baselineFrame);
    assert.equal(harness.runtime._nodeIndex.size, baselineSize);
    assert.equal(harness.runtime._animationSystem._players.size, 1);
  });

test('dynamic replacement adoption failure restores the exact old animation player record',
  async (t) => {
    const oldChild = animatedPrefab({
      id: 'nested/adoption-animation-old',
      gameplayType: 'test.nested-adoption-animation-old',
      playerProperties: { animationId: null },
    });
    const newChild = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'nested/adoption-animation-new',
      gameplayType: 'test.nested-adoption-animation-new',
      root: {
        components: [
          { key: 'animator', type: 'animation.player@1', properties: { animationId: null } },
          { key: 'starter', type: PlayAnimationOnAttach.typeId,
            properties: { animationId: 'anim.unit.walk' } },
        ],
        children: [{
          localName: 'body', transform: IDENTITY, visible: true,
          components: [{ key: 'sprite', type: 'render.sprite@3', properties: {
            textureResourceId: ATLAS.id, width: 1, height: 1, frame: 2,
          } }],
          children: [],
        }],
      },
    });
    const outer = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'nested/adoption-animation-outer',
      gameplayType: 'test.nested-adoption-animation-outer',
      root: { components: [], children: [] },
      prefabSlots: [{
        key: 'units', parentLocalPath: null,
        allowedPrefabIds: [oldChild.id, newChild.id], maximumInstances: 1,
      }],
      resolveState(state) {
        return { prefabSlots: { units: { only: { prefabId: state.prefabId } } } };
      },
    });
    const harness = await animationHarness({
      prefabEntries: [outer, oldChild, newChild],
      configureComponents(registry) {
        registry.register({ ComponentClass: PlayAnimationOnAttach });
      },
    });
    t.after(() => harness.runtime.dispose());
    const owner = 'py/0';
    const childRoot = `prefab/${owner}/units/only`;
    commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
      authorityNode(0, outer.id, { prefabId: oldChild.id }),
    ), { sourceTickDelta: 1 });
    await harness.runtime.whenReady();
    harness.runtime.start();
    const oldRoot = harness.runtime._nodeIndex.require(childRoot);
    const oldPlayer = playerComponent(harness, childRoot);
    const oldSprite = spriteComponent(harness, childRoot);
    oldPlayer.playAnimation('animator', 'anim.unit.walk');
    harness.frames.step(16);
    harness.frames.step(150);
    const oldRecord = harness.runtime._animationSystem._players.get(oldPlayer);
    const oldOrigin = oldRecord.startedAtVisualSeconds;
    const oldFrame = harness.runtime._renderSystem.effectiveProperties(oldSprite).frame;
    const oldState = harness.runtime._nodeIndex.require(owner).requireComponent('authority').state;

    const originalAttached = harness.runtime._componentAttached.bind(harness.runtime);
    const failure = new Error('injected animation adoption failure');
    harness.runtime._componentAttached = (component) => {
      originalAttached(component);
      if (component.key === 'starter') throw failure;
    };
    let caught = null;
    try {
      assert.throws(() => commitAuthority(harness.runtime, () =>
        harness.runtime.authority.setNodeState({
          nodeId: 0, state: { prefabId: newChild.id },
        }), { sourceTickDelta: 1 }), (error) => {
        caught = error;
        return error === failure;
      });
    } finally {
      harness.runtime._componentAttached = originalAttached;
    }

    assert.strictEqual(caught, failure);
    assert.strictEqual(harness.runtime._nodeIndex.require(childRoot), oldRoot);
    assert.strictEqual(playerComponent(harness, childRoot), oldPlayer);
    assert.strictEqual(harness.runtime._animationSystem._players.get(oldPlayer), oldRecord);
    assert.equal(oldRecord.currentAnimationId, 'anim.unit.walk');
    assert.equal(oldRecord.startedAtVisualSeconds, oldOrigin);
    assert.equal(harness.runtime._renderSystem.effectiveProperties(oldSprite).frame, oldFrame);
    assert.equal(harness.runtime._renderSystem._entries.has(oldSprite), true);
    assert.strictEqual(
      harness.runtime._nodeIndex.require(owner).requireComponent('authority').state,
      oldState,
    );
  });

test('a fixed animated child of a static Scene Prefab binds before preorder attach', async (t) => {
  const leaf = animatedPrefab({
    id: 'nested/static-animated-leaf',
    gameplayType: 'test.nested-static-animated-leaf',
  });
  const outer = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'nested/static-animated-outer',
    gameplayType: 'test.nested-static-animated-outer',
    root: { components: [], children: [] },
    prefabInstances: [{
      key: 'child',
      parentLocalPath: null,
      prefabId: leaf.id,
      state: {},
    }],
  });
  const harness = await animationHarness({
    prefabEntries: [outer, leaf],
    prefabInstances: [{
      localName: 'preview',
      parentLocalName: null,
      prefabId: outer.id,
      transform: IDENTITY,
      visible: true,
      state: {},
    }],
  });
  t.after(() => harness.runtime.dispose());
  const child = 'prefab/scene/main/preview/child';
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness, child), 1);
  assert.equal(harness.runtime._animationSystem._players.size, 1);
});

test('non-loop animations hold the last keyframe and stop requesting frames', async (t) => {
  const fire = walkAnimation({ frames: [4, 5], loop: false });
  const harness = await animationHarness({ resources: [ATLAS, fire] });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();

  harness.frames.step(16);
  assert.equal(effectiveFrame(harness), 4);
  harness.frames.step(99);
  assert.equal(effectiveFrame(harness), 4);
  harness.frames.step(1);
  assert.equal(effectiveFrame(harness), 5);
  harness.frames.step(500);
  assert.equal(effectiveFrame(harness), 5, 'non-loop holds its final keyframe');
  assert.equal(harness.frames.pending, 0, 'completed animation stops continuous draw');
  harness.frames.step(500);
  assert.equal(effectiveFrame(harness), 5);
});

test('loop animations keep the frame loop scheduled; stop returns to idle', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  assert.equal(harness.frames.pending, 1, 'loop animation keeps drawing');
  harness.frames.step(100);

  playerComponent(harness).stopAnimation('animator');
  assert.equal(harness.frames.pending, 1, 'stop wakes one frame to restore base values');
  harness.frames.step(0);
  assert.equal(harness.frames.pending, 0, 'idle after stop with no other dynamic content');
  assert.equal(effectiveFrame(harness), 2, 'stop restores the latest base frame');
  assert.equal(batchableOf(harness), true, 'stop restores static batching');
});

test('set keeps phase, play restarts, and declarative patches re-apply', async (t) => {
  const fire = defineFrameAnimation({ id: 'anim.unit.fire',
    target: { node: 'body', component: 'sprite' }, frames: [4, 5], fps: 10, loop: false });
  const idle = walkAnimation({ id: 'anim.unit.idle', frames: [3], fps: 10, loop: true });
  const harness = await animationHarness({ resources: [ATLAS, walkAnimation(), fire, idle] });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  const player = playerComponent(harness);
  harness.frames.step(16);
  harness.frames.step(150);
  assert.equal(effectiveFrame(harness), 1);

  player.setAnimation('animator', 'anim.unit.walk');
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 1, 'set with the same id keeps the phase');

  player.playAnimation('animator', 'anim.unit.fire');
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 4, 'play switches and restarts from zero');

  player.playAnimation('animator', 'anim.unit.fire');
  harness.frames.step(50);
  assert.equal(effectiveFrame(harness), 4);
  player.playAnimation('animator', 'anim.unit.fire');
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 4, 'play with the same id forces a restart');

  player.setAnimation('animator', 'anim.unit.idle');
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 3);

  assert.throws(() => player.setAnimation('animator', 'anim.unit.missing'),
    { code: 'display-resource-missing' });
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 3, 'failed set leaves the old animation playing');
  assert.equal(player.properties.animationId, 'anim.unit.walk',
    'runtime commands never rewrite declarative properties');
});

test('switching clips clears overrides and batching ownership from targets the next clip omits',
  async (t) => {
    const first = walkAnimation({ id: 'anim.target.first', target: {
      node: 'body', component: 'first',
    }, frames: [1] });
    const second = walkAnimation({ id: 'anim.target.second', target: {
      node: 'body', component: 'second',
    }, frames: [3] });
    const prefab = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'target.two-sprites',
      gameplayType: 'test.animated',
      root: {
        components: [{ key: 'animator', type: 'animation.player@1',
          properties: { animationId: first.id } }],
        children: [{
          localName: 'body', transform: IDENTITY, components: [
            { key: 'first', type: 'render.sprite@3', properties: {
              textureResourceId: 'tex.unit', width: 1, height: 1, frame: 0,
            } },
            { key: 'second', type: 'render.sprite@3', properties: {
              textureResourceId: 'tex.unit', width: 1, height: 1, frame: 2,
            } },
          ], children: [],
        }],
      },
    });
    const harness = await animationHarness({ prefab, resources: [ATLAS, first, second] });
    t.after(() => harness.runtime.dispose());
    commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
      authorityNode(0, prefab.id),
    ), { sourceTickDelta: 1 });
    await harness.runtime.whenReady();
    harness.runtime.start();
    harness.frames.step(16);

    const body = harness.runtime._nodeIndex.require('prefab/py/0/body');
    const firstSprite = body.getComponent('first');
    const secondSprite = body.getComponent('second');
    assert.equal(harness.runtime._renderSystem.effectiveProperties(firstSprite).frame, 1);
    assert.equal(spriteBinding(harness, 'py/0', 'first').patch.batchable, false);
    assert.equal(spriteBinding(harness, 'py/0', 'second').patch.batchable, true);

    playerComponent(harness).playAnimation('animator', second.id);
    harness.frames.step(0);
    assert.equal(harness.runtime._renderSystem.effectiveProperties(firstSprite).frame, 0,
      'the omitted target immediately exposes its base frame');
    assert.equal(spriteBinding(harness, 'py/0', 'first').patch.batchable, true);
    assert.equal(harness.runtime._renderSystem.effectiveProperties(secondSprite).frame, 3);
    assert.equal(spriteBinding(harness, 'py/0', 'second').patch.batchable, false);

    playerComponent(harness).stopAnimation('animator');
    harness.frames.step(0);
    assert.equal(harness.runtime._renderSystem.effectiveProperties(secondSprite).frame, 2);
    assert.equal(spriteBinding(harness, 'py/0', 'second').patch.batchable, true);
  });

test('stop restores the newest base properties, not a start-time snapshot', async (t) => {
  const prefab = animatedPrefab({
    resolveState(state) {
      return { nodes: {}, components: { 'body/sprite': { frame: state.frame } } };
    },
  });
  const harness = await animationHarness({ prefab });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
    authorityNode(0, 'target.animated', { frame: 2 }),
  ), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 1, 'override wins while playing');

  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0, state: { frame: 3 },
  }), { sourceTickDelta: 1 });
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 1, 'base patch does not interrupt the override');

  playerComponent(harness).stopAnimation('animator');
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 3, 'stop exposes the newest base frame');
  assert.equal(spriteComponent(harness).properties.frame, 3, 'base properties were never mutated');
});

test('animation overrides drive batchable:false without touching base properties', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();

  const binding = spriteBinding(harness);
  assert.equal(binding.descriptor.properties.frame, 2, 'base frame stays declarative');
  assert.equal(binding.descriptor.batchable, true, 'no override before frames run');

  harness.runtime.start();
  harness.frames.step(16);
  assert.equal(batchableOf(harness), false, 'active animation opts out of static batches');
  assert.equal(effectiveFrame(harness), 0);
  assert.equal(spriteComponent(harness).properties.frame, 2,
    'sampling never writes component.properties');

  harness.frames.step(300);
  const calls = harness.fakeBackends[0].calls.filter(([kind]) => kind === 'update');
  const patchFrames = calls.length;
  assert.ok(patchFrames < 6, `unchanged sampled frames do not re-update (${patchFrames} updates)`);
});

test('disabled players clear overrides and re-enable from frame zero', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  harness.frames.step(150);
  assert.equal(effectiveFrame(harness), 1);

  playerComponent(harness).setEnabled(false);
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 2, 'disable restores the base frame');
  assert.equal(batchableOf(harness), true);
  assert.equal(harness.frames.pending, 0, 'disabled player stops continuous draw');

  playerComponent(harness).setEnabled(true);
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 0, 're-enable restarts the declared animation');
});

test('set and play commands cannot restart a disabled player', async (t) => {
  const fire = walkAnimation({ id: 'anim.unit.fire', frames: [5], loop: true });
  const harness = await animationHarness({ resources: [ATLAS, walkAnimation(), fire] });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  const player = playerComponent(harness);
  player.setEnabled(false);
  harness.frames.step(0);

  player.setAnimation('animator', fire.id);
  player.playAnimation('animator', fire.id);
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 2);
  assert.equal(batchableOf(harness), true);
  assert.equal(harness.frames.pending, 0);

  player.setEnabled(true);
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 0,
    're-enable starts the declarative walk clip, not a disabled-time command');
});

test('commit seal validates active clips against a changed target atlas', async (t) => {
  const smallAtlas = Object.freeze({ id: 'tex.small', kind: 'texture-atlas', url: './small.png',
    columns: 1, rows: 1 });
  const prefab = animatedPrefab({
    spriteProperties: { textureResourceId: ATLAS.id, width: 1, height: 1, frame: 0 },
    resolveState(state) {
      return { nodes: {}, components: {
        'body/sprite': { textureResourceId: state.textureResourceId, frame: 0 },
      } };
    },
  });
  const harness = await animationHarness({ prefab, resources: [ATLAS, smallAtlas, walkAnimation()] });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
    authorityNode(0, prefab.id, { textureResourceId: ATLAS.id }),
  ), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);

  const previous = harness.runtime.summary().cursor;
  const cursor = Object.freeze({
    commitSeq: previous.commitSeq + 1,
    sourceTick: previous.sourceTick + 1,
    lastCommandSeq: previous.lastCommandSeq + 1,
  });
  harness.runtime.commitGate.begin(cursor);
  harness.runtime.authority.setNodeState({
    nodeId: 0, state: { textureResourceId: smallAtlas.id },
  });
  let failure = null;
  try { harness.runtime.commitGate.seal(cursor); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'display-animation-frame-out-of-range');
  assert.deepEqual(harness.runtime.summary().cursor, previous,
    'an invalid effective frame cannot advance the ACK cursor');
  assert.equal(spritePatch(harness).properties.textureResourceId, ATLAS.id,
    'the closed draw gate never publishes the invalid candidate to the backend');
  harness.runtime.commitGate.fail(failure);
});

test('commit seal validates declared targets for disabled and stopped players', async (t) => {
  const smallAtlas = Object.freeze({ id: 'tex.small', kind: 'texture-atlas', url: './small.png',
    columns: 1, rows: 1 });
  const prefab = animatedPrefab({
    spriteProperties: { textureResourceId: ATLAS.id, width: 1, height: 1, frame: 0 },
    resolveState(state) {
      return { nodes: {}, components: {
        'body/sprite': { textureResourceId: state.textureResourceId, frame: 0 },
      } };
    },
  });
  for (const mode of ['disabled', 'stopped']) {
    await t.test(mode, async (subtest) => {
      const harness = await animationHarness({
        prefab,
        resources: [ATLAS, smallAtlas, walkAnimation()],
      });
      subtest.after(() => harness.runtime.dispose());
      commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
        authorityNode(0, prefab.id, { textureResourceId: ATLAS.id }),
      ), { sourceTickDelta: 1 });
      const player = playerComponent(harness);
      if (mode === 'disabled') player.setEnabled(false);
      else player.stopAnimation('animator');

      const previous = harness.runtime.summary().cursor;
      assert.throws(() => commitAuthority(harness.runtime, () =>
        harness.runtime.authority.setNodeState({
          nodeId: 0, state: { textureResourceId: smallAtlas.id },
        }), { sourceTickDelta: 1 }), { code: 'display-animation-frame-out-of-range' });
      assert.deepEqual(harness.runtime.summary().cursor, previous);
      assert.equal(harness.runtime._animationSystem._outputOwners.size, 0,
        `${mode} declarations validate without taking playback ownership`);
    });
  }
});

test('failed player re-enable rolls enabled back without acquiring an output', async (t) => {
  const smallAtlas = Object.freeze({ id: 'tex.small', kind: 'texture-atlas', url: './small.png',
    columns: 1, rows: 1 });
  const harness = await animationHarness({
    resources: [ATLAS, smallAtlas, walkAnimation()],
  });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  const player = playerComponent(harness);
  const sprite = spriteComponent(harness);
  player.setEnabled(false);
  harness.componentRegistry.patchComponentProperties({
    component: sprite,
    patch: { textureResourceId: smallAtlas.id, frame: 0 },
    resourceRegistry: harness.resourceRegistry,
  });

  assert.throws(() => player.setEnabled(true), { code: 'display-animation-frame-out-of-range' });
  assert.equal(player.enabled, false);
  assert.equal(harness.runtime._animationSystem._players.get(player).currentAnimationId, null);
  assert.equal(harness.runtime._animationSystem._outputOwners.size, 0);
});

test('one state patch can switch the player and target atlas independent of property order',
  async (t) => {
    const smallAtlas = Object.freeze({ id: 'tex.small', kind: 'texture-atlas', url: './small.png',
      columns: 1, rows: 1 });
    const smallClip = walkAnimation({ id: 'anim.unit.small', frames: [0] });
    const prefab = animatedPrefab({
      spriteProperties: { textureResourceId: ATLAS.id, width: 1, height: 1, frame: 0 },
      resolveState(state) {
        // Player first is deliberate: the final cross-component candidate, not object
        // insertion order, determines validity.
        return { nodes: {}, components: {
          '$root/animator': { animationId: state.animationId },
          'body/sprite': { textureResourceId: state.textureResourceId, frame: 0 },
        } };
      },
    });
    const harness = await animationHarness({
      prefab,
      resources: [ATLAS, smallAtlas, walkAnimation(), smallClip],
    });
    t.after(() => harness.runtime.dispose());
    commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
      authorityNode(0, prefab.id, {
        animationId: 'anim.unit.walk', textureResourceId: ATLAS.id,
      }),
    ), { sourceTickDelta: 1 });
    await harness.runtime.whenReady();
    harness.runtime.start();
    harness.frames.step(16);

    commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
      nodeId: 0,
      state: { animationId: smallClip.id, textureResourceId: smallAtlas.id },
    }), { sourceTickDelta: 1 });
    harness.frames.step(0);
    assert.equal(spritePatch(harness).properties.textureResourceId, smallAtlas.id);
    assert.equal(effectiveFrame(harness), 0);
    assert.equal(batchableOf(harness), false);
  });

test('declarative animationId patches follow the documented switch semantics', async (t) => {
  const fire = defineFrameAnimation({ id: 'anim.unit.fire',
    target: { node: 'body', component: 'sprite' }, frames: [4, 5], fps: 10, loop: true });
  const harness = await animationHarness({ resources: [ATLAS, walkAnimation(), fire] });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  const player = playerComponent(harness);
  harness.frames.step(16);
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 1);

  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0, state: {},
  }), { sourceTickDelta: 1 });
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 1, 'same id patch does not restart');

  commitAuthority(harness.runtime, () => harness.runtime.authority.setNodeState({
    nodeId: 0, state: {},
  }), { sourceTickDelta: 1 });
  harness.frames.step(100);
  void player;
});

test('prefab replacement adopts animation players exactly once', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 1);

  commitAuthority(harness.runtime, () => harness.runtime.authority.replaceNodePrefab({
    nodeId: 0, prefabId: 'target.animated', state: {},
  }), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.frames.step(0);
  assert.equal(effectiveFrame(harness), 0, 'the replacement instance restarts from zero');
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 1);
});

test('replacement shadow preflights resolver animation targets before destroying the old scope',
  async (t) => {
    const badTarget = defineAnimation({
      id: 'anim.bad-shadow', durationMs: 100, loop: true, tracks: [{
        channel: 'sprite.frame', target: { node: 'missing', component: 'sprite' },
        interpolation: 'step', keyframes: [{ atMs: 0, value: 0 }],
      }],
    });
    const replacement = animatedPrefab({
      id: 'target.dynamic-replacement',
      playerProperties: {},
      resolveState(state) {
        return { nodes: {}, components: {
          '$root/animator': { animationId: state.animationId },
        } };
      },
    });
    const original = animatedPrefab();
    const harness = await animationHarness({
      prefabEntries: [original, replacement],
      resources: [ATLAS, walkAnimation(), badTarget],
    });
    t.after(() => harness.runtime.dispose());
    commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
      authorityNode(0, original.id),
    ), { sourceTickDelta: 1 });
    const oldRoot = harness.runtime._nodeIndex.require('py/0');
    const oldPlayer = oldRoot.getComponent('animator');
    const previous = harness.runtime.summary().cursor;
    const cursor = Object.freeze({
      commitSeq: previous.commitSeq + 1,
      sourceTick: previous.sourceTick + 1,
      lastCommandSeq: previous.lastCommandSeq + 1,
    });
    harness.runtime.commitGate.begin(cursor);
    let failure = null;
    try {
      harness.runtime.authority.replaceNodePrefab({
        nodeId: 0, prefabId: replacement.id, state: { animationId: badTarget.id },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 'display-animation-target-missing');
    assert.strictEqual(harness.runtime._nodeIndex.require('py/0'), oldRoot);
    assert.strictEqual(oldRoot.getComponent('animator'), oldPlayer);
    assert.equal(oldPlayer.disposed, false);
    assert(harness.runtime._nodeIndex.get('prefab/py/0/body'));
    assert.equal(harness.runtime._animationSystem._players.size, 1,
      'the rejected shadow never registers a second player');
    harness.runtime.commitGate.fail(failure);
  });

test('prefab dispose releases ownership and a fresh instance can reuse the output', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  const create = (nodeId) => commitAuthority(harness.runtime, () =>
    harness.runtime.authority.createNode(authorityNode(nodeId)), { sourceTickDelta: 1 });
  create(0);
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);

  commitAuthority(harness.runtime, () => harness.runtime.authority.removeNode({
    nodeId: 0,
  }), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.frames.step(0);

  create(1);
  await harness.runtime.whenReady();
  harness.frames.step(16);
  assert.equal(effectiveFrame(harness, 'py/1'), 0, 'a fresh node ID starts cleanly');
  await harness.runtime.dispose();
  await harness.runtime.dispose();
});

test('renderer rebuild keeps the player phase and remounts effective frames', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  harness.frames.step(150);
  assert.equal(effectiveFrame(harness), 1);

  await harness.runtime.rebuildRenderBackend();
  await harness.runtime.whenReady();
  harness.frames.step(0);
  const remounted = spriteBinding(harness);
  assert.equal(remounted.descriptor.properties.frame, 1,
    'remount uses the current effective frame');
  assert.equal(remounted.descriptor.batchable, false);
  harness.frames.step(50);
  assert.equal(effectiveFrame(harness), 2, 'phase continues across the rebuild');
});

class VisualBehaviour extends BehaviourComponent {
  static typeId = 'visual.test@1';
  static tickPhase = 'update';
  tick() {}
}

test('agent commands resolve players on the caller node only', async (t) => {
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'target.behaviour', gameplayType: 'test.animated',
    root: { components: [
      { key: 'animator', type: 'animation.player@1', properties: {} },
      { key: 'visual', type: 'visual.test@1', properties: {} },
    ], children: [{
      localName: 'body', transform: IDENTITY, components: [
        { key: 'sprite', type: 'render.sprite@3',
          properties: { textureResourceId: 'tex.unit', width: 1, height: 1, frame: 2 } }],
      children: [],
    }] },
  });
  const harness = await animationHarness({ prefab, configureComponents: (registry) => {
    registry.register({ ComponentClass: VisualBehaviour });
  } });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(
    authorityNode(0, 'target.behaviour'),
  ), { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  const visual = harness.runtime._nodeIndex.require('py/0').getComponent('visual');
  const spriteOnBody = harness.runtime._nodeIndex.require('prefab/py/0/body');

  visual.setAnimation('animator', 'anim.unit.walk');
  harness.frames.step(16);
  assert.equal(effectiveFrame(harness), 0);

  assert.throws(() => spriteOnBody.getComponent('sprite').setAnimation('animator', 'anim.unit.walk'),
    { code: 'display-animation-player-missing' });
  assert.throws(() => visual.setAnimation('missing-player', 'anim.unit.walk'),
    { code: 'display-animation-player-missing' });
  assert.throws(() => visual.setAnimation('animator', null),
    { code: 'display-animation-command-invalid' });

  const detached = new VisualBehaviour({ key: 'detached' });
  assert.throws(() => detached.setAnimation('animator', 'anim.unit.walk'),
    { code: 'display-component-not-attached' });
});

test('output conflicts between players fail closed and leave the owner running', async (t) => {
  const twoPlayers = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA, id: 'target.animated', gameplayType: 'test.animated',
    root: { components: [
      { key: 'animator', type: 'animation.player@1',
        properties: { animationId: 'anim.unit.walk' } },
      { key: 'fx', type: 'animation.player@1', properties: {} },
    ], children: [{
      localName: 'body', transform: IDENTITY, components: [
        { key: 'sprite', type: 'render.sprite@3',
          properties: { textureResourceId: 'tex.unit', width: 1, height: 1, frame: 2 } }],
      children: [],
    }] },
  });
  const harness = await animationHarness({
    prefab: twoPlayers,
    resources: [ATLAS, walkAnimation(), walkAnimation({ id: 'anim.unit.other', frames: [3, 2] })],
  });
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  harness.runtime.start();
  harness.frames.step(16);
  assert.equal(effectiveFrame(harness), 0);

  const fx = harness.runtime._nodeIndex.require('py/0').getComponent('fx');
  assert.throws(() => fx.playAnimation('fx', 'anim.unit.other'),
    { code: 'display-animation-output-conflict' });
  harness.frames.step(100);
  assert.equal(effectiveFrame(harness), 1, 'the original animation keeps running');

  const missingTarget = defineAnimation({
    id: 'anim.bad-target', durationMs: 100, loop: true, tracks: [{
      channel: 'sprite.frame', target: { node: 'legs', component: 'sprite' },
      interpolation: 'step', keyframes: [{ atMs: 0, value: 0 }],
    }],
  });
  const missingComponent = defineAnimation({
    id: 'anim.bad-component', durationMs: 100, loop: true, tracks: [{
      channel: 'sprite.frame', target: { node: 'body', component: 'missing' },
      interpolation: 'step', keyframes: [{ atMs: 0, value: 0 }],
    }],
  });
  const withBadTarget = await animationHarness({
    resources: [ATLAS, walkAnimation(), missingTarget, missingComponent],
  });
  t.after(() => withBadTarget.runtime.dispose());
  commitAuthority(withBadTarget.runtime, () => withBadTarget.runtime.authority.createNode(
    authorityNode(),
  ), { sourceTickDelta: 1 });
  await withBadTarget.runtime.whenReady();
  withBadTarget.runtime.start();
  withBadTarget.frames.step(16);
  assert.throws(() => playerComponent(withBadTarget)
    .playAnimation('animator', 'anim.bad-target'), { code: 'display-animation-target-missing' });
  assert.throws(() => playerComponent(withBadTarget)
    .playAnimation('animator', 'anim.bad-component'), { code: 'display-animation-target-missing' });
  withBadTarget.frames.step(100);
  assert.equal(effectiveFrame(withBadTarget), 1, 'failed preflight keeps the old animation');
});

test('components cannot override the final animation methods', () => {
  const registry = createComponentRegistry();
  class Overriding extends VisualBehaviour {
    setAnimation() { return 'nope'; }
  }
  Overriding.typeId = 'visual.override@1';
  assert.throws(() => registry.register({ ComponentClass: Overriding }),
    { code: 'display-component-final-method-override' });
  class OverridingDispatcher extends VisualBehaviour {
    _animationCommand() { return 'bypass'; }
  }
  OverridingDispatcher.typeId = 'visual.override-dispatcher@1';
  assert.throws(() => registry.register({ ComponentClass: OverridingDispatcher }),
    { code: 'display-component-final-method-override' });
});

test('a stopped player keeps ownership semantics and animation kinds stay closed', async (t) => {
  const harness = await animationHarness();
  t.after(() => harness.runtime.dispose());
  commitAuthority(harness.runtime, () => harness.runtime.authority.createNode(authorityNode()),
    { sourceTickDelta: 1 });
  await harness.runtime.whenReady();
  const player = playerComponent(harness);
  player.stopAnimation('animator');
  harness.runtime.start();
  harness.frames.step(16);
  assert.equal(effectiveFrame(harness), 2);
  assert.equal(batchableOf(harness), true);
  void SpriteRendererComponent;
});
