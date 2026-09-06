import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceRegistry, createComponentRegistry } from '../src/index.js';

const texture = {id:'color',kind:'texture',url:'/color.png',colorSpace:'srgb',
  alphaEncoding:'premultiplied',minFilter:'linear-mipmap-linear',magFilter:'nearest'};
const program = {id:'program',kind:'program',revision:1,language:'glsl-module@1',stage:'surface',
  textureSlots:{color:{usage:'color'}},parameterSchema:{},
  source:'vec4 evaluate(ProgramInput data){return texture2D(t_color, data.uv);}'};
const material = {id:'material',kind:'material',family:'material.program',programResourceId:'program',
  textures:{color:'color'}};

test('premultiplied source and separate min/mag filters are catalog data for program color slots',()=>{
  const registry=createResourceRegistry([texture,program,material]);
  registry.validateReferences();
  assert.equal(registry.require('color').describe().magFilter,'nearest');
  for(const change of [
    {filter:'linear'}, {minFilter:'bad'}, {magFilter:'linear-mipmap-linear'},
    {mipmaps:false}, {colorSpace:'linear'}, {alphaSampling:'straight'}, {alphaEncoding:'unknown'},
  ]) assert.throws(()=>createResourceRegistry([{...texture,...change}]));
});

test('sampling normalization cannot be bypassed with ordinary materials, sprites or arbitrary sampler helpers',()=>{
  for(const consumer of [
    {id:'material',kind:'material',family:'material.unlit',textureResourceIds:['color']},
    {id:'atlas',kind:'texture-atlas',textureResourceId:'color',columns:2,rows:1},
    {id:'particle',kind:'particle',maximumCapacity:8,textureResourceId:'color'},
  ]) assert.throws(()=>createResourceRegistry([texture,consumer]).validateReferences(),
    {code:'display-texture-program-sampling-required'});
  const registry=createResourceRegistry([texture]);
  const components=createComponentRegistry();
  assert.throws(()=>components.normalizeProperties('render.sprite@3',
    {textureResourceId:'color',width:1,height:1},registry),{code:'display-texture-program-sampling-required'});
  const indirect={...program,source:'vec4 read(sampler2D tex,vec2 uv){return texture2D(tex,uv);} vec4 evaluate(ProgramInput d){return read(t_color,d.uv);}'};
  assert.throws(()=>createResourceRegistry([texture,indirect,material]).validateReferences(),
    {code:'display-program-texture-sampling-invalid'});
});
