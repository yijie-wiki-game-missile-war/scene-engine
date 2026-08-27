import {
  parseDisplayCheckpoint,
  parseDisplayCommandStream,
} from './display.js';
import { applyJsonPatch, prepareJsonSnapshot } from './json-tree.js';
import { readPacketLog } from './packet-log.js';
import {
  DEFAULT_ENGINE_LIMITS,
  encodeEngineAck,
  encodeEngineInput,
  readEnginePacket,
} from './wire.js';

const AUTHORITY_METHOD = Object.freeze({
  'node-create': 'createNode',
  'node-set-transform': 'setNodeTransform',
  'node-set-parent': 'setNodeParent',
  'node-set-visible': 'setNodeVisible',
  'node-set-state': 'setNodeState',
  'node-replace-prefab': 'replaceNodePrefab',
  'node-remove': 'removeNode',
});

export class SceneEngineClientError extends Error {
  constructor(code, message = code, options = undefined) {
    super(message, options);
    this.name = 'SceneEngineClientError';
    this.code = code;
  }
}

export class SceneEngineClient {
  #commit = null;
  #createDisplaySession;
  #displaySession = null;
  #disposed = false;
  #failed = false;
  #lastCommandSeq = null;
  #limits;
  #onCommit;
  #worldCodec = null;
  #worldState = null;

  constructor({
    limits = DEFAULT_ENGINE_LIMITS,
    onCommit = null,
    createDisplaySession,
  } = {}) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
      fail('client-limits-invalid');
    }
    if (onCommit !== null && typeof onCommit !== 'function') {
      fail('client-on-commit-invalid');
    }
    if (typeof createDisplaySession !== 'function') {
      fail('client-display-session-factory-invalid');
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
    this.#createDisplaySession = createDisplaySession;
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
          || header.world_revision < this.#commit.worldRevision
          || header.last_command_seq < this.#lastCommandSeq) {
        fail('checkpoint-cursor-not-higher');
      }
      if (header.world_codec !== this.#worldCodec) fail('world-codec-changed');
    }
    const world = prepareJsonSnapshot(
      attachment(packet, 'world_snapshot').value,
      this.#limits,
    );
    const checkpoint = parseDisplayCheckpoint(
      attachment(packet, 'display_checkpoint').value,
      { header },
    );
    const commit = commitView('checkpoint', header);
    const cursor = displayCursor(commit);
    let candidate = null;
    try {
      candidate = callSynchronous(
        this.#createDisplaySession,
        undefined,
        [Object.freeze({
          sceneName: checkpoint.sceneName,
          sceneCatalogHash: checkpoint.sceneCatalogHash,
          prefabCatalogHash: checkpoint.prefabCatalogHash,
          stateSchemaHash: checkpoint.stateSchemaHash,
          commit,
        })],
        'display-session-factory-async',
      );
      candidate = createSession(candidate);
      callSynchronous(
        candidate.runtime.installScene,
        candidate.runtime,
        [Object.freeze({ sceneName: checkpoint.sceneName })],
        'display-install-scene-async',
      );
      for (const node of checkpoint.nodes) {
        callAuthority(candidate.authorityPort, 'createNode', node);
      }
      callSynchronous(
        candidate.runtime.activate,
        candidate.runtime,
        [cursor],
        'display-activate-async',
      );
      callSynchronous(
        candidate.runtime.start,
        candidate.runtime,
        [],
        'display-start-async',
      );
      const displaySummary = provideDisplaySummary(candidate);
      const ackPacket = encodeEngineAck({
        streamId: commit.streamId,
        commitSeq: commit.commitSeq,
        lastCommandSeq: commit.lastCommandSeq,
      }, this.#limits);
      const previous = this.#displaySession;
      this.#displaySession = candidate;
      this.#worldState = world;
      this.#worldCodec = header.world_codec;
      this.#commit = commit;
      this.#lastCommandSeq = checkpoint.lastCommandSeq;
      safeDispose(previous);
      this.#schedule('checkpoint', commit, world, displaySummary);
      return outcome('checkpoint', commit, ackPacket, null);
    } catch (error) {
      safeDispose(candidate);
      throw error;
    }
  }

  #applyCommit(packet) {
    if (this.#commit === null) fail('checkpoint-required');
    const header = packet.header;
    validateCommitProgression(this.#commit, header, this.#worldCodec);
    const stream = parseDisplayCommandStream(
      attachment(packet, 'display_command_stream').value,
      {
        header,
        baseCommandSeq: this.#lastCommandSeq,
      },
    );
    const world = applyJsonPatch(
      this.#worldState,
      attachment(packet, 'world_patch').value,
      this.#limits,
    );
    const commit = commitView('commit', header);
    const cursor = displayCursor(commit);
    const session = this.#displaySession;
    let gateBegun = false;
    try {
      callSynchronous(
        session.commitGate.begin,
        session.commitGate,
        [cursor],
        'display-gate-begin-async',
      );
      gateBegun = true;
      for (const command of stream.commands) {
        callAuthority(
          session.authorityPort,
          AUTHORITY_METHOD[command.kind],
          authorityPayload(command),
        );
      }
      callSynchronous(
        session.commitGate.seal,
        session.commitGate,
        [cursor],
        'display-gate-seal-async',
      );
      this.#worldState = world;
      this.#commit = commit;
      this.#lastCommandSeq = stream.lastCommandSeq;
      const displaySummary = provideDisplaySummary(session);
      const ackPacket = encodeEngineAck({
        streamId: commit.streamId,
        commitSeq: commit.commitSeq,
        lastCommandSeq: commit.lastCommandSeq,
      }, this.#limits);
      this.#schedule('commit', commit, world, displaySummary);
      return outcome('commit', commit, ackPacket, null);
    } catch (error) {
      if (gateBegun) safeGateFail(session, error);
      throw error;
    }
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
  currentDisplayView() {
    this.#requireOpen();
    return this.#displaySession === null ? null : provideCurrentDisplayView(this.#displaySession);
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
      displayView: this.currentDisplayView(),
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    safeDispose(this.#displaySession);
    this.#displaySession = null;
    this.#worldState = null;
    this.#worldCodec = null;
    this.#commit = null;
    this.#lastCommandSeq = null;
    this.#createDisplaySession = null;
    this.#onCommit = null;
  }

  #schedule(kind, commit, worldState, displaySummary) {
    if (this.#onCommit === null) return;
    const payload = Object.freeze({ kind, commit, worldState, displaySummary });
    try {
      queueMicrotask(() => {
        if (this.#disposed) return;
        try { this.#onCommit(payload); } catch { /* observers never roll back a commit */ }
      });
    } catch { /* observer scheduling never rolls back a commit or withholds its ACK */ }
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
  if (header.last_command_seq < previous.lastCommandSeq) {
    fail('display-command-cursor-regressed');
  }
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
    lastCommandSeq: header.last_command_seq,
    cause: kind === 'checkpoint' ? null : header.cause,
    causationId: kind === 'checkpoint' ? null : header.causation_id,
  });
}

function displayCursor(commit) {
  return Object.freeze({
    commitSeq: commit.commitSeq,
    sourceTick: commit.sourceTick,
    lastCommandSeq: commit.lastCommandSeq,
  });
}

function createSession(value) {
  requireSynchronousResult(value, 'display-session-factory-async');
  requireRecord(value, 'display-session-invalid');
  const expected = new Set([
    'runtime', 'authorityPort', 'commitGate', 'dispose',
  ]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size
      || keys.some((key) => typeof key !== 'string' || !expected.has(key))) {
    fail('display-session-fields-invalid');
  }
  requireMethods(
    value.runtime,
    ['installScene', 'activate', 'start', 'summary', 'currentView'],
    'display-session-runtime-invalid',
  );
  requireMethods(value.authorityPort, Object.values(AUTHORITY_METHOD), 'authority-port-invalid');
  requireMethods(value.commitGate, ['begin', 'seal', 'fail'], 'display-commit-gate-invalid');
  if (typeof value.dispose !== 'function') fail('display-session-dispose-invalid');
  return value;
}

function callAuthority(authorityPort, method, record) {
  if (!method) fail('display-command-kind-invalid');
  return callSynchronous(
    authorityPort[method],
    authorityPort,
    [record],
    'authority-operation-async',
  );
}

function authorityPayload(command) {
  switch (command.kind) {
    case 'node-create':
      return Object.freeze({
        name: command.name,
        parentName: command.parentName,
        prefabId: command.prefabId,
        transformMode: command.transformMode,
        transform: command.transform,
        visible: command.visible,
        state: command.state,
      });
    case 'node-set-transform':
      return Object.freeze({ name: command.name, transform: command.transform });
    case 'node-set-parent':
      return Object.freeze({ name: command.name, parentName: command.parentName });
    case 'node-set-visible':
      return Object.freeze({ name: command.name, visible: command.visible });
    case 'node-set-state':
      return Object.freeze({ name: command.name, state: command.state });
    case 'node-replace-prefab':
      return Object.freeze({
        name: command.name,
        prefabId: command.prefabId,
        state: command.state,
      });
    case 'node-remove':
      return Object.freeze({ name: command.name });
    default:
      fail('display-command-kind-invalid');
  }
}

function callSynchronous(method, receiver, args, asyncCode) {
  const result = method.apply(receiver, args);
  return requireSynchronousResult(result, asyncCode);
}

function provideDisplaySummary(session) {
  return requireSynchronousResult(session.runtime.summary(), 'display-summary-async');
}

function provideCurrentDisplayView(session) {
  return requireSynchronousResult(session.runtime.currentView(), 'display-current-view-async');
}

function safeGateFail(session, error) {
  try {
    const result = session.commitGate.fail(error);
    if (isThenable(result)) observeThenable(result);
  } catch { /* the original projection error is authoritative */ }
}

function safeDispose(session) {
  if (session === null) return;
  try {
    const result = session.dispose();
    if (isThenable(result)) observeThenable(result);
  } catch { /* replacement/dispose cleanup cannot roll back the new session */ }
}

function requireSynchronousResult(value, asyncCode) {
  if (!isThenable(value)) return value;
  observeThenable(value);
  fail(asyncCode);
}

function observeThenable(value) {
  void Promise.resolve(value).catch(() => {});
}

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function requireMethods(value, methods, code) {
  requireRecord(value, code);
  for (const method of methods) if (typeof value[method] !== 'function') fail(code);
}

function requireRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
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
