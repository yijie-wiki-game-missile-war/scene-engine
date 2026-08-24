import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { encodeEngineAck, encodePacket } from '../src/wire.js';
import {
  STREAM_ID,
  baselineNode,
  checkpointPacket,
  command,
  commitPacket,
  transform,
} from '../test/support.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WIRE = `${ROOT}/fixtures/wire-v2`;
const LOG = `${ROOT}/fixtures/packet-log`;

for (const target of [WIRE, LOG]) {
  rmSync(target, { force: true, recursive: true });
  mkdirSync(target, { recursive: true });
}

const checkpoint = checkpointPacket({
  worldSnapshot: { tick: 0, world_revision: 0, state: { value: 7 } },
});
const tick = commitPacket({
  commands: [
    command('node-set-transform', 1, 1, { transform: transform(1.5) }),
    command('node-set-state', 2, 1, { state: { mode: 'active' } }),
  ],
  worldPatch: {
    schema: 'scene-engine-json-tree@1',
    changes: [
      { op: 'set', path: ['tick'], value: 1 },
      { op: 'set', path: ['world_revision'], value: 1 },
    ],
  },
});
const inputCommit = commitPacket({
  commitSeq: 2,
  sourceTick: 1,
  worldRevision: 2,
  baseCommandSeq: 2,
  commands: [],
  cause: 'input',
  causationId: 'client-a:1',
  worldPatch: {
    schema: 'scene-engine-json-tree@1',
    changes: [
      { op: 'set', path: ['state', 'value'], value: 8 },
      { op: 'set', path: ['world_revision'], value: 2 },
    ],
  },
});
const periodic = checkpointPacket({
  commitSeq: 2,
  sourceTick: 1,
  worldRevision: 2,
  lastCommandSeq: 2,
  worldSnapshot: { tick: 1, world_revision: 2, state: { value: 8 } },
  nodes: [{
    ...baselineNode(),
    transform: transform(1.5),
    state: { mode: 'active' },
  }],
});
const input = encodePacket('engine.input', {
  schema: 'scene-engine-wire@2',
  type: 'engine.input',
  input_id: 'client-a:2',
  observed_stream_id: STREAM_ID,
  observed_commit_seq: 2,
  command: 'example.set',
}, [{ kind: 'input_payload', encoding: 'json', value: { value: 1.5 } }]);
const inputResult = encodePacket('engine.input_result', {
  schema: 'scene-engine-wire@2',
  type: 'engine.input_result',
  input_id: 'client-a:2',
  status: 'no-op',
  reason_code: 'unchanged',
}, [{ kind: 'result_payload', encoding: 'json', value: { value: 1 } }]);
const ack = encodeEngineAck({
  streamId: STREAM_ID,
  commitSeq: 2,
  lastCommandSeq: 2,
});

for (const [name, bytes] of Object.entries({
  'checkpoint.bin': checkpoint,
  'commit-tick.bin': tick,
  'commit-input.bin': inputCommit,
  'input.bin': input,
  'input-result.bin': inputResult,
  'ack.bin': ack,
})) writeFileSync(`${WIRE}/${name}`, bytes);

const records = [checkpoint, tick, inputCommit, periodic];
const entries = [];
const chunks = [];
let offset = 0;
for (const [index, bytes] of records.entries()) {
  const prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setBigUint64(0, BigInt(bytes.byteLength), true);
  chunks.push(prefix, bytes);
  offset += prefix.byteLength;
  const packet = index === 0 ? { commit: 0, tick: 0, revision: 0, command: 0 }
    : index === 1 ? { commit: 1, tick: 1, revision: 1, command: 2 }
      : { commit: 2, tick: 1, revision: 2, command: 2 };
  entries.push({
    stream_id: STREAM_ID,
    commit_seq: packet.commit,
    source_tick: packet.tick,
    world_revision: packet.revision,
    offset,
    packet_length: bytes.byteLength,
    checkpoint: index === 0 || index === 3,
    last_command_seq: packet.command,
  });
  offset += bytes.byteLength;
}
const packets = concat(chunks);
const indexBytes = canonical(entries);
const manifest = {
  schema: 'scene-engine-packet-log@2',
  wire_schema: 'scene-engine-wire@2',
  complete: true,
  packet_count: records.length,
  checkpoint_count: 2,
  packets_bytes: packets.byteLength,
  packets_sha256: sha256(packets),
  index_sha256: sha256(indexBytes),
  stream_id: STREAM_ID,
  first_commit_seq: 0,
  last_commit_seq: 2,
  first_source_tick: 0,
  last_source_tick: 1,
  first_command_seq: 0,
  last_command_seq: 2,
};
writeFileSync(`${LOG}/packets.bin`, packets);
writeFileSync(`${LOG}/index.json`, indexBytes);
writeFileSync(`${LOG}/manifest.json`, canonical(manifest));

const malformed = `${LOG}/malformed`;
mkdirSync(malformed);
for (const name of ['manifest.json', 'index.json']) cpSync(`${LOG}/${name}`, `${malformed}/${name}`);
const validPackets = readFileSync(`${LOG}/packets.bin`);
writeFileSync(`${malformed}/packets.bin`, validPackets.subarray(0, validPackets.length - 1));

function canonical(value) {
  return new TextEncoder().encode(`${JSON.stringify(sort(value))}\n`);
}

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function concat(values) {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let cursor = 0;
  for (const value of values) {
    output.set(value, cursor);
    cursor += value.byteLength;
  }
  return output;
}
