import { Component } from '../component/component.js';
import {
  cloneAndFreeze,
  exactKeys,
  nonemptyString,
  plainRecord,
  safeInteger,
} from '../internal.js';
import { fail } from '../runtime/health.js';

export const RENDER_COMPOSITION_SCHEMA = 'scene-engine-render-composition@1';
export const RENDER_COMPOSITION_PASS_KINDS = Object.freeze([
  'protected-base',
  'ordinary',
  'foreground',
]);
export const MAXIMUM_COMPOSITION_GROUPS = 30;

function groupId(value, code = 'display-render-composition-group-invalid') {
  return nonemptyString(value, code);
}

export function defineRenderComposition(value) {
  const record = exactKeys(value, [
    'schema', 'id', 'revision', 'defaultGroup', 'groups', 'passes',
  ], [], 'display-render-composition-invalid');
  if (record.schema !== RENDER_COMPOSITION_SCHEMA
      || !Array.isArray(record.groups) || !Array.isArray(record.passes)
      || record.groups.length === 0 || record.groups.length > MAXIMUM_COMPOSITION_GROUPS
      || record.passes.length !== RENDER_COMPOSITION_PASS_KINDS.length) {
    fail('display-render-composition-invalid');
  }
  const groups = record.groups.map((value) => {
    const entry = exactKeys(value, ['id'], [], 'display-render-composition-group-invalid');
    return Object.freeze({ id: groupId(entry.id) });
  });
  const groupIds = new Set(groups.map((entry) => entry.id));
  if (groupIds.size !== groups.length) fail('display-render-composition-group-duplicate');

  const assigned = new Set();
  const passIds = new Set();
  const passes = record.passes.map((value, index) => {
    const entry = exactKeys(value, ['id', 'kind', 'groups'], [],
      'display-render-composition-pass-invalid');
    const id = nonemptyString(entry.id, 'display-render-composition-pass-invalid');
    if (passIds.has(id) || entry.kind !== RENDER_COMPOSITION_PASS_KINDS[index]
        || !Array.isArray(entry.groups) || entry.groups.length === 0) {
      fail('display-render-composition-pass-invalid');
    }
    passIds.add(id);
    const passGroups = entry.groups.map((group) => groupId(group));
    if (new Set(passGroups).size !== passGroups.length) {
      fail('display-render-composition-group-duplicate');
    }
    for (const group of passGroups) {
      if (!groupIds.has(group)) fail('display-render-composition-group-missing');
      if (assigned.has(group)) fail('display-render-composition-group-duplicate');
      assigned.add(group);
    }
    return Object.freeze({ id, kind: entry.kind, groups: Object.freeze(passGroups) });
  });
  if (assigned.size !== groupIds.size) fail('display-render-composition-group-unassigned');
  const defaultGroup = groupId(record.defaultGroup);
  if (!groupIds.has(defaultGroup)) fail('display-render-composition-default-group-invalid');
  return cloneAndFreeze({
    schema: RENDER_COMPOSITION_SCHEMA,
    id: nonemptyString(record.id, 'display-render-composition-id-invalid'),
    revision: safeInteger(record.revision, 'display-render-composition-revision-invalid', {
      minimum: 0,
    }),
    defaultGroup,
    groups,
    passes,
  }, 'display-render-composition-invalid');
}

export function compositionGroupIds(plan) {
  return new Set(plan?.groups.map((entry) => entry.id) ?? []);
}

export class RenderCompositionComponent extends Component {
  static typeId = 'render.composition@1';
  static allowMultiple = false;
}

function normalizeCompositionProperties(value) {
  const record = plainRecord(value, 'display-render-composition-properties-invalid');
  const exact = exactKeys(record, ['group'], [], 'display-render-composition-properties-invalid');
  return Object.freeze({ group: groupId(exact.group) });
}

export const RENDER_COMPOSITION_COMPONENT_DESCRIPTOR = Object.freeze({
  ComponentClass: RenderCompositionComponent,
  normalizeProperties: normalizeCompositionProperties,
});
