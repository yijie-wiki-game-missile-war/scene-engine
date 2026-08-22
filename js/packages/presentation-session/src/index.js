import {
  PRESENTATION_CONTROL_MAXIMUM_BYTES,
  PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  SCENE_PACKET_HEADER_BYTES,
  cursorEnvelopeFromJSON,
  cursorEnvelopeToJSON,
  parsePresentationControl,
  sha256HexBytes,
} from '@scene-engine/presentation-codec';

export class PresentationSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PresentationSessionError';
  }
}

export class PresentationBackpressureError extends PresentationSessionError {
  constructor(message) {
    super(message);
    this.name = 'PresentationBackpressureError';
  }
}

export const DEFAULT_PRESENTATION_SESSION_LIMITS = Object.freeze({
  maximumInFlightFrames: 8,
  maximumQueuedCorrelations: 256,
  maximumQueuedFrames: 256,
  maximumQueuedBytes: 32 * 1024 * 1024,
  maximumQueuedTickSpan: 600,
  baselineReadyDeadlineMs: 5_000,
  presentationAckDeadlineMs: 10_000,
  // Codec limits describe stored payload bytes after the 24-byte SEDF
  // envelope. Session limits describe the complete wire packet.
  maximumPacketBytes: 8 * 1024 * 1024 + SCENE_PACKET_HEADER_BYTES,
});

export function createPresentationFramePacket({
  frameSeq,
  sourceTick,
  projectionId,
  packet,
}) {
  positiveSafeInteger(frameSeq, 'frameSeq');
  nonnegativeSafeInteger(sourceTick, 'sourceTick');
  positiveSafeInteger(projectionId, 'projectionId');
  const bytes = readonlyBytes(packet, 'frame packet');
  if (bytes.byteLength === 0) throw new PresentationSessionError('frame packet must not be empty');
  return Object.freeze({ frameSeq, sourceTick, projectionId, packet: bytes });
}

export class PresentationResetRequiredError extends PresentationSessionError {
  constructor(message, resetRequired) {
    super(message);
    this.name = 'PresentationResetRequiredError';
    this.resetRequired = resetRequired;
  }
}

export class OrderedPresentationSession {
  constructor({
    bootstrapPacket,
    sceneEpoch,
    bootstrapId,
    viewerScope,
    profileId,
    authorityBaseline,
    limits = {},
    initialCorrelationSeq = 0,
    initialFrameSeq = 0,
  }) {
    this.limits = normalizeLimits(limits);
    const bootstrapByteLength = byteView(bootstrapPacket, 'bootstrap packet').byteLength;
    if (bootstrapByteLength === 0
        || bootstrapByteLength > this.limits.maximumPacketBytes) {
      throw new PresentationSessionError('bootstrap packet byte length is invalid');
    }
    this.bootstrapPacket = readonlyBytes(bootstrapPacket, 'bootstrap packet');
    this.sceneEpoch = positiveSafeInteger(sceneEpoch, 'sceneEpoch');
    this.bootstrapId = positiveSafeInteger(bootstrapId, 'bootstrapId');
    this.viewerScope = canonicalText(viewerScope, 'viewerScope');
    this.profileId = canonicalText(profileId, 'profileId');
    this.authorityBaseline = normalizeCursor(authorityBaseline);
    this.pending = [];
    this.inFlight = [];
    this.queuedFrames = 0;
    this.queuedBytes = 0;
    this.lastAdmittedFrameSeq = nonnegativeSafeInteger(initialFrameSeq, 'initialFrameSeq');
    this.lastAdmittedTick = null;
    this.lastCorrelationSeq = nonnegativeSafeInteger(initialCorrelationSeq, 'initialCorrelationSeq');
    this.lastAckedFrameSeq = initialFrameSeq;
    this.lastAckedCorrelationSeq = initialCorrelationSeq;
    this.lastAckedAuthorityCursor = null;
    this.lastClientSessionSeq = 0;
    this.lastClientMessageBytes = null;
    this.resetRequired = null;
    this.ready = false;
    this.valid = true;
    this.bootstrapOpened = false;
    this.openedAtMs = null;
    this.lastProgressAtMs = null;
  }

  get queuedCorrelations() {
    return this.pending.length + this.inFlight.length;
  }

  openBootstrap({ wallNowMs }) {
    this.requireValid();
    if (this.bootstrapOpened) throw new PresentationSessionError('bootstrap was already opened');
    const now = finiteNow(wallNowMs);
    this.bootstrapOpened = true;
    this.openedAtMs = now;
    this.lastProgressAtMs = now;
    return Object.freeze({ kind: 'bootstrap', data: this.bootstrapPacket });
  }

  admit({ frames, correlation }) {
    this.requireValid();
    if (!frames || typeof frames[Symbol.iterator] !== 'function') {
      throw new PresentationSessionError('frames must be iterable');
    }
    const records = [];
    for (const frame of frames) {
      if (records.length >= this.limits.maximumInFlightFrames) {
        throw new PresentationBackpressureError(
          'correlation frame batch exceeds in-flight credit window',
        );
      }
      const packetLength = byteView(frame?.packet, 'frame packet').byteLength;
      if (packetLength === 0 || packetLength > this.limits.maximumPacketBytes) {
        throw new PresentationSessionError('frame packet exceeds byte limit');
      }
      records.push(createPresentationFramePacket(frame));
    }
    const correlationLength = byteView(correlation, 'correlation').byteLength;
    if (correlationLength === 0 || correlationLength > PRESENTATION_CONTROL_MAXIMUM_BYTES) {
      throw new PresentationSessionError('correlation byte length is invalid');
    }
    const raw = readonlyBytes(correlation, 'correlation');
    const message = parsePresentationControl(raw, {
      direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT,
    });
    this.assertEnvelope(message);
    if (message.type !== 'presentation.correlation') {
      throw new PresentationSessionError('admission requires a correlation');
    }
    const payload = message.payload;
    const correlationSeq = decimalToSafeInteger(payload.correlation_seq, 'correlation_seq');
    if (correlationSeq !== this.lastCorrelationSeq + 1) {
      throw new PresentationSessionError('correlation sequence gap');
    }
    const sourceTick = decimalToSafeInteger(payload.source_tick, 'source_tick', {
      allowZero: true,
    });
    if (this.lastAdmittedTick != null && sourceTick !== this.lastAdmittedTick
        && sourceTick !== this.lastAdmittedTick + 1) {
      throw new PresentationSessionError('source tick gap');
    }
    let previousFrame = this.lastAdmittedFrameSeq;
    for (const record of records) {
      if (record.frameSeq !== previousFrame + 1) {
        throw new PresentationSessionError('frame sequence gap');
      }
      if (record.sourceTick !== sourceTick) {
        throw new PresentationSessionError('correlation source_tick mismatch');
      }
      if (record.projectionId !== decimalToSafeInteger(payload.projection_id, 'projection_id')) {
        throw new PresentationSessionError('correlation projection_id mismatch');
      }
      previousFrame = record.frameSeq;
    }
    if (payload.presentation_required !== (records.length > 0)) {
      throw new PresentationSessionError('presentation_required mismatch');
    }
    if (payload.frame_refs.length !== records.length) {
      throw new PresentationSessionError('correlation frame count mismatch');
    }
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const ref = payload.frame_refs[index];
      if (decimalToSafeInteger(ref.frame_seq, 'frame_seq') !== record.frameSeq) {
        throw new PresentationSessionError('correlation frame sequence mismatch');
      }
      if (ref.sha256 !== sha256HexBytes(record.packet)) {
        throw new PresentationSessionError('correlation frame hash mismatch');
      }
    }
    const addedBytes = raw.byteLength
      + records.reduce((total, record) => total + record.packet.byteLength, 0);
    if (this.queuedCorrelations + 1 > this.limits.maximumQueuedCorrelations
        || this.queuedFrames + records.length > this.limits.maximumQueuedFrames
        || this.queuedBytes + addedBytes > this.limits.maximumQueuedBytes) {
      throw new PresentationBackpressureError('viewer presentation queue is full');
    }
    const oldestTick = this.oldestQueuedTick();
    if (oldestTick != null
        && sourceTick - oldestTick > this.limits.maximumQueuedTickSpan) {
      throw new PresentationBackpressureError(
        'viewer presentation queue exceeds tick-span limit',
      );
    }
    if (previousFrame === 0) {
      throw new PresentationSessionError('first presentation correlation must contain a frame');
    }
    const admission = Object.freeze({
      correlationSeq,
      authorityCursor: cursorEnvelopeFromJSON(payload.authority_cursor),
      frames: Object.freeze(records),
      correlation: raw,
      byteCount: addedBytes,
      cumulativeFrameSeq: previousFrame,
      sourceTick,
    });
    this.pending.push(admission);
    this.queuedFrames += records.length;
    this.queuedBytes += addedBytes;
    this.lastCorrelationSeq = correlationSeq;
    if (records.length > 0) {
      this.lastAdmittedFrameSeq = records.at(-1).frameSeq;
    }
    this.lastAdmittedTick = sourceTick;
  }

  handleClientControl(data, { wallNowMs }) {
    this.requireValid();
    const now = finiteNow(wallNowMs);
    const controlLength = byteView(data, 'control').byteLength;
    if (controlLength === 0 || controlLength > PRESENTATION_CONTROL_MAXIMUM_BYTES) {
      throw new PresentationSessionError('control byte length is invalid');
    }
    const raw = readonlyBytes(data, 'control');
    const message = parsePresentationControl(raw, {
      direction: PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    });
    this.assertEnvelope(message);
    if (this.isDuplicate(message, raw)) return null;
    if (message.type === 'presentation.ready') {
      if (!this.bootstrapOpened) throw new PresentationSessionError('ready arrived before bootstrap');
      if (this.ready) throw new PresentationSessionError('presentation is already ready');
      if (message.payload.profile_id !== this.profileId) {
        throw new PresentationSessionError('ready profile mismatch');
      }
      if (!cursorEquals(
        cursorEnvelopeFromJSON(message.payload.authority_baseline),
        this.authorityBaseline,
      )) {
        throw new PresentationSessionError('ready authority baseline mismatch');
      }
      this.ready = true;
      this.lastAckedAuthorityCursor = this.authorityBaseline;
      this.lastProgressAtMs = now;
      return null;
    }
    if (message.type === 'presentation.resync_request') {
      return this.invalidate('client-resync');
    }
    if (!this.ready) throw new PresentationSessionError('ack arrived before ready');
    this.acknowledge(message, now);
    return null;
  }

  drainSendable({ wallNowMs }) {
    this.requireValid();
    this.checkTimeout({ wallNowMs });
    if (!this.ready) return [];
    const inFlightFrames = this.inFlight.reduce(
      (total, admission) => total + admission.frames.length,
      0,
    );
    let available = this.limits.maximumInFlightFrames - inFlightFrames;
    const transmissions = [];
    const startedAckWindow = this.inFlight.length === 0;
    while (this.pending.length > 0) {
      const candidate = this.pending[0];
      if (candidate.frames.length > available) break;
      this.pending.shift();
      this.inFlight.push(candidate);
      for (const frame of candidate.frames) {
        transmissions.push(Object.freeze({
          kind: 'frame',
          data: frame.packet,
          frameSeq: frame.frameSeq,
        }));
      }
      transmissions.push(Object.freeze({
        kind: 'correlation',
        data: candidate.correlation,
        correlationSeq: candidate.correlationSeq,
      }));
      available -= candidate.frames.length;
    }
    if (startedAckWindow && this.inFlight.length > 0) this.lastProgressAtMs = finiteNow(wallNowMs);
    return transmissions;
  }

  checkTimeout({ wallNowMs }) {
    const now = finiteNow(wallNowMs);
    if (this.bootstrapOpened && !this.ready && this.openedAtMs != null
        && now - this.openedAtMs > this.limits.baselineReadyDeadlineMs) {
      const resetRequired = this.invalidate('ready-timeout');
      throw new PresentationResetRequiredError(
        'presentation ready timed out',
        resetRequired,
      );
    }
    if (this.inFlight.length > 0 && this.lastProgressAtMs != null
        && now - this.lastProgressAtMs > this.limits.presentationAckDeadlineMs) {
      const resetRequired = this.invalidate('ack-timeout');
      throw new PresentationResetRequiredError(
        'presentation acknowledgement timed out',
        resetRequired,
      );
    }
  }

  acknowledge(message, now) {
    const frameSeq = decimalToSafeInteger(message.payload.frame_seq, 'frame_seq');
    const correlationSeq = decimalToSafeInteger(
      message.payload.correlation_seq,
      'correlation_seq',
    );
    if (frameSeq < this.lastAckedFrameSeq || correlationSeq < this.lastAckedCorrelationSeq) {
      throw new PresentationSessionError('cumulative ack moved backwards');
    }
    const target = this.inFlight.find((item) => item.correlationSeq === correlationSeq);
    if (!target || target.cumulativeFrameSeq !== frameSeq) {
      throw new PresentationSessionError('ack exceeds the sent window');
    }
    const cursor = message.payload.authority_cursor == null
      ? null
      : cursorEnvelopeFromJSON(message.payload.authority_cursor);
    if (!cursorEquals(cursor, target.authorityCursor)) {
      throw new PresentationSessionError('ack authority cursor mismatch');
    }
    while (this.inFlight.length > 0
        && this.inFlight[0].correlationSeq <= correlationSeq) {
      const admission = this.inFlight.shift();
      this.queuedFrames -= admission.frames.length;
      this.queuedBytes -= admission.byteCount;
    }
    this.lastAckedFrameSeq = frameSeq;
    this.lastAckedCorrelationSeq = correlationSeq;
    this.lastAckedAuthorityCursor = target.authorityCursor;
    this.lastProgressAtMs = now;
  }

  isDuplicate(message, raw) {
    const sequence = message.session_seq;
    if (sequence === this.lastClientSessionSeq) {
      if (!bytesEqual(this.lastClientMessageBytes, raw)) {
        throw new PresentationSessionError('session sequence retry changed bytes');
      }
      return true;
    }
    if (sequence !== this.lastClientSessionSeq + 1) {
      throw new PresentationSessionError('client session sequence gap');
    }
    this.lastClientSessionSeq = sequence;
    this.lastClientMessageBytes = raw;
    return false;
  }

  assertEnvelope(message) {
    if (message.viewer_scope !== this.viewerScope) {
      throw new PresentationSessionError('viewer_scope mismatch');
    }
    if (decimalToSafeInteger(message.scene_epoch, 'scene_epoch') !== this.sceneEpoch) {
      throw new PresentationSessionError('stale scene_epoch');
    }
    if (decimalToSafeInteger(message.bootstrap_id, 'bootstrap_id') !== this.bootstrapId) {
      throw new PresentationSessionError('stale bootstrap_id');
    }
  }

  invalidate(reason) {
    if (this.resetRequired != null) return this.resetRequired;
    this.valid = false;
    this.ready = false;
    this.pending.length = 0;
    this.inFlight.length = 0;
    this.queuedFrames = 0;
    this.queuedBytes = 0;
    this.resetRequired = Object.freeze({
      required: true,
      reason: canonicalText(reason, 'reset reason'),
      sceneEpoch: this.sceneEpoch,
      bootstrapId: this.bootstrapId,
      viewerScope: this.viewerScope,
      lastAcknowledgedCursor: this.lastAckedAuthorityCursor,
      lastAcknowledgedFrameSeq: this.lastAckedFrameSeq,
      lastAcknowledgedCorrelationSeq: this.lastAckedCorrelationSeq,
    });
    return this.resetRequired;
  }

  oldestQueuedTick() {
    if (this.inFlight.length > 0) return this.inFlight[0].sourceTick;
    if (this.pending.length > 0) return this.pending[0].sourceTick;
    return null;
  }

  requireValid() {
    if (!this.valid) throw new PresentationSessionError('presentation session is invalid');
  }
}

function normalizeLimits(changes) {
  const limits = { ...DEFAULT_PRESENTATION_SESSION_LIMITS, ...changes };
  for (const [name, value] of Object.entries(limits)) positiveSafeInteger(value, name);
  if (limits.maximumInFlightFrames > limits.maximumQueuedFrames) {
    throw new PresentationSessionError('maximumInFlightFrames cannot exceed maximumQueuedFrames');
  }
  return Object.freeze(limits);
}

function normalizeCursor(value) {
  return cursorEnvelopeFromJSON(cursorEnvelopeToJSON(value));
}

function cursorEquals(left, right) {
  if (left == null || right == null) return left === right;
  return left.codecIdentity === right.codecIdentity
    && bytesEqual(left.canonicalBytes, right.canonicalBytes);
}

function readonlyBytes(value, label) {
  return new Uint8Array(byteView(value, label));
}

function byteView(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new PresentationSessionError(`${label} must be bytes`);
}

function bytesEqual(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function finiteNow(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PresentationSessionError('wallNowMs must be finite and non-negative');
  }
  return value;
}

function canonicalText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new PresentationSessionError(`${field} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value, field) {
  nonnegativeSafeInteger(value, field);
  if (value === 0) throw new PresentationSessionError(`${field} must be positive`);
  return value;
}

function nonnegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PresentationSessionError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function decimalToSafeInteger(value, field, { allowZero = false } = {}) {
  const numeric = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(numeric) || numeric < minimum || String(numeric) !== value) {
    throw new PresentationSessionError(`${field} exceeds the JavaScript session range`);
  }
  return numeric;
}
