import * as THREE from 'three';

const MIN_ANCHOR_DEPTH = 1e-6;
const QUAD = Object.freeze([
  [-0.5, 0.5, 0], [0.5, 0.5, 0], [-0.5, -0.5, 0], [0.5, -0.5, 0],
]);

// The anchor keeps its ordinary world projection. Remove only the off-axis
// perspective term; retain depth, camera pitch foreshortening and zoom.
export function compensatePanelViewPoint(point, anchor, perspective, out = new THREE.Vector3()) {
  out.copy(point);
  if (perspective && anchor.z < -MIN_ANCHOR_DEPTH) {
    const ratio = (point.z - anchor.z) / anchor.z;
    out.x += anchor.x * ratio;
    out.y += anchor.y * ratio;
  }
  return out;
}

function installShader(material, anchor) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.scenePanelAnchor = { value: anchor };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `
#include <common>
uniform vec4 scenePanelAnchor;
#ifdef USE_INSTANCING
attribute vec4 sceneInstancePanelAnchor;
#endif
`);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
#include <project_vertex>
vec4 panelAnchor = scenePanelAnchor;
#ifdef USE_INSTANCING
panelAnchor = sceneInstancePanelAnchor;
#endif
if (panelAnchor.w > 0.5 && isPerspectiveMatrix(projectionMatrix)) {
  vec4 panelViewAnchor = viewMatrix * vec4(panelAnchor.xyz, 1.0);
  if (panelViewAnchor.z < -${MIN_ANCHOR_DEPTH}) {
    mvPosition.xy += panelViewAnchor.xy * ((mvPosition.z - panelViewAnchor.z) / panelViewAnchor.z);
    gl_Position = projectionMatrix * mvPosition;
  }
}
`);
  };
  material.customProgramCacheKey = () => 'scene-engine-panel-projection@1';
}

function writeAnchor(target, value) {
  if (value === null) target.set(0, 0, 0, 0);
  else target.set(value[0], value[1], value[2], 1);
}

// Raycast the same deformed quad as the vertex shader, including instances.
// No render-only Node transform or alternate picking pose is introduced.
function intersectPanel(object, worldMatrix, anchor, raycaster, hits, instanceId) {
  const camera = raycaster.camera;
  if (!camera) return;
  const anchorView = new THREE.Vector3(anchor.x, anchor.y, anchor.z)
    .applyMatrix4(camera.matrixWorldInverse);
  const vertices = QUAD.map((point) => {
    const world = new THREE.Vector3(...point).applyMatrix4(worldMatrix);
    if (anchor.w < 0.5 || !camera.isPerspectiveCamera) return world;
    world.applyMatrix4(camera.matrixWorldInverse);
    return compensatePanelViewPoint(world, anchorView, true, world).applyMatrix4(camera.matrixWorld);
  });
  const point = new THREE.Vector3();
  for (const [a, b, c] of [[0, 2, 1], [2, 3, 1]]) {
    if (!raycaster.ray.intersectTriangle(vertices[a], vertices[b], vertices[c], false, point)) continue;
    const distance = raycaster.ray.origin.distanceTo(point);
    if (distance < raycaster.near || distance > raycaster.far) continue;
    hits.push({ distance, point: point.clone(), object,
      ...(instanceId === undefined ? {} : { instanceId }) });
    return;
  }
}

export function installPanelProjection(object, material) {
  const anchor = new THREE.Vector4();
  installShader(material, anchor);
  const ordinaryRaycast = object.raycast;
  object.raycast = function raycast(raycaster, hits) {
    if (anchor.w < 0.5) return ordinaryRaycast.call(this, raycaster, hits);
    intersectPanel(this, this.matrixWorld, anchor, raycaster, hits);
  };
  return (value) => {
    writeAnchor(anchor, value);
    // The shader can move vertices outside the undeformed geometry's bounds.
    object.frustumCulled = value === null;
  };
}

export function installInstancedPanelProjection(object, material, count) {
  const anchors = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
  object.geometry.setAttribute('sceneInstancePanelAnchor', anchors);
  installShader(material, new THREE.Vector4());
  object.frustumCulled = false;
  object.raycast = function raycast(raycaster, hits) {
    const instanceMatrix = new THREE.Matrix4(); const world = new THREE.Matrix4();
    const anchor = new THREE.Vector4();
    for (let index = 0; index < this.count; index += 1) {
      this.getMatrixAt(index, instanceMatrix);
      // Hidden batch instances have a zero matrix; never resurrect them in pick.
      if (instanceMatrix.elements[0] === 0 && instanceMatrix.elements[1] === 0
          && instanceMatrix.elements[2] === 0) continue;
      world.multiplyMatrices(this.matrixWorld, instanceMatrix);
      anchor.fromBufferAttribute(anchors, index);
      intersectPanel(this, world, anchor, raycaster, hits, index);
    }
  };
  const setAt = (index, value) => {
    anchors.setXYZW(index, value?.[0] ?? 0, value?.[1] ?? 0, value?.[2] ?? 0, value === null ? 0 : 1);
  };
  return Object.freeze({ attribute: anchors, setAt });
}
