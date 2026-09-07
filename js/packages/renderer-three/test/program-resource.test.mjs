import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createResourceRegistry } from '@scene-engine/display';
import { createComponentHandle, loadThreeResource, disposeThreeResource } from '../src/resources.js';
import { ResourceManager } from '../src/resource-manager.js';
import { CAMERA_PROPERTIES, createHarness, descriptor, frame, patch } from './support.mjs';

const program = { id: 'program/test', kind: 'program', revision: 1, language: 'glsl-module@1',
  stage: 'background', source: 'vec4 evaluate(ProgramInput input){return vec4(p_amount+0.01*sin(input.visualSeconds),0.0,0.0,1.0);}',
  timeChannel: 'water', parameterSchema: { amount: { type: 'float', default: 0.5,
    min: 0, max: 1, updateable: true } }, textureSlots: {} };

test('procedural background samples shared pause/resume and camera frame without creating a second scene', async () => {
  const { backend, registry } = createHarness({ descriptors: [program] });
  const camera = await backend.createBinding(descriptor('camera', 'camera', 'render.camera@1', CAMERA_PROPERTIES, registry));
  const properties = { programResourceId: program.id, textures: {}, parameters: { amount: 0.2 } };
  const binding = await backend.createBinding(descriptor('background', 'background', 'render.background@1', properties, registry));
  backend.updateBinding(camera, patch('camera', 'camera', CAMERA_PROPERTIES, new THREE.Matrix4().makeTranslation(0, 0, 10)));
  backend.updateBinding(binding, patch('background', 'background', properties));
  const material = [...backend._bindings.values()].find((record) => record.componentType === 'render.background@1').handle.object.material;
  assert.equal(backend.prepareFrame({ ...frame(camera, 800, 9), visualTimes: { water: { seconds: 3, running: false } } }).requiresContinuousDraw, false);
  backend.render();
  assert.equal(material.uniforms.se_time.value, 3);
  assert.equal(material.uniforms.se_cameraWorld.value.elements[14], 10);
  assert.equal(backend.prepareFrame({ ...frame(camera, 0, 10), visualTimes: { water: { seconds: 4, running: true } } }).requiresContinuousDraw, true);
  assert.equal(material.uniforms.se_time.value, 4);
  backend.updateBinding(binding, patch('background', 'background', properties, new THREE.Matrix4(), false));
  assert.equal(backend.prepareFrame(frame(camera, 0, 12)).requiresContinuousDraw, false);
  await backend.dispose();
  assert.equal(backend.diagnostics().resourceCount, 0);
});

test('procedural mesh instances isolate uniforms, share named texture leases, and update without recompilation', async () => {
  const descriptors = [{ ...program, stage: 'surface', textureSlots: { mask: { usage: 'data' } } },
    { id: 'texture/test', kind: 'texture', url: '/test.png', colorSpace: 'linear' },
    { id: 'material/test', kind: 'material', family: 'material.program', programResourceId: program.id,
      textures: { mask: 'texture/test' }, parameters: { amount: 0.6 } },
    { id: 'mesh/test', kind: 'mesh', positions: [0,0,0, 1,0,0, 0,1,0] }];
  const registry = createResourceRegistry(descriptors); let textureLoads = 0;
  const manager = new ResourceManager({ registry, onFailure() {}, dispose: disposeThreeResource,
    load: async (descriptor, signal, dependencies) => descriptor.kind === 'texture'
      ? (textureLoads++, { kind: 'texture', descriptor, texture: new THREE.Texture(), ownsTexture: true })
      : loadThreeResource(descriptor, signal, dependencies) });
  const leases = ['mesh/test', 'material/test'].map((id) => manager.acquire(id));
  await Promise.all(leases.map((lease) => lease.ready));
  const properties = { meshResourceId: 'mesh/test', materialResourceId: 'material/test', parameters: { amount: 0.3 } };
  const first = createComponentHandle({ componentType: 'render.mesh@1', properties, leases });
  const second = createComponentHandle({ componentType: 'render.mesh@1', properties, leases });
  const version = first.object.material.version;
  first.update({ ...properties, parameters: { amount: 0.9 } });
  assert.equal(first.object.material.uniforms.p_amount.value, 0.9);
  assert.equal(second.object.material.uniforms.p_amount.value, 0.3);
  assert.equal(first.object.material.version, version);
  assert.equal(first.object.material.uniforms.t_mask.value, second.object.material.uniforms.t_mask.value);
  assert.equal(typeof first.createBatch, 'function');
  const batch = first.createBatch(2);
  assert.equal(batch.object.material.uniforms.t_mask.value, first.object.material.uniforms.t_mask.value);
  batch.dispose();
  assert.equal(textureLoads, 1);
  first.dispose(); second.dispose(); leases.forEach((lease) => lease.release()); manager.dispose();
  assert.equal(manager.diagnostics().resourceCount, 0);
});
