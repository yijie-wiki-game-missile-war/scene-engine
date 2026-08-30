import {
  booleanValue,
  cloneAndFreeze,
  deepFreeze,
  exactKeys,
  finiteNumber,
  nonemptyString,
  plainRecord,
  safeInteger,
} from '../internal.js';
import { assertLocalPath } from '../node/node-name.js';
import { fail } from '../runtime/health.js';

export const ANIMATION_RESOURCE_SCHEMA = 'scene-engine-animation-resource@2';
export const ANIMATION_CHANNELS = Object.freeze(['sprite.frame']);
export const ANIMATION_INTERPOLATIONS = Object.freeze(['step']);

const RESOURCE_ERROR = 'display-animation-resource-invalid';
const TRACK_ERROR = 'display-animation-track-invalid';
const KEYFRAME_ERROR = 'display-animation-keyframes-invalid';

/**
 * Stable identity of one animated output inside a single animation. Two tracks in the
 * same descriptor may not share an output key.
 */
export function animationOutputKey(track) {
  return `${track.channel}\0${track.target.node}\0${track.target.component}`;
}

function animationTarget(value) {
  const record = exactKeys(value, ['node', 'component'], [], TRACK_ERROR);
  const node = record.node === '$root' ? '$root' : assertLocalPath(record.node, TRACK_ERROR);
  return Object.freeze({ node, component: nonemptyString(record.component, TRACK_ERROR) });
}

function animationKeyframes(value, durationMs) {
  if (!Array.isArray(value) || value.length === 0) fail(KEYFRAME_ERROR);
  const keyframes = value.map((entry, index) => {
    const record = exactKeys(entry, ['atMs', 'value'], [], KEYFRAME_ERROR);
    const atMs = finiteNumber(record.atMs, KEYFRAME_ERROR);
    if (atMs < 0 || atMs >= durationMs) fail(KEYFRAME_ERROR);
    if (index === 0 ? atMs !== 0 : atMs <= value[index - 1].atMs) fail(KEYFRAME_ERROR);
    return Object.freeze({ atMs, value: safeInteger(record.value, KEYFRAME_ERROR, { minimum: 0 }) });
  });
  return Object.freeze(keyframes);
}

function animationTrack(value, durationMs) {
  const record = exactKeys(value, ['channel', 'target', 'interpolation', 'keyframes'], [],
    TRACK_ERROR);
  if (!ANIMATION_CHANNELS.includes(record.channel)) fail(TRACK_ERROR);
  if (!ANIMATION_INTERPOLATIONS.includes(record.interpolation)) fail(TRACK_ERROR);
  return Object.freeze({
    channel: record.channel,
    target: animationTarget(record.target),
    interpolation: record.interpolation,
    keyframes: animationKeyframes(record.keyframes, durationMs),
  });
}

/**
 * Canonical normalizer for `scene-engine-animation-resource@2`. `defineAnimation()`,
 * `defineFrameAnimation()` and the ResourceRegistry all share this single path, so a
 * descriptor accepted by a helper can never be rejected by the registry (or vice versa).
 */
export function normalizeAnimationDescriptor(value) {
  const record = exactKeys(value, ['id', 'kind', 'schema', 'durationMs', 'loop', 'tracks'],
    ['revision', 'hash'], RESOURCE_ERROR);
  if (record.kind !== 'animation' || record.schema !== ANIMATION_RESOURCE_SCHEMA) {
    fail(RESOURCE_ERROR);
  }
  const durationMs = finiteNumber(record.durationMs, RESOURCE_ERROR);
  if (durationMs <= 0) fail(RESOURCE_ERROR);
  if (!Array.isArray(record.tracks) || record.tracks.length === 0) fail(RESOURCE_ERROR);
  const tracks = Object.freeze(record.tracks.map((track) => animationTrack(track, durationMs)));
  const outputs = new Set();
  for (const track of tracks) {
    const key = animationOutputKey(track);
    if (outputs.has(key)) fail(TRACK_ERROR);
    outputs.add(key);
  }
  const descriptor = {
    id: nonemptyString(record.id, RESOURCE_ERROR),
    kind: 'animation',
    schema: ANIMATION_RESOURCE_SCHEMA,
    durationMs,
    loop: booleanValue(record.loop, RESOURCE_ERROR),
    tracks,
  };
  if (Object.hasOwn(record, 'revision')) {
    descriptor.revision = safeInteger(record.revision, 'display-resource-revision-invalid',
      { minimum: 0 });
  }
  if (Object.hasOwn(record, 'hash')) {
    if (typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.hash)) {
      fail('display-resource-hash-invalid');
    }
    descriptor.hash = record.hash;
  }
  return deepFreeze(descriptor);
}

/**
 * Low-level helper: build one canonical animation resource from explicit tracks.
 *
 * ```js
 * defineAnimation({
 *   id: 'anim.unit.fire',
 *   durationMs: 240,
 *   loop: false,
 *   tracks: [{ channel: 'sprite.frame', target: { node: 'body', component: 'sprite' },
 *     interpolation: 'step', keyframes: [{ atMs: 0, value: 4 }] }],
 * })
 * ```
 */
export function defineAnimation(value) {
  const record = exactKeys(value, ['id', 'durationMs', 'loop', 'tracks'], ['revision', 'hash'],
    'display-animation-definition-invalid');
  return normalizeAnimationDescriptor({ ...record, kind: 'animation', schema: ANIMATION_RESOURCE_SCHEMA });
}

/**
 * Agent-facing helper for uniform frame replacement timelines.
 *
 * ```js
 * defineFrameAnimation({
 *   id: 'anim.unit.walk',
 *   target: { node: 'body', component: 'sprite' },
 *   frames: [0, 1, 2, 1],
 *   fps: 10,
 *   loop: true,
 * })
 * ```
 */
export function defineFrameAnimation(value) {
  const record = exactKeys(value, ['id', 'target', 'frames', 'fps', 'loop'], ['revision', 'hash'],
    'display-animation-definition-invalid');
  if (!Array.isArray(record.frames) || record.frames.length === 0) {
    fail('display-animation-definition-invalid');
  }
  const frames = record.frames.map(
    (frame) => safeInteger(frame, 'display-animation-definition-invalid', { minimum: 0 }),
  );
  const fps = finiteNumber(record.fps, 'display-animation-definition-invalid');
  if (fps <= 0) fail('display-animation-definition-invalid');
  const frameMs = 1000 / fps;
  const descriptor = {
    id: record.id,
    kind: 'animation',
    schema: ANIMATION_RESOURCE_SCHEMA,
    durationMs: frames.length * frameMs,
    loop: booleanValue(record.loop, 'display-animation-definition-invalid'),
    tracks: [Object.freeze({
      channel: 'sprite.frame',
      target: cloneAndFreeze(plainRecord(record.target, 'display-animation-definition-invalid')),
      interpolation: 'step',
      keyframes: Object.freeze(frames.map((frame, index) => Object.freeze({
        atMs: index * frameMs,
        value: frame,
      }))),
    })],
  };
  if (Object.hasOwn(record, 'revision')) descriptor.revision = record.revision;
  if (Object.hasOwn(record, 'hash')) descriptor.hash = record.hash;
  return normalizeAnimationDescriptor(descriptor);
}
