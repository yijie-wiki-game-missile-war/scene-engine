import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  NodeWebSocketTransmissionAdapter,
  NodeWebSocketTransportError,
} from '../src/index.js';

class FakeSocket extends EventEmitter {
  constructor(results) {
    super();
    this.results = [...results];
    this.writes = [];
    this.destroyed = false;
  }

  write(value) {
    this.writes.push(Buffer.from(value));
    return this.results.shift() ?? true;
  }

  destroy() { this.destroyed = true; }
}

test('bounded writer waits for drain before advancing its queue', async () => {
  const socket = new FakeSocket([false, true]);
  const adapter = new NodeWebSocketTransmissionAdapter({
    socket,
    encodeTransmission: ({ data }) => data,
  });
  const sending = adapter.send([
    { data: new TextEncoder().encode('one') },
    { data: new TextEncoder().encode('two') },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.writes.length, 1);
  assert.equal(adapter.status().queuedTransmissions, 2);
  socket.emit('drain');
  await sending;
  assert.deepEqual(socket.writes.map((value) => value.toString()), ['one', 'two']);
  assert.equal(adapter.status().queuedBytes, 0);
});

test('bounded writer rejects queue overflow before writing', async () => {
  const socket = new FakeSocket([false]);
  const adapter = new NodeWebSocketTransmissionAdapter({
    socket,
    encodeTransmission: ({ data }) => data,
    limits: { maximumQueuedBytes: 2 },
  });
  await assert.rejects(
    () => adapter.send([{ data: new TextEncoder().encode('toolarge') }]),
    NodeWebSocketTransportError,
  );
  assert.equal(socket.writes.length, 0);
});
