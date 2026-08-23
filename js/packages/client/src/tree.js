import { SceneBodyError, validateTree } from './scene.js';

export class SceneTreeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SceneTreeError';
    this.code = code;
  }
}

export class SceneTree {
  constructor({ maximumTreeDepth = 64 } = {}) {
    if (!Number.isSafeInteger(maximumTreeDepth) || maximumTreeDepth <= 0) {
      fail('scene-tree-depth-limit-invalid');
    }
    this.maximumTreeDepth = maximumTreeDepth;
    this.state = null;
    this.disposed = false;
  }

  prepareCheckpoint(bootstrap, frame, commit) {
    this.requireOpen();
    if (frame.bytes.byteLength > bootstrap.header.maximumFrameBytes
        || frame.nodes.length > bootstrap.header.maximumDynamicNodes) {
      fail('scene-checkpoint-frame-limit');
    }
    validateFrameRegistry(frame.nodes, bootstrap.visualTypes, bootstrap.animationStates);
    validateTree(frame.nodes, bootstrap.staticNodes, this.maximumTreeDepth);
    const staticNodes = Object.freeze(bootstrap.staticNodes.map((node) => publicNode(node, true)));
    const dynamicNodes = Object.freeze(frame.nodes.map((node) => publicNode(node, false)));
    const state = buildState({
      generation: (this.state?.generation ?? 0) + 1,
      commit,
      bootstrap,
      staticNodes,
      dynamicNodes,
      maxSeenDisplayId: maximumId([...staticNodes, ...dynamicNodes]),
    });
    return Object.freeze({
      expectedState: this.state,
      checkpoint: true,
      state,
      plan: bootstrapPlan(state),
      sceneEvents: frame.events,
    });
  }

  prepareFrame(frame, commit) {
    this.requireReady();
    const previous = this.state;
    if (frame.bytes.byteLength > previous.bootstrap.header.maximumFrameBytes
        || frame.nodes.length > previous.bootstrap.header.maximumDynamicNodes) {
      fail('scene-frame-limit');
    }
    validateFrameRegistry(
      frame.nodes,
      previous.bootstrap.visualTypes,
      previous.bootstrap.animationStates,
    );
    validateTree(frame.nodes, previous.bootstrap.staticNodes, this.maximumTreeDepth);
    const dynamicNodes = Object.freeze(frame.nodes.map((node) => publicNode(node, false)));
    validateIdLifetime(previous, dynamicNodes);
    const state = buildState({
      generation: previous.generation,
      commit,
      bootstrap: previous.bootstrap,
      staticNodes: previous.staticNodes,
      dynamicNodes,
      maxSeenDisplayId: maximumId([{
        displayId: previous.maxSeenDisplayId,
      }, ...dynamicNodes]),
    });
    return Object.freeze({
      expectedState: previous,
      checkpoint: false,
      state,
      plan: framePlan(previous, state),
      sceneEvents: frame.events,
    });
  }

  prepareNoFrame(commit) {
    this.requireReady();
    const previous = this.state;
    const state = {
      ...previous,
      commit,
      view: null,
    };
    state.view = createView(state);
    return Object.freeze({
      expectedState: previous,
      checkpoint: false,
      state: Object.freeze(state),
      plan: null,
      sceneEvents: Object.freeze([]),
    });
  }

  commit(candidate) {
    this.requireOpen();
    if (!candidate?.state || candidate.expectedState !== this.state) {
      fail('scene-candidate-stale');
    }
    if (candidate.checkpoint) {
      if (this.state !== null
          && candidate.state.commit.commitSeq <= this.state.commit.commitSeq) {
        fail('scene-checkpoint-cursor-not-higher');
      }
    } else if (this.state === null
        || candidate.state.commit.commitSeq !== this.state.commit.commitSeq + 1) {
      fail('scene-candidate-stale');
    }
    this.state = candidate.state;
  }

  currentView() { this.requireReady(); return this.state.view; }
  getNode(displayId) { return this.currentView().getNode(displayId); }
  getProfile(displayId) { return this.currentView().getProfile(displayId); }
  getInteraction(displayId) { return this.currentView().getInteraction(displayId); }
  getWorldPose(displayId, out) { return this.currentView().getWorldPose(displayId, out); }

  dispose() {
    this.disposed = true;
    this.state = null;
  }

  requireOpen() { if (this.disposed) fail('scene-tree-disposed'); }
  requireReady() { this.requireOpen(); if (!this.state) fail('scene-checkpoint-missing'); }
}

function buildState({
  generation, commit, bootstrap, staticNodes, dynamicNodes, maxSeenDisplayId,
}) {
  const nodes = Object.freeze([...staticNodes, ...dynamicNodes]);
  const nodeById = new Map(nodes.map((node) => [node.displayId, node]));
  const poses = deriveWorldPoses(nodes, nodeById);
  const state = {
    generation,
    commit,
    bootstrap,
    staticNodes,
    dynamicNodes,
    nodes,
    nodeById,
    poses,
    maxSeenDisplayId,
    view: null,
  };
  state.view = createView(state);
  return Object.freeze(state);
}

function createView(state) {
  const bootstrap = state.bootstrap;
  return Object.freeze({
    generation: state.generation,
    commitSeq: state.commit.commitSeq,
    sourceTick: state.commit.sourceTick,
    nodeCount: state.nodes.length,
    staticNodeCount: state.staticNodes.length,
    dynamicNodeCount: state.dynamicNodes.length,
    sceneMetadataCount: bootstrap.sceneMetadataCount,
    visualTypeCount: bootstrap.visualTypeCount,
    animationStateCount: bootstrap.animationStateCount,
    nodeAt: (index) => at(state.nodes, index, 'scene-node-index-invalid'),
    getNode: (displayId) => state.nodeById.get(displayIdValue(displayId)) ?? null,
    getProfile: (displayId) => state.nodeById.get(displayIdValue(displayId))?.profile ?? null,
    getInteraction: (displayId) => (
      state.nodeById.get(displayIdValue(displayId))?.interaction ?? null
    ),
    getWorldPose: (displayId, out) => writePose(state.poses.get(displayIdValue(displayId)), out),
    sceneMetadataAt: (index) => bootstrap.sceneMetadataAt(index),
    getSceneMetadata: (typeId) => bootstrap.getSceneMetadata(typeId),
    visualTypeAt: (index) => bootstrap.visualTypeAt(index),
    animationStateAt: (index) => bootstrap.animationStateAt(index),
  });
}

function publicNode(node, isStatic) {
  return Object.freeze({
    animationFlags: node.animationFlags,
    animationStartTick: node.animationStartTick,
    animationStateId: node.animationStateId,
    displayId: node.displayId,
    flags: node.flags,
    interaction: publicPayload(node.interaction),
    isStatic,
    localPosition: node.localPosition,
    localRotationXyzw: node.localRotationXyzw,
    localScale: node.localScale,
    parentDisplayId: node.parentDisplayId,
    profile: publicPayload(node.profile),
    visualTypeId: node.visualTypeId,
  });
}

function publicPayload(value) {
  if (!value) return null;
  return Object.freeze({
    typeId: value.payloadTypeId,
    flags: value.flags,
    bytes: value.data.slice(),
  });
}

function validateFrameRegistry(nodes, visualTypes, animationStates) {
  const visuals = new Map(visualTypes.map((item) => [item.visualTypeId, item]));
  const animations = new Set(animationStates.map((item) => item.animationStateId));
  for (const node of nodes) {
    const visual = visuals.get(node.visualTypeId);
    if (!visual || (node.profile?.payloadTypeId ?? 0) !== visual.profileTypeId
        || (node.interaction?.payloadTypeId ?? 0) !== visual.interactionTypeId) {
      fail('scene-node-registry-mismatch');
    }
    if (node.animationStateId && !animations.has(node.animationStateId)) {
      fail('scene-node-animation-unknown');
    }
  }
}

function validateIdLifetime(previous, nodes) {
  const current = new Set(previous.dynamicNodes.map((node) => node.displayId));
  for (const node of nodes) {
    if (!current.has(node.displayId) && node.displayId <= previous.maxSeenDisplayId) {
      fail('scene-display-id-reused');
    }
  }
}

function bootstrapPlan(state) {
  const ids = Object.freeze(state.nodes.map((node) => node.displayId));
  return freezePlan({
    kind: 'bootstrap',
    generation: state.generation,
    commitSeq: state.commit.commitSeq,
    sourceTick: state.commit.sourceTick,
    createIds: ids,
  });
}

function framePlan(previous, candidate) {
  const oldNodes = new Map(previous.dynamicNodes.map((node) => [node.displayId, node]));
  const nextNodes = new Map(candidate.dynamicNodes.map((node) => [node.displayId, node]));
  const plan = {
    kind: 'frame',
    generation: candidate.generation,
    commitSeq: candidate.commit.commitSeq,
    sourceTick: candidate.commit.sourceTick,
    animationDirtyIds: [],
    createIds: [],
    interactionDirtyIds: [],
    localPoseDirtyIds: [],
    profileStateDirtyIds: [],
    removeIds: [],
    reparentIds: [],
    visibilityDirtyIds: [],
    visualReplaceIds: [],
  };
  for (const [identity] of oldNodes) if (!nextNodes.has(identity)) plan.removeIds.push(identity);
  for (const [identity, next] of nextNodes) {
    const old = oldNodes.get(identity);
    if (!old) { plan.createIds.push(identity); continue; }
    if (old.parentDisplayId !== next.parentDisplayId) plan.reparentIds.push(identity);
    if (!poseEquals(old, next)) plan.localPoseDirtyIds.push(identity);
    if ((old.flags & 1) !== (next.flags & 1)) plan.visibilityDirtyIds.push(identity);
    if (old.visualTypeId !== next.visualTypeId) plan.visualReplaceIds.push(identity);
    if (!payloadEquals(old.profile, next.profile)) plan.profileStateDirtyIds.push(identity);
    if (!payloadEquals(old.interaction, next.interaction)) plan.interactionDirtyIds.push(identity);
    if (old.animationStateId !== next.animationStateId
        || old.animationStartTick !== next.animationStartTick
        || old.animationFlags !== next.animationFlags) plan.animationDirtyIds.push(identity);
  }
  return freezePlan(plan);
}

function freezePlan(changes) {
  const empty = Object.freeze([]);
  const fields = [
    'animationDirtyIds', 'createIds', 'interactionDirtyIds', 'localPoseDirtyIds',
    'profileStateDirtyIds', 'removeIds', 'reparentIds', 'visibilityDirtyIds',
    'visualReplaceIds',
  ];
  const result = { ...changes };
  for (const field of fields) result[field] = Object.freeze([...(changes[field] ?? empty)]);
  return Object.freeze(result);
}

function deriveWorldPoses(nodes, byId) {
  const result = new Map();
  const visiting = new Set();
  const derive = (identity) => {
    if (result.has(identity)) return result.get(identity);
    if (visiting.has(identity)) fail('scene-tree-cycle');
    visiting.add(identity);
    const node = byId.get(identity);
    let pose;
    if (node.parentDisplayId === 0n) {
      pose = Object.freeze({
        position: Object.freeze([...node.localPosition]),
        rotationXyzw: Object.freeze([...node.localRotationXyzw]),
        scale: Object.freeze([...node.localScale]),
      });
    } else {
      pose = composePose(derive(node.parentDisplayId), node);
    }
    visiting.delete(identity);
    result.set(identity, pose);
    return pose;
  };
  for (const node of nodes) derive(node.displayId);
  return result;
}

function composePose(parent, child) {
  const scaled = child.localPosition.map((value, index) => value * parent.scale[index]);
  const rotated = rotate(parent.rotationXyzw, scaled);
  return Object.freeze({
    position: Object.freeze(parent.position.map((value, index) => value + rotated[index])),
    rotationXyzw: Object.freeze(multiplyQuaternion(parent.rotationXyzw, child.localRotationXyzw)),
    scale: Object.freeze(parent.scale.map((value, index) => value * child.localScale[index])),
  });
}

function multiplyQuaternion(left, right) {
  const [ax, ay, az, aw] = left; const [bx, by, bz, bw] = right;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
function rotate([x, y, z, w], [vx, vy, vz]) {
  const tx = 2 * (y * vz - z * vy); const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function writePose(pose, out) {
  if (!pose) return false;
  if (!out?.position || !out?.rotationXyzw || !out?.scale
      || out.position.length < 3 || out.rotationXyzw.length < 4 || out.scale.length < 3) {
    fail('scene-world-pose-output-invalid');
  }
  for (let index = 0; index < 3; index += 1) {
    out.position[index] = pose.position[index]; out.scale[index] = pose.scale[index];
  }
  for (let index = 0; index < 4; index += 1) out.rotationXyzw[index] = pose.rotationXyzw[index];
  return true;
}
function poseEquals(left, right) {
  return arraysEqual(left.localPosition, right.localPosition)
    && arraysEqual(left.localRotationXyzw, right.localRotationXyzw)
    && arraysEqual(left.localScale, right.localScale);
}
function payloadEquals(left, right) {
  if (left === null || right === null) return left === right;
  return left.typeId === right.typeId && left.flags === right.flags
    && arraysEqual(left.bytes, right.bytes);
}
function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function maximumId(nodes) {
  let result = 0n;
  for (const node of nodes) if (node.displayId > result) result = node.displayId;
  return result;
}
function displayIdValue(value) {
  try { const result = BigInt(value); if (result < 0n) throw new Error(); return result; } catch { fail('scene-display-id-invalid'); }
}
function at(values, index, code) {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) fail(code);
  return values[index];
}
function fail(code) {
  if (code instanceof SceneBodyError) throw code;
  throw new SceneTreeError(code);
}
