import {
  PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  cursorEnvelopeFromJSON,
  cursorEnvelopeToJSON,
  encodePresentationControl,
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
  baselineReadyDeadlineMs: 5_000,
  presentationAckDeadlineMs: 10_000,
  maximumPacketBytes: 8 * 1024 * 1024,
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
    this.bootstrapPacket = readonlyBytes(bootstrapPacket, 'bootstrap packet');
    if (this.bootstrapPacket.byteLength === 0
        || this.bootstrapPacket.byteLength > this.limits.maximumPacketBytes) {
      throw new PresentationSessionError('bootstrap packet byte length is invalid');
    }
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
    this.clientMessages = new Map();
    this.lastClientSessionSeq = 0;
    this.serverSessionSeq = 0;
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
    const records = [...frames].map((frame) => createPresentationFramePacket(frame));
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
    let previousFrame = this.lastAdmittedFrameSeq;
    let previousTick = this.lastAdmittedTick;
    for (const record of records) {
      if (record.packet.byteLength > this.limits.maximumPacketBytes) {
        throw new PresentationSessionError('frame packet exceeds byte limit');
      }
      if (record.frameSeq !== previousFrame + 1) {
        throw new PresentationSessionError('frame sequence gap');
      }
      if (previousTick != null && record.sourceTick !== previousTick
          && record.sourceTick !== previousTick + 1) {
        throw new PresentationSessionError('source tick gap');
      }
      if (record.sourceTick !== decimalToSafeInteger(
        payload.source_tick,
        'source_tick',
        { allowZero: true },
      )) {
        throw new PresentationSessionError('correlation source_tick mismatch');
      }
      if (record.projectionId !== decimalToSafeInteger(payload.projection_id, 'projection_id')) {
        throw new PresentationSessionError('correlation projection_id mismatch');
      }
      previousFrame = record.frameSeq;
      previousTick = record.sourceTick;
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
    });
    this.pending.push(admission);
    this.queuedFrames += records.length;
    this.queuedBytes += addedBytes;
    this.lastCorrelationSeq = correlationSeq;
    if (records.length > 0) {
      this.lastAdmittedFrameSeq = records.at(-1).frameSeq;
      this.lastAdmittedTick = records.at(-1).sourceTick;
    }
  }

  handleClientControl(data, { wallNowMs }) {
    this.requireValid();
    const now = finiteNow(wallNowMs);
    const raw = readonlyBytes(data, 'control');
    const message = parsePresentationControl(raw, {
      direction: PRESENTATION_CONTROL_CLIENT_TO_SERVER,
    });
    this.assertEnvelope(message);
    if (this.isDuplicate(message, raw)) return [];
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
      this.lastProgressAtMs = now;
      return [];
    }
    if (message.type === 'presentation.resync_request') {
      return [this.invalidate('client-resync')];
    }
    if (!this.ready) throw new PresentationSessionError('ack arrived before ready');
    this.acknowledge(message, now);
    return [];
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
    return transmissions;
  }

  checkTimeout({ wallNowMs }) {
    const now = finiteNow(wallNowMs);
    if (this.bootstrapOpened && !this.ready && this.openedAtMs != null
        && now - this.openedAtMs > this.limits.baselineReadyDeadlineMs) {
      this.invalidate('ready-timeout');
      throw new PresentationSessionError('presentation ready timed out');
    }
    if (this.inFlight.length > 0 && this.lastProgressAtMs != null
        && now - this.lastProgressAtMs > this.limits.presentationAckDeadlineMs) {
      this.invalidate('ack-timeout');
      throw new PresentationSessionError('presentation acknowledgement timed out');
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
    this.lastProgressAtMs = now;
  }

  isDuplicate(message, raw) {
    const sequence = message.session_seq;
    const existing = this.clientMessages.get(sequence);
    if (existing) {
      if (!bytesEqual(existing, raw)) {
        throw new PresentationSessionError('session sequence retry changed bytes');
      }
      return true;
    }
    if (sequence !== this.lastClientSessionSeq + 1) {
      throw new PresentationSessionError('client session sequence gap');
    }
    this.clientMessages.set(sequence, raw);
    this.lastClientSessionSeq = sequence;
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
    this.valid = false;
    this.ready = false;
    this.serverSessionSeq += 1;
    return Object.freeze({
      kind: 'reset',
      data: encodePresentationControl({
        bootstrap_id: String(this.bootstrapId),
        message_id: `presentation-reset-${this.serverSessionSeq}`,
        payload: {
          next_bootstrap_id: String(this.bootstrapId + 1),
          next_scene_epoch: String(this.sceneEpoch + 1),
          reason,
        },
        protocol: 'scene-presentation-control-v2',
        scene_epoch: String(this.sceneEpoch),
        schema_version: 1,
        session_seq: this.serverSessionSeq,
        type: 'presentation.reset',
        viewer_scope: this.viewerScope,
      }, { direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT }),
    });
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
  let view;
  if (value instanceof Uint8Array) view = value;
  else if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new PresentationSessionError(`${label} must be bytes`);
  return new Uint8Array(view);
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
