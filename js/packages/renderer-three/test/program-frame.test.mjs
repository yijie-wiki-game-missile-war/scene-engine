import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createProgramMaterial, programFrameMethods, programCompileContext } from '../src/program-material.js';
import { expandUpperFieldCamera, upperFieldSourceLayout } from '../src/upper-field.js';

const program = { id: 'program/frame', revision: 3, stage: 'surface', parameterSchema: {}, textureSlots: {},
  source: 'vec4 evaluate(ProgramInput data){return vec4(data.cameraPosition,1.0);}' };
test('program frame exposes the actual expanded matrices and final CSS/buffer viewport with camera switches', () => {
  const material = createProgramMaterial(program, {}, {}), handle = programFrameMethods(material, program);
  const cameras = [new THREE.PerspectiveCamera(60, 4/3, .2, 100), new THREE.OrthographicCamera(-4, 4, 3, -3, .2, 100)];
  const profile = { kind: 'upper-field-compression', startNdcY: .1, strength: .25 };
  const layout = upperFieldSourceLayout(400, 300, profile);
  for (const [index, camera] of cameras.entries()) {
    camera.position.set(1, 2, 8); camera.rotation.y = .2; camera.updateMatrixWorld(true);
    const restore = expandUpperFieldCamera(camera, layout);
    handle.prepareProgramFrame({ camera, width: layout.width, height: layout.height, pixelRatio: 1,
      finalWidth: 400, finalHeight: 300, finalPixelRatio: 2, viewportCssOrigin: { x: 59, y: 43 },
      projectionProfile: profile, sourceSpan: layout.span });
    const u = material.uniforms;
    assert.deepEqual(u.se_projectionMatrix.value.elements, camera.projectionMatrix.elements);
    const identity = u.se_projectionMatrix.value.clone().multiply(u.se_inverseProjection.value);
    identity.elements.forEach((value, i) => assert.ok(Math.abs(value - (i % 5 === 0 ? 1 : 0)) < 1e-10));
    assert.deepEqual(u.se_viewMatrix.value.elements, camera.matrixWorldInverse.elements);
    assert.deepEqual(u.se_viewportCssOrigin.value.toArray(), [59, 43]);
    assert.deepEqual(u.se_viewportBufferOrigin.value.toArray(), [0, 0]);
    assert.deepEqual(u.se_viewportBuffer.value.toArray(), [800, 600]);
    assert.deepEqual(u.se_projectionParameters.value.toArray(), [.2, 100, index ? 0 : Math.PI / 3, index ? 6 : 0]);
    assert.equal(u.se_orthographic.value, index === 1);
    restore();
    // The frame owns copies; terminal restoration cannot change shader inputs.
    assert.notDeepEqual(u.se_projectionMatrix.value.elements, camera.projectionMatrix.elements);
  }
  handle.prepareProgramFrame({ camera: cameras[0], width: 401, height: 301, pixelRatio: 1.25,
    finalCssWidth: 401.5, finalCssHeight: 301.25 });
  assert.deepEqual(material.uniforms.se_viewportCss.value.toArray(), [401.5, 301.25]);
  assert.deepEqual(material.uniforms.se_viewportBuffer.value.toArray(), [501, 376]);
  assert.deepEqual(material.uniforms.se_sourceBuffer.value.toArray(), [501, 376]);
  material.dispose();
});

test('compile metadata is resource scoped, preserves shader sharing, and cannot attribute a different shader', () => {
  const first = createProgramMaterial(program, {}, {}), second = createProgramMaterial(program, {}, {});
  assert.equal(first.fragmentShader, second.fragmentShader);
  const renderer = {}, token = {}, object = { userData: { threeBindingToken: token } };
  first.onBeforeRender(renderer, null, null, null, object);
  assert.equal(programCompileContext(renderer, 'ordinary shader'), null);
  first.onBeforeRender(renderer, null, null, null, object);
  const context = programCompileContext(renderer, first.fragmentShader);
  assert.deepEqual(context.metadata, { resourceId: program.id, revision: 3, programStage: 'surface' });
  assert.equal(context.bindingToken, token);
  assert.equal(programCompileContext(renderer, first.fragmentShader), null);
  first.dispose(); second.dispose();
});

test('a shared failed GPU program is checked once and attributed to each current resource', () => {
  const first = createProgramMaterial(program, {}, {});
  const secondProgram = { ...program, id: 'program/other' };
  const second = createProgramMaterial(secondProgram, {}, {});
  assert.equal(first.fragmentShader, second.fragmentShader);
  let selected, checks = 0;
  const gpu = { getUniforms() { checks += 1; const error = new Error('bounded link failure');
    error.code = 'three-program-compile-failed';
    error.programContext = programCompileContext(renderer, selected.fragmentShader); throw error; } };
  const renderer = { compile(object) { selected = object.material; }, properties: { get: () => ({ currentProgram: gpu }) } };
  for (const [material, descriptor] of [[first, program], [second, secondProgram]]) {
    const object = { material, visible: true, userData: {} };
    assert.throws(() => programFrameMethods(material, descriptor).prepareProgramCompile(renderer, {}, {}, object),
      error => error.programContext.metadata.resourceId === descriptor.id);
  }
  assert.equal(checks, 1);
  const validGpu = { getUniforms() {} };
  renderer.properties.get = () => ({ currentProgram: validGpu });
  assert.doesNotThrow(() => programFrameMethods(first, program).prepareProgramCompile(renderer, {}, {},
    { material: first, visible: true, userData: {} }));
  first.dispose(); second.dispose();
});
