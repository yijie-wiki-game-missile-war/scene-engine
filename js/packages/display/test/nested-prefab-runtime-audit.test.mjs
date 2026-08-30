import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BehaviourComponent,
  PREFAB_DEFINITION_SCHEMA,
  createComponentRegistry,
  createPrefabRegistry,
  createResourceRegistry,
  definePrefab,
} from '../src/index.js';
import { IDENTITY, commitAuthority, createHarness } from './helpers.mjs';

class CandidateIsolationProbe extends BehaviourComponent {
  static typeId = 'audit.candidate-isolation@1';
  static tickPhase = 'update';

  onAttach(display) {
    if (display.nodes.has(this.properties.removedNodeName)) {
      const error = new Error('replacement shadow exposed a node removed by the candidate');
      error.code = 'audit-replacement-shadow-stale-node';
      throw error;
    }
  }

  tick() {}
}

class CandidatePresenceProbe extends BehaviourComponent {
  static typeId = 'audit.candidate-presence@1';
  static tickPhase = 'update';

  onAttach(display) {
    if (!display.nodes.has(this.properties.requiredNodeName)) {
      const error = new Error('candidate shadow omitted a sibling added by the same candidate');
      error.code = 'audit-candidate-shadow-sibling-missing';
      throw error;
    }
  }

  tick() {}
}

class PreparedLeakProbe extends BehaviourComponent {
  static typeId = 'audit.prepared-leak@1';
  static tickPhase = 'update';
  static constructed = new Set();

  constructor(options) {
    super(options);
    PreparedLeakProbe.constructed.add(this);
  }

  tick() {}
}

class ThrowingConstructionProbe extends BehaviourComponent {
  static typeId = 'audit.throwing-construction@1';
  static tickPhase = 'update';
  static armed = false;

  constructor(options) {
    super(options);
    if (ThrowingConstructionProbe.armed) {
      const error = new Error('injected component construction failure');
      error.code = 'audit-component-construction-failure';
      throw error;
    }
  }

  tick() {}
}

class RetainedValueProbe extends BehaviourComponent {
  static typeId = 'audit.retained-value@1';
  static tickPhase = 'update';
  tick() {}
}

class CandidateParentStateProbe extends BehaviourComponent {
  static typeId = 'audit.candidate-parent-state@1';
  static tickPhase = 'update';

  onAttach(display) {
    const parent = display.nodes.require(this.properties.parentNodeName);
    const state = parent.getComponentState('state');
    const childNames = new Set(parent.childNames);
    if (state?.properties.value !== this.properties.expectedValue
        || parent.visibleSelf !== this.properties.expectedVisible
        || parent.visibleInHierarchy !== this.properties.expectedVisible
        || childNames.size !== 1
        || !childNames.has(this.properties.expectedChildName)) {
      const error = new Error('candidate parent view did not expose its final retained state');
      error.code = 'audit-candidate-parent-state-stale';
      throw error;
    }
  }

  tick() {}
}

class CandidateRollbackProbe extends BehaviourComponent {
  static typeId = 'audit.candidate-rollback@1';
  static tickPhase = 'update';
  static constructed = new Set();

  constructor(options) {
    super(options);
    CandidateRollbackProbe.constructed.add(this);
  }

  onAttach() {
    if (this.properties.fail) {
      const error = new Error(`injected candidate attach failure: ${this.properties.tag}`);
      error.code = 'audit-candidate-second-attach-failure';
      throw error;
    }
  }

  tick() {}
}

function registerStringPropertyProbe(registry, ComponentClass, propertyName) {
  registry.register({
    ComponentClass,
    normalizeProperties(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 1
          || typeof value[propertyName] !== 'string') {
        throw new TypeError(`${ComponentClass.typeId} properties invalid`);
      }
      return Object.freeze({ [propertyName]: value[propertyName] });
    },
    resourceReferences: () => [],
  });
}

function registerRetainedCandidateProbes(registry) {
  registry.register({
    ComponentClass: RetainedValueProbe,
    normalizeProperties(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.value)) {
        throw new TypeError('retained value properties invalid');
      }
      return Object.freeze({ value: value.value });
    },
    resourceReferences: () => [],
  });
  registry.register({
    ComponentClass: CandidateParentStateProbe,
    normalizeProperties(value) {
      const keys = ['expectedChildName', 'expectedValue', 'expectedVisible', 'parentNodeName'];
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== keys.length
          || keys.some((key) => !Object.hasOwn(value, key))
          || typeof value.parentNodeName !== 'string'
          || typeof value.expectedChildName !== 'string'
          || !Number.isSafeInteger(value.expectedValue)
          || typeof value.expectedVisible !== 'boolean') {
        throw new TypeError('candidate parent state properties invalid');
      }
      return Object.freeze({
        parentNodeName: value.parentNodeName,
        expectedChildName: value.expectedChildName,
        expectedValue: value.expectedValue,
        expectedVisible: value.expectedVisible,
      });
    },
    resourceReferences: () => [],
  });
  registry.register({
    ComponentClass: CandidateRollbackProbe,
    normalizeProperties(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 2
          || typeof value.tag !== 'string' || typeof value.fail !== 'boolean') {
        throw new TypeError('candidate rollback properties invalid');
      }
      return Object.freeze({ tag: value.tag, fail: value.fail });
    },
    resourceReferences: () => [],
  });
}

function emptyDefinition(id, gameplayType) {
  return definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id,
    gameplayType,
    root: { components: [], children: [] },
  });
}

function authorityCommand({ name, parentName, prefabId }) {
  return {
    name,
    parentName,
    prefabId,
    transformMode: 'live',
    transform: IDENTITY,
    visible: true,
    state: {},
  };
}

function nextCursor(runtime) {
  const current = runtime.summary().cursor;
  return Object.freeze({
    commitSeq: current.commitSeq + 1,
    sourceTick: current.sourceTick + 1,
    lastCommandSeq: current.lastCommandSeq + 1,
  });
}

test('nested child depth rejection leaves no detached NodeIndex entry', async () => {
  const empty = emptyDefinition('audit/depth-empty', 'audit.depth-empty');
  const child = emptyDefinition('audit/depth-child', 'audit.depth-child');
  const owner = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/depth-owner',
    gameplayType: 'audit.depth-owner',
    root: { components: [], children: [] },
    prefabInstances: [{
      key: 'child',
      parentLocalPath: null,
      prefabId: child.id,
    }],
  });

  let deepestParent = null;
  const { runtime } = await createHarness({
    prefabEntries: [empty, child, owner],
    bootstrapAuthority(authority) {
      // sys/scene-root is depth 1 and sys/authority-root is depth 2. These 125
      // ordinary authority roots leave the final owner at depth 128, where its
      // nested child must be rejected at depth 129.
      for (let index = 0; index < 125; index += 1) {
        const name = `py/p${String(index).padStart(3, '0')}`;
        authority.createNode(authorityCommand({
          name,
          parentName: deepestParent,
          prefabId: empty.id,
        }));
        deepestParent = name;
      }
    },
  });

  const baselineSize = runtime._nodeIndex.size;
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  let caught = null;
  try {
    runtime.authority.createNode(authorityCommand({
      name: 'py/depth-target',
      parentName: deepestParent,
      prefabId: owner.id,
    }));
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.code, 'display-node-depth-limit');
  assert.equal(runtime._nodeIndex.get('py/depth-target'), null);
  assert.equal(runtime._nodeIndex.get('prefab/py/depth-target/child'), null);
  assert.equal(runtime._nodeIndex.size, baselineSize);
  runtime.commitGate.fail(caught);
  await runtime.dispose();
});

test('an empty dynamic slot uses its actual graph height at the authority depth boundary',
  async (t) => {
    const empty = emptyDefinition('audit/actual-height-empty', 'audit.actual-height-empty');
    const child = emptyDefinition('audit/actual-height-child', 'audit.actual-height-child');
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/actual-height-owner',
      gameplayType: 'audit.actual-height-owner',
      root: { components: [], children: [] },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: null,
        allowedPrefabIds: [child.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          prefabSlots: {
            children: state.withChild === true
              ? { only: { prefabId: child.id } }
              : {},
          },
        };
      },
    });

    let deepestParent = null;
    const { runtime } = await createHarness({
      prefabEntries: [empty, child, owner],
      bootstrapAuthority(authority) {
        for (let index = 0; index < 125; index += 1) {
          const name = `py/h${String(index).padStart(3, '0')}`;
          authority.createNode(authorityCommand({
            name,
            parentName: deepestParent,
            prefabId: empty.id,
          }));
          deepestParent = name;
        }
      },
    });
    t.after(() => runtime.dispose());

    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({
        name: 'py/actual-height-target',
        parentName: deepestParent,
        prefabId: owner.id,
      }),
      state: { withChild: false },
    }), { sourceTickDelta: 1 });

    assert.notEqual(runtime._nodeIndex.get('py/actual-height-target'), null);
    assert.equal(runtime._nodeIndex.get('prefab/py/actual-height-target/children/only'), null);
  });

test('a dynamic slot key cannot reserve the exact path of an ordinary local Node', () => {
  const child = emptyDefinition('audit/slot-path-child', 'audit.slot-path-child');
  const owner = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/slot-path-owner',
    gameplayType: 'audit.slot-path-owner',
    root: {
      components: [],
      children: [{
        localName: 'tiles',
        components: [],
        children: [],
      }],
    },
    prefabSlots: [{
      key: 'tiles',
      parentLocalPath: null,
      allowedPrefabIds: [child.id],
      maximumInstances: 1,
    }],
  });
  const componentRegistry = createComponentRegistry();
  const resourceRegistry = createResourceRegistry();
  const prefabRegistry = createPrefabRegistry([owner, child]);

  assert.throws(
    () => owner.compile({ componentRegistry, resourceRegistry, prefabRegistry }),
    (error) => error?.code === 'display-prefab-instance-key-duplicate',
  );
});

test('a newly attached nested fixed billboard sees the transaction final retained parent pose',
  async (t) => {
    const child = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/final-parent-pose-child',
      gameplayType: 'audit.final-parent-pose-child',
      root: {
        components: [{
          key: 'billboard',
          type: 'behavior.billboard@2',
          properties: {
            facing: 'fixed',
            mode: 'initialize',
            axisMode: 'full',
          },
        }],
        children: [],
      },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/final-parent-pose-owner',
      gameplayType: 'audit.final-parent-pose-owner',
      root: {
        components: [],
        children: [{
          localName: 'mount',
          transform: IDENTITY,
          components: [],
          children: [],
        }],
      },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: 'mount',
        allowedPrefabIds: [child.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          nodes: { mount: { transform: state.mountTransform } },
          prefabSlots: {
            children: state.show
              ? { only: { prefabId: child.id } }
              : {},
          },
        };
      },
    });
    const { runtime } = await createHarness({ prefabEntries: [owner, child] });
    t.after(() => runtime.dispose());
    const ownerName = 'py/final-parent-pose';
    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
      state: { show: false, mountTransform: IDENTITY },
    }), { sourceTickDelta: 1 });

    const halfSqrt = Math.SQRT1_2;
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: ownerName,
      state: {
        show: true,
        mountTransform: {
          position: [0, 0, 0],
          rotationXyzw: [0, halfSqrt, 0, halfSqrt],
          scale: [1, 1, 1],
        },
      },
    }), { sourceTickDelta: 1 });

    const world = runtime.currentView().getWorldTransform(
      'prefab/py/final-parent-pose/children/only',
    );
    assert.ok(Math.abs(world.rotationXyzw[0]) < 1e-12);
    assert.ok(Math.abs(world.rotationXyzw[1]) < 1e-12);
    assert.ok(Math.abs(world.rotationXyzw[2]) < 1e-12);
    assert.ok(Math.abs(Math.abs(world.rotationXyzw[3]) - 1) < 1e-12);
  });

test('bulk dynamic removal visits the flat materialization ledger only linearly', async (t) => {
  const child = emptyDefinition('audit/bulk-remove-child', 'audit.bulk-remove-child');
  const owner = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/bulk-remove-owner',
    gameplayType: 'audit.bulk-remove-owner',
    root: { components: [], children: [] },
    prefabSlots: [{
      key: 'children',
      parentLocalPath: null,
      allowedPrefabIds: [child.id],
      maximumInstances: 64,
    }],
    resolveState(state) {
      return {
        prefabSlots: {
          children: Object.fromEntries(Array.from({ length: state.count }, (_, index) => [
            `child-${String(index).padStart(2, '0')}`,
            { prefabId: child.id },
          ])),
        },
      };
    },
  });
  const { runtime } = await createHarness({ prefabEntries: [owner, child] });
  t.after(() => runtime.dispose());
  const ownerName = 'py/bulk-remove';
  commitAuthority(runtime, () => runtime.authority.createNode({
    ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
    state: { count: 64 },
  }), { sourceTickDelta: 1 });
  const baselineNodeCount = runtime._nodeIndex.size;

  const scope = runtime._prefabInstantiator.getScope(runtime._nodeIndex.require(ownerName));
  const records = scope.records;
  const originalValues = records.values.bind(records);
  let yielded = 0;
  records.values = () => {
    const iterator = originalValues();
    return {
      next() {
        const result = iterator.next();
        if (!result.done) yielded += 1;
        return result;
      },
      [Symbol.iterator]() { return this; },
    };
  };

  const originalDetachForest = runtime._nodeGraph.detachForest.bind(runtime._nodeGraph);
  let detachForestCalls = 0;
  runtime._nodeGraph.detachForest = (nodes) => {
    detachForestCalls += 1;
    return originalDetachForest(nodes);
  };

  try {
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: ownerName,
      state: { count: 0 },
    }), { sourceTickDelta: 1 });
  } finally {
    runtime._nodeGraph.detachForest = originalDetachForest;
  }

  assert.ok(yielded <= 4 * 65,
    `bulk removal iterated ${yielded} ledger records for 65 records`);
  assert.equal(detachForestCalls, 1);
  assert.equal(runtime._nodeIndex.size, baselineNodeCount - 64);
});

test('a nested replacement shadow cannot observe nodes removed by the same candidate',
  async (t) => {
    const ownerName = 'py/candidate-isolation';
    const removedNodeName = `prefab/${ownerName}/children/only/old-only`;
    const oldChild = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/candidate-isolation-old',
      gameplayType: 'audit.candidate-isolation-old',
      root: {
        components: [],
        children: [{
          localName: 'old-only',
          components: [],
          children: [],
        }],
      },
    });
    const newChild = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/candidate-isolation-new',
      gameplayType: 'audit.candidate-isolation-new',
      root: {
        components: [{
          key: 'probe',
          type: CandidateIsolationProbe.typeId,
          properties: { removedNodeName },
        }],
        children: [],
      },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/candidate-isolation-owner',
      gameplayType: 'audit.candidate-isolation-owner',
      root: { components: [], children: [] },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: null,
        allowedPrefabIds: [oldChild.id, newChild.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          prefabSlots: {
            children: {
              only: { prefabId: state.prefabId },
            },
          },
        };
      },
    });
    const { runtime } = await createHarness({
      prefabEntries: [owner, oldChild, newChild],
      configureComponents(registry) {
        registerStringPropertyProbe(registry, CandidateIsolationProbe, 'removedNodeName');
      },
    });
    t.after(() => runtime.dispose());

    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
      state: { prefabId: oldChild.id },
    }), { sourceTickDelta: 1 });
    assert.notEqual(runtime._nodeIndex.get(removedNodeName), null);

    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: ownerName,
      state: { prefabId: newChild.id },
    }), { sourceTickDelta: 1 });

    assert.equal(runtime._nodeIndex.get(removedNodeName), null);
    assert.notEqual(runtime._nodeIndex.get(`prefab/${ownerName}/children/only`), null);
  });

test('an addition shadow hides every sibling removed by the same candidate', async (t) => {
  const ownerName = 'py/candidate-remove-add';
  const removedNodeName = `prefab/${ownerName}/children/old/old-only`;
  const oldChild = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-remove-add-old',
    gameplayType: 'audit.candidate-remove-add-old',
    root: {
      components: [],
      children: [{ localName: 'old-only', components: [], children: [] }],
    },
  });
  const newChild = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-remove-add-new',
    gameplayType: 'audit.candidate-remove-add-new',
    root: {
      components: [{
        key: 'probe',
        type: CandidateIsolationProbe.typeId,
        properties: { removedNodeName },
      }],
      children: [],
    },
  });
  const owner = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-remove-add-owner',
    gameplayType: 'audit.candidate-remove-add-owner',
    root: { components: [], children: [] },
    prefabSlots: [{
      key: 'children',
      parentLocalPath: null,
      allowedPrefabIds: [oldChild.id, newChild.id],
      maximumInstances: 1,
    }],
    resolveState(state) {
      return {
        prefabSlots: {
          children: state.next
            ? { next: { prefabId: newChild.id } }
            : { old: { prefabId: oldChild.id } },
        },
      };
    },
  });
  const { runtime } = await createHarness({
    prefabEntries: [owner, oldChild, newChild],
    configureComponents(registry) {
      registerStringPropertyProbe(registry, CandidateIsolationProbe, 'removedNodeName');
    },
  });
  t.after(() => runtime.dispose());

  commitAuthority(runtime, () => runtime.authority.createNode({
    ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
    state: { next: false },
  }), { sourceTickDelta: 1 });
  assert.notEqual(runtime._nodeIndex.get(removedNodeName), null);

  commitAuthority(runtime, () => runtime.authority.setNodeState({
    name: ownerName,
    state: { next: true },
  }), { sourceTickDelta: 1 });

  assert.equal(runtime._nodeIndex.get(removedNodeName), null);
  assert.notEqual(runtime._nodeIndex.get(`prefab/${ownerName}/children/next`), null);
});

test('addition attach hooks see siblings added by the same complete candidate', async (t) => {
  const ownerName = 'py/candidate-added-siblings';
  const requiredNodeName = `prefab/${ownerName}/children/bravo`;
  const probeChild = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-added-sibling-probe',
    gameplayType: 'audit.candidate-added-sibling-probe',
    root: {
      components: [{
        key: 'probe',
        type: CandidatePresenceProbe.typeId,
        properties: { requiredNodeName },
      }],
      children: [],
    },
  });
  const emptyChild = emptyDefinition(
    'audit/candidate-added-sibling-empty',
    'audit.candidate-added-sibling-empty',
  );
  const owner = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-added-sibling-owner',
    gameplayType: 'audit.candidate-added-sibling-owner',
    root: { components: [], children: [] },
    prefabSlots: [{
      key: 'children',
      parentLocalPath: null,
      allowedPrefabIds: [probeChild.id, emptyChild.id],
      maximumInstances: 2,
    }],
    resolveState(state) {
      return {
        prefabSlots: {
          children: state.show
            ? {
              alpha: { prefabId: probeChild.id },
              bravo: { prefabId: emptyChild.id },
            }
            : {},
        },
      };
    },
  });
  const { runtime } = await createHarness({
    prefabEntries: [owner, probeChild, emptyChild],
    configureComponents(registry) {
      registerStringPropertyProbe(registry, CandidatePresenceProbe, 'requiredNodeName');
    },
  });
  t.after(() => runtime.dispose());

  commitAuthority(runtime, () => runtime.authority.createNode({
    ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
    state: { show: false },
  }), { sourceTickDelta: 1 });

  commitAuthority(runtime, () => runtime.authority.setNodeState({
    name: ownerName,
    state: { show: true },
  }), { sourceTickDelta: 1 });

  assert.notEqual(runtime._nodeIndex.get(requiredNodeName), null);
});

test('a partial live NodeIndex registration failure rolls an adopted subtree fully back',
  async (t) => {
    const child = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/partial-adopt-child',
      gameplayType: 'audit.partial-adopt-child',
      root: {
        components: [],
        children: [{ localName: 'body', components: [], children: [] }],
      },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/partial-adopt-owner',
      gameplayType: 'audit.partial-adopt-owner',
      root: { components: [], children: [] },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: null,
        allowedPrefabIds: [child.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          prefabSlots: {
            children: state.show ? { only: { prefabId: child.id } } : {},
          },
        };
      },
    });
    const { runtime } = await createHarness({ prefabEntries: [owner, child] });
    t.after(() => runtime.dispose());
    const ownerName = 'py/partial-adopt';
    const childRootName = `prefab/${ownerName}/children/only`;
    const childBodyName = `${childRootName}/body`;
    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
      state: { show: false },
    }), { sourceTickDelta: 1 });
    const baselineSize = runtime._nodeIndex.size;
    const authority = runtime._nodeIndex.require(ownerName).requireComponent('authority');
    const baselineState = authority.state;
    const originalRegister = runtime._nodeIndex.register.bind(runtime._nodeIndex);
    const failure = new Error('injected partial live registration failure');
    failure.code = 'audit-partial-adopt-registration-failure';
    runtime._nodeIndex.register = (node) => {
      if (node.name === childBodyName) throw failure;
      return originalRegister(node);
    };

    const cursor = nextCursor(runtime);
    runtime.commitGate.begin(cursor);
    let caught = null;
    try {
      runtime.authority.setNodeState({ name: ownerName, state: { show: true } });
    } catch (error) {
      caught = error;
    } finally {
      runtime._nodeIndex.register = originalRegister;
    }

    assert.strictEqual(caught, failure);
    assert.equal(runtime._nodeIndex.get(childRootName), null);
    assert.equal(runtime._nodeIndex.get(childBodyName), null);
    assert.equal(runtime._nodeIndex.size, baselineSize);
    assert.strictEqual(authority.state, baselineState);
    runtime.commitGate.fail(caught);
  });

test('component preparation failure disposes components already created on the same Node',
  async (t) => {
    const child = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/component-preparation-child',
      gameplayType: 'audit.component-preparation-child',
      root: {
        components: [
          { key: 'first', type: PreparedLeakProbe.typeId, properties: {} },
          { key: 'fails', type: ThrowingConstructionProbe.typeId, properties: {} },
        ],
        children: [],
      },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/component-preparation-owner',
      gameplayType: 'audit.component-preparation-owner',
      root: { components: [], children: [] },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: null,
        allowedPrefabIds: [child.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          prefabSlots: {
            children: state.show ? { only: { prefabId: child.id } } : {},
          },
        };
      },
    });
    const { runtime } = await createHarness({
      prefabEntries: [owner, child],
      configureComponents(registry) {
        registry.register({ ComponentClass: PreparedLeakProbe });
        registry.register({ ComponentClass: ThrowingConstructionProbe });
      },
    });
    t.after(() => runtime.dispose());
    const ownerName = 'py/component-preparation';
    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
      state: { show: false },
    }), { sourceTickDelta: 1 });
    const baselineSize = runtime._nodeIndex.size;
    const authority = runtime._nodeIndex.require(ownerName).requireComponent('authority');
    const baselineState = authority.state;
    PreparedLeakProbe.constructed = new Set();
    ThrowingConstructionProbe.armed = true;

    const cursor = nextCursor(runtime);
    runtime.commitGate.begin(cursor);
    let caught = null;
    try {
      runtime.authority.setNodeState({ name: ownerName, state: { show: true } });
    } catch (error) {
      caught = error;
    } finally {
      ThrowingConstructionProbe.armed = false;
    }

    assert.equal(caught?.code, 'audit-component-construction-failure');
    assert.ok(PreparedLeakProbe.constructed.size > 0);
    assert.equal([...PreparedLeakProbe.constructed].every((component) => component.disposed), true);
    assert.equal(runtime._nodeIndex.size, baselineSize);
    assert.strictEqual(authority.state, baselineState);
    runtime.commitGate.fail(caught);
  });

test('a child attach hook reads the retained parent final properties, visibility, and children',
  async (t) => {
    const ownerName = 'py/candidate-retained-parent';
    const parentNodeName = `prefab/${ownerName}/mount`;
    const expectedChildName = `prefab/${ownerName}/children/only`;
    const child = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/candidate-retained-parent-child',
      gameplayType: 'audit.candidate-retained-parent-child',
      root: {
        components: [{
          key: 'probe',
          type: CandidateParentStateProbe.typeId,
          properties: {
            parentNodeName,
            expectedChildName,
            expectedValue: 42,
            expectedVisible: false,
          },
        }],
        children: [],
      },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/candidate-retained-parent-owner',
      gameplayType: 'audit.candidate-retained-parent-owner',
      root: {
        components: [],
        children: [{
          localName: 'mount',
          visible: true,
          components: [{
            key: 'state',
            type: RetainedValueProbe.typeId,
            properties: { value: 1 },
          }],
          children: [],
        }],
      },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: 'mount',
        allowedPrefabIds: [child.id],
        maximumInstances: 1,
      }],
      resolveState(state) {
        return {
          nodes: { mount: { visible: state.parentVisible } },
          components: { 'mount/state': { value: state.value } },
          prefabSlots: {
            children: state.show ? { only: { prefabId: child.id } } : {},
          },
        };
      },
    });
    const { runtime } = await createHarness({
      prefabEntries: [owner, child],
      configureComponents: registerRetainedCandidateProbes,
    });
    t.after(() => runtime.dispose());

    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
      state: { show: false, parentVisible: true, value: 1 },
    }), { sourceTickDelta: 1 });
    commitAuthority(runtime, () => runtime.authority.setNodeState({
      name: ownerName,
      state: { show: true, parentVisible: false, value: 42 },
    }), { sourceTickDelta: 1 });

    const parent = runtime.currentView().getNode(parentNodeName);
    assert.equal(parent.visibleSelf, false);
    assert.deepEqual(parent.childNames, [expectedChildName]);
    assert.equal(parent.getComponentState('state').properties.value, 42);
  });

test('a second sibling attach failure preserves every retained live baseline', async (t) => {
  const child = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-retained-rollback-child',
    gameplayType: 'audit.candidate-retained-rollback-child',
    root: {
      components: [{
        key: 'probe',
        type: CandidateRollbackProbe.typeId,
        properties: { tag: 'base', fail: false },
      }],
      children: [],
    },
    resolveState(state) {
      return {
        components: {
          '$root/probe': { tag: state.tag, fail: state.fail },
        },
      };
    },
  });
  const owner = definePrefab({
    schema: PREFAB_DEFINITION_SCHEMA,
    id: 'audit/candidate-retained-rollback-owner',
    gameplayType: 'audit.candidate-retained-rollback-owner',
    root: {
      components: [],
      children: [{
        localName: 'mount',
        transform: IDENTITY,
        visible: true,
        components: [{
          key: 'state',
          type: RetainedValueProbe.typeId,
          properties: { value: 1 },
        }],
        children: [],
      }],
    },
    prefabSlots: [{
      key: 'children',
      parentLocalPath: 'mount',
      allowedPrefabIds: [child.id],
      maximumInstances: 2,
    }],
    resolveState(state) {
      return {
        nodes: {
          mount: {
            transform: state.mountTransform,
            visible: state.parentVisible,
          },
        },
        components: { 'mount/state': { value: state.value } },
        prefabSlots: {
          children: state.show
            ? {
              alpha: { prefabId: child.id, state: { tag: 'alpha', fail: false } },
              bravo: { prefabId: child.id, state: { tag: 'bravo', fail: true } },
            }
            : {},
        },
      };
    },
  });
  const { runtime } = await createHarness({
    prefabEntries: [owner, child],
    configureComponents: registerRetainedCandidateProbes,
  });
  t.after(() => runtime.dispose());
  const ownerName = 'py/candidate-retained-rollback';
  const mountName = `prefab/${ownerName}/mount`;
  const initialState = {
    show: false,
    mountTransform: IDENTITY,
    parentVisible: true,
    value: 1,
  };
  commitAuthority(runtime, () => runtime.authority.createNode({
    ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
    state: initialState,
  }), { sourceTickDelta: 1 });

  const ownerNode = runtime._nodeIndex.require(ownerName);
  const authority = ownerNode.requireComponent('authority');
  const mount = runtime._nodeIndex.require(mountName);
  const stateComponent = mount.requireComponent('state');
  const scope = runtime._prefabInstantiator.getScope(ownerNode);
  const baseline = {
    authorityState: authority.state,
    componentProperties: stateComponent.properties,
    cursor: runtime.summary().cursor,
    indexEntries: new Map([...runtime._nodeIndex.values()].map((node) => [node.name, node])),
    localTransform: mount.localTransform,
    nodeCount: runtime._nodeIndex.size,
    records: scope.records,
    scopeState: scope.state,
  };
  CandidateRollbackProbe.constructed = new Set();
  const changedTransform = {
    position: [9, 8, 7],
    rotationXyzw: [0, 0, 0, 1],
    scale: [2, 2, 2],
  };
  const cursor = nextCursor(runtime);
  runtime.commitGate.begin(cursor);
  let caught = null;
  try {
    runtime.authority.setNodeState({
      name: ownerName,
      state: {
        show: true,
        mountTransform: changedTransform,
        parentVisible: false,
        value: 99,
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.code, 'audit-candidate-second-attach-failure');
  assert.strictEqual(authority.state, baseline.authorityState);
  assert.strictEqual(scope.state, baseline.scopeState);
  assert.strictEqual(scope.records, baseline.records);
  assert.strictEqual(mount.localTransform, baseline.localTransform);
  assert.equal(mount.visibleSelf, true);
  assert.strictEqual(stateComponent.properties, baseline.componentProperties);
  assert.equal(runtime._nodeIndex.size, baseline.nodeCount);
  for (const [name, node] of baseline.indexEntries) {
    assert.strictEqual(runtime._nodeIndex.require(name), node);
  }
  assert.equal(runtime._nodeIndex.get(`prefab/${ownerName}/children/alpha`), null);
  assert.equal(runtime._nodeIndex.get(`prefab/${ownerName}/children/bravo`), null);
  assert.deepEqual(runtime.summary().cursor, baseline.cursor);
  assert.equal(CandidateRollbackProbe.constructed.size, 2);
  assert.equal([...CandidateRollbackProbe.constructed]
    .every((component) => component.disposed), true);
  runtime.commitGate.fail(caught);
});

test('multiple removed siblings regain exact order and identity after a later patch failure',
  async (t) => {
    const child = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/removal-forest-child',
      gameplayType: 'audit.removal-forest-child',
      root: {
        components: [],
        children: [{ localName: 'body', components: [], children: [] }],
      },
    });
    const owner = definePrefab({
      schema: PREFAB_DEFINITION_SCHEMA,
      id: 'audit/removal-forest-owner',
      gameplayType: 'audit.removal-forest-owner',
      root: {
        components: [],
        children: [{
          localName: 'mount',
          transform: IDENTITY,
          visible: true,
          components: [{
            key: 'state',
            type: RetainedValueProbe.typeId,
            properties: { value: 1 },
          }],
          children: [],
        }],
      },
      prefabSlots: [{
        key: 'children',
        parentLocalPath: 'mount',
        allowedPrefabIds: [child.id],
        maximumInstances: 5,
      }],
      resolveState(state) {
        return {
          nodes: {
            mount: {
              transform: state.mountTransform,
              visible: state.parentVisible,
            },
          },
          components: { 'mount/state': { value: state.value } },
          prefabSlots: {
            children: Object.fromEntries(state.keys.map((key) => [
              key,
              { prefabId: child.id },
            ])),
          },
        };
      },
    });
    const { runtime } = await createHarness({
      prefabEntries: [owner, child],
      configureComponents: registerRetainedCandidateProbes,
    });
    t.after(() => runtime.dispose());
    const ownerName = 'py/removal-forest';
    const mountName = `prefab/${ownerName}/mount`;
    const childName = (key) => `prefab/${ownerName}/children/${key}`;
    const initialKeys = ['alpha', 'bravo', 'charlie', 'delta'];
    commitAuthority(runtime, () => runtime.authority.createNode({
      ...authorityCommand({ name: ownerName, parentName: null, prefabId: owner.id }),
      state: {
        keys: initialKeys,
        mountTransform: IDENTITY,
        parentVisible: true,
        value: 1,
      },
    }), { sourceTickDelta: 1 });

    const ownerNode = runtime._nodeIndex.require(ownerName);
    const authority = ownerNode.requireComponent('authority');
    const mount = runtime._nodeIndex.require(mountName);
    const stateComponent = mount.requireComponent('state');
    const scope = runtime._prefabInstantiator.getScope(ownerNode);
    const baselineRoots = new Map(initialKeys.map((key) => [
      key,
      runtime._nodeIndex.require(childName(key)),
    ]));
    const baselineBodies = new Map(initialKeys.map((key) => [
      key,
      runtime._nodeIndex.require(`${childName(key)}/body`),
    ]));
    const baseline = {
      authorityState: authority.state,
      componentProperties: stateComponent.properties,
      cursor: runtime.summary().cursor,
      localTransform: mount.localTransform,
      nodeCount: runtime._nodeIndex.size,
      records: scope.records,
      scopeState: scope.state,
    };
    const originalPropertiesChanged = runtime._componentPropertiesChanged.bind(runtime);
    const failure = new Error('injected retained patch failure after removal and adoption');
    failure.code = 'audit-removal-forest-late-patch-failure';
    runtime._componentPropertiesChanged = (component) => {
      originalPropertiesChanged(component);
      if (component === stateComponent && component.properties.value === 99) throw failure;
    };
    const changedTransform = {
      position: [6, 5, 4],
      rotationXyzw: [0, 0, 0, 1],
      scale: [3, 3, 3],
    };
    const cursor = nextCursor(runtime);
    runtime.commitGate.begin(cursor);
    let caught = null;
    try {
      runtime.authority.setNodeState({
        name: ownerName,
        state: {
          keys: ['alpha', 'delta', 'echo'],
          mountTransform: changedTransform,
          parentVisible: false,
          value: 99,
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      runtime._componentPropertiesChanged = originalPropertiesChanged;
    }

    assert.strictEqual(caught, failure);
    assert.deepEqual(mount.children.map((node) => node.name), initialKeys.map(childName));
    for (const key of initialKeys) {
      assert.strictEqual(runtime._nodeIndex.require(childName(key)), baselineRoots.get(key));
      assert.strictEqual(runtime._nodeIndex.require(`${childName(key)}/body`), baselineBodies.get(key));
      assert.equal(baselineRoots.get(key).disposed, false);
      assert.equal(baselineBodies.get(key).disposed, false);
    }
    assert.equal(runtime._nodeIndex.get(childName('echo')), null);
    assert.equal(runtime._nodeIndex.get(`${childName('echo')}/body`), null);
    assert.equal(runtime._nodeIndex.size, baseline.nodeCount);
    assert.strictEqual(scope.records, baseline.records);
    assert.strictEqual(scope.state, baseline.scopeState);
    assert.strictEqual(authority.state, baseline.authorityState);
    assert.deepEqual(mount.localTransform, baseline.localTransform);
    assert.equal(mount.visibleSelf, true);
    assert.strictEqual(stateComponent.properties, baseline.componentProperties);
    assert.deepEqual(runtime.summary().cursor, baseline.cursor);
    runtime.commitGate.fail(caught);
  });
