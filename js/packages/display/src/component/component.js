import { assertSynchronous, cloneAndFreeze, nonemptyString } from '../internal.js';
import { fail } from '../runtime/health.js';

const COMPONENT_MUTATION_TOKEN = Object.freeze({});
const REPLACE_PROPERTIES = Symbol('scene-engine.component.replace-properties');
const ATTACHMENTS = new WeakMap();

// Package-private helpers. The package root does not export these capabilities.
export function attachedComponentNode(component) {
  return ATTACHMENTS.get(component)?.node ?? null;
}

// Package-private: the mutation token and symbol are intentionally not exported. The
// ComponentRegistry is the only public object that can reach this operation.
export function replaceComponentProperties(component, properties) {
  if (!(component instanceof Component)) fail('display-component-invalid');
  return component[REPLACE_PROPERTIES](COMPONENT_MUTATION_TOKEN, properties);
}

export class Component {
  #properties;

  static typeId = null;
  static allowMultiple = false;
  static tickPhase = null;
  static drivesTransform = false;

  constructor({ key, enabled = true, properties = {} }) {
    this._key = nonemptyString(key, 'display-component-key-invalid');
    if (typeof enabled !== 'boolean') fail('display-component-enabled-invalid');
    this._enabled = enabled;
    this.#properties = cloneAndFreeze(properties, 'display-component-properties-invalid');
    this._attached = false;
    this._attachAttempted = false;
    this._disposed = false;
  }

  get key() { return this._key; }
  get node() { return ATTACHMENTS.get(this)?.view ?? null; }
  get enabled() { return this._enabled; }
  get disposed() { return this._disposed; }
  get properties() { return this.#properties; }
  get drivesTransform() { return this.constructor.drivesTransform; }

  attach(node, context) {
    if (this._disposed) fail('display-component-disposed');
    if (this._attachAttempted || this._attached || ATTACHMENTS.has(this)) {
      fail('display-component-already-attached');
    }
    if (!node || !context || typeof context.nodeViewFor !== 'function'
        || !context.publicDisplay) fail('display-component-attach-invalid');
    const attachment = { node, context, view: context.nodeViewFor(node) };
    ATTACHMENTS.set(this, attachment);
    this._attachAttempted = true;
    let hookStarted = false;
    try {
      hookStarted = true;
      assertSynchronous(this.onAttach?.(context.publicDisplay), 'display-component-async-handler');
      this._attached = true;
      context.componentAttached?.(this);
    } catch (error) {
      if (this._attached) {
        try { context.componentDetaching?.(this); } catch { /* preserve the attach error */ }
      }
      if (hookStarted) {
        try {
          assertSynchronous(this.onDispose?.(context.publicDisplay, 'attach-rollback'),
            'display-component-async-handler');
        } catch { /* preserve the attach error */ }
      }
      this._attached = false;
      ATTACHMENTS.delete(this);
      throw error;
    }
    return this;
  }

  setEnabled(enabled) {
    if (this._disposed) fail('display-component-disposed');
    if (typeof enabled !== 'boolean') fail('display-component-enabled-invalid');
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    const attachment = ATTACHMENTS.get(this);
    if (this._attached) attachment.context.componentEnabledChanged?.(this);
  }

  /**
   * Change only this component's own Node transform. The capability exists only for
   * components whose class declares drivesTransform=true and never applies to py/ roots.
   */
  setDrivenLocalTransform(transform) {
    if (this._disposed) fail('display-component-disposed');
    const attachment = ATTACHMENTS.get(this);
    // The attachment exists during onAttach, before scheduler registration completes.
    if (!attachment) fail('display-component-not-attached');
    attachment.context.setDrivenLocalTransform(this, attachment.node, transform);
  }

  dispose(reason = 'disposed') {
    if (this._disposed) return Object.freeze([]);
    const errors = [];
    const attachment = ATTACHMENTS.get(this) ?? null;
    if (this._attached && attachment !== null) {
      try { attachment.context.componentDetaching?.(this); } catch (error) { errors.push(error); }
      try {
        assertSynchronous(
          this.onDispose?.(attachment.context.publicDisplay, reason),
          'display-component-async-handler',
        );
      } catch (error) { errors.push(error); }
    }
    this._attached = false;
    this._disposed = true;
    ATTACHMENTS.delete(this);
    return Object.freeze(errors);
  }

  [REPLACE_PROPERTIES](token, properties) {
    if (token !== COMPONENT_MUTATION_TOKEN) fail('display-component-properties-readonly');
    if (this._disposed) fail('display-component-disposed');
    const previous = this.#properties;
    this.#properties = properties;
    const attachment = ATTACHMENTS.get(this);
    try {
      if (this._attached) attachment.context.componentPropertiesChanged?.(this);
    } catch (error) {
      this.#properties = previous;
      throw error;
    }
    return this.#properties;
  }

  _adoptContext(context) {
    const attachment = ATTACHMENTS.get(this);
    if (!this._attached || this._disposed || !attachment
        || typeof context.nodeViewFor !== 'function' || !context.publicDisplay) {
      fail('display-component-adopt-state-invalid');
    }
    attachment.context = context;
    attachment.view = context.nodeViewFor(attachment.node);
    context.componentAttached?.(this);
  }
}
