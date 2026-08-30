import assert from 'node:assert/strict';
import test from 'node:test';

import { Node } from '../src/node/node.js';
import { NodeGraph } from '../src/node/node-graph.js';
import { NodeIndex } from '../src/node/node-index.js';

const IDENTITY = Object.freeze({
  position: Object.freeze([0, 0, 0]),
  rotationXyzw: Object.freeze([0, 0, 0, 1]),
  scale: Object.freeze([1, 1, 1]),
});

function createNode(token, name, transform = IDENTITY) {
  return new Node({ name, sceneToken: token, transform });
}

function createForestHarness() {
  const token = {};
  const index = new NodeIndex();
  const graph = new NodeGraph({ nodeIndex: index });
  const nodes = {
    root: createNode(token, 'sys/scene-root', { ...IDENTITY, position: [10, 0, 0] }),
    alpha: createNode(token, 'scene/main/alpha'),
    alphaLeaf: createNode(token, 'scene/main/alpha-leaf'),
    middle: createNode(token, 'scene/main/middle'),
    bravo: createNode(token, 'scene/main/bravo'),
    bravoLeaf: createNode(token, 'scene/main/bravo-leaf'),
    orphan: createNode(token, 'scene/main/orphan'),
  };
  for (const node of Object.values(nodes)) index.register(node);
  graph.attach(nodes.root);
  graph.attach(nodes.alpha, nodes.root);
  graph.attach(nodes.alphaLeaf, nodes.alpha);
  graph.attach(nodes.middle, nodes.root);
  graph.attach(nodes.bravo, nodes.root);
  graph.attach(nodes.bravoLeaf, nodes.bravo);
  graph.flushWorldTransforms();
  return { graph, index, nodes };
}

function topologySnapshot(graph, nodes) {
  return {
    transformDirtyRoots: [...graph._transformDirtyRoots],
    visibilityDirtyRoots: [...graph._visibilityDirtyRoots],
    entries: new Map(Object.entries(nodes).map(([key, node]) => [key, {
      graph: node._graph,
      parent: node.parent,
      children: [...node.children],
    }])),
  };
}

function assertTopologySnapshot(graph, nodes, snapshot) {
  assert.deepEqual([...graph._transformDirtyRoots], snapshot.transformDirtyRoots);
  assert.deepEqual([...graph._visibilityDirtyRoots], snapshot.visibilityDirtyRoots);
  for (const [key, expected] of snapshot.entries) {
    const node = nodes[key];
    assert.strictEqual(node._graph, expected.graph);
    assert.strictEqual(node.parent, expected.parent);
    assert.deepEqual(node.children, expected.children);
  }
}

test('detachForest rejects duplicate, non-closed, and detached inputs before any write', () => {
  const { graph, nodes } = createForestHarness();

  for (const [invalid, code] of [
    [[nodes.bravo, nodes.bravo], 'display-node-forest-invalid'],
    [[nodes.alpha], 'display-node-forest-invalid'],
    [[nodes.orphan], 'display-node-detached'],
    [[nodes.root, nodes.alpha, nodes.alphaLeaf, nodes.middle, nodes.bravo, nodes.bravoLeaf],
      'display-node-forest-invalid'],
  ]) {
    const before = topologySnapshot(graph, nodes);
    assert.throws(() => graph.detachForest(invalid), { code });
    assertTopologySnapshot(graph, nodes, before);
  }
});

test('restoreForest restores exact sibling order, ancestry, and pending dirty behavior', () => {
  const transformed = [];
  const visibility = [];
  const { graph, nodes } = createForestHarness();
  graph.setCallbacks({
    onWorldTransform(node) { transformed.push(node.name); },
    onVisibility(node) { visibility.push(node.name); },
  });
  nodes.alpha.setLocalTransform({ ...IDENTITY, position: [3, 0, 0] });
  nodes.bravo.setVisible(false);
  const originalOrder = nodes.root.children;
  const forest = [nodes.alpha, nodes.alphaLeaf, nodes.bravo, nodes.bravoLeaf];

  const token = graph.detachForest(forest);
  assert.deepEqual(nodes.root.children, [nodes.middle]);
  for (const node of forest) {
    assert.strictEqual(node.parent, null);
    assert.strictEqual(node._graph, null);
  }

  graph.restoreForest(token);
  assert.deepEqual(nodes.root.children, originalOrder);
  assert.strictEqual(nodes.alphaLeaf.parent, nodes.alpha);
  assert.strictEqual(nodes.bravoLeaf.parent, nodes.bravo);
  for (const node of forest) assert.strictEqual(node._graph, graph);

  graph.flushWorldTransforms();
  assert.deepEqual(nodes.alpha.worldTransform.position, [13, 0, 0]);
  assert.equal(nodes.bravo.visibleInHierarchy, false);
  assert.equal(nodes.bravoLeaf.visibleInHierarchy, false);
  assert.deepEqual(transformed, [nodes.alpha.name, nodes.alphaLeaf.name]);
  assert.deepEqual(visibility, [nodes.bravo.name, nodes.bravoLeaf.name]);
  assert.throws(() => graph.restoreForest(token), { code: 'display-node-forest-invalid' });
  assert.throws(() => graph.commitDetachedForest(token), { code: 'display-node-forest-invalid' });
});

test('a committed detached forest token cannot be restored or committed twice', () => {
  const { graph, nodes } = createForestHarness();
  const token = graph.detachForest([nodes.alpha, nodes.alphaLeaf]);
  graph.commitDetachedForest(token);

  assert.throws(() => graph.restoreForest(token), { code: 'display-node-forest-invalid' });
  assert.throws(() => graph.commitDetachedForest(token), { code: 'display-node-forest-invalid' });
  assert.deepEqual(nodes.root.children, [nodes.middle, nodes.bravo]);
  assert.strictEqual(nodes.alpha._graph, null);
  assert.strictEqual(nodes.alphaLeaf._graph, null);
});

test('restoreChildOrder reorders only the same attached child set and fails before mutation', () => {
  const { graph, nodes } = createForestHarness();
  const desired = [nodes.bravo, nodes.middle, nodes.alpha];
  graph.restoreChildOrder(nodes.root, desired);
  assert.deepEqual(nodes.root.children, desired);

  for (const invalid of [
    [nodes.alpha, nodes.middle],
    [nodes.alpha, nodes.alpha, nodes.bravo],
    [nodes.alpha, nodes.middle, nodes.alphaLeaf],
  ]) {
    assert.throws(() => graph.restoreChildOrder(nodes.root, invalid),
      { code: 'display-node-forest-invalid' });
    assert.deepEqual(nodes.root.children, desired);
  }
});
