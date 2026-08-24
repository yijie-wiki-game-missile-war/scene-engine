import { fail } from '../runtime/health.js';
import { assertNodeName } from './node-name.js';

export class NodeIndex {
  constructor() { this._nodes = new Map(); }
  get size() { return this._nodes.size; }

  register(node) {
    if (!node || typeof node.name !== 'string') fail('display-node-invalid');
    const name = assertNodeName(node.name);
    if (this._nodes.has(name)) fail('display-node-name-duplicate');
    this._nodes.set(name, node);
    return node;
  }

  unregister(node) {
    if (!node || this._nodes.get(node.name) !== node) fail('display-node-unregister-identity');
    this._nodes.delete(node.name);
  }

  get(name) { return this._nodes.get(name) ?? null; }
  has(name) { return this._nodes.has(name); }
  require(name) {
    const node = this.get(name);
    if (!node) fail('display-node-missing');
    return node;
  }

  findByPrefix(prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) fail('display-node-prefix-invalid');
    return Object.freeze([...this._nodes.values()].filter((node) => node.name.startsWith(prefix)));
  }

  values() { return this._nodes.values(); }
}

export function createNodeIndex() { return new NodeIndex(); }
