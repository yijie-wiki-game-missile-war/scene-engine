function keyOf(nodeName, componentKey) { return JSON.stringify([nodeName, componentKey]); }

export function createFakeRenderBackend({ asyncCreate = false, asyncDestroy = false,
  requiresContinuousDraw = false, failCreateFor = null, resolveCreateNull = false } = {}) {
  const bindings = new Map();
  const calls = [];
  let disposed = false; let draws = 0; let lastFrame = null;
  const backend = {
    createBinding(descriptor) {
      calls.push(['create', descriptor.nodeName, descriptor.componentKey]);
      if (failCreateFor === keyOf(descriptor.nodeName, descriptor.componentKey)) {
        throw new Error('fake-create-failed');
      }
      const binding = { identity: { nodeName: descriptor.nodeName, componentKey: descriptor.componentKey },
        descriptor, patch: null };
      const install = () => {
        if (descriptor.signal?.aborted) throw new Error('fake-create-aborted');
        if (resolveCreateNull) return null;
        bindings.set(keyOf(descriptor.nodeName, descriptor.componentKey), binding);
        return binding;
      };
      return asyncCreate ? Promise.resolve().then(install) : install();
    },
    updateBinding(binding, patch) { binding.patch = patch; calls.push(['update', binding.identity.nodeName,
      binding.identity.componentKey]); },
    destroyBinding(binding) {
      const destroy = () => {
        if (bindings.get(keyOf(binding.identity.nodeName, binding.identity.componentKey)) === binding) {
          bindings.delete(keyOf(binding.identity.nodeName, binding.identity.componentKey));
        }
        calls.push(['destroy', binding.identity.nodeName, binding.identity.componentKey]);
      };
      return asyncDestroy ? Promise.resolve().then(destroy) : destroy();
    },
    prepareFrame(frame) { lastFrame = frame; calls.push(['prepare', frame.sourceTick]);
      return { requiresContinuousDraw }; },
    render() { draws += 1; calls.push(['render']); },
    requestResize() { calls.push(['resize']); },
    pick() { return null; },
    projectWorldPoint({ position }) { return { x: position[0], y: position[1], visible: true }; },
    focusWorldPoint(target) { calls.push(['focus', target]); },
    capture() { return { bindingCount: bindings.size, draws, disposed }; },
    whenIdle() { return Promise.resolve(); },
    diagnostics() { return { bindingCount: bindings.size, draws }; },
    dispose() { disposed = true; bindings.clear(); calls.push(['dispose']); },
  };
  return { backend, bindings, calls, get draws() { return draws; }, get lastFrame() { return lastFrame; } };
}
