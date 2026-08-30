import assert from 'node:assert/strict';
import test from 'node:test';

import { BillboardComponent, LookAtComponent, createComponentRegistry } from '../src/index.js';
import { composeWorldTransform, createMutableWorldTransform, normalizeTransform } from '../src/math/transform.js';
import { NodeGraph } from '../src/node/node-graph.js';
import { NodeIndex } from '../src/node/node-index.js';
import { assertNodeName, joinPrefabNodeName, joinSceneNodeName, parseNodeName } from '../src/node/node-name.js';
import { Node } from '../src/node/node.js';
import { createInternalComponentContext } from '../src/runtime/component-context.js';
import { IDENTITY } from './helpers.mjs';

test('Node names use the frozen grammar and helpers never rename', () => {
  assert.deepEqual(parseNodeName('py/aircraft-17').segments, ['aircraft-17']);
  assert.equal(joinSceneNodeName('main', 'camera/subject'), 'scene/main/camera/subject');
  assert.equal(joinPrefabNodeName('py/aircraft-17', 'body'), 'prefab/py/aircraft-17/body');
  for (const invalid of ['other/x', 'py/A', 'py/a b', 'py/a//b', 'py/../b', 'py/a\\b']) {
    assert.throws(() => assertNodeName(invalid));
  }
  assert.throws(() => assertNodeName(`py/${'a'.repeat(190)}`));
});

test('Transform normalizes quaternions, rejects non-positive scale, and composes TRS', () => {
  const local = normalizeTransform({ position: [1, 0, 0], rotationXyzw: [0, 0, 0, 2], scale: [2, 3, 4] });
  assert.deepEqual(local.rotationXyzw, [0, 0, 0, 1]);
  assert.throws(() => normalizeTransform({ ...IDENTITY, scale: [1, 0, 1] }));
  assert.throws(() => normalizeTransform({ ...IDENTITY, scale: [1, -1, 1] }));
  const parent = { position: [2, 3, 4], rotationXyzw: [0, 0, 0, 1], scale: [2, 2, 2] };
  const world = composeWorldTransform(parent, local, createMutableWorldTransform());
  assert.deepEqual(world.position, [4, 3, 4]);
  assert.deepEqual(world.scale, [4, 6, 8]);
  assert.deepEqual(Array.from(world.matrix).slice(12, 15), [4, 3, 4]);
});

test('world matrix preserves affine shear from non-uniform parent scale and child rotation', () => {
  const parent = composeWorldTransform(null, normalizeTransform({
    ...IDENTITY, scale: [2, 3, 4],
  }), createMutableWorldTransform());
  const halfSqrt = Math.sqrt(0.5);
  const child = normalizeTransform({
    ...IDENTITY, rotationXyzw: [0, 0, halfSqrt, halfSqrt],
  });
  const world = composeWorldTransform(parent, child, createMutableWorldTransform());
  assert(Math.abs(world.matrix[0]) < 1e-12);
  assert(Math.abs(world.matrix[1] - 3) < 1e-12);
  assert(Math.abs(world.matrix[4] + 2) < 1e-12);
  assert(Math.abs(world.matrix[5]) < 1e-12);
});

test('initialize and continuous Billboard and LookAt face targets through a scaled and rotated ancestor', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const halfAngle = Math.PI / 8;
  const parent = new Node({ name: 'scene/main/parent', sceneToken: token, transform: {
    ...IDENTITY,
    rotationXyzw: [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)],
    scale: [100, 1, 3],
  } });
  const billboardNode = new Node({ name: 'scene/main/billboard', sceneToken: token, transform: IDENTITY });
  const initializedNode = new Node({ name: 'scene/main/initialized-billboard', sceneToken: token,
    transform: IDENTITY });
  const lookAtNode = new Node({ name: 'scene/main/look-at', sceneToken: token, transform: IDENTITY });
  const camera = new Node({ name: 'scene/main/camera', sceneToken: token,
    transform: { ...IDENTITY, position: [20, 4, 11] } });
  for (const node of [parent, billboardNode, initializedNode, lookAtNode, camera]) index.register(node);
  graph.attach(parent); graph.attach(billboardNode, parent); graph.attach(initializedNode, parent);
  graph.attach(lookAtNode, parent); graph.attach(camera);
  graph.flushWorldTransforms();
  const context = createInternalComponentContext({
    scene: { name: 'main', activeCameraName: camera.name }, nodeIndex: index, nodeGraph: graph,
  });
  const components = [
    [billboardNode, new BillboardComponent({ key: 'billboard', properties: {
      mode: 'continuous', axisMode: 'full', facing: 'camera', cameraName: camera.name,
    } })],
    [initializedNode, new BillboardComponent({ key: 'billboard', properties: {
      mode: 'initialize', axisMode: 'full', facing: 'camera', cameraName: camera.name,
    } })],
    [lookAtNode, new LookAtComponent({ key: 'look-at', properties: {
      targetNodeName: camera.name, targetPosition: null, axisMode: 'full',
    } })],
  ];
  for (const [node, component] of components) {
    node.addComponent(component); component.attach(node, context); component.tick({ display: context.publicDisplay });
  }
  graph.flushWorldTransforms();
  for (const [node] of components) {
    const forward = [node._worldTransform.matrix[8], node._worldTransform.matrix[9],
      node._worldTransform.matrix[10]];
    const desired = camera._worldTransform.position.map((value, indexValue) => value
      - node._worldTransform.position[indexValue]);
    const dot = forward.reduce((sum, value, indexValue) => sum + value * desired[indexValue], 0)
      / (Math.hypot(...forward) * Math.hypot(...desired));
    assert(dot > 1 - 1e-12);
  }
});

test('fixed Billboard keeps world +Z / +Y through rotated non-uniform parent TRS', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const registry = createComponentRegistry();
  const parent = new Node({ name: 'scene/main/parent', sceneToken: token, transform: IDENTITY });
  const card = new Node({ name: 'scene/main/card', sceneToken: token, transform: {
    ...IDENTITY, position: [2, 3, 4], scale: [2, 4, 1],
  } });
  index.register(parent); index.register(card); graph.attach(parent); graph.attach(card, parent);
  const context = createInternalComponentContext({
    scene: { name: 'main', activeCameraName: null }, nodeIndex: index, nodeGraph: graph,
  });
  const component = registry.create(registry.compile({ key: 'facing', type: 'behavior.billboard@2',
    properties: { mode: 'continuous', axisMode: 'y-axis' } }));
  card.addComponent(component); component.attach(card, context);
  const yaw = Math.PI / 4;
  for (const [rotationXyzw, scale] of [
    [[0, 0, 0, 1], [3, 2, 5]],
    [[0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], [3, 1, 1]],
    [[0.2, 0.4, 0.1, 0.8], [3, 3, 3]],
    [[0, 1, 0, 0], [2, 4, 3]],
  ]) {
    parent.setLocalTransform({ position: [-5, 2, 7], rotationXyzw, scale });
    component.tick({ display: context.publicDisplay }); graph.flushWorldTransforms();
    const matrix = card.worldTransform.matrix;
    for (const [offset, expected] of [[4, [0, 1, 0]], [8, [0, 0, 1]]]) {
      const axis = Array.from(matrix).slice(offset, offset + 3);
      const length = Math.hypot(...axis);
      axis.forEach((value, i) => assert(Math.abs(value / length - expected[i]) < 1e-12));
    }
    assert.deepEqual(card.localTransform.position, [2, 3, 4]);
    assert.deepEqual(card.localTransform.scale, [2, 4, 1]);
  }
  component.dispose();
});

test('NodeIndex enforces duplicate and unregister identity without partial writes', () => {
  const token = {}; const index = new NodeIndex();
  const first = new Node({ name: 'scene/main/a', sceneToken: token, transform: IDENTITY });
  const duplicate = new Node({ name: 'scene/main/a', sceneToken: token, transform: IDENTITY });
  index.register(first);
  assert.throws(() => index.register(duplicate), { code: 'display-node-name-duplicate' });
  assert.equal(index.get(first.name), first);
  assert.throws(() => index.unregister(duplicate), { code: 'display-node-unregister-identity' });
  index.unregister(first);
  assert.equal(index.size, 0);
});

test('NodeGraph rejects cycle before mutation and propagates transform/visibility', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const root = new Node({ name: 'sys/scene-root', sceneToken: token, transform: IDENTITY });
  const parent = new Node({ name: 'scene/main/parent', sceneToken: token,
    transform: { ...IDENTITY, position: [3, 0, 0] } });
  const child = new Node({ name: 'scene/main/child', sceneToken: token,
    transform: { ...IDENTITY, position: [2, 0, 0] } });
  for (const node of [root, parent, child]) index.register(node);
  graph.attach(root); graph.attach(parent, root); graph.attach(child, parent); graph.flushWorldTransforms();
  assert.deepEqual(child.worldTransform.position, [5, 0, 0]);
  assert.throws(() => graph.reparent(parent, child), { code: 'display-node-cycle' });
  assert.equal(parent.parent, root); assert.equal(child.parent, parent);
  parent.setVisible(false); graph.flushWorldTransforms();
  assert.equal(child.visibleInHierarchy, false);
});

test('NodeGraph maximum depth is exactly 128', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index, maximumDepth: 128 });
  let parent = new Node({ name: 'sys/scene-root', sceneToken: token, transform: IDENTITY });
  index.register(parent); graph.attach(parent);
  for (let depth = 2; depth <= 128; depth += 1) {
    const node = new Node({ name: `scene/main/n${depth}`, sceneToken: token, transform: IDENTITY });
    index.register(node); graph.attach(node, parent); parent = node;
  }
  const tooDeep = new Node({ name: 'scene/main/too-deep', sceneToken: token, transform: IDENTITY });
  index.register(tooDeep);
  assert.throws(() => graph.attach(tooDeep, parent), { code: 'display-node-depth-limit' });
  assert.equal(tooDeep.parent, null);
});
