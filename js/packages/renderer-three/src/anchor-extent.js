import * as THREE from 'three';
import { projectUpperFieldY } from '@scene-engine/display';
import { UPPER_FIELD_FORWARD_GLSL } from './upper-field.js';

// A sprite's object matrix includes width/height. Anchor offsets are declared
// in Node local units, before that component-local size transform.
export function anchorExtentBounds(world, properties, camera, profile) {
  const offset = properties.anchorOffset ?? [0, 0, 0];
  const anchor = new THREE.Vector3(offset[0] / properties.width, offset[1] / properties.height, offset[2])
    .applyMatrix4(world).applyMatrix4(camera.matrixWorldInverse);
  const depth = -anchor.z;
  if (!Number.isFinite(depth) || depth < camera.near || depth > camera.far) return null;
  const width = new THREE.Vector3().setFromMatrixColumn(world, 0).length();
  const height = new THREE.Vector3().setFromMatrixColumn(world, 1).length();
  if (!(width > 0 && height > 0)) return null;
  const clip = new THREE.Vector4(anchor.x, anchor.y, anchor.z, 1).applyMatrix4(camera.projectionMatrix);
  const x = clip.x / clip.w; const y = projectUpperFieldY(clip.y / clip.w, profile);
  const sizeX = camera.projectionMatrix.elements[0] * width / clip.w;
  const sizeY = camera.projectionMatrix.elements[5] * height / clip.w;
  const pivot = properties.pivot ?? [0.5, 0.5];
  return { minX: x - sizeX * pivot[0], maxX: x + sizeX * (1-pivot[0]),
    minY: y - sizeY * pivot[1], maxY: y + sizeY * (1-pivot[1]),
    depth, ndcDepth: clip.z / clip.w, sizeX, sizeY };
}

export function installAnchorExtent(object, material, getProperties) {
  let profile = null;
  const program = material.userData.sceneEngineProgram !== undefined;
  const uniforms = {
    seAnchorProfile: { value: new THREE.Vector2(0, 0) },
    seAnchorSpan: { value: 2 },
    seAnchorClip: { value: new THREE.Vector2(0.1, 1000) },
    seAnchorOffset: { value: new THREE.Vector3() },
    seAnchorPivot: { value: new THREE.Vector2(0.5, 0.5) },
    ...(program ? {} : { seAnchorMapMatrix: { value: material.map.matrix } }),
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace(program ? '// scene-engine-anchor-declarations' : '#include <common>', `
${program ? '' : '#include <common>'}
uniform vec2 seAnchorProfile;
uniform float seAnchorSpan;
uniform vec2 seAnchorClip;
uniform vec3 seAnchorOffset;
uniform vec2 seAnchorPivot;
varying vec4 seAnchorRect;
varying vec2 seAnchorSource;
varying vec3 seAnchorWorld;
${UPPER_FIELD_FORWARD_GLSL}
float seAnchorInverse(float q) {
  if(q <= seAnchorProfile.x || seAnchorProfile.y == 0.0) return q;
  return seAnchorProfile.x + (q-seAnchorProfile.x)/(1.0-seAnchorProfile.y*(q-seAnchorProfile.x));
}
`);
    shader.vertexShader = shader.vertexShader.replace(program ? '// scene-engine-anchor-vertex' : '#include <project_vertex>', `
${program ? '' : '#include <project_vertex>'}
mat4 seWorld = modelMatrix;
#ifdef USE_INSTANCING
seWorld = modelMatrix * instanceMatrix;
#endif
vec4 seViewAnchor = viewMatrix * seWorld * vec4(seAnchorOffset, 1.0);
seAnchorWorld = (seWorld * vec4(seAnchorOffset, 1.0)).xyz;
vec4 seClipAnchor = projectionMatrix * seViewAnchor;
float seDepth = -seViewAnchor.z;
vec2 seSize = vec2(length(seWorld[0].xyz), length(seWorld[1].xyz));
if(seDepth < seAnchorClip.x || seDepth > seAnchorClip.y || min(seSize.x,seSize.y) <= 0.0) {
  gl_Position = vec4(2.0,2.0,2.0,1.0);
  seAnchorRect = vec4(0.0); seAnchorSource = vec2(0.0);
} else {
  vec2 seNdc = seClipAnchor.xy / seClipAnchor.w;
  seNdc.y = (seNdc.y + 1.0) * seAnchorSpan * 0.5 - 1.0;
  vec2 seCenter = vec2(seNdc.x, se_projectUpperFieldY(seNdc.y,seAnchorProfile.x,seAnchorProfile.y));
  vec2 seExtent = vec2(projectionMatrix[0][0], projectionMatrix[1][1] * seAnchorSpan * 0.5) * seSize / seClipAnchor.w;
  seAnchorRect = vec4(seCenter - seAnchorPivot * seExtent,seExtent);
  // Clip the final rectangle before G, so offscreen extent cannot cross its asymptote.
  vec2 seFinal = clamp(seAnchorRect.xy + (position.xy + 0.5) * seExtent, vec2(-1.0), vec2(1.0));
  seAnchorSource = vec2(seFinal.x, seAnchorInverse(seFinal.y));
  vec2 seSourceClip = vec2(seAnchorSource.x, (seAnchorSource.y + 1.0) * 2.0 / seAnchorSpan - 1.0);
  gl_Position = vec4(seSourceClip * seClipAnchor.w, seClipAnchor.z, seClipAnchor.w);
}
`);
    shader.fragmentShader = shader.fragmentShader.replace(program ? '// scene-engine-anchor-declarations' : '#include <common>', `
${program ? '' : '#include <common>'}
uniform vec2 seAnchorProfile;
${program ? '' : 'uniform mat3 seAnchorMapMatrix;'}
varying vec4 seAnchorRect;
varying vec2 seAnchorSource;
varying vec3 seAnchorWorld;
${program ? '' : UPPER_FIELD_FORWARD_GLSL}
vec2 seAnchorImageUv() {
  vec2 finalPosition = vec2(seAnchorSource.x, se_projectUpperFieldY(seAnchorSource.y,seAnchorProfile.x,seAnchorProfile.y));
  return (finalPosition - seAnchorRect.xy) / seAnchorRect.zw;
}
`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec2 seUv = seAnchorImageUv();
  vec4 sampledDiffuseColor = texture2D(map, (seAnchorMapMatrix * vec3(seUv,1.0)).xy);
  diffuseColor *= sampledDiffuseColor;
#endif
`);
  };
  material.customProgramCacheKey = () => `scene-engine-anchor-extent@2:${program}`;
  material.needsUpdate = true;
  object.frustumCulled = false;
  // Three sorts transparent meshes by this local-space sphere center. The
  // undeformed quad center is not the anchor when anchorOffset is nonzero.
  if (!object.isInstancedMesh) object.boundingSphere = new THREE.Sphere();
  object.raycast = function (raycaster, hits) {
    const camera = raycaster.camera;
    if (!camera) return;
    const test = (world, instanceId) => {
      const bounds = anchorExtentBounds(world, getProperties(), camera, profile);
      if (!bounds) return;
      const origin = raycaster.ray.origin.clone().applyMatrix4(camera.matrixWorldInverse);
      const direction = raycaster.ray.direction; const view = camera.matrixWorldInverse.elements;
      // Keep the ray's world-distance parameter; normalizing after the view
      // transform would change it when the camera inherits scale.
      const directionZ = view[2]*direction.x + view[6]*direction.y + view[10]*direction.z;
      const t = (-bounds.depth - origin.z) / directionZ;
      if (!Number.isFinite(t) || t < 0) return;
      const point = raycaster.ray.at(t, new THREE.Vector3());
      const projected = point.clone().project(camera);
      const y = projectUpperFieldY(projected.y, profile);
      if (projected.x < bounds.minX || projected.x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return;
      const distance = point.distanceTo(raycaster.ray.origin);
      if (distance < raycaster.near || distance > raycaster.far) return;
      hits.push({ object: this, point, distance,
        uv: new THREE.Vector2((projected.x-bounds.minX)/bounds.sizeX,(y-bounds.minY)/bounds.sizeY),
        ...(instanceId === undefined ? {} : { instanceId }) });
    };
    if (this.isInstancedMesh) {
      const instance = new THREE.Matrix4(); const world = new THREE.Matrix4();
      for (let index=0; index<this.count; index+=1) {
        this.getMatrixAt(index,instance);
        test(world.multiplyMatrices(this.matrixWorld,instance),index);
      }
    } else test(this.matrixWorld);
  };
  return {
    prepareQuery(projectionProfile) { profile = projectionProfile; },
    prepareFrame({ camera, projectionProfile, sourceSpan = 2 }) {
      const properties = getProperties(); const offset = properties.anchorOffset ?? [0,0,0];
      uniforms.seAnchorOffset.value.set(offset[0]/properties.width,offset[1]/properties.height,offset[2]);
      if (!object.isInstancedMesh) object.boundingSphere.center.copy(uniforms.seAnchorOffset.value);
      uniforms.seAnchorPivot.value.fromArray(properties.pivot ?? [0.5,0.5]);
      uniforms.seAnchorProfile.value.set(projectionProfile?.startNdcY ?? 0,projectionProfile?.strength ?? 0);
      uniforms.seAnchorSpan.value = sourceSpan;
      uniforms.seAnchorClip.value.set(camera.near,camera.far);
      material.map?.updateMatrix();
    },
  };
}
