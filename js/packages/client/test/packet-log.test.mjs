import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SceneEngineClient, readPacketLog } from '../src/index.js';
import { createMockDisplayFactory } from './support.mjs';

const ROOT = fileURLToPath(new URL('../fixtures/packet-log/', import.meta.url));

test('validates packet-log@2 command cursor and replays through sole Authority path', async () => {
  const log = readPacketLog(await files(ROOT));
  assert.equal(log.manifest.schema, 'scene-engine-packet-log@2');
  assert.equal(log.manifest.wire_schema, 'scene-engine-wire@2');
  assert.equal(log.entries.length, 4);
  assert.equal(log.manifest.checkpoint_count, 2);
  assert.deepEqual(log.entries.map(({ last_command_seq: value }) => value), [0, 7, 7, 7]);
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
  assert.equal(client.currentCommit().lastCommandSeq, 7);
  assert.equal(client.currentWorldState().state.stable.value, 8);
  assert.deepEqual(sessions[0].log.map(([kind]) => kind), [
    'installScene', 'createNode', 'createNode', 'activate', 'start', 'summary',
    'begin', 'createNode', 'setNodeTransform', 'setNodeParent', 'setNodeVisible',
    'setNodeState', 'replaceNodePrefab', 'removeNode', 'seal', 'summary',
    'begin', 'seal', 'summary',
  ]);
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
  assert.equal(client.currentCommit().lastCommandSeq, 7);
  assert.equal(sessions.length, 1);
});

test('rejects malformed package-local packet log and legacy manifest', async () => {
  assert.throws(() => readPacketLog(awaitFilesSync(`${ROOT}/malformed`)));
  const values = await files(ROOT);
  const manifest = JSON.parse(new TextDecoder().decode(values.manifest));
  manifest.schema = 'scene-engine-packet-log@1';
  values.manifest = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  assert.throws(() => readPacketLog(values));
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

import { readFileSync as read } from 'node:fs';
