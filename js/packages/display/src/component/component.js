import { assertSynchronous, cloneAndFreeze, nonemptyString } from '../internal.js';
import { fail } from '../runtime/health.js';
const COMPONENT_MUTATION_TOKEN = Object.freeze({});
const REPLACE_PROPERTIES = Symbol('scene-engine.component.replace-properties');
const ATTACHMENTS = new WeakMap();
const FINAL_INSTANCE_METHODS = Object.freeze([
  'attach',
  'setEnabled',
  'setDrivenLocalTransform',
  'setProgramParameters',
  'setAnimation',
  'playAnimation',
  'stopAnimation',
  'dispose',
]);

function lockFinalInstanceMethods(component) {
  const descriptors = {};
  for (const name of FINAL_INSTANCE_METHODS) {
    descriptors[name] = {
      value: Component.prototype[name],
      writable: false,
      configurable: false,
      enumerable: false,
    };
  }
  Object.defineProperties(component, descriptors);
}

// Package-private helpers. The package root does not export these capabilities.
export function attachedComponentNode(component) {
  return ATTACHMENTS.get(component)?.node ?? null;
}

function requireAttachedComponent(component) {
  if (!(component instanceof Component) || component._disposed) {
    fail('display-component-adopt-state-invalid');
  }
  const attachment = ATTACHMENTS.get(component);
  if (!component._attached || !attachment || !attachment.registered) {
    fail('display-component-adopt-state-invalid');
  }
  return attachment;
}

function requireComponentContext(context) {
  if (!context || typeof context.nodeViewFor !== 'function' || !context.publicDisplay) {
    fail('display-component-adopt-state-invalid');
  }
  return context;
}

/**
 * Package-private, non-virtual context transfer. Prefab shadow adoption must not call
 * a user-overridable method on Component. The returned closure reverses a completed
 * transfer, including live scheduler/player/render registration.
 */
export function adoptComponentContext(component, context) {
  const attachment = requireAttachedComponent(component);
  const next = requireComponentContext(context);
  const previous = Object.freeze({
    context: attachment.context,
    view: attachment.view,
  });
  if (previous.context === next) return () => {};

  try {
    previous.context.componentDetaching?.(component);
  } catch (error) {
    // A registry callback can fail after partially unregistering. Re-advertise the
    // unchanged attachment before exposing the error.
    try {
      previous.context.componentAttached?.(component);
      attachment.registered = true;
    } catch { /* preserve the adoption error */ }
    throw error;
  }
  attachment.registered = false;
  try {
    attachment.context = next;
    attachment.view = next.nodeViewFor(attachment.node);
    next.componentAttached?.(component);
    attachment.registered = true;
  } catch (error) {
    try { next.componentDetaching?.(component); } catch { /* preserve the adoption error */ }
    attachment.context = previous.context;
    attachment.view = previous.view;
    try {
      previous.context.componentAttached?.(component);
      attachment.registered = true;
    } catch { /* preserve the adoption error */ }
    throw error;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    try {
      if (attachment.registered) next.componentDetaching?.(component);
    } finally {
      attachment.context = previous.context;
      attachment.view = previous.view;
      attachment.registered = false;
      previous.context.componentAttached?.(component);
      attachment.registered = true;
    }
  };
}

/** Temporarily remove one attached component from its current live registries. */
export function suspendComponentRegistration(component) {
  const attachment = requireAttachedComponent(component);
  const resumeSuspended = attachment.context.componentSuspending?.(component) ?? null;
  if (resumeSuspended !== null && typeof resumeSuspended !== 'function') {
    fail('display-component-adopt-state-invalid');
  }
  if (resumeSuspended !== null) {
    attachment.registered = false;
    let active = true;
    return () => {
      if (!active) return;
      resumeSuspended();
      attachment.registered = true;
      active = false;
    };
  }
  try {
    attachment.context.componentDetaching?.(component);
  } catch (error) {
    try {
      attachment.context.componentAttached?.(component);
      attachment.registered = true;
    } catch { /* preserve the suspension error */ }
    throw error;
  }
  attachment.registered = false;
  let active = true;
  return () => {
    if (!active) return;
    attachment.context.componentAttached?.(component);
    attachment.registered = true;
    active = false;
  };
}

// Package-private: the mutation token and symbol are intentionally not exported. The
// ComponentRegistry is the only public object that can reach this operation.
export function replaceComponentProperties(component, properties) {
  if (!(component instanceof Component)) fail('display-component-invalid');
  return component[REPLACE_PROPERTIES](COMPONENT_MUTATION_TOKEN, properties);
}

// Transaction-local closure; never enters the public Component capability surface.
export function captureComponentVisualInputs(component) {
  return ATTACHMENTS.get(component)?.context.captureProgramInputs?.(component) ?? null;
}

/** Package-private synchronous event barrier used only by AuthorityPort. */
export function dispatchComponentEvent(component, event) {
  if (!(component instanceof Component) || component._disposed) {
    fail('display-component-invalid');
  }
  const attachment = ATTACHMENTS.get(component);
  if (!component._attached || !attachment || !attachment.registered) {
    fail('display-component-not-attached');
  }
  if (!component._enabled) return;
  if (typeof component.onEvent !== 'function') fail('display-component-event-handler-invalid');
  assertSynchronous(
    component.onEvent(attachment.context.publicDisplay, event),
    'display-component-async-handler',
  );
}

function dispatchAnimationCommand(component, operation, playerKey, animationId = null) {
  if (component._disposed) fail('display-component-disposed');
  nonemptyString(playerKey, 'display-animation-command-invalid');
  if (operation !== 'stop' && animationId === null) {
    fail('display-animation-command-invalid');
  }
  const attachment = ATTACHMENTS.get(component);
  if (!attachment || (!component._attached && !attachment.attachHookActive)) {
    fail('display-component-not-attached');
  }
  const context = attachment.context;
  if (typeof context.setAnimation !== 'function') {
    fail('display-animation-system-unavailable');
  }
  context.setAnimation(component, operation, playerKey, animationId);
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
    // An inherited non-writable method does not stop JavaScript class fields from
    // defining an own property. Lock the final API on every instance so class fields,
    // constructor defineProperty calls and later assignment all fail closed.
    lockFinalInstanceMethods(this);
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
    const attachment = {
      node,
      context,
      view: context.nodeViewFor(node),
      registered: false,
      attachHookActive: false,
    };
    ATTACHMENTS.set(this, attachment);
    this._attachAttempted = true;
    let hookStarted = false;
    try {
      hookStarted = true;
      attachment.attachHookActive = true;
      assertSynchronous(this.onAttach?.(context.publicDisplay), 'display-component-async-handler');
      attachment.attachHookActive = false;
      // A hook may call the public dispose method while attachment is still being
      // staged. Never resurrect that component or register a disposed identity.
      if (this._disposed || ATTACHMENTS.get(this) !== attachment) {
        fail('display-component-disposed');
      }
      this._attached = true;
      context.componentAttached?.(this);
      attachment.registered = true;
    } catch (error) {
      attachment.attachHookActive = false;
      if (this._attached) {
        try { context.componentDetaching?.(this); } catch { /* preserve the attach error */ }
      }
      attachment.registered = false;
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

  setProgramParameters(renderKey, patch) {
    if (this._disposed) fail('display-component-disposed');
    nonemptyString(renderKey, 'display-program-input-invalid');
    const attachment = ATTACHMENTS.get(this);
    if (!this._attached || !attachment?.registered) fail('display-component-not-attached');
    if (typeof attachment.context.setProgramParameters !== 'function') fail('display-program-input-unavailable');
    attachment.context.setProgramParameters(this, renderKey, patch);
  }

  setEnabled(enabled) {
    if (this._disposed) fail('display-component-disposed');
    if (typeof enabled !== 'boolean') fail('display-component-enabled-invalid');
    if (enabled === this._enabled) return;
    const previous = this._enabled;
    this._enabled = enabled;
    const attachment = ATTACHMENTS.get(this);
    try {
      if (this._attached) attachment.context.componentEnabledChanged?.(this);
    } catch (error) {
      this._enabled = previous;
      // Runtime callbacks update scheduler/player/render registration from the
      // component's current value. Replay the prior value as compensation if a
      // callback failed after making a partial external change.
      if (this._attached) {
        try { attachment.context.componentEnabledChanged?.(this); } catch {
          /* preserve the original transition error */
        }
      }
      throw error;
    }
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

  /**
   * Animation operations address an `animation.player@1` on the caller's own node.
   * They validate and enqueue synchronously; the visual start point is resolved by the
   * AnimationSystem on its next sample. Subclasses cannot override these methods.
   */
  setAnimation(playerKey, animationId) {
    dispatchAnimationCommand(this, 'set', playerKey, animationId);
  }

  playAnimation(playerKey, animationId) {
    dispatchAnimationCommand(this, 'play', playerKey, animationId);
  }

  stopAnimation(playerKey) {
    dispatchAnimationCommand(this, 'stop', playerKey);
  }

  dispose(reason = 'disposed') {
    if (this._disposed) return Object.freeze([]);
    const errors = [];
    const attachment = ATTACHMENTS.get(this) ?? null;
    if (this._attached && attachment !== null) {
      if (attachment.registered) {
        try { attachment.context.componentDetaching?.(this); } catch (error) { errors.push(error); }
        attachment.registered = false;
      }
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
    const restoreInputs = captureComponentVisualInputs(this);
    this.#properties = properties;
    const attachment = ATTACHMENTS.get(this);
    try {
      if (this._attached) attachment.context.componentPropertiesChanged?.(this);
    } catch (error) {
      this.#properties = previous;
      restoreInputs?.();
      throw error;
    }
    return this.#properties;
  }

}

// Prevent mutation of the shared fallback methods as well as instance shadowing.
Object.freeze(Component.prototype);
