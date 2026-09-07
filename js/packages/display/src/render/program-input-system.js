import { attachedComponentNode } from '../component/component.js';
import { BehaviourComponent } from '../component/behaviour-component.js';
import { normalizeProgramParameters } from '../resource/program-resource.js';
import { cloneAndFreeze, plainRecord } from '../internal.js';
import { fail } from '../runtime/health.js';

const ERROR = 'display-program-input-invalid';

export class ProgramInputSystem {
  constructor({ resourceRegistry, renderSystem }) {
    this.resources = resourceRegistry; this.render = renderSystem;
    this.targets = new Map(); this.owners = new Map();
  }

  programFor(target) {
    let programId = null;
    if (target?.constructor.typeId === 'render.mesh@1'
        || target?.constructor.typeId === 'render.sprite@3') {
      const material = this.resources.require(target.properties.materialResourceId).describe();
      if (material.family === 'material.program') programId = material.programResourceId;
    } else if (target?.constructor.typeId === 'render.background@1') {
      programId = target.properties.programResourceId;
    }
    if (!programId) fail(ERROR);
    return this.resources.require(programId).describe();
  }

  set(requester, key, patch) {
    if (!(requester instanceof BehaviourComponent) || !requester.enabled || requester.disposed) fail(ERROR);
    const node = attachedComponentNode(requester);
    const target = node?.getComponent(key);
    // A type id is not a component key; never search outside the requester's Node.
    if (!target || target.key !== key || target.disposed) fail(ERROR);
    const current = this.targets.get(target);
    if (current && current.requester !== requester) fail('display-program-input-owner-conflict');
    if (patch === null) { this.releaseTarget(target); return; }
    const program = this.programFor(target);
    const delta = plainRecord(patch, ERROR);
    for (const key of Object.keys(delta)) if (program.parameterSchema[key]?.updateable !== true) fail(ERROR);
    // Validate the whole candidate before mutating either the owner or render layer.
    const values = { ...(current?.values ?? {}), ...delta };
    const normalized = normalizeProgramParameters(program, values);
    const selected = cloneAndFreeze(Object.fromEntries(Object.keys(values).map(key => [key, normalized[key]])), ERROR);
    if (current && JSON.stringify(current.values) === JSON.stringify(selected)) return;
    this.targets.set(target, { requester, programId: program.id, values: selected });
    let targets = this.owners.get(requester);
    if (!targets) { targets = new Set(); this.owners.set(requester, targets); }
    targets.add(target);
    this.render.setProgramParameterOverride(target, selected);
  }

  releaseTarget(target) {
    const record = this.targets.get(target);
    if (!record) return;
    this.targets.delete(target);
    const targets = this.owners.get(record.requester);
    targets?.delete(target);
    if (targets?.size === 0) this.owners.delete(record.requester);
    this.render.clearProgramParameterOverride(target);
  }

  release(component) {
    for (const target of [...(this.owners.get(component) ?? [])]) this.releaseTarget(target);
    this.releaseTarget(component);
  }

  propertiesChanged(component) {
    const record = this.targets.get(component);
    if (!record) return;
    let program;
    try { program = this.programFor(component); } catch { this.releaseTarget(component); return; }
    if (program.id !== record.programId) this.releaseTarget(component);
  }

  _records(component) {
    const affected = new Set(this.owners.get(component) ?? []);
    if (this.targets.has(component)) affected.add(component);
    return [...affected].map(target => ({ target, ...this.targets.get(target) }));
  }

  _restore(records) {
    for (const record of records) {
      if (record.target.disposed || record.requester.disposed || !record.requester.enabled) continue;
      const current = attachedComponentNode(record.requester)?.getComponent(record.target.key);
      if (current !== record.target) continue;
      let program;
      try { program = this.programFor(current); } catch { continue; }
      if (program.id === record.programId) this.set(record.requester, current.key, record.values);
    }
  }

  capture(component) {
    const records = this._records(component);
    return records.length ? () => { this.release(component); this._restore(records); } : null;
  }

  // Prefab reconciliation temporarily unregisters retained Components. Preserve a
  // claim through a successful restore, but don't keep it across real disposal.
  suspend(component) {
    const records = this._records(component);
    if (!records.length) return null;
    this.release(component);
    return () => this._restore(records);
  }

  dispose() {
    for (const target of [...this.targets.keys()]) this.releaseTarget(target);
  }
}
