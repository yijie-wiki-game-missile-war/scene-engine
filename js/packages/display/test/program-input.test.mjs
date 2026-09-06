import assert from 'node:assert/strict';
import test from 'node:test';
import { BehaviourComponent, definePrefab, PREFAB_DEFINITION_SCHEMA } from '../src/index.js';
import { createHarness, commitAuthority, IDENTITY } from './helpers.mjs';

const source='vec4 evaluate(ProgramInput d){return vec4(p_amount,p_fixed,0.0,1.0);}';
const resources=[
 {id:'program',kind:'program',revision:1,language:'glsl-module@1',stage:'surface',source,textureSlots:{},
  parameterSchema:{amount:{type:'float',default:.2,min:0,max:1,updateable:true},fixed:{type:'float',default:.3,min:0,max:1,updateable:false}}},
 {id:'mesh',kind:'mesh',positions:[0,0,0,1,0,0,0,1,0]},
 {id:'material',kind:'material',family:'material.program',programResourceId:'program',textures:{},parameters:{}},
];
for (const renderKind of ['mesh', 'sprite']) {
const mesh={key:'visual',type:`render.${renderKind}@${renderKind === 'mesh' ? 1 : 3}`,properties: renderKind === 'mesh'
 ? {meshResourceId:'mesh',materialResourceId:'material'}
 : {materialResourceId:'material',width:2,height:1,projectionSemantics:'anchor-extent',pivot:[.5,0]}};
const instances=[];
class Driver extends BehaviourComponent {
 static typeId='test.program-driver'; static allowMultiple=true;
 constructor(options){super(options);instances.push(this);}
}
async function harness(options={}){
 instances.length=0;
 const h=await createHarness({resources,configureComponents(r){r.register({ComponentClass:Driver});},
  sceneNodes:[{localName:'subject',parentLocalName:null,transform:IDENTITY,components:[mesh,{key:'driver',type:Driver.typeId,properties:{}},{key:'other',type:Driver.typeId,properties:{}}]}],
  ...options});
 await h.runtime.whenReady(); h.runtime.start(); h.frames.step();
 return h;
}
const binding=(h)=>[...h.fakeBackends.at(-1).bindings.values()].find(b=>b.identity.componentKey==='visual');

test(`${renderKind} same-node program parameters are transient, bounded and single-owner`,async(t)=>{
 const h=await harness();t.after(()=>h.runtime.dispose());
 const [driver,other]=instances;
 const before=h.runtime.summary();
 driver.setProgramParameters('visual',{amount:.8});h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.8);
 assert.equal(binding(h).patch.batchable,true);
 assert.equal(h.runtime.currentView().getComponentState('scene/main/subject', 'visual').properties.parameters.amount,.2);
 assert.deepEqual(h.runtime.summary().cursor,before.cursor);
 for(const patch of [{amount:NaN},{unknown:1},{amount:1.1},{fixed:.3},{amount:[.5]}]){
  assert.throws(()=>driver.setProgramParameters('visual',patch));
  h.frames.step();assert.equal(binding(h).patch.properties.parameters.amount,.8);
 }
 assert.throws(()=>other.setProgramParameters('visual',{amount:.5}),{code:'display-program-input-owner-conflict'});
 assert.throws(()=>driver.setProgramParameters('scene/main/camera',{amount:.5}));
 driver.setProgramParameters('visual',null);h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.2);
 other.setProgramParameters('visual',{amount:.6});h.frames.step();
 other.setEnabled(false);h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.2);
 assert.throws(()=>other.setProgramParameters('visual',{amount:.6}));
});

test(`${renderKind} backend rebuild preserves transient values; disposal releases claims without retaining components`,async(t)=>{
 const h=await harness();t.after(()=>h.runtime.dispose());
 const driver=instances[0];driver.setProgramParameters('visual',{amount:.7});h.frames.step();
 await h.runtime.rebuildRenderBackend();h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.7);
 driver.dispose();h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.2);
 assert.throws(()=>driver.setProgramParameters('visual',{amount:.9}),{code:'display-component-disposed'});
 assert.equal(h.runtime._programInputSystem.targets.size,0);
 assert.equal(h.runtime._programInputSystem.owners.size,0);
});

test(`${renderKind} complete authority state reconciliation retains visual sample and release reveals newest base value`,async(t)=>{
 const prefab=definePrefab({schema:PREFAB_DEFINITION_SCHEMA,id:'test.program',gameplayType:'test.program',
  root:{components:[mesh,{key:'driver',type:Driver.typeId,properties:{}}],children:[]},
  resolveState(state){return {components:{'$root/visual':{parameters:{amount:state.amount}}}}}});
 const h=await harness({sceneNodes:[],prefabEntries:[prefab]});t.after(()=>h.runtime.dispose());
 commitAuthority(h.runtime,()=>h.runtime.authority.createNode({nodeId:0,parentNodeId:null,displayKindId:prefab.id,
  transformMode:'live',transform:IDENTITY,visible:true,state:{amount:.2}}));
 await h.runtime.whenReady();h.frames.step();
 const driver=instances.find(x=>x.node?.name==='py/0');
 driver.setProgramParameters('visual',{amount:.9});h.frames.step();
 commitAuthority(h.runtime,()=>h.runtime.authority.setNodeState({nodeId:0,state:{amount:.4}}));
 h.frames.step();assert.equal(binding(h).patch.properties.parameters.amount,.9);
 driver.setProgramParameters('visual',null);h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.4);
 commitAuthority(h.runtime,()=>h.runtime.authority.removeNode({nodeId:0}));
 assert.equal(h.runtime._programInputSystem.targets.size,0);
});

test(`${renderKind} changing the program releases its claim and rejects unattached or cross-node inputs`,async t=>{
 const alternate=resources.map(resource=>resource.kind==='program' ? {...resource,id:'alternate-program'}
   : resource.kind==='material' ? {...resource,id:'alternate-material',programResourceId:'alternate-program'} : null).filter(Boolean);
 const h=await harness({resources:[...resources,...alternate],sceneNodes:[
  {localName:'subject',parentLocalName:null,transform:IDENTITY,components:[mesh,{key:'driver',type:Driver.typeId,properties:{}}]},
  {localName:'neighbor',parentLocalName:null,transform:IDENTITY,components:[{...mesh,key:'neighbor-visual'}]},
 ]});t.after(()=>h.runtime.dispose());
 const driver=instances[0];
 const unattached=new Driver({key:'unattached'});
 assert.throws(()=>unattached.setProgramParameters('visual',{amount:.9}),{code:'display-component-not-attached'});
 assert.throws(()=>driver.setProgramParameters('neighbor-visual',{amount:.9}),{code:'display-program-input-invalid'});
 driver.setProgramParameters('visual',{amount:.9});h.frames.step();
 const target=h.runtime._nodeIndex.require('scene/main/subject').requireComponent('visual');
 h.componentRegistry.patchComponentProperties({component:target,
  patch:{materialResourceId:'alternate-material',parameters:{}},resourceRegistry:h.resourceRegistry});
 h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.2);
 assert.equal(h.runtime._programInputSystem.targets.size,0);
 driver.setProgramParameters('visual',{amount:.8});
 target.setEnabled(false);target.setEnabled(true);h.frames.step();
 assert.equal(binding(h).patch.properties.parameters.amount,.2);
 assert.equal(h.runtime._programInputSystem.targets.size,0);
});
}
