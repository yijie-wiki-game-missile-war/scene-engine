import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceRegistry } from '@scene-engine/display';
import { GeneratedTextureStore } from '../../display/src/runtime/generated-texture-store.js';
import { ResourceManager } from '../src/resource-manager.js';
import { loadThreeResource, disposeThreeResource } from '../src/resources.js';

const descriptor={id:'generated/test',kind:'generated-texture',revision:1,width:4,height:4,format:'rgba8unorm',usage:'data',
  initialValue:[0,0,0,255],budget:{maxUpdateBytes:64,maxRegions:4}};
function setup(overrides={}, additional=[]) {
  const registry=createResourceRegistry([{...descriptor,...overrides},...additional]), store=new GeneratedTextureStore(registry,()=>{});
  const uploads=[], fences=new Set(); let complete=false,error=0;
  const gl={NO_ERROR:0,TIMEOUT_EXPIRED:1,WAIT_FAILED:2,CONDITION_SATISFIED:3,SYNC_GPU_COMMANDS_COMPLETE:4,
    fenceSync(){const fence={};fences.add(fence);return fence;},deleteSync:f=>fences.delete(f),flush(){},
    clientWaitSync:()=>complete?3:1,getError:()=>error};
  const renderer={capabilities:{maxTextureSize:4096},extensions:{has:()=>false},getContext:()=>gl,
    initTexture(texture){uploads.push({textureId:texture.id,ranges:texture.updateRanges.map(x=>({...x})),pixels:texture.image.data.slice()});texture.clearUpdateRanges();}};
  const failures=[];
  const manager=new ResourceManager({registry,load:loadThreeResource,dispose:disposeThreeResource,
    generatedTextureSource:store.sourcePort,renderer,onFailure:(id,error)=>failures.push([id,error.code])});
  return {store,manager,uploads,fences,failures,complete:()=>complete=true,error:()=>error=123};
}
test('generated textures upload locally, wait for GPU fence, share leases and dispose once',async()=>{
  const x=setup(), a=x.manager.acquire(descriptor.id),b=x.manager.acquire(descriptor.id);await Promise.all([a.ready,b.ready]);
  assert.equal(a.value,b.value); assert.equal(x.manager.hasUninitializedGeneratedTextures(),true);
  assert.equal(x.manager.prepareGeneratedTextures(),true); assert.equal(x.uploads.length,1);
  assert.equal(x.store.status(descriptor.id).status,'pending-upload');
  x.manager.prepareGeneratedTextures(); assert.equal(x.uploads.length,1);
  x.complete(); assert.equal(x.manager.prepareGeneratedTextures(),false);
  assert.equal((await x.store.whenReady(descriptor.id)).status,'ready');
  const t=x.store.begin(descriptor.id,{sourceRevision:'frame/8'});
  t.commit({regions:[{x:1,y:2,width:1,height:1,data:new Uint8Array([200,100,50,255])}]});
  assert.equal(x.manager.prepareGeneratedTextures(),true);
  assert.deepEqual(x.uploads[1].ranges,[{start:36,count:4}]);
  assert.equal(x.manager.diagnostics().generatedUploadedBytes,68);
  x.manager.prepareGeneratedTextures();assert.equal(x.store.status(descriptor.id).generation,t.generation);
  let disposeCount=0;a.value.texture.addEventListener('dispose',()=>disposeCount++);
  a.release();assert.equal(disposeCount,0);b.release();assert.equal(disposeCount,1);
  x.manager.dispose();x.store.dispose();assert.equal(disposeCount,1);assert.equal(x.fences.size,0);
});
test('unsupported float filtering fails explicitly and failed upload reports readiness without discarding CPU source',async()=>{
  const unsupported=setup({format:'rgba32float',filter:'linear'});
  const bad=unsupported.manager.acquire(descriptor.id); await assert.rejects(bad.ready,/filter-unsupported/);
  assert.equal((await unsupported.store.whenReady(descriptor.id)).status,'failed');
  bad.release();unsupported.manager.dispose();unsupported.store.dispose();
  const x=setup(), lease=x.manager.acquire(descriptor.id);await lease.ready;
  x.error(); assert.throws(()=>x.manager.prepareGeneratedTextures(),/upload-failed/);
  assert.equal((await x.store.whenReady(descriptor.id)).status,'failed'); assert.equal(x.failures.length,1);
  x.manager.dispose();x.store.dispose();assert.equal(x.fences.size,0);
});
test('one frame budget defers complete generations and backend recreation uploads retained source',async()=>{
  const x=setup(), lease=x.manager.acquire(descriptor.id); await lease.ready;
  assert.deepEqual(lease.value.prepareGeneratedTexture(32),{pending:true,uploadedBytes:0});
  assert.equal(x.uploads.length,0);
  x.store.begin(descriptor.id,{sourceRevision:'checkpoint/2'}).commit({regions:[{x:0,y:0,width:1,height:1,data:new Uint8Array([10,20,30,40])}]});
  x.manager.prepareGeneratedTextures();x.complete();x.manager.prepareGeneratedTextures();
  x.manager.dispose();assert.equal(x.store.status(descriptor.id).status,'pending-upload');
  const newLease=x.store.sourcePort.acquire(descriptor.id);
  assert.deepEqual([...newLease.update().regions[0].data.slice(0,4)],[10,20,30,40]);
  assert.equal(newLease.update().byteLength,64);newLease.release('backend-disposed');x.store.dispose();
});

test('an uncompleted GPU fence has a finite polling budget and never retries the failed upload',async()=>{
  const x=setup(), lease=x.manager.acquire(descriptor.id);await lease.ready;x.manager.prepareGeneratedTextures();
  const waiting=x.store.whenReady(descriptor.id);
  for(let i=0;i<120;i++)assert.equal(x.manager.prepareGeneratedTextures(),true);
  assert.throws(()=>x.manager.prepareGeneratedTextures(),/fence-timeout/);
  assert.equal((await waiting).status,'failed');assert.equal(x.failures.length,1);
  assert.throws(()=>x.manager.prepareGeneratedTextures(),/fence-timeout/);
  assert.throws(()=>x.manager.hasUninitializedGeneratedTextures(),/fence-timeout/);
  assert.equal(x.failures.length,1);assert.equal(x.uploads.length,1);
  x.manager.dispose();x.store.dispose();assert.equal(x.fences.size,0);
});

test('a retired loader rejection cannot poison readiness in the surviving runtime source',async()=>{
  const registry=createResourceRegistry([descriptor]),store=new GeneratedTextureStore(registry,()=>{});
  let rejectLoad;const failures=[];
  const manager=new ResourceManager({registry,generatedTextureSource:store.sourcePort,
    load:()=>new Promise((_resolve,reject)=>{rejectLoad=reject;}),dispose:disposeThreeResource,onFailure:e=>failures.push(e)});
  const lease=manager.acquire(descriptor.id);await Promise.resolve();manager.dispose();
  rejectLoad(new Error('late failure'));await assert.rejects(lease.ready,/late failure/);
  assert.equal(store.status(descriptor.id).status,'pending-upload');assert.equal(failures.length,0);store.dispose();
});

test('initial uploads and existing peers make progress under continuous full-budget updates', async () => {
  const large = { ...descriptor, width: 1024, height: 2048,
    budget: { maxUpdateBytes: 8 * 1024 * 1024, maxRegions: 1 } };
  const peer = { ...large, id: 'generated/peer' };
  const x = setup(large, [peer]);
  const first = x.manager.acquire(large.id);
  await first.ready;
  x.complete();
  x.manager.prepareGeneratedTextures();
  x.manager.prepareGeneratedTextures();
  const second = x.manager.acquire(peer.id);
  await second.ready;
  const data = new Uint8Array(large.width * large.height * 4);
  const commit = (id, frame) => {
    data[0] = frame;
    x.store.begin(id, { sourceRevision: String(frame) })
      .commit({ regions: [{ x: 0, y: 0, width: large.width, height: large.height, data }] });
  };
  const prepare = () => {
    const before = x.manager.diagnostics().generatedUploadedBytes;
    x.manager.prepareGeneratedTextures();
    assert.ok(x.manager.diagnostics().generatedUploadedBytes - before <= large.budget.maxUpdateBytes);
  };

  commit(large.id, 1);
  prepare();
  assert.equal(second.value.generatedInitialized, true, 'initial upload precedes existing updates');
  assert.equal(x.manager.hasUninitializedGeneratedTextures(), false);
  prepare();

  for (let frame = 2; frame < 8; frame++) {
    commit(large.id, frame);
    commit(peer.id, frame);
    prepare();
  }
  // Both resources submit recent complete generations even though only one
  // full update fits in each frame. Inspect the actual submitted pixel buffers.
  for (const lease of [first, second]) {
    const uploads = x.uploads.filter(upload => upload.textureId === lease.value.texture.id);
    assert.ok(uploads.at(-1).pixels[0] >= 6, `${lease.resourceId} starved`);
  }
  x.manager.dispose();
  x.store.dispose();
});
