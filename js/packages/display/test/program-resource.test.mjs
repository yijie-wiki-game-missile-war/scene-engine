import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceRegistry, createComponentRegistry, normalizeProgramParameters } from '@scene-engine/display';
import { VisualTimeChannels } from '../src/runtime/visual-time.js';

const source = 'vec4 evaluate(ProgramInput input) { return vec4(p_tint, 1.0); }';
export const program = { id: 'program/test', kind: 'program', revision: 1, language: 'glsl-module@1',
  stage: 'background', source, timeChannel: 'water', parameterSchema: {
    tint: { type: 'color', default: [0.1, 0.2, 0.3], min: 0, max: 1, updateable: true },
    enabled: { type: 'bool', default: true, updateable: false },
    edges: { type: 'vec4', length: 2, default: [[0,0,0,0], [1,1,1,1]], min: -100, max: 100, updateable: true },
  }, textureSlots: { mask: { usage: 'data' } } };
const texture = { id: 'texture/mask', kind: 'texture', url: '/mask.png', colorSpace: 'linear' };

test('program schema is frozen, complete, named and participates in resource description', () => {
  const registry = createResourceRegistry([program, texture]);
  const descriptor = registry.require(program.id).describe();
  assert.equal(descriptor.schema, 'scene-engine-program-resource@1');
  assert.equal(Object.isFrozen(descriptor.parameterSchema.tint.default), true);
  assert.equal(descriptor.source, source);
  assert.deepEqual(normalizeProgramParameters(descriptor, { tint: [1,0,0] }).tint, [1,0,0]);
  const components = createComponentRegistry();
  const props = components.normalizeProperties('render.background@1', {
    programResourceId: program.id, textures: { mask: texture.id }, parameters: { tint: [1,0,0] },
  }, registry);
  assert.equal(props.parameters.enabled, true);
  assert.throws(() => components.normalizeProperties('render.background@1', {
    programResourceId: program.id, textures: { other: texture.id },
  }, registry));
  assert.throws(() => components.normalizeProperties('render.background@1', {
    programResourceId: program.id, textures: { mask: texture.id }, parameters: { enabled: false },
  }, registry));
});

test('program validation rejects malformed types, bounds, loops and owner terminals before loading', () => {
  for (const replacement of [
    { source: 'void main() { gl_Position=vec4(0.0); }' },
    { source: source + ' void bad(){while(true){}}' },
    { source: source + ' void bad(){for(int i=0;i<1000;i++){}}' },
    { parameterSchema: { value: { type: 'float', default: NaN, min: 0, max: 1, updateable: true } } },
    { parameterSchema: { value: { type: 'vec3', default: [1,2], min: 0, max: 3, updateable: true } } },
    { parameterSchema: { value: { type: 'float', default: [0], length: 65, min: 0, max: 1, updateable: true } } },
    { parameterSchema: { value: { type: 'int', default: 0.5, min: 0, max: 1, updateable: true } } },
    { parameterSchema: { value: { type: 'float', default: 2, min: 0, max: 1, updateable: true } } },
    { unknown: true },
  ]) assert.throws(() => createResourceRegistry([{ ...program, ...replacement }]));
  assert.throws(() => normalizeProgramParameters(program, { unknown: 1 }));
});

test('procedural material requires a surface program and color/data texture semantics', () => {
  const material = { id: 'material/test', kind: 'material', family: 'material.program',
    programResourceId: program.id, textures: { mask: texture.id } };
  assert.throws(() => createResourceRegistry([program, texture, material]));
  createResourceRegistry([{ ...program, stage: 'surface' }, texture, material]);
  assert.throws(() => createResourceRegistry([{ ...program, stage: 'surface' },
    { ...texture, colorSpace: 'srgb' }, material]));
  assert.throws(() => createResourceRegistry([{ ...program, stage: 'surface' },
    texture, { ...material, textures: { mask: material.id } }]));
});

test('visual channels preserve phase across pause, rate and freeze with independent samples', () => {
  const time = new VisualTimeChannels(['water', 'cloud']);
  assert.equal(time.snapshot(3).water.seconds, 3);
  time.set('water', { paused: true }, 3);
  assert.equal(time.snapshot(8).water.seconds, 3);
  assert.equal(time.snapshot(8).cloud.seconds, 8);
  time.set('water', { paused: false, rate: 2 }, 8);
  assert.equal(time.snapshot(10).water.seconds, 7);
  time.set('water', { freezeSeconds: 12 }, 10);
  assert.deepEqual(time.snapshot(15).water, { seconds: 12, running: false });
  time.set('water', { freezeSeconds: null }, 15);
  assert.equal(time.snapshot(16).water.seconds, 14);
  assert.throws(() => time.set('water', { rate: Infinity }, 16));
  assert.equal(time.snapshot(16).water.seconds, 14);
});

test('global procedural pause retains independent channel controls and resumes continuously', () => {
  const time = new VisualTimeChannels(['water','cloud']);
  time.set('water', { paused:true }, 3);
  time.set('cloud', { rate:2 }, 3);
  const paused=time.setPaused(true, 5);
  assert.deepEqual(paused.cloud,{seconds:7,running:false});
  assert.deepEqual(time.snapshot(100),paused);
  time.set('cloud',{rate:.5},100);
  assert.equal(time.snapshot(200).cloud.seconds,7);
  assert.throws(()=>time.setPaused(1,200));
  time.setPaused(false,200);
  assert.deepEqual(time.snapshot(202).cloud,{seconds:8,running:true});
  assert.deepEqual(time.snapshot(202).water,{seconds:3,running:false});
  time.set('water',{freezeSeconds:12},202);
  time.setPaused(true,203);time.setPaused(true,210);time.setPaused(false,220);
  assert.deepEqual(time.snapshot(221).water,{seconds:12,running:false});
  assert.deepEqual(time.snapshot(221).cloud,{seconds:9,running:true});
});

test('integer schemas, defaults and updates stay within exact signed 32-bit GPU transport', () => {
  const descriptor = { ...program, source: 'vec4 evaluate(ProgramInput d){return vec4(float(p_count));}',
    parameterSchema: { count: { type: 'int', default: 0, min: -2147483648, max: 2147483647, updateable: true } } };
  const registered = createResourceRegistry([descriptor, texture]).require(program.id).describe();
  for (const count of [-2147483648, 2147483647]) {
    assert.equal(normalizeProgramParameters(registered, { count }).count, count);
  }
  for (const count of [-2147483649, 2147483648, 4294967296, Number.MAX_SAFE_INTEGER, .5]) {
    assert.throws(() => normalizeProgramParameters(registered, { count }));
    assert.throws(() => createResourceRegistry([{ ...descriptor, parameterSchema: {
      count: { ...descriptor.parameterSchema.count, default: count },
    } }, texture]));
  }
  for (const bounds of [{ min: -2147483649 }, { max: 2147483648 }, { min: -.5 }, { max: .5 }]) {
    assert.throws(() => createResourceRegistry([{ ...descriptor, parameterSchema: {
      count: { ...descriptor.parameterSchema.count, ...bounds },
    } }, texture]));
  }
});
