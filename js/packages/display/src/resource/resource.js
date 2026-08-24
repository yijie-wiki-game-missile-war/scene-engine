import { cloneAndFreeze, nonemptyString, safeInteger } from '../internal.js';

export class Resource {
  constructor({ id, schema, revision = 0, descriptor = {} }) {
    this._id = nonemptyString(id, 'display-resource-id-invalid');
    this._schema = nonemptyString(schema, 'display-resource-schema-invalid');
    this._revision = safeInteger(revision, 'display-resource-revision-invalid', { minimum: 0 });
    this._descriptor = cloneAndFreeze(descriptor, 'display-resource-definition-invalid');
  }
  get id() { return this._id; }
  get schema() { return this._schema; }
  get revision() { return this._revision; }
  describe() { return this._descriptor; }
}
