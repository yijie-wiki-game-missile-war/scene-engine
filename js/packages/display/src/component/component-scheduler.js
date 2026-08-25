import { assertSynchronous } from '../internal.js';
import { fail } from '../runtime/health.js';
import { behaviourHasTick } from './behaviour-component.js';

export class ComponentScheduler {
  constructor({ onError = null } = {}) {
    this._phases = { update: [], 'before-render': [] };
    this._registered = new Set();
    this._onError = onError;
    this._halted = false;
  }

  get halted() { return this._halted; }

  register(component) {
    if (!behaviourHasTick(component)) return;
    const phase = component.constructor.tickPhase;
    if (phase !== 'update' && phase !== 'before-render') fail('display-component-tick-phase-invalid');
    if (this._registered.has(component)) fail('display-component-scheduler-duplicate');
    this._registered.add(component);
    if (component.enabled) this._phases[phase].push(component);
  }

  unregister(component) {
    if (!this._registered.delete(component)) return;
    this._removeFromPhase(component);
  }

  setEnabled(component, enabled) {
    if (!this._registered.has(component)) return;
    this._removeFromPhase(component);
    if (enabled) this._phases[component.constructor.tickPhase].push(component);
  }

  runUpdate(frame) { this._run('update', frame); }
  runBeforeRender(frame) { this._run('before-render', frame); }

  halt() { this._halted = true; }
  reset() { this._halted = false; }
  clear() {
    this._halted = true;
    this._registered.clear();
    this._phases.update.length = 0;
    this._phases['before-render'].length = 0;
  }

  _run(phase, frame) {
    if (this._halted) fail('display-component-scheduler-halted');
    const snapshot = [...this._phases[phase]];
    for (const component of snapshot) {
      if (!this._registered.has(component) || !component.enabled || component.disposed) continue;
      try {
        assertSynchronous(component.tick(frame), 'display-component-async-handler');
      } catch (error) {
        this._halted = true;
        this._onError?.({ error, component, phase });
        throw error;
      }
    }
  }

  _removeFromPhase(component) {
    const phase = component.constructor.tickPhase;
    if (phase !== 'update' && phase !== 'before-render') return;
    const entries = this._phases[phase];
    const index = entries.indexOf(component);
    if (index !== -1) entries.splice(index, 1);
  }
}
