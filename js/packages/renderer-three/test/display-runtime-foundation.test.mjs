import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GEOMETRY_PREFAB_ID,
  NESTED_PREFAB_ID,
  authorityNodeName,
  backendRecord,
  commitAuthority,
  createAuthorityNode,
  createFoundationHarness,
  transformAt,
} from './display-runtime-support.mjs';

const ROOT_ID = 0;
const MOVER_ID = 1;
const ROOT = authorityNodeName(ROOT_ID);
const MOVER = authorityNodeName(MOVER_ID);
const FIXED = `prefab/${ROOT}/fixed`;
const DYNAMIC_ALPHA = `prefab/${ROOT}/units/alpha`;
const DYNAMIC_BRAVO = `prefab/${ROOT}/units/bravo`;

function geometryNode(root, localName) { return `prefab/${root}/${localName}`; }

function translation(matrix) { return Array.from(matrix.slice(12, 15)); }

function assertTupleAlmostEqual(actual, expected, epsilon = 1e-12) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= epsilon,
      `tuple[${index}] expected ${expected[index]}, received ${actual[index]}`);
  }
}

function assertZeroBackendOwnership(entry) {
  const diagnostics = entry.backend.diagnostics();
  assert.equal(diagnostics.bindingCount, 0);
  assert.equal(diagnostics.nodeBindingCount, 0);
  assert.equal(diagnostics.batchCount, 0);
  assert.equal(diagnostics.instanceCount, 0);
  assert.equal(diagnostics.pendingBindingCount, 0);
  assert.equal(diagnostics.resourceCount, 0);
  assert.equal(diagnostics.readyResourceCount, 0);
  assert.equal(diagnostics.resourceLeaseCount, 0);
  assert.equal(diagnostics.pendingResourceCount, 0);
  assert.equal(diagnostics.disposed, true);
  assert.equal(entry.renderer.disposed, true);
  assert.equal(entry.observerDisconnected, true);
}

test('DisplayRuntime drives geometry, nested Prefabs, authority activity, animation, rebuild, and zero-resource disposal',
  async () => {
    const harness = await createFoundationHarness();
    const { runtime, frames, backends, health } = harness;
    const nodeIndex = runtime._nodeIndex;
    const scheduler = runtime._scheduler;
    const animationSystem = runtime._animationSystem;
    const renderSystem = runtime._renderSystem;
    try {
      const rootTransform = transformAt([10, 0, 0]);
      commitAuthority(runtime, () => runtime.authority.createNode(createAuthorityNode({
        nodeId: ROOT_ID,
        displayKindId: NESTED_PREFAB_ID,
        state: {
          fixedState: { particleIntensity: 0.5 },
          units: {
            alpha: {
              prefabId: GEOMETRY_PREFAB_ID,
              transform: transformAt([3, 0, 0]),
              visible: true,
              state: { meshRenderOrder: 2 },
            },
          },
        },
      })), { matrixRows: [[ROOT_ID, rootTransform]] });
      const moverTransform = transformAt([-2, 1, 0]);
      commitAuthority(runtime, () => runtime.authority.createNode(createAuthorityNode({
        nodeId: MOVER_ID,
      })), { matrixRows: [[MOVER_ID, moverTransform]] });
      await runtime.whenReady();

      const initialView = runtime.currentView();
      assert.equal(initialView.getNode(FIXED).parentName, `prefab/${ROOT}/mount`);
      assert.equal(initialView.getNode(DYNAMIC_ALPHA).parentName, `prefab/${ROOT}/mount`);
      assert.deepEqual(translation(initialView.getWorldTransform(`${FIXED}/mesh-node`)), [11, 0, 0]);
      assert.equal(initialView.getComponentState(`${DYNAMIC_ALPHA}/mesh-node`, 'mesh')
        .properties.renderOrder, 2);
      assert.equal(initialView.getComponentState(`${FIXED}/particle-node`, 'particle')
        .properties.intensity, 0.5);

      frames.step(16);
      const firstBackend = backends[0].backend;
      const moverRecords = {
        mesh: backendRecord(firstBackend, geometryNode(MOVER, 'mesh-node'), 'mesh'),
        sprite: backendRecord(firstBackend, geometryNode(MOVER, 'sprite-node'), 'sprite'),
        model: backendRecord(firstBackend, geometryNode(MOVER, 'model-node'), 'model'),
        surface: backendRecord(firstBackend, geometryNode(MOVER, 'surface-node'), 'surface'),
        particle: backendRecord(firstBackend, geometryNode(MOVER, 'particle-node'), 'particle'),
      };
      for (const [kind, record] of Object.entries(moverRecords)) {
        assert.notEqual(record, null, `${kind} binding must reach the real Three backend`);
      }
      assert.equal(moverRecords.mesh.handle.object.isMesh, true);
      assert.equal(moverRecords.sprite.handle.object.isMesh, true);
      assert.equal(moverRecords.sprite.handle.object.geometry.type, 'PlaneGeometry');
      assert.equal(moverRecords.model.handle.object.isGroup, true);
      assert.equal(moverRecords.model.handle.object.children[0].isMesh, true);
      assert.equal(moverRecords.surface.handle.object.isMesh, true);
      assert.equal(moverRecords.surface.handle.object.material.type, 'ShaderMaterial');
      assert.equal(moverRecords.particle.handle.object.isPoints, true);
      assert.equal(moverRecords.sprite.properties.frame, 0);
      assert.equal(moverRecords.sprite.batchable, false,
        'Display animation ownership keeps the live sprite out of static batching');
      assert.equal(frames.pending, 1,
        'the requested-draw scene continues while surface/particle/animation paths are active');

      frames.step(110);
      assert.equal(moverRecords.sprite.properties.frame, 1,
        'sprite.frame is sampled from the Display-local visual clock');

      const halfTurn = Math.SQRT1_2;
      const moved = transformAt([2, 3, 4], {
        rotationXyzw: [0, 0, halfTurn, halfTurn],
        scale: [2, 3, 4],
      });
      commitAuthority(runtime, () => runtime.authority.setNodeTransforms({
        nodeIds: new Uint32Array([MOVER_ID]),
      }), {
        matrixRows: [[MOVER_ID, moved]],
      });
      let view = runtime.currentView();
      assertTupleAlmostEqual(view.getNode(MOVER).localTransform, moved);
      assert.deepEqual(translation(view.getWorldTransform(MOVER)), [2, 3, 4]);

      commitAuthority(runtime, () => runtime.authority.setNodeParent({
        nodeId: MOVER_ID,
        parentNodeId: ROOT_ID,
      }));
      view = runtime.currentView();
      assert.equal(view.getNode(MOVER).parentName, ROOT);
      assert.deepEqual(translation(view.getWorldTransform(MOVER)), [12, 3, 4]);

      commitAuthority(runtime, () => runtime.authority.setNodeVisible({
        nodeId: MOVER_ID,
        visible: false,
      }));
      frames.step(0);
      assert.equal(runtime.currentView().getNode(geometryNode(MOVER, 'mesh-node')).visibleInHierarchy,
        false);
      assert.equal(moverRecords.mesh.visible, false);
      assert.equal(moverRecords.particle.visible, false);

      const childTransform = transformAt([0.5, 1.5, 2.5], {
        rotationXyzw: [halfTurn, 0, 0, halfTurn],
        scale: [1.25, 0.75, 2],
      });
      commitAuthority(runtime, () => runtime.authority.setNodeState({
        nodeId: MOVER_ID,
        state: {
          meshTransform: childTransform,
          meshVisible: true,
          meshRenderOrder: 9,
          spriteAlpha: 0.4,
          particleIntensity: 2,
        },
      }));
      view = runtime.currentView();
      const meshTransform = view.getNode(geometryNode(MOVER, 'mesh-node')).localTransform;
      assertTupleAlmostEqual(meshTransform, childTransform);
      assert.equal(view.getComponentState(geometryNode(MOVER, 'mesh-node'), 'mesh')
        .properties.renderOrder, 9);
      assert.equal(view.getComponentState(geometryNode(MOVER, 'sprite-node'), 'sprite')
        .properties.alpha, 0.4);
      assert.equal(view.getComponentState(geometryNode(MOVER, 'particle-node'), 'particle')
        .properties.intensity, 2);

      commitAuthority(runtime, () => runtime.authority.setNodeVisible({
        nodeId: MOVER_ID,
        visible: true,
      }));
      commitAuthority(runtime, () => runtime.authority.setNodeState({
        nodeId: ROOT_ID,
        state: {
          fixedTransform: transformAt([5, 0, 0], { scale: [1.5, 1.5, 1.5] }),
          fixedVisible: false,
          fixedState: { meshRenderOrder: 7 },
          units: {
            bravo: {
              prefabId: GEOMETRY_PREFAB_ID,
              transform: transformAt([-3, 0, 0]),
              visible: true,
              state: { spriteAlpha: 0.6 },
            },
          },
        },
      }));
      await runtime.whenReady();
      view = runtime.currentView();
      assert.equal(view.getNode(DYNAMIC_ALPHA), null,
        'complete nested state removes a dynamic instance omitted from the desired set');
      assert.notEqual(view.getNode(DYNAMIC_BRAVO), null);
      assert.deepEqual(
        [0, 5, 10].map((index) => view.getNode(FIXED).localTransform[index]),
        [1.5, 1.5, 1.5],
      );
      assert.equal(view.getNode(`${FIXED}/mesh-node`).visibleInHierarchy, false);
      assert.equal(view.getComponentState(`${FIXED}/mesh-node`, 'mesh').properties.renderOrder, 7);
      assert.equal(view.getComponentState(`${DYNAMIC_BRAVO}/sprite-node`, 'sprite')
        .properties.alpha, 0.6);

      frames.step(0);
      const frameBeforeRebuild = moverRecords.sprite.properties.frame;
      const oldNodeCount = runtime.currentView().nodeCount;
      const oldBindingCount = firstBackend.diagnostics().bindingCount;
      await runtime.rebuildRenderBackend();
      await runtime.whenReady();
      frames.step(0);
      assert.equal(backends.length, 2);
      assert.equal(firstBackend.diagnostics().disposed, true);
      assert.equal(backends[0].renderer.disposed, true);
      assert.equal(backends[1].backend.diagnostics().bindingCount, oldBindingCount);
      assert.equal(runtime.currentView().nodeCount, oldNodeCount);
      const rebuiltSprite = backendRecord(
        backends[1].backend,
        geometryNode(MOVER, 'sprite-node'),
        'sprite',
      );
      assert.equal(rebuiltSprite.properties.frame, frameBeforeRebuild,
        'backend rebuild remounts the current effective animation value');
      frames.step(100);
      assert.equal(rebuiltSprite.properties.frame, (frameBeforeRebuild + 1) % 4,
        'animation phase continues after backend rebuild');

      commitAuthority(runtime, () => runtime.authority.removeNode({ nodeId: MOVER_ID }));
      assert.equal(runtime.currentView().getNode(MOVER), null);
      commitAuthority(runtime, () => runtime.authority.removeNode({ nodeId: ROOT_ID }));
      await runtime.whenReady();
      assert.equal(runtime.currentView().getNode(ROOT), null);
      const sceneOnly = backends[1].backend.diagnostics();
      assert.equal(sceneOnly.bindingCount, 3);
      assert.equal(sceneOnly.resourceCount, 0);
      assert.equal(sceneOnly.resourceLeaseCount, 0);
      assert.deepEqual(health, []);
    } finally {
      await runtime.dispose();
    }

    assert.equal(nodeIndex.size, 0);
    assert.equal(scheduler._registered.size, 0);
    assert.equal(animationSystem._players.size, 0);
    assert.equal(renderSystem._entries.size, 0);
    assert.equal(frames.pending, 0);
    for (const backend of backends) assertZeroBackendOwnership(backend);
  });
