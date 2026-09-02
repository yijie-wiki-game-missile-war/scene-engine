const RUNTIME_LISTENERS = new WeakMap();

export function registerInteractionRuntimeLifecycle(runtime, listener) {
  let listeners = RUNTIME_LISTENERS.get(runtime);
  if (listeners === undefined) {
    listeners = new Set();
    RUNTIME_LISTENERS.set(runtime, listeners);
  }
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
    if (listeners.size === 0) RUNTIME_LISTENERS.delete(runtime);
  };
}

export function notifyInteractionRuntimeLifecycle(runtime, event) {
  const listeners = RUNTIME_LISTENERS.get(runtime);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* interaction observers are isolated */ }
  }
}
