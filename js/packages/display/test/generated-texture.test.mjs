import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceRegistry, createComponentRegistry, GENERATED_TEXTURE_RESOURCE_SCHEMA } from '@scene-engine/display';
import { GeneratedTextureStore } from '../src/runtime/generated-texture-store.js';

const descriptor = { id:'data/test',kind:'generated-texture',revision:1,width:4,height:2,format:'rgba8unorm',usage:'data',
  initialValue:[1,2,3,255],budget:{maxUpdateBytes:128,maxRegions:4} };
const patch = (x,y,data) => ({x,y,width:data.length/4,height:1,data:new Uint8Array(data)});
const uploadPixels = lease => lease.update().regions.flatMap(region => Array.from(region.data));
function setup(d = descriptor) { let draws=0; const registry=createResourceRegistry([d]);
  const store=new GeneratedTextureStore(registry,()=>draws++); return {store,api:store.publicPort,draws:()=>draws}; }

test('generated descriptors are closed catalog data and bind only program data slots',()=>{
  const registry=createResourceRegistry([descriptor,{id:'p',kind:'program',revision:1,language:'glsl-module@1',stage:'background',
    source:'vec4 evaluate(ProgramInput data){return texture2D(t_field,data.screenUv);}',parameterSchema:{},textureSlots:{field:{usage:'data'}}}]);
  assert.equal(registry.require(descriptor.id).describe().schema,GENERATED_TEXTURE_RESOURCE_SCHEMA);
  assert.equal(Object.isFrozen(registry.require(descriptor.id).describe().initialValue),true);
  const components=createComponentRegistry();
  components.normalizeProperties('render.background@1',{programResourceId:'p',textures:{field:descriptor.id}},registry);
  for(const value of [{url:'data:x'},{width:0},{width:2048,height:2048},{format:'rgb8'},{usage:'color'},
    {initialValue:[-1,2,3,255]},{mipmaps:true},{budget:{maxUpdateBytes:1e9,maxRegions:4}},{filter:'bicubic'}])
    assert.throws(()=>createResourceRegistry([{...descriptor,...value}]));
});

test('generation commits validate the entire candidate, copy callers and atomically merge overlap',()=>{
  const {store,api,draws}=setup(), lease=store.sourcePort.acquire(descriptor.id);
  const original=uploadPixels(lease);
  const ticket=api.begin(descriptor.id,{sourceRevision:'world@1'});
  assert.throws(()=>ticket.commit({regions:[patch(0,0,[255,0,0,255]),patch(4,0,[0,0,0,0])]}));
  assert.deepEqual(uploadPixels(lease),original); assert.equal(draws(),0);
  const a=patch(0,0,[255,0,0,255,0,255,0,255]);
  ticket.commit({regions:[a,patch(1,0,[0,0,255,255])]}); a.data.fill(99);
  assert.deepEqual(uploadPixels(lease).slice(0,8),[255,0,0,255,0,0,255,255]);
  assert.deepEqual(uploadPixels(lease).slice(8),original.slice(8));
  assert.equal(api.status(descriptor.id).status,'pending-upload'); assert.equal(draws(),1);
  assert.throws(()=>ticket.commit({regions:[a]})); store.dispose();
});

test('superseded, cancelled and disposed work cannot publish and readiness settles',async()=>{
  const {store,api}=setup();
  const old=api.begin(descriptor.id,{sourceRevision:'world@1'}), oldReady=api.whenReady(descriptor.id);
  const next=api.begin(descriptor.id,{sourceRevision:'world@2'});
  assert.equal(old.signal.aborted,true); assert.equal((await oldReady).status,'discarded');
  assert.equal(old.commit({regions:[patch(0,0,[9,9,9,9])]}).status,'discarded');
  const ready=api.whenReady(descriptor.id); next.cancel(); assert.equal((await ready).status,'discarded');
  const final=api.begin(descriptor.id,{sourceRevision:'world@3'}), finalReady=api.whenReady(descriptor.id);
  store.dispose(); store.dispose(); assert.equal(final.signal.aborted,true);
  assert.equal((await finalReady).status,'disposed'); assert.equal(final.commit({}).status,'discarded');
  assert.throws(()=>api.begin(descriptor.id,{sourceRevision:'late'}));
});

test('source revisions survive backend replacement and new GPU leases require a fresh upload',async()=>{
  const {store,api}=setup(); const first=store.sourcePort.acquire(descriptor.id);
  const ticket=api.begin(descriptor.id,{sourceRevision:'checkpoint@8'});
  ticket.commit({regions:[patch(2,1,[42,43,44,255])]});
  const saved=uploadPixels(first);
  const ready=api.whenReady(descriptor.id);
  first.submitted(ticket.generation); assert.equal(api.status(descriptor.id).status,'pending-upload');
  first.uploaded(ticket.generation); assert.equal((await ready).status,'ready');
  first.release('backend-disposed');
  assert.equal(api.status(descriptor.id).sampleable,false);
  const second=store.sourcePort.acquire(descriptor.id); assert.deepEqual(uploadPixels(second),saved);
  assert.equal(second.update(1).deferred,true);
  const update=second.update(128); assert.equal(update.byteLength,32); assert.equal(update.generation,ticket.generation);
  second.submitted(update.generation); second.uploaded(update.generation);
  assert.equal(api.status(descriptor.id).committedSourceRevision,'checkpoint@8');
  second.release('resource-unreferenced'); store.dispose();
});

test('local dirty rows remain bounded and do not upload an unchanged texture',()=>{
  const {store,api}=setup(), lease=store.sourcePort.acquire(descriptor.id);
  lease.submitted(0); lease.uploaded(0); assert.equal(lease.update(),null);
  api.begin(descriptor.id,{sourceRevision:'a'}).commit({regions:[patch(1,1,[4,5,6,7])]});
  api.begin(descriptor.id,{sourceRevision:'b'}).commit({regions:[patch(2,1,[8,9,10,11])]});
  const update=lease.update(); assert.equal(update.byteLength,8); assert.equal(update.regions.length,1);
  assert.equal(update.regions[0].start,20); assert.deepEqual([...update.regions[0].data],[4,5,6,7,8,9,10,11]);
  lease.submitted(update.generation); assert.equal(lease.update(),null); store.dispose();
});

test('float data preserves signed values, rejects nonfinite or wrong storage without changing the source',()=>{
  const {store,api}=setup({...descriptor,format:'rgba32float',initialValue:[-2,.25,1e3,1]});
  const lease=store.sourcePort.acquire(descriptor.id), ticket=api.begin(descriptor.id,{sourceRevision:'signed'});
  const before=uploadPixels(lease);
  for(const data of [new Uint8Array(4),new Float32Array([NaN,0,0,0]),new Float32Array([Infinity,0,0,0])])
    assert.throws(()=>ticket.commit({regions:[{x:0,y:0,width:1,height:1,data}]}));
  assert.deepEqual(uploadPixels(lease),before);
  ticket.commit({regions:[{x:0,y:0,width:1,height:1,data:new Float32Array([-42,.5,1,2])}]});
  assert.equal(uploadPixels(lease)[0],-42); store.dispose();
});

test('aggregate residency and per-update byte budgets reject before allocation or publication',()=>{
  const list=Array.from({length:8},(_,i)=>({...descriptor,id:`data/${i}`,width:1024,height:2048}));
  assert.throws(()=>new GeneratedTextureStore(createResourceRegistry(list),()=>{}),/budget-exceeded/);
  const {store,api}=setup({...descriptor,budget:{maxUpdateBytes:4,maxRegions:4}});
  const ticket=api.begin(descriptor.id,{sourceRevision:'large'});
  assert.throws(()=>ticket.commit({regions:[patch(0,0,[1,2,3,4,5,6,7,8])]}),/budget-exceeded/);
  assert.equal(api.status(descriptor.id).committedGeneration,0); store.dispose();
});

test('removal cancels an unfinished producer while backend retirement preserves it and waiters are shared',async()=>{
  const {store,api}=setup();let lease=store.sourcePort.acquire(descriptor.id);
  const retired=api.begin(descriptor.id,{sourceRevision:'in-flight'}), ready=api.whenReady(descriptor.id);
  assert.equal(api.whenReady(descriptor.id),ready);
  lease.release('backend-disposed');assert.equal(retired.signal.aborted,false);
  retired.commit({regions:[patch(0,0,[12,13,14,255])]});assert.equal(retired.cancel(),false);
  lease=store.sourcePort.acquire(descriptor.id);lease.submitted(retired.generation);lease.uploaded(retired.generation);
  assert.equal((await ready).status,'ready');
  const removed=api.begin(descriptor.id,{sourceRevision:'removed'}), removedReady=api.whenReady(descriptor.id);
  lease.release('resource-unreferenced');assert.equal(removed.signal.aborted,true);
  assert.equal((await removedReady).status,'discarded');assert.equal(removed.commit({}).status,'discarded');
  const next=api.begin(descriptor.id,{sourceRevision:'fresh'});assert.ok(next.generation>removed.generation);store.dispose();
});

test('removing and reattaching a committed source requires upload without cancelling its generation', async () => {
  for (const wasReady of [false, true]) {
    const { store, api } = setup();
    const first = store.sourcePort.acquire(descriptor.id);
    const ticket = api.begin(descriptor.id, { sourceRevision: 'retained' });
    ticket.commit({ regions: [patch(0, 0, [12, 13, 14, 255])] });
    const expected = uploadPixels(first);
    if (wasReady) {
      first.submitted(ticket.generation);
      first.uploaded(ticket.generation);
    }
    const priorReady = api.whenReady(descriptor.id);
    first.release('resource-unreferenced');
    assert.equal((await priorReady).status, wasReady ? 'ready' : 'discarded');
    assert.equal(ticket.signal.aborted, false);
    assert.equal(api.status(descriptor.id).status, 'pending-upload');
    assert.equal(api.status(descriptor.id).sampleable, false);

    const second = store.sourcePort.acquire(descriptor.id);
    const ready = api.whenReady(descriptor.id);
    assert.deepEqual(uploadPixels(second), expected);
    second.submitted(ticket.generation);
    assert.equal(api.status(descriptor.id).status, 'pending-upload');
    second.uploaded(ticket.generation);
    assert.equal((await ready).status, 'ready');
    assert.equal(api.status(descriptor.id).committedSourceRevision, 'retained');
    assert.equal(ticket.cancel(), false);
    second.release('resource-unreferenced');
    store.dispose();
  }
});
