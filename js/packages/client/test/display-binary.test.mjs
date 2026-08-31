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
  takeOwnedDisplayMatrixTensor,
} from '../src/display.js';
import { readEnginePacket } from '../src/wire.js';

const HASH_A = '01'.repeat(32);
const HASH_B = 'a5'.repeat(32);
const HASH_C = 'ff'.repeat(32);
const PYTHON_FIXTURES = fileURLToPath(new URL('../../../../fixtures/wire-v3/', import.meta.url));
const MATRIX_LENGTH = 16;
const MATRIX_BYTES = MATRIX_LENGTH * 4;

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

function matrixPool(size, entries) {
  const result = new Float32Array(size * MATRIX_LENGTH);
  for (const [id, value] of entries) result.set(value, id * MATRIX_LENGTH);
  return result;
}

function baselineNode(nodeId, parentNodeId = null) {
  return {
    node_id: nodeId,
    parent_node_id: parentNodeId,
    prefab_id: 'unit.example',
    transform_mode: 'live',
    visible: true,
    state: { mode: 'idle', nested: { value: 3 } },
  };
}

function checkpoint({
  nodes = [baselineNode(0)],
  poolSize = 1,
  matrices = matrixPool(poolSize, [[0, matrix()]]),
} = {}) {
  return {
    schema: DISPLAY_CHECKPOINT_SCHEMA,
    scene_name: 'main',
    scene_catalog_hash: HASH_A,
    prefab_catalog_hash: HASH_B,
    state_schema_hash: HASH_C,
    last_command_seq: 7,
    matrix_pool_size: poolSize,
    matrix_pool: matrices,
    nodes,
  };
}

function command(kind, commandSeq, fields = {}) {
  const common = {
    schema: NODE_COMMAND_SCHEMA,
    command_seq: commandSeq,
    source_tick: 12,
    kind,
  };
  return kind === 'node-set-transform-batch'
    ? { ...common, ...fields, node_ids: fields.node_ids }
    : { ...common, node_id: fields.node_id ?? 0, ...fields };
}

function stream(commands, {
  poolSize = 3,
  dirtyNodeIds = new Uint32Array(),
  dirtyMatrices = new Float32Array(),
} = {}) {
  return {
    schema: DISPLAY_COMMAND_STREAM_SCHEMA,
    base_command_seq: 7,
    last_command_seq: 7 + commands.length,
    matrix_pool_size: poolSize,
    dirty_node_ids: dirtyNodeIds,
    dirty_matrices: dirtyMatrices,
    commands,
  };
}

function parsedCheckpointToRecord(value) {
  return {
    schema: DISPLAY_CHECKPOINT_SCHEMA,
    scene_name: value.sceneName,
    scene_catalog_hash: value.sceneCatalogHash,
    prefab_catalog_hash: value.prefabCatalogHash,
    state_schema_hash: value.stateSchemaHash,
    last_command_seq: value.lastCommandSeq,
    matrix_pool_size: value.matrixPoolSize,
    matrix_pool: value.matrixPool,
    nodes: value.nodes.map((node) => ({
      node_id: node.nodeId,
      parent_node_id: node.parentNodeId,
      prefab_id: node.prefabId,
      transform_mode: node.transformMode,
      visible: node.visible,
      state: node.state,
    })),
  };
}

function parsedCommandToRecord(value) {
  const common = {
    schema: NODE_COMMAND_SCHEMA,
    command_seq: value.commandSeq,
    source_tick: value.sourceTick,
    kind: value.kind,
  };
  if (value.kind === 'node-set-transform-batch') {
    return { ...common, node_ids: value.nodeIds };
  }
  const nodeCommon = { ...common, node_id: value.nodeId };
  switch (value.kind) {
    case 'node-create':
      return {
        ...nodeCommon,
        parent_node_id: value.parentNodeId,
        prefab_id: value.prefabId,
        transform_mode: value.transformMode,
        visible: value.visible,
        state: value.state,
      };
    case 'node-set-parent':
      return { ...nodeCommon, parent_node_id: value.parentNodeId };
    case 'node-set-visible':
      return { ...nodeCommon, visible: value.visible };
    case 'node-set-state':
      return { ...nodeCommon, state: value.state };
    case 'node-replace-prefab':
      return { ...nodeCommon, prefab_id: value.prefabId, state: value.state };
    case 'node-remove':
      return nodeCommon;
    default:
      throw new Error(`unexpected command kind: ${value.kind}`);
  }
}

function parsedStreamToRecord(value) {
  return {
    schema: DISPLAY_COMMAND_STREAM_SCHEMA,
    base_command_seq: value.baseCommandSeq,
    last_command_seq: value.lastCommandSeq,
    matrix_pool_size: value.matrixPoolSize,
    dirty_node_ids: value.dirtyNodeIds,
    dirty_matrices: value.dirtyMatrices,
    commands: value.commands.map(parsedCommandToRecord),
  };
}

function rawAttachment(packet, kind) {
  return packet.attachments.find((attachment) => attachment.kind === kind).value;
}

test('binary Display v4 checkpoint decodes one owned pool tensor and ID metadata', () => {
  const source = matrixPool(3, [[0, shearMatrix(17.75)], [2, matrix(4)]]);
  const bytes = encodeDisplayCheckpoint(checkpoint({
    poolSize: 3,
    matrices: source,
    nodes: [baselineNode(0), { ...baselineNode(2, 0), transform_mode: 'initial', visible: false }],
  }));
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'SDCP');
  assert.equal(bytes[4], 4);

  const parsed = parseDisplayCheckpoint(bytes, { header: { last_command_seq: 7 } });
  assert.equal(parsed.schema, 'scene-engine-display-checkpoint@7');
  assert.equal(parsed.matrixPoolSize, 3);
  assert.ok(parsed.matrixPool instanceof Float32Array);
  assert.equal(parsed.matrixPool.length, 3 * MATRIX_LENGTH);
  assert.deepEqual(parsed.matrixPool, source);
  assert.notStrictEqual(parsed.matrixPool, source);
  assert.notStrictEqual(parsed.matrixPool.buffer, bytes.buffer);
  assert.deepEqual(parsed.nodes.map(({ nodeId, parentNodeId }) => [nodeId, parentNodeId]), [
    [0, null], [2, 0],
  ]);
  assert.equal(parsed.nodes[1].transformMode, 'initial');
  assert.equal(parsed.nodes[1].visible, false);
  assert.equal('transform' in parsed.nodes[0], false);
  assert.deepEqual(parsed.nodes[0].state, { mode: 'idle', nested: { value: 3 } });
  assert.deepEqual(encodeDisplayCheckpoint(parsedCheckpointToRecord(parsed)), bytes);

  const first = parsed.matrixPool[0];
  bytes.fill(0);
  assert.equal(parsed.matrixPool[0], first, 'packet mutation cannot alias the decoded tensor');
});

test('binary Display v4 command stream carries one transform batch before create rows', () => {
  const commands = [
    command('node-create', 8, {
      node_id: 2,
      parent_node_id: null,
      prefab_id: 'unit.example',
      transform_mode: 'live',
      visible: true,
      state: { created: true },
    }),
    command('node-set-transform-batch', 9, { node_ids: new Uint32Array([0]) }),
    command('node-set-parent', 10, { node_id: 0, parent_node_id: 2 }),
    command('node-set-visible', 11, { node_id: 0, visible: false }),
    command('node-set-state', 12, { node_id: 0, state: { mode: 'active' } }),
    command('node-replace-prefab', 13, {
      node_id: 0, prefab_id: 'unit.replacement', state: { level: 2 },
    }),
    command('node-remove', 14, { node_id: 0 }),
  ];
  const dirtyNodeIds = new Uint32Array([0, 2]);
  const dirtyMatrices = new Float32Array([...shearMatrix(2), ...matrix(1)]);
  const bytes = encodeDisplayCommandStream(stream(commands, {
    poolSize: 3, dirtyNodeIds, dirtyMatrices,
  }), { sourceTick: 12 });
  const parsed = parseDisplayCommandStream(bytes, {
    header: { source_tick: 12, last_command_seq: 14 },
    baseCommandSeq: 7,
  });

  assert.equal(parsed.schema, 'scene-engine-display-command-stream@7');
  assert.deepEqual(parsed.commands.map(({ kind }) => kind), commands.map(({ kind }) => kind));
  assert.deepEqual(parsed.commands.map(({ commandSeq }) => commandSeq), [8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual([...parsed.dirtyNodeIds], [0, 2]);
  assert.deepEqual(parsed.dirtyMatrices, dirtyMatrices);
  assert.notStrictEqual(parsed.dirtyMatrices.buffer, bytes.buffer);
  assert.equal(parsed.commands[0].parentNodeId, null);
  assert.equal(parsed.commands[2].parentNodeId, 2);
  assert.equal(parsed.commands[1].transformCount, 1);
  assert.deepEqual([...parsed.commands[1].nodeIds], [0]);
  assert.equal('nodeId' in parsed.commands[1], false);
  assert.deepEqual(encodeDisplayCommandStream(parsedStreamToRecord(parsed), {
    sourceTick: 12,
  }), bytes);
});

test('command stream fixed command limit precedes command traversal', () => {
  const overLimitCount = 65_537;
  const encoded = encodeDisplayCommandStream(stream([]), { sourceTick: 12 });
  const malformed = encoded.slice();
  new DataView(malformed.buffer, malformed.byteOffset, malformed.byteLength)
    .setUint32(24, overLimitCount, true);

  assert.throws(() => parseDisplayCommandStream(malformed, {
    header: { source_tick: 12, last_command_seq: 7 + overLimitCount },
    baseCommandSeq: 7,
  }), (error) => (
    error instanceof DisplayRecordError && error.code === 'display-command-count-limit'
  ));

  assert.throws(() => encodeDisplayCommandStream(
    stream(new Array(overLimitCount).fill(null)),
    { sourceTick: 12 },
  ), (error) => (
    error instanceof DisplayRecordError && error.code === 'display-command-count-limit'
  ));
});

test('canonical Python binary fixtures re-encode to exact Display bytes', async () => {
  const checkpointPacketValue = readEnginePacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/checkpoint.bin`),
  ));
  const checkpointBytes = rawAttachment(checkpointPacketValue, 'display_checkpoint');
  const parsedCheckpoint = parseDisplayCheckpoint(checkpointBytes, {
    header: checkpointPacketValue.header,
  });
  assert.equal(parsedCheckpoint.matrixPool[4], 0.25);
  assert.deepEqual(encodeDisplayCheckpoint(parsedCheckpointToRecord(parsedCheckpoint)), checkpointBytes);

  const commitPacketValue = readEnginePacket(new Uint8Array(
    await readFile(`${PYTHON_FIXTURES}/commit-tick.bin`),
  ));
  const commandBytes = rawAttachment(commitPacketValue, 'display_command_stream');
  const parsedStream = parseDisplayCommandStream(commandBytes, {
    header: commitPacketValue.header,
    baseCommandSeq: parsedCheckpoint.lastCommandSeq,
  });
  const transformCommand = parsedStream.commands.find(
    ({ kind }) => kind === 'node-set-transform-batch',
  );
  assert.equal(transformCommand.transformCount > 0, true);
  assert.equal(parsedStream.dirtyMatrices[4], 0.25);
  assert.equal(parsedStream.dirtyMatrices[12], 1.5);
  assert.deepEqual(encodeDisplayCommandStream(parsedStreamToRecord(parsedStream), {
    sourceTick: commitPacketValue.header.source_tick,
  }), commandBytes);
});

test('matrix tensor codec canonicalizes negative zero and enforces active/tombstone rows', () => {
  const negativeZero = matrix();
  for (const index of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12]) negativeZero[index] = -0;
  const bytes = encodeDisplayCheckpoint(checkpoint({ matrices: negativeZero }));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const matrixOffset = 8 + 8 + 4 + 4;
  for (const index of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12]) {
    assert.equal(view.getUint32(matrixOffset + (index * 4), true), 0);
  }
  const parsed = parseDisplayCheckpoint(bytes, { header: { last_command_seq: 7 } });
  for (const value of parsed.matrixPool) if (value === 0) assert.equal(Object.is(value, -0), false);

  assert.throws(() => encodeDisplayCheckpoint(checkpoint({
    matrices: [...matrix()],
  })), (error) => error.code === 'display-matrix-pool-invalid');
  assert.throws(() => encodeDisplayCheckpoint(checkpoint({
    poolSize: 2,
    matrices: matrixPool(2, [[0, matrix()], [1, matrix()]]),
  })), (error) => error.code === 'display-matrix-pool-tombstone-invalid');
  const negativeZeroTombstone = matrixPool(2, [[0, matrix()]]);
  negativeZeroTombstone[MATRIX_LENGTH] = -0;
  assert.throws(() => encodeDisplayCheckpoint(checkpoint({
    poolSize: 2,
    matrices: negativeZeroTombstone,
  })), (error) => error.code === 'display-matrix-pool-tombstone-invalid');

  const invalidTombstoneBits = encodeDisplayCheckpoint(checkpoint({
    poolSize: 2,
    matrices: matrixPool(2, [[0, matrix()]]),
  }));
  new DataView(invalidTombstoneBits.buffer).setUint32(
    (8 + 8 + 4 + 4) + MATRIX_BYTES,
    0x80000000,
    true,
  );
  assert.throws(() => parseDisplayCheckpoint(invalidTombstoneBits, {
    header: { last_command_seq: 7 },
  }), (error) => error.code === 'display-matrix-pool-tombstone-invalid');
  const reflected = matrix(); reflected[0] = -1;
  assert.throws(() => encodeDisplayCheckpoint(checkpoint({ matrices: reflected })),
    (error) => error.code === 'display-transform-matrix-invalid');
  assert.throws(() => encodeDisplayCommandStream({
    ...stream([]), schema: 'scene-engine-display-command-stream@5',
  }, { sourceTick: 12 }), (error) => error.code === 'display-command-stream-schema-invalid');
});

test('owned matrix tensor transfer rejects arbitrary and already-consumed values', () => {
  const bytes = encodeDisplayCheckpoint(checkpoint());
  const parsed = parseDisplayCheckpoint(bytes, { header: { last_command_seq: 7 } });
  const owned = parsed.matrixPool;
  assert.strictEqual(takeOwnedDisplayMatrixTensor(owned), owned);
  assert.throws(() => takeOwnedDisplayMatrixTensor(owned),
    (error) => error.code === 'display-transform-ownership-invalid');
  assert.throws(() => takeOwnedDisplayMatrixTensor(matrix()),
    (error) => error.code === 'display-transform-ownership-invalid');
});

test('binary parsers reject malformed pool IDs, tensors, records, and framing', () => {
  const valid = encodeDisplayCheckpoint(checkpoint());
  for (const [offset, value, code] of [
    [0, 0, 'display-checkpoint-magic-invalid'],
    [4, 2, 'display-checkpoint-version-invalid'],
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

  const invalidLastRow = encodeDisplayCheckpoint(checkpoint({
    poolSize: 2,
    matrices: matrixPool(2, [[0, matrix()], [1, matrix(5)]]),
    nodes: [baselineNode(0), baselineNode(1, 0)],
  }));
  const invalidLastRowView = new DataView(invalidLastRow.buffer);
  invalidLastRowView.setFloat32((8 + 8 + 4 + 4) + MATRIX_BYTES + 12, 0.5, true);
  assert.throws(() => parseDisplayCheckpoint(invalidLastRow, {
    header: { last_command_seq: 7 },
  }), (error) => error.code === 'display-transform-matrix-invalid');

  assert.throws(() => parseDisplayCheckpoint(valid.subarray(0, valid.length - 1),
    { header: { last_command_seq: 7 } }));
  const trailing = new Uint8Array(valid.length + 1); trailing.set(valid);
  assert.throws(() => parseDisplayCheckpoint(trailing, { header: { last_command_seq: 7 } }),
    (error) => error.code === 'display-checkpoint-trailing-bytes');

  const transformCommand = command('node-set-transform-batch', 8, {
    node_ids: new Uint32Array([0]),
  });
  const commandBytes = encodeDisplayCommandStream(stream([transformCommand], {
    poolSize: 1,
    dirtyNodeIds: new Uint32Array([0]),
    dirtyMatrices: matrix(3),
  }), { sourceTick: 12 });
  const parseCommand = (bytes) => parseDisplayCommandStream(bytes, {
    header: { source_tick: 12, last_command_seq: 8 }, baseCommandSeq: 7,
  });

  const unalignedOwner = new Uint8Array(commandBytes.length + 3);
  unalignedOwner.set(commandBytes, 1);
  const unaligned = parseCommand(unalignedOwner.subarray(1, 1 + commandBytes.length));
  assert.deepEqual(Array.from(unaligned.dirtyNodeIds), [0]);
  assert.deepEqual(Array.from(unaligned.dirtyMatrices), Array.from(matrix(3)));

  const matrixOffset = 36 + 4;
  for (const signalingNaN of [0x7f801234, 0xff801234]) {
    const invalidMatrixBits = commandBytes.slice();
    new DataView(invalidMatrixBits.buffer).setUint32(matrixOffset + (12 * 4), signalingNaN, true);
    assert.throws(() => parseCommand(invalidMatrixBits),
      (error) => error.code === 'display-transform-matrix-invalid');
  }

  const tickMismatch = commandBytes.slice();
  new DataView(tickMismatch.buffer).setBigUint64(16, 13n, true);
  assert.throws(() => parseCommand(tickMismatch),
    (error) => error.code === 'display-command-source-tick-mismatch');
  const excessiveCommands = commandBytes.slice();
  new DataView(excessiveCommands.buffer).setUint32(24, 0xffffffff, true);
  assert.throws(() => parseCommand(excessiveCommands),
    (error) => error.code === 'display-command-count-limit');
  const outOfRangeId = commandBytes.slice();
  new DataView(outOfRangeId.buffer).setUint32(36, 1, true);
  assert.throws(() => parseCommand(outOfRangeId),
    (error) => error.code === 'display-transform-dirty-id-invalid');

  assert.throws(() => encodeDisplayCommandStream(stream([transformCommand], {
    poolSize: 2,
    dirtyNodeIds: new Uint32Array([1, 0]),
    dirtyMatrices: new Float32Array([...matrix(1), ...matrix(2)]),
  }), { sourceTick: 12 }), (error) => error.code === 'display-transform-dirty-id-order-invalid');
  assert.throws(() => encodeDisplayCommandStream(stream([transformCommand], {
    poolSize: 2,
    dirtyNodeIds: new Uint32Array([0, 1]),
    dirtyMatrices: new Float32Array([...matrix(1), ...matrix(2)]),
  }), { sourceTick: 12 }), (error) => error.code === 'display-transform-dirty-target-mismatch');
  assert.throws(() => encodeDisplayCommandStream(stream([
    command('node-set-transform-batch', 8, { node_ids: new Uint32Array([1]) }),
  ], {
    poolSize: 2,
    dirtyNodeIds: new Uint32Array([0]),
    dirtyMatrices: matrix(1),
  }), { sourceTick: 12 }), (error) => error.code === 'display-transform-dirty-target-mismatch');
  assert.throws(() => encodeDisplayCommandStream(stream([
    command('node-set-transform-batch', 8, { node_ids: new Uint32Array([1, 0]) }),
  ], {
    poolSize: 2,
    dirtyNodeIds: new Uint32Array([0, 1]),
    dirtyMatrices: new Float32Array([...matrix(1), ...matrix(2)]),
  }), { sourceTick: 12 }), (error) => error.code === 'display-transform-batch-id-order-invalid');

  const selfParent = command('node-set-parent', 8, {
    node_id: 0,
    parent_node_id: 0,
  });
  assert.throws(() => encodeDisplayCommandStream(stream([selfParent]), {
    sourceTick: 12,
  }), (error) => error.code === 'display-parent-node-id-invalid');

  const validParent = encodeDisplayCommandStream(stream([
    command('node-set-parent', 8, { node_id: 0, parent_node_id: 1 }),
  ]), { sourceTick: 12 });
  const selfParentBytes = validParent.slice();
  new DataView(selfParentBytes.buffer).setUint32(36 + 1 + 4, 0, true);
  assert.throws(() => parseCommand(selfParentBytes),
    (error) => error.code === 'display-parent-node-id-invalid');

  const commandOffset = 36 + 4 + MATRIX_BYTES;
  const invalidOpcode = commandBytes.slice(); invalidOpcode[commandOffset] = 99;
  assert.throws(() => parseCommand(invalidOpcode),
    (error) => error.code === 'display-command-kind-invalid');
  assert.throws(() => parseCommand(commandBytes.subarray(0, commandBytes.length - 1)));
});
