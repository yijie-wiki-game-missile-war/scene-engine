import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as api from '../src/index.js';
import { CAMERA_PROPERTIES, createHarness, descriptor } from './support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('0.9 root is the exact ThreeRenderBackend public surface', async () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'THREE_RENDER_BACKEND_SCHEMA',
    'ThreeRenderBackendError',
    'createThreeRenderBackend',
  ]);
  assert.equal(api.THREE_RENDER_BACKEND_SCHEMA, 'scene-engine-three-render-backend@1');
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '0.9.2');
  assert.deepEqual((await fs.readdir(path.join(ROOT, 'src'))).sort(), [
    'backend.js', 'constants.js', 'errors.js', 'index.js', 'resource-manager.js',
    'resources.js', 'validation.js',
  ]);
});

test('backend implements only the frozen RenderBackendPort and exposes no Three values', async () => {
  const { backend, registry } = createHarness();
  const methods = [
    'createBinding', 'updateBinding', 'destroyBinding', 'prepareFrame', 'render',
    'requestResize', 'pick', 'projectWorldPoint', 'focusWorldPoint', 'capture',
    'whenIdle', 'diagnostics', 'dispose',
  ];
  for (const method of methods) assert.equal(typeof backend[method], 'function', method);
  for (const removed of ['install', 'apply', 'applyBatch', 'rebuild', 'start', 'stop', 'requestAnimationFrame']) {
    assert.equal(removed in backend, false, removed);
  }
  const camera = await backend.createBinding(descriptor('scene/camera', 'camera',
    'render.camera@1', CAMERA_PROPERTIES, registry));
  const diagnostics = backend.diagnostics();
  assert.equal(diagnostics.bindingCount, 1);
  assert.equal(containsThreeValue(diagnostics), false);
  assert.equal(containsThreeValue(backend.capture()), false);
  backend.destroyBinding(camera);
  backend.dispose();
});

test('legacy implementation vocabulary is physically absent', async () => {
  const source = (await Promise.all((await fs.readdir(path.join(ROOT, 'src'))).map(
    (name) => fs.readFile(path.join(ROOT, 'src', name), 'utf8'),
  ))).join('\n');
  for (const token of [
    'ThreeRender' + 'Runtime',
    'Render' + 'Composition',
    'Render' + 'Snapshot',
    'Render' + 'Batch',
    'display' + 'Id',
    'Scene' + 'Tree',
    'createOrientation' + 'Updater',
  ]) assert.equal(source.includes(token), false, token);
});

function containsThreeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value.isObject3D || value.isMaterial || value.isBufferGeometry || value.isTexture) return true;
  return Object.values(value).some((entry) => containsThreeValue(entry, seen));
}
