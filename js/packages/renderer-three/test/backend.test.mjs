import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { loadThreeResource } from '../src/resources.js';
import { compensatePanelViewPoint } from '../src/panel-projection.js';
import {
  CAMERA_PROPERTIES,
  INLINE_RESOURCES,
  createHarness,
  descriptor,
  frame,
  patch,
} from './support.mjs';

test('new bindings own a complete identity world matrix before the first Display update', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const properties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
    castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true };
  const bindings = await Promise.all(['a', 'b'].map((name) => backend.createBinding(
    descriptor(`py/${name}`, 'mesh', 'render.mesh@1', properties, registry),
  )));
  const identity = new THREE.Matrix4().toArray();
  for (const binding of bindings) {
    const worldMatrix = backend._records.get(binding).worldMatrix;
    assert.equal(worldMatrix.length, 16);
    assert.deepEqual(worldMatrix, identity);
  }

  backend.prepareFrame(frame(camera));
  const instance = new THREE.Matrix4();
  backend._batches[0].object.getMatrixAt(0, instance);
  assert.deepEqual(instance.toArray(), identity);
  backend.dispose();
});

test('real Three bindings are flat per node and consume Engine world matrices', async () => {
  const { backend, registry, renderer } = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  assert.equal(backend._records.get(camera).handle.camera.aspect, 4 / 3,
    'a camera created after initial resize inherits the current host aspect');
  const meshProperties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
    castShadow: true, receiveShadow: true, renderOrder: 2, pickable: true };
  const first = await backend.createBinding(descriptor('py/aircraft', 'body',
    'render.mesh@1', meshProperties, registry));
  const second = await backend.createBinding(descriptor('py/aircraft', 'outline',
    'render.mesh@1', meshProperties, registry));
  const cameraMatrix = new THREE.Matrix4().makeTranslation(0, 0, 5);
  const modelMatrix = new THREE.Matrix4().makeTranslation(2, 3, 4);
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES, cameraMatrix));
  backend.updateBinding(first, patch('py/aircraft', 'body', meshProperties, modelMatrix));
  backend.updateBinding(second, patch('py/aircraft', 'outline', meshProperties, modelMatrix));
  const preparation = backend.prepareFrame(frame(camera, 12, 1.5));
  assert.equal(preparation.requiresContinuousDraw, false);
  assert.equal(backend.diagnostics().nodeBindingCount, 2);
  assert.equal(backend.diagnostics().bindingCount, 3);
  assert.equal(backend.diagnostics().batchCount, 1);
  assert.equal(backend.diagnostics().instanceCount, 2);
  const nodeRoot = backend._nodes.get('py/aircraft').object;
  assert.equal(nodeRoot.parent, null,
    'a Node root with only batched representations is absent from Three scene traversal');
  assert.equal(nodeRoot.matrixAutoUpdate, false);
  assert.deepEqual(nodeRoot.matrix.toArray(), modelMatrix.toArray());
  assert.equal(backend._root.children.some((child) => child.name.includes('parent')), false);
  backend.render();
  assert.equal(renderer.draws, 1);
  assert.equal(backend.diagnostics().rendererCalls, 1);
  backend.destroyBinding(first); backend.destroyBinding(second); backend.destroyBinding(camera);
  assert.equal(backend.diagnostics().nodeBindingCount, 0);
  backend.dispose();
});

test('pick and project return only node/component identities and plain coordinates', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const meshProperties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
    castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true };
  const mesh = await backend.createBinding(descriptor('py/target', 'mesh', 'render.mesh@1',
    meshProperties, registry));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 5)));
  backend.updateBinding(mesh, patch('py/target', 'mesh', meshProperties));
  backend.prepareFrame(frame(camera));
  const projected = backend.projectWorldPoint({ position: [0, 0, 0] });
  assert.equal(projected.visible, true);
  assert.ok(Math.abs(projected.clientX - 400) < 1e-6);
  assert.ok(Math.abs(projected.clientY - 300) < 1e-6);
  const hit = backend.pick({ clientX: 400, clientY: 300 });
  assert.equal(hit.nodeName, 'py/target');
  assert.equal(hit.componentKey, 'mesh');
  assert.deepEqual(Object.keys(hit).sort(), ['componentKey', 'distance', 'nodeName', 'point']);
  backend.render();
  const cameraBefore = backend._activeCamera.handle.camera.position.toArray();
  const suggestion = backend.focusWorldPoint({ position: [1, 2, 3], radius: 2 });
  assert.equal(suggestion.nodeName, 'scene/camera');
  assert.deepEqual(backend._activeCamera.handle.camera.position.toArray(), cameraBefore,
    'focus returns a Node-transform suggestion and never mutates the backend camera');
  backend.dispose();
});

test('ordinary, panel, and batched picking obeys the active camera near/far planes', async () => {
  for (const kind of ['mesh', 'panel']) {
    for (const count of [1, 2]) {
      const textureDescriptor = { id: 'texture/pick-panel', kind: 'texture', url: 'memory:panel' };
      const descriptors = kind === 'mesh' ? INLINE_RESOURCES : [textureDescriptor];
      const { backend, registry } = createHarness({
        descriptors,
        loadResource: kind === 'mesh' ? loadThreeResource : async (resource) => ({
          kind: resource.kind, descriptor: resource, texture: new THREE.Texture(), ownsTexture: true,
        }),
      });
      try {
        const cameraProperties = { ...CAMERA_PROPERTIES, near: 1, far: 10 };
        const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
          'render.camera@1', cameraProperties, registry));
        backend.updateBinding(camera, patch('scene/camera', 'camera', cameraProperties));
        const properties = kind === 'mesh'
          ? { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
            castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true }
          : { textureResourceId: 'texture/pick-panel', width: 2, height: 2,
            frame: 0, pickable: true };
        const bindings = [];
        for (let index = 0; index < count; index += 1) {
          const nodeName = `py/${kind}-${index}`;
          const binding = await backend.createBinding(descriptor(nodeName, kind,
            kind === 'mesh' ? 'render.mesh@1' : 'render.sprite@3', properties, registry));
          const x = index * 4;
          const update = patch(nodeName, kind, properties,
            new THREE.Matrix4().makeTranslation(x, 0, -20));
          backend.updateBinding(binding, kind === 'panel'
            ? { ...update, panelAnchorWorld: [x, 0, -20] } : update);
          bindings.push({ binding, nodeName });
        }
        backend.prepareFrame(frame(camera));
        assert.equal(backend.diagnostics().batchCount, count === 1 ? 0 : 1);
        assert.equal(backend.pick({ clientX: 400, clientY: 300 }), null,
          `${kind}/${count} beyond far plane must not be pickable`);

        const first = bindings[0];
        let update = patch(first.nodeName, kind, properties,
          new THREE.Matrix4().makeTranslation(0, 0, -5));
        backend.updateBinding(first.binding, kind === 'panel'
          ? { ...update, panelAnchorWorld: [0, 0, -5] } : update);
        backend.prepareFrame(frame(camera, 1));
        assert.equal(backend.pick({ clientX: 400, clientY: 300 })?.nodeName, first.nodeName);

        update = patch(first.nodeName, kind, properties,
          new THREE.Matrix4().makeTranslation(0, 0, -0.5));
        backend.updateBinding(first.binding, kind === 'panel'
          ? { ...update, panelAnchorWorld: [0, 0, -0.5] } : update);
        backend.prepareFrame(frame(camera, 2));
        assert.equal(backend.pick({ clientX: 400, clientY: 300 }), null,
          `${kind}/${count} before near plane must not be pickable`);
      } finally { backend.dispose(); }
    }
  }
});

test('environment-only background keeps its explicit color across async resource replacement', async () => {
  const descriptors = [
    { id: 'texture/environment-a', kind: 'texture', url: 'memory:a' },
    { id: 'texture/environment-b', kind: 'texture', url: 'memory:b' },
  ];
  const loadResource = async (resource) => {
    const texture = new THREE.Texture(); texture.name = resource.id;
    return { kind: 'texture', descriptor: resource, texture, ownsTexture: true };
  };
  const { backend, registry } = createHarness({ descriptors, loadResource });
  const initial = { colorRgba: 0x2244_66ff, textureResourceId: null,
    environmentResourceId: 'texture/environment-a' };
  const binding = await backend.createBinding(descriptor('scene/environment', 'background',
    'render.background@1', initial, registry));
  assert.equal(backend._scene.background.getHex(), 0x224466);
  assert.equal(backend._scene.environment.name, 'texture/environment-a');
  const next = { ...initial, colorRgba: 0x1133_55ff,
    environmentResourceId: 'texture/environment-b' };
  backend.updateBinding(binding, patch('scene/environment', 'background', next));
  await backend.whenIdle();
  assert.equal(backend._scene.background.getHex(), 0x113355);
  assert.equal(backend._scene.environment.name, 'texture/environment-b');
  backend.dispose();
});

test('reverting to the active resource cancels a pending replacement generation', async () => {
  let resolveReplacement;
  const descriptors = [
    { id: 'texture/active', kind: 'texture', url: 'memory:active' },
    { id: 'texture/pending', kind: 'texture', url: 'memory:pending' },
  ];
  const loadResource = async (resource) => {
    if (resource.id === 'texture/pending') {
      return new Promise((resolve) => { resolveReplacement = () => {
        const texture = new THREE.Texture(); texture.name = resource.id;
        resolve({ kind: 'texture', descriptor: resource, texture, ownsTexture: true });
      }; });
    }
    const texture = new THREE.Texture(); texture.name = resource.id;
    return { kind: 'texture', descriptor: resource, texture, ownsTexture: true };
  };
  const { backend, registry } = createHarness({ descriptors, loadResource });
  const active = { colorRgba: 0x1122_33ff, textureResourceId: null,
    environmentResourceId: 'texture/active' };
  const binding = await backend.createBinding(descriptor('scene/environment', 'background',
    'render.background@1', active, registry));
  const pending = { ...active, environmentResourceId: 'texture/pending' };
  backend.updateBinding(binding, patch('scene/environment', 'background', pending));
  await Promise.resolve();
  backend.updateBinding(binding, patch('scene/environment', 'background', active));
  resolveReplacement();
  await backend.whenIdle();
  assert.equal(backend._scene.environment.name, 'texture/active');
  assert.deepEqual(backend._records.get(binding).resourceIds, ['texture/active']);
  backend.dispose();
});

test('resource replacement reuses one target load and installs the latest full patch', async () => {
  const descriptors = [
    { id: 'texture/active', kind: 'texture-atlas', url: 'memory:active', columns: 2, rows: 2 },
    { id: 'texture/pending', kind: 'texture-atlas', url: 'memory:pending', columns: 2, rows: 2 },
    { id: 'texture/superseding', kind: 'texture-atlas', url: 'memory:superseding', columns: 2, rows: 2 },
  ];
  const loadCounts = new Map(); const resolvers = new Map();
  const makeAsset = (resource) => ({ kind: resource.kind, descriptor: resource,
    texture: new THREE.Texture(), ownsTexture: true });
  const loadResource = (resource) => {
    loadCounts.set(resource.id, (loadCounts.get(resource.id) ?? 0) + 1);
    if (resource.id === 'texture/active') return Promise.resolve(makeAsset(resource));
    return new Promise((resolve) => resolvers.set(resource.id, () => resolve(makeAsset(resource))));
  };
  const { backend, registry } = createHarness({ descriptors, loadResource });
  const base = { textureResourceId: 'texture/active', width: 2, height: 3,
    frame: 0, pickable: true };
  const binding = await backend.createBinding(descriptor('py/panel', 'sprite',
    'render.sprite@3', base, registry));
  const firstMatrix = new THREE.Matrix4().makeTranslation(1, 2, -3);
  const first = { ...patch('py/panel', 'sprite', {
    ...base, textureResourceId: 'texture/pending', frame: 1,
  }, firstMatrix, false, true), panelAnchorWorld: [1, 0, -3] };
  backend.updateBinding(binding, first);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(loadCounts.get('texture/pending'), 1);

  const latestMatrix = new THREE.Matrix4().makeTranslation(4, 5, -6);
  const latest = { ...patch('py/panel', 'sprite', {
    ...base, textureResourceId: 'texture/pending', frame: 3,
  }, latestMatrix, true, false), panelAnchorWorld: [4, 1, -6] };
  backend.updateBinding(binding, latest);
  await Promise.resolve();
  assert.equal(loadCounts.get('texture/pending'), 1,
    'same target full patches must not abort and restart the resource load');
  resolvers.get('texture/pending')();
  await backend.whenIdle();

  const record = backend._records.get(binding);
  assert.deepEqual(record.resourceIds, ['texture/pending']);
  assert.equal(record.properties.frame, 3);
  assert.equal(record.batchable, false);
  assert.equal(record.visible, true);
  assert.deepEqual(record.panelAnchorWorld, [4, 1, -6]);
  assert.deepEqual(record.nodeRoot.matrix.toArray(), latestMatrix.toArray());
  assert.equal(record.handle.object.visible, true);

  // A different pending target supersedes the first generation. Returning to
  // another target must win even when the abandoned loader resolves later.
  backend.updateBinding(binding, { ...latest,
    properties: { ...base, textureResourceId: 'texture/superseding', frame: 2 } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(loadCounts.get('texture/superseding'), 1);
  backend.updateBinding(binding, { ...latest, properties: base });
  await Promise.resolve(); await Promise.resolve();
  resolvers.get('texture/superseding')();
  await backend.whenIdle();
  assert.deepEqual(record.resourceIds, ['texture/active']);
  assert.equal(record.properties.frame, 0);
  backend.dispose();
});

test('camera, background, and all light bindings are explicit with no default light', async () => {
  const { backend, registry } = createHarness();
  assert.equal(backend._scene.children.some((object) => object.isLight), false);
  assert.throws(() => backend.createBinding(descriptor('scene/invalid', 'background',
    'render.background@1', null, registry)), /resource|properties/u);
  const recovered = await backend.createBinding(descriptor('scene/invalid', 'background',
    'render.background@1', { colorRgba: 0x0000_00ff, textureResourceId: null,
      environmentResourceId: null }, registry));
  backend.destroyBinding(recovered);
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const backgroundProperties = { colorRgba: 0x2244_66ff,
    textureResourceId: null, environmentResourceId: null };
  const background = await backend.createBinding(descriptor('scene/environment', 'background',
    'render.background@1', backgroundProperties, registry));
  const ambientProperties = { colorRgba: 0xffff_ffff, intensity: 0.3, castShadow: false };
  const directionalProperties = { colorRgba: 0xffee_ccff, intensity: 2,
    castShadow: true };
  const pointProperties = { colorRgba: 0xff00_00ff, intensity: 3,
    castShadow: false, range: 20 };
  const spotProperties = { colorRgba: 0x00ff_00ff, intensity: 4, castShadow: true,
    range: 30, angleDegrees: 35, penumbra: 0.25 };
  const lights = await Promise.all([
    backend.createBinding(descriptor('scene/ambient', 'light', 'render.ambient-light@1',
      ambientProperties, registry)),
    backend.createBinding(descriptor('scene/sun', 'light', 'render.directional-light@1',
      directionalProperties, registry)),
    backend.createBinding(descriptor('scene/point', 'light', 'render.point-light@1',
      pointProperties, registry)),
    backend.createBinding(descriptor('scene/spot', 'light', 'render.spot-light@1',
      spotProperties, registry)),
  ]);
  assert.equal(backend.diagnostics().lightCount, 4);
  assert.equal(backend.diagnostics().backgroundCount, 1);
  assert.equal(backend._scene.background.getHex(), 0x224466);
  assert.throws(() => backend.createBinding(descriptor('scene/other', 'background',
    'render.background@1', backgroundProperties, registry)), /three-background-duplicate/u);
  const orthographic = { projection: 'orthographic', near: 0.1, far: 100, orthoHeight: 20 };
  backend.updateBinding(camera, patch('scene/camera', 'camera', orthographic));
  assert.equal(backend._records.get(camera).handle.camera.isOrthographicCamera, true);
  for (const binding of lights) backend.destroyBinding(binding);
  backend.destroyBinding(background);
  assert.equal(backend._scene.background, null);
  assert.equal(backend.diagnostics().lightCount, 0);
  backend.dispose();
});

test('sprite has no orientation path and static sprites batch with real Three objects', async () => {
  const textureDescriptor = { id: 'texture/atlas', kind: 'texture-atlas', url: 'memory:atlas',
    columns: 2, rows: 2 };
  const loadResource = async (resource, signal, dependencies) => {
    if (resource.kind === 'texture-atlas') {
      const texture = new THREE.Texture(); texture.needsUpdate = true;
      return { kind: resource.kind, descriptor: resource, texture, ownsTexture: true };
    }
    return loadThreeResource(resource, signal, dependencies);
  };
  const { backend, registry } = createHarness({ descriptors: [textureDescriptor], loadResource });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const properties = { textureResourceId: 'texture/atlas', width: 2, height: 3,
    material: { tintRgba: 0xffff_ffff, opacity: 1, emissive: 0,
      alphaMode: 'blend', alphaCutoff: 0 }, alpha: 0.8, frame: 1,
    renderOrder: 4, pickable: true };
  const first = await backend.createBinding(descriptor('py/a', 'sprite', 'render.sprite@3',
    properties, registry));
  const second = await backend.createBinding(descriptor('py/b', 'sprite', 'render.sprite@3',
    properties, registry));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
    new THREE.Matrix4().makeTranslation(0, 0, 5)));
  backend.updateBinding(first, patch('py/a', 'sprite', properties));
  backend.updateBinding(second, patch('py/b', 'sprite', properties,
    new THREE.Matrix4().makeTranslation(3, 0, 0)));
  backend.prepareFrame(frame(camera));
  assert.equal(backend.diagnostics().batchCount, 1);
  assert.equal(backend._records.get(first).handle.object.rotation.x, 0);
  const batch = backend._batches[0];
  assert.equal(batch.panelAnchorAttribute.usage, THREE.DynamicDrawUsage);
  backend.updateBinding(first, {
    ...patch('py/a', 'sprite', properties, new THREE.Matrix4().makeTranslation(1, 0, 0)),
    panelAnchorWorld: [1, 0, 0],
  });
  backend.prepareFrame(frame(camera, 1));
  assert.deepEqual(batch.panelAnchorAttribute.updateRanges, [{
    start: 0,
    count: batch.panelAnchorAttribute.array.length,
  }]);
  await assert.rejects(() => backend.createBinding(descriptor('py/legacy', 'sprite',
    'render.sprite@3', { ...properties, orientation: 'billboard' }, registry)),
  /three-sprite-properties-invalid/u);
  backend.dispose();
});

test('sprite materials apply explicit depth reads and writes independently of alpha mode', async () => {
  const textureDescriptor = { id: 'texture/depth', kind: 'texture', url: 'memory:depth' };
  const loadResource = async (resource) => ({
    kind: resource.kind,
    descriptor: resource,
    texture: new THREE.Texture(),
    ownsTexture: true,
  });
  const { backend, registry } = createHarness({
    descriptors: [textureDescriptor], loadResource,
  });
  const properties = {
    textureResourceId: 'texture/depth', width: 1, height: 1,
    material: { alphaMode: 'mask', alphaCutoff: 0.035,
      depthTest: true, depthWrite: false },
    alpha: 1, frame: 0, renderOrder: 1, pickable: false,
  };
  const binding = await backend.createBinding(descriptor(
    'py/depth', 'sprite', 'render.sprite@3', properties, registry,
  ));
  const material = backend._records.get(binding).handle.object.material;
  assert.equal(material.transparent, false);
  assert.equal(material.alphaTest, 0.035);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, false);

  const noDepth = { ...properties, material: {
    ...properties.material, depthTest: false, depthWrite: false,
  } };
  backend.updateBinding(binding, patch('py/depth', 'sprite', noDepth));
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, false);

  await assert.rejects(() => backend.createBinding(descriptor(
    'py/invalid-depth', 'sprite', 'render.sprite@3', {
      ...properties,
      material: { ...properties.material, depthTest: false, depthWrite: true },
    }, registry,
  )), { code: 'three-material-depth-invalid' });
  backend.dispose();
});

test('panel compensation keeps its anchor and depth while removing pan-dependent perspective skew', () => {
  const camera = new THREE.PerspectiveCamera(34, 4 / 3, 0.1, 100);
  camera.position.set(0, 8, 10); camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
  const anchor = new THREE.Vector3(2, 0.16, 1);
  const vertices = [[-1, 0.16, 1], [3, 0.16, 1], [-1, 3.16, 1], [3, 3.16, 1]];
  function projectedOffsets() {
    const a = anchor.clone().applyMatrix4(camera.matrixWorldInverse);
    const origin = a.clone().applyMatrix4(camera.projectionMatrix);
    assert.deepEqual(compensatePanelViewPoint(a, a, true).toArray(), a.toArray());
    return vertices.map((vertex) => {
      const v = new THREE.Vector3(...vertex).applyMatrix4(camera.matrixWorldInverse);
      const compensated = compensatePanelViewPoint(v, a, true);
      assert.equal(compensated.z, v.z, 'depth and pitch foreshortening are retained');
      const screen = compensated.applyMatrix4(camera.projectionMatrix).sub(origin);
      return [screen.x, screen.y];
    });
  }
  const before = projectedOffsets();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  camera.position.addScaledVector(right, 7).addScaledVector(up, -3);
  camera.updateMatrixWorld(true);
  projectedOffsets().forEach((point, index) => point.forEach((value, axis) => {
    assert.ok(Math.abs(value - before[index][axis]) < 1e-12);
  }));
  const v = new THREE.Vector3(2, 3, -5);
  assert.deepEqual(compensatePanelViewPoint(v, new THREE.Vector3(1, 2, -10), false).toArray(), v.toArray());
  assert.deepEqual(compensatePanelViewPoint(v, new THREE.Vector3(1, 2, 0), true).toArray(), v.toArray());
});

test('compensated sprite picking agrees with vertices for ordinary and batched panels after pan', async () => {
  for (const count of [1, 3]) {
    const { backend, registry } = createHarness({
      descriptors: [
        { id: 'texture/panel', kind: 'texture', url: 'memory:panel' },
        { id: 'texture/panel-replacement', kind: 'texture', url: 'memory:panel-replacement' },
      ],
      loadResource: async (resource) => ({ kind: 'texture', descriptor: resource,
        texture: new THREE.Texture(), ownsTexture: true }),
    });
    try {
      const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
        'render.camera@1', CAMERA_PROPERTIES, registry));
      const cameraPose = new THREE.PerspectiveCamera();
      cameraPose.position.set(0, 6, 10); cameraPose.lookAt(0, 0, 0);
      cameraPose.position.x += 10; cameraPose.updateMatrixWorld(true);
      backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES, cameraPose.matrixWorld));
      const properties = { textureResourceId: 'texture/panel', width: 2, height: 3, pickable: true };
      const bindings = [];
      for (let index = 0; index < count; index += 1) {
        const binding = await backend.createBinding(descriptor(`py/panel-${index}`, 'sprite',
          'render.sprite@3', properties, registry));
        const update = { ...patch(`py/panel-${index}`, 'sprite', properties,
          new THREE.Matrix4().makeTranslation(index * 6, 1.5, 0)), panelAnchorWorld: [index * 6, 0, 0] };
        backend.updateBinding(binding, update); bindings.push({ binding, update });
      }
      backend.prepareFrame(frame(camera)); backend.render();
      assert.equal(backend.diagnostics().batchCount, count === 1 ? 0 : 1);
      const viewCamera = backend._activeCamera.handle.camera;
      const anchor = new THREE.Vector3(0, 0, 0).applyMatrix4(viewCamera.matrixWorldInverse);
      const upperPoint = new THREE.Vector3(0, 2.8, 0).applyMatrix4(viewCamera.matrixWorldInverse);
      const expectedWorld = compensatePanelViewPoint(upperPoint, anchor, true).applyMatrix4(viewCamera.matrixWorld);
      const screen = backend.projectWorldPoint({ position: expectedWorld.toArray() });
      const hit = backend.pick({ clientX: screen.clientX, clientY: screen.clientY });
      assert.equal(hit?.nodeName, 'py/panel-0');
      assert.ok(new THREE.Vector3(...hit.point).distanceTo(expectedWorld) < 1e-6);
      assert.deepEqual(backend._nodes.get('py/panel-0').object.matrix.toArray(), bindings[0].update.worldMatrix);
      backend.updateBinding(bindings[0].binding, { ...bindings[0].update, visible: false });
      backend.prepareFrame(frame(camera));
      assert.equal(backend.pick({ clientX: screen.clientX, clientY: screen.clientY }), null);
      const previous = backend._records.get(bindings[0].binding).worldMatrix;
      assert.throws(() => backend.updateBinding(bindings[0].binding,
        { ...bindings[0].update, panelAnchorWorld: [0, NaN, 0] }), /panel-anchor-invalid/);
      assert.equal(backend._records.get(bindings[0].binding).worldMatrix, previous);
      backend.updateBinding(bindings[0].binding, { ...bindings[0].update,
        properties: { ...properties, textureResourceId: 'texture/panel-replacement' } });
      await backend.whenIdle(); backend.prepareFrame(frame(camera)); backend.render();
      const replacedHit = backend.pick({ clientX: screen.clientX, clientY: screen.clientY });
      assert.equal(replacedHit?.nodeName, 'py/panel-0', 'resource replacement restores the same projection anchor');
      assert.ok(new THREE.Vector3(...replacedHit.point).distanceTo(expectedWorld) < 1e-6);
    } finally { backend.dispose(); }
  }
});

test('water and particle visual samplers request continuous draw without RenderTargets', async () => {
  const descriptors = [
    { id: 'surface/water', kind: 'surface', family: 'surface.water',
      geometry: { primitive: 'plane', width: 10, height: 10, segmentsX: 2, segmentsY: 3 },
      textureResourceIds: [], defaults: { amplitude: 0.2, speed: 1, foam: 0.5, textureScale: 1 } },
    { id: 'particle/sparks', kind: 'particle', maximumCapacity: 64,
      textureResourceId: null, defaults: {} },
  ];
  const { backend, registry } = createHarness({ descriptors });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const surfaceProperties = { surfaceResourceId: 'surface/water',
    material: { tintRgba: 0x4488_ffff, opacity: 0.8, emissive: 0,
      alphaMode: 'blend', alphaCutoff: 0 }, parameters: {}, renderOrder: 0, pickable: true };
  const particleProperties = { particleResourceId: 'particle/sparks', intensity: 1,
    parameters: { durationTicks: 60, capacity: 32, seed: 7, rate: 30, size: 0.2,
      velocity: [0, 2, 0], spread: [1, 0, 1], gravity: [0, -9.8, 0],
      blendMode: 'additive' }, renderOrder: 1 };
  const surface = await backend.createBinding(descriptor('scene/water', 'surface',
    'render.surface@1', surfaceProperties, registry));
  const particle = await backend.createBinding(descriptor('py/sparks', 'particle',
    'render.particle@2', particleProperties, registry));
  backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES));
  backend.updateBinding(surface, patch('scene/water', 'surface', surfaceProperties));
  backend.updateBinding(particle, patch('py/sparks', 'particle', particleProperties));
  const prepared = backend.prepareFrame(frame(camera, 30, 0.5));
  assert.equal(prepared.requiresContinuousDraw, true);
  assert.equal(backend.diagnostics().renderTargetCount, 0);
  const particleObject = backend._records.get(particle).handle.object;
  // The emitter's procedural clock starts at its own first sample, so the frame at
  // page-visual 0.5s is still the emitter's local zero.
  assert.equal(particleObject.geometry.drawRange.count, 0);
  backend.prepareFrame(frame(camera, 60, 1.0));
  assert.equal(particleObject.geometry.drawRange.count > 0, true);
  assert.equal(particleObject.geometry.attributes.position.version > 0, true);
  backend.dispose();
});
