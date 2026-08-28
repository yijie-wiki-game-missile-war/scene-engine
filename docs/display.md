# Display Node, Prefab, Component and catalog contract

This is the only current browser Display model. There is no compatibility decoder, local-edit port, alternate Node tree or
fallback runtime.

## Release tuple

```text
scene-engine Python                 0.9.0
@scene-engine/client               0.10.0
@scene-engine/display              0.4.0
@scene-engine/renderer-three       0.9.3
wire                               scene-engine-wire@2
display                            scene-engine-display-node@3
catalog manifest                   scene-engine-display-catalog-manifest@1
packet log                         scene-engine-packet-log@2
```

The package publishes `src/index.d.ts` and exports only the root API listed by `src/index.js`.

## One runtime, one graph

One `DisplayRuntime` owns:

- one active Scene;
- one NodeIndex and one NodeGraph;
- one local TRS per Node;
- one ComponentScheduler;
- one RenderSystem;
- one application RAF.

Every Node local Transform is:

```js
{
  position: [x, y, z],
  rotationXyzw: [x, y, z, w],
  scale: [x, y, z],
}
```

The boundary copies finite numbers, normalizes nonzero quaternions and rejects non-positive scale. A Component never owns a
second Transform. Anything needing an independent pose is a child Node.

Canonical names are immutable lowercase paths under exactly:

```text
sys/ scene/ py/ prefab/
```

Names are at most 192 UTF-8 bytes; maximum tree depth is 128. Python supplies complete `py/` names and never addresses
Prefab-local names.

## Catalog and identity

All definitions and registries are complete before runtime construction. `DisplayRuntime` builds a canonical manifest, computes
its identity, then seals Scene, Prefab, Resource and Component registries.

Required constructor input includes one state-schema identity for each gameplay type used by a Prefab:

```js
const authorityStateSchemas = [
  { gameplayType: 'unit.basic', schemaId: 'unit.basic.state', revision: 1 },
];
```

The manifest contains sorted, closed descriptions of:

```text
scenes
prefabs
resources
components
authorityStateSchemas
```

`computeDisplayCatalogIdentity(manifest)` generates three independent lowercase SHA-256 values:

- Scene catalog hash;
- Prefab/Resource/Component catalog hash;
- authority-state schema hash.

`toDisplayCatalogIdentityRecord(identity)` converts them to the snake-case JSON record loaded by Python. Registration order does
not change identity; duplicate IDs, duplicate gameplay-type schemas or incomplete schema coverage fail. Client compares
`runtime.catalogIdentity()` with checkpoint identity before `installScene`.

The manifest contains declarative data, not JavaScript function source. Therefore:

- changing a Prefab resolver or its state-to-patch semantics requires increasing that Prefab's `revision`;
- changing a custom Component normalizer, resource-reference contract or behaviour semantics requires a new versioned `typeId`;
- changing an authority-state contract requires increasing its schema `revision` or changing `schemaId`.

A model component with animation requires the model Resource descriptor to declare a closed `clipNames` catalog. Display checks
`clipId` against it before mutation; the backend later verifies that the loaded asset actually contains the declared clip. A
mismatch between descriptor and asset is a catalog/build defect, not a command that may be ACKed and repaired later.

## Prefab identity

`PrefabDefinition.id` is the exact, unique display-catalog key. `PrefabDefinition.gameplayType` is non-unique metadata describing
the complete authority-state contract consumed by its resolver. Multiple visual Prefabs may share one gameplay type.

Authority create and replace operations carry exact `prefabId`. Lookup or implicit selection by gameplay type is forbidden on
the production path.

A Prefab resolver is pure, synchronous and deterministic. It receives complete authority state and returns only closed Node and
Component patches. Replacement stages and validates an unregistered shadow scope, then swaps it for one authority target;
old and new Prefab-local canonical names are never simultaneously present in NodeIndex.

## Authority boundary

Python owns each `py/` root's:

```text
name / existence / parent / local Transform / visibility / prefabId / complete state
```

The Authority surface contains only single-target operations:

```text
createNode
setNodeTransform
setNodeParent
setNodeVisible
setNodeState
replaceNodePrefab
removeNode
```

`null` parent means `sys/authority-root`; a non-null parent must be an existing `py/` root. `setNodeState` is complete replacement,
not merge patch.

Checkpoint bootstrap may create authority roots after `installScene` and before `activate`. Once activated, every Authority call
must occur between an exact `commitGate.begin(cursor)` and `commitGate.seal(cursor)`. Calls outside an open gate fail with no
mutation. Authority operations throw on failure; once a transaction has begun, the Client or a direct manual caller must call
`commitGate.fail(error)`. The production Client path does this automatically. Failing the gate closes drawing, stops scheduling
and marks the projection invalid.

This rule is implementation-enforced, not merely documented.

## Component capability boundary

The following Component properties are read-only values or snapshots:

```text
key / enabled / properties / NodeView
```

The controlled public methods are `setEnabled`, `setDrivenLocalTransform` for an eligible transform-driving Behaviour, and
`dispose`; none of them grants mutable Node-tree access.

Behaviour hooks receive a frozen public Display context with:

- read-only Scene identity and active-camera name;
- `get/require/has` NodeView lookup;
- world-transform queries.

They do not receive NodeIndex, NodeGraph, AuthorityPort, RenderSystem, scheduler or raw Node objects. `Component.node` is a
read-only NodeView. A class declaring `drivesTransform=true` may call `setDrivenLocalTransform` only for its own non-authority
Node; it cannot move a Python authority root or another Node.

Only synchronous optional lifecycle handlers exist:

```text
onAttach(display)
tick(frame)
onDispose(display, reason)
```

Only BehaviourComponents tick. RenderComponents are declarative and cannot implement handlers. Promise-returning handlers fail.
Attach order is Node preorder then declaration order; disposal is child-before-parent then reverse declaration order.

Component properties are deeply frozen and can change only through:

```js
componentRegistry.patchComponentProperties({
  component,
  patch,
  resourceRegistry,
});
```

The registry merges the candidate, normalizes the complete value, validates all Resource IDs and kinds, then replaces the
property identity atomically. On failure, previous properties, dirty state, resource leases and draw request remain unchanged.

## Render-state validation before seal

Display owns the full schema for built-in renderer properties. It validates nested values before any node mutation or commit
seal, including:

- model material overrides and animation (`clipId`, `startTick`, `clock`, `loop`);
- sprite material/frame/flipbook bounds;
- surface material, family and parameter records;
- particle capacity, vectors, parameters and animation;
- camera, background and all light-specific fields.

Resource-dependent checks use the registered descriptor, for example model clip catalogs and texture-atlas frame bounds. The
Three backend keeps defensive validation, but an invalid business record must not first fail on the next RAF after ACK.

## Checkpoint, commit and summary

A checkpoint carries Scene name, three catalog hashes, command cursor and parent-first authority roots. Client creates a fresh
session, verifies catalog identity, installs the Scene, bootstraps roots, activates and starts it, then swaps the session.

A commit closes the draw gate, applies every command, flushes transforms and seals the exact cursor. JavaScript run-to-completion
prevents RAF from observing a partial transaction. The seal is not cross-command rollback; any command failure invalidates the
whole projection and emits no ACK.

`DisplayRuntime.summary()` is O(1):

```js
{
  schema: 'scene-engine-display-summary@1',
  sceneName: 'main',
  revision: 123,
  cursor: { commitSeq: 123, sourceTick: 121, lastCommandSeq: 992 },
  nodeCount: 1503,
  health: 'ready',
}
```

`currentView()` is an explicit immutable full-tree snapshot for picking/focus resolution, diagnostics and tests. It is never
constructed automatically for each commit observer.

## Frame and renderer lifecycle

Frame order is:

```text
update
world-transform flush
before-render
world-transform flush
RenderSystem.prepareFrame
RenderBackend.render()
```

`sourceTick` is simulation time. `visualSeconds` and `deltaSeconds` are visual-only and cannot create gameplay facts.

One backend binding is identified by `(nodeName, componentKey)`. Runtime disposal stops RAF, closes the gate, aborts pending
work, unloads Scene and Prefab scopes, disposes Components and RenderSystem, empties NodeIndex and releases references.
Repeated `dispose()` calls return the same completion operation.

Renderer failure can use explicit `rebuildRenderBackend()` when recoverable; this remounts declarative bindings while preserving
Node and Component identity. Authority/Display projection failure instead requires a fresh checkpoint/session.
