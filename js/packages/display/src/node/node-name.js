import { nonemptyString } from '../internal.js';
import { fail } from '../runtime/health.js';

export const NODE_PREFIXES = Object.freeze(['sys', 'scene', 'py', 'prefab']);
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_BYTES = 192;

export function parseNodeName(value) {
  const name = nonemptyString(value, 'display-node-name-invalid');
  if (new TextEncoder().encode(name).length > MAX_BYTES || name.includes('\\')) {
    fail('display-node-name-invalid');
  }
  const segments = name.split('/');
  if (segments.length < 2 || !NODE_PREFIXES.includes(segments[0])
      || segments.some((entry) => !SEGMENT.test(entry) || entry === '..')) {
    fail('display-node-name-invalid');
  }
  return Object.freeze({ name, prefix: segments[0], segments: Object.freeze(segments.slice(1)) });
}

export function assertNodeName(value) {
  return parseNodeName(value).name;
}

export function assertNodePrefix(value, prefix) {
  if (!NODE_PREFIXES.includes(prefix)) fail('display-node-prefix-invalid');
  const parsed = parseNodeName(value);
  if (parsed.prefix !== prefix) fail('display-node-prefix-invalid');
  return parsed.name;
}

export function assertLocalPath(value, code = 'display-local-name-invalid') {
  const path = nonemptyString(value, code);
  const segments = path.split('/');
  if (segments.some((entry) => !SEGMENT.test(entry) || entry === '..')) fail(code);
  return path;
}

export function joinSceneNodeName(sceneId, localPath) {
  const scene = assertLocalPath(sceneId, 'display-scene-id-invalid');
  const local = assertLocalPath(localPath);
  return assertNodeName(`scene/${scene}/${local}`);
}

export function joinPrefabNodeName(ownerName, localPath) {
  const owner = assertNodeName(ownerName);
  if (owner.startsWith('prefab/')) fail('display-prefab-owner-invalid');
  const local = assertLocalPath(localPath);
  return assertNodeName(`prefab/${owner}/${local}`);
}
