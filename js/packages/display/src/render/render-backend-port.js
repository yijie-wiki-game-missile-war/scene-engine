import { fail } from '../runtime/health.js';

const REQUIRED_METHODS = Object.freeze([
  'createBinding',
  'updateBinding',
  'destroyBinding',
  'prepareFrame',
  'render',
  'requestResize',
  'pick',
  'projectWorldPoint',
  'focusWorldPoint',
  'capture',
  'whenIdle',
  'diagnostics',
  'dispose',
]);

export function assertRenderBackendPort(backend) {
  if (backend === null || typeof backend !== 'object') fail('display-render-backend-invalid');
  for (const method of REQUIRED_METHODS) {
    if (typeof backend[method] !== 'function') fail('display-render-backend-invalid');
  }
  return backend;
}

export function bindingIdentity(nodeName, componentKey) {
  return Object.freeze({ nodeName, componentKey });
}
