import { exactKeys } from '../internal.js';
import { fail } from './health.js';

// Display owns channel phases; backend rebuilds never recreate this state.
export class VisualTimeChannels {
  constructor(names = []) {
    this.pausedAt = null;
    this.channels = new Map([...new Set(['default', ...names])].map((name) =>
      [name, { origin: 0, phase: 0, rate: 1, paused: false, freezeSeconds: null }]));
  }
  set(name, value, visualSeconds) {
    visualSeconds = this.pausedAt ?? visualSeconds;
    const previous = this.channels.get(name);
    if (!previous) fail('display-visual-time-channel-invalid');
    const control = exactKeys(value, [], ['paused', 'rate', 'freezeSeconds'], 'display-visual-time-invalid');
    const next = { ...previous, ...control };
    if (typeof next.paused !== 'boolean' || typeof next.rate !== 'number'
        || !Number.isFinite(next.rate) || next.rate < 0 || next.rate > 16
        || (next.freezeSeconds !== null && (typeof next.freezeSeconds !== 'number'
          || !Number.isFinite(next.freezeSeconds) || next.freezeSeconds < 0))) fail('display-visual-time-invalid');
    next.phase = this._seconds(previous, visualSeconds);
    next.origin = visualSeconds;
    this.channels.set(name, next);
    return this.snapshot(visualSeconds)[name];
  }
  setPaused(paused, now) {
    if (typeof paused !== 'boolean') fail('display-visual-time-invalid');
    if (paused && this.pausedAt === null) this.pausedAt = now;
    else if (!paused && this.pausedAt !== null) {
      const offset = Math.max(0, now - this.pausedAt);
      for (const control of this.channels.values()) control.origin += offset;
      this.pausedAt = null;
    }
    return this.snapshot(now);
  }
  _seconds(control, now) {
    return control.freezeSeconds ?? (control.phase
      + (control.paused ? 0 : Math.max(0, now - control.origin) * control.rate));
  }
  snapshot(now) {
    now = this.pausedAt ?? now;
    return Object.freeze(Object.fromEntries([...this.channels].map(([name, control]) => [name,
      Object.freeze({ seconds: this._seconds(control, now),
        running: this.pausedAt === null && !control.paused && control.rate > 0 && control.freezeSeconds === null })])));
  }
}
