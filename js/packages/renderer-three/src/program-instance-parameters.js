import * as THREE from 'three';
import { normalizeProgramParameters } from '@scene-engine/display';

const WIDTHS = Object.freeze({ float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, color: 3, vec4: 4 });

// Renderer-owned instance transport, not a public generated texture Resource.
// One fixed-schema row per instance keeps changes bounded and sampler usage at
// one texture even for the full 256-scalar public parameter budget.
export function createProgramInstanceParameters(program, count) {
  let scalarCount = 0;
  const fields = Object.entries(program.parameterSchema).filter(([, spec]) => spec.updateable)
    .map(([name, spec]) => {
      const field = { name, spec, offset: scalarCount, storageWidth: spec.type === 'int' ? 2 : WIDTHS[spec.type] };
      scalarCount += field.storageWidth * (spec.length ?? 1);
      return field;
    });
  if (fields.length === 0) return null;
  const width = Math.ceil(scalarCount / 4);
  const stride = width * 4;
  const data = new Float32Array(stride * count);
  const texture = new THREE.DataTexture(data, width, count, THREE.RGBAFormat, THREE.FloatType);
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  const declarations = fields.map(({ name, spec }) => `${spec.type === 'color' ? 'vec3' : spec.type} p_${name}${spec.length ? `[${spec.length}]` : ''};`).join('\n');
  const assignments = [];
  for (const { name, spec, storageWidth, offset } of fields) {
    for (let item = 0; item < (spec.length ?? 1); item += 1) {
      const values = Array.from({ length: storageWidth }, (_, component) => {
        const scalar = offset + item * storageWidth + component;
        return `texture2D(se_instanceParameters,vec2(${(Math.floor(scalar / 4) + 0.5) / width},se_instanceRow)).${'rgba'[scalar % 4]}`;
      });
      const rhs = spec.type === 'bool' ? `(${values[0]}!=0.0)`
        : spec.type === 'int' ? `(int(${values[0]})*65536+int(${values[1]}))`
        : spec.type === 'float' ? values[0]
          : `${spec.type === 'color' ? 'vec3' : spec.type}(${values.join(',')})`;
      assignments.push(`p_${name}${spec.length ? `[${item}]` : ''}=${rhs};`);
    }
  }
  return {
    texture, stride, fields,
    declarations: `uniform sampler2D se_instanceParameters; varying float se_instanceRow;\n${declarations}`,
    assignments: assignments.join('\n'),
    attribute: new THREE.InstancedBufferAttribute(Float32Array.from({ length: count }, (_, index) => (index + 0.5) / count), 1),
    write(index, parameters) {
      const normalized = normalizeProgramParameters(program, parameters);
      let changed = false;
      for (const { name, spec, offset } of fields) {
        const value = normalized[name];
        const source = Array.isArray(value) ? value.flat() : [value];
        // Match WebGL uniform1i's signed 32-bit conversion without float32
        // precision loss at values beyond 2^24.
        const values = spec.type === 'int' ? source.flatMap((entry) => [entry >> 16, entry & 65535]) : source;
        for (let item = 0; item < values.length; item += 1) {
          const location = index * stride + offset + item;
          const next = Math.fround(Number(values[item]));
          if (data[location] !== next) { data[location] = next; changed = true; }
        }
      }
      if (changed) {
        texture.addUpdateRange(index * stride, stride);
        texture.needsUpdate = true;
      }
    },
    dispose() { texture.dispose(); },
  };
}
