import { applyJsonPatch, prepareJsonSnapshot } from './json-tree.js';
import { readPacketLog } from './packet-log.js';
import { parseSceneBootstrap, parseSceneFrame } from './scene.js';
import { SceneTree } from './tree.js';
import {
  DEFAULT_ENGINE_LIMITS,
  encodeEngineAck,
  encodeEngineInput,
  readEnginePacket,
} from './wire.js';

const EMPTY_SCENE_EVENTS = Object.freeze([]);

export class SceneEngineClientError extends Error {
  constructor(code, message = code, options = undefined) {
    super(message, options);
    this.name = 'SceneEngineClientError';
    this.code = code;
  }
}

export class SceneEngineClient {
  #commit = null;
  #disposed = false;
  #failed = false;
  #limits;
  #onCommit;
  #tree;
  #worldCodec = null;
  #worldState = null;

  constructor({ limits = DEFAULT_ENGINE_LIMITS, onCommit = null } = {}) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      fail('client-limits-invalid');
    }
    if (onCommit !== null && typeof onCommit !== 'function') {
      fail('client-on-commit-invalid');
    }
    const known = new Set(Object.keys(DEFAULT_ENGINE_LIMITS));
    for (const key of Reflect.ownKeys(limits)) {
      if (typeof key !== 'string' || !known.has(key)) fail('client-limit-unknown');
    }
    this.#limits = Object.freeze({ ...DEFAULT_ENGINE_LIMITS, ...limits });
    for (const value of Object.values(this.#limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) fail('client-limit-invalid');
    }
    this.#onCommit = onCommit;
    this.#tree = new SceneTree();
  }

  applyPacket(rawBytes) {
    this.#requireAvailable();
    let packet;
    try {
      packet = readEnginePacket(rawBytes, this.#limits);
      if (packet.kind === 'engine.checkpoint') return this.#applyCheckpoint(packet);
      if (packet.kind === 'engine.commit') return this.#applyCommit(packet);
      if (packet.kind === 'engine.input_result') return this.#applyInputResult(packet);
      if (packet.kind === 'engine.error') {
        this.#failed = true;
        throw new SceneEngineClientError('engine-error', packet.header.code);
      }
      throw new SceneEngineClientError('server-packet-kind-invalid');
    } catch (error) {
      this.#failed = true;
      if (error instanceof SceneEngineClientError) throw error;
      throw new SceneEngineClientError(
        error?.code ?? 'packet-apply-failed',
        error?.message ?? 'packet apply failed',
        { cause: error },
      );
    }
  }

  #applyCheckpoint(packet) {
    const header = packet.header;
    if (this.#commit !== null) {
      if (header.stream_id !== this.#commit.streamId) fail('checkpoint-stream-changed');
      if (header.commit_seq <= this.#commit.commitSeq
          || header.source_tick < this.#commit.sourceTick
          || header.world_revision < this.#commit.worldRevision) {
        fail('checkpoint-cursor-not-higher');
      }
      if (header.world_codec !== this.#worldCodec) fail('world-codec-changed');
    }
    const world = prepareJsonSnapshot(attachment(packet, 'world_snapshot').value, this.#limits);
    const bootstrap = parseSceneBootstrap(attachment(packet, 'scene_bootstrap').bytes, {
      maximumBootstrapBytes: this.#limits.maximumAttachmentBytes,
    });
    const frame = parseSceneFrame(attachment(packet, 'scene_frame').bytes, {
      sourceTick: header.source_tick,
      limits: {
        maximumFrameBytes: Math.min(
          bootstrap.header.maximumFrameBytes,
          this.#limits.maximumAttachmentBytes,
        ),
        maximumFrameNodes: bootstrap.header.maximumDynamicNodes,
      },
    });
    const commit = commitView('checkpoint', header);
    const candidate = this.#tree.prepareCheckpoint(bootstrap, frame, commit);
    const ackPacket = encodeEngineAck({
      streamId: commit.streamId,
      commitSeq: commit.commitSeq,
    }, this.#limits);
    this.#tree.commit(candidate);
    this.#worldState = world;
    this.#worldCodec = header.world_codec;
    this.#commit = commit;
    const events = sceneEventView(candidate.sceneEvents);
    this.#schedule('checkpoint', commit, candidate.plan, events);
    return outcome('checkpoint', commit, ackPacket, null);
  }

  #applyCommit(packet) {
    if (this.#commit === null) fail('checkpoint-required');
    const header = packet.header;
    validateCommitProgression(this.#commit, header, this.#worldCodec);
    const world = applyJsonPatch(
      this.#worldState,
      attachment(packet, 'world_patch').value,
      this.#limits,
    );
    const commit = commitView('commit', header);
    const frameAttachment = optionalAttachment(packet, 'scene_frame');
    if (header.cause === 'tick' && frameAttachment === null) {
      fail('tick-scene-frame-required');
    }
    let candidate;
    if (frameAttachment) {
      const frame = parseSceneFrame(frameAttachment.bytes, {
        sourceTick: header.source_tick,
        limits: {
          maximumFrameBytes: this.#limits.maximumAttachmentBytes,
        },
      });
      candidate = this.#tree.prepareFrame(frame, commit);
    } else {
      candidate = this.#tree.prepareNoFrame(commit);
    }
    const events = frameAttachment
      ? sceneEventView(candidate.sceneEvents)
      : EMPTY_SCENE_EVENTS;
    const ackPacket = encodeEngineAck({
      streamId: commit.streamId,
      commitSeq: commit.commitSeq,
    }, this.#limits);
    this.#tree.commit(candidate);
    this.#worldState = world;
    this.#commit = commit;
    this.#schedule('commit', commit, candidate.plan, events);
    return outcome('commit', commit, ackPacket, null);
  }

  #applyInputResult(packet) {
    if (this.#commit === null) fail('checkpoint-required');
    const resultAttachment = optionalAttachment(packet, 'result_payload');
    const result = resultAttachment?.value ?? null;
    if (result && typeof result === 'object') deepFreezeOwned(result);
    const inputResult = Object.freeze({
      inputId: packet.header.input_id,
      status: packet.header.status,
      reasonCode: packet.header.reason_code,
      result,
    });
    return outcome('input_result', this.#commit, null, inputResult);
  }

  currentWorldState() { this.#requireOpen(); return this.#worldState; }
  currentCommit() { this.#requireOpen(); return this.#commit; }
  currentView() { this.#requireOpen(); return this.#commit ? this.#tree.currentView() : null; }
  getNode(displayId) { return this.currentView()?.getNode(displayId) ?? null; }
  getProfile(displayId) { return this.currentView()?.getProfile(displayId) ?? null; }
  getInteraction(displayId) { return this.currentView()?.getInteraction(displayId) ?? null; }
  getWorldPose(displayId, out) {
    const view = this.currentView();
    return view === null ? false : view.getWorldPose(displayId, out);
  }

  encodeInput({ inputId, command, args = {} } = {}) {
    this.#requireAvailable();
    if (this.#commit === null) fail('checkpoint-required');
    return encodeEngineInput({
      inputId,
      observedStreamId: this.#commit.streamId,
      observedCommitSeq: this.#commit.commitSeq,
      command,
      args,
    }, this.#limits);
  }

  capture() {
    this.#requireOpen();
    return Object.freeze({
      commit: this.#commit,
      worldState: this.#worldState,
      view: this.#commit ? this.#tree.currentView() : null,
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tree.dispose();
    this.#worldState = null;
    this.#worldCodec = null;
    this.#commit = null;
    this.#onCommit = null;
  }

  #schedule(kind, commit, plan, events) {
    if (this.#onCommit === null) return;
    const payload = Object.freeze({
      kind,
      commit,
      view: this.#tree.currentView(),
      plan,
      events,
    });
    queueMicrotask(() => {
      if (this.#disposed) return;
      try { this.#onCommit(payload); } catch { /* observers never roll back a commit */ }
    });
  }

  #requireOpen() { if (this.#disposed) fail('client-disposed'); }
  #requireAvailable() {
    this.#requireOpen();
    if (this.#failed) fail('client-failed');
  }
}

function validateCommitProgression(previous, header, worldCodec) {
  if (header.stream_id !== previous.streamId) fail('commit-stream-changed');
  if (header.world_codec !== worldCodec) fail('world-codec-changed');
  if (header.commit_seq !== previous.commitSeq + 1) fail('commit-sequence-gap');
  if (header.world_revision !== previous.worldRevision + 1) fail('world-revision-gap');
  const delta = header.source_tick - previous.sourceTick;
  if (header.cause === 'tick' ? delta !== 1
    : header.cause === 'input' ? delta !== 0 : ![0, 1].includes(delta)) {
    fail('source-tick-progression-invalid');
  }
}

function commitView(kind, header) {
  return Object.freeze({
    kind,
    streamId: header.stream_id,
    commitSeq: header.commit_seq,
    sourceTick: header.source_tick,
    worldRevision: header.world_revision,
    cause: kind === 'checkpoint' ? null : header.cause,
    causationId: kind === 'checkpoint' ? null : header.causation_id,
  });
}
function sceneEventView(events) {
  return events.length === 0 ? EMPTY_SCENE_EVENTS : Object.freeze([...events]);
}
function outcome(kind, commit, ackPacket, inputResult) {
  return Object.freeze({ kind, commit, ackPacket, inputResult });
}
function attachment(packet, kind) {
  const value = optionalAttachment(packet, kind);
  if (value === null) fail(`attachment-${kind}-missing`);
  return value;
}
function optionalAttachment(packet, kind) {
  return packet.attachments.find((value) => value.kind === kind) ?? null;
}
function deepFreezeOwned(value) {
  if (!value || typeof value !== 'object') return value;
  for (const item of Object.values(value)) deepFreezeOwned(item);
  return Object.freeze(value);
}
function fail(code) { throw new SceneEngineClientError(code); }

export {
  DEFAULT_ENGINE_LIMITS,
  encodeEngineAck,
  encodeEngineInput,
  readEnginePacket,
  readPacketLog,
};
