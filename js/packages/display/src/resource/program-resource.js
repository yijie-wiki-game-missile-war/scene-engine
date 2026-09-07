import { validateProgramTextureSampling } from './texture-sampling.js';
import { cloneAndFreeze, exactKeys, plainRecord } from '../internal.js';
import { fail } from '../runtime/health.js';

export const PROGRAM_RESOURCE_SCHEMA = 'scene-engine-program-resource@1';
const TYPES = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4, color: 3 };
const ERROR = 'display-program-invalid';
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value)
      || /^(gl_|se_|p_|t_)/.test(value)) fail(ERROR);
  return value;
}
function number(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail(ERROR); return value; }
function scalar(value, spec) {
  if (spec.type === 'bool') { if (typeof value !== 'boolean') fail(ERROR); return value; }
  number(value);
  if (spec.type === 'int' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) fail(ERROR);
  if (value < spec.min || value > spec.max) fail(ERROR);
  return value;
}
function entry(value, spec) {
  const size = TYPES[spec.type];
  if (size === 1) return scalar(value, spec);
  if (!Array.isArray(value) || value.length !== size) fail(ERROR);
  return value.map((value) => scalar(value, spec));
}
function parameter(value, spec) {
  if (!spec.length) return entry(value, spec);
  if (!Array.isArray(value) || value.length !== spec.length) fail(ERROR);
  return value.map((value) => entry(value, spec));
}
export function normalizeProgramDescriptor(value) {
  const record = exactKeys(value, ['id', 'kind', 'revision', 'language', 'stage', 'source',
    'parameterSchema', 'textureSlots'], ['schema', 'hash', 'timeChannel'], ERROR);
  if (record.kind !== 'program' || record.language !== 'glsl-module@1'
      || !['background', 'surface'].includes(record.stage)
      || !Number.isSafeInteger(record.revision) || record.revision < 1
      || typeof record.id !== 'string' || !record.id || record.id.trim() !== record.id
      || (record.schema !== undefined && record.schema !== PROGRAM_RESOURCE_SCHEMA)
      || (record.hash !== undefined && !/^[a-f0-9]{64}$/.test(record.hash))) fail(ERROR);
  const source = record.source;
  if (typeof source !== 'string' || source.length > 65536) fail(ERROR);
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (!/\bvec4\s+evaluate\s*\(\s*ProgramInput\s+\w+\s*\)/.test(clean)
      || /\b(main|uniform|attribute|varying|layout|discard|while|do)\b|\b(gl_|se_)\w*|#/.test(clean)) fail(ERROR);
  // GLSL ES static integer loops only; the module cannot introduce an unbounded loop.
  const loops = [...clean.matchAll(/\bfor\s*\(([^)]*)\)/g)];
  if (loops.length > 8 || loops.length !== [...clean.matchAll(/\bfor\b/g)].length) fail(ERROR);
  let loopBudget = 1;
  for (const [, loop] of loops) {
    const match = /^\s*int\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;\s*(?:\1\+\+|\+\+\1)\s*$/.exec(loop);
    if (!match || Number(match[2]) > 64) fail(ERROR);
    loopBudget *= Math.max(1, Number(match[2]));
    if (loopBudget > 4096) fail(ERROR);
  }
  const schema = {}; let components = 0;
  for (const [name, value] of Object.entries(plainRecord(record.parameterSchema, ERROR))) {
    identifier(name);
    const spec = exactKeys(value, ['type', 'default', 'updateable'], ['min', 'max', 'length'], ERROR);
    if (!Object.hasOwn(TYPES, spec.type) || typeof spec.updateable !== 'boolean') fail(ERROR);
    if (spec.type === 'bool') { if (spec.min !== undefined || spec.max !== undefined) fail(ERROR); }
    else if (number(spec.min) > number(spec.max)) fail(ERROR);
    if (spec.type === 'int' && (!Number.isInteger(spec.min) || !Number.isInteger(spec.max)
      || spec.min < -2147483648 || spec.max > 2147483647)) fail(ERROR);
    if (spec.length !== undefined && (!Number.isSafeInteger(spec.length) || spec.length < 1 || spec.length > 64)) fail(ERROR);
    components += TYPES[spec.type] * (spec.length ?? 1);
    if (components > 256) fail(ERROR);
    schema[name] = { ...spec, default: parameter(spec.default, spec) };
  }
  const slots = {};
  for (const [name, value] of Object.entries(plainRecord(record.textureSlots, ERROR))) {
    identifier(name);
    const slot = exactKeys(value, ['usage'], [], ERROR);
    if (!['color', 'data'].includes(slot.usage)) fail(ERROR);
    slots[name] = slot;
  }
  if (Object.keys(slots).length > 8) fail(ERROR);
  for (const [, name] of clean.matchAll(/\bp_(\w+)/g)) if (!Object.hasOwn(schema, name)) fail(ERROR);
  for (const [, name] of clean.matchAll(/\bt_(\w+)/g)) if (!Object.hasOwn(slots, name)) fail(ERROR);
  return cloneAndFreeze({ ...record, schema: PROGRAM_RESOURCE_SCHEMA,
    timeChannel: identifier(record.timeChannel ?? 'default'), parameterSchema: schema, textureSlots: slots }, ERROR);
}

export function normalizeProgramParameters(program, value = {}, { dynamic = false } = {}) {
  const values = plainRecord(value, ERROR);
  for (const key of Object.keys(values)) {
    const spec = program.parameterSchema[key];
    if (!spec || (dynamic && !spec.updateable
      && JSON.stringify(values[key]) !== JSON.stringify(spec.default))) fail(ERROR);
  }
  return cloneAndFreeze(Object.fromEntries(Object.entries(program.parameterSchema).map(([name, spec]) =>
    [name, parameter(Object.hasOwn(values, name) ? values[name] : spec.default, spec)])), ERROR);
}

export function validateProgramTextures(program, value, registry) {
  const textures = plainRecord(value, ERROR);
  if (Object.keys(textures).length !== Object.keys(program.textureSlots).length) fail(ERROR);
  for (const [name, slot] of Object.entries(program.textureSlots)) {
    const id = textures[name];
    if (typeof id !== 'string' || !id) fail(ERROR);
    if (!registry) continue;
    const texture = registry.require(id).describe();
    if (texture.kind === 'generated-texture') {
      if (slot.usage !== 'data') fail(ERROR);
      continue;
    }
    validateProgramTextureSampling(program, name, texture);
    if (texture.kind !== 'texture' || (slot.usage === 'data' && texture.colorSpace !== 'linear')
        || (slot.usage === 'color' && texture.colorSpace !== 'srgb')) fail(ERROR);
  }
  return cloneAndFreeze(textures, ERROR);
}
