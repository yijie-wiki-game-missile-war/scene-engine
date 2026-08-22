import {
  PRESENTATION_CONTROL_CLIENT_TO_SERVER,
  PRESENTATION_CONTROL_SERVER_TO_CLIENT,
  cursorEnvelopeFromJSON,
  parsePresentationControl,
} from '@scene-engine/presentation-codec';
import {
  OrderedPresentationSession,
} from '@scene-engine/presentation-session';

export class ReplayCoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplayCoreError';
  }
}

export class ReplayTimeline {
  constructor({ ticksPerSecond = 60, speed = 1 } = {}) {
    positiveSafeInteger(ticksPerSecond, 'ticksPerSecond');
    this.ticksPerSecond = ticksPerSecond;
    this.speed = normalizeSpeed(speed);
    this.paused = false;
    this.pausedAtMs = null;
    this.nextDueAtMs = null;
    this.lastTick = null;
  }

  reset({ baselineTick, wallNowMs }) {
    this.lastTick = nonnegativeSafeInteger(baselineTick, 'baselineTick');
    this.nextDueAtMs = finiteNow(wallNowMs);
    this.paused = false;
    this.pausedAtMs = null;
  }

  dueFor(nextTick, wallNowMs) {
    const tick = nonnegativeSafeInteger(nextTick, 'nextTick');
    const now = finiteNow(wallNowMs);
    if (this.lastTick == null) throw new ReplayCoreError('timeline baseline is not open');
    if (tick < this.lastTick) throw new ReplayCoreError('authority tick moved backwards');
    const delay = ((tick - this.lastTick) * 1000 / this.ticksPerSecond) / this.speed;
    return (this.nextDueAtMs ?? now) + delay;
  }

  commit(tick, dueAtMs) {
    this.lastTick = nonnegativeSafeInteger(tick, 'tick');
    this.nextDueAtMs = finiteNow(dueAtMs);
  }

  pause(wallNowMs) {
    if (!this.paused) {
      this.paused = true;
      this.pausedAtMs = finiteNow(wallNowMs);
    }
  }

  resume(wallNowMs) {
    if (!this.paused) return;
    const now = finiteNow(wallNowMs);
    const elapsed = now - this.pausedAtMs;
    if (this.nextDueAtMs != null) this.nextDueAtMs += elapsed;
    this.paused = false;
    this.pausedAtMs = null;
  }

  setSpeed(speed, wallNowMs) {
    const next = normalizeSpeed(speed);
    const now = finiteNow(wallNowMs);
    if (this.nextDueAtMs != null && this.nextDueAtMs > now) {
      this.nextDueAtMs = now + ((this.nextDueAtMs - now) * this.speed / next);
    }
    this.speed = next;
  }
}

export class AuthorityReplaySession {
  constructor({
    authorityLane,
    ticksPerSecond = 60,
    speed = 1,
    instant = false,
    maximumTransmissionsPerPump = 1024,
  }) {
    assertAuthorityLane(authorityLane);
    this.authorityLane = authorityLane;
    this.timeline = new ReplayTimeline({ ticksPerSecond, speed });
    this.instant = Boolean(instant);
    this.maximumTransmissionsPerPump = positiveSafeInteger(
      maximumTransmissionsPerPump,
      'maximumTransmissionsPerPump',
    );
    this.generation = 0;
    this.ready = false;
    this.recordIndex = null;
    this.baselineCursor = null;
    this.opened = false;
    this.closed = false;
    this.exhausted = false;
  }

  async open(checkpointId, { wallNowMs }) {
    this.requireNotClosed();
    if (this.opened) throw new ReplayCoreError('replay session is already open');
    return this.openGeneration(checkpointId, finiteNow(wallNowMs));
  }

  markBaselineReady(cursorEnvelope) {
    this.requireOpen();
    if (!cursorEquals(cursorEnvelope, this.baselineCursor)) {
      throw new ReplayCoreError('authority baseline ACK cursor mismatch');
    }
    this.ready = true;
  }

  async pump(wallNowMs) {
    this.requireOpen();
    const now = finiteNow(wallNowMs);
    if (!this.ready || this.timeline.paused) return [];
    const output = [];
    while (output.length < this.maximumTransmissionsPerPump) {
      const authority = await this.authorityLane.readRecord(this.recordIndex);
      if (authority == null) { this.exhausted = true; break; }
      const tick = this.authorityLane.tickOf(authority);
      const dueAtMs = this.instant ? now : this.timeline.dueFor(tick, now);
      if (now < dueAtMs) break;
      output.push(Object.freeze({
        kind: 'authority',
        data: readonlyBytes(this.authorityLane.wire(authority), 'authority wire'),
        generation: this.generation,
      }));
      this.timeline.commit(tick, dueAtMs);
      this.recordIndex += 1n;
    }
    return output;
  }

  pause(wallNowMs) { this.requireOpen(); this.timeline.pause(wallNowMs); }
  resume(wallNowMs) { this.requireOpen(); this.timeline.resume(wallNowMs); }
  setSpeed(speed, wallNowMs) { this.requireOpen(); this.timeline.setSpeed(speed, wallNowMs); }

  async seek(checkpointId, { wallNowMs }) {
    this.requireOpen();
    this.opened = false;
    this.ready = false;
    const transmissions = await this.openGeneration(checkpointId, finiteNow(wallNowMs));
    return Object.freeze({ generation: this.generation, reconnectRequired: true, transmissions });
  }

  status() {
    return Object.freeze({
      closed: this.closed,
      generation: this.generation,
      exhausted: this.exhausted,
      opened: this.opened,
      paused: this.timeline.paused,
      ready: this.ready,
      speed: this.timeline.speed,
      authorityRecordIndex: this.recordIndex,
    });
  }

  async close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    await this.authorityLane.close?.(reason);
  }

  async openGeneration(checkpointId, wallNowMs) {
    const opened = await this.authorityLane.openCheckpoint(checkpointId);
    if (!opened?.baseline || typeof opened.nextRecordIndex !== 'bigint') {
      throw new ReplayCoreError('authority checkpoint port returned invalid state');
    }
    this.generation += 1;
    this.exhausted = false;
    this.ready = false;
    this.baselineCursor = normalizeCursor(opened.baseline.cursor);
    this.recordIndex = opened.nextRecordIndex;
    this.timeline.reset({ baselineTick: this.authorityLane.tickOf(opened.baseline), wallNowMs });
    this.opened = true;
    return Object.freeze([Object.freeze({
      kind: 'authority-baseline',
      data: readonlyBytes(this.authorityLane.wire(opened.baseline), 'authority baseline wire'),
      generation: this.generation,
    })]);
  }

  requireOpen() {
    this.requireNotClosed();
    if (!this.opened) throw new ReplayCoreError('replay session is not open');
  }

  requireNotClosed() {
    if (this.closed) throw new ReplayCoreError('replay session is closed');
  }
}

export class CompositeReplaySession {
  constructor({
    authorityLane,
    presentationArchive,
    viewerScope,
    profileId,
    ticksPerSecond = 60,
    sessionLimits = {},
    speed = 1,
    instant = false,
    maximumTransmissionsPerPump = 1024,
  }) {
    assertAuthorityLane(authorityLane);
    if (!presentationArchive || typeof presentationArchive.openCheckpoint !== 'function'
        || typeof presentationArchive.iterateFrom !== 'function') {
      throw new ReplayCoreError('presentationArchive port is invalid');
    }
    this.authorityLane = authorityLane;
    this.presentationArchive = presentationArchive;
    this.viewerScope = canonicalText(viewerScope, 'viewerScope');
    this.profileId = canonicalText(profileId, 'profileId');
    this.timeline = new ReplayTimeline({ ticksPerSecond, speed });
    this.instant = Boolean(instant);
    this.sessionLimits = sessionLimits;
    this.maximumTransmissionsPerPump = positiveSafeInteger(
      maximumTransmissionsPerPump,
      'maximumTransmissionsPerPump',
    );
    this.generation = 0;
    this.authorityReady = false;
    this.presentationSession = null;
    this.authorityRecordIndex = null;
    this.presentationIterator = null;
    this.baselinePresentationPending = false;
    this.pendingJoined = null;
    this.baselineCursor = null;
    this.opened = false;
    this.closed = false;
    this.exhausted = false;
  }

  async open(checkpointId, { wallNowMs }) {
    this.requireNotClosed();
    if (this.opened) throw new ReplayCoreError('replay session is already open');
    return this.openGeneration(checkpointId, finiteNow(wallNowMs));
  }

  markAuthorityBaselineReady(cursorEnvelope) {
    this.requireOpen();
    if (!cursorEquals(cursorEnvelope, this.baselineCursor)) {
      throw new ReplayCoreError('authority baseline ACK cursor mismatch');
    }
    this.authorityReady = true;
  }

  handlePresentationControl(raw, { wallNowMs }) {
    this.requireOpen();
    return this.presentationSession.handleClientControl(raw, {
      wallNowMs: finiteNow(wallNowMs),
    });
  }

  async pump(wallNowMs) {
    this.requireOpen();
    const now = finiteNow(wallNowMs);
    this.presentationSession.checkTimeout({ wallNowMs: now });
    if (this.timeline.paused || !this.authorityReady || !this.presentationSession.ready) return [];
    const output = [];
    if (this.baselinePresentationPending) {
      const baselinePresentation = this.presentationSession.drainSendable({ wallNowMs: now });
      if (baselinePresentation.length === 0) return output;
      for (const transmission of baselinePresentation) {
        output.push(Object.freeze({ ...transmission, generation: this.generation }));
      }
      this.baselinePresentationPending = false;
    }
    while (output.length < this.maximumTransmissionsPerPump) {
      if (!this.pendingJoined) {
        const authority = await this.authorityLane.readRecord(this.authorityRecordIndex);
        if (authority == null) { this.exhausted = true; break; }
        const joined = await this.readPresentationJoin(authority);
        const tick = this.authorityLane.tickOf(authority);
        this.pendingJoined = {
          authority,
          joined,
          tick,
          dueAtMs: this.instant ? now : this.timeline.dueFor(tick, now),
        };
        this.presentationSession.admit({
          frames: joined.frames,
          correlation: joined.correlation,
        });
      }
      if (now < this.pendingJoined.dueAtMs) break;
      const presentation = this.presentationSession.drainSendable({ wallNowMs: now });
      if (presentation.length === 0) break;
      output.push(Object.freeze({
        kind: 'authority',
        data: readonlyBytes(this.authorityLane.wire(this.pendingJoined.authority), 'authority wire'),
        generation: this.generation,
      }));
      for (const transmission of presentation) {
        output.push(Object.freeze({ ...transmission, generation: this.generation }));
      }
      this.timeline.commit(this.pendingJoined.tick, this.pendingJoined.dueAtMs);
      this.authorityRecordIndex += 1n;
      this.pendingJoined = null;
    }
    return output;
  }

  pause(wallNowMs) {
    this.requireOpen();
    this.timeline.pause(wallNowMs);
  }

  resume(wallNowMs) {
    this.requireOpen();
    this.timeline.resume(wallNowMs);
  }

  setSpeed(speed, wallNowMs) {
    this.requireOpen();
    this.timeline.setSpeed(speed, wallNowMs);
  }

  async seek(checkpointId, { wallNowMs }) {
    this.requireOpen();
    this.invalidateGeneration();
    const transmissions = await this.openGeneration(checkpointId, finiteNow(wallNowMs));
    return Object.freeze({
      generation: this.generation,
      reconnectRequired: true,
      transmissions,
    });
  }

  status() {
    return Object.freeze({
      authorityReady: this.authorityReady,
      closed: this.closed,
      exhausted: this.exhausted,
      generation: this.generation,
      opened: this.opened,
      paused: this.timeline.paused,
      presentationReady: Boolean(this.presentationSession?.ready),
      speed: this.timeline.speed,
      authorityRecordIndex: this.authorityRecordIndex,
    });
  }

  async close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    this.pendingJoined = null;
    this.presentationIterator = null;
    this.baselinePresentationPending = false;
    if (typeof this.authorityLane.close === 'function') await this.authorityLane.close(reason);
  }

  async openGeneration(checkpointId, wallNowMs) {
    const [authorityOpened, presentationOpened] = await Promise.all([
      this.authorityLane.openCheckpoint(checkpointId),
      this.presentationArchive.openCheckpoint(checkpointId),
    ]);
    if (!authorityOpened || !authorityOpened.baseline
        || typeof authorityOpened.nextRecordIndex !== 'bigint') {
      throw new ReplayCoreError('authority checkpoint port returned invalid state');
    }
    const baselineCursor = normalizeCursor(authorityOpened.baseline.cursor);
    const baselineTick = this.authorityLane.tickOf(authorityOpened.baseline);
    const archiveTick = bigintToSafeNumber(
      presentationOpened.checkpoint.sourceTick,
      'presentation checkpoint source tick',
    );
    if (baselineTick !== archiveTick) {
      throw new ReplayCoreError('authority/presentation checkpoint tick mismatch');
    }
    this.generation += 1;
    this.exhausted = false;
    this.authorityReady = false;
    this.baselineCursor = baselineCursor;
    this.authorityRecordIndex = authorityOpened.nextRecordIndex;
    this.presentationIterator = this.presentationArchive.iterateFrom(checkpointId)[Symbol.asyncIterator]();
    const first = await this.presentationIterator.next();
    if (first.done || first.value.kind !== 'checkpoint') {
      throw new ReplayCoreError('presentation checkpoint iterator is invalid');
    }
    this.presentationSession = new OrderedPresentationSession({
      bootstrapPacket: presentationOpened.bootstrapPacket,
      sceneEpoch: bigintToSafeNumber(presentationOpened.checkpoint.sceneEpoch, 'sceneEpoch'),
      bootstrapId: bigintToSafeNumber(presentationOpened.checkpoint.bootstrapId, 'bootstrapId'),
      viewerScope: this.viewerScope,
      profileId: this.profileId,
      authorityBaseline: baselineCursor,
      limits: this.sessionLimits,
    });
    const baselinePresentation = await this.readPresentationJoin(authorityOpened.baseline);
    this.presentationSession.admit(baselinePresentation);
    this.baselinePresentationPending = true;
    this.timeline.reset({ baselineTick, wallNowMs });
    this.pendingJoined = null;
    this.opened = true;
    return Object.freeze([
      Object.freeze({
        kind: 'authority-baseline',
        data: readonlyBytes(this.authorityLane.wire(authorityOpened.baseline), 'authority baseline wire'),
        generation: this.generation,
      }),
      Object.freeze({
        ...this.presentationSession.openBootstrap({ wallNowMs }),
        generation: this.generation,
      }),
    ]);
  }

  async readPresentationJoin(authorityRecord) {
    const frames = [];
    for (;;) {
      const next = await this.presentationIterator.next();
      if (next.done) throw new ReplayCoreError('presentation archive ended before authority lane');
      const record = next.value;
      if (record.kind === 'checkpoint') {
        throw new ReplayCoreError('presentation segment changed without seek/reset');
      }
      if (record.kind === 'frame') {
        frames.push({
          frameSeq: bigintToSafeNumber(record.entry.frameSeq, 'frameSeq'),
          sourceTick: bigintToSafeNumber(record.entry.sourceTick, 'sourceTick'),
          projectionId: bigintToSafeNumber(record.entry.projectionId, 'projectionId'),
          packet: record.bytes,
        });
        continue;
      }
      const correlation = parsePresentationControl(record.bytes, {
        direction: PRESENTATION_CONTROL_SERVER_TO_CLIENT,
      });
      if (correlation.type !== 'presentation.correlation') {
        throw new ReplayCoreError('archive join record is not a correlation');
      }
      const authorityCursor = normalizeCursor(this.authorityLane.cursorOf(authorityRecord));
      const correlationCursor = cursorEnvelopeFromJSON(correlation.payload.authority_cursor);
      if (!cursorEquals(authorityCursor, correlationCursor)) {
        throw new ReplayCoreError('authority/presentation cursor mismatch');
      }
      const authorityTick = this.authorityLane.tickOf(authorityRecord);
      if (BigInt(authorityTick) !== BigInt(correlation.payload.source_tick)) {
        throw new ReplayCoreError('authority/presentation tick mismatch');
      }
      return { frames, correlation: record.bytes };
    }
  }

  invalidateGeneration() {
    this.opened = false;
    this.authorityReady = false;
    this.pendingJoined = null;
    this.presentationIterator = null;
  }

  requireOpen() {
    this.requireNotClosed();
    if (!this.opened) throw new ReplayCoreError('replay session is not open');
  }

  requireNotClosed() {
    if (this.closed) throw new ReplayCoreError('replay session is closed');
  }
}

function assertAuthorityLane(value) {
  for (const method of ['openCheckpoint', 'readRecord', 'tickOf', 'wire', 'cursorOf']) {
    if (!value || typeof value[method] !== 'function') {
      throw new ReplayCoreError(`authorityLane.${method} port is required`);
    }
  }
}

function normalizeCursor(value) {
  if (!value || typeof value.codecIdentity !== 'string' || !(value.canonicalBytes instanceof Uint8Array)) {
    throw new ReplayCoreError('authority cursor envelope is invalid');
  }
  return Object.freeze({
    codecIdentity: value.codecIdentity,
    canonicalBytes: new Uint8Array(value.canonicalBytes),
  });
}

function cursorEquals(left, right) {
  if (!left || !right || left.codecIdentity !== right.codecIdentity
      || left.canonicalBytes.byteLength !== right.canonicalBytes.byteLength) return false;
  return left.canonicalBytes.every((byte, index) => byte === right.canonicalBytes[index]);
}

function readonlyBytes(value, label) {
  let view;
  if (value instanceof Uint8Array) view = value;
  else if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else throw new ReplayCoreError(`${label} must be bytes`);
  return new Uint8Array(view);
}

function finiteNow(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ReplayCoreError('wallNowMs must be finite and non-negative');
  }
  return value;
}

function normalizeSpeed(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 64) {
    throw new ReplayCoreError('speed must be finite in (0, 64]');
  }
  return value;
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReplayCoreError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReplayCoreError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function bigintToSafeNumber(value, field) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new ReplayCoreError(`${field} exceeds local session range`);
  }
  return numeric;
}

function canonicalText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ReplayCoreError(`${field} is invalid`);
  }
  return value;
}

export { PRESENTATION_CONTROL_CLIENT_TO_SERVER };
