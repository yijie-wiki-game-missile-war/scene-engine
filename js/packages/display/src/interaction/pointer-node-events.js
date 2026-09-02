import {
  assertSynchronous,
  cloneAndFreezeJson,
  exactKeys,
  safeInteger,
} from '../internal.js';
import { fail } from '../runtime/health.js';

export const POINTER_NODE_EVENT_INPUT_COMMAND = 'display.pointer-event';

export const POINTER_NODE_EVENT_NAMES = Object.freeze([
  'click',
  'context-click',
  'double-click',
  'drag-grab',
  'drag-move',
  'drag-drop',
  'proximity-enter',
  'proximity-move',
  'proximity-leave',
]);

const POINTER_NODE_EVENT_NAME_SET = new Set(POINTER_NODE_EVENT_NAMES);
const MAXIMUM_NODE_ID = 0xfffffffe;

function nodeId(value) {
  return safeInteger(value, 'display-pointer-node-event-invalid', {
    minimum: 0,
    maximum: MAXIMUM_NODE_ID,
  });
}

function eventName(value) {
  if (typeof value !== 'string' || !POINTER_NODE_EVENT_NAME_SET.has(value)) {
    fail('display-pointer-node-event-invalid');
  }
  return value;
}

export function normalizePointerNodeEvent(value) {
  const record = exactKeys(
    value,
    ['nodeId', 'eventName', 'payload'],
    [],
    'display-pointer-node-event-invalid',
  );
  const name = eventName(record.eventName);
  const payload = cloneAndFreezeJson(record.payload, 'display-pointer-node-event-invalid');
  const id = nodeId(record.nodeId);
  if (payload === null || Array.isArray(payload) || payload.phase !== name
      || payload.startInteraction?.target?.authorityNodeId !== id) {
    fail('display-pointer-node-event-invalid');
  }
  return Object.freeze({
    nodeId: id,
    eventName: name,
    payload,
  });
}

export function pointerNodeEventInput(value) {
  const event = normalizePointerNodeEvent(value);
  return Object.freeze({
    command: POINTER_NODE_EVENT_INPUT_COMMAND,
    args: Object.freeze({
      node_id: event.nodeId,
      event_name: event.eventName,
      payload: event.payload,
    }),
  });
}

export class PointerNodeEventHub {
  #listeners = new Map();

  addEventListener(targetNodeId, targetEventName, listener) {
    const id = nodeId(targetNodeId);
    const name = eventName(targetEventName);
    if (typeof listener !== 'function') fail('display-pointer-node-listener-invalid');
    const key = `${id}:${name}`;
    let listeners = this.#listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  dispatch(value) {
    const event = normalizePointerNodeEvent(value);
    const listeners = this.#listeners.get(`${event.nodeId}:${event.eventName}`);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      assertSynchronous(
        listener(event),
        'display-pointer-node-listener-async',
      );
    }
  }

  clear() {
    this.#listeners.clear();
  }
}
