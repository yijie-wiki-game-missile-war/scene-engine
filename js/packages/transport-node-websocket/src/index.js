export class NodeWebSocketTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NodeWebSocketTransportError';
  }
}

export const DEFAULT_NODE_WEBSOCKET_LIMITS = Object.freeze({
  maximumQueuedTransmissions: 1024,
  maximumQueuedBytes: 32 * 1024 * 1024,
  socketWriteDeadlineMs: 10_000,
});

export class NodeWebSocketTransmissionAdapter {
  constructor({
    socket,
    encodeTransmission,
    limits = {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (!socket || typeof socket.write !== 'function' || typeof socket.once !== 'function'
        || typeof socket.off !== 'function') {
      throw new NodeWebSocketTransportError('socket port is invalid');
    }
    if (typeof encodeTransmission !== 'function') {
      throw new NodeWebSocketTransportError('encodeTransmission port is required');
    }
    this.socket = socket;
    this.encodeTransmission = encodeTransmission;
    this.limits = normalizeLimits(limits);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.queue = [];
    this.queuedBytes = 0;
    this.flushing = null;
    this.closed = false;
  }

  async send(transmissions) {
    this.requireOpen();
    if (!Array.isArray(transmissions)) {
      throw new NodeWebSocketTransportError('transmissions must be an array');
    }
    const batch = transmissions.map((transmission) => {
      const bytes = readonlyBytes(this.encodeTransmission(transmission));
      if (bytes.byteLength === 0) {
        throw new NodeWebSocketTransportError('encoded transmission must not be empty');
      }
      return { transmission, bytes };
    });
    const addedBytes = batch.reduce((total, item) => total + item.bytes.byteLength, 0);
    if (this.queue.length + batch.length > this.limits.maximumQueuedTransmissions
        || this.queuedBytes + addedBytes > this.limits.maximumQueuedBytes) {
      throw new NodeWebSocketTransportError('socket write queue is full');
    }
    this.queue.push(...batch);
    this.queuedBytes += addedBytes;
    if (!this.flushing) this.flushing = this.flush();
    try {
      await this.flushing;
    } finally {
      if (this.queue.length === 0) this.flushing = null;
    }
  }

  async flush() {
    while (this.queue.length > 0) {
      this.requireOpen();
      const item = this.queue[0];
      const accepted = this.socket.write(Buffer.from(
        item.bytes.buffer,
        item.bytes.byteOffset,
        item.bytes.byteLength,
      ));
      if (!accepted) await this.waitForDrain();
      this.queue.shift();
      this.queuedBytes -= item.bytes.byteLength;
    }
  }

  async waitForDrain() {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        this.socket.off('drain', onDrain);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onDrain = () => finish();
      const onError = (error) => finish(new NodeWebSocketTransportError(
        `socket write failed: ${error?.message ?? 'unknown error'}`,
      ));
      const onClose = () => finish(new NodeWebSocketTransportError('socket closed before drain'));
      const timer = this.setTimer(
        () => finish(new NodeWebSocketTransportError('socket write timed out')),
        this.limits.socketWriteDeadlineMs,
      );
      this.socket.once('drain', onDrain);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
    });
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (typeof this.socket.destroy === 'function' && !this.socket.destroyed) {
      this.socket.destroy(new NodeWebSocketTransportError(reason));
    }
  }

  status() {
    return Object.freeze({
      closed: this.closed,
      queuedBytes: this.queuedBytes,
      queuedTransmissions: this.queue.length,
      waitingForDrain: Boolean(this.flushing && this.queue.length > 0),
    });
  }

  requireOpen() {
    if (this.closed) throw new NodeWebSocketTransportError('socket adapter is closed');
  }
}

function normalizeLimits(changes) {
  const limits = { ...DEFAULT_NODE_WEBSOCKET_LIMITS, ...changes };
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new NodeWebSocketTransportError(`${field} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function readonlyBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new NodeWebSocketTransportError('encoded transmission must be bytes');
}
