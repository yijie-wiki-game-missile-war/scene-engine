import { Component } from '../component/component.js';
import {
  cloneAndFreezeJson,
  exactKeys,
  isPlainRecord,
} from '../internal.js';
import { fail } from '../runtime/health.js';

export const POINTER_TARGET_ROLES = Object.freeze([
  'proximity',
  'select',
  'drag-source',
  'drop-surface',
  'drop-target',
]);

const POINTER_TARGET_ROLE_SET = new Set(POINTER_TARGET_ROLES);

export class PointerTargetComponent extends Component {
  static typeId = 'interaction.pointer-target@1';
  static allowMultiple = false;
}

function normalizePointerTargetProperties(value) {
  const record = exactKeys(
    value,
    ['roles', 'data'],
    [],
    'display-pointer-target-properties-invalid',
  );
  if (!Array.isArray(record.roles) || record.roles.length === 0) {
    fail('display-pointer-target-roles-invalid');
  }
  const seen = new Set();
  const roles = record.roles.map((role) => {
    if (typeof role !== 'string' || !POINTER_TARGET_ROLE_SET.has(role) || seen.has(role)) {
      fail('display-pointer-target-roles-invalid');
    }
    seen.add(role);
    return role;
  });
  const data = cloneAndFreezeJson(record.data, 'display-pointer-target-data-invalid');
  if (!isPlainRecord(data)) fail('display-pointer-target-data-invalid');
  return Object.freeze({ roles: Object.freeze(roles), data });
}

export const POINTER_TARGET_COMPONENT_DESCRIPTOR = Object.freeze({
  ComponentClass: PointerTargetComponent,
  normalizeProperties: normalizePointerTargetProperties,
});
