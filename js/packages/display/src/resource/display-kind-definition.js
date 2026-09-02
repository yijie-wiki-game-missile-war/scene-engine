import {
  assertSynchronous,
  compareUtf8Strings,
  exactKeys,
  safeInteger,
} from '../internal.js';
import { fail } from '../runtime/health.js';
import { assertPrefabId } from './prefab-definition.js';

const ENCODER = new TextEncoder();
const DISPLAY_KIND_ID = /^[a-z0-9][a-z0-9._@-]*(?:\/[a-z0-9][a-z0-9._@-]*)*$/u;
const GAMEPLAY_TYPE = /^[a-z0-9][a-z0-9._-]*$/u;

export function assertDisplayKindId(value) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !DISPLAY_KIND_ID.test(value)) fail('display-kind-id-invalid');
  return value;
}

function assertGameplayType(value) {
  if (typeof value !== 'string' || ENCODER.encode(value).byteLength > 192
      || !GAMEPLAY_TYPE.test(value)) fail('display-kind-gameplay-type-invalid');
  return value;
}

function normalizePrefabIds(value) {
  if (!Array.isArray(value)) fail('display-kind-authority-prefabs-invalid');
  const result = value.map(assertPrefabId).sort(compareUtf8Strings);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] === result[index]) fail('display-kind-authority-prefabs-invalid');
  }
  return Object.freeze(result);
}

export class DisplayKindDefinition {
  constructor(value) {
    const record = exactKeys(value, [
      'id', 'gameplayType', 'revision', 'authorityPrefabIds',
    ], ['defaultPrefabId', 'resolvePrefab'], 'display-kind-definition-invalid');
    const authorityPrefabIds = normalizePrefabIds(record.authorityPrefabIds);
    const hasDefault = Object.hasOwn(record, 'defaultPrefabId');
    const hasResolver = Object.hasOwn(record, 'resolvePrefab');
    if (hasResolver && typeof record.resolvePrefab !== 'function') {
      fail('display-kind-resolver-invalid');
    }
    if (authorityPrefabIds.length === 0) {
      if (hasDefault || hasResolver) fail('display-kind-selection-invalid');
    } else if (hasDefault === hasResolver) {
      // A closed non-empty implementation set has exactly one explicit selection rule.
      fail('display-kind-selection-invalid');
    }
    const defaultPrefabId = hasDefault ? assertPrefabId(record.defaultPrefabId) : null;
    if (defaultPrefabId !== null && !authorityPrefabIds.includes(defaultPrefabId)) {
      fail('display-kind-default-prefab-invalid');
    }
    this._id = assertDisplayKindId(record.id);
    this._gameplayType = assertGameplayType(record.gameplayType);
    this._revision = safeInteger(record.revision, 'display-kind-revision-invalid', { minimum: 0 });
    this._authorityPrefabIds = authorityPrefabIds;
    this._defaultPrefabId = defaultPrefabId;
    this._resolver = hasResolver ? record.resolvePrefab : null;
    this._description = Object.freeze({
      id: this._id,
      gameplayType: this._gameplayType,
      revision: this._revision,
      authorityPrefabIds: this._authorityPrefabIds,
      defaultPrefabId: this._defaultPrefabId,
    });
    Object.freeze(this);
  }

  get id() { return this._id; }
  get gameplayType() { return this._gameplayType; }
  get revision() { return this._revision; }
  get authorityPrefabIds() { return this._authorityPrefabIds; }
  get defaultPrefabId() { return this._defaultPrefabId; }
  describe() { return this._description; }

  resolvePrefab(state) {
    if (this._authorityPrefabIds.length === 0) return null;
    if (this._resolver === null) return this._defaultPrefabId;
    const selected = assertSynchronous(
      this._resolver(state),
      'display-kind-resolver-async',
    );
    return typeof selected === 'string' && this._authorityPrefabIds.includes(selected)
      ? selected : null;
  }
}

export function defineDisplayKind(value) { return new DisplayKindDefinition(value); }
