import { cloneAndFreeze, enumValue } from '../internal.js';
import { assertPrefabId } from '../resource/prefab-definition.js';
import { Component } from './component.js';

/** Package-private marker for one Python-owned authority root. */
export class AuthorityComponent extends Component {
  static typeId = 'engine.authority@1';
  static allowMultiple = false;

  constructor({ key = 'authority', prefabId, transformMode, state = {} }) {
    super({ key, enabled: true, properties: {} });
    this._prefabId = assertPrefabId(prefabId);
    this._transformMode = enumValue(transformMode, ['initial', 'live'],
      'display-authority-transform-mode-invalid');
    this._state = cloneAndFreeze(state, 'display-authority-state-invalid');
  }

  get prefabId() { return this._prefabId; }
  get transformMode() { return this._transformMode; }
  get state() { return this._state; }
  get drivesTransform() { return this._transformMode === 'live'; }

  _setState(state) { this._state = cloneAndFreeze(state, 'display-authority-state-invalid'); }
  _setPrefab(prefabId, state) {
    this._prefabId = assertPrefabId(prefabId);
    this._state = cloneAndFreeze(state, 'display-authority-state-invalid');
  }
}
