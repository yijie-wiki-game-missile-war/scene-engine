import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_CHECKPOINT_SCHEMA,
  DISPLAY_COMMAND_STREAM_SCHEMA,
  NODE_COMMAND_SCHEMA,
  DisplayRecordError,
  encodeDisplayCheckpoint,
  encodeDisplayCommandStream,
  parseDisplayCheckpoint,
  parseDisplayCommandStream,
  takeOwnedDisplayMatrix,
} from '../src/display.js';
import { readEnginePacket } from '../src/wire.js';

const HASH_A = '01'.repeat(32);
const HASH_B = 'a5'.repeat(32);
const HASH_C = 'ff'.repeat(32);
const PYTHON_FIXTURES = fileURLToPath(new URL('../../../../fixtures/wire-v3/', import.meta.url));

function matrix(x = 0) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, -2.25, 9.5, 1,
  ]);
}

function shearMatrix(x = 0) {
  return new Float32Array([
    2, 0.25, 0, 0,
    0.5, 3, 0.75, 0,
    0, 0.5, 4, 0,
    x, -2.25, 9.5, 1,
  ]);
}

function baselineNode(name, parentName = null, value = matrix()) {
  return {
    name,
    parent_name: parentName,
    prefab_id: 'unit.example',
    transform_mode: 'live',
    transform: value,
    visible: true,
    state: { mode: 'idle', nested: { value: 3 } },
  };
}

function checkpoint(nodes = [baselineNode('py/root')]) {
  return {
    schema: DISPLAY_CHECKPOINT_SCHEMA,
    scene_name: 'main',
    scene_catalog_hash: HASH_A,
    prefab_catalog_hash: HASH_B,
    state_schema_hash: HASH_C,
    last_command_seq: 7,
    nodes,
  };
}

function command(kind, commandSeq, fields = {}) {
  return {
    schema: NODE_COMMAND_SCHEMA,
    command_seq: commandSeq,
    source_tick: 12,
    kind,
    name: fields.name ?? 'py/root',
    ...fields,
  };
}

function stream(commands) {
  return {
    schema: DISPLAY_COMMAND_STREAM_SCHEMA,
    base_command_seq: 7,
    last_command_seq: 7 + commands.length,
    commands,
  };
}

function checkpointMatrixOffset() {
  const sceneBytes = new TextEncoder().encode('main').byteLength;
  const nameBytes = new TextEncoder().encode('py/root').byteLength;
  const prefabBytes = new TextEncoder().encode('unit.example').byteLength;
  return 8 + 8 + 2 + sceneBytes + (3 * 32) + 4
    + 2 + nameBytes + 4 + 2 + prefabBytes + 1;
}

function parsedCheckpointToRecord(value) {
  return {
    schema: DISPLAY_CHECKPOINT_SCHEMA,
    scene_name: value.sceneName,
    scene_catalog_hash: value.sceneCatalogHash,
    prefab_catalog_hash: value.prefabCatalogHash,
    state_schema_hash: value.stateSchemaHash,
    last_command_seq: value.lastCommandSeq,
    nodes: value.nodes.map((node) => ({
      name: node.name,
      parent_name: node.parentName,
      prefab_id: node.prefabId,
      transform_mode: node.transformMode,
      transform: node.transform,
      visible: node.visible,
      state: node.state,
    })),
  };
}

function parsedCommandToRecord(commandValue) {
  const common = {
    schema: NODE_COMMAND_SCHEMA,
    command_seq: commandValue.commandSeq,
    source_tick: commandValue.sourceTick,
    kind: commandValue.kind,
    name: commandValue.name,
  };
  switch (commandValue.kind) {
    case 'node-create':
      return {
        ...common,
        parent_name: commandValue.parentName,
        prefab_id: commandValue.prefabId,
        transform_mode: commandValue.transformMode,
        transform: commandValue.transform,
        visible: commandValue.visible,
        state: commandValue.state,
      };
    case 'node-set-transform':
      return { ...common, transform: commandValue.transform };
    case 'node-set-parent':
      return { ...common, parent_name: commandValue.parentName };
    case 'node-set-visible':
      return { ...common, visible: commandValue.visible };
    case 'node-set-state':
      return { ...common, state: commandValue.state };
    case 'node-replace-prefab':
      return { ...common, prefab_id: commandValue.prefabId, state: commandValue.state };
    case 'node-remove':
      return common;
    default:
      throw new Error(`unexpected command kind: ${commandValue.kind}`);
  }
}

function rawAttachment(packet, kind) {
  return packet.attachments.find((attachment) => attachment.kind === kind).value;
}

test('binary Display v2 checkpoint preserves a shear matrix as owned Float32Array bytes', () => {
  const source = shearMatrix(17.75);
  const bytes = encodeDisplayCheckpoint(checkpoint([
    baselineNode('py/root', null, source),
    { ...baselineNode('py/root/child', 'py/root'), transform_mode: 'initial', visible: false },
  ]));
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'SDCP');
  assert.equal(bytes[4], 2);

  const parsed = parseDisplayCheckpoint(bytes, { header: { last_command_seq: 7 } });
  assert.equal(parsed.schema, 'scene-engine-display-checkpoint@5');
  assert.equal(parsed.sceneCatalogHash, HASH_A);
  assert.equal(parsed.prefabCatalogHash, HASH_B);
  assert.equal(parsed.stateSchemaHash, HASH_C);
  assert.equal(parsed.nodes[1].parentName, 'py/root');
  assert.equal(parsed.nodes[1].transformMode, 'initial');
  assert.equal(parsed.nodes[1].visible, false);
  assert.deepEqual(parsed.nodes[0].state, { mode: 'idle', nested: { value: 3 } });
  assert.ok(parsed.nodes[0].transform instanceof Float32Array);
  assert.deepEqual(parsed.nodes[0].transform, source);
  assert.notStrictEqual(parsed.nodes[0].transform, source);
  assert.notStrictEqual(parsed.nodes[0].transform.buffer, bytes.buffer);
  assert.notStrictEqual(parsed.nodes[0].transform.buffer, parsed.nodes[1].transform.buffer);

  const encodedAgain = encodeDisplayCheckpoint(parsedCheckpointToRecord(parsed));
  assert.deepEqual(encodedAgain, bytes, 'canonical matrix payload round-trips exact bytes');

  const first = parsed.nodes[0].transform[0];
  bytes.fill(0);
  assert.equal(parsed.nodes[0].transform[0], first, 'packet mutation cannot alias parsed matrix');
});

test('binary Display command stream covers every opcode without matrix decomposition', () => {
  const source = shearMatrix(2);
  const commands = [
    command('node-create', 8, {
      name: 'py/new', parent_name: null, prefab_id: 'unit.example', transform_mode: 'live',
      transform: shearMatrix(1), visible: true, state: { created: true },
    }),
    command('node-set-transform', 9, { transform: source }),
    command('node-set-parent', 10, { parent_name: 'py/new' }),
    command('node-set-visible', 11, { visible: false }),
    command('node-set-state', 12, { state: { mode: 'active' } }),
    command('node-replace-prefab', 13, { prefab_id: 'unit.replacement', state: { level: 2 } }),
    command('node-remove', 14),
  ];
  const bytes = encodeDisplayCommandStream(stream(commands), { sourceTick: 12 });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'SDCS');
  assert.equal(bytes[4], 2);
  const parsed = parseDisplayCommandStream(bytes, {
    header: { source_tick: 12, last_command_seq: 14 },
    baseCommandSeq: 7,
  });
  assert.equal(parsed.schema, 'scene-engine-display-command-stream@5');
  assert.deepEqual(parsed.commands.map(({ kind }) => kind), commands.map(({ kind }) => kind));
  assert.deepEqual(parsed.commands.map(({ commandSeq }) => commandSeq), [8, 9, 10, 11, 12, 13, 14]);
  assert.ok(parsed.commands.every(({ sourceTick }) => sourceTick === 12));
  assert.equal(parsed.commands[0].parentName, null);
  assert.ok(parsed.commands[0].transform instanceof Float32Array);
  assert.deepEqual(parsed.commands[1].transform, source);
  assert.notStrictEqual(parsed.commands[1].transform, source);
  assert.equal(parsed.commands[2].parentName, 'py/new');
  assert.equal(parsed.commands[3].visible, false);
  assert.deepEqual(parsed.commands[4].state, { mode: 'active' });
  assert.equal(parsed.commands[5].prefabId, 'unit.replacement');
});

test('canonical Python binary fixtures re-encode to exact Display bytes', async () => {
  const checkpointPacketValue = readEnginePacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/checkpoint.bin`),
  ));
  const checkpointBytes = rawAttachment(checkpointPacketValue, 'display_checkpoint');
  const parsedCheckpoint = parseDisplayCheckpoint(checkpointBytes, {
    header: checkpointPacketValue.header,
  });
  assert.equal(parsedCheckpoint.nodes[0].transform[4], 0.25);
  assert.deepEqual(
    encodeDisplayCheckpoint(parsedCheckpointToRecord(parsedCheckpoint)),
    checkpointBytes,
  );

  const commitPacketValue = readEnginePacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/commit-tick.bin`),
  ));
  const commandBytes = rawAttachment(commitPacketValue, 'display_command_stream');
  const parsedStream = parseDisplayCommandStream(commandBytes, {
    header: commitPacketValue.header,
    baseCommandSeq: parsedCheckpoint.lastCommandSeq,
  });
  const transformCommand = parsedStream.commands.find(
    ({ kind }) => kind === 'node-set-transform',
  );
  assert.equal(transformCommand.transform[4], 0.25);
  assert.equal(transformCommand.transform[12], 1.5);
  assert.deepEqual(encodeDisplayCommandStream({
    schema: DISPLAY_COMMAND_STREAM_SCHEMA,
    base_command_seq: parsedStream.baseCommandSeq,
    last_command_seq: parsedStream.lastCommandSeq,
    commands: parsedStream.commands.map(parsedCommandToRecord),
  }, { sourceTick: commitPacketValue.header.source_tick }), commandBytes);
});

test('matrix codec canonicalizes negative zero and rejects legacy TRS or ordinary arrays', () => {
  const negativeZero = matrix();
  for (const index of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12]) negativeZero[index] = -0;
  const bytes = encodeDisplayCheckpoint(checkpoint([baselineNode('py/root', null, negativeZero)]));
  const offset = checkpointMatrixOffset();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const index of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12]) {
    assert.equal(view.getUint32(offset + (index * 4), true), 0);
  }
  const parsed = parseDisplayCheckpoint(bytes, { header: { last_command_seq: 7 } });
  for (const value of parsed.nodes[0].transform) {
    if (value === 0) assert.equal(Object.is(value, -0), false);
  }

  const legacyTrs = {
    position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1],
  };
  for (const invalid of [legacyTrs, [...matrix()]]) {
    assert.throws(
      () => encodeDisplayCheckpoint(checkpoint([baselineNode('py/root', null, invalid)])),
      (error) => error.code === 'display-transform-matrix-invalid',
    );
  }
  assert.throws(() => encodeDisplayCommandStream({
    ...stream([]), schema: 'scene-engine-display-command-stream@4',
  }, { sourceTick: 12 }), (error) => error.code === 'display-command-stream-schema-invalid');
});

test('owned matrix transfer rejects arbitrary and already-consumed values', () => {
  const bytes = encodeDisplayCheckpoint(checkpoint());
  const parsed = parseDisplayCheckpoint(bytes, { header: { last_command_seq: 7 } });
  const owned = parsed.nodes[0].transform;
  assert.strictEqual(takeOwnedDisplayMatrix(owned), owned);
  assert.throws(() => takeOwnedDisplayMatrix(owned),
    (error) => error.code === 'display-transform-ownership-invalid');
  assert.throws(() => takeOwnedDisplayMatrix(matrix()),
    (error) => error.code === 'display-transform-ownership-invalid');
  assert.throws(() => takeOwnedDisplayMatrix({
    position: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: [1, 1, 1],
  }), (error) => error.code === 'display-transform-ownership-invalid');
});

test('binary Display parsers reject headers, topology, malformed matrices, and framing corruption', () => {
  const valid = encodeDisplayCheckpoint(checkpoint());
  for (const [offset, value, code] of [
    [0, 0, 'display-checkpoint-magic-invalid'],
    [4, 1, 'display-checkpoint-version-invalid'],
    [5, 2, 'display-checkpoint-scalar-invalid'],
    [6, 1, 'display-checkpoint-flags-invalid'],
  ]) {
    const corrupt = valid.slice();
    corrupt[offset] = value;
    assert.throws(() => parseDisplayCheckpoint(corrupt, { header: { last_command_seq: 7 } }),
      (error) => error instanceof DisplayRecordError && error.code === code);
  }

  const cursorMismatch = valid.slice();
  new DataView(cursorMismatch.buffer).setBigUint64(8, 8n, true);
  assert.throws(() => parseDisplayCheckpoint(cursorMismatch, { header: { last_command_seq: 7 } }),
    (error) => error.code === 'display-checkpoint-command-cursor-mismatch');

  const sceneBytes = new TextEncoder().encode('main').byteLength;
  const countOffset = 8 + 8 + 2 + sceneBytes + (3 * 32);
  const excessiveCount = valid.slice();
  new DataView(excessiveCount.buffer).setUint32(countOffset, 0xffffffff, true);
  assert.throws(() => parseDisplayCheckpoint(excessiveCount, { header: { last_command_seq: 7 } }),
    (error) => error.code === 'display-checkpoint-nodes-invalid');
  const nodeStart = countOffset + 4;
  const nameBytes = new TextEncoder().encode('py/root').byteLength;
  const parentOffset = nodeStart + 2 + nameBytes;
  const invalidParent = valid.slice();
  new DataView(invalidParent.buffer).setUint32(parentOffset, 0, true);
  assert.throws(() => parseDisplayCheckpoint(invalidParent, { header: { last_command_seq: 7 } }),
    (error) => error.code === 'display-checkpoint-parent-order-invalid');

  const prefabBytes = new TextEncoder().encode('unit.example').byteLength;
  const flagsOffset = parentOffset + 4 + 2 + prefabBytes;
  const invalidFlags = valid.slice();
  invalidFlags[flagsOffset] = 0x80;
  assert.throws(() => parseDisplayCheckpoint(invalidFlags, { header: { last_command_seq: 7 } }),
    (error) => error.code === 'display-checkpoint-node-flags-invalid');

  const matrixOffset = flagsOffset + 1;
  for (const [index, value] of [
    [0, Number.NaN],
    [3, 0.25],
    [0, -1],
    [0, 0],
  ]) {
    const malformed = valid.slice();
    new DataView(malformed.buffer).setFloat32(matrixOffset + (index * 4), value, true);
    assert.throws(() => parseDisplayCheckpoint(malformed, { header: { last_command_seq: 7 } }),
      (error) => error.code === 'display-transform-matrix-invalid');
  }

  assert.throws(() => parseDisplayCheckpoint(valid.subarray(0, valid.length - 1),
    { header: { last_command_seq: 7 } }));
  const trailing = new Uint8Array(valid.length + 1); trailing.set(valid);
  assert.throws(() => parseDisplayCheckpoint(trailing, { header: { last_command_seq: 7 } }),
    (error) => error.code === 'display-checkpoint-trailing-bytes');

  const commandBytes = encodeDisplayCommandStream(stream([command('node-remove', 8)]),
    { sourceTick: 12 });
  const tickMismatch = commandBytes.slice();
  new DataView(tickMismatch.buffer).setBigUint64(16, 13n, true);
  assert.throws(() => parseDisplayCommandStream(tickMismatch, {
    header: { source_tick: 12, last_command_seq: 8 }, baseCommandSeq: 7,
  }), (error) => error.code === 'display-command-source-tick-mismatch');
  const excessiveCommands = commandBytes.slice();
  new DataView(excessiveCommands.buffer).setUint32(24, 0xffffffff, true);
  assert.throws(() => parseDisplayCommandStream(excessiveCommands, {
    header: { source_tick: 12, last_command_seq: 8 }, baseCommandSeq: 7,
  }), (error) => error.code === 'display-command-list-invalid');
  const invalidOpcode = commandBytes.slice(); invalidOpcode[28] = 99;
  assert.throws(() => parseDisplayCommandStream(invalidOpcode, {
    header: { source_tick: 12, last_command_seq: 8 }, baseCommandSeq: 7,
  }), (error) => error.code === 'display-command-kind-invalid');
});
