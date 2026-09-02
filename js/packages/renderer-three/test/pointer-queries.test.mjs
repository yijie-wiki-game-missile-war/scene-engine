import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { compensatePanelViewPoint } from '../src/panel-projection.js';
import {
  CAMERA_PROPERTIES,
  INLINE_RESOURCES,
  createHarness,
  descriptor,
  frame,
  patch,
} from './support.mjs';

const MESH_PROPERTIES = Object.freeze({
  meshResourceId: 'mesh/triangle',
  materialResourceId: 'material/standard',
  castShadow: false,
  receiveShadow: false,
  renderOrder: 0,
  pickable: true,
});

test('perspective screen rays use CSS viewport coordinates and return frozen plain normalized data', async () => {
  const { backend, registry } = createHarness();
  try {
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', CAMERA_PROPERTIES, registry));
    backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    backend.prepareFrame(frame(camera));

    const center = backend.screenPointToWorldRay({ clientX: 400, clientY: 300 });
    assert.deepEqual(Object.keys(center).sort(), ['direction', 'origin']);
    assert.equal(Object.isFrozen(center), true);
    assert.equal(Object.isFrozen(center.origin), true);
    assert.equal(Object.isFrozen(center.direction), true);
    assertVectorClose(center.origin, [0, 0, 5]);
    assertVectorClose(center.direction, [0, 0, -1]);
    assert.ok(Math.abs(vectorLength(center.direction) - 1) < 1e-12);
    assert.equal(containsThreeValue(center), false);

    const rightEdge = backend.screenPointToWorldRay({ clientX: 800, clientY: 300 });
    assert.ok(rightEdge.direction[0] > 0);
    assert.ok(rightEdge.direction[2] < 0);
    assert.ok(Math.abs(vectorLength(rightEdge.direction) - 1) < 1e-12);
    const upperLeft = backend.screenPointToWorldRay({ clientX: 0, clientY: 0 });
    assert.ok(upperLeft.direction[0] < 0);
    assert.ok(upperLeft.direction[1] > 0);
  } finally { backend.dispose(); }
});

test('orthographic rays honor host offsets and resized viewport projection', async () => {
  const { backend, registry, host } = createHarness();
  try {
    const properties = { projection: 'orthographic', near: 0.1, far: 100, orthoHeight: 6 };
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', properties, registry));
    backend.updateBinding(camera, patch('scene/camera', 'camera', properties,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    backend.prepareFrame(frame(camera));

    host.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600 });
    const offsetCenter = backend.screenPointToWorldRay({ clientX: 500, clientY: 350 });
    assertVectorClose(offsetCenter.origin, [0, 0, 5]);
    assertVectorClose(offsetCenter.direction, [0, 0, -1]);
    const offsetRight = backend.screenPointToWorldRay({ clientX: 900, clientY: 350 });
    assert.ok(Math.abs(offsetRight.origin[0] - 4) < 1e-12);

    host.getBoundingClientRect = () => ({ left: 20, top: 30, width: 400, height: 200 });
    assert.deepEqual(backend.requestResize(), { width: 400, height: 200, pixelRatio: 2 });
    const resizedCenter = backend.screenPointToWorldRay({ clientX: 220, clientY: 130 });
    assertVectorClose(resizedCenter.origin, [0, 0, 5]);
    const resizedRight = backend.screenPointToWorldRay({ clientX: 420, clientY: 130 });
    assert.ok(Math.abs(resizedRight.origin[0] - 6) < 1e-12);
    const resizedTop = backend.screenPointToWorldRay({ clientX: 220, clientY: 30 });
    assert.ok(Math.abs(resizedTop.origin[1] - 3) < 1e-12);
    assertVectorClose(resizedRight.direction, resizedCenter.direction);
  } finally { backend.dispose(); }
});

test('orthographic proximity honors host offsets and resized CSS viewports', async () => {
  const { backend, registry, host } = createHarness({ descriptors: INLINE_RESOURCES });
  try {
    const properties = { projection: 'orthographic', near: 0.1, far: 100, orthoHeight: 6 };
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', properties, registry));
    const mesh = await backend.createBinding(descriptor('py/ordinary', 'mesh',
      'render.mesh@1', MESH_PROPERTIES, registry));
    backend.updateBinding(camera, patch('scene/camera', 'camera', properties,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    backend.updateBinding(mesh, patch('py/ordinary', 'mesh', MESH_PROPERTIES));
    backend.prepareFrame(frame(camera));

    for (const viewport of [
      { left: 100, top: 50, width: 800, height: 600 },
      { left: 20, top: 30, width: 400, height: 200 },
    ]) {
      host.getBoundingClientRect = () => viewport;
      backend.requestResize();
      const edge = backend.projectWorldPoint({ position: [1, 0, 0] });
      assert.equal(backend.pickProximity({
        clientX: edge.clientX + 12, clientY: edge.clientY, radiusPixels: 11.999,
      }), null);
      const nearby = backend.pickProximity({
        clientX: edge.clientX + 12, clientY: edge.clientY, radiusPixels: 12.001,
      });
      assert.equal(nearby.nodeName, 'py/ordinary');
      assert.ok(Math.abs(nearby.screenDistancePixels - 12) < 1e-9);
    }
  } finally { backend.dispose(); }
});

test('pointer queries reject malformed input and require an active camera', () => {
  const { backend, host } = createHarness();
  try {
    for (const value of [null, {}, { clientX: 0, clientY: Number.NaN },
      { clientX: 0, clientY: 0, extra: true }]) {
      assert.throws(() => backend.screenPointToWorldRay(value),
        (error) => error?.code === 'three-backend-screen-point-invalid');
    }
    for (const value of [null, {}, { clientX: 0, clientY: 0 },
      { clientX: 0, clientY: 0, radiusPixels: -1 },
      { clientX: 0, clientY: 0, radiusPixels: 256.001 },
      { clientX: 0, clientY: 0, radiusPixels: Number.POSITIVE_INFINITY },
      { clientX: 0, clientY: 0, radiusPixels: 1, extra: true }]) {
      assert.throws(() => backend.pickProximity(value),
        (error) => error?.code === 'three-backend-proximity-invalid');
    }
    assert.throws(() => backend.screenPointToWorldRay({ clientX: 0, clientY: 0 }),
      (error) => error?.code === 'three-active-camera-required');
    assert.throws(() => backend.pickProximity({ clientX: 0, clientY: 0, radiusPixels: 0 }),
      (error) => error?.code === 'three-active-camera-required');

    host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 100 });
    // The camera check precedes viewport access while there is no active camera.
    assert.throws(() => backend.screenPointToWorldRay({ clientX: 0, clientY: 0 }),
      (error) => error?.code === 'three-active-camera-required');
  } finally { backend.dispose(); }
});

test('pointer queries fail closed when the active CSS viewport is unavailable', async () => {
  const { backend, registry, host } = createHarness();
  try {
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', CAMERA_PROPERTIES, registry));
    backend.prepareFrame(frame(camera));
    for (const rect of [
      { left: 0, top: 0, width: 0, height: 100 },
      { left: Number.NaN, top: 0, width: 100, height: 100 },
    ]) {
      host.getBoundingClientRect = () => rect;
      assert.throws(() => backend.screenPointToWorldRay({ clientX: 0, clientY: 0 }),
        (error) => error?.code === 'three-backend-viewport-invalid');
      assert.throws(() => backend.pickProximity({
        clientX: 0, clientY: 0, radiusPixels: 1,
      }), (error) => error?.code === 'three-backend-viewport-invalid');
    }
    host.getBoundingClientRect = () => { throw new Error('detached'); };
    assert.throws(() => backend.screenPointToWorldRay({ clientX: 0, clientY: 0 }),
      (error) => error?.code === 'three-backend-viewport-invalid');
    assert.throws(() => backend.pickProximity({
      clientX: 0, clientY: 0, radiusPixels: 1,
    }), (error) => error?.code === 'three-backend-viewport-invalid');
  } finally { backend.dispose(); }
});

test('ordinary proximity uses CSS-pixel projected bounds and zero radius preserves exact pick', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  try {
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', CAMERA_PROPERTIES, registry));
    const mesh = await backend.createBinding(descriptor('py/ordinary', 'mesh',
      'render.mesh@1', MESH_PROPERTIES, registry));
    backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    backend.updateBinding(mesh, patch('py/ordinary', 'mesh', MESH_PROPERTIES));
    backend.prepareFrame(frame(camera));

    const exactPick = backend.pick({ clientX: 400, clientY: 300 });
    const exactProximity = backend.pickProximity({
      clientX: 400, clientY: 300, radiusPixels: 0,
    });
    assert.equal(exactProximity.nodeName, exactPick.nodeName);
    assert.equal(exactProximity.componentKey, exactPick.componentKey);
    assert.equal(exactProximity.screenDistancePixels, 0);
    assert.equal(Number.isFinite(exactProximity.depth), true);
    assert.equal(containsThreeValue(exactProximity), false);
    assert.equal(Object.isFrozen(exactProximity), true);

    const edge = backend.projectWorldPoint({ position: [1, 0, 0] });
    const nearbyX = edge.clientX + 12;
    assert.equal(backend.pickProximity({
      clientX: nearbyX, clientY: edge.clientY, radiusPixels: 11.999,
    }), null);
    const nearby = backend.pickProximity({
      clientX: nearbyX, clientY: edge.clientY, radiusPixels: 12.001,
    });
    assert.equal(nearby.nodeName, 'py/ordinary');
    assert.equal(nearby.componentKey, 'mesh');
    assert.ok(Math.abs(nearby.screenDistancePixels - 12) < 1e-9);
    assert.equal(containsThreeValue(nearby), false);

    backend.updateBinding(mesh, patch('py/ordinary', 'mesh', MESH_PROPERTIES,
      new THREE.Matrix4(), false));
    assert.equal(backend.pickProximity({
      clientX: 400, clientY: 300, radiusPixels: 256,
    }), null);
  } finally { backend.dispose(); }
});

test('ordinary and batched proximity clip projected bounds at camera near and far planes', async () => {
  const descriptors = Object.freeze([
    { id: 'mesh/depth-spanning', kind: 'mesh', positions: [
      -10, -10, 4.95,
      10, -10, -96,
      0, 10, -96,
    ], indices: [0, 1, 2] },
    INLINE_RESOURCES[1],
  ]);
  const properties = Object.freeze({
    ...MESH_PROPERTIES,
    meshResourceId: 'mesh/depth-spanning',
  });
  const cameraProperties = Object.freeze({
    projection: 'perspective', near: 0.1, far: 100, fovYDegrees: 60,
  });

  for (const batched of [false, true]) {
    const { backend, registry } = createHarness({ descriptors });
    try {
      const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
        'render.camera@1', cameraProperties, registry));
      backend.updateBinding(camera, patch('scene/camera', 'camera', cameraProperties,
        new THREE.Matrix4().makeTranslation(0, 0, 5)));
      const first = await backend.createBinding(descriptor('py/span-0', 'mesh',
        'render.mesh@1', properties, registry, undefined, batched));
      backend.updateBinding(first, patch('py/span-0', 'mesh', properties,
        new THREE.Matrix4(), true, batched));
      if (batched) {
        const hiddenPeer = await backend.createBinding(descriptor('py/span-1', 'mesh',
          'render.mesh@1', properties, registry));
        backend.updateBinding(hiddenPeer, patch('py/span-1', 'mesh', properties,
          new THREE.Matrix4(), false));
      }
      backend.prepareFrame(frame(camera));
      assert.equal(backend.diagnostics().batchCount, batched ? 1 : 0);

      const exact = backend.pick({ clientX: 400, clientY: 300 });
      assert.equal(exact?.nodeName, 'py/span-0');
      assert.ok(exact.point[2] < 4.9 && exact.point[2] > -95,
        'the exact hit lies between the camera clipping planes');
      const nearby = backend.pickProximity({
        clientX: 400, clientY: 300, radiusPixels: 1,
      });
      assert.equal(nearby?.nodeName, 'py/span-0');
      assert.equal(nearby.screenDistancePixels, 0);
      assert.ok(nearby.depth >= -1 && nearby.depth <= 1);
    } finally { backend.dispose(); }
  }
});

test('batched proximity maps projected instance bounds back to the logical binding', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  try {
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', CAMERA_PROPERTIES, registry));
    backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    const bindings = [];
    for (const [nodeName, x] of [['py/left', -2], ['py/right', 2]]) {
      const binding = await backend.createBinding(descriptor(nodeName, 'mesh',
        'render.mesh@1', MESH_PROPERTIES, registry));
      backend.updateBinding(binding, patch(nodeName, 'mesh', MESH_PROPERTIES,
        new THREE.Matrix4().makeTranslation(x, 0, 0)));
      bindings.push(binding);
    }
    backend.prepareFrame(frame(camera));
    assert.equal(backend.diagnostics().batchCount, 1);
    assert.equal(backend._records.get(bindings[0]).batched, true);
    assert.equal(backend._records.get(bindings[1]).batched, true);

    const rightCenter = backend.projectWorldPoint({ position: [2, 0, 0] });
    const result = backend.pickProximity({
      clientX: rightCenter.clientX, clientY: rightCenter.clientY, radiusPixels: 8,
    });
    assert.deepEqual(Object.keys(result).sort(), [
      'componentKey', 'depth', 'nodeName', 'screenDistancePixels',
    ]);
    assert.equal(result.nodeName, 'py/right');
    assert.equal(result.componentKey, 'mesh');
    assert.equal(result.screenDistancePixels, 0);
    assert.equal(containsThreeValue(result), false);

    backend.updateBinding(bindings[1], patch('py/right', 'mesh', MESH_PROPERTIES,
      new THREE.Matrix4().makeTranslation(2, 0, 0), false));
    backend.prepareFrame(frame(camera, 1));
    assert.equal(backend.pickProximity({
      clientX: rightCenter.clientX, clientY: rightCenter.clientY, radiusPixels: 8,
    }), null);
  } finally { backend.dispose(); }
});

test('ordinary and batched proximity follow compensated sprite projection', async () => {
  for (const count of [1, 3]) {
    const { backend, registry } = createHarness({
      descriptors: [{ id: 'texture/panel', kind: 'texture', url: 'memory:panel' }],
      loadResource: async (resource) => ({ kind: 'texture', descriptor: resource,
        texture: new THREE.Texture(), ownsTexture: true }),
    });
    try {
      const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
        'render.camera@1', CAMERA_PROPERTIES, registry));
      const cameraPose = new THREE.PerspectiveCamera();
      cameraPose.position.set(0, 6, 10); cameraPose.lookAt(0, 0, 0);
      cameraPose.position.x += 10; cameraPose.updateMatrixWorld(true);
      backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
        cameraPose.matrixWorld));
      const properties = {
        textureResourceId: 'texture/panel', width: 2, height: 3, pickable: true,
      };
      for (let index = 0; index < count; index += 1) {
        const binding = await backend.createBinding(descriptor(`py/panel-${index}`, 'sprite',
          'render.sprite@3', properties, registry));
        backend.updateBinding(binding, {
          ...patch(`py/panel-${index}`, 'sprite', properties,
            new THREE.Matrix4().makeTranslation(index * 6, 1.5, 0)),
          panelAnchorWorld: [index * 6, 0, 0],
        });
      }
      backend.prepareFrame(frame(camera)); backend.render();
      assert.equal(backend.diagnostics().batchCount, count === 1 ? 0 : 1);

      const viewCamera = backend._activeCamera.handle.camera;
      const anchor = new THREE.Vector3(0, 0, 0).applyMatrix4(viewCamera.matrixWorldInverse);
      const panelPoint = new THREE.Vector3(0, 2.8, 0).applyMatrix4(viewCamera.matrixWorldInverse);
      const compensatedWorld = compensatePanelViewPoint(panelPoint, anchor, true)
        .applyMatrix4(viewCamera.matrixWorld);
      const screen = backend.projectWorldPoint({ position: compensatedWorld.toArray() });
      const nearby = backend.pickProximity({
        clientX: screen.clientX, clientY: screen.clientY, radiusPixels: 1,
      });
      assert.equal(nearby?.nodeName, 'py/panel-0');
      assert.equal(nearby.screenDistancePixels, 0);
    } finally { backend.dispose(); }
  }
});

test('model proximity selects the current automatic LOD before the next render', async () => {
  const makeLevel = (centerX) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      centerX - 1, -1, 0,
      centerX + 1, -1, 0,
      centerX, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2]);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    return root;
  };
  const templates = [makeLevel(0), makeLevel(4)];
  const modelDescriptor = {
    id: 'model/lod', kind: 'model', url: 'memory:near', lodUrls: ['memory:far'],
  };
  const { backend, registry } = createHarness({
    descriptors: [modelDescriptor],
    loadResource: async (resource) => ({
      kind: 'model', descriptor: resource, template: templates[0], templates,
    }),
  });
  try {
    const cameraProperties = {
      projection: 'orthographic', near: 0.1, far: 100, orthoHeight: 10,
    };
    const modelProperties = {
      modelResourceId: 'model/lod', materialOverrides: {}, castShadow: false,
      receiveShadow: false, renderOrder: 0, pickable: true,
    };
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', cameraProperties, registry));
    const model = await backend.createBinding(descriptor('py/lod', 'model',
      'render.model@2', modelProperties, registry, undefined, false));
    backend.updateBinding(model, patch('py/lod', 'model', modelProperties,
      new THREE.Matrix4(), true, false));

    backend.updateBinding(camera, patch('scene/camera', 'camera', cameraProperties,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    backend.prepareFrame(frame(camera));
    const nearScreen = backend.projectWorldPoint({ position: [4, 0, 0] });
    assert.equal(backend.pickProximity({
      clientX: nearScreen.clientX, clientY: nearScreen.clientY, radiusPixels: 1,
    }), null, 'the inactive distant LOD must not expand the near-camera proxy');
    const lod = backend._records.get(model).handle.object;
    assert.deepEqual(lod.levels.map((level) => level.object.visible), [true, false]);

    backend.updateBinding(camera, patch('scene/camera', 'camera', cameraProperties,
      new THREE.Matrix4().makeTranslation(0, 0, 30)));
    backend.prepareFrame(frame(camera, 1));
    const farScreen = backend.projectWorldPoint({ position: [4, 0, 0] });
    assert.equal(backend.pickProximity({
      clientX: farScreen.clientX, clientY: farScreen.clientY, radiusPixels: 1,
    })?.nodeName, 'py/lod');
    assert.deepEqual(lod.levels.map((level) => level.object.visible), [false, true]);
  } finally { backend.dispose(); }
});

test('proximity ties sort by depth and then stable logical identity', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  try {
    const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
      'render.camera@1', CAMERA_PROPERTIES, registry));
    backend.updateBinding(camera, patch('scene/camera', 'camera', CAMERA_PROPERTIES,
      new THREE.Matrix4().makeTranslation(0, 0, 5)));
    for (const [nodeName, z] of [['py/back', -2], ['py/front', 0]]) {
      const binding = await backend.createBinding(descriptor(nodeName, 'mesh',
        'render.mesh@1', MESH_PROPERTIES, registry, undefined, false));
      backend.updateBinding(binding, patch(nodeName, 'mesh', MESH_PROPERTIES,
        new THREE.Matrix4().makeTranslation(0, 0, z), true, false));
    }
    backend.prepareFrame(frame(camera));
    assert.equal(backend.pickProximity({
      clientX: 400, clientY: 300, radiusPixels: 1,
    }).nodeName, 'py/front');

    const front = [...backend._bindings.values()].find(
      (record) => record.identity.nodeName === 'py/front',
    );
    backend.updateBinding(front.token, patch('py/front', 'mesh', MESH_PROPERTIES,
      new THREE.Matrix4().makeTranslation(0, 0, -2), true, false));
    assert.equal(backend.pickProximity({
      clientX: 400, clientY: 300, radiusPixels: 1,
    }).nodeName, 'py/back');
  } finally { backend.dispose(); }
});

function assertVectorClose(actual, expected, tolerance = 1e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance,
    `axis ${index}: expected ${expected[index]}, received ${value}`));
}

function vectorLength(value) {
  return Math.hypot(...value);
}

function containsThreeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value.isVector3 || value.isObject3D || value.isMaterial || value.isBufferGeometry
      || value.isTexture) return true;
  return Object.values(value).some((entry) => containsThreeValue(entry, seen));
}
