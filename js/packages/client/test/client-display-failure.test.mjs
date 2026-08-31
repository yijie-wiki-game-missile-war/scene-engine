import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PREFAB_DEFINITION_SCHEMA,
  SCENE_DEFINITION_SCHEMA,
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
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
  baselineNode,
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

test('canonical Wire fixtures install and commit against the canonical Display catalog', async (t) => {
  const fixture = (path) => new URL(`../../../../fixtures/${path}`, import.meta.url);
  const manifest = JSON.parse(await readFile(
    fixture('display-catalog-v2/manifest.json'), 'utf8',
  ));
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry(manifest.resources);
  const prefabRegistry = createPrefabRegistry(manifest.prefabs.map((value) => definePrefab(value)));
  const sceneRegistry = createSceneRegistry(manifest.scenes.map((value) => defineScene(value)));
  const runtimes = [];
  const client = new SceneEngineClient({
    createDisplaySession() {
      let nextFrameId = 0;
      const runtime = createDisplayRuntime({
        sceneRegistry,
        prefabRegistry,
        resourceRegistry,
        componentRegistry,
        authorityStateSchemas: manifest.authorityStateSchemas,
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

  const checkpoint = client.applyPacket(new Uint8Array(
    await readFile(fixture('wire-v3/checkpoint.bin')),
  ));
  const commit = client.applyPacket(new Uint8Array(
    await readFile(fixture('wire-v3/commit-tick.bin')),
  ));
  assert.ok(checkpoint.ackPacket instanceof Uint8Array);
  assert.ok(commit.ackPacket instanceof Uint8Array);
  const view = client.currentDisplayView();
  const aircraft = view.getNode('py/1');
  assert.equal(view.health, 'ready');
  assert.equal(aircraft.localTransform[4], 0.25);
  assert.equal(aircraft.localTransform[12], 1.5);
  assert.equal(aircraft.visibleSelf, false);
  assert.notEqual(view.getNode('prefab/py/1/body'), null);
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

test('real DisplayRuntime returns no ACK for command or world-overflow commit failures', async (t) => {
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry([]);
  const prefab = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'unit.example',
    gameplayType: 'unit.example',
    root: { components: [], children: [] },
  });
  const prefabRegistry = createPrefabRegistry([prefab]);
  const sceneRegistry = createSceneRegistry([defineScene({
    schema: SCENE_DEFINITION_SCHEMA,
    id: 'main',
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
  const authorityStateSchemas = Object.freeze([Object.freeze({
    gameplayType: 'unit.example', schemaId: 'unit.example.state', revision: 1,
  })]);
  const catalogIdentity = computeDisplayCatalogIdentity(buildDisplayCatalogManifest({
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas,
  }));

  const runtimes = [];
  const clients = [];
  const createRealClient = () => new SceneEngineClient({
    createDisplaySession({ sceneName }) {
      assert.equal(sceneName, 'main');
      let nextFrameId = 0;
      const runtime = createDisplayRuntime({
        sceneRegistry,
        prefabRegistry,
        resourceRegistry,
        componentRegistry,
        authorityStateSchemas,
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
  const client = createRealClient();
  clients.push(client);
  t.after(async () => {
    for (const activeClient of clients) activeClient.dispose();
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  });

  const checkpoint = client.applyPacket(checkpointPacket({
    sceneCatalogHash: catalogIdentity.sceneCatalogHash,
    prefabCatalogHash: catalogIdentity.prefabCatalogHash,
    stateSchemaHash: catalogIdentity.stateSchemaHash,
    matrixPoolSize: 2,
  }));
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
            node_id: 1,
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
  assert.equal(failedView.getNode('py/0').visibleSelf, false);
  assert.equal(failedView.health, 'projection-invalid');
  assert.equal(runtimes[0].summary().health, 'projection-invalid');
  assert.throws(
    () => client.applyPacket(commitPacket()),
    (error) => error.code === 'client-failed',
  );

  const overflowClient = createRealClient();
  clients.push(overflowClient);
  const localScale = new Float32Array([
    1000, 0, 0, 0,
    0, 1000, 0, 0,
    0, 0, 1000, 0,
    0, 0, 0, 1,
  ]);
  const nodes = Array.from({ length: 101 }, (_, index) => baselineNode(
    index,
    index === 0 ? null : index - 1,
  ));
  const matrixPool = new Float32Array(nodes.length * 16);
  for (const node of nodes) matrixPool.set(localScale, node.node_id * 16);
  const overflowCheckpoint = overflowClient.applyPacket(checkpointPacket({
    nodes,
    matrixPoolSize: nodes.length,
    matrixPool,
    sceneCatalogHash: catalogIdentity.sceneCatalogHash,
    prefabCatalogHash: catalogIdentity.prefabCatalogHash,
    stateSchemaHash: catalogIdentity.stateSchemaHash,
  }));
  assert.ok(overflowCheckpoint.ackPacket instanceof Uint8Array);
  const acknowledged = overflowClient.currentCommit();
  const hugeRootScale = new Float32Array([
    1e10, 0, 0, 0,
    0, 1e10, 0, 0,
    0, 0, 1e10, 0,
    0, 0, 0, 1,
  ]);
  const noOverflowOutcome = Symbol('no-overflow-outcome');
  let overflowOutcome = noOverflowOutcome;
  assert.throws(() => {
    overflowOutcome = overflowClient.applyPacket(commitPacket({
      commands: [command('node-set-transform-batch', 1, 1, {
        node_ids: new Uint32Array([0]), matrices: hugeRootScale,
      })],
      matrixPoolSize: nodes.length,
    }));
  }, (error) => error.code === 'display-transform-world-nonfinite');
  assert.equal(overflowOutcome, noOverflowOutcome, 'overflow commit must not return an ACK outcome');
  assert.strictEqual(overflowClient.currentCommit(), acknowledged);
  assert.equal(overflowClient.currentDisplayView().health, 'projection-invalid');
  assert.throws(() => overflowClient.applyPacket(commitPacket()),
    (error) => error.code === 'client-failed');
});
