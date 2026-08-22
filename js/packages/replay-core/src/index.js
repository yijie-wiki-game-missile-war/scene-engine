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
    const referenceNow = this.paused ? this.pausedAtMs : now;
    if (this.nextDueAtMs != null && this.nextDueAtMs > referenceNow) {
      this.nextDueAtMs = referenceNow
        + ((this.nextDueAtMs - referenceNow) * this.speed / next);
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
    maximumBytesPerPump = 32 * 1024 * 1024,
    maximumTransmissionsPerPump = 1024,
  }) {
    assertAuthorityLane(authorityLane);
    this.authorityLane = authorityLane;
    this.timeline = new ReplayTimeline({ ticksPerSecond, speed });
    this.instant = Boolean(instant);
    this.maximumBytesPerPump = positiveSafeInteger(
      maximumBytesPerPump,
      'maximumBytesPerPump',
    );
    this.maximumTransmissionsPerPump = positiveSafeInteger(
      maximumTransmissionsPerPump,
      'maximumTransmissionsPerPump',
    );
    this.generation = 0;
    this.ready = false;
    this.recordIndex = null;
    this.baselineCursor = null;
    this.baselineOutbound = null;
    this.pendingOutbound = null;
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
    let outputBytes = 0;
    if (this.baselineOutbound) {
      outputBytes = this.drainAuthorityOutbound(
        this.baselineOutbound,
        output,
        outputBytes,
      );
      if (this.baselineOutbound.index < this.baselineOutbound.transmissions.length) {
        return output;
      }
      this.baselineOutbound = null;
    }
    while (output.length < this.maximumTransmissionsPerPump) {
      if (!this.pendingOutbound) {
        const authority = await this.authorityLane.readRecord(this.recordIndex);
        if (authority == null) { this.exhausted = true; break; }
        const tick = this.authorityLane.tickOf(authority);
        this.pendingOutbound = {
          dueAtMs: this.instant ? now : this.timeline.dueFor(tick, now),
          index: 0,
          tick,
          transmissions: authorityTransmissions(this.authorityLane, authority),
        };
      }
      if (now < this.pendingOutbound.dueAtMs) break;
      outputBytes = this.drainAuthorityOutbound(
        this.pendingOutbound,
        output,
        outputBytes,
      );
      if (this.pendingOutbound.index < this.pendingOutbound.transmissions.length) break;
      this.timeline.commit(this.pendingOutbound.tick, this.pendingOutbound.dueAtMs);
      this.recordIndex += 1n;
      this.pendingOutbound = null;
    }
    return output;
  }

  pause(wallNowMs) { this.requireOpen(); this.timeline.pause(wallNowMs); }

  resume(wallNowMs) {
    this.requireOpen();
    const now = finiteNow(wallNowMs);
    const pausedAt = this.timeline.pausedAtMs;
    if (this.timeline.paused && this.pendingOutbound && pausedAt != null) {
      this.pendingOutbound.dueAtMs += now - pausedAt;
    }
    this.timeline.resume(now);
  }

  setSpeed(speed, wallNowMs) {
    this.requireOpen();
    const nextSpeed = normalizeSpeed(speed);
    const now = finiteNow(wallNowMs);
    const referenceNow = this.timeline.paused ? this.timeline.pausedAtMs : now;
    if (this.pendingOutbound && this.pendingOutbound.dueAtMs > referenceNow) {
      this.pendingOutbound.dueAtMs = referenceNow
        + ((this.pendingOutbound.dueAtMs - referenceNow) * this.timeline.speed / nextSpeed);
    }
    this.timeline.setSpeed(nextSpeed, now);
  }

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
    this.baselineOutbound = null;
    this.pendingOutbound = null;
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
    const baselineTransmissions = authorityTransmissions(
      this.authorityLane,
      opened.baseline,
    );
    this.baselineOutbound = baselineTransmissions.length > 1
      ? { index: 1, transmissions: baselineTransmissions }
      : null;
    this.pendingOutbound = null;
    this.timeline.reset({ baselineTick: this.authorityLane.tickOf(opened.baseline), wallNowMs });
    this.opened = true;
    return Object.freeze([Object.freeze({
      kind: 'authority-baseline',
      data: readonlyBytes(baselineTransmissions[0].data, 'authority baseline wire'),
      generation: this.generation,
    })]);
  }

  drainAuthorityOutbound(pending, output, outputBytes) {
    while (pending.index < pending.transmissions.length
        && output.length < this.maximumTransmissionsPerPump) {
      const transmission = pending.transmissions[pending.index];
      const wire = authorityTransmissionBytes(transmission, pending.index);
      if (wire.byteLength > this.maximumBytesPerPump) {
        throw new ReplayCoreError('authority transmission exceeds maximumBytesPerPump');
      }
      if (outputBytes + wire.byteLength > this.maximumBytesPerPump) break;
      output.push(Object.freeze({
        kind: transmission.kind,
        data: new Uint8Array(wire),
        generation: this.generation,
      }));
      outputBytes += wire.byteLength;
      pending.index += 1;
    }
    return outputBytes;
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
    maximumBytesPerPump = 64 * 1024 * 1024,
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
    this.maximumBytesPerPump = positiveSafeInteger(
      maximumBytesPerPump,
      'maximumBytesPerPump',
    );
    this.maximumTransmissionsPerPump = positiveSafeInteger(
      maximumTransmissionsPerPump,
      'maximumTransmissionsPerPump',
    );
    this.generation = 0;
    this.authorityReady = false;
    this.presentationSession = null;
    this.authorityRecordIndex = null;
    this.authorityEndRecordIndex = null;
    this.presentationIterator = null;
    this.baselineAuthorityOutbound = null;
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
    let outputBytes = 0;
    if (this.baselinePresentationPending) {
      const baselineAdmission = this.presentationSession.pending[0];
      if (!baselineAdmission) return output;
      const baselineBytes = admissionTransmissionBytes(baselineAdmission);
      const baselineCount = baselineAdmission.frames.length + 1;
      if (baselineBytes > this.maximumBytesPerPump) {
        throw new ReplayCoreError('presentation transmission group exceeds maximumBytesPerPump');
      }
      if (baselineCount > this.maximumTransmissionsPerPump) {
        throw new ReplayCoreError(
          'presentation transmission group exceeds maximumTransmissionsPerPump',
        );
      }
      if (outputBytes + baselineBytes > this.maximumBytesPerPump
          || output.length + baselineCount > this.maximumTransmissionsPerPump) {
        return output;
      }
      const baselinePresentation = this.presentationSession.drainSendable({ wallNowMs: now });
      if (baselinePresentation.length === 0) return output;
      if (transmissionBytes(baselinePresentation) !== baselineBytes
          || baselinePresentation.length !== baselineCount) {
        throw new ReplayCoreError('presentation session changed baseline transmission group');
      }
      for (const transmission of baselinePresentation) {
        output.push(Object.freeze({ ...transmission, generation: this.generation }));
      }
      outputBytes += baselineBytes;
      this.baselinePresentationPending = false;
    }
    if (this.baselineAuthorityOutbound) {
      outputBytes = this.drainAuthorityOutbound(
        this.baselineAuthorityOutbound,
        output,
        outputBytes,
      );
      if (this.baselineAuthorityOutbound.index
          < this.baselineAuthorityOutbound.transmissions.length) {
        return output;
      }
      this.baselineAuthorityOutbound = null;
    }
    while (output.length < this.maximumTransmissionsPerPump) {
      if (!this.pendingJoined) {
        if (this.authorityRecordIndex === this.authorityEndRecordIndex) {
          this.exhausted = true;
          break;
        }
        if (this.authorityRecordIndex > this.authorityEndRecordIndex) {
          throw new ReplayCoreError('authority checkpoint range was exceeded');
        }
        const authority = await this.authorityLane.readRecord(this.authorityRecordIndex);
        if (authority == null) {
          throw new ReplayCoreError('authority lane ended before checkpoint boundary');
        }
        const joined = await this.readPresentationJoin(authority);
        const tick = this.authorityLane.tickOf(authority);
        this.pendingJoined = {
          authority,
          authorityOutbound: {
            index: 0,
            transmissions: authorityTransmissions(this.authorityLane, authority),
          },
          joined,
          primarySent: false,
          tick,
          dueAtMs: this.instant ? now : this.timeline.dueFor(tick, now),
        };
        this.presentationSession.admit({
          frames: joined.frames,
          correlation: joined.correlation,
        });
      }
      if (now < this.pendingJoined.dueAtMs) break;
      if (!this.pendingJoined.primarySent) {
        const admission = this.presentationSession.pending[0];
        if (!admission || !presentationAdmissionIsSendable(
          this.presentationSession,
          admission,
        )) {
          break;
        }
        const primary = this.pendingJoined.authorityOutbound.transmissions[0];
        const authorityBytes = authorityTransmissionBytes(primary, 0);
        const presentationBytes = presentationJoinBytes(this.pendingJoined.joined);
        const presentationCount = this.pendingJoined.joined.frames.length + 1;
        const primaryBytes = authorityBytes.byteLength + presentationBytes;
        const primaryCount = 1 + presentationCount;
        if (primaryBytes > this.maximumBytesPerPump) {
          throw new ReplayCoreError('joined primary group exceeds maximumBytesPerPump');
        }
        if (primaryCount > this.maximumTransmissionsPerPump) {
          throw new ReplayCoreError('joined primary group exceeds maximumTransmissionsPerPump');
        }
        if (outputBytes + primaryBytes > this.maximumBytesPerPump
            || output.length + primaryCount > this.maximumTransmissionsPerPump) {
          break;
        }
        output.push(Object.freeze({
          kind: primary.kind,
          data: new Uint8Array(authorityBytes),
          generation: this.generation,
        }));
        const presentation = this.presentationSession.drainSendable({ wallNowMs: now });
        if (presentation.length === 0) {
          throw new ReplayCoreError('presentation admission became unsendable');
        }
        if (transmissionBytes(presentation) !== presentationBytes
            || presentation.length !== presentationCount) {
          throw new ReplayCoreError('presentation session changed joined transmission bytes');
        }
        for (const transmission of presentation) {
          output.push(Object.freeze({ ...transmission, generation: this.generation }));
        }
        this.timeline.commit(this.pendingJoined.tick, this.pendingJoined.dueAtMs);
        outputBytes += primaryBytes;
        this.pendingJoined.authorityOutbound.index = 1;
        this.pendingJoined.primarySent = true;
      }
      outputBytes = this.drainAuthorityOutbound(
        this.pendingJoined.authorityOutbound,
        output,
        outputBytes,
      );
      if (this.pendingJoined.authorityOutbound.index
          < this.pendingJoined.authorityOutbound.transmissions.length) {
        break;
      }
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
    const now = finiteNow(wallNowMs);
    const pausedAt = this.timeline.pausedAtMs;
    if (this.timeline.paused && this.pendingJoined && pausedAt != null) {
      this.pendingJoined.dueAtMs += now - pausedAt;
    }
    this.timeline.resume(now);
  }

  setSpeed(speed, wallNowMs) {
    this.requireOpen();
    const nextSpeed = normalizeSpeed(speed);
    const now = finiteNow(wallNowMs);
    const referenceNow = this.timeline.paused ? this.timeline.pausedAtMs : now;
    if (this.pendingJoined && this.pendingJoined.dueAtMs > referenceNow) {
      this.pendingJoined.dueAtMs = referenceNow
        + ((this.pendingJoined.dueAtMs - referenceNow) * this.timeline.speed / nextSpeed);
    }
    this.timeline.setSpeed(nextSpeed, now);
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
    this.authorityEndRecordIndex = null;
    this.baselineAuthorityOutbound = null;
    this.baselinePresentationPending = false;
    if (typeof this.authorityLane.close === 'function') await this.authorityLane.close(reason);
  }

  async openGeneration(checkpointId, wallNowMs) {
    const [authorityOpened, presentationOpened] = await Promise.all([
      this.authorityLane.openCheckpoint(checkpointId),
      this.presentationArchive.openCheckpoint(checkpointId),
    ]);
    if (!authorityOpened || !authorityOpened.baseline
        || typeof authorityOpened.nextRecordIndex !== 'bigint'
        || typeof authorityOpened.endRecordIndexExclusive !== 'bigint'
        || authorityOpened.endRecordIndexExclusive < authorityOpened.nextRecordIndex) {
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
    this.authorityEndRecordIndex = authorityOpened.endRecordIndexExclusive;
    const baselineAuthorityTransmissions = authorityTransmissions(
      this.authorityLane,
      authorityOpened.baseline,
    );
    this.baselineAuthorityOutbound = baselineAuthorityTransmissions.length > 1
      ? { index: 1, transmissions: baselineAuthorityTransmissions }
      : null;
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
        data: readonlyBytes(
          baselineAuthorityTransmissions[0].data,
          'authority baseline wire',
        ),
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
    let frameBytes = 0;
    const limits = this.presentationSession.limits;
    for (;;) {
      const next = await this.presentationIterator.next();
      if (next.done) throw new ReplayCoreError('presentation archive ended before authority lane');
      const record = next.value;
      if (record.kind === 'checkpoint') {
        throw new ReplayCoreError('presentation segment changed without seek/reset');
      }
      if (record.kind === 'frame') {
        if (frames.length >= limits.maximumInFlightFrames
            || frames.length >= limits.maximumQueuedFrames) {
          throw new ReplayCoreError('presentation join exceeds its frame-count limit');
        }
        const packetLength = byteView(record.bytes, 'presentation frame packet').byteLength;
        if (packetLength === 0 || packetLength > limits.maximumPacketBytes) {
          throw new ReplayCoreError('presentation join frame exceeds maximumPacketBytes');
        }
        if (frameBytes > limits.maximumQueuedBytes - packetLength) {
          throw new ReplayCoreError('presentation join exceeds maximumQueuedBytes');
        }
        frameBytes += packetLength;
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
      const correlationLength = byteView(
        record.bytes,
        'presentation correlation',
      ).byteLength;
      if (frameBytes > limits.maximumQueuedBytes - correlationLength) {
        throw new ReplayCoreError('presentation join exceeds maximumQueuedBytes');
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
    this.authorityEndRecordIndex = null;
    this.baselineAuthorityOutbound = null;
  }

  drainAuthorityOutbound(pending, output, outputBytes) {
    while (pending.index < pending.transmissions.length
        && output.length < this.maximumTransmissionsPerPump) {
      const transmission = pending.transmissions[pending.index];
      const wire = authorityTransmissionBytes(transmission, pending.index);
      if (wire.byteLength > this.maximumBytesPerPump) {
        throw new ReplayCoreError('authority transmission exceeds maximumBytesPerPump');
      }
      if (outputBytes + wire.byteLength > this.maximumBytesPerPump) break;
      output.push(Object.freeze({
        kind: transmission.kind,
        data: new Uint8Array(wire),
        generation: this.generation,
      }));
      outputBytes += wire.byteLength;
      pending.index += 1;
    }
    return outputBytes;
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
  return new Uint8Array(byteView(value, label));
}

function authorityTransmissions(authorityLane, record) {
  const authorityWire = byteView(authorityLane.wire(record), 'authority wire');
  const transmissions = typeof authorityLane.transmissionsOf === 'function'
    ? authorityLane.transmissionsOf(record)
    : [Object.freeze({ kind: 'authority', data: authorityWire })];
  if (!Array.isArray(transmissions) || transmissions.length === 0) {
    throw new ReplayCoreError('authority transmission group is invalid');
  }
  const first = transmissions[0];
  const firstWire = byteView(first?.data, 'authority transmission');
  if (first?.kind !== 'authority' || !bytesEqual(firstWire, authorityWire)) {
    throw new ReplayCoreError('authority transmission group must begin with its authority wire');
  }
  return transmissions;
}

function authorityTransmissionBytes(transmission, index) {
  const expectedKind = index === 0 ? 'authority' : 'authority-control';
  if (transmission?.kind !== expectedKind) {
    throw new ReplayCoreError('authority transmission group order is invalid');
  }
  return byteView(transmission.data, 'authority transmission');
}

function bytesEqual(left, right) {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function byteView(value, label) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ReplayCoreError(`${label} must be bytes`);
}

function transmissionBytes(transmissions) {
  let total = 0;
  for (const transmission of transmissions) {
    const length = byteView(transmission?.data, 'transmission data').byteLength;
    if (total > Number.MAX_SAFE_INTEGER - length) {
      throw new ReplayCoreError('transmission byte count exceeds JavaScript range');
    }
    total += length;
  }
  return total;
}

function admissionTransmissionBytes(admission) {
  if (!admission || !Array.isArray(admission.frames)) {
    throw new ReplayCoreError('presentation admission is invalid');
  }
  let total = byteView(admission.correlation, 'presentation correlation').byteLength;
  for (const frame of admission.frames) {
    const length = byteView(frame?.packet, 'presentation frame packet').byteLength;
    if (total > Number.MAX_SAFE_INTEGER - length) {
      throw new ReplayCoreError('presentation admission byte count exceeds JavaScript range');
    }
    total += length;
  }
  return total;
}

function presentationAdmissionIsSendable(session, admission) {
  let inFlightFrames = 0;
  for (const item of session.inFlight) {
    if (!Array.isArray(item?.frames)) {
      throw new ReplayCoreError('presentation in-flight admission is invalid');
    }
    inFlightFrames += item.frames.length;
  }
  return admission.frames.length <= session.limits.maximumInFlightFrames - inFlightFrames;
}

function presentationJoinBytes(joined) {
  if (!joined || !Array.isArray(joined.frames)) {
    throw new ReplayCoreError('presentation join is invalid');
  }
  let total = byteView(joined.correlation, 'presentation correlation').byteLength;
  for (const frame of joined.frames) {
    const length = byteView(frame?.packet, 'presentation frame packet').byteLength;
    if (total > Number.MAX_SAFE_INTEGER - length) {
      throw new ReplayCoreError('presentation join byte count exceeds JavaScript range');
    }
    total += length;
  }
  return total;
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
