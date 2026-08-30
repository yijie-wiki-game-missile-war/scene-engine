#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { SceneEngineClient } from '../../js/packages/client/src/index.js';
import { createDisplayRuntime } from '../../js/packages/display/src/index.js';
import { createFakeRenderBackend } from '../../js/packages/display/src/testing/fake-render-backend.js';
import {
  COMMUNICATION_SCENE_ID,
  buildCommunicationCatalog,
} from './communication_catalog.mjs';

const MAXIMUM_FRAME_BYTES = 64 * 1024 * 1024;

class PassiveFrameAdapter {
  constructor() {
    this.next = 1;
    this.pending = new Set();
    this.requests = 0;
    this.executions = 0;
  }

  request() {
    const identity = this.next;
    this.next += 1;
    this.requests += 1;
    this.pending.add(identity);
    return identity;
  }

  cancel(identity) { this.pending.delete(identity); }
  now() { return 0; }
}

const probe = {
  runtime: null,
  frames: null,
  fakeBackend: null,
  sessionCount: 0,
};
const engineHash = createHash('sha256');
const ackHash = createHash('sha256');
let enginePacketCount = 0;
let engineBytes = 0;
let ackBytes = 0;

function createDisplaySession(metadata) {
  if (metadata.sceneName !== COMMUNICATION_SCENE_ID) {
    throw new Error(`unexpected communication scene: ${metadata.sceneName}`);
  }
  const catalog = buildCommunicationCatalog();
  const frames = new PassiveFrameAdapter();
  const fake = createFakeRenderBackend();
  const runtime = createDisplayRuntime({
    sceneRegistry: catalog.sceneRegistry,
    prefabRegistry: catalog.prefabRegistry,
    resourceRegistry: catalog.resourceRegistry,
    componentRegistry: catalog.componentRegistry,
    authorityStateSchemas: catalog.manifest.authorityStateSchemas,
    createRenderBackend: () => fake.backend,
    frameAdapter: frames,
  });
  probe.runtime = runtime;
  probe.frames = frames;
  probe.fakeBackend = fake;
  probe.sessionCount += 1;
  return {
    runtime,
    authorityPort: runtime.authority,
    commitGate: runtime.commitGate,
    dispose: () => runtime.dispose(),
  };
}

const client = new SceneEngineClient({ createDisplaySession });

function updateFramedHash(hash, payload) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(payload.byteLength, 0);
  hash.update(length);
  hash.update(payload);
}

async function writeFrame(payload) {
  const body = Buffer.from(payload);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.byteLength, 0);
  if (!process.stdout.write(Buffer.concat([header, body]))) await once(process.stdout, 'drain');
}

function canonicalTransformDigest(view) {
  const hash = createHash('sha256');
  const roots = view.snapshot().nodes
    .filter((node) => node.name.startsWith('py/'))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const node of roots) {
    hash.update(node.name);
    hash.update('\0');
    hash.update(node.localTransform.position.join(','));
    hash.update('\0');
    hash.update(node.localTransform.rotationXyzw.join(','));
    hash.update('\0');
    hash.update(node.localTransform.scale.join(','));
    hash.update('\0');
  }
  return { rootCount: roots.length, sha256: hash.digest('hex') };
}

async function finish() {
  const view = client.currentDisplayView();
  const transformDigest = canonicalTransformDigest(view);
  const finalCommit = client.currentCommit();
  const finalWorldState = client.currentWorldState();
  const displaySummary = probe.runtime.summary();
  const noRenderWork = {
    catalogResourceCount: 0,
    frameRequests: probe.frames.requests,
    frameExecutions: probe.frames.executions,
    pendingFrameCallbacks: probe.frames.pending.size,
    fakeBackendDraws: probe.fakeBackend.draws,
    fakeBackendBindings: probe.fakeBackend.bindings.size,
  };
  const runtimeRefs = {
    nodeIndex: probe.runtime._nodeIndex,
    scheduler: probe.runtime._scheduler,
    renderSystem: probe.runtime._renderSystem,
    animationSystem: probe.runtime._animationSystem,
  };
  client.dispose();
  await probe.runtime.dispose();
  const cleanup = {
    nodeCount: runtimeRefs.nodeIndex.size,
    schedulerHandlerCount: runtimeRefs.scheduler._registered.size,
    renderSystemEntryCount: runtimeRefs.renderSystem._entries.size,
    animationPlayerCount: runtimeRefs.animationSystem._players.size,
    pendingFrameCallbacks: probe.frames.pending.size,
    fakeBackendBindings: probe.fakeBackend.bindings.size,
    fakeBackendDisposed: probe.fakeBackend.backend.capture().disposed,
  };
  cleanup.returnedToZero = cleanup.nodeCount === 0
    && cleanup.schedulerHandlerCount === 0
    && cleanup.renderSystemEntryCount === 0
    && cleanup.animationPlayerCount === 0
    && cleanup.pendingFrameCallbacks === 0
    && cleanup.fakeBackendBindings === 0
    && cleanup.fakeBackendDisposed === true;
  const report = {
    schema: 'scene-engine-python-js-communication-peer@1',
    enginePacketCount,
    engineBytes,
    engineFramedSha256: engineHash.digest('hex'),
    ackBytes,
    ackFramedSha256: ackHash.digest('hex'),
    sessionCount: probe.sessionCount,
    finalCommit,
    finalWorldState,
    displaySummary,
    transformDigest,
    noRenderWork,
    cleanup,
  };
  await writeFrame(Buffer.from(JSON.stringify(report), 'utf8'));
}

async function handlePacket(payload) {
  updateFramedHash(engineHash, payload);
  enginePacketCount += 1;
  engineBytes += payload.byteLength;
  const outcome = client.applyPacket(new Uint8Array(payload));
  if (!(outcome.ackPacket instanceof Uint8Array)) {
    throw new Error(`packet ${enginePacketCount} did not synchronously produce ACK bytes`);
  }
  const ack = Buffer.from(outcome.ackPacket);
  updateFramedHash(ackHash, ack);
  ackBytes += ack.byteLength;
  await writeFrame(ack);
}

async function main() {
  const header = Buffer.allocUnsafe(4);
  let headerOffset = 0;
  let expectedLength = null;
  let payloadLength = 0;
  let payloadChunks = [];
  for await (const chunk of process.stdin) {
    let offset = 0;
    while (offset < chunk.length) {
      if (expectedLength === null) {
        const headerBytes = Math.min(4 - headerOffset, chunk.length - offset);
        chunk.copy(header, headerOffset, offset, offset + headerBytes);
        headerOffset += headerBytes;
        offset += headerBytes;
        if (headerOffset < 4) continue;
        expectedLength = header.readUInt32LE(0);
        headerOffset = 0;
        if (expectedLength > MAXIMUM_FRAME_BYTES) {
          throw new Error(`frame exceeds ${MAXIMUM_FRAME_BYTES} bytes`);
        }
        if (expectedLength === 0) {
          if (offset !== chunk.length) throw new Error('finish frame must be last');
          await finish();
          return;
        }
      }
      const payloadBytes = Math.min(expectedLength - payloadLength, chunk.length - offset);
      payloadChunks.push(chunk.subarray(offset, offset + payloadBytes));
      payloadLength += payloadBytes;
      offset += payloadBytes;
      if (payloadLength !== expectedLength) continue;
      const payload = payloadChunks.length === 1
        ? payloadChunks[0]
        : Buffer.concat(payloadChunks, expectedLength);
      await handlePacket(payload);
      expectedLength = null;
      payloadLength = 0;
      payloadChunks = [];
    }
  }
  if (expectedLength !== null || headerOffset !== 0) {
    throw new Error('communication peer input ended with a truncated frame');
  }
  throw new Error('communication peer input ended without a finish frame');
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
