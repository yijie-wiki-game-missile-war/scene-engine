import assert from 'node:assert/strict';
import test from 'node:test';
import { associateColorPixels, programTextureSampling } from '../src/texture-sampling.js';

test('source conventions normalize to associated linear color before GPU sRGB filtering',()=>{
  const straight=new Uint8Array([255,255,255,128,255,40,100,0]);
  const premult=new Uint8Array([128,128,128,128,0,0,0,0]);
  const actual=associateColorPixels(straight,2,1);
  assert.deepEqual([...actual],[188,188,188,128,0,0,0,0]);
  assert.deepEqual(associateColorPixels(premult,2,1,'premultiplied'),actual);
  assert.deepEqual([...straight],[255,255,255,128,255,40,100,0]);
  assert.throws(()=>associateColorPixels(new Float32Array(8),2,1));
  assert.throws(()=>associateColorPixels(straight,2,2));
});

test('only associated color slots receive the straight-linear sampling boundary',()=>{
  const program={source:'vec4 evaluate(ProgramInput d){return texture2D(t_color,d.uv)+texture2D(t_mask,d.uv);}',
    textureSlots:{color:{usage:'color'},mask:{usage:'data'}}};
  const sampled=programTextureSampling(program,{color:{userData:{sceneEngineAlphaSampling:'premultiplied-linear'}}});
  assert.match(sampled.source,/se_sample_color\(d.uv\)/);
  assert.match(sampled.source,/texture2D\(t_mask,d.uv\)/);
  assert.match(sampled.helpers,/s.rgb\/s.a/);
  assert.match(sampled.helpers,/float bias/);
});
