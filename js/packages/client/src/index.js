import {
  parseDisplayCheckpoint,
  parseDisplayCommandStream,
  takeOwnedDisplayMatrixTensor,
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
  #applying = false;
  #cleanupAfterCommit = false;
  #commit = null;
  #createDisplaySession;
  #displaySession = null;
  #disposed = false;
  #failed = false;
  #lastCommandSeq = null;
  #limits;
  #matrixPoolSize = null;
  #onCommit;
  #retiredNodeIds = null;
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
    if (this.#applying) {
      if (!this.#cleanupAfterCommit) this.#failed = true;
      fail('client-apply-reentrant');
    }
    this.#applying = true;
    let packet;
    try {
      packet = readEnginePacket(rawBytes, this.#limits);
      let result;
      if (packet.kind === 'engine.checkpoint') result = this.#applyCheckpoint(packet);
      else if (packet.kind === 'engine.commit') result = this.#applyCommit(packet);
      else if (packet.kind === 'engine.input_result') result = this.#applyInputResult(packet);
      else if (packet.kind === 'engine.error') {
        this.#failed = true;
        throw new SceneEngineClientError('engine-error', packet.header.code);
      } else {
        throw new SceneEngineClientError('server-packet-kind-invalid');
      }
      this.#assertApplyCanCommit();
      return result;
    } catch (error) {
      this.#failed = true;
      if (error instanceof SceneEngineClientError) throw error;
      throw new SceneEngineClientError(
        error?.code ?? 'packet-apply-failed',
        error?.message ?? 'packet apply failed',
        { cause: error },
      );
    } finally {
      this.#applying = false;
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
      { header, maximumJsonDepth: this.#limits.maximumJsonDepth },
    );
    const retiredNodeIds = validateCheckpointMatrixPoolProgression(
      this.#matrixPoolSize,
      this.#retiredNodeIds,
      checkpoint,
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
      assertCatalogIdentity(candidate.runtime, Object.freeze({
        sceneCatalogHash: checkpoint.sceneCatalogHash,
        prefabCatalogHash: checkpoint.prefabCatalogHash,
        stateSchemaHash: checkpoint.stateSchemaHash,
      }));
      callSynchronous(
        candidate.runtime.installScene,
        candidate.runtime,
        [Object.freeze({ sceneName: checkpoint.sceneName })],
        'display-install-scene-async',
      );
      callAuthority(
        candidate.authorityPort,
        'installNodeMatrixPool',
        checkpointMatrixPoolPayload(checkpoint),
      );
      for (const node of checkpoint.nodes) {
        callAuthority(candidate.authorityPort, 'createNode', authorityNodePayload(node));
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
      this.#assertApplyCanCommit();
      const previous = this.#displaySession;
      this.#displaySession = candidate;
      this.#worldState = world;
      this.#worldCodec = header.world_codec;
      this.#commit = commit;
      this.#lastCommandSeq = checkpoint.lastCommandSeq;
      this.#matrixPoolSize = checkpoint.matrixPoolSize;
      this.#retiredNodeIds = retiredNodeIds;
      this.#cleanupAfterCommit = true;
      try { safeDispose(previous); } finally { this.#cleanupAfterCommit = false; }
      this.#assertApplyCanCommit();
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
        maximumJsonDepth: this.#limits.maximumJsonDepth,
      },
    );
    validateMatrixPoolProgression(this.#matrixPoolSize, stream);
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
      callAuthority(
        session.authorityPort,
        'applyNodeTransformBatch',
        commandMatrixBatchPayload(stream),
      );
      let removedNodeIds = null;
      for (const command of stream.commands) {
        callAuthority(
          session.authorityPort,
          AUTHORITY_METHOD[command.kind],
          authorityPayload(command),
        );
        if (command.kind === 'node-remove') {
          if (removedNodeIds === null) removedNodeIds = [];
          removedNodeIds.push(command.nodeId);
        }
      }
      callSynchronous(
        session.commitGate.seal,
        session.commitGate,
        [cursor],
        'display-gate-seal-async',
      );
      this.#assertApplyCanCommit();
      this.#worldState = world;
      this.#commit = commit;
      this.#lastCommandSeq = stream.lastCommandSeq;
      this.#matrixPoolSize = stream.matrixPoolSize;
      if (removedNodeIds !== null) {
        for (const nodeId of removedNodeIds) this.#retiredNodeIds.add(nodeId);
      }
      const displaySummary = provideDisplaySummary(session);
      this.#assertApplyCanCommit();
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
    this.#matrixPoolSize = null;
    this.#retiredNodeIds = null;
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
  #assertApplyCanCommit() {
    this.#requireOpen();
    if (this.#failed) fail('client-apply-reentrant');
  }
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

function validateMatrixPoolProgression(previousSize, stream) {
  if (!Number.isSafeInteger(previousSize) || stream.matrixPoolSize < previousSize) {
    fail('display-matrix-pool-progression-invalid');
  }
  const growth = stream.matrixPoolSize - previousSize;
  if (growth > stream.dirtyNodeIds.length) {
    fail('display-matrix-pool-progression-invalid');
  }
  const firstNew = stream.dirtyNodeIds.length - growth;
  for (let offset = 0; offset < growth; offset += 1) {
    if (stream.dirtyNodeIds[firstNew + offset] !== previousSize + offset) {
      fail('display-matrix-pool-progression-invalid');
    }
  }
  const createdIds = growth === 0 ? null : new Set();
  for (const command of stream.commands) {
    if (command.kind !== 'node-create') continue;
    if (command.nodeId < previousSize || createdIds === null) {
      fail('display-matrix-pool-progression-invalid');
    }
    createdIds.add(command.nodeId);
  }
  for (let nodeId = previousSize; nodeId < stream.matrixPoolSize; nodeId += 1) {
    if (!createdIds.has(nodeId)) {
      fail('display-matrix-pool-progression-invalid');
    }
  }
}

function validateCheckpointMatrixPoolProgression(previousSize, previousRetiredIds, checkpoint) {
  if (previousSize !== null && (
    !Number.isSafeInteger(previousSize)
      || checkpoint.matrixPoolSize < previousSize
      || !(previousRetiredIds instanceof Set)
  )) {
    fail('display-matrix-pool-progression-invalid');
  }
  const activeIds = new Set();
  for (const node of checkpoint.nodes) {
    if (previousRetiredIds?.has(node.nodeId)) {
      fail('display-matrix-pool-progression-invalid');
    }
    activeIds.add(node.nodeId);
  }
  const retiredIds = new Set(previousRetiredIds ?? []);
  for (let nodeId = 0; nodeId < checkpoint.matrixPoolSize; nodeId += 1) {
    if (!activeIds.has(nodeId)) retiredIds.add(nodeId);
  }
  return retiredIds;
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
  for (const key of ['runtime', 'authorityPort', 'commitGate', 'dispose']) {
    if (!Object.hasOwn(value, key)) fail('display-session-fields-invalid');
  }
  requireMethods(
    value.runtime,
    ['catalogIdentity', 'installScene', 'activate', 'start', 'summary', 'currentView'],
    'display-session-runtime-invalid',
  );
  requireMethods(value.authorityPort, [
    'installNodeMatrixPool',
    'applyNodeTransformBatch',
    ...Object.values(AUTHORITY_METHOD),
  ], 'authority-port-invalid');
  requireMethods(value.commitGate, ['begin', 'seal', 'fail'], 'display-commit-gate-invalid');
  if (typeof value.dispose !== 'function') fail('display-session-dispose-invalid');
  return Object.freeze({
    runtime: value.runtime,
    authorityPort: value.authorityPort,
    commitGate: value.commitGate,
    dispose: () => value.dispose.call(value),
  });
}

function assertCatalogIdentity(runtime, expected) {
  const actual = callSynchronous(
    runtime.catalogIdentity,
    runtime,
    [],
    'display-catalog-identity-async',
  );
  requireRecord(actual, 'display-catalog-identity-invalid');
  const fields = ['sceneCatalogHash', 'prefabCatalogHash', 'stateSchemaHash'];
  const keys = Reflect.ownKeys(actual);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail('display-catalog-identity-invalid');
  }
  for (const field of fields) {
    if (typeof actual[field] !== 'string' || !/^[0-9a-f]{64}$/u.test(actual[field])) {
      fail('display-catalog-identity-invalid');
    }
    if (actual[field] !== expected[field]) fail('display-catalog-identity-mismatch');
  }
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
      return authorityNodePayload(command);
    case 'node-set-transform':
      return Object.freeze({ nodeId: command.nodeId });
    case 'node-set-parent':
      return Object.freeze({ nodeId: command.nodeId, parentNodeId: command.parentNodeId });
    case 'node-set-visible':
      return Object.freeze({ nodeId: command.nodeId, visible: command.visible });
    case 'node-set-state':
      return Object.freeze({ nodeId: command.nodeId, state: command.state });
    case 'node-replace-prefab':
      return Object.freeze({
        nodeId: command.nodeId,
        prefabId: command.prefabId,
        state: command.state,
      });
    case 'node-remove':
      return Object.freeze({ nodeId: command.nodeId });
    default:
      fail('display-command-kind-invalid');
  }
}

function authorityNodePayload(node) {
  return Object.freeze({
    nodeId: node.nodeId,
    parentNodeId: node.parentNodeId,
    prefabId: node.prefabId,
    transformMode: node.transformMode,
    visible: node.visible,
    state: node.state,
  });
}

function checkpointMatrixPoolPayload(checkpoint) {
  return Object.freeze({
    poolSize: checkpoint.matrixPoolSize,
    matrices: takeOwnedDisplayMatrixTensor(checkpoint.matrixPool),
  });
}

function commandMatrixBatchPayload(stream) {
  return Object.freeze({
    poolSize: stream.matrixPoolSize,
    nodeIds: stream.dirtyNodeIds,
    matrices: takeOwnedDisplayMatrixTensor(stream.dirtyMatrices),
  });
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
