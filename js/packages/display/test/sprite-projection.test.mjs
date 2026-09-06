import assert from 'node:assert/strict';
import test from 'node:test';
import { createComponentRegistry, createResourceRegistry, defineFrameAnimation, definePrefab, PREFAB_DEFINITION_SCHEMA } from '../src/index.js';
import { createHarness, commitAuthority, emptyPrefab, IDENTITY, matrixTransform } from './helpers.mjs';

const program = { id:'program/card', kind:'program', revision:1, language:'glsl-module@1', stage:'surface',
  source:'vec4 evaluate(ProgramInput d){return texture2D(t_image,d.uv)*p_amount;}',
  textureSlots:{image:{usage:'color'}}, parameterSchema:{
    amount:{type:'float',default:.2,min:0,max:1,updateable:true},
    fixed:{type:'float',default:.3,min:0,max:1,updateable:false},
  }};
const material = {id:'material/card',kind:'material',family:'material.program',programResourceId:program.id,
  textures:{image:'texture/card'},parameters:{fixed:.6},properties:{alphaMode:'blend'}};
const resources = [program, material,
  {id:'texture/card',kind:'texture',url:'./card.png',colorSpace:'srgb',alphaSampling:'premultiplied'}];
const programSprite = {materialResourceId:material.id,width:2,height:1,projectionSemantics:'anchor-extent'};

test('sprite projection properties have an explicit closed geometry/anchor contract',()=>{
  const registry=createComponentRegistry();
  const resources=createResourceRegistry([{id:'texture/card',kind:'texture',url:'./card.png'}]);
  const props={textureResourceId:'texture/card',width:2,height:1,projectionSemantics:'anchor-extent'};
  const normalize=value=>registry.normalizeProperties('render.sprite@3',value,resources);
  assert.deepEqual(normalize(props).anchorOffset,[0,0,0]);
  assert.deepEqual(normalize(props).pivot,[.5,.5]);
  const offset=[1,2,3];const normalized=normalize({...props,anchorOffset:offset});offset[0]=99;
  assert.deepEqual(normalized.anchorOffset,[1,2,3]);assert.ok(Object.isFrozen(normalized.anchorOffset));
  for(const invalid of [{projectionSemantics:'guess-owner'}, {projectionSemantics:'geometry',anchorOffset:[0,0,0]},
    {projectionSemantics:'geometry',pivot:[.5,.5]}, {anchorOffset:[NaN,0,0]}, {pivot:[0,-.1]}, {pivot:[0,1.1]},
    {pivot:[NaN,0]}, {pivot:[0,0,0]}, {pivot:null}, {anchorOffset:null}]) {
    assert.throws(()=>normalize({...props,...invalid}));
  }
});

test('program sprite resource union validates parameters and preserves named associated sampling', () => {
  const registry=createComponentRegistry();
  const resourceRegistry=createResourceRegistry(resources);
  const normalize=value=>registry.normalizeProperties('render.sprite@3',value,resourceRegistry);
  const pivot=[.5,0];
  const properties=normalize({...programSprite,pivot,parameters:{amount:.8}});
  pivot[1]=1;
  assert.deepEqual(properties.pivot,[.5,0]);
  assert.ok(Object.isFrozen(properties.pivot));
  assert.deepEqual(properties.parameters,{amount:.8,fixed:.6});
  for (const field of ['textureResourceId','material','alpha','frame']) assert.equal(Object.hasOwn(properties,field),false);
  assert.deepEqual(registry.validateResourceReferences('render.sprite@3',properties,resourceRegistry),
    [{id:material.id,kinds:['material']}]);
  for (const patch of [{textureResourceId:'texture/card'}, {material:{}}, {alpha:1}, {frame:0},
    {projectionSemantics:'geometry'}, {projectionSemantics:undefined}, {materialResourceId:'texture/card'},
    {materialResourceId:program.id}, {materialResourceId:'missing'}, {parameters:{fixed:.3}},
    {parameters:{unknown:1}}, {parameters:{amount:Infinity}}, {width:0}, {height:NaN}, {pivot:[2,0]}]) {
    assert.throws(()=>normalize({...programSprite,...patch}));
  }
  assert.throws(()=>normalize({textureResourceId:'texture/card',width:2,height:1}));
  assert.throws(()=>createResourceRegistry(resources.map(entry=>entry.id===program.id ? {...entry,stage:'background'} : entry)));
  for (const badMaterial of [{...material,programResourceId:'missing'}, {...material,textures:{image:'missing'}},
    {...material,textures:{image:program.id}}]) {
    assert.throws(()=>createResourceRegistry(resources.map(entry=>entry.id===material.id ? badMaterial : entry)));
  }
  const ordinaryMaterials=createResourceRegistry([{id:'ordinary',kind:'material',family:'material.standard'}]);
  assert.throws(()=>registry.normalizeProperties('render.sprite@3',{...programSprite,materialResourceId:'ordinary'},ordinaryMaterials));
});

test('invalid program sprite authority candidate preserves prior properties and binding identity', async t => {
  const prefab=definePrefab({schema:PREFAB_DEFINITION_SCHEMA,id:'program-sprite',gameplayType:'program-sprite',
    root:{components:[{key:'sprite',type:'render.sprite@3',properties:programSprite}],children:[]},
    resolveState(state){return {components:{'$root/sprite':{pivot:state.pivot,parameters:{amount:state.amount}}}}}});
  const h=await createHarness({resources,prefabEntries:[prefab]});t.after(()=>h.runtime.dispose());
  commitAuthority(h.runtime,()=>h.runtime.authority.createNode({nodeId:0,parentNodeId:null,displayKindId:prefab.id,
    transformMode:'live',transform:IDENTITY,visible:true,state:{pivot:[.5,0],amount:.4}}));
  await h.runtime.whenReady();h.runtime.start();h.frames.step();
  const before=h.runtime.currentView().getComponentState('py/0','sprite');
  const binding=[...h.fakeBackends[0].bindings.values()].find(entry=>entry.identity.componentKey==='sprite');
  assert.equal(binding.patch.properties.materialResourceId,material.id);
  assert.deepEqual(binding.patch.properties.pivot,[.5,0]);
  assert.throws(()=>commitAuthority(h.runtime,()=>h.runtime.authority.setNodeState({nodeId:0,state:{pivot:[.5,2],amount:.9}})));
  assert.deepEqual(h.runtime.currentView().getComponentState('py/0','sprite'),before);
  assert.equal([...h.fakeBackends[0].bindings.values()].find(entry=>entry.identity.componentKey==='sprite'),binding);
});

test('fixed-panel compensation combined with anchor extent is rejected before authority exposure',async t=>{
  const prefab=emptyPrefab({childComponents:[
    {key:'panel',type:'behavior.billboard@2',properties:{mode:'continuous',axisMode:'y-axis'}},
    {key:'sprite',type:'render.sprite@3',properties:{textureResourceId:'texture/card',width:2,height:1,projectionSemantics:'anchor-extent'}},
  ]});
  const {runtime,fakeBackends}=await createHarness({prefabEntries:[prefab],resources:[{id:'texture/card',kind:'texture',url:'./card.png'}]});
  t.after(()=>runtime.dispose());
  assert.throws(()=>commitAuthority(runtime,()=>runtime.authority.createNode({nodeId:0,parentNodeId:null,
    displayKindId:prefab.id,transformMode:'live',transform:IDENTITY,visible:true,state:{}})),
  {code:'display-sprite-projection-combination-invalid'});
  assert.equal(runtime.currentView().getNode('py/0'),null);
  assert.equal(fakeBackends.at(-1).draws,0);
});

test('complete candidate can change fixed billboard and sprite projection together in either patch order', async t => {
  for (const spriteFirst of [true,false]) {
    const prefab=emptyPrefab({childComponents:[
      {key:'panel',type:'behavior.billboard@2',properties:{mode:'continuous',axisMode:'full',facing:'fixed'}},
      {key:'sprite',type:'render.sprite@3',properties:{textureResourceId:'plain',width:2,height:1}},
    ],resolveState(state){
      if (!state.anchor) return {};
      const sprite=['body/sprite',{projectionSemantics:'anchor-extent',pivot:[.5,0]}];
      const panel=['body/panel',{facing:'camera'}];
      return {components:Object.fromEntries(spriteFirst ? [sprite,panel] : [panel,sprite])};
    }});
    const h=await createHarness({prefabEntries:[prefab],resources:[{id:'plain',kind:'texture',url:'./card.png'}]});
    t.after(()=>h.runtime.dispose());
    commitAuthority(h.runtime,()=>h.runtime.authority.createNode({nodeId:0,parentNodeId:null,displayKindId:prefab.id,
      transformMode:'live',transform:IDENTITY,visible:true,state:{anchor:false}}));
    commitAuthority(h.runtime,()=>h.runtime.authority.setNodeState({nodeId:0,state:{anchor:true}}));
    assert.equal(h.runtime.currentView().getComponentState('prefab/py/0/body','sprite').properties.projectionSemantics,'anchor-extent');
  }
});

test('scene prefab projection inheritance follows parent order even when the child is declared first', async t => {
  const parent=definePrefab({schema:PREFAB_DEFINITION_SCHEMA,id:'camera-facing',gameplayType:'camera-facing',
    root:{components:[{key:'facing',type:'behavior.billboard@2',properties:{mode:'continuous',axisMode:'full',facing:'camera'}}],children:[]}});
  const child=definePrefab({schema:PREFAB_DEFINITION_SCHEMA,id:'program-card',gameplayType:'program-card',
    root:{components:[{key:'sprite',type:'render.sprite@3',properties:programSprite}],children:[]}});
  const h=await createHarness({resources,prefabEntries:[parent,child],sceneNodes:[
    {localName:'fixed-parent',parentLocalName:null,components:[{key:'facing',type:'behavior.billboard@2',
      properties:{mode:'continuous',axisMode:'full',facing:'fixed'}}]},
  ],prefabInstances:[
    {localName:'child',parentLocalName:'parent',prefabId:child.id},
    {localName:'parent',parentLocalName:'fixed-parent',prefabId:parent.id},
  ]});
  t.after(()=>h.runtime.dispose());
  assert.equal(h.runtime.currentView().getComponentState('scene/main/child','sprite').properties.materialResourceId,material.id);
  await assert.rejects(createHarness({resources,prefabEntries:[child],sceneNodes:[
    {localName:'fixed-parent',parentLocalName:null,components:[{key:'facing',type:'behavior.billboard@2',
      properties:{mode:'continuous',axisMode:'full',facing:'fixed'}}]},
  ],prefabInstances:[{localName:'child',parentLocalName:'fixed-parent',prefabId:child.id}]}),
  {code:'display-sprite-projection-combination-invalid'});
});

test('program sprites reject sprite.frame in static and runtime animation binding with the target contract error', async t => {
  const animation=defineFrameAnimation({id:'animation/card',target:{node:'$root',component:'sprite'},frames:[0],fps:1,loop:false});
  const makePrefab=animationId=>definePrefab({schema:PREFAB_DEFINITION_SCHEMA,id:'animated-program',gameplayType:'animated-program',
    root:{components:[{key:'sprite',type:'render.sprite@3',properties:programSprite},
      {key:'animator',type:'animation.player@1',properties:{animationId}}],children:[]}});
  await assert.rejects(createHarness({resources:[...resources,animation],prefabEntries:[makePrefab(animation.id)]}),
    {code:'display-animation-target-type-invalid'});
  const prefab=makePrefab(null);
  const h=await createHarness({resources:[...resources,animation],prefabEntries:[prefab]});t.after(()=>h.runtime.dispose());
  commitAuthority(h.runtime,()=>h.runtime.authority.createNode({nodeId:0,parentNodeId:null,displayKindId:prefab.id,
    transformMode:'live',transform:IDENTITY,visible:true,state:{}}));
  const animator=h.runtime._nodeIndex.require('py/0').requireComponent('animator');
  assert.throws(()=>animator.playAnimation('animator',animation.id),
    {code:'display-animation-target-type-invalid'});
  assert.equal(animator.properties.animationId,null);
});

for (const ancestor of [false,true]) test(`direct ${ancestor ? 'ancestor' : 'same-node'} Billboard properties roll back an incompatible fixed projection`, async t => {
  const h=await createHarness({resources,sceneNodes:[
    {localName:'parent',parentLocalName:null,transform:matrixTransform({position:[0,0,-5]}),components:[
      {key:'facing',type:'behavior.billboard@2',properties:{mode:'continuous',axisMode:'full',facing:'camera'}},
      ...(ancestor ? [] : [{key:'sprite',type:'render.sprite@3',properties:programSprite}]),
    ]},
    ...(ancestor ? [{localName:'child',parentLocalName:'parent',components:[{key:'sprite',type:'render.sprite@3',properties:programSprite}]}] : []),
  ]});t.after(()=>h.runtime.dispose());
  await h.runtime.whenReady();h.runtime.start();h.frames.step();
  const facing=h.runtime._nodeIndex.require('scene/main/parent').requireComponent('facing');
  const before=facing.properties;
  assert.throws(()=>h.componentRegistry.patchComponentProperties({component:facing,patch:{facing:'fixed'},resourceRegistry:h.resourceRegistry}),
    {code:'display-sprite-projection-combination-invalid'});
  assert.equal(facing.properties,before);
  assert.equal(facing.enabled,true);
  h.runtime.requestDraw();h.frames.step();
  assert.equal(h.runtime.summary().health,'ready');
});

test('enabling a fixed ancestor rolls back before it affects an anchor sprite', async t => {
  const h=await createHarness({resources,sceneNodes:[
    {localName:'parent',parentLocalName:null,components:[{key:'facing',type:'behavior.billboard@2',enabled:false,
      properties:{mode:'continuous',axisMode:'full',facing:'fixed'}}]},
    {localName:'child',parentLocalName:'parent',components:[{key:'sprite',type:'render.sprite@3',properties:programSprite}]},
  ]});t.after(()=>h.runtime.dispose());
  const facing=h.runtime._nodeIndex.require('scene/main/parent').requireComponent('facing');
  assert.throws(()=>facing.setEnabled(true),{code:'display-sprite-projection-combination-invalid'});
  assert.equal(facing.enabled,false);
  assert.equal(h.runtime.summary().health,'ready');
});

test('direct Sprite geometry-to-anchor change rolls back under a fixed panel', async t => {
  const h=await createHarness({resources:[{id:'plain',kind:'texture',url:'./card.png'}],sceneNodes:[
    {localName:'card',parentLocalName:null,components:[
      {key:'facing',type:'behavior.billboard@2',properties:{mode:'continuous',axisMode:'full',facing:'fixed'}},
      {key:'sprite',type:'render.sprite@3',properties:{textureResourceId:'plain',width:2,height:1}},
    ]},
  ]});t.after(()=>h.runtime.dispose());
  const sprite=h.runtime._nodeIndex.require('scene/main/card').requireComponent('sprite');
  const before=sprite.properties;
  assert.throws(()=>h.componentRegistry.patchComponentProperties({component:sprite,
    patch:{projectionSemantics:'anchor-extent',pivot:[.5,0]},resourceRegistry:h.resourceRegistry}),
    {code:'display-sprite-projection-combination-invalid'});
  assert.equal(sprite.properties,before);
});

test('nested camera Billboard blocks ancestor validation and incompatible commit changes fail before cursor seal', async t => {
  const h=await createHarness({resources,sceneNodes:[
    {localName:'parent',parentLocalName:null,components:[{key:'facing',type:'behavior.billboard@2',
      properties:{mode:'continuous',axisMode:'full',facing:'camera'}}]},
    {localName:'child',parentLocalName:'parent',components:[
      {key:'facing',type:'behavior.billboard@2',properties:{mode:'continuous',axisMode:'full',facing:'camera'}},
      {key:'sprite',type:'render.sprite@3',properties:programSprite},
    ]},
  ]});t.after(()=>h.runtime.dispose());
  const parent=h.runtime._nodeIndex.require('scene/main/parent').requireComponent('facing');
  const child=h.runtime._nodeIndex.require('scene/main/child').requireComponent('facing');
  const patch=component=>h.componentRegistry.patchComponentProperties({component,patch:{facing:'fixed'},resourceRegistry:h.resourceRegistry});
  patch(parent);
  assert.equal(parent.properties.facing,'fixed');
  const before=h.runtime.summary().cursor;
  let applied=false;
  assert.throws(()=>commitAuthority(h.runtime,()=>{patch(child);applied=true;}),
    {code:'display-sprite-projection-combination-invalid'});
  assert.equal(applied,true,'a commit checks its complete candidate at seal');
  assert.deepEqual(h.runtime.summary().cursor,before);
  assert.equal(h.runtime.summary().health,'projection-invalid');
  assert.equal(h.fakeBackends[0].draws,0);
  assert.equal(h.frames.pending,0);
});
