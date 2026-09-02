import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SceneEngineClient, readPacketLog } from '../src/index.js';
import { sha256HexBytes } from '../src/hash.js';
import { readEnginePacket } from '../src/wire.js';
import {
  baselineNode,
  checkpointPacket,
  command,
  commitPacket,
  createMockDisplayFactory,
} from './support.mjs';

const ROOT = fileURLToPath(new URL('../fixtures/packet-log/', import.meta.url));

test('validates packet-log@3 command cursor and replays through sole Authority path', async () => {
  const log = readPacketLog(await files(ROOT));
  assert.equal(log.manifest.schema, 'scene-engine-packet-log@3');
  assert.equal(log.manifest.wire_schema, 'scene-engine-wire@3');
  assert.equal(log.entries.length, 4);
  assert.equal(log.manifest.checkpoint_count, 2);
  assert.deepEqual(log.entries.map(({ last_command_seq: value }) => value), [0, 11, 11, 11]);
  assert.deepEqual(log.records.map(({ packet }) => packet.kind), [
    'engine.checkpoint', 'engine.commit', 'engine.commit', 'engine.checkpoint',
  ]);

  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  for (const record of log.records) {
    if (record.entry.checkpoint && client.currentCommit() !== null) continue;
    client.applyPacket(record.rawBytes);
  }
  assert.equal(client.currentCommit().commitSeq, 2);
  assert.equal(client.currentCommit().lastCommandSeq, 11);
  assert.equal(client.currentWorldState().state.stable.value, 8);
  assert.deepEqual(sessions[0].log.map(([kind]) => kind), [
    'installScene', 'installNodeMatrixPool', 'createNode', 'createNode', 'createNode',
    'activate', 'start', 'summary',
    'begin', 'applyNodeTransformBatch', 'createNode', 'setNodeTransforms',
    'setNodeParent', 'setNodeVisible',
    'setNodeState', 'setNodeDisplayKind', 'setNodeProperty', 'setNodeProperty',
    'unsetNodeProperty', 'emitNodeEvent', 'removeNode', 'seal', 'summary',
    'begin', 'applyNodeTransformBatch', 'seal', 'summary',
  ]);
  assert.equal(sessions[0].log.filter(([kind]) => kind === 'emitNodeEvent').length, 1);
  assert.deepEqual(log.packetAt(0), log.records[0].rawBytes);
});

test('seek checkpoint constructs a fresh client/runtime at the indexed command cursor', async () => {
  const log = readPacketLog(await files(ROOT));
  const checkpoint = log.records.at(-1);
  assert.equal(checkpoint.entry.checkpoint, true);
  const { factory, sessions } = createMockDisplayFactory();
  const client = new SceneEngineClient({ createDisplaySession: factory });
  client.applyPacket(checkpoint.rawBytes);
  assert.equal(client.currentCommit().commitSeq, 2);
  assert.equal(client.currentCommit().lastCommandSeq, 11);
  assert.equal(sessions[0].log.some(([kind]) => kind === 'emitNodeEvent'), false);
  assert.equal(sessions.length, 1);
});

test('rejects malformed package-local packet log and legacy manifest', async () => {
  assert.throws(() => readPacketLog(awaitFilesSync(`${ROOT}/malformed`)));
  const values = await files(ROOT);
  const manifest = JSON.parse(new TextDecoder().decode(values.manifest));
  manifest.schema = 'scene-engine-packet-log@2';
  values.manifest = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  assert.throws(() => readPacketLog(values));
});

test('rejects same-cursor checkpoints that shrink or resurrect the matrix pool', () => {
  const initial = checkpointPacket({
    nodes: [baselineNode(0), baselineNode(1)],
    matrixPoolSize: 2,
  });
  const removed = commitPacket({
    commands: [command('node-remove', 1, 1, { node_id: 1 })],
    matrixPoolSize: 2,
  });
  const periodic = {
    commitSeq: 1,
    sourceTick: 1,
    worldRevision: 1,
    lastCommandSeq: 1,
  };
  const malicious = [
    checkpointPacket({ ...periodic, nodes: [baselineNode(0)], matrixPoolSize: 1 }),
    checkpointPacket({
      ...periodic,
      nodes: [baselineNode(0), baselineNode(1)],
      matrixPoolSize: 2,
    }),
  ];

  for (const checkpoint of malicious) {
    assert.throws(
      () => readPacketLog(packetLog([initial, removed, checkpoint])),
      { code: 'packet-log-periodic-checkpoint-matrix-pool-mismatch' },
    );
  }
});

test('rejects tiny sparse uint32 pool growth without suffix allocation', () => {
  const initial = checkpointPacket({ nodes: [], matrixPoolSize: 0 });
  const sparseGrowth = commitPacket({ commands: [], matrixPoolSize: 0xffffffff });
  assert.throws(
    () => readPacketLog(packetLog([initial, sparseGrowth])),
    { code: 'packet-log-matrix-pool-lifecycle-invalid' },
  );
});

async function files(root) {
  return {
    manifest: new Uint8Array(await readFile(`${root}/manifest.json`)),
    index: new Uint8Array(await readFile(`${root}/index.json`)),
    packets: new Uint8Array(await readFile(`${root}/packets.bin`)),
  };
}

function awaitFilesSync(root) {
  return {
    manifest: read(`${root}/manifest.json`),
    index: read(`${root}/index.json`),
    packets: read(`${root}/packets.bin`),
  };
}

function packetLog(packetValues) {
  const packetsBytes = packetValues.reduce((total, value) => total + 8 + value.byteLength, 0);
  const packets = new Uint8Array(packetsBytes);
  const entries = [];
  let cursor = 0;
  for (const rawBytes of packetValues) {
    new DataView(packets.buffer).setBigUint64(cursor, BigInt(rawBytes.byteLength), true);
    packets.set(rawBytes, cursor + 8);
    const packet = readEnginePacket(rawBytes);
    entries.push({
      stream_id: packet.header.stream_id,
      commit_seq: packet.header.commit_seq,
      source_tick: packet.header.source_tick,
      world_revision: packet.header.world_revision,
      offset: cursor + 8,
      packet_length: rawBytes.byteLength,
      checkpoint: packet.kind === 'engine.checkpoint',
      last_command_seq: packet.header.last_command_seq,
    });
    cursor += 8 + rawBytes.byteLength;
  }
  const index = jsonBytes(entries);
  const first = entries[0];
  const last = entries.at(-1);
  const manifest = jsonBytes({
    schema: 'scene-engine-packet-log@3',
    wire_schema: 'scene-engine-wire@3',
    complete: true,
    packet_count: entries.length,
    checkpoint_count: entries.filter(({ checkpoint }) => checkpoint).length,
    packets_bytes: packets.byteLength,
    packets_sha256: sha256HexBytes(packets),
    index_sha256: sha256HexBytes(index),
    stream_id: first.stream_id,
    first_commit_seq: first.commit_seq,
    last_commit_seq: last.commit_seq,
    first_source_tick: first.source_tick,
    last_source_tick: last.source_tick,
    first_command_seq: first.last_command_seq,
    last_command_seq: last.last_command_seq,
  });
  return { manifest, index, packets };
}

function jsonBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

import { readFileSync as read } from 'node:fs';
