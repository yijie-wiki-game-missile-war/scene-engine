export class ThreeRenderBackendError extends Error {
  constructor(code, message = code, options = undefined) {
    super(message, options);
    this.name = 'ThreeRenderBackendError';
    this.code = code;
  }
}

export function fail(code, message = code, options = undefined) {
  throw new ThreeRenderBackendError(code, message, options);
}
