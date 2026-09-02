import {
  cloneAndFreeze,
  exactKeys,
  finiteNumber,
  safeInteger,
} from '../internal.js';
import { DisplayRuntimeError, fail } from '../runtime/health.js';
import {
  interactionTargetIdentity,
  interactionTargetIsCurrent,
} from './interaction-picking.js';
import { registerInteractionRuntimeLifecycle } from './runtime-lifecycle.js';

const DEFAULTS = Object.freeze({
  primaryButton: 0,
  secondaryButton: 2,
  dragThresholdPixels: 4,
  doubleClickIntervalMs: 350,
  doubleClickDistancePixels: 6,
  proximityRadiusPixels: 12,
});

const CALLBACK_NAMES = Object.freeze([
  'onPress',
  'onClick',
  'onContextClick',
  'onDoubleClick',
  'onDragGrab',
  'onDragMove',
  'onDragDrop',
  'onProximityEnter',
  'onProximityMove',
  'onProximityLeave',
  'onCancel',
  'onError',
]);

const OPTION_KEYS = Object.freeze({
  required: Object.freeze(['element', 'runtime', 'claim']),
  optional: Object.freeze([
    ...Object.keys(DEFAULTS),
    ...CALLBACK_NAMES,
  ]),
});

function nonnegativeNumber(value, code, maximum = Number.POSITIVE_INFINITY) {
  const result = finiteNumber(value, code);
  if (result < 0 || result > maximum) fail(code);
  return result;
}

function positiveNumber(value, code) {
  const result = finiteNumber(value, code);
  if (result <= 0) fail(code);
  return result;
}

function eventCoordinate(event, key, fallback = 0) {
  return typeof event?.[key] === 'number' && Number.isFinite(event[key]) ? event[key] : fallback;
}

function eventInteger(event, key, fallback) {
  return Number.isSafeInteger(event?.[key]) ? event[key] : fallback;
}

function eventPointerType(event, fallback = '') {
  return typeof event?.pointerType === 'string' ? event.pointerType : fallback;
}

function eventTime(event) {
  if (typeof event?.timeStamp === 'number' && Number.isFinite(event.timeStamp)) {
    return event.timeStamp;
  }
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now() : Date.now();
}

function targetHasRole(interaction, role) {
  return interaction?.target?.roles?.includes(role) === true;
}

function sameTarget(leftInteraction, rightInteraction, leftIdentity = null, rightIdentity = null) {
  if (leftInteraction?.target === null || leftInteraction?.target === undefined
      || rightInteraction?.target === null || rightInteraction?.target === undefined) return false;
  if (leftIdentity !== null && rightIdentity !== null) {
    return leftIdentity.runtime === rightIdentity.runtime
      && leftIdentity.component === rightIdentity.component;
  }
  return leftInteraction.target.nodeName === rightInteraction.target.nodeName;
}

function callbackError(name) {
  return new DisplayRuntimeError(
    'display-pointer-callback-async',
    `${name} must complete synchronously`,
  );
}

function validateOptions(options) {
  const record = exactKeys(
    options,
    OPTION_KEYS.required,
    OPTION_KEYS.optional,
    'display-pointer-controller-options-invalid',
  );
  const element = record.element;
  if (!element || typeof element.addEventListener !== 'function'
      || typeof element.removeEventListener !== 'function'
      || typeof element.setPointerCapture !== 'function'
      || typeof element.releasePointerCapture !== 'function'
      || typeof record.runtime !== 'function' || typeof record.claim !== 'function') {
    fail('display-pointer-controller-options-invalid');
  }
  const callbacks = {};
  for (const name of CALLBACK_NAMES) {
    const callback = record[name] ?? null;
    if (callback !== null && typeof callback !== 'function') {
      fail('display-pointer-controller-options-invalid');
    }
    callbacks[name] = callback;
  }
  const primaryButton = safeInteger(
    record.primaryButton ?? DEFAULTS.primaryButton,
    'display-pointer-controller-options-invalid',
    { minimum: 0, maximum: 4 },
  );
  const secondaryButton = safeInteger(
    record.secondaryButton ?? DEFAULTS.secondaryButton,
    'display-pointer-controller-options-invalid',
    { minimum: 0, maximum: 4 },
  );
  if (primaryButton === secondaryButton) fail('display-pointer-controller-options-invalid');
  return Object.freeze({
    element,
    runtime: record.runtime,
    claim: record.claim,
    callbacks: Object.freeze(callbacks),
    primaryButton,
    secondaryButton,
    dragThresholdPixels: nonnegativeNumber(
      record.dragThresholdPixels ?? DEFAULTS.dragThresholdPixels,
      'display-pointer-controller-options-invalid',
    ),
    doubleClickIntervalMs: positiveNumber(
      record.doubleClickIntervalMs ?? DEFAULTS.doubleClickIntervalMs,
      'display-pointer-controller-options-invalid',
    ),
    doubleClickDistancePixels: nonnegativeNumber(
      record.doubleClickDistancePixels ?? DEFAULTS.doubleClickDistancePixels,
      'display-pointer-controller-options-invalid',
    ),
    proximityRadiusPixels: nonnegativeNumber(
      record.proximityRadiusPixels ?? DEFAULTS.proximityRadiusPixels,
      'display-pointer-controller-options-invalid',
      256,
    ),
  });
}

class PointerInteractionControllerImplementation {
  constructor(options) {
    this._element = options.element;
    this._runtimeGetter = options.runtime;
    this._claim = options.claim;
    this._callbacks = options.callbacks;
    this._primaryButton = options.primaryButton;
    this._secondaryButton = options.secondaryButton;
    this._dragThresholdPixels = options.dragThresholdPixels;
    this._doubleClickIntervalMs = options.doubleClickIntervalMs;
    this._doubleClickDistancePixels = options.doubleClickDistancePixels;
    this._proximityRadiusPixels = options.proximityRadiusPixels;
    this._active = null;
    this._proximity = null;
    this._lastClick = null;
    this._runtime = null;
    this._runtimeUsable = false;
    this._unsubscribeRuntime = null;
    this._capturedPointerId = null;
    this._releasingPointerId = null;
    this._pendingContextMenu = null;
    this._contextMenuTimer = null;
    this._targetValidationQueued = false;
    this._targetValidationReason = null;
    this._disposed = false;
    this._elementWasConnected = this._element.isConnected === true;
    this._listenerOptions = Object.freeze({ capture: true, passive: false });
    this._listeners = Object.freeze([
      ['pointerdown', (event) => this._pointerDown(event)],
      ['pointermove', (event) => this._pointerMove(event)],
      ['pointerup', (event) => this._pointerUp(event)],
      ['pointercancel', (event) => this._pointerCancel(event)],
      ['lostpointercapture', (event) => this._lostPointerCapture(event)],
      ['pointerleave', (event) => this._pointerLeave(event)],
      ['contextmenu', (event) => this._contextMenu(event)],
    ]);
    for (const [name, listener] of this._listeners) {
      this._element.addEventListener(name, listener, this._listenerOptions);
    }
    this._mutationObserver = this._createRemovalObserver();
    this._syncRuntime('runtime-replaced');
  }

  get disposed() { return this._disposed; }

  dispose(reason = 'controller-disposed') {
    if (this._disposed) return;
    this._disposed = true;
    for (const [name, listener] of this._listeners) {
      this._element.removeEventListener(name, listener, true);
    }
    this._mutationObserver?.disconnect();
    this._mutationObserver = null;
    this._unsubscribeRuntime?.();
    this._unsubscribeRuntime = null;
    this._cancelGesture(reason);
    this._leaveProximity(reason);
    this._lastClick = null;
    this._clearContextMenuClaim();
    this._runtime = null;
    this._runtimeUsable = false;
    this._element = null;
    this._runtimeGetter = null;
    this._claim = null;
    this._callbacks = null;
  }

  _createRemovalObserver() {
    const document = this._element.ownerDocument ?? null;
    const Observer = document?.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    if (typeof Observer !== 'function' || !document?.documentElement) return null;
    const observer = new Observer(() => {
      if (this._disposed) return;
      if (this._element.isConnected === true) {
        this._elementWasConnected = true;
      } else if (this._elementWasConnected) {
        this.dispose('element-removed');
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return observer;
  }

  _syncRuntime(replacementReason) {
    if (this._disposed) return null;
    let candidate;
    try { candidate = this._runtimeGetter(); } catch (error) {
      this._reportError(error);
      return null;
    }
    if (candidate === this._runtime) return this._runtimeUsable ? candidate : null;
    this._lastClick = null;
    if (this._runtime !== null) {
      this._cancelGesture(replacementReason);
      this._leaveProximity(replacementReason);
    }
    this._unsubscribeRuntime?.();
    this._unsubscribeRuntime = null;
    this._runtime = candidate ?? null;
    this._runtimeUsable = false;
    if (candidate === null || typeof candidate !== 'object'
        || typeof candidate.pickInteraction !== 'function'
        || typeof candidate.pickInteractionProximity !== 'function'
        || typeof candidate.screenPointToWorldRay !== 'function') return null;
    this._runtimeUsable = true;
    this._unsubscribeRuntime = registerInteractionRuntimeLifecycle(
      candidate,
      (event) => this._runtimeLifecycle(candidate, event),
    );
    return candidate;
  }

  _runtimeLifecycle(runtime, event) {
    if (this._disposed || runtime !== this._runtime) return;
    if (event?.kind === 'runtime-disposed') {
      this._lastClick = null;
      this._cancelGesture('runtime-disposed');
      this._leaveProximity('runtime-disposed');
      this._runtimeUsable = false;
      return;
    }
    if (event?.kind === 'backend-rebuild') {
      this._lastClick = null;
      this._cancelGesture('backend-rebuild');
      this._leaveProximity('backend-rebuild');
      this._runtimeUsable = false;
      return;
    }
    if (event?.kind === 'backend-ready') {
      this._runtimeUsable = true;
      return;
    }
    if (event?.kind === 'component-changed') {
      const component = event.component;
      if (this._active?.sourceIdentity?.component === component
          || this._proximity?.identity?.component === component) {
        this._queueTargetValidation(event.reason);
      }
    }
  }

  _queueTargetValidation(reason = 'target-changed') {
    if (this._disposed) return;
    this._targetValidationReason = reason;
    if (this._targetValidationQueued) return;
    this._targetValidationQueued = true;
    queueMicrotask(() => {
      this._targetValidationQueued = false;
      const currentReason = this._targetValidationReason ?? 'target-changed';
      this._targetValidationReason = null;
      if (!this._disposed) this._validateCurrentTargets(currentReason);
    });
  }

  _validateCurrentTargets(reason = 'target-changed') {
    if (this._active !== null && !this._activeSourceIsCurrent()) this._cancelGesture(reason);
    if (this._proximity !== null && this._proximity.identity !== null
        && !interactionTargetIsCurrent(
          this._proximity.identity,
          this._runtime,
          ['proximity'],
        )) this._leaveProximity(reason);
  }

  _activeSourceIsCurrent(requiredRole = null) {
    const active = this._active;
    if (active === null || active.sourceIdentity === null) return active !== null;
    if (!interactionTargetIsCurrent(active.sourceIdentity, this._runtime, [])) return false;
    const roles = active.sourceIdentity.component.properties.roles;
    if (requiredRole !== null) return roles.includes(requiredRole);
    if (active.dragging) return roles.includes('drag-source');
    return (active.canSelect && roles.includes('select'))
      || (active.canDrag && roles.includes('drag-source'));
  }

  _runtimeForEvent() {
    this._validateCurrentTargets();
    return this._syncRuntime('runtime-replaced');
  }

  _query(runtime, event, proximity) {
    const query = {
      clientX: eventCoordinate(event, 'clientX'),
      clientY: eventCoordinate(event, 'clientY'),
    };
    const interaction = proximity
      ? runtime.pickInteractionProximity({ ...query, radiusPixels: this._proximityRadiusPixels })
      : runtime.pickInteraction(query);
    const worldRay = runtime.screenPointToWorldRay(query);
    return Object.freeze({ interaction, worldRay });
  }

  _sample({ phase, event, start, interaction, worldRay, reason = null }) {
    const clientX = eventCoordinate(event, 'clientX', start?.clientX ?? 0);
    const clientY = eventCoordinate(event, 'clientY', start?.clientY ?? 0);
    const startClientX = start?.startClientX ?? start?.clientX ?? clientX;
    const startClientY = start?.startClientY ?? start?.clientY ?? clientY;
    const value = {
      phase,
      pointerId: eventInteger(event, 'pointerId', start?.pointerId ?? 0),
      pointerType: eventPointerType(event, start?.pointerType ?? ''),
      button: eventInteger(event, 'button', start?.button ?? -1),
      buttons: eventInteger(event, 'buttons', start?.buttons ?? 0),
      clientX,
      clientY,
      startClientX,
      startClientY,
      deltaClientX: clientX - startClientX,
      deltaClientY: clientY - startClientY,
      startInteraction: start?.startInteraction ?? start?.currentInteraction ?? interaction,
      currentInteraction: interaction,
      worldRay,
      ...(reason === null ? {} : { reason }),
    };
    return cloneAndFreeze(value, 'display-pointer-sample-invalid');
  }

  _terminalSample(state, phase, reason, event = null) {
    const previous = state.lastSample ?? state.startSample;
    return this._sample({
      phase,
      reason,
      event: event ?? previous,
      start: state.startSample,
      interaction: previous.currentInteraction,
      worldRay: previous.worldRay,
    });
  }

  _pointerDown(event) {
    if (this._disposed || this._active !== null) return;
    const button = eventInteger(event, 'button', -1);
    if (button !== this._primaryButton && button !== this._secondaryButton) return;
    const runtime = this._runtimeForEvent();
    if (runtime === null) return;
    if (this._proximity !== null) this._leaveProximity('press', event);
    let query;
    try { query = this._query(runtime, event, false); } catch (error) {
      this._reportError(error);
      return;
    }
    const canSelect = targetHasRole(query.interaction, 'select');
    const canDrag = button === this._primaryButton
      && targetHasRole(query.interaction, 'drag-source');
    if (!canSelect && !canDrag) return;
    const sample = this._sample({
      phase: 'press',
      event,
      start: null,
      interaction: query.interaction,
      worldRay: query.worldRay,
    });
    let token;
    try {
      token = this._invokeSynchronous('claim', this._claim, [sample]);
      if (token === undefined) {
        throw new DisplayRuntimeError(
          'display-pointer-claim-invalid',
          'claim must return an opaque token or null',
        );
      }
    } catch (error) {
      this._reportError(error);
      return;
    }
    if (token === null) return;
    const identity = interactionTargetIdentity(query.interaction);
    this._active = {
      pointerId: sample.pointerId,
      pointerType: sample.pointerType,
      button,
      token,
      startSample: sample,
      lastSample: sample,
      sourceIdentity: identity,
      canSelect,
      canDrag,
      dragging: false,
    };
    if (button === this._secondaryButton) this._claimContextMenu();
    this._isolate(event);
    try {
      this._element.setPointerCapture(sample.pointerId);
      this._capturedPointerId = sample.pointerId;
    } catch (error) {
      this._cancelGesture('capture-failed', event);
      this._reportError(error);
      return;
    }
    try { this._invokeCallback('onPress', [token, sample]); } catch (error) {
      this._cancelGesture('callback-error', event);
      this._reportError(error);
    }
  }

  _pointerMove(event) {
    if (this._disposed) return;
    if (this._active !== null) {
      if (eventInteger(event, 'pointerId', -1) !== this._active.pointerId) return;
      this._isolate(event);
      const runtime = this._runtimeForEvent();
      if (runtime === null || this._active === null) return;
      let query;
      try { query = this._query(runtime, event, false); } catch (error) {
        this._cancelGesture('query-failed', event);
        this._reportError(error);
        return;
      }
      const active = this._active;
      const distance = Math.hypot(
        eventCoordinate(event, 'clientX') - active.startSample.clientX,
        eventCoordinate(event, 'clientY') - active.startSample.clientY,
      );
      if (!active.dragging && distance > this._dragThresholdPixels) {
        if (active.button !== this._primaryButton || !active.canDrag
            || !this._activeSourceIsCurrent('drag-source')) {
          active.lastSample = this._sample({
            phase: 'press', event, start: active.startSample,
            interaction: query.interaction, worldRay: query.worldRay,
          });
          this._cancelGesture('movement-threshold', event);
          return;
        }
        this._lastClick = null;
        active.dragging = true;
        const sample = this._sample({
          phase: 'drag-grab', event, start: active.startSample,
          interaction: query.interaction, worldRay: query.worldRay,
        });
        active.lastSample = sample;
        try { this._invokeCallback('onDragGrab', [active.token, sample]); } catch (error) {
          this._cancelGesture('callback-error', event);
          this._reportError(error);
        }
        return;
      }
      const sample = this._sample({
        phase: active.dragging ? 'drag-move' : 'press',
        event,
        start: active.startSample,
        interaction: query.interaction,
        worldRay: query.worldRay,
      });
      active.lastSample = sample;
      if (!active.dragging) return;
      try { this._invokeCallback('onDragMove', [active.token, sample]); } catch (error) {
        this._cancelGesture('callback-error', event);
        this._reportError(error);
      }
      return;
    }
    const pointerType = eventPointerType(event);
    if ((pointerType !== 'mouse' && pointerType !== 'pen')
        || eventInteger(event, 'buttons', 0) !== 0) return;
    const runtime = this._runtimeForEvent();
    if (runtime === null) return;
    let query;
    try { query = this._query(runtime, event, true); } catch (error) {
      this._leaveProximity('query-failed', event);
      this._reportError(error);
      return;
    }
    this._updateProximity(event, query.interaction, query.worldRay);
  }

  _pointerUp(event) {
    if (this._disposed || this._active === null
        || eventInteger(event, 'pointerId', -1) !== this._active.pointerId) return;
    this._isolate(event);
    const runtime = this._runtimeForEvent();
    if (runtime === null || this._active === null) return;
    let query;
    try { query = this._query(runtime, event, false); } catch (error) {
      this._cancelGesture('query-failed', event);
      this._reportError(error);
      return;
    }
    const active = this._active;
    const distance = Math.hypot(
      eventCoordinate(event, 'clientX') - active.startSample.clientX,
      eventCoordinate(event, 'clientY') - active.startSample.clientY,
    );
    if (active.dragging) {
      if (!this._activeSourceIsCurrent('drag-source')) {
        this._cancelGesture('target-role-removed', event);
        return;
      }
      const sample = this._sample({
        phase: 'drag-drop', event, start: active.startSample,
        interaction: query.interaction, worldRay: query.worldRay,
      });
      active.lastSample = sample;
      try { this._invokeCallback('onDragDrop', [active.token, sample]); } catch (error) {
        this._cancelGesture('callback-error', event);
        this._reportError(error);
        return;
      }
      this._finishGesture();
      return;
    }
    if (distance > this._dragThresholdPixels || !active.canSelect) {
      active.lastSample = this._sample({
        phase: 'press', event, start: active.startSample,
        interaction: query.interaction, worldRay: query.worldRay,
      });
      this._cancelGesture(distance > this._dragThresholdPixels
        ? 'movement-threshold' : 'released-without-action', event);
      return;
    }
    if (!this._activeSourceIsCurrent('select') || !sameTarget(
      active.startSample.startInteraction,
      query.interaction,
      active.sourceIdentity,
      interactionTargetIdentity(query.interaction),
    )) {
      active.lastSample = this._sample({
        phase: 'press', event, start: active.startSample,
        interaction: query.interaction, worldRay: query.worldRay,
      });
      this._cancelGesture(!this._activeSourceIsCurrent('select')
        ? 'target-role-removed' : 'target-mismatch', event);
      return;
    }
    const phase = active.button === this._secondaryButton ? 'context-click' : 'click';
    const sample = this._sample({
      phase, event, start: active.startSample,
      interaction: query.interaction, worldRay: query.worldRay,
    });
    active.lastSample = sample;
    try {
      if (active.button === this._secondaryButton) {
        this._lastClick = null;
        this._invokeCallback('onContextClick', [active.token, sample]);
        this._completeContextMenuClaim(active, sample, event);
      } else {
        this._invokeCallback('onClick', [active.token, sample]);
        this._dispatchDoubleClick(active, sample, event);
      }
    } catch (error) {
      this._cancelGesture('callback-error', event);
      this._reportError(error);
      return;
    }
    this._finishGesture();
  }

  _dispatchDoubleClick(active, clickSample, event) {
    const identity = active.sourceIdentity;
    const now = eventTime(event);
    const previous = this._lastClick;
    const matches = previous !== null
      && active.button === previous.button
      && active.pointerType === previous.pointerType
      && now >= previous.time
      && now - previous.time <= this._doubleClickIntervalMs
      && Math.hypot(
        clickSample.clientX - previous.clientX,
        clickSample.clientY - previous.clientY,
      ) <= this._doubleClickDistancePixels
      && sameTarget(
        active.startSample.startInteraction,
        previous.interaction,
        identity,
        previous.identity,
      );
    if (!matches) {
      this._lastClick = Object.freeze({
        button: active.button,
        pointerType: active.pointerType,
        time: now,
        clientX: clickSample.clientX,
        clientY: clickSample.clientY,
        interaction: active.startSample.startInteraction,
        identity,
      });
      return;
    }
    this._lastClick = null;
    const sample = cloneAndFreeze(
      { ...clickSample, phase: 'double-click' },
      'display-pointer-sample-invalid',
    );
    active.lastSample = sample;
    this._invokeCallback('onDoubleClick', [active.token, sample]);
  }

  _pointerCancel(event) {
    if (this._disposed) return;
    const pointerId = eventInteger(event, 'pointerId', -1);
    if (this._active !== null && pointerId === this._active.pointerId) {
      this._isolate(event);
      this._cancelGesture('pointer-cancel', event);
    }
    if (this._proximity !== null && pointerId === this._proximity.pointerId) {
      this._leaveProximity('pointer-cancel', event);
    }
  }

  _lostPointerCapture(event) {
    if (this._disposed) return;
    const pointerId = eventInteger(event, 'pointerId', -1);
    if (pointerId === this._releasingPointerId) return;
    if (this._active !== null && pointerId === this._active.pointerId) {
      this._capturedPointerId = null;
      this._cancelGesture('lost-pointer-capture', event);
    }
  }

  _pointerLeave(event) {
    if (this._disposed || this._active !== null || this._proximity === null) return;
    if (eventInteger(event, 'pointerId', this._proximity.pointerId) === this._proximity.pointerId) {
      this._leaveProximity('pointer-leave', event);
    }
  }

  _updateProximity(event, interaction, worldRay) {
    const eligible = targetHasRole(interaction, 'proximity');
    const identity = eligible ? interactionTargetIdentity(interaction) : null;
    if (!eligible) {
      this._leaveProximity('not-proximate', event, interaction, worldRay);
      return;
    }
    const current = this._proximity;
    if (current !== null && sameTarget(
      current.startSample.startInteraction,
      interaction,
      current.identity,
      identity,
    )) {
      const sample = this._sample({
        phase: 'proximity-move', event, start: current.startSample,
        interaction, worldRay,
      });
      current.lastSample = sample;
      current.identity = identity;
      try { this._invokeCallback('onProximityMove', [sample]); } catch (error) {
        this._leaveProximity('callback-error', event);
        this._reportError(error);
      }
      return;
    }
    if (current !== null) this._leaveProximity('target-changed', event, interaction, worldRay);
    const sample = this._sample({
      phase: 'proximity-enter', event, start: null, interaction, worldRay,
    });
    this._proximity = {
      pointerId: sample.pointerId,
      identity,
      startSample: sample,
      lastSample: sample,
    };
    try { this._invokeCallback('onProximityEnter', [sample]); } catch (error) {
      this._leaveProximity('callback-error', event);
      this._reportError(error);
    }
  }

  _leaveProximity(reason, event = null, interaction = undefined, worldRay = undefined) {
    const current = this._proximity;
    if (current === null) return;
    this._proximity = null;
    const previous = current.lastSample;
    const sample = this._sample({
      phase: 'proximity-leave',
      reason,
      event: event ?? previous,
      start: current.startSample,
      interaction: interaction === undefined ? previous.currentInteraction : interaction,
      worldRay: worldRay === undefined ? previous.worldRay : worldRay,
    });
    try { this._invokeCallback('onProximityLeave', [sample]); } catch (error) {
      this._reportError(error);
    }
  }

  _cancelGesture(reason, event = null) {
    const active = this._active;
    if (active === null) return;
    this._active = null;
    this._lastClick = null;
    if (active.button === this._secondaryButton) this._clearContextMenuClaim();
    const sample = this._terminalSample(active, 'cancel', reason, event);
    this._releaseCapture(active.pointerId);
    try { this._invokeCallback('onCancel', [active.token, sample]); } catch (error) {
      this._reportError(error);
    }
  }

  _finishGesture() {
    const active = this._active;
    if (active === null) return;
    this._active = null;
    this._releaseCapture(active.pointerId);
  }

  _releaseCapture(pointerId) {
    if (this._capturedPointerId !== pointerId || this._element === null) return;
    this._capturedPointerId = null;
    this._releasingPointerId = pointerId;
    try {
      if (typeof this._element.hasPointerCapture !== 'function'
          || this._element.hasPointerCapture(pointerId)) {
        this._element.releasePointerCapture(pointerId);
      }
    } catch (error) {
      this._reportError(error);
    } finally {
      this._releasingPointerId = null;
    }
  }

  _isolate(event) {
    try { event.preventDefault?.(); } catch { /* best effort */ }
    try {
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      else event.stopPropagation?.();
    } catch { /* best effort */ }
  }

  _claimContextMenu() {
    this._clearContextMenuClaim();
  }

  _completeContextMenuClaim(active, sample, event) {
    if (active.contextMenuConsumed === true) return;
    this._clearContextMenuClaim();
    this._pendingContextMenu = Object.freeze({
      clientX: sample.clientX,
      clientY: sample.clientY,
      completedAt: eventTime(event),
      pointerId: active.pointerId,
      pointerType: active.pointerType,
    });
    this._contextMenuTimer = setTimeout(() => this._clearContextMenuClaim(), 1000);
  }

  _clearContextMenuClaim() {
    this._pendingContextMenu = null;
    if (this._contextMenuTimer !== null) clearTimeout(this._contextMenuTimer);
    this._contextMenuTimer = null;
  }

  _contextMenu(event) {
    if (this._disposed) return;
    const activeSecondary = this._active !== null
      && this._active.button === this._secondaryButton;
    if (activeSecondary) {
      if ((Number.isSafeInteger(event?.button) && event.button !== this._secondaryButton)
          || (Number.isSafeInteger(event?.pointerId)
            && event.pointerId !== this._active.pointerId)
          || (typeof event?.pointerType === 'string' && event.pointerType.length > 0
            && event.pointerType !== this._active.pointerType)) return;
      this._active.contextMenuConsumed = true;
      this._isolate(event);
      return;
    }
    const pending = this._pendingContextMenu;
    if (pending === null) return;
    const now = eventTime(event);
    if ((Number.isSafeInteger(event?.button) && event.button !== this._secondaryButton)
        || (Number.isSafeInteger(event?.pointerId) && event.pointerId !== pending.pointerId)
        || (typeof event?.pointerType === 'string' && event.pointerType.length > 0
          && event.pointerType !== pending.pointerType)
        || now < pending.completedAt || now - pending.completedAt > 1000
        || Math.hypot(
          eventCoordinate(event, 'clientX') - pending.clientX,
          eventCoordinate(event, 'clientY') - pending.clientY,
        ) > 1) return;
    this._isolate(event);
    this._clearContextMenuClaim();
  }

  _invokeSynchronous(name, callback, args) {
    const result = callback(...args);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')
        && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      throw callbackError(name);
    }
    return result;
  }

  _invokeCallback(name, args) {
    const callback = this._callbacks?.[name] ?? null;
    if (callback === null) return undefined;
    return this._invokeSynchronous(name, callback, args);
  }

  _reportError(error) {
    const callback = this._callbacks?.onError ?? null;
    if (callback === null) return;
    try { this._invokeSynchronous('onError', callback, [error]); } catch {
      /* onError is the final isolation boundary */
    }
  }
}

export function createPointerInteractionController(options) {
  const implementation = new PointerInteractionControllerImplementation(validateOptions(options));
  return Object.freeze({
    get disposed() { return implementation.disposed; },
    dispose() { implementation.dispose(); },
  });
}
