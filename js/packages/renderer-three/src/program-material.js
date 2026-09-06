import { UPPER_FIELD_FORWARD_GLSL } from './upper-field.js';
import { programTextureSampling } from './texture-sampling.js';
import * as THREE from 'three';
import { normalizeProgramParameters } from '@scene-engine/display';
import { ThreeRenderBackendError } from './errors.js';

const PROGRAM_DRAW_CONTEXT = new WeakMap();
const CHECKED_GPU_PROGRAMS = new WeakMap();
export function programCompileContext(renderer, fragmentSource) {
  const context = PROGRAM_DRAW_CONTEXT.get(renderer);
  PROGRAM_DRAW_CONTEXT.delete(renderer);
  return context && fragmentSource?.includes(context.marker) ? context : null;
}

// Only this module owns the stage entry points and output/color terminal.
export function createProgramMaterial(program, textures, parameters, properties = {}, instanceParameters = null, anchorExtent = false) {
  const uniforms = {
    se_time: { value: 0 }, se_inverseProjection: { value: new THREE.Matrix4() },
    se_cameraWorld: { value: new THREE.Matrix4() }, se_orthographic: { value: false },
    se_viewMatrix: { value: new THREE.Matrix4() }, se_projectionMatrix: { value: new THREE.Matrix4() },
    se_projectionParameters: { value: new THREE.Vector4() },
    se_viewportCssOrigin: { value: new THREE.Vector2() },
    se_viewportBufferOrigin: { value: new THREE.Vector2() },
    se_viewportCss: { value: new THREE.Vector2(1, 1) },
    se_viewportBuffer: { value: new THREE.Vector2(1, 1) },
    se_sourceBuffer: { value: new THREE.Vector2(1, 1) },
    se_projection: { value: new THREE.Vector3(0, 0, 2) },
    se_tint: { value: new THREE.Color(((properties.tintRgba ?? 0xffffffff) >>> 8) & 0xffffff) },
    se_opacity: { value: (properties.opacity ?? 1) * ((properties.tintRgba ?? 0xffffffff) & 255) / 255 },
    se_alphaCutoff: { value: properties.alphaMode === 'mask' ? properties.alphaCutoff : 0 },
  };
  const declarations = [];
  for (const [name, spec] of Object.entries(program.parameterSchema)) {
    if (instanceParameters && spec.updateable) continue;
    declarations.push(`uniform ${spec.type === 'color' ? 'vec3' : spec.type} p_${name}${spec.length ? `[${spec.length}]` : ''};`);
    uniforms[`p_${name}`] = { value: null };
  }
  if (instanceParameters) {
    declarations.push(instanceParameters.declarations);
    uniforms.se_instanceParameters = { value: instanceParameters.texture };
  }
  for (const name of Object.keys(program.textureSlots)) {
    declarations.push(`uniform sampler2D t_${name};`);
    uniforms[`t_${name}`] = { value: textures[name] };
  }
  const sampling = programTextureSampling(program, textures);
  const background = program.stage === 'background';
  const material = new THREE.ShaderMaterial({
    uniforms, depthTest: background ? false : properties.depthTest ?? true,
    depthWrite: background ? false : properties.depthWrite ?? properties.alphaMode !== 'blend',
    transparent: background ? false : properties.alphaMode === 'blend', side: THREE.DoubleSide,
    vertexShader: `varying vec2 se_uv; varying vec3 se_world;
      ${anchorExtent ? '// scene-engine-anchor-declarations' : ''}
      ${instanceParameters ? 'attribute float se_programRow; varying float se_instanceRow;' : ''}
      void main() { se_uv=uv; vec4 local=vec4(position,1.0);
        #ifdef USE_INSTANCING
        local=instanceMatrix*local;
        #endif
        ${instanceParameters ? 'se_instanceRow=se_programRow;' : ''}
        vec4 world=modelMatrix*local; se_world=world.xyz;
        ${background ? 'gl_Position=vec4(position.xy,1.0,1.0);' : 'gl_Position=projectionMatrix*viewMatrix*world;'}
        ${anchorExtent ? '// scene-engine-anchor-vertex' : ''}
      }`,
    fragmentShader: `uniform float se_time; uniform mat4 se_inverseProjection; uniform mat4 se_cameraWorld;
      uniform mat4 se_viewMatrix; uniform mat4 se_projectionMatrix; uniform vec4 se_projectionParameters;
      uniform vec2 se_viewportCssOrigin; uniform vec2 se_viewportBufferOrigin;
      uniform bool se_orthographic; uniform vec2 se_viewportCss; uniform vec2 se_viewportBuffer;
      uniform vec2 se_sourceBuffer; uniform vec3 se_projection;
      uniform vec3 se_tint; uniform float se_opacity; uniform float se_alphaCutoff;
      varying vec2 se_uv; varying vec3 se_world;
      struct ProgramInput { float visualSeconds; vec3 worldPosition; vec2 uv;
        bool hasAnchor; vec3 anchorWorldPosition;
        vec3 rayOrigin; vec3 rayDirection; vec2 viewportCss; vec2 viewportBuffer;
        vec2 screenUv; vec3 cameraPosition;
        mat4 cameraWorldMatrix; mat4 viewMatrix; mat4 projectionMatrix; mat4 inverseProjectionMatrix;
        int projectionMode; vec4 projectionParameters; vec3 projectionProfile;
        vec2 viewportCssOrigin; vec2 viewportBufferOrigin; };
      ${UPPER_FIELD_FORWARD_GLSL}
      ${anchorExtent ? '// scene-engine-anchor-declarations' : ''}
      ${declarations.join('\n')}
      ${sampling.helpers}
      ${sampling.source}
      void main() {
        ${instanceParameters?.assignments ?? ''}
        vec2 sourceUv=gl_FragCoord.xy/se_sourceBuffer;
        vec2 ndc=sourceUv*2.0-1.0;
        float originalY=sourceUv.y*se_projection.z-1.0;
        vec2 screenUv=vec2(sourceUv.x,0.5+0.5*se_projectUpperFieldY(originalY,se_projection.x,se_projection.y));
        vec4 nearPoint=se_inverseProjection*vec4(ndc,-1.0,1.0); nearPoint/=nearPoint.w;
        vec4 farPoint=se_inverseProjection*vec4(ndc,1.0,1.0); farPoint/=farPoint.w;
        vec3 origin=(se_cameraWorld*(se_orthographic ? nearPoint : vec4(0.0,0.0,0.0,1.0))).xyz;
        vec3 direction=normalize((se_cameraWorld*vec4(farPoint.xyz-nearPoint.xyz,0.0)).xyz);
        ${anchorExtent ? `vec3 anchorView=(se_viewMatrix*vec4(seAnchorWorld,1.0)).xyz;
        vec3 originView=(se_viewMatrix*vec4(origin,1.0)).xyz;
        vec3 directionView=(se_viewMatrix*vec4(direction,0.0)).xyz;
        vec3 sampleWorld=origin+direction*((anchorView.z-originView.z)/directionView.z);` : ''}
        ProgramInput se_sample=ProgramInput(se_time,${anchorExtent ? 'sampleWorld,seAnchorImageUv(),true,seAnchorWorld' : 'se_world,se_uv,false,vec3(0.0)'},origin,direction,se_viewportCss,se_viewportBuffer,
          screenUv,se_cameraWorld[3].xyz,se_cameraWorld,se_viewMatrix,se_projectionMatrix,se_inverseProjection,
          se_orthographic ? 1 : 0,se_projectionParameters,se_projection,se_viewportCssOrigin,se_viewportBufferOrigin);
        vec4 result=evaluate(se_sample); result.rgb*=se_tint; result.a*=se_opacity;
        if(result.a<se_alphaCutoff) discard;
        gl_FragColor=vec4(max(result.rgb,vec3(0.0)),clamp(result.a,0.0,1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const marker = '// scene-engine-procedural-program';
  material.fragmentShader = `${marker}\n${material.fragmentShader}`;
  material.userData.sceneEngineProgram = Object.freeze({ resourceId: program.id,
    revision: program.revision, programStage: program.stage });
  material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
    PROGRAM_DRAW_CONTEXT.set(renderer, { marker, metadata: material.userData.sceneEngineProgram,
      bindingToken: object.userData.threeBindingToken ?? null,
      batchIdentity: object.userData.threeBatchRecords?.[0]?.identity ?? null,
      affectedBindingCount: object.userData.threeBatchRecords?.length ?? 1 });
  };
  updateProgramParameters(material, program, parameters);
  return material;
}

export function updateProgramParameters(material, program, values) {
  const normalized = normalizeProgramParameters(program, values);
  for (const [name, value] of Object.entries(normalized)) {
    if (material.uniforms[`p_${name}`]) material.uniforms[`p_${name}`].value = Array.isArray(value) ? value.flat() : value;
  }
}

export function programFrameMethods(material, program) {
  const usesTime = /\.\s*visualSeconds\b/.test(program.source);
  let active = usesTime;
  let compiledVersion = -1;
  return {
    requiresContinuousDraw: usesTime,
    isContinuousDrawActive() { return active; },
    prepareProgramCompile(renderer, scene, camera, object) {
      if (!object.visible || compiledVersion === material.version || typeof renderer.compile !== 'function') return;
      // compile() finishes its renderer bookkeeping before link status is read.
      // Throwing from an in-progress render would leave Three's nested state
      // stacks unbalanced, so resource failures must be found before drawing.
      renderer.compile(object, camera, scene);
      // Only inspect the program selected for this material, never historical
      // failed entries still leased by another binding.
      const gpuProgram = renderer.properties.get(material).currentProgram;
      material.onBeforeRender(renderer, scene, camera, object.geometry, object);
      const cached = CHECKED_GPU_PROGRAMS.get(gpuProgram);
      if (cached?.error) {
        const error = new ThreeRenderBackendError('three-program-compile-failed', cached.error);
        error.programContext = PROGRAM_DRAW_CONTEXT.get(renderer);
        PROGRAM_DRAW_CONTEXT.delete(renderer);
        throw error;
      }
      if (!cached) {
        try { gpuProgram.getUniforms(); CHECKED_GPU_PROGRAMS.set(gpuProgram, { error: null }); }
        catch (error) {
          if (error.code === 'three-program-compile-failed') CHECKED_GPU_PROGRAMS.set(gpuProgram, { error: error.message });
          throw error;
        }
      }
      compiledVersion = material.version;
    },
    sample(frame) {
      const time = frame.visualTimes?.[program.timeChannel ?? 'default'];
      material.uniforms.se_time.value = time?.seconds ?? frame.visualSeconds;
      active = usesTime && (time?.running ?? true);
    },
    prepareProgramFrame({ camera, width, height, pixelRatio = 1, projectionProfile = null, sourceSpan = 2,
      finalWidth = width, finalHeight = height, finalPixelRatio = pixelRatio, viewportCssOrigin = { x: 0, y: 0 },
      finalCssWidth = finalWidth, finalCssHeight = finalHeight }) {
      material.uniforms.se_inverseProjection.value.copy(camera.projectionMatrixInverse);
      material.uniforms.se_cameraWorld.value.copy(camera.matrixWorld);
      material.uniforms.se_viewMatrix.value.copy(camera.matrixWorldInverse);
      material.uniforms.se_projectionMatrix.value.copy(camera.projectionMatrix);
      material.uniforms.se_projectionParameters.value.set(camera.near, camera.far,
        camera.isOrthographicCamera ? 0 : THREE.MathUtils.degToRad(camera.fov),
        camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom : 0);
      material.uniforms.se_viewportCssOrigin.value.set(viewportCssOrigin.x, viewportCssOrigin.y);
      material.uniforms.se_viewportBufferOrigin.value.set(0, 0);
      material.uniforms.se_orthographic.value = camera.isOrthographicCamera === true;
      material.uniforms.se_viewportCss.value.set(finalCssWidth, finalCssHeight);
      material.uniforms.se_viewportBuffer.value.set(Math.floor(finalWidth * finalPixelRatio), Math.floor(finalHeight * finalPixelRatio));
      material.uniforms.se_sourceBuffer.value.set(Math.floor(width * pixelRatio), Math.floor(height * pixelRatio));
      material.uniforms.se_projection.value.set(projectionProfile?.startNdcY ?? 0, projectionProfile?.strength ?? 0, sourceSpan);
    },
  };
}

export function createProgramBackgroundHandle(program, textures, properties) {
  const material = createProgramMaterial(program, textures, properties.parameters ?? {});
  const geometry = new THREE.PlaneGeometry(2, 2);
  const object = new THREE.Mesh(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = -2147483647;
  object.userData.sceneEngineProgramBackground = true;
  return {
    object, camera: null, pickable: false, batchFingerprint: null, createBatch: null,
    ...programFrameMethods(material, program),
    update(value) { updateProgramParameters(material, program, value.parameters ?? {}); },
    dispose() { object.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
