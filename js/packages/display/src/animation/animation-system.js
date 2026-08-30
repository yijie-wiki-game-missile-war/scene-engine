import { attachedComponentNode } from '../component/component.js';
import { nonemptyString } from '../internal.js';
import { SpriteRendererComponent } from '../render/components.js';
import { fail } from '../runtime/health.js';
import { AnimationPlayerComponent } from './animation-player.js';
import { ANIMATION_RESOURCE_SCHEMA } from './animation-resource.js';

const CHANNEL_SPRITE_FRAME = 'sprite.frame';

function describeTarget(track) {
  return `${track.target.node}/${track.target.component}`;
}

function requireAnimationDescriptor(resourceRegistry, animationId) {
  const resource = resourceRegistry.require(animationId);
  const descriptor = resource.describe();
  if (descriptor.kind !== 'animation' || descriptor.schema !== ANIMATION_RESOURCE_SCHEMA) {
    fail('display-animation-resource-invalid',
      `Animation ${animationId} is not a ${ANIMATION_RESOURCE_SCHEMA} resource.`);
  }
  return descriptor;
}

function atlasFrameLimit(resourceRegistry, spriteProperties, animationId, trackIndex, track) {
  const texture = resourceRegistry.require(spriteProperties.textureResourceId).describe();
  if (texture.kind !== 'texture-atlas') {
    fail('display-animation-target-type-invalid',
      `Animation ${animationId} track ${trackIndex} targets ${describeTarget(track)} whose texture `
      + `${spriteProperties.textureResourceId} is not a texture-atlas.`);
  }
  return texture.columns * texture.rows;
}

function resolveRuntimeTrackBinding({
  descriptor,
  track,
  trackIndex,
  rootNode,
  resolveNode,
  resourceRegistry,
}) {
  if (track.channel !== CHANNEL_SPRITE_FRAME) {
    fail('display-animation-track-invalid',
      `Animation ${descriptor.id} track ${trackIndex} uses unsupported channel ${track.channel}.`);
  }
  const targetNode = track.target.node === '$root' ? rootNode : resolveNode(track.target.node);
  if (targetNode === null || targetNode.disposed) {
    fail('display-animation-target-missing',
      `Animation ${descriptor.id} track ${trackIndex} targets missing node `
      + `${describeTarget(track)} under ${rootNode.name}.`);
  }
  const target = targetNode.getComponent(track.target.component);
  if (target === null || target.disposed) {
    fail('display-animation-target-missing',
      `Animation ${descriptor.id} track ${trackIndex} targets missing component `
      + `${describeTarget(track)} under ${rootNode.name}.`);
  }
  if (!(target instanceof SpriteRendererComponent)) {
    fail('display-animation-target-type-invalid',
      `Animation ${descriptor.id} track ${trackIndex} target ${describeTarget(track)} `
      + 'is not a sprite renderer component.');
  }
  const limit = atlasFrameLimit(resourceRegistry, target.properties, descriptor.id,
    trackIndex, track);
  for (const keyframe of track.keyframes) {
    if (keyframe.value >= limit) {
      fail('display-animation-frame-out-of-range',
        `Animation ${descriptor.id} track ${trackIndex} keyframe ${keyframe.value} exceeds `
        + `atlas ${target.properties.textureResourceId} frame count ${limit}.`);
    }
  }
  return target;
}

function claimOutput(outputs, target, track, owner, descriptor, trackIndex) {
  let owners = outputs.get(target);
  if (!owners) { owners = new Map(); outputs.set(target, owners); }
  const current = owners.get(track.channel);
  if (current !== undefined && current !== owner) {
    fail('display-animation-output-conflict',
      `Animation ${descriptor.id} track ${trackIndex} output ${describeTarget(track)} `
      + `is already owned by player ${current.component?.key ?? current.key}.`);
  }
  owners.set(track.channel, owner);
}

function requirePrefabAnimationScope(scope) {
  if (!scope?.root || scope.root.disposed || typeof scope.nodeByPath?.get !== 'function') {
    fail('display-animation-player-placement-invalid',
      'Animation players require an attached Prefab scope identity and local node map.');
  }
  return scope;
}

/**
 * Compile-time binding preflight for statically declared root players. It mirrors the
 * runtime resolver in AnimationSystem: both must reject with the same error codes.
 */
export function validateCompiledPrefabAnimationBindings({ root, nodes }, resourceRegistry) {
  const outputs = new Set();
  for (const player of root.components) {
    if (player.type !== AnimationPlayerComponent.typeId || player.properties.animationId === null) {
      continue;
    }
    const descriptor = requireAnimationDescriptor(resourceRegistry, player.properties.animationId);
    descriptor.tracks.forEach((track, trackIndex) => {
      const node = track.target.node === '$root' ? root
        : nodes.find((candidate) => candidate.localPath === track.target.node);
      if (!node) {
        fail('display-animation-target-missing',
          `Animation ${descriptor.id} track ${trackIndex} targets missing node `
          + `${describeTarget(track)} in prefab.`);
      }
      const component = node.components.find((candidate) => candidate.key === track.target.component);
      if (!component) {
        fail('display-animation-target-missing',
          `Animation ${descriptor.id} track ${trackIndex} targets missing component `
          + `${describeTarget(track)} in prefab.`);
      }
      if (component.type !== SpriteRendererComponent.typeId) {
        fail('display-animation-target-type-invalid',
          `Animation ${descriptor.id} track ${trackIndex} target ${describeTarget(track)} `
          + 'is not a sprite renderer component.');
      }
      const limit = atlasFrameLimit(resourceRegistry, component.properties, descriptor.id, trackIndex,
        track);
      for (const keyframe of track.keyframes) {
        if (keyframe.value >= limit) {
          fail('display-animation-frame-out-of-range',
            `Animation ${descriptor.id} track ${trackIndex} keyframe ${keyframe.value} exceeds `
            + `atlas ${component.properties.textureResourceId} frame count ${limit}.`);
        }
      }
      const key = `${track.channel}\0${track.target.node}\0${track.target.component}`;
      if (outputs.has(key)) {
        fail('display-animation-output-conflict',
          `Animation ${descriptor.id} track ${trackIndex} output ${describeTarget(track)} `
          + 'is already owned by another root player.');
      }
      outputs.add(key);
    });
  }
}

/**
 * Package-private runtime preflight for a fully prepared Prefab scope. Resolver patches
 * have already produced the candidate properties, but the scope is not registered with
 * the live AnimationSystem yet. Replacement can therefore reject the shadow without
 * destroying the old live scope.
 */
export function validatePreparedPrefabAnimationBindings(scope, resourceRegistry) {
  requirePrefabAnimationScope(scope);
  const outputs = new Map();
  const rootComponents = scope.componentsByNode?.get?.(scope.root) ?? scope.root.components;
  for (const player of rootComponents) {
    if (!(player instanceof AnimationPlayerComponent) || player.properties.animationId === null) {
      continue;
    }
    const descriptor = requireAnimationDescriptor(resourceRegistry, player.properties.animationId);
    descriptor.tracks.forEach((track, trackIndex) => {
      const target = resolveRuntimeTrackBinding({
        descriptor,
        track,
        trackIndex,
        rootNode: scope.root,
        resolveNode: (localPath) => scope.nodeByPath.get(localPath) ?? null,
        resourceRegistry,
      });
      claimOutput(outputs, target, track, player, descriptor, trackIndex);
    });
  }
}

function timeTolerance(left, right) {
  return Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right));
}

function timeAtOrAfter(value, boundary) {
  return value >= boundary || boundary - value <= timeTolerance(value, boundary);
}

function loopSampleTime(elapsedMs, durationMs) {
  const remainder = elapsedMs % durationMs;
  return remainder <= timeTolerance(remainder, 0)
      || timeAtOrAfter(remainder, durationMs)
    ? 0 : remainder;
}

function sampleStep(keyframes, sampleMs, cursor) {
  let index = cursor.index;
  if (index >= keyframes.length || !timeAtOrAfter(sampleMs, keyframes[index].atMs)) index = 0;
  while (index + 1 < keyframes.length
      && timeAtOrAfter(sampleMs, keyframes[index + 1].atMs)) index += 1;
  cursor.index = index;
  return keyframes[index].value;
}

/**
 * The single Display-owned animation sampler. Timing starts at each player's own
 * `visualSeconds` origin; `sourceTick` never advances an animation. Sampled values are
 * pushed to the RenderSystem as transient overrides — base component properties stay
 * untouched.
 */
export class AnimationSystem {
  constructor({ resourceRegistry, renderSystem, onNeedsDraw = null }) {
    this._resourceRegistry = resourceRegistry;
    this._renderSystem = renderSystem;
    this._onNeedsDraw = onNeedsDraw;
    this._prefabScopes = new WeakMap();
    this._players = new Map();
    this._outputOwners = new Map();
    this._requiresContinuousDraw = false;
    this._requiresBindingValidation = false;
    this._cleared = false;
  }

  get requiresContinuousDraw() { return this._requiresContinuousDraw; }

  /**
   * Package-private provenance binding. PrefabInstantiator calls this before any
   * component on the instance root can register. The mapping contains only the Nodes
   * declared by that exact Prefab instance, so a parent animation cannot address a
   * nested child Prefab's internals even though every expanded value is an ordinary
   * Node/Component in the sole live graph.
   */
  bindPrefabScope(scope) {
    if (this._cleared) fail('display-animation-system-unavailable');
    const normalized = requirePrefabAnimationScope(scope);
    const current = this._prefabScopes.get(normalized.root);
    if (current !== undefined && current !== normalized) {
      fail('display-prefab-scope-duplicate');
    }
    this._prefabScopes.set(normalized.root, normalized);
  }

  /** Idempotent counterpart used after the scope's players have unregistered. */
  unbindPrefabScope(scope) {
    if (!scope?.root) return;
    if (this._prefabScopes.get(scope.root) === scope) this._prefabScopes.delete(scope.root);
  }

  register(player) {
    if (this._cleared) return;
    if (!(player instanceof AnimationPlayerComponent) || player.disposed) {
      fail('display-animation-player-missing');
    }
    const node = attachedComponentNode(player);
    if (node === null) fail('display-animation-player-missing');
    const prefabScope = this._prefabScopes.get(node);
    if (prefabScope === undefined || prefabScope.root !== node) {
      fail('display-animation-player-placement-invalid',
        `Animation player ${player.key} must be placed on a bound Prefab root node, not ${node.name}.`);
    }
    if (this._players.has(player)) fail('display-animation-player-duplicate');
    const record = {
      component: player,
      prefabScope,
      rootNode: node,
      declaredAnimationId: player.properties.animationId,
      declaredDescriptor: null,
      declaredBindings: [],
      currentAnimationId: null,
      descriptor: null,
      bindings: [],
      cursors: [],
      lastValues: [],
      startedAtVisualSeconds: null,
      pendingStart: false,
      completed: false,
      pendingDeclaredChange: false,
    };
    this._players.set(player, record);
    if (record.declaredAnimationId !== null) {
      const descriptor = requireAnimationDescriptor(this._resourceRegistry,
        record.declaredAnimationId);
      const bindings = this._resolveBindings(record, descriptor, false);
      record.declaredDescriptor = descriptor;
      record.declaredBindings = bindings;
      if (player.enabled) this._startAnimation(record, record.declaredAnimationId);
    }
    this._requestDraw();
  }

  unregister(player) {
    const record = this._players.get(player);
    if (!record) return;
    this._releaseRecord(record);
    this._players.delete(player);
  }

  /** Package-private transaction suspension that preserves the exact player record. */
  suspend(player) {
    const record = this._players.get(player);
    if (!record) fail('display-animation-player-missing');
    if (record.descriptor !== null) {
      record.descriptor.tracks.forEach((track, index) => {
        const target = record.bindings[index];
        const owners = this._outputOwners.get(target);
        if (owners?.get(track.channel) === record) {
          owners.delete(track.channel);
          if (owners.size === 0) this._outputOwners.delete(target);
        }
        this._renderSystem.clearAnimationOverride(target);
      });
    }
    this._players.delete(player);
    this._requestDraw();

    let active = true;
    return () => {
      if (!active) return;
      if (this._cleared) fail('display-animation-system-unavailable');
      if (this._players.has(player)) fail('display-animation-player-duplicate');
      if (record.descriptor !== null) {
        record.descriptor.tracks.forEach((track, index) => {
          const owners = this._outputOwners.get(record.bindings[index]);
          const owner = owners?.get(track.channel);
          if (owner !== undefined && owner !== record) {
            fail('display-animation-output-conflict');
          }
        });
      }

      this._players.set(player, record);
      if (record.descriptor !== null) {
        record.descriptor.tracks.forEach((track, index) => {
          const target = record.bindings[index];
          let owners = this._outputOwners.get(target);
          if (!owners) { owners = new Map(); this._outputOwners.set(target, owners); }
          owners.set(track.channel, record);
          if (record.lastValues[index] !== null) {
            this._renderSystem.setAnimationOverride(target, { frame: record.lastValues[index] });
          }
        });
      }
      active = false;
      this._requestDraw();
    };
  }

  setEnabled(player) {
    const record = this._players.get(player);
    if (!record) return;
    if (!player.enabled) {
      this._releaseAnimation(record, true);
      this._requestDraw();
      return;
    }
    if (player.properties.animationId !== null) {
      this._startAnimation(record, player.properties.animationId);
      this._requestDraw();
    }
  }

  propertiesChanged(player) {
    const record = this._players.get(player);
    if (!record) return;
    record.declaredAnimationId = player.properties.animationId;
    // Authority state patches may change both a player's declared clip and the target
    // Sprite atlas. Reconcile all players only after the complete transaction candidate
    // exists, so resolver property order cannot expose an invalid intermediate binding.
    record.pendingDeclaredChange = true;
    this._requiresBindingValidation = true;
    this._requestDraw();
  }

  targetPropertiesChanged(component) {
    if (this._outputOwners.has(component)
        || [...this._players.values()].some((record) =>
          record.declaredBindings.includes(component))) {
      this._requiresBindingValidation = true;
    }
  }

  /**
   * Agent command entry: `operation` is 'set', 'play' or 'stop'. The requester must be
   * attached to the same node as the player it addresses.
   */
  applyCommand(requester, operation, playerKey, animationId = null) {
    nonemptyString(playerKey, 'display-animation-command-invalid');
    if (operation !== 'stop' && animationId === null) {
      fail('display-animation-command-invalid');
    }
    if (requester?.disposed) fail('display-component-disposed');
    const node = attachedComponentNode(requester);
    if (node === null) fail('display-component-not-attached');
    const player = node.getComponent(playerKey);
    if (!(player instanceof AnimationPlayerComponent)) {
      fail('display-animation-player-missing',
        `No animation player with key ${playerKey} is attached to ${node.name}.`);
    }
    const record = this._players.get(player);
    if (!record) fail('display-animation-player-missing');
    if (operation === 'stop') {
      this._releaseAnimation(record, true);
    } else if (!player.enabled) {
      // Disabled players own no outputs. Re-enable always restarts the declarative clip,
      // so commands issued while disabled are intentionally ignored.
      return;
    } else if (operation === 'set' && record.currentAnimationId === animationId) {
      return;
    } else {
      this._startAnimation(record, animationId);
    }
    this._requestDraw();
  }

  sample(frame) {
    if (this._players.size === 0) {
      this._requiresContinuousDraw = false;
      return;
    }
    let continuous = false;
    for (const record of this._players.values()) {
      if (record.pendingStart) {
        record.startedAtVisualSeconds = frame.visualSeconds;
        record.pendingStart = false;
      }
      if (record.descriptor === null || record.startedAtVisualSeconds === null) continue;
      const elapsedMs = Math.max(0, (frame.visualSeconds - record.startedAtVisualSeconds) * 1000);
      const descriptor = record.descriptor;
      const sampleMs = descriptor.loop
        ? loopSampleTime(elapsedMs, descriptor.durationMs)
        : (timeAtOrAfter(elapsedMs, descriptor.durationMs)
          ? descriptor.durationMs : elapsedMs);
      for (let index = 0; index < descriptor.tracks.length; index += 1) {
        const value = sampleStep(descriptor.tracks[index].keyframes, sampleMs, record.cursors[index]);
        if (record.lastValues[index] === value) continue;
        record.lastValues[index] = value;
        this._renderSystem.setAnimationOverride(record.bindings[index], { frame: value });
      }
      if (descriptor.loop) {
        continuous = true;
      } else if (!record.completed) {
        if (timeAtOrAfter(elapsedMs, descriptor.durationMs)) record.completed = true;
        else continuous = true;
      }
    }
    this._requiresContinuousDraw = continuous;
  }

  clear() {
    if (this._cleared) return;
    this._cleared = true;
    for (const record of [...this._players.values()]) this._releaseRecord(record);
    this._players.clear();
    this._outputOwners.clear();
    this._prefabScopes = new WeakMap();
    this._requiresContinuousDraw = false;
    this._requiresBindingValidation = false;
  }

  /**
   * Commit/activation barrier. Validate every final declarative binding, including
   * disabled and explicitly stopped players, plus every active imperative clip against
   * the current component and Resource properties before changing any player ownership.
   * A failure leaves the prior animation records intact and prevents the cursor from sealing.
   */
  validateAndApplyPendingChanges() {
    if (!this._requiresBindingValidation) return;
    const plans = [];
    const outputs = new Map();
    for (const record of this._players.values()) {
      const declaredAnimationId = record.component.properties.animationId;
      let declaredDescriptor = null;
      let declaredBindings = [];
      if (declaredAnimationId !== null) {
        declaredDescriptor = requireAnimationDescriptor(this._resourceRegistry,
          declaredAnimationId);
        declaredBindings = this._resolveBindings(record, declaredDescriptor, false);
      }

      let animationId = record.currentAnimationId;
      let restart = false;
      if (record.pendingDeclaredChange) {
        if (!record.component.enabled || declaredAnimationId === null) {
          animationId = null;
        } else if (declaredAnimationId !== record.currentAnimationId) {
          animationId = declaredAnimationId;
          restart = true;
        }
      }
      let descriptor = null;
      let bindings = [];
      if (animationId !== null) {
        if (animationId === declaredAnimationId) {
          descriptor = declaredDescriptor;
          bindings = declaredBindings;
        } else {
          descriptor = requireAnimationDescriptor(this._resourceRegistry, animationId);
          bindings = this._resolveBindings(record, descriptor, false);
        }
        descriptor.tracks.forEach((track, trackIndex) => {
          claimOutput(outputs, bindings[trackIndex], track, record, descriptor, trackIndex);
        });
      }
      plans.push({
        record,
        declaredAnimationId,
        declaredDescriptor,
        declaredBindings,
        animationId,
        descriptor,
        bindings,
        restart,
      });
    }

    let changed = false;
    for (const plan of plans) {
      const { record } = plan;
      record.declaredAnimationId = plan.declaredAnimationId;
      record.declaredDescriptor = plan.declaredDescriptor;
      record.declaredBindings = plan.declaredBindings;
      if (!record.pendingDeclaredChange) continue;
      record.pendingDeclaredChange = false;
      if (!plan.restart && plan.animationId === record.currentAnimationId) continue;
      this._releaseAnimation(record, true);
      if (plan.animationId !== null) {
        this._adoptResolvedAnimation(record, plan.animationId, plan.descriptor, plan.bindings);
      }
      changed = true;
    }
    this._requiresBindingValidation = false;
    if (changed) this._requestDraw();
  }

  _resolveBindings(record, descriptor, validateOwners = true) {
    const bindings = [];
    descriptor.tracks.forEach((track, trackIndex) => {
      const target = resolveRuntimeTrackBinding({
        descriptor,
        track,
        trackIndex,
        rootNode: record.rootNode,
        resolveNode: (localPath) => record.prefabScope.nodeByPath.get(localPath) ?? null,
        resourceRegistry: this._resourceRegistry,
      });
      if (validateOwners) {
        const owners = this._outputOwners.get(target);
        const channelOwner = owners?.get(track.channel);
        if (channelOwner !== undefined && channelOwner !== record) {
          fail('display-animation-output-conflict',
            `Animation ${descriptor.id} track ${trackIndex} output ${describeTarget(track)} `
            + `is already owned by player ${channelOwner.component.key}.`);
        }
      }
      bindings.push(target);
    });
    return bindings;
  }

  _startAnimation(record, animationId) {
    // Atomic switch: validate the full candidate before releasing the old animation.
    const descriptor = requireAnimationDescriptor(this._resourceRegistry, animationId);
    const bindings = this._resolveBindings(record, descriptor);
    this._releaseAnimation(record, true);
    this._adoptResolvedAnimation(record, animationId, descriptor, bindings);
  }

  _adoptResolvedAnimation(record, animationId, descriptor, bindings) {
    record.currentAnimationId = animationId;
    record.descriptor = descriptor;
    record.bindings = bindings;
    record.cursors = descriptor.tracks.map(() => ({ index: 0 }));
    record.lastValues = descriptor.tracks.map(() => null);
    record.startedAtVisualSeconds = null;
    record.pendingStart = true;
    record.completed = false;
    record.pendingDeclaredChange = false;
    descriptor.tracks.forEach((track, index) => {
      let owners = this._outputOwners.get(bindings[index]);
      if (!owners) { owners = new Map(); this._outputOwners.set(bindings[index], owners); }
      owners.set(track.channel, record);
    });
  }

  _releaseAnimation(record, clearOverrides) {
    if (record.descriptor === null) return;
    record.descriptor.tracks.forEach((track, index) => {
      const owners = this._outputOwners.get(record.bindings[index]);
      if (owners?.get(track.channel) === record) {
        owners.delete(track.channel);
        if (owners.size === 0) this._outputOwners.delete(record.bindings[index]);
      }
      if (clearOverrides) this._renderSystem.clearAnimationOverride(record.bindings[index]);
    });
    record.currentAnimationId = null;
    record.descriptor = null;
    record.bindings = [];
    record.cursors = [];
    record.lastValues = [];
    record.startedAtVisualSeconds = null;
    record.pendingStart = false;
    record.completed = false;
  }

  _releaseRecord(record) {
    this._releaseAnimation(record, true);
  }

  _requestDraw() {
    try { this._onNeedsDraw?.(); } catch { /* draw requests cannot break animation state */ }
  }
}
