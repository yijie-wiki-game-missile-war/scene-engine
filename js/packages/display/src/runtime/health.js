export class DisplayRuntimeError extends Error {
  constructor(code, message = code, options = undefined) {
    super(message, options);
    this.name = 'DisplayRuntimeError';
    this.code = code;
  }
}

export function fail(code, message = code, options = undefined) {
  throw new DisplayRuntimeError(code, message, options);
}

export function healthEvent({ severity = 'error', code, message, nodeName = null,
  componentType = null, componentKey = null, resourceId = null, phase = null,
  recoverable = false, revision, programStage, affectedBindingCount, diagnostic, isolation }) {
  return Object.freeze({
    severity,
    code,
    message,
    nodeName,
    componentType,
    componentKey,
    resourceId,
    phase,
    recoverable,
    ...(programStage ? { revision, programStage, affectedBindingCount, diagnostic } : {}),
    ...(isolation ? { isolation } : {}),
  });
}
