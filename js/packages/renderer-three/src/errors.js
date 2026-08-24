export class ThreeRenderRuntimeError extends Error {
  constructor(code, message = code, options = undefined) {
    super(message, options);
    this.name = 'ThreeRenderRuntimeError';
    this.code = code;
  }
}

export function fail(code, message = code, options = undefined) {
  throw new ThreeRenderRuntimeError(code, message, options);
}
