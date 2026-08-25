import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  definePrefab,
  defineScene,
} from '../../display/src/index.js';
import { createFakeRenderBackend } from '../../display/src/testing/fake-render-backend.js';
import { SceneEngineClient } from '../src/index.js';
import {
  checkpointPacket,
  command,
  commitPacket,
  createMockDisplayFactory,
  transform,
} from './support.mjs';

const RENDERER_PROFILE = Object.freeze({
  drawMode: 'requested',
  maximumPixelRatio: 1,
  clearRgba: 0x000000ff,
  antialias: false,
  alpha: false,
  shadows: false,
  toneMapping: 'none',
});

test('rejected thenables are observed while synchronous barriers fail closed', async (t) => {
  const unhandled = [];
  const onUnhandledRejection = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandledRejection);
  t.after(() => process.off('unhandledRejection', onUnhandledRejection));

  const factoryClient = new SceneEngineClient({
    createDisplaySession: () => Promise.reject(new Error('factory-rejected')),
  });
  assert.throws(
    () => factoryClient.applyPacket(checkpointPacket()),
    (error) => error.code === 'display-session-factory-async',
  );

  const { factory, sessions } = createMockDisplayFactory();
  const authorityClient = new SceneEngineClient({ createDisplaySession: factory });
  authorityClient.applyPacket(checkpointPacket());
  sessions[0].session.authorityPort.setNodeVisible = () => (
    Promise.reject(new Error('authority-rejected'))
  );
  sessions[0].session.commitGate.fail = () => Promise.reject(new Error('gate-fail-rejected'));
  assert.throws(
    () => authorityClient.applyPacket(commitPacket({
      commands: [command('node-set-visible', 1, 1, { visible: false })],
    })),
    (error) => error.code === 'authority-operation-async',
  );
  assert.throws(
    () => authorityClient.applyPacket(commitPacket()),
    (error) => error.code === 'client-failed',
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  factoryClient.dispose();
  authorityClient.dispose();
});

test('real DisplayRuntime invalidates a partially mutated failed commit without an ACK', async (t) => {
  const runtimes = [];
  const client = new SceneEngineClient({
    createDisplaySession({ sceneName }) {
      const componentRegistry = createComponentRegistry();
      const resourceRegistry = createResourceRegistry([]);
      const prefab = definePrefab({
        schema: PREFAB_DEFINITION_SCHEMA,
        id: 'client-test.unit',
        logicalType: 'unit.example',
        root: { components: [], children: [] },
      });
      const prefabRegistry = createPrefabRegistry([{
        sceneProfile: 'client-test',
        logicalType: prefab.logicalType,
        definition: prefab,
      }]);
      const sceneRegistry = createSceneRegistry([defineScene({
        schema: SCENE_DEFINITION_SCHEMA,
        id: sceneName,
        sceneProfile: 'client-test',
        rendererProfile: RENDERER_PROFILE,
        activeCameraLocalName: 'camera',
        nodes: [{
          localName: 'camera',
          parentLocalName: null,
          transform: transform(),
          components: [{
            key: 'camera',
            type: 'render.camera@1',
            properties: {
              projection: 'perspective',
              fovYDegrees: 50,
              near: 0.1,
              far: 100,
            },
          }],
        }],
        prefabInstances: [],
      })]);
      let nextFrameId = 0;
      const runtime = createDisplayRuntime({
        sceneRegistry,
        prefabRegistry,
        resourceRegistry,
        componentRegistry,
        createRenderBackend: () => createFakeRenderBackend().backend,
        frameAdapter: {
          request: () => { nextFrameId += 1; return nextFrameId; },
          cancel: () => {},
          now: () => 0,
        },
      });
      runtimes.push(runtime);
      return {
        runtime,
        authorityPort: runtime.authority,
        commitGate: runtime.commitGate,
        dispose: () => runtime.dispose(),
      };
    },
  });
  t.after(async () => {
    client.dispose();
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  });

  const checkpoint = client.applyPacket(checkpointPacket());
  assert.ok(checkpoint.ackPacket instanceof Uint8Array);
  const beforeCommit = client.currentCommit();
  const beforeWorld = client.currentWorldState();
  const noOutcome = Symbol('no-outcome');
  let failedOutcome = noOutcome;

  assert.throws(
    () => {
      failedOutcome = client.applyPacket(commitPacket({
        commands: [
          command('node-set-visible', 1, 1, { visible: false }),
          command('node-set-state', 2, 1, {
            name: 'py/missing',
            state: { mode: 'unreachable' },
          }),
        ],
      }));
    },
    (error) => error.code === 'display-node-missing',
  );

  assert.equal(failedOutcome, noOutcome, 'failed commit must not return an ACK outcome');
  assert.strictEqual(client.currentCommit(), beforeCommit);
  assert.strictEqual(client.currentWorldState(), beforeWorld);
  const failedView = client.currentDisplayView();
  assert.equal(failedView.getNode('py/unit-1').visibleSelf, false);
  assert.equal(failedView.health, 'projection-invalid');
  assert.equal(runtimes[0].summary().health, 'projection-invalid');
  assert.throws(
    () => client.applyPacket(commitPacket()),
    (error) => error.code === 'client-failed',
  );
});
