import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { anchorExtentBounds } from '../src/anchor-extent.js';
import { createHarness, descriptor, frame, patch, CAMERA_PROPERTIES } from './support.mjs';

const program = { id: 'program/sprite', kind: 'program', revision: 1, language: 'glsl-module@1', stage: 'surface',
  timeChannel: 'cloud', parameterSchema: { opacity: { type: 'float', min: 0, max: 1, default: 1, updateable: true } },
  textureSlots: {}, source: `vec4 evaluate(ProgramInput data) {
    return vec4(data.uv, data.hasAnchor ? 1.0 : 0.0, p_opacity + 0.01*sin(data.visualSeconds));
  }` };
const material = { id: 'material/sprite', kind: 'material', family: 'material.program', programResourceId: program.id,
  textures: {}, parameters: {}, properties: { alphaMode: 'blend', depthTest: true, depthWrite: false } };
const texture = { id: 'texture/sprite', kind: 'texture', url: '/sprite.png', colorSpace: 'srgb' };
const properties = { materialResourceId: material.id, width: 2, height: 1, projectionSemantics: 'anchor-extent', pickable: true };
const profile = { mode: 'upper-field', startNdcY: 0.1, strength: 0.6 };
const spriteRecord = (backend, name) => [...backend._bindings.values()].find((record) => record.identity.nodeName === name);

test('program sprite pivots retain final UV bounds and query/project parity in both cameras and profiles', async () => {
  for (const orthographic of [false, true]) for (const projectionProfile of [null, profile]) for (const pivot of [[.5,.5],[.5,0],[.4,.2]]) {
    const { backend, registry } = createHarness({ descriptors: [program, material] });
    const cameraProperties = orthographic ? { projection: 'orthographic', orthoHeight: 10, near: .1, far: 100, projectionProfile }
      : { ...CAMERA_PROPERTIES, projectionProfile };
    const camera = await backend.createBinding(descriptor('camera','camera','render.camera@1',cameraProperties,registry));
    const p = { ...properties, pivot, anchorOffset: [.2,.3,0] };
    const binding = await backend.createBinding(descriptor('sprite','sprite','render.sprite@3',p,registry));
    backend.updateBinding(binding,patch('sprite','sprite',p,new THREE.Matrix4().makeTranslation(0,1,-5)));
    backend.prepareFrame(frame(camera));
    const record = spriteRecord(backend,'sprite');
    record.handle.object.updateWorldMatrix(true,false);
    const bounds = anchorExtentBounds(record.handle.object.matrixWorld,p,backend._activeCamera.handle.camera,projectionProfile);
    const anchor = backend.projectWorldPoint({position:[.2,1.3,-5]});
    assert.ok(Math.abs((bounds.minY+bounds.sizeY*pivot[1]+1)*300 - (600-anchor.clientY)) < 1e-8);
    for (const uv of [[.05,.05],[.9,.1],[.1,.9],[.9,.9],[.5,.5]]) {
      const query = { clientX: (bounds.minX+bounds.sizeX*uv[0]+1)*400,
        clientY: (1-bounds.minY-bounds.sizeY*uv[1])*300 };
      const hit = backend.pick(query);
      assert.equal(hit?.nodeName,'sprite');
      const projected = backend.projectWorldPoint({position:hit.point});
      assert.ok(Math.hypot(query.clientX-projected.clientX,query.clientY-projected.clientY)<1e-8);
      assert.equal(backend.pickProximity({...query,radiusPixels:0})?.nodeName,'sprite');
    }
    assert.equal(backend.diagnostics().batchCount,0);
    backend.dispose();
  }
});

test('program sprites share the anchor shader, stay ordinary and isolate parameters without recompilation', async () => {
  const {backend,registry}=createHarness({descriptors:[program,material]});
  const camera=await backend.createBinding(descriptor('camera','camera','render.camera@1',CAMERA_PROPERTIES,registry));
  const bindings=[];
  for(const name of ['first','second']) {
    const binding=await backend.createBinding(descriptor(name,'sprite','render.sprite@3',properties,registry));
    backend.updateBinding(binding,patch(name,'sprite',properties,new THREE.Matrix4().makeTranslation(0,0,-5)));
    bindings.push(binding);
  }
  const prepare=()=>backend.prepareFrame({...frame(camera,0,10),visualTimes:{cloud:{seconds:7,running:false}}});
  assert.equal(prepare().requiresContinuousDraw,false);
  backend.render();
  const first=spriteRecord(backend,'first').handle.object.material;
  const second=spriteRecord(backend,'second').handle.object.material;
  const version=first.version;
  const shader={vertexShader:first.vertexShader,fragmentShader:first.fragmentShader,uniforms:{...first.uniforms}};
  first.onBeforeCompile(shader);
  assert.match(shader.vertexShader,/seAnchorRect = vec4\(seCenter - seAnchorPivot/);
  assert.match(shader.fragmentShader,/sampleWorld=origin\+direction/);
  assert.match(shader.fragmentShader,/seAnchorImageUv\(\),true,seAnchorWorld/);
  assert.doesNotMatch(shader.vertexShader,/scene-engine-anchor-vertex/);
  assert.deepEqual(shader.uniforms.seAnchorPivot.value.toArray(),[.5,.5]);
  assert.equal(first.uniforms.se_time.value,7);
  assert.equal(backend.diagnostics().batchCount,0);
  backend.updateBinding(bindings[0],patch('first','sprite',{...properties,parameters:{opacity:.2},pivot:[.5,0]},new THREE.Matrix4().makeTranslation(0,0,-5)));
  prepare();backend.render();
  assert.equal(first.uniforms.p_opacity.value,.2);
  assert.equal(second.uniforms.p_opacity.value,1);
  assert.equal(first.version,version);
  assert.deepEqual(shader.uniforms.seAnchorPivot.value.toArray(),[.5,0]);
  backend.dispose();
  assert.equal(backend.diagnostics().resourceCount,0);
});

test('anchor sorting uses actual anchor depth and changing back to fixed-panel geometry accepts the new state',async()=>{
  const {backend,registry}=createHarness({descriptors:[texture],loadResource:async descriptor=>({kind:'texture',descriptor,texture:new THREE.Texture(),ownsTexture:true})});
  const camera=await backend.createBinding(descriptor('camera','camera','render.camera@1',CAMERA_PROPERTIES,registry));
  const p={textureResourceId:texture.id,width:2,height:1,projectionSemantics:'anchor-extent',anchorOffset:[0,0,8],material:{alphaMode:'blend'}};
  const binding=await backend.createBinding(descriptor('sprite','sprite','render.sprite@3',p,registry,undefined,false));
  backend.updateBinding(binding,patch('sprite','sprite',p,new THREE.Matrix4().makeTranslation(0,0,-10),true,false));
  backend.prepareFrame(frame(camera));backend.render();
  const object=spriteRecord(backend,'sprite').handle.object;
  const center=object.boundingSphere.center.clone().applyMatrix4(object.matrixWorld);
  assert.deepEqual(center.toArray(),[0,0,-2]);
  const geometry={textureResourceId:texture.id,width:2,height:1,projectionSemantics:'geometry'};
  backend.updateBinding(binding,{...patch('sprite','sprite',geometry,new THREE.Matrix4().makeTranslation(0,0,-10),true,false),panelAnchorWorld:[0,0,-10]});
  assert.equal(object.boundingSphere,undefined);
  const shader={vertexShader:THREE.ShaderLib.basic.vertexShader,fragmentShader:THREE.ShaderLib.basic.fragmentShader,uniforms:{}};
  object.material.onBeforeCompile(shader);
  assert.deepEqual(shader.uniforms.scenePanelAnchor.value.toArray(),[0,0,-10,1]);
  backend.dispose();
});

test('renderer rejects invalid program sprite resource branches, stage, pivot and parameters',async()=>{
  for(const change of [{textureResourceId:texture.id},{material:{}},{alpha:.5},{frame:0},{projectionSemantics:'geometry'},
    {pivot:[0,2]},{parameters:{missing:1}}]) {
    const {backend,registry}=createHarness({descriptors:[program,material]});
    await assert.rejects(async()=>backend.createBinding(descriptor('sprite','sprite','render.sprite@3',{...properties,...change},registry)));
    backend.dispose();
  }
  const {backend,registry}=createHarness({descriptors:[{...program,stage:'background'},material]});
  await assert.rejects(()=>backend.createBinding(descriptor('sprite','sprite','render.sprite@3',properties,registry)));
  backend.dispose();
});

test('multiple program representations consume one prepared camera frame per world pass',async()=>{
  const {backend,registry,renderer}=createHarness({descriptors:[program,material]});
  const cameraBinding=await backend.createBinding(descriptor('camera','camera','render.camera@1',CAMERA_PROPERTIES,registry));
  backend.updateBinding(cameraBinding,patch('camera','camera',CAMERA_PROPERTIES,new THREE.Matrix4().makeTranslation(2,3,4)));
  for(let index=0;index<3;index+=1) {
    const name=`sprite/${index}`;
    const binding=await backend.createBinding(descriptor(name,'sprite','render.sprite@3',properties,registry));
    backend.updateBinding(binding,patch(name,'sprite',properties,new THREE.Matrix4().makeTranslation(index,0,-5)));
  }
  backend.prepareFrame(frame(cameraBinding));
  const camera=backend._activeCamera.handle.camera;
  const seen=[];let preparations=0;
  for(const method of ['updateWorldMatrix','updateMatrixWorld']) {
    const original=camera[method];
    camera[method]=function(...args){preparations+=1;return original.apply(this,args);};
  }
  const records=[...backend._bindings.values()].filter(record=>record.componentType==='render.sprite@3');
  for(const record of records) {
    const original=record.handle.prepareProgramFrame;
    record.handle.prepareProgramFrame=function(value){seen.push(value);return original.call(this,value);};
  }
  // Isolate the backend preparation contract from Three's own draw traversal.
  renderer.render=()=>{};
  backend.render();
  assert.equal(preparations,1);
  assert.equal(seen.length,3);
  assert.ok(seen.every(value=>value===seen[0]));
  for(const record of records) {
    const uniforms=record.handle.object.material.uniforms;
    assert.deepEqual(uniforms.se_cameraWorld.value.elements,camera.matrixWorld.elements);
    assert.deepEqual(uniforms.se_viewMatrix.value.elements,camera.matrixWorldInverse.elements);
    assert.deepEqual(uniforms.se_projectionMatrix.value.elements,camera.projectionMatrix.elements);
  }
  backend.dispose();
});

test('the display hit plane retains world ray distance with a scaled camera transform',async()=>{
  const {backend,registry}=createHarness({descriptors:[program,material]});
  const camera=await backend.createBinding(descriptor('camera','camera','render.camera@1',CAMERA_PROPERTIES,registry));
  backend.updateBinding(camera,patch('camera','camera',CAMERA_PROPERTIES,new THREE.Matrix4().makeScale(2,2,2)));
  const binding=await backend.createBinding(descriptor('sprite','sprite','render.sprite@3',properties,registry));
  backend.updateBinding(binding,patch('sprite','sprite',properties,new THREE.Matrix4().makeTranslation(0,0,-5)));
  backend.prepareFrame(frame(camera));
  const hit=backend.pick({clientX:400,clientY:300});
  assert.ok(Math.abs(hit.point[2]+5)<1e-10);
  backend.dispose();
});
