import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { deriveUpperFieldProjection } from '@scene-engine/display';
import { anchorExtentBounds } from '../src/anchor-extent.js';
import { createHarness, descriptor, frame, patch } from './support.mjs';

const profile=deriveUpperFieldProjection({pitchDegrees:35,fovYDegrees:34,startNdcY:0.1,targetNdcY:0.79});
const texture={id:'sprite/white',kind:'texture',url:'/white.png',colorSpace:'srgb'};
const properties={textureResourceId:texture.id,width:2,height:1,projectionSemantics:'anchor-extent',anchorOffset:[0,0,0],pickable:true};
function harness(){return createHarness({descriptors:[texture],loadResource:async descriptor=>({kind:'texture',descriptor,texture:new THREE.Texture(),ownsTexture:true})});}
async function cameraBinding(backend,registry,orthographic=false){
  const properties=orthographic?{projection:'orthographic',orthoHeight:10,near:0.1,far:1000,projectionProfile:profile}
    :{projection:'perspective',fovYDegrees:60,near:0.1,far:1000,projectionProfile:profile};
  return backend.createBinding(descriptor('camera','camera','render.camera@1',properties,registry));
}
test('anchor bounds use view-aligned world extents and perspective/orthographic depth scaling',()=>{
  for(const camera of [new THREE.PerspectiveCamera(60,4/3,.1,1000),new THREE.OrthographicCamera(-20/3,20/3,5,-5,.1,1000)]){
    camera.updateMatrixWorld(true);
    const world=new THREE.Matrix4().compose(new THREE.Vector3(0,5,-5),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),1),new THREE.Vector3(2,1,1));
    const close=anchorExtentBounds(world,properties,camera,profile);
    world.elements[14]=-10;
    const far=anchorExtentBounds(world,properties,camera,profile);
    assert.ok(Math.abs(close.sizeY/far.sizeY-(camera.isPerspectiveCamera?2:1))<1e-12);
    assert.ok(Math.abs(close.sizeX/far.sizeX-(camera.isPerspectiveCamera?2:1))<1e-12);
    const shifted=anchorExtentBounds(world,{...properties,anchorOffset:[1,0,0]},camera,profile);
    const anchor=new THREE.Vector3(.5,0,0).applyMatrix4(world).project(camera);
    assert.ok(Math.abs((shifted.minX+shifted.maxX)/2-anchor.x)<1e-12);
  }
});
test('ordinary and instanced anchors pick final coverage and reconstruct a reprojectable display point',async()=>{
  for(const batched of [false,true]) for(const orthographic of [false,true]){
    const {backend,registry}=harness();const camera=await cameraBinding(backend,registry,orthographic);
    const sprites=[];
    for(let i=0;i<(batched?2:1);i++){
      const name='sprite/'+i;
      const sprite=await backend.createBinding(descriptor(name,'sprite','render.sprite@3',properties,registry,undefined,batched));
      backend.updateBinding(sprite,patch(name,'sprite',properties,new THREE.Matrix4().makeTranslation(i*3,5,-5),true,batched));
      sprites.push(sprite);
    }
    backend.prepareFrame(frame(camera));
    const anchor=backend.projectWorldPoint({position:[0,5,-5]});
    const query={clientX:anchor.clientX,clientY:anchor.clientY-20};
    const hit=backend.pick(query);
    assert.equal(hit.nodeName,'sprite/0');
    const result=backend.projectWorldPoint({position:hit.point});
    assert.ok(Math.hypot(result.clientX-query.clientX,result.clientY-query.clientY)<1e-9);
    assert.equal(backend.pickProximity({...query,radiusPixels:0}).nodeName,hit.nodeName);
    // Moving the anchor before near must remove the whole billboard and its proxy.
    backend.updateBinding(sprites[0],patch('sprite/0','sprite',properties,new THREE.Matrix4().makeTranslation(0,0,-.01),true,batched));
    backend.prepareFrame(frame(camera));
    assert.equal(backend.pick({clientX:400,clientY:300}),null);
    assert.throws(()=>backend.updateBinding(sprites[0],{...patch('sprite/0','sprite',properties),panelAnchorWorld:[0,0,0]}),{code:'three-sprite-projection-combination-invalid'});
    backend.dispose();
  }
});
test('an offscreen anchor keeps entering extent, bounds and proximity',async()=>{
  const {backend,registry}=harness();const camera=await cameraBinding(backend,registry);
  const sprite=await backend.createBinding(descriptor('sprite','sprite','render.sprite@3',properties,registry));
  backend.updateBinding(sprite,patch('sprite','sprite',properties,new THREE.Matrix4().makeTranslation(4.5,0,-5)));
  backend.prepareFrame(frame(camera));
  assert.equal(backend.projectWorldPoint({position:[4.5,0,-5]}).visible,false);
  assert.equal(backend.pick({clientX:795,clientY:300}).nodeName,'sprite');
  assert.equal(backend.pickProximity({clientX:770,clientY:355,radiusPixels:10}).nodeName,'sprite');
  backend.dispose();
});
