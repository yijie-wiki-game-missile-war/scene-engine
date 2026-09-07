import {
  BehaviourComponent, createComponentRegistry, createDisplayKindRegistry, createDisplayRuntime,
  createPrefabRegistry, createResourceRegistry, createSceneRegistry, defineDisplayKind, definePrefab,
  defineScene, deriveUpperFieldProjection, PREFAB_DEFINITION_SCHEMA, SCENE_DEFINITION_SCHEMA,
} from '@scene-engine/display';
import { createThreeRenderBackend } from '@scene-engine/renderer-three';

const host = document.querySelector('#host'), canvas = host.querySelector('canvas');
const query = new URLSearchParams(location.search);
host.style.width = `${Number(query.get('width')) || 640}px`;
host.style.height = `${Number(query.get('height')) || 480}px`;
const checks = {}, cases = [], errors = [], expectedFailures = [], backends = [], drivers = [];
const evidence = query.get('evidence') === '1' ? [] : null;
const matrix = (x = 0, y = 0, z = 0) => [1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1];
const width = 1.4, height = 1;
const profile = deriveUpperFieldProjection({ pitchDegrees:35, fovYDegrees:34, startNdcY:.1, targetNdcY:.79 });
const linear = value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
const field = (type, value, min = 0, max = 1) => ({ type, default:value, min, max, updateable:true });
class Driver extends BehaviourComponent {
  static typeId = 'fixture.program-sprite-driver';
  constructor(options) { super(options); drivers.push(this); }
}
// These checks independently reconstruct expected frame inputs inside a test
// evaluator. They do not supply geometry, projection or uniforms to the backend.
const source = `vec4 evaluate(ProgramInput data){
  if(p_mode==0)return vec4(data.uv,0.25,1.0);
  if(p_mode==1){
    bool valid=data.hasAnchor&&length(data.anchorWorldPosition-p_anchor)<0.001;
    vec4 worldView=data.viewMatrix*vec4(data.worldPosition,1.0);
    vec4 anchorView=data.viewMatrix*vec4(data.anchorWorldPosition,1.0);
    valid=valid&&abs(worldView.z-anchorView.z)<0.001;
    valid=valid&&length(cross(data.worldPosition-data.rayOrigin,data.rayDirection))<0.001;
    vec4 clip=data.projectionMatrix*worldView;
    vec2 uv=clip.xy/clip.w*0.5+0.5;
    float y=uv.y*data.projectionProfile.z-1.0;
    float delta=max(0.0,y-data.projectionProfile.x);
    float finalY=y<=data.projectionProfile.x?y:data.projectionProfile.x+delta/(1.0+data.projectionProfile.y*delta);
    valid=valid&&length(vec2(uv.x,finalY*0.5+0.5)-data.screenUv)<0.001;
    valid=valid&&data.projectionMode==p_cameraMode&&abs(data.visualSeconds-p_time)<0.001;
    return valid?vec4(0.0,1.0,0.0,1.0):vec4(1.0,0.0,0.0,1.0);
  }
  if(p_mode==2)return vec4(data.screenUv,0.25,1.0);
  if(p_mode==3)return vec4(p_color,p_alpha);
  if(p_mode==4)return texture2D(t_image,data.uv);
  if(p_mode==5)return vec4(data.hasAnchor?1.0:0.0,length(data.anchorWorldPosition)<0.001?1.0:0.0,0.0,1.0);
  if(p_mode==7)return vec4(1.0,1.0,1.0,data.uv.x);
  if(p_mode==8)return texture2D(t_image,vec2((float(p_frame)+mix(0.05,0.95,data.uv.x))*0.5,mix(0.05,0.95,data.uv.y)));
  return vec4(0.2+0.1*sin(data.visualSeconds),0.4,0.6,1.0);
}`;
const parameters = {
  mode:field('int',0,0,8), frame:field('int',0,0,1), anchor:field('vec3',[0,1,-5],-100,100), cameraMode:field('int',0,0,1),
  time:field('float',3,0,100), color:field('color',[1,0,0]), alpha:field('float',1),
};
function resources() {
  const items = [{ id:'program', kind:'program', revision:1, language:'glsl-module@1', stage:'surface',
    source, parameterSchema:parameters, textureSlots:{ image:{ usage:'color' } } },
  { id:'program/broken',kind:'program',revision:1,language:'glsl-module@1',stage:'surface',
    source:'vec4 evaluate(ProgramInput data){return missingFunction(data.uv);}',parameterSchema:parameters,textureSlots:{image:{usage:'color'}} },
  { id:'material/broken',kind:'material',family:'material.program',programResourceId:'program/broken',
    textures:{image:'texture/straight'},parameters:{},properties:{alphaMode:'opaque'} },
  { id:'quad', kind:'mesh', positions:[-width/2,-height/2,0,width/2,-height/2,0,width/2,height/2,0,-width/2,height/2,0],
    indices:[0,1,2,0,2,3], uvs:[0,0,1,0,1,1,0,1] }];
  for (const encoding of ['straight','premultiplied','atlas']) {
    items.push({ id:`texture/${encoding}`, kind:'texture', url:`/scripts/support/texture-alpha/${encoding}.png`,
      colorSpace:'srgb', ...(encoding === 'straight' ? { alphaSampling:'premultiplied' } : encoding==='premultiplied'?{ alphaEncoding:'premultiplied' }:{}),
      minFilter:'linear', magFilter:'linear', mipmaps:false });
    for (const alphaMode of ['opaque','blend','mask']) items.push({ id:`material/${encoding}/${alphaMode}`, kind:'material',
      family:'material.program', programResourceId:'program', textures:{ image:`texture/${encoding}` }, parameters:{},
      properties:{ alphaMode, depthTest:true, depthWrite:alphaMode !== 'blend', ...(alphaMode==='mask'?{alphaCutoff:.5}:{}) } });
  }
  return createResourceRegistry(items);
}
function properties(state, mesh = false) {
  return { materialResourceId:state.broken?'material/broken':`material/${state.encoding || 'straight'}/${state.mask ? 'mask' : state.blend ? 'blend' : 'opaque'}`,
    ...(mesh ? { meshResourceId:'quad' } : { width, height, projectionSemantics:'anchor-extent',
      pivot:state.pivot || [.5,.5], anchorOffset:state.offset || [0,0,0] }),
    parameters:state.parameters || {}, pickable:true };
}
function prefab(mesh) {
  return definePrefab({ schema:PREFAB_DEFINITION_SCHEMA, id:mesh ? 'mesh' : 'sprite', gameplayType:'fixture.visual',
    root:{ components:[], children:[{ localName:'visual', transform:matrix(), components:[
      { key:'visual', type:mesh ? 'render.mesh@1' : 'render.sprite@3', properties:properties({},mesh) },
      { key:'driver', type:Driver.typeId, properties:{} },
      { key:'composition', type:'render.composition@1', properties:{group:'ordinary'} }], children:[] }] },
    resolveState(state) { return { nodes:{ visual:{ transform:matrix(...state.position), visible:state.visible !== false } },
      components:{ 'visual/visual':properties(state,mesh),'visual/composition':{group:state.group||'ordinary'} } }; } });
}
class Frames {
  callbacks = new Map(); id = 0; time = 0; maximumPending = 0;
  now() { return this.time; }
  request(callback) { this.callbacks.set(++this.id,callback); this.maximumPending=Math.max(this.maximumPending,this.callbacks.size); return this.id; }
  cancel(id) { this.callbacks.delete(id); }
  step() { this.time+=16; const callbacks=[...this.callbacks.values()];this.callbacks.clear();for(const callback of callbacks)callback(this.time); }
}
let runtime;
try {
  let maximumErrorCss=0, maximumUvError=0, roundtripErrorCss=0, maximumScreenUvError=0, alphaConventionDifference=0;
  for (const orthographic of [false,true]) for (const compressed of [false,true]) {
    const label=`${orthographic?'orthographic':'perspective'}/${compressed?'upper':'identity'}`;
    const camera={ projection:orthographic?'orthographic':'perspective', near:.1, far:100,
      ...(orthographic?{orthoHeight:6}:{fovYDegrees:60}), ...(compressed?{projectionProfile:profile}:{}) };
    const scene=defineScene({ schema:SCENE_DEFINITION_SCHEMA,id:'main',sceneProfile:'program-sprite-validation',
      rendererProfile:{drawMode:'requested',maximumPixelRatio:2,clearRgba:0x000000ff,antialias:false,alpha:false,shadows:false,toneMapping:'none'},
      compositionPlan:{schema:'scene-engine-render-composition@1',id:'fixture-composition',revision:1,defaultGroup:'ordinary',
        groups:[{id:'base'},{id:'ordinary'},{id:'foreground'}],passes:[{id:'base-pass',kind:'protected-base',groups:['base']},
          {id:'ordinary-pass',kind:'ordinary',groups:['ordinary']},{id:'foreground-pass',kind:'foreground',groups:['foreground']}]},
      activeCameraLocalName:'camera',nodes:[{localName:'camera',parentLocalName:null,transform:matrix(),
        components:[{key:'camera',type:'render.camera@1',properties:camera}]}],prefabInstances:[] });
    const frames=new Frames(), components=createComponentRegistry();components.register({ComponentClass:Driver});
    runtime=createDisplayRuntime({hostElement:host,canvas,resourceRegistry:resources(),componentRegistry:components,
      sceneRegistry:createSceneRegistry([scene]),prefabRegistry:createPrefabRegistry([prefab(false),prefab(true)]),
      displayKindRegistry:createDisplayKindRegistry(['sprite','mesh'].map(id=>defineDisplayKind({id,gameplayType:'fixture.visual',revision:1,authorityPrefabIds:[id],defaultPrefabId:id}))),
      authorityStateSchemas:[{gameplayType:'fixture.visual',schemaId:'fixture.visual@1',revision:1}],frameAdapter:frames,
      createRenderBackend(options){const backend=createThreeRenderBackend(options);backends.push(backend);return backend;},
      onHealth(event){if(event.code)(event.resourceId==='program/broken'?expectedFailures:errors).push(event);} });
    runtime.installScene({sceneName:'main'});
    const states=[{position:[0,1,-5]},{position:[0,1,-5],visible:false},{position:[0,1,-5],visible:false}];
    runtime.authority.installNodeMatrixPool({poolSize:3,matrices:new Float32Array([...matrix(),...matrix(),...matrix()])});
    states.forEach((state,nodeId)=>runtime.authority.createNode({nodeId,parentNodeId:null,displayKindId:nodeId===2?'mesh':'sprite',transformMode:'live',visible:true,state}));
    runtime.activate({commitSeq:0,sourceTick:0,lastCommandSeq:0});runtime.start();
    runtime.setVisualTimeControl('default',{freezeSeconds:3});
    await runtime.whenReady();frames.step();
    const gl=canvas.getContext('webgl2'),rect=host.getBoundingClientRect();let sequence=0;
    const read=()=>{runtime.capture();const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
    const pixel=(pixels,x,y)=>{const px=Math.max(0,Math.min(canvas.width-1,Math.floor((x-rect.left)*canvas.width/rect.width))),
      py=Math.max(0,Math.min(canvas.height-1,Math.floor((y-rect.top)*canvas.height/rect.height)));
      return {rgba:Array.from(pixels.slice(((canvas.height-1-py)*canvas.width+px)*4,((canvas.height-1-py)*canvas.width+px)*4+4)),
        x:rect.left+(px+.5)*rect.width/canvas.width,y:rect.top+(py+.5)*rect.height/canvas.height};};
    const update=async(nodeId,patch)=>{states[nodeId]={...states[nodeId],...patch};const cursor={commitSeq:++sequence,sourceTick:sequence,lastCommandSeq:sequence};
      runtime.commitGate.begin(cursor);try{runtime.authority.setNodeState({nodeId,state:states[nodeId]});runtime.commitGate.seal(cursor);}catch(error){runtime.commitGate.fail(error);throw error;}
      frames.step();await runtime.whenReady();frames.step();};
    const bounds=state=>{const anchor=state.position.map((v,i)=>v+(state.offset?.[i]||0)),point=runtime.projectWorldPoint({position:anchor});
      const scale=orthographic?rect.height/6:rect.height/(2*Math.tan(Math.PI/6)*-anchor[2]),pivot=state.pivot||[.5,.5];
      return {left:point.clientX-pivot[0]*width*scale,right:point.clientX+(1-pivot[0])*width*scale,
        top:point.clientY-(1-pivot[1])*height*scale,bottom:point.clientY+pivot[1]*height*scale};};
    // The UV evaluator emits constant linear blue .25. The terminal may filter
    // its silhouette; locate half coverage in linear light between pixel centers,
    // rather than treating every nonblack edge texel as full rectangle coverage.
    const edgeAt=(pixels,axis,expected,cross)=>{
      const horizontal=axis==='x',count=horizontal?canvas.width:canvas.height;
      const origin=horizontal?rect.left:rect.top,extent=horizontal?rect.width:rect.height;
      const crossPixel=Math.floor((cross-(horizontal?rect.top:rect.left))*(horizontal?canvas.height/rect.height:canvas.width/rect.width));
      const coverage=index=>{const x=horizontal?index:crossPixel,y=horizontal?crossPixel:index;
        return linear(pixels[((canvas.height-1-y)*canvas.width+x)*4+2])/.25;};
      let nearest=null;
      for(let i=0;i<count-1;i++){
        const a=coverage(i),b=coverage(i+1);
        if((a<.5)===(b<.5))continue;
        const edge=origin+(i+.5+(.5-a)/(b-a))*extent/count;
        if(nearest===null||Math.abs(edge-expected)<Math.abs(nearest-expected))nearest=edge;
      }
      if(nearest===null)throw Error(`${label}: missing ${axis} half-coverage crossing`);
      return nearest;
    };
    for(const pivot of [[.5,.5],[.5,0],[.35,.2]]) {
      await update(0,{pivot,position:[0,1,-5],offset:pivot[0]===.35?[.2,.15,0]:[0,0,0],parameters:{mode:0}});
      const pixels=read(),r=bounds(states[0]);
      const observed=[edgeAt(pixels,'x',r.left,(r.top+r.bottom)/2),edgeAt(pixels,'x',r.right,(r.top+r.bottom)/2),
        edgeAt(pixels,'y',r.top,(r.left+r.right)/2),edgeAt(pixels,'y',r.bottom,(r.left+r.right)/2)];
      const expected=[r.left,r.right,r.top,r.bottom];
      const edgeError=Math.max(...observed.map((v,i)=>Math.abs(v-expected[i])));maximumErrorCss=Math.max(maximumErrorCss,edgeError);
      let uvError=0,hitError=0;
      for(const u of [.2,.5,.8])for(const v of [.2,.5,.8]){
        const sample=pixel(pixels,r.left+u*(r.right-r.left),r.bottom-v*(r.bottom-r.top));
        uvError=Math.max(uvError,Math.abs(linear(sample.rgba[0])-(sample.x-r.left)/(r.right-r.left)),Math.abs(linear(sample.rgba[1])-(r.bottom-sample.y)/(r.bottom-r.top)));
        const hit=runtime.pick({clientX:sample.x,clientY:sample.y});if(!hit)throw Error(`${label}: visible UV point missed`);
        const projected=runtime.projectWorldPoint({position:hit.point});hitError=Math.max(hitError,Math.hypot(projected.clientX-sample.x,projected.clientY-sample.y));
      }
      maximumUvError=Math.max(maximumUvError,uvError);roundtripErrorCss=Math.max(roundtripErrorCss,hitError);
      cases.push({label,pivot,edgeErrorCss:edgeError,uvError,hitErrorCss:hitError});
      if(evidence&&compressed&&!orthographic&&pivot[0]===.35)evidence.push({label:'upper-field-offset-anchor-bottom-pivot-uv',dataUrl:canvas.toDataURL('image/png')});
    }
    for(const [edge,x,y] of [['left',rect.left-10,rect.top+rect.height/2],['right',rect.right+10,rect.top+rect.height/2],
      ['top',rect.left+rect.width/2,rect.top-10],['bottom',rect.left+rect.width/2,rect.bottom+10]]) {
      const ray=runtime.screenPointToWorldRay({clientX:x,clientY:y});
      const distance=(-5-ray.origin[2])/ray.direction[2],position=ray.origin.map((v,i)=>v+ray.direction[i]*distance);
      await update(0,{position,pivot:[.5,.5],offset:[0,0,0],parameters:{mode:0}});
      const r=bounds(states[0]),pixels=read(),visible={left:Math.max(rect.left,r.left),right:Math.min(rect.right,r.right),
        top:Math.max(rect.top,r.top),bottom:Math.min(rect.bottom,r.bottom)};
      const sample=pixel(pixels,(visible.left+visible.right)/2,(visible.top+visible.bottom)/2);
      const u=(sample.x-r.left)/(r.right-r.left),v=(r.bottom-sample.y)/(r.bottom-r.top);
      const uvError=Math.max(Math.abs(linear(sample.rgba[0])-u),Math.abs(linear(sample.rgba[1])-v));
      const hit=runtime.pick({clientX:sample.x,clientY:sample.y});
      checks[`${label}/clipped-${edge}`]=sample.rgba[2]>50&&uvError<=.025&&hit!==null;
      cases.push({label,edge,anchorOutside:true,uvError});
    }
    for(const [name,z] of [['near',-.05],['behind',1],['far',-101]]) {
      await update(0,{position:[0,0,z],parameters:{mode:0}});const pixels=read();
      checks[`${label}/clipped-${name}`]=pixels.every((v,i)=>i%4===3||v===0)&&runtime.pick({clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2})===null;
    }
    await update(0,{position:[0,1,-5],pivot:[.5,.5],parameters:{mode:1,anchor:[0,1,-5],cameraMode:orthographic?1:0,time:3}});
    let r=bounds(states[0]),samples=read();
    checks[`${label}/frameInputs`]=[.2,.5,.8].every(u=>{const c=pixel(samples,r.left+u*(r.right-r.left),(r.top+r.bottom)/2).rgba;return c[1]>250&&c[0]<5;});
    await update(0,{parameters:{mode:2}});samples=read();
    for(const u of [.2,.5,.8]){const s=pixel(samples,r.left+u*(r.right-r.left),(r.top+r.bottom)/2);
      maximumScreenUvError=Math.max(maximumScreenUvError,Math.abs(linear(s.rgba[0])-(s.x-rect.left)/rect.width),Math.abs(linear(s.rgba[1])-(rect.bottom-s.y)/rect.height));}
    await update(0,{pivot:[.35,.2],encoding:'atlas',parameters:{mode:8,frame:0}});r=bounds(states[0]);
    const atlasPixel=()=>pixel(read(),(r.left+r.right)/2,(r.top+r.bottom)/2).rgba;
    const firstFrame=atlasPixel();await update(0,{parameters:{mode:8,frame:1}});const secondFrame=atlasPixel();
    checks[`${label}/atlasFrames`]=firstFrame[0]>250&&firstFrame[1]<5&&secondFrame[1]>250&&secondFrame[0]<5;

    // Shared material, separate Behaviour claims, same-runtime rebuild and freeze.
    await update(0,{position:[-.9,0,-5],pivot:[.5,.5],encoding:'straight',parameters:{mode:3,color:[1,0,0]}});
    await update(1,{visible:true,position:[.9,0,-5],parameters:{mode:3,color:[0,0,1]}});
    const driver=drivers.find(d=>!d.disposed&&d.node?.name==='prefab/py/0/visual');
    driver.setProgramParameters('visual',{color:[0,1,0]});frames.step();
    const centers=states.slice(0,2).map(s=>runtime.projectWorldPoint({position:s.position}));
    samples=read();checks[`${label}/parameterIsolation`]=pixel(samples,centers[0].clientX,centers[0].clientY).rgba[1]>250&&pixel(samples,centers[1].clientX,centers[1].clientY).rgba[2]>250;
    const beforeRebuild=samples;await runtime.rebuildRenderBackend();await runtime.whenReady();frames.step();
    checks[`${label}/rebuild`]=read().every((v,i)=>v===beforeRebuild[i]);
    driver.setProgramParameters('visual',null);frames.step();
    await update(1,{visible:false});await update(0,{position:[0,1,-5],parameters:{mode:6}});
    const frozen=read();frames.time+=1000;runtime.requestDraw();frames.step();checks[`${label}/freeze`]=read().every((v,i)=>v===frozen[i]);
    runtime.setVisualTimeControl('default',{freezeSeconds:null});runtime.setVisualTimePaused(true);frames.step();
    const paused=read();frames.time+=1000;runtime.requestDraw();frames.step();
    checks[`${label}/pause`]=read().every((v,i)=>v===paused[i]);
    runtime.setVisualTimePaused(false);frames.time+=1000;runtime.requestDraw();frames.step();
    checks[`${label}/resume`]=read().some((v,i)=>v!==paused[i]);
    runtime.setVisualTimeControl('default',{freezeSeconds:3});frames.step();

    // Identical sprite coverage isolates the two associated-alpha source encodings.
    await update(0,{parameters:{mode:4},blend:true,encoding:'straight'});const straight=read();
    await update(0,{encoding:'premultiplied'});const premultiplied=read();
    for(let i=0;i<straight.length;i++)alphaConventionDifference=Math.max(alphaConventionDifference,Math.abs(straight[i]-premultiplied[i]));
    // Mesh and sprite sample the same image at their center, with mesh hasAnchor=false.
    await update(0,{visible:false});await update(2,{visible:true,position:[0,1,-5],blend:true,parameters:{mode:4}});
    const center=runtime.projectWorldPoint({position:[0,1,-5]});const meshColor=pixel(read(),center.clientX,center.clientY).rgba;
    const spriteColor=pixel(straight,center.clientX,center.clientY).rgba;
    checks[`${label}/meshSpriteAlpha`]=meshColor.slice(0,3).every((v,i)=>Math.abs(v-spriteColor[i])<=3)&&meshColor[0]>20;
    await update(2,{blend:false,parameters:{mode:5}});const noAnchor=pixel(read(),center.clientX,center.clientY).rgba;
    checks[`${label}/meshAnchorDefaults`]=noAnchor[1]>250&&noAnchor[0]<5;

    await update(2,{visible:false});await update(0,{visible:true,blend:false,mask:true,parameters:{mode:7},group:'base'});
    const maskBounds=bounds(states[0]),masked=read();
    const maskLeft=pixel(masked,maskBounds.left+(maskBounds.right-maskBounds.left)*.25,(maskBounds.top+maskBounds.bottom)/2).rgba;
    const maskRight=pixel(masked,maskBounds.left+(maskBounds.right-maskBounds.left)*.75,(maskBounds.top+maskBounds.bottom)/2).rgba;
    checks[`${label}/mask`]=maskLeft[0]===0&&maskRight[0]>250;
    await update(0,{mask:false,position:[0,0,-5],parameters:{mode:3,color:[1,0,0]}});
    await update(2,{visible:true,group:'foreground',position:[0,0,-6],parameters:{mode:3,color:[0,0,1]}});
    const protectedPoint=runtime.projectWorldPoint({position:[0,0,-5]}),protectedColor=pixel(read(),protectedPoint.clientX,protectedPoint.clientY).rgba;
    checks[`${label}/protectedDepth`]=protectedColor[0]>250&&protectedColor[2]<5;

    // Opaque near mesh wins depth; two blended sprites preserve far-to-near order.
    await update(2,{position:[0,0,-4],parameters:{mode:3,color:[0,0,1]}});
    await update(0,{visible:true,position:[0,0,-5],blend:false,group:'ordinary',parameters:{mode:3,color:[1,0,0]}});
    const mid=runtime.projectWorldPoint({position:[0,0,-5]});const depth=pixel(read(),mid.clientX,mid.clientY).rgba;
    checks[`${label}/depth`]=depth[2]>250&&depth[0]<5;
    await update(2,{visible:false,group:'ordinary'});await update(0,{position:[0,0,-4],blend:true,parameters:{mode:3,color:[1,0,0],alpha:.5}});
    await update(1,{visible:true,position:[0,0,-6],blend:true,parameters:{mode:3,color:[0,0,1],alpha:.5}});
    const blend=pixel(read(),mid.clientX,mid.clientY).rgba;
    cases.push({label,meshColor,spriteColor,noAnchor,blend});
    checks[`${label}/transparentOrder`]=blend[0]>blend[2]+35&&blend[2]>30;
    if(evidence&&compressed&&!orthographic)evidence.push({label:'upper-field-transparent-sprite-order',dataUrl:canvas.toDataURL('image/png')});
    await update(0,{position:[-.9,0,-5],blend:false,parameters:{mode:3,color:[1,0,0]}});
    await update(1,{position:[.9,0,-5],blend:false,parameters:{mode:3,color:[0,1,0]}});
    const healthy=runtime.projectWorldPoint({position:states[1].position}),faultPoint=runtime.projectWorldPoint({position:states[0].position});
    const originalLink=gl.linkProgram.bind(gl);let links=0;
    gl.linkProgram=(...args)=>{links++;return originalLink(...args);};
    const warningsBefore=expectedFailures.length;
    await update(0,{broken:true});const compileAttempts=links;
    const cursorBefore=runtime.summary().cursor.commitSeq;
    await update(1,{parameters:{mode:3,color:[0,1,0]}});
    for(let repeat=0;repeat<3;repeat++){runtime.requestDraw();frames.step();read();}
    const faultPixels=read();
    checks[`${label}/faultIsolation`]=pixel(faultPixels,healthy.clientX,healthy.clientY).rgba[1]>250
      &&pixel(faultPixels,faultPoint.clientX,faultPoint.clientY).rgba.slice(0,3).every(v=>v===0)
      &&runtime.pick({clientX:faultPoint.clientX,clientY:faultPoint.clientY})===null
      &&runtime.summary().cursor.commitSeq>cursorBefore&&runtime.summary().health==='ready';
    checks[`${label}/faultBounded`]=expectedFailures.length===warningsBefore+1&&links===compileAttempts&&compileAttempts===1;
    cases.push({label,compileAttempts,repeatedFrameLinks:links-compileAttempts,programFailureWarnings:expectedFailures.length-warningsBefore});
    await update(0,{broken:false});const restored=pixel(read(),faultPoint.clientX,faultPoint.clientY).rgba;
    checks[`${label}/faultRecovery`]=restored[0]>250&&restored[1]<5;
    gl.linkProgram=originalLink;

    if(orthographic&&compressed){
      await update(1,{visible:false});await update(0,{position:[0,1,-5],parameters:{mode:1,anchor:[0,1,-5],cameraMode:1,time:3}});
      host.style.margin='43px 59px';host.style.width=`${rect.width-73}px`;host.style.height=`${rect.height-57}px`;
      await new Promise(resolve=>setTimeout(resolve,60));runtime.requestDraw();frames.step();await runtime.whenReady();frames.step();
      const moved=host.getBoundingClientRect(),anchor=runtime.projectWorldPoint({position:[0,1,-5]});
      const movedPixel=()=>{const pixels=read(),x=Math.floor((anchor.clientX-moved.left)*canvas.width/moved.width),
        y=Math.floor((anchor.clientY-moved.top)*canvas.height/moved.height);return Array.from(pixels.slice(((canvas.height-1-y)*canvas.width+x)*4,((canvas.height-1-y)*canvas.width+x)*4+4));};
      const inputs=movedPixel();await update(0,{parameters:{mode:2}});const screen=movedPixel();
      await update(0,{parameters:{mode:0}});const uv=movedPixel();
      checks.movedViewport=inputs[1]>250&&inputs[0]<5&&Math.abs(linear(screen[0])-(anchor.clientX-moved.left)/moved.width)<.01
        &&Math.abs(linear(screen[1])-(moved.bottom-anchor.clientY)/moved.height)<.01
        &&Math.abs(linear(uv[0])-.5)<.025&&Math.abs(linear(uv[1])-.5)<.025
        &&canvas.width===Math.floor(moved.width*Math.min(devicePixelRatio,2))&&canvas.height===Math.floor(moved.height*Math.min(devicePixelRatio,2));
      cases.push({label,movedViewport:{left:moved.left,top:moved.top,width:moved.width,height:moved.height},inputs,screen,uv});
    }
    checks[`${label}/singleFrameOwner`]=frames.maximumPending===1;
    checks[`${label}/gl`]=gl.getError()===gl.NO_ERROR;
    await runtime.dispose();runtime=null;
  }
  checks.edges=maximumErrorCss<=1;checks.uv=maximumUvError<=.025;checks.pickRoundtrip=roundtripErrorCss<=1;
  checks.screenUv=maximumScreenUvError<=.01;checks.alphaSources=alphaConventionDifference<=2;
  checks.resourcesReleased=backends.every(b=>b.diagnostics().resourceCount===0&&b.diagnostics().resourceLeaseCount===0);
  checks.noErrors=errors.length===0;
  const gl=canvas.getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');
  publish({status:Object.values(checks).every(Boolean)?'READY':'NOT READY',checks,cases,maximumErrorCss,maximumUvError,roundtripErrorCss,
    maximumScreenUvError,alphaConventionDifference,errors,expectedProgramFailures:expectedFailures.length,...(evidence?{evidence}:{}),environment:{gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),devicePixelRatio,userAgent:navigator.userAgent}});
} catch(error) { await runtime?.dispose();publish({status:'NOT READY',error:String(error.stack||error),checks,cases,errors}); }
function publish(report) { document.body.dataset.result=btoa(unescape(encodeURIComponent(JSON.stringify(report))));document.title=report.status; }
