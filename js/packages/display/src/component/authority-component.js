import { cloneAndFreeze, enumValue, nonemptyString } from '../internal.js';
import { Component } from './component.js';

export class AuthorityComponent extends Component {
  static typeId = 'engine.authority@1';

  constructor({ key = 'authority', prefabType, transformMode, state = {} }) {
    super({ key, enabled: true, properties: {} });
    this._prefabType = nonemptyString(prefabType, 'display-prefab-type-invalid');
    this._transformMode = enumValue(
      transformMode,
      ['initial', 'live'],
      'display-authority-transform-mode-invalid',
    );
    this._state = cloneAndFreeze(state, 'display-authority-state-invalid');
  }

  get prefabType() { return this._prefabType; }
  get transformMode() { return this._transformMode; }
  get state() { return this._state; }
  get drivesTransform() { return this._transformMode === 'live'; }

  applyTransform(command) {
    return this._context.authority.setNodeTransform({ ...command, name: this.node.name });
  }
  applyParent(command) {
    return this._context.authority.setNodeParent({ ...command, name: this.node.name });
  }
  applyVisible(command) {
    return this._context.authority.setNodeVisible({ ...command, name: this.node.name });
  }
  applyState(command) {
    return this._context.authority.setNodeState({ ...command, name: this.node.name });
  }
  replacePrefab(command) {
    return this._context.authority.replaceNodePrefab({ ...command, name: this.node.name });
  }

  _setState(state) { this._state = cloneAndFreeze(state, 'display-authority-state-invalid'); }
  _setPrefab(prefabType, state) {
    this._prefabType = nonemptyString(prefabType, 'display-prefab-type-invalid');
    this._setState(state);
  }
}
