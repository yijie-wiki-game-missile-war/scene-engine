import {
  exactKeys,
  finiteNumber,
  nonemptyString,
  tuple,
} from '../internal.js';
import { attachedComponentNode } from '../component/component.js';
import { fail } from '../runtime/health.js';
import { PointerTargetComponent } from './pointer-target-component.js';

const RESULT_IDENTITIES = new WeakMap();

function normalizedPickHit(value) {
  const hit = exactKeys(
    value,
    ['nodeName', 'componentKey', 'point', 'distance'],
    [],
    'display-interaction-hit-invalid',
  );
  const distance = finiteNumber(hit.distance, 'display-interaction-hit-invalid');
  if (distance < 0) fail('display-interaction-hit-invalid');
  return Object.freeze({
    nodeName: nonemptyString(hit.nodeName, 'display-interaction-hit-invalid'),
    componentKey: nonemptyString(hit.componentKey, 'display-interaction-hit-invalid'),
    point: Object.freeze(tuple(hit.point, 3, 'display-interaction-hit-invalid')),
    distance,
  });
}

function normalizedProximityHit(value, radiusPixels) {
  const hit = exactKeys(
    value,
    ['nodeName', 'componentKey', 'screenDistancePixels', 'depth'],
    [],
    'display-interaction-proximity-hit-invalid',
  );
  const screenDistancePixels = finiteNumber(
    hit.screenDistancePixels,
    'display-interaction-proximity-hit-invalid',
  );
  if (screenDistancePixels < 0 || screenDistancePixels > radiusPixels) {
    fail('display-interaction-proximity-hit-invalid');
  }
  return Object.freeze({
    nodeName: nonemptyString(hit.nodeName, 'display-interaction-proximity-hit-invalid'),
    componentKey: nonemptyString(hit.componentKey, 'display-interaction-proximity-hit-invalid'),
    screenDistancePixels,
    depth: finiteNumber(hit.depth, 'display-interaction-proximity-hit-invalid'),
  });
}

function findTarget(nodeIndex, nodeName) {
  let node = nodeIndex.get(nodeName);
  while (node !== null) {
    const component = node.getComponent(PointerTargetComponent);
    if (component !== null && component.enabled && !component.disposed) {
      return { node, component };
    }
    node = node.parent;
  }
  return null;
}

function targetSnapshot(node, component) {
  const authorityOwnerName = node._authorityOwnerName;
  return Object.freeze({
    nodeName: node.name,
    authorityOwnerName,
    authorityNodeId: authorityOwnerName === null
      ? null : Number.parseInt(authorityOwnerName.slice('py/'.length), 10),
    roles: component.properties.roles,
    data: component.properties.data,
  });
}

export function resolveInteractionPick(
  runtime,
  nodeIndex,
  rawHit,
  { proximity = false, radiusPixels = 0 } = {},
) {
  if (rawHit === null) return null;
  const hit = proximity
    ? normalizedProximityHit(rawHit, radiusPixels) : normalizedPickHit(rawHit);
  const resolved = findTarget(nodeIndex, hit.nodeName);
  const result = Object.freeze({
    hit,
    target: resolved === null ? null : targetSnapshot(resolved.node, resolved.component),
  });
  if (resolved !== null) {
    RESULT_IDENTITIES.set(result, Object.freeze({
      runtime,
      node: resolved.node,
      component: resolved.component,
      roles: resolved.component.properties.roles,
    }));
  }
  return result;
}

export function interactionTargetIdentity(result) {
  return result === null ? null : RESULT_IDENTITIES.get(result) ?? null;
}

export function interactionTargetIsCurrent(identity, runtime, requiredRoles = identity?.roles ?? []) {
  if (identity === null || identity === undefined || identity.runtime !== runtime) return false;
  const { component, node } = identity;
  if (node.disposed || component.disposed || !component.enabled
      || attachedComponentNode(component) !== node) return false;
  return requiredRoles.every((role) => component.properties.roles.includes(role));
}

export function pointerQuery(value, code = 'display-pointer-query-invalid') {
  const query = exactKeys(value, ['clientX', 'clientY'], [], code);
  return Object.freeze({
    clientX: finiteNumber(query.clientX, code),
    clientY: finiteNumber(query.clientY, code),
  });
}

export function proximityQuery(value) {
  const query = exactKeys(
    value,
    ['clientX', 'clientY', 'radiusPixels'],
    [],
    'display-proximity-query-invalid',
  );
  const radiusPixels = finiteNumber(query.radiusPixels, 'display-proximity-query-invalid');
  if (radiusPixels < 0 || radiusPixels > 256) {
    fail('display-proximity-query-invalid');
  }
  return Object.freeze({
    clientX: finiteNumber(query.clientX, 'display-proximity-query-invalid'),
    clientY: finiteNumber(query.clientY, 'display-proximity-query-invalid'),
    radiusPixels,
  });
}

export function normalizeWorldRay(value) {
  const ray = exactKeys(
    value,
    ['origin', 'direction'],
    [],
    'display-world-ray-invalid',
  );
  const origin = Object.freeze(tuple(ray.origin, 3, 'display-world-ray-invalid'));
  const directionInput = tuple(ray.direction, 3, 'display-world-ray-invalid');
  const length = Math.hypot(...directionInput);
  if (Math.abs(length - 1) > 1e-6) fail('display-world-ray-invalid');
  const direction = Object.freeze(directionInput.map((entry) => entry / length));
  return Object.freeze({ origin, direction });
}
