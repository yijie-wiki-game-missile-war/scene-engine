import assert from 'node:assert/strict';
import test from 'node:test';

import { BillboardComponent, LookAtComponent, createComponentRegistry } from '../src/index.js';
import { composeWorldTransform, createMutableWorldTransform, normalizeTransform } from '../src/math/transform.js';
import { NodeGraph } from '../src/node/node-graph.js';
import { NodeIndex } from '../src/node/node-index.js';
import { NodeView } from '../src/node/node-view.js';
import { assertNodeName, joinPrefabNodeName, joinSceneNodeName, parseNodeName } from '../src/node/node-name.js';
import { Node } from '../src/node/node.js';
import { createInternalComponentContext } from '../src/runtime/component-context.js';
import { IDENTITY, matrixPosition, matrixTransform } from './helpers.mjs';

test('Node names use the frozen grammar and helpers never rename', () => {
  assert.deepEqual(parseNodeName('py/aircraft-17').segments, ['aircraft-17']);
  assert.equal(joinSceneNodeName('main', 'camera/subject'), 'scene/main/camera/subject');
  assert.equal(joinPrefabNodeName('py/aircraft-17', 'body'), 'prefab/py/aircraft-17/body');
  for (const invalid of ['other/x', 'py/A', 'py/a b', 'py/a//b', 'py/../b', 'py/a\\b']) {
    assert.throws(() => assertNodeName(invalid));
  }
  assert.throws(() => assertNodeName(`py/${'a'.repeat(190)}`));
});

test('Transform canonicalizes finite affine matrices, permits shear, and composes matrices', () => {
  const local = normalizeTransform(matrixTransform({ position: [1, 0, 0], scale: [2, 3, 4] }));
  assert.equal(Object.isFrozen(local), true);
  assert.throws(() => normalizeTransform({
    position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1],
  }), { code: 'display-transform-invalid' });
  assert.throws(() => normalizeTransform(matrixTransform({ scale: [1, 0, 1] })),
    { code: 'display-transform-invalid' });
  assert.throws(() => normalizeTransform(matrixTransform({ scale: [-1, 1, 1] })),
    { code: 'display-transform-invalid' });
  const sheared = normalizeTransform([
    1, 0, 0, 0,
    0.25, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  assert.equal(sheared[4], 0.25);
  const parent = normalizeTransform(matrixTransform({ position: [2, 3, 4], scale: [2, 2, 2] }));
  const world = composeWorldTransform(parent, local, createMutableWorldTransform());
  assert.deepEqual(Array.from(world).slice(12, 15), [4, 3, 4]);
  assert.deepEqual([world[0], world[5], world[10]], [4, 6, 8]);
});

test('Node owns Float32 local storage and public matrix snapshots never alias it', () => {
  const input = new Float32Array(matrixTransform({ position: [2, 3, 4] }));
  const node = new Node({ name: 'scene/main/owned', sceneToken: {}, transform: input });
  assert.equal(node._localTransform instanceof Float32Array, true);
  assert.notStrictEqual(node._localTransform, input);
  input[12] = 99;
  assert.equal(node._localTransform[12], 2);
  const owned = node._localTransform;
  assert.throws(() => node.setLocalTransform(undefined), { code: 'display-transform-invalid' });
  assert.strictEqual(node._localTransform, owned);

  const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const view = new NodeView(node, graph);
  const local = view.localTransform;
  assert.equal(Object.isFrozen(local), true);
  assert.throws(() => { local[12] = 100; }, TypeError);
  assert.equal(node._localTransform[12], 2);

  index.register(node); graph.attach(node); graph.flushWorldTransforms();
  const world = view.getWorldTransform();
  assert.equal(Object.isFrozen(world), true);
  assert.throws(() => { world[12] = 101; }, TypeError);
  assert.equal(node._worldTransform[12], 2);
  const output = new Float64Array(16);
  view.getWorldTransform(output);
  output[12] = 102;
  assert.equal(node._worldTransform[12], 2);
});

test('world matrix preserves affine shear from non-uniform parent scale and child rotation', () => {
  const parent = composeWorldTransform(null,
    normalizeTransform(matrixTransform({ scale: [2, 3, 4] })), createMutableWorldTransform());
  const halfSqrt = Math.sqrt(0.5);
  const child = normalizeTransform(matrixTransform({
    rotationXyzw: [0, 0, halfSqrt, halfSqrt],
  }));
  const world = composeWorldTransform(parent, child, createMutableWorldTransform());
  assert(Math.abs(world[0]) < 1e-6);
  assert(Math.abs(world[1] - 3) < 1e-6);
  assert(Math.abs(world[4] + 2) < 1e-6);
  assert(Math.abs(world[5]) < 1e-6);
});

test('NodeGraph multiplies valid sheared local matrices through the hierarchy', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const parentTransform = normalizeTransform([
    1, 0, 0, 0,
    0.25, 1, 0, 0,
    0, 0, 1, 0,
    2, 3, 4, 1,
  ]);
  const childTransform = normalizeTransform([
    1, 0.5, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    5, 6, 7, 1,
  ]);
  const parent = new Node({ name: 'scene/main/shear-parent', sceneToken: token,
    transform: parentTransform });
  const child = new Node({ name: 'scene/main/shear-child', sceneToken: token,
    transform: childTransform });
  index.register(parent); index.register(child);
  graph.attach(parent); graph.attach(child, parent); graph.flushWorldTransforms();

  assert.deepEqual(child.worldTransform, [
    1.125, 0.5, 0, 0,
    0.25, 1, 0, 0,
    0, 0, 1, 0,
    8.5, 9, 11, 1,
  ]);
});

test('world composition rejects finite local matrices whose hierarchy product overflows', () => {
  const local = normalizeTransform(matrixTransform({ scale: [1e10, 1e10, 1e10] }));
  const parentWorld = createMutableWorldTransform();
  parentWorld[0] = Number.MAX_VALUE;
  const output = createMutableWorldTransform();
  assert.throws(() => composeWorldTransform(parentWorld, local, output),
    { code: 'display-transform-world-nonfinite' });
  assert.equal([...output].every(Number.isFinite), true);
});

test('initialize and continuous Billboard and LookAt face targets through a scaled and rotated ancestor', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const halfAngle = Math.PI / 8;
  const parent = new Node({ name: 'scene/main/parent', sceneToken: token, transform: matrixTransform({
    rotationXyzw: [0, Math.sin(halfAngle), 0, Math.cos(halfAngle)],
    scale: [100, 1, 3],
  }) });
  const billboardNode = new Node({ name: 'scene/main/billboard', sceneToken: token, transform: IDENTITY });
  const initializedNode = new Node({ name: 'scene/main/initialized-billboard', sceneToken: token,
    transform: IDENTITY });
  const lookAtNode = new Node({ name: 'scene/main/look-at', sceneToken: token, transform: IDENTITY });
  const camera = new Node({ name: 'scene/main/camera', sceneToken: token,
    transform: matrixTransform({ position: [20, 4, 11] }) });
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
    const forward = [node._worldTransform[8], node._worldTransform[9],
      node._worldTransform[10]];
    const desired = [12, 13, 14].map((indexValue) => camera._worldTransform[indexValue]
      - node._worldTransform[indexValue]);
    const dot = forward.reduce((sum, value, indexValue) => sum + value * desired[indexValue], 0)
      / (Math.hypot(...forward) * Math.hypot(...desired));
    assert(dot > 1 - 1e-6);
  }
});

test('fixed Billboard keeps world +Z / +Y through a rotated non-uniform parent matrix', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const registry = createComponentRegistry();
  const parent = new Node({ name: 'scene/main/parent', sceneToken: token, transform: IDENTITY });
  const card = new Node({ name: 'scene/main/card', sceneToken: token,
    transform: matrixTransform({ position: [2, 3, 4], scale: [2, 4, 1] }) });
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
    parent.setLocalTransform(matrixTransform({ position: [-5, 2, 7], rotationXyzw, scale }));
    component.tick({ display: context.publicDisplay }); graph.flushWorldTransforms();
    const matrix = card.worldTransform;
    for (const [offset, expected] of [[4, [0, 1, 0]], [8, [0, 0, 1]]]) {
      const axis = Array.from(matrix).slice(offset, offset + 3);
      const length = Math.hypot(...axis);
      axis.forEach((value, i) => assert(Math.abs(value / length - expected[i]) < 1e-5));
    }
    assert.deepEqual(matrixPosition(card.localTransform), [2, 3, 4]);
    const localScales = [0, 4, 8].map(
      (offset) => Math.hypot(...card.localTransform.slice(offset, offset + 3)),
    );
    localScales.forEach((value, indexValue) => {
      assert.ok(Math.abs(value - [2, 4, 1][indexValue]) < 1e-5);
    });
  }
  component.dispose();
});

test('transform drivers reject own local shear while allowing sheared ancestors', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const shear = Object.freeze([
    1, 0, 0, 0,
    0.5, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const parent = new Node({ name: 'scene/main/sheared-parent', sceneToken: token, transform: shear });
  const card = new Node({ name: 'scene/main/card-under-shear', sceneToken: token, transform: IDENTITY });
  const shearedBillboard = new Node({
    name: 'scene/main/sheared-billboard', sceneToken: token, transform: shear,
  });
  const shearedLookAt = new Node({
    name: 'scene/main/sheared-look-at', sceneToken: token, transform: shear,
  });
  for (const node of [parent, card, shearedBillboard, shearedLookAt]) index.register(node);
  graph.attach(parent); graph.attach(card, parent); graph.attach(shearedBillboard);
  graph.attach(shearedLookAt); graph.flushWorldTransforms();
  const context = createInternalComponentContext({
    scene: { name: 'main', activeCameraName: null }, nodeIndex: index, nodeGraph: graph,
  });

  const allowed = new BillboardComponent({ key: 'allowed', properties: {
    facing: 'fixed', mode: 'initialize', axisMode: 'full',
  } });
  card.addComponent(allowed);
  assert.doesNotThrow(() => allowed.attach(card, context));
  graph.flushWorldTransforms();
  const forward = Array.from(card._worldTransform.slice(8, 11));
  const forwardLength = Math.hypot(...forward);
  assert.ok(Math.abs(forward[0] / forwardLength) < 1e-6);
  assert.ok(Math.abs(forward[1] / forwardLength) < 1e-6);
  assert.ok(Math.abs(forward[2] / forwardLength - 1) < 1e-6);

  const rejectedBillboard = new BillboardComponent({ key: 'rejected-billboard', properties: {
    facing: 'fixed', mode: 'initialize', axisMode: 'full',
  } });
  shearedBillboard.addComponent(rejectedBillboard);
  assert.throws(() => rejectedBillboard.attach(shearedBillboard, context),
    { code: 'display-transform-driver-shear' });

  const rejectedLookAt = new LookAtComponent({ key: 'rejected-look-at', properties: {
    targetNodeName: null, targetPosition: [0, 0, 5], axisMode: 'full',
  } });
  shearedLookAt.addComponent(rejectedLookAt); rejectedLookAt.attach(shearedLookAt, context);
  assert.throws(() => rejectedLookAt.tick({ display: context.publicDisplay }),
    { code: 'display-transform-driver-shear' });
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
    transform: matrixTransform({ position: [3, 0, 0] }) });
  const child = new Node({ name: 'scene/main/child', sceneToken: token,
    transform: matrixTransform({ position: [2, 0, 0] }) });
  for (const node of [root, parent, child]) index.register(node);
  graph.attach(root); graph.attach(parent, root); graph.attach(child, parent); graph.flushWorldTransforms();
  assert.deepEqual(matrixPosition(child.worldTransform), [5, 0, 0]);
  assert.throws(() => graph.reparent(parent, child), { code: 'display-node-cycle' });
  assert.equal(parent.parent, root); assert.equal(child.parent, parent);
  parent.setVisible(false); graph.flushWorldTransforms();
  assert.equal(child.visibleInHierarchy, false);
});

test('NodeGraph compacts descendant-then-ancestor dirty roots at flush and preserves callbacks', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const root = new Node({ name: 'sys/scene-root', sceneToken: token, transform: IDENTITY });
  const parent = new Node({ name: 'scene/main/parent', sceneToken: token,
    transform: matrixTransform({ position: [3, 0, 0] }) });
  const child = new Node({ name: 'scene/main/child', sceneToken: token,
    transform: matrixTransform({ position: [2, 0, 0] }) });
  for (const node of [root, parent, child]) index.register(node);
  graph.attach(root); graph.attach(parent, root); graph.attach(child, parent);
  graph.flushWorldTransforms();

  const dirty = [];
  const transformed = [];
  const visibility = [];
  graph.setCallbacks({
    onDirty(kind, node) { dirty.push(`${kind}:${node.name}`); },
    onWorldTransform(node) { transformed.push(node.name); },
    onVisibility(node) { visibility.push(node.name); },
  });
  child.setLocalTransform(matrixTransform({ position: [4, 0, 0] }));
  child.setVisible(false);
  parent.setLocalTransform(matrixTransform({ position: [7, 0, 0] }));
  parent.setVisible(false);

  assert.deepEqual([...graph._transformDirtyRoots], [child, parent]);
  assert.deepEqual([...graph._visibilityDirtyRoots], [child, parent]);
  assert.deepEqual(graph.flushWorldTransforms(), { transformCount: 1, visibilityCount: 1 });
  assert.deepEqual(dirty, [
    `transform:${child.name}`,
    `visibility:${child.name}`,
    `transform:${parent.name}`,
    `visibility:${parent.name}`,
  ]);
  assert.deepEqual(transformed, [parent.name, child.name]);
  assert.deepEqual(visibility, [parent.name, child.name]);
  assert.deepEqual(matrixPosition(child.worldTransform), [11, 0, 0]);
  assert.equal(child.visibleInHierarchy, false);

  dirty.length = 0;
  transformed.length = 0;
  visibility.length = 0;
  parent.setLocalTransform(matrixTransform({ position: [9, 0, 0] }));
  child.setLocalTransform(matrixTransform({ position: [6, 0, 0] }));
  assert.deepEqual([...graph._transformDirtyRoots], [parent]);
  assert.deepEqual(graph.flushWorldTransforms(), { transformCount: 1, visibilityCount: 0 });
  assert.deepEqual(dirty, [`transform:${parent.name}`, `transform:${child.name}`]);
  assert.deepEqual(transformed, [parent.name, child.name]);
  assert.deepEqual(visibility, []);
  assert.deepEqual(matrixPosition(child.worldTransform), [15, 0, 0]);
});

test('NodeGraph marks flat dirty siblings without enumerating the pending root sets', () => {
  const token = {}; const index = new NodeIndex(); const graph = new NodeGraph({ nodeIndex: index });
  const root = new Node({ name: 'sys/scene-root', sceneToken: token, transform: IDENTITY });
  const siblings = Array.from({ length: 256 }, (_, value) => new Node({
    name: `scene/main/sibling-${value}`,
    sceneToken: token,
    transform: IDENTITY,
  }));
  index.register(root); graph.attach(root);
  for (const sibling of siblings) {
    index.register(sibling);
    graph.attach(sibling, root);
  }
  graph.flushWorldTransforms();

  let transformIterations = 0;
  let visibilityIterations = 0;
  const transformIterator = graph._transformDirtyRoots[Symbol.iterator].bind(
    graph._transformDirtyRoots,
  );
  const visibilityIterator = graph._visibilityDirtyRoots[Symbol.iterator].bind(
    graph._visibilityDirtyRoots,
  );
  graph._transformDirtyRoots[Symbol.iterator] = function* countedTransformIterator() {
    transformIterations += 1;
    yield* transformIterator();
  };
  graph._visibilityDirtyRoots[Symbol.iterator] = function* countedVisibilityIterator() {
    visibilityIterations += 1;
    yield* visibilityIterator();
  };

  const transformed = [];
  const visibility = [];
  graph.setCallbacks({
    onWorldTransform(node) { transformed.push(node.name); },
    onVisibility(node) { visibility.push(node.name); },
  });
  for (const [value, sibling] of siblings.entries()) {
    sibling.setLocalTransform(matrixTransform({ position: [value + 1, 0, 0] }));
    sibling.setVisible(false);
  }

  assert.equal(transformIterations, 0);
  assert.equal(visibilityIterations, 0);
  assert.deepEqual(graph.flushWorldTransforms(), {
    transformCount: siblings.length,
    visibilityCount: siblings.length,
  });
  assert.equal(transformIterations, 1);
  assert.equal(visibilityIterations, 1);
  assert.deepEqual(transformed, siblings.map((node) => node.name));
  assert.deepEqual(visibility, siblings.map((node) => node.name));
  assert.deepEqual(matrixPosition(siblings.at(-1).worldTransform), [siblings.length, 0, 0]);
  assert.equal(siblings.at(-1).visibleInHierarchy, false);
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
