import { assertSynchronous, cloneAndFreeze, nonemptyString } from '../internal.js';
import { fail } from '../runtime/health.js';

export class Component {
  static typeId = null;
  static allowMultiple = false;
  static tickPhase = null;
  static drivesTransform = false;

  constructor({ key, enabled = true, properties = {} }) {
    this._key = nonemptyString(key, 'display-component-key-invalid');
    if (typeof enabled !== 'boolean') fail('display-component-enabled-invalid');
    this._enabled = enabled;
    this._properties = cloneAndFreeze(properties, 'display-component-properties-invalid');
    this._node = null;
    this._context = null;
    this._attached = false;
    this._attachAttempted = false;
    this._disposed = false;
    this._normalizer = null;
  }

  get key() { return this._key; }
  get node() { return this._node; }
  get enabled() { return this._enabled; }
  get disposed() { return this._disposed; }
  get properties() { return this._properties; }
  get drivesTransform() { return this.constructor.drivesTransform; }

  attach(node, context) {
    if (this._disposed) fail('display-component-disposed');
    if (this._attachAttempted || this._attached || this._node !== null) {
      fail('display-component-already-attached');
    }
    if (!node || !context) fail('display-component-attach-invalid');
    this._node = node;
    this._context = context;
    this._attachAttempted = true;
    let hookStarted = false;
    try {
      hookStarted = true;
      assertSynchronous(this.onAttach?.(context), 'display-component-async-handler');
      this._attached = true;
      context.componentAttached?.(this);
    } catch (error) {
      if (this._attached) {
        try { context.componentDetaching?.(this); } catch { /* preserve the attach error */ }
      }
      if (hookStarted) {
        try {
          assertSynchronous(this.onDispose?.(context, 'attach-rollback'),
            'display-component-async-handler');
        } catch { /* preserve the attach error */ }
      }
      this._attached = false;
      this._node = null;
      this._context = null;
      throw error;
    }
    return this;
  }

  setEnabled(enabled) {
    if (this._disposed) fail('display-component-disposed');
    if (typeof enabled !== 'boolean') fail('display-component-enabled-invalid');
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    if (this._attached) this._context.componentEnabledChanged?.(this);
  }

  patchProperties(patch) {
    if (this._disposed) fail('display-component-disposed');
    if (typeof this._normalizer !== 'function') fail('display-component-properties-readonly');
    const candidate = { ...this._properties, ...patch };
    const normalized = this._normalizer(candidate);
    this._properties = cloneAndFreeze(normalized, 'display-component-properties-invalid');
    if (this._attached) this._context.componentPropertiesChanged?.(this);
  }

  dispose(reason = 'disposed') {
    if (this._disposed) return Object.freeze([]);
    const errors = [];
    if (this._attached) {
      try { this._context.componentDetaching?.(this); } catch (error) { errors.push(error); }
      try {
        assertSynchronous(
          this.onDispose?.(this._context, reason),
          'display-component-async-handler',
        );
      } catch (error) { errors.push(error); }
    }
    this._attached = false;
    this._disposed = true;
    this._context = null;
    this._node = null;
    return Object.freeze(errors);
  }

  _setNormalizer(normalizer) { this._normalizer = normalizer; }
  _replaceNormalizedProperties(properties) {
    this._properties = properties;
    if (this._attached) this._context.componentPropertiesChanged?.(this);
  }
  _adoptContext(context) {
    if (!this._attached || this._disposed) fail('display-component-adopt-state-invalid');
    this._context = context;
    context.componentAttached?.(this);
  }
}
