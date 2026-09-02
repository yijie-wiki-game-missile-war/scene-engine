import { cloneAndFreeze, enumValue } from '../internal.js';
import { assertDisplayKindId } from '../resource/display-kind-definition.js';
import { assertPrefabId } from '../resource/prefab-definition.js';
import { Component } from './component.js';

/** Package-private marker for one Python-owned authority root. */
export class AuthorityComponent extends Component {
  static typeId = 'engine.authority@1';
  static allowMultiple = false;

  constructor({ key = 'authority', displayKindId, prefabId = null, transformMode, state = {} }) {
    super({ key, enabled: true, properties: {} });
    this._displayKindId = assertDisplayKindId(displayKindId);
    this._prefabId = prefabId === null ? null : assertPrefabId(prefabId);
    this._transformMode = enumValue(transformMode, ['initial', 'live'],
      'display-authority-transform-mode-invalid');
    this._state = cloneAndFreeze(state, 'display-authority-state-invalid');
  }

  get displayKindId() { return this._displayKindId; }
  get prefabId() { return this._prefabId; }
  get transformMode() { return this._transformMode; }
  get state() { return this._state; }
  get drivesTransform() { return this._transformMode === 'live'; }

  _setState(state, prefabId = this._prefabId) {
    this._prefabId = prefabId === null ? null : assertPrefabId(prefabId);
    this._state = cloneAndFreeze(state, 'display-authority-state-invalid');
  }
  _setDisplayKind(displayKindId, prefabId, state) {
    this._displayKindId = assertDisplayKindId(displayKindId);
    this._setState(state, prefabId);
  }
}
