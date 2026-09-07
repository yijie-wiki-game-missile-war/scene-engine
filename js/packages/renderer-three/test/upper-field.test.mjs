import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { deriveUpperFieldProjection } from '@scene-engine/display';
import { upperFieldSourceLayout, expandUpperFieldCamera } from '../src/upper-field.js';
import { CAMERA_PROPERTIES, INLINE_RESOURCES, createHarness, descriptor, frame, patch } from './support.mjs';

const profile = deriveUpperFieldProjection({ pitchDegrees: 35, fovYDegrees: 34,
  startNdcY: 0.1, targetNdcY: 0.79 });
const properties = { ...CAMERA_PROPERTIES, projectionProfile: profile };
function enableTargets(renderer) {
  renderer.capabilities = { maxTextureSize: 8192 };
  renderer.extensions = { has: () => true };
  let target = null;
  renderer.getRenderTarget = () => target;
  renderer.setRenderTarget = (next) => { target = next; };
}

test('source budget keeps CSS sampling independent of DPR and fails closed for excessive profiles', () => {
  const layout = upperFieldSourceLayout(1920, 1080, profile);
  assert.ok(layout.width * layout.height < 16 * 1024 * 1024);
  assert.ok(layout.maximumTexelDisplacementCssPixels < 1);
  assert.throws(() => upperFieldSourceLayout(1920, 1080, { ...profile, strength: 1.099 }),
    { code: 'three-upper-field-budget-exceeded' });
  assert.throws(() => upperFieldSourceLayout(1920, 1080, profile, 4096),
    { code: 'three-upper-field-budget-exceeded' });
});
test('expanded frustum preserves clip depth and restores both camera projection matrices', () => {
  for (const camera of [new THREE.PerspectiveCamera(60, 4/3, 0.1, 1000),
    new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 1000)]) {
    const original = camera.projectionMatrix.clone();
    const inverse = camera.projectionMatrixInverse.clone();
    const point = new THREE.Vector3(1, 4, -5);
    const ndc = point.clone().project(camera);
    const layout = upperFieldSourceLayout(800, 600, profile);
    const restore = expandUpperFieldCamera(camera, layout);
    const expanded = point.clone().project(camera);
    assert.ok(Math.abs(expanded.z - ndc.z) < 1e-12);
    assert.ok(Math.abs(expanded.x - ndc.x) < 1e-12);
    assert.ok(Math.abs(expanded.y - ((ndc.y + 1) * 2 / layout.span - 1)) < 1e-12);
    restore();
    assert.deepEqual(camera.projectionMatrix.toArray(), original.toArray());
    assert.deepEqual(camera.projectionMatrixInverse.toArray(), inverse.toArray());
  }
});
test('same-scene terminal restores camera, roots, target, shadow flags and owns its buffer', async () => {
  const { backend, registry, renderer } = createHarness();
  enableTargets(renderer);
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', properties, registry));
  backend.prepareFrame(frame(camera));
  const original = backend._activeCamera.handle.camera.projectionMatrix.clone();
  backend.render();
  assert.equal(renderer.draws, 2);
  assert.equal(backend.diagnostics().cameraCount, 1);
  assert.equal(backend.diagnostics().renderTargetCount, 1);
  assert.equal(renderer.getRenderTarget(), null);
  assert.equal(backend._root.visible, true);
  assert.deepEqual(backend._activeCamera.handle.camera.projectionMatrix.toArray(), original.toArray());
  const target = backend._upperFieldTerminal.target;
  backend.render();
  assert.equal(backend._upperFieldTerminal.target, target);
  let disposed = 0; target.addEventListener('dispose', () => { disposed += 1; });
  renderer.render = () => { throw new Error('GPU failure'); };
  assert.throws(() => backend.render());
  assert.equal(backend._upperFieldTerminal.object.visible, false);
  assert.equal(backend._root.visible, true);
  assert.equal(renderer.getRenderTarget(), null);
  assert.deepEqual(backend._activeCamera.handle.camera.projectionMatrix.toArray(), original.toArray());
  backend.dispose(); backend.dispose();
  assert.equal(disposed, 1);
});
test('CPU project/ray/pick round trip upper geometry and classify invalid and offscreen points', async () => {
  const { backend, registry } = createHarness({ descriptors: INLINE_RESOURCES });
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', properties, registry));
  const meshProperties = { meshResourceId: 'mesh/triangle', materialResourceId: 'material/standard',
    castShadow: false, receiveShadow: false, renderOrder: 0, pickable: true };
  const mesh = await backend.createBinding(descriptor('scene/target', 'mesh',
    'render.mesh@1', meshProperties, registry));
  backend.updateBinding(mesh, patch('scene/target', 'mesh', meshProperties,
    new THREE.Matrix4().makeTranslation(0, 5, -5)));
  backend.prepareFrame(frame(camera));
  const projected = backend.projectWorldPoint({ position: [0, 5, -5] });
  assert.equal(projected.visible, true, 'standard upper-clip rejected points may be visible after F');
  const ray = backend.screenPointToWorldRay(projectedQuery(projected));
  assert.ok(new THREE.Ray(new THREE.Vector3(...ray.origin),
    new THREE.Vector3(...ray.direction)).distanceToPoint(new THREE.Vector3(0, 5, -5)) < 1e-12);
  const hit = backend.pick(projectedQuery(projected));
  assert.equal(hit.nodeName, 'scene/target');
  const roundtrip = backend.projectWorldPoint({ position: hit.point });
  assert.ok(Math.hypot(roundtrip.clientX - projected.clientX,
    roundtrip.clientY - projected.clientY) < 1e-9);
  assert.equal(backend.pickProximity({ ...projectedQuery(projected), radiusPixels: 0 }).nodeName, hit.nodeName);
  assert.equal(backend.projectWorldPoint({ position: [100, 0, -5] }).visible, false);
  for (const position of [[0,0,0], [0,0,5], [0,0,-0.01], [0,0,-2000]]) {
    assert.deepEqual(backend.projectWorldPoint({ position }),
      { clientX: null, clientY: null, depth: null, visible: false });
  }
  assert.throws(() => backend.screenPointToWorldRay({ clientX: 400, clientY: -100 }),
    { code: 'display-projection-domain' });
  assert.equal(backend.pick({ clientX: 400, clientY: -100 }), null);
  backend.dispose();
});
test('orthographic inverse rays retain parallel directions and varying origins; unfit focus is explicit', async () => {
  const { backend, registry } = createHarness();
  const properties = { projection: 'orthographic', near: 0.1, far: 1000,
    orthoHeight: 10, projectionProfile: profile };
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', properties, registry));
  backend.prepareFrame(frame(camera));
  const lower = backend.screenPointToWorldRay({ clientX: 400, clientY: 500 });
  const upper = backend.screenPointToWorldRay({ clientX: 400, clientY: 10 });
  assert.deepEqual(lower.direction, upper.direction);
  assert.notDeepEqual(lower.origin, upper.origin);
  for (const sample of [[400, 500], [400, 10]]) {
    const ray = backend.screenPointToWorldRay({ clientX: sample[0], clientY: sample[1] });
    const position = ray.origin.map((v, i) => v + 5 * ray.direction[i]);
    const point = backend.projectWorldPoint({ position });
    assert.ok(Math.hypot(point.clientX - sample[0], point.clientY - sample[1]) < 1e-10);
  }
  assert.throws(() => backend.focusWorldPoint({ position: [0,0,-5], radius: 20 }),
    { code: 'three-focus-bounds-unfit' });
  backend.dispose();
});
function projectedQuery(point) { return { clientX: point.clientX, clientY: point.clientY }; }

test('public box focus fits all corners under the final projection without a conservative sphere', async () => {
  for (const aspect of [16/9, 9/16]) {
    const { backend, registry } = createHarness();
    const props = { ...properties, fovYDegrees: 34, far: 5000 };
    const binding = await backend.createBinding(descriptor('scene/camera', 'camera', 'render.camera@1', props, registry));
    backend.prepareFrame(frame(binding));
    const camera = backend._activeCamera.handle.camera;
    camera.aspect = aspect; camera.position.set(0, 600 * Math.sin(35 * Math.PI / 180), 600 * Math.cos(35 * Math.PI / 180));
    camera.lookAt(0, 0, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const halfExtents = [422.7 * 1.12 / 2, 0, 419.1 * 1.12 / 2];
    const fit = backend.focusWorldPoint({ position: [0,0,0], halfExtents });
    assert.ok(Math.hypot(...fit.position) < 1600);
    camera.position.fromArray(fit.position); camera.updateMatrixWorld(true);
    for (const x of [-halfExtents[0], halfExtents[0]]) for (const z of [-halfExtents[2], halfExtents[2]]) {
      const p = new THREE.Vector3(x, 0, z).project(camera);
      const projected = backend.projectWorldPoint({ position: [x,0,z] });
      assert.ok(Math.abs(p.x) <= 1.000000001);
      assert.ok(projected.clientY >= -1e-8 && projected.clientY <= 600 + 1e-8);
    }
    assert.throws(() => backend.focusWorldPoint({ position: [0,0,0], radius: 1, halfExtents }), { code: 'three-backend-focus-invalid' });
    assert.throws(() => backend.focusWorldPoint({ position: [0,0,0], halfExtents: [1,-1,1] }), { code: 'three-backend-focus-invalid' });
    backend.dispose();
  }
});
