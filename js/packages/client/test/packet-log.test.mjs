import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SceneEngineClient, readPacketLog } from '../src/index.js';

const ROOT = fileURLToPath(new URL('../fixtures/packet-log/', import.meta.url));

test('validates exact packet log and replays through the sole client path', async () => {
  const log = readPacketLog(await files(ROOT));
  assert.equal(log.manifest.schema, 'scene-engine-packet-log@1');
  assert.equal(log.entries.length, 4);
  assert.equal(log.manifest.checkpoint_count, 2);
  assert.deepEqual(log.records.map(({ packet }) => packet.kind), [
    'engine.checkpoint', 'engine.commit', 'engine.commit', 'engine.checkpoint',
  ]);
  const client = new SceneEngineClient();
  for (const record of log.records) {
    if (record.entry.checkpoint && client.currentCommit() !== null) continue;
    client.applyPacket(record.rawBytes);
  }
  assert.equal(client.currentCommit().commitSeq, 2);
  assert.equal(client.currentWorldState().state.stable.value, 8);
  assert.deepEqual(log.packetAt(0), log.records[0].rawBytes);
});

test('rejects a malformed package-local packet log', async () => {
  assert.throws(() => readPacketLog(awaitFilesSync(`${ROOT}/malformed`)));
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
