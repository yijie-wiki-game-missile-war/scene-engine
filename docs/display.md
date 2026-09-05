# Display Node, Prefab, Component and catalog contract

This is the only current browser Display model. There is no compatibility decoder, local-edit port, alternate Node tree or
fallback runtime.

## Release tuple

```text
scene-engine Python                 0.19.0
@scene-engine/client               0.16.0
@scene-engine/display              0.18.0
@scene-engine/renderer-three       0.15.3
wire                               scene-engine-wire@3
display                            scene-engine-display-node@9
scene definition                   scene-engine-scene-definition@3
prefab definition                  scene-engine-prefab-definition@5
catalog manifest                   scene-engine-display-catalog-manifest@3
packet log                         scene-engine-packet-log@3
```

The package publishes `src/index.d.ts` and exports only the root API listed by `src/index.js`.

## One runtime, one graph

One `DisplayRuntime` owns:

- one active Scene;
- one NodeIndex and one NodeGraph;
- one authority-root Matrix4 pool indexed by stream-stable ID, plus browser-owned matrices for Scene/Prefab Nodes;
- one ComponentScheduler;
- one RenderSystem;
- one AnimationSystem;
- one private flat Prefab materialization ledger;
- one application RAF.

Every Node local Transform is exactly one 16-value column-major Matrix4:

```js
[
  m00, m10, m20, 0,
  m01, m11, m21, 0,
  m02, m12, m22, 0,
   tx,  ty,  tz, 1,
]
```

Python's hot-path owner is `DisplayMatrixPool`: it retains one contiguous NumPy `ndarray` with shape `(n,4,4)`, dtype `<f4`
and axes `[node,column,row]`. A row is selected directly by `node_id` and already has the exact column-major byte order used on
Wire. `DisplayTransform` remains the immutable value/convenience type used to author or snapshot one row; neither type has a
persistent byte or TRS sidecar.
`DisplayTransform(matrix_bytes=...)` copies exactly 64 immutable input bytes into that owner without interpreting their sixteen
binary32 bit patterns. `DisplayTransform.from_matrix(...)` exists for numeric authoring and converts exactly sixteen
column-major values to little-endian float32; neither path canonicalizes negative zero or checks finite, affine or determinant
rules.

The browser Client is the first semantic boundary. It reads each matrix tensor into one owned Float32Array, canonicalizes negative zero,
requires finite affine entries (`m[3]=m[7]=m[11]=0`, `m[15]=1`) and requires the upper-left 3x3 determinant to be positive and
nonzero. Shear is legal; reflections and singular matrices are not. Display repeats the check defensively and stores authority
rows in one shared pool. Each authority Node resolves its local row by ID; public views return immutable copies, never the
mutable owner.

NodeGraph owns one Float64Array world matrix per Node. A root copies its local matrix; a child computes exactly
`parentWorld * localMatrix`. There is no position/quaternion/scale cache, decomposition or TRS hierarchy path. The wider world
accumulator avoids a new float32 rounding at every depth; the renderer still receives the resulting matrix directly. Every
derived entry must remain finite; hierarchy overflow fails the synchronous commit seal before its cursor can be ACKed. float16
is not accepted because its spacing is too coarse for unrestricted world coordinates.

### Matrix convenience API

Product and display-authoring code does not need to hand-write sixteen values. Python exposes pure methods on
`DisplayTransform`; JavaScript exposes one frozen `DisplayTransform` facade from `@scene-engine/display`:

| Operation | Python | JavaScript |
| --- | --- | --- |
| direct matrix construction | `DisplayTransform(matrix_bytes=raw)` / `from_matrix(values)` | Client binary decode |
| identity / TRS construction | `identity()` / `from_trs(...)` | `identity()` / `fromTRS(...)` |
| full composition | `parent.composed(local)` | `compose(parent, local)` |
| absolute parent-space origin | `with_translation(position)` | `withTranslation(matrix, position)` |
| absolute basis-column lengths | `with_scale(scale)` | `withScale(matrix, scale)` |
| relative translation | `translated_self/parent(delta)` | `translatedSelf/Parent(matrix, delta)` |
| relative axis-angle rotation | `rotated_self/parent(axis, radians)` | `rotatedSelf/Parent(matrix, axis, radians)` |
| relative positive scale | `scaled_self/parent(factors)` | `scaledSelf/Parent(matrix, factors)` |
| point/vector conversion | `transform_*` / `inverse_transform_*` | `transform*` / `inverseTransform*` |

```python
pose = DisplayTransform.from_trs(position=(10, 0, 2), scale=(2, 2, 2))
pose = pose.translated_self((0, 0, 4)).rotated_parent((0, 1, 0), math.pi / 2)
pool.set(ship_id, pose)
command = DisplayCommand.set_transform_batch((ship_id,))
```

```js
let pose = DisplayTransform.fromTRS({ position: [10, 0, 2], scale: [2, 2, 2] });
pose = DisplayTransform.rotatedParent(
  DisplayTransform.translatedSelf(pose, [0, 0, 4]),
  [0, 1, 0],
  Math.PI / 2,
);
```

Every convenience operation returns a new immutable binary32 Matrix4 and never changes the source, relaxes the Matrix4
boundary to accept a TRS record, or stores TRS beside the matrix. Python deliberately leaves final matrix semantics to Client;
the JavaScript facade returns canonical accepted matrices. `from_trs`/`fromTRS` accepts transient `position`, normalizes a
nonzero `rotation_xyzw`/`rotationXyzw`, and accepts positive `scale` only to construct the resulting matrix.

Python keeps the existing read API while protecting the NumPy owner: `matrix` returns the immutable 16-value column-major
representation, while `matrix_bytes` creates an exact temporary 64-byte little-endian serialization. Neither accessor exposes
a writable array, and `matrix_bytes` is not identity-preserving with bytes passed to the constructor. Binary Display encoding
reads the resident column-major array directly and writes the same 64 bytes to the attachment.

Let the local basis and origin be `B` and `t`. The suffix is mandatory because a local matrix by itself cannot perform a true
world-space edit when it has an unknown parent:

```text
translated self:        t' = t + B * delta
translated parent:      t' = t + delta
rotated/scaled self:    B' = B * operation
rotated/scaled parent:  B' = operation * B
```

Rotation and scale keep `t` fixed; they do not orbit around the parent origin. `withScale` sets the positive length of each
basis column while preserving its direction, the angles between columns, authored shear and translation. There is no general
matrix-to-quaternion/Euler decomposition, lossy world scale, or context-free world mutation API. Continuous target facing uses
the existing `LookAtComponent`; it is not duplicated as a second transform owner.

Point conversion uses homogeneous `w=1`, so it includes translation. Vector conversion uses `w=0`, so it excludes translation
but includes rotation, scale and shear; it is intentionally not named `transformDirection`, whose Unity meaning ignores scale.
Inverse conversion uses the complete affine inverse rather than an orthogonal-only shortcut. Returned vectors are immutable
finite triples and are not quantized to float32.

Wire authority identity is a stable `uint32 node_id`, used directly as the Python and browser authority-matrix-pool row. IDs
allocate monotonically and are not reused inside a stream; removal leaves a zero tombstone until the next stream. Display maps
an authority ID to the internal canonical name `py/<decimal-id>`, but this string never crosses Wire.

Browser-local canonical names are immutable lowercase paths under exactly:

```text
sys/ scene/ py/ prefab/
```

Names are at most 192 UTF-8 bytes; maximum tree depth is 128. Python never addresses a canonical name or Prefab-local path;
checkpoint Nodes and structural commands carry numeric node/parent IDs. A nested materialization prefixes `prefab/` exactly
once, followed by the outer owner and accumulated
instance/local path, for example `prefab/py/0/tiles/tile-q0-r0/body`; it never constructs
`prefab/prefab/...`.

The materialization ledger records definition-instance provenance, source keys and owned ordinary Nodes/Components. NodeIndex,
NodeGraph and the one authority MatrixPool remain the only runtime hierarchy/Transform owners; the ledger is package-private bookkeeping for diff,
animation scope, rollback and disposal, not a second tree or a caller-visible child-Prefab object.

## Catalog and identity

All definitions and registries are complete before runtime construction. `DisplayRuntime` builds a canonical manifest, computes
its browser-local identity, then seals Display Kind, Scene, Prefab, Resource and Component registries.

Required constructor input includes a `displayKindRegistry` and one state-schema identity for each gameplay type used by a
Display Kind or Prefab:

```js
const authorityStateSchemas = [
  { gameplayType: 'unit.basic', schemaId: 'unit.basic.state', revision: 1 },
];
```

The manifest contains sorted, closed descriptions of:

```text
scenes
displayKinds
prefabs
resources
components
authorityStateSchemas
```

`computeDisplayCatalogIdentity(manifest)` generates three independent lowercase SHA-256 values:

- Scene catalog hash;
- Display Kind/Prefab/Resource/Component catalog hash;
- authority-state schema hash.

`toDisplayCatalogIdentityRecord(identity)` remains an optional local artifact-tooling conversion. Python does not load these
hashes and Client does not compare them with producer bytes. Registration order does not change identity; duplicate IDs,
invalid Kind-to-Prefab mappings, duplicate gameplay-type schemas or incomplete schema coverage fail.

Prefab compilation is registry-aware. Its dependency graph includes every fixed child reference and every dynamic slot
allowlist entry. Missing definitions, self/mutual cycles, illegal mounts, duplicate keys, name/depth expansion failures and
configured instance limits fail before Scene installation; definitions shared by a dependency DAG are compiled once. The
conservative compiled expansion bound is 65,536 ordinary Nodes per outer instance, in addition to the existing 128-level graph
depth and 192-byte canonical-name limits.

The manifest contains declarative data, not JavaScript function source. Therefore:

- changing a Prefab resolver or its state-to-patch semantics requires increasing that Prefab's `revision`;
- changing a Display Kind selector's semantics requires increasing that Kind's `revision` because function source is not hashed;
- changing fixed child declarations, slot allowlists or slot limits changes the Prefab catalog hash through the canonical
  declaration;
- changing a custom Component normalizer, resource-reference contract or behaviour semantics requires a new versioned `typeId`;
- changing an authority-state contract requires increasing its schema `revision` or changing `schemaId`.

A static `animation.player@1` binding is preflighted at Prefab compile time against that definition instance's own root tree and
the Resource registry (target node, component type, atlas usage, frame bounds, output ownership). A parent definition cannot
target a nested child's internals. A mismatch between descriptor and Prefab is a catalog/build defect, not a command that may be
ACKed and repaired later. Runtime animation switches repeat the same checks with the same error codes. See
[Display animator](display-animation.md).

## Prefab identity and composition

`PrefabDefinition.id` is the exact, unique display-catalog key. `PrefabDefinition.gameplayType` is non-unique metadata describing
the complete state contract consumed by its resolver. Multiple visual Prefabs may share one gameplay type. Nested and Scene
composition still use exact `prefabId`; gameplay type never selects a Prefab.

The outer Authority boundary instead uses a `DisplayKindDefinition`:

```js
const kind = defineDisplayKind({
  id: 'display.unit/fighter@1',
  gameplayType: 'unit.basic',
  revision: 1,
  authorityPrefabIds: ['visual/fighter-a', 'visual/fighter-b'],
  resolvePrefab(state) {
    if (state.variant === 'a') return 'visual/fighter-a';
    if (state.variant === 'b') return 'visual/fighter-b';
    return null;
  },
});
const displayKindRegistry = createDisplayKindRegistry([kind]);
```

An empty allowlist is a known unimplemented requirement. A non-empty list has exactly one explicit policy: either
`defaultPrefabId` or synchronous `resolvePrefab(state)`. A selector returns an allowed exact ID, or `null`/`undefined` when a
legal state has no current selection. Registration order never chooses an implementation. Selector exceptions and Promises
fail closed.

Schema `scene-engine-prefab-definition@5` defines matrix-native definition-owned composition and its public transient-event
names:

```js
const islandPrefab = definePrefab({
  schema: PREFAB_DEFINITION_SCHEMA,
  id: 'world/island',
  revision: 3,
  gameplayType: 'island',
  events: ['explode', 'hit'],
  root: islandRoot,
  prefabInstances: [{
    key: 'harbour',
    parentLocalPath: null,
    prefabId: 'world/harbour',
    transform: harbourTransform,
    visible: true,
    state: { damaged: false },
  }],
  prefabSlots: [{
    key: 'tiles',
    parentLocalPath: null,
    allowedPrefabIds: ['world/tile-grass', 'world/tile-rock'],
    maximumInstances: 96,
  }],
  resolveState(state) {
    return {
      nodes: {},
      components: {},
      prefabInstances: {
        harbour: { visible: state.harbourVisible, state: state.harbour },
      },
      prefabSlots: {
        tiles: Object.fromEntries(state.tiles.map((tile) => [tile.key, {
          prefabId: tile.prefabId,
          transform: tile.transform,
          visible: tile.visible,
          state: tile.visualState,
        }])),
      },
    };
  },
});
```

Fixed definitions use
`{key, parentLocalPath, prefabId, transform?, visible?, state?}`. A missing fixed-child resolver override resets that child to
its declaration baseline; the child itself continues to exist. Omitted declaration values mean identity Transform, visible and
empty complete state. Use a slot with `maximumInstances: 1` for an optional singleton.

Dynamic slots use `{key, parentLocalPath, allowedPrefabIds, maximumInstances}`. Resolver output for a slot is a record from a
stable instance key to `{prefabId, transform?, visible?, state?}`. It is the complete desired set on every call, never a delta:
a missing slot output is empty. A runtime-selected `prefabId` must be in the slot allowlist and the desired count must not exceed
`maximumInstances`. The allowlist is non-empty and unique, the limit is a positive safe integer, and omitted per-instance values
mean identity Transform, visible and empty complete state. Definition keys and dynamic instance keys are one canonical path
segment each and at most 192 UTF-8 bytes.

`parentLocalPath: null` mounts below the current definition instance root. A non-null path may name only an ordinary Node in the
current definition's own root tree. It cannot traverse into another child instance, and dynamic composition cannot create a
second parent graph.

Every resolver is pure, synchronous and deterministic. It receives the complete state for that definition instance and may
return only closed `nodes`, `components`, `prefabInstances` and `prefabSlots` outputs. Child `state` is also a complete
replacement and recursively feeds that child's resolver. Dynamic structure may come only from this resolution step, not from a
Behaviour, RAF callback, Resource load or renderer.

## Runtime materialization and diff

Nested Prefabs are authoring/catalog constructs. On Scene or authority creation, Display resolves them recursively and creates
ordinary `Node` and `Component` objects in the one existing NodeIndex and NodeGraph. Once play begins there is no runtime-visible
child-Prefab object, no public nested-scope API and no second tree. The game continues to address only the outer Scene instance
or `py/` authority root.

For one dynamic slot, identity is `(slot key, instance key, prefabId)`:

- the same keys and `prefabId` retain Node/Component identity while transform, visibility and complete state update;
- a new instance key adds one recursively materialized subtree;
- a missing instance key removes it child-before-parent;
- the same instance key with a different `prefabId` replaces it and starts a new instance lifecycle.

A fixed child is retained by its declaration key and exact `prefabId`; resolver overrides update only its Transform,
visibility and complete state. Its nested descendants follow the same recursive rules.

Display first resolves and validates the complete recursive candidate. Additions and replacements are staged off the live
index; only a valid candidate is adopted, retained patches applied and old subtrees disposed. Validation or staging failure
leaves the live materialization unchanged. An adopt failure rolls back the current single operation where possible; if rollback
cannot restore the projection, the commit gate fails closed and a fresh checkpoint/session is required. The existing commit
contract still does not promise rollback across multiple Authority commands.

Outer kind resolution preserves the Authority Node's numeric ID, derived name, parent and authority-owned children. The same
selected Prefab reconciles in place; a changed selection stages and adopts a replacement ledger. Old and new Prefab-local names
are never simultaneously present in NodeIndex. Losing a selection disposes only Prefab-local content and retains the root.

## Authority boundary

Python owns each authority root's:

```text
nodeId / existence / parentNodeId / MatrixPool row / visibility / displayKindId / complete state
```

This is deliberately the outer boundary. Python does not publish commands for definition-owned child instances, does not know
their Prefab-local paths and cannot address them through `prefab/...` names. `setNodeState` replaces the outer complete state;
the registered synchronous resolvers derive all nested desired instances and child complete states inside the same Display
operation.

The Authority surface installs one full matrix pool for a checkpoint, stages one dirty matrix block per commit and consumes all
existing-row updates through one vector-targeted command. Structural/state operations remain single-ID calls:

```text
installNodeMatrixPool
applyNodeTransformBatch
createNode
setNodeTransforms
setNodeParent
setNodeVisible
setNodeState
setNodeProperty
unsetNodeProperty
emitNodeEvent
setNodeDisplayKind
removeNode
```

`setNodeTransforms` receives one strictly increasing `Uint32Array` and consumes all of its staged rows atomically at that
command's sequence position. Validation of every target completes before any row is copied or Node is marked dirty; the whole
batch invokes the mutation hook once. New rows are not part of this call: their staged suffix rows are claimed by the ordered
`createNode` records.

`null` parent means `sys/authority-root`; a non-null parent ID must be an existing authority root. `setNodeState` is complete
replacement, not merge patch. It reruns kind selection before reconciling, replacing, removing or adding materialization.

Every syntactically valid create first installs the Authority root. Current gaps are bounded by live Authority IDs and exposed
through `currentDiagnostics()`; `onDiagnostic` receives only transitions, not an unbounded history:

| Resolution | Diagnostic | Severity | ACK |
| --- | --- | --- | --- |
| kind absent | `display-kind-unknown-requirement` | warning | yes |
| known kind with empty allowlist | `display-kind-unimplemented` | warning | yes |
| non-empty kind cannot select | `display-kind-selection-unresolved` | error | yes |

Each gap root retains MatrixPool row, hierarchy, visibility and complete state. `setNodeState`, property set/unset and kind
change can later materialize it. Selector exceptions, malformed JSON, an invalid selected Prefab or materialization failure
remain fail-closed and produce no ACK.

`setNodeProperty` and `unsetNodeProperty` first construct a complete outer-state candidate and then reuse the exact
`setNodeState` resolver/reconcile transaction. They address only one top-level name; dots are literal and do not form a path.
JSON `null` remains a value, while unsetting a missing member fails closed. Names are at most 192 UTF-8 bytes and use the
Display @9 fixed forbidden-code-point table documented in `wire.md`; this rejects whitespace, control/format, surrogate,
private-use and noncharacter code points plus JavaScript prototype-pollution names, while allowing `Cn` so runtime Unicode
versions cannot disagree. The complete candidate remains subject to the product Prefab resolver/state contract, so a schema
may reject an otherwise syntactically valid field. A property value has one fewer JSON-depth level than complete state because
inserting the member adds the outer state-object level; this is validated before the Authority candidate is applied.

`emitNodeEvent` on a materialized root requires the current outer Prefab to declare `eventName`. It routes only within that Prefab definition record,
to enabled Behaviour components whose registered Component class explicitly includes the name in static `eventNames`.
Recipients run in Node preorder and declaration order. The frozen handler record is
`{eventName, payload, commandSeq, sourceTick}`; payload is a JSON object. A handler must return synchronously, and failure follows
the normal no-ACK/projection-invalid path. On an empty gap root it is a successful no-op with no subscribers. Events do not
mutate Authority state or appear in checkpoints.

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

The controlled public methods are `setEnabled`, `setDrivenLocalTransform` for an eligible transform-driving Behaviour, the
animation operations `setAnimation` / `playAnimation` / `stopAnimation`, and `dispose`; none of them grants mutable Node-tree
access.

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
onEvent(display, event)
onDispose(display, reason)
```

Only BehaviourComponents tick or subscribe to events. A Behaviour declares subscriptions through static `eventNames`; a
Prefab's `events` list is the public allowlist, so neither declaration alone exposes an event. RenderComponents are declarative
and cannot implement handlers or subscriptions. Promise-returning handlers fail. Attach/event order is Node preorder then
declaration order; disposal is child-before-parent then reverse declaration order.

### Property projection and event handling quickstart

This example is the browser half of the
[Python publication quickstart](runtime.md#node-property-and-event-publication-quickstart). It uses only the public
`@scene-engine/display` API and connects the four required pieces: a registered Behaviour, its Prefab attachment, the Prefab's
public event allowlist and the resolver that projects complete authority state into Component properties.

```js
import {
  BehaviourComponent,
  PREFAB_DEFINITION_SCHEMA,
  createComponentRegistry,
  createDisplayKindRegistry,
  createPrefabRegistry,
  defineDisplayKind,
  definePrefab,
} from '@scene-engine/display';

class UnitStatusBehaviour extends BehaviourComponent {
  static typeId = 'game.unit-status@1';
  static eventNames = ['explode'];

  constructor(options) {
    super(options);
    this.lastExplosion = null;
  }

  onEvent(_display, event) {
    if (event.eventName !== 'explode') return;

    // Product-specific Display-local handling belongs here and must return
    // synchronously. Retaining the frozen record is safe for later visual ticks.
    // With the Python command order above, this.properties.dead is already true.
    this.lastExplosion = event;
  }
}

const componentRegistry = createComponentRegistry();
componentRegistry.register({
  ComponentClass: UnitStatusBehaviour,
  normalizeProperties(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('status properties must be an object');
    }
    if (typeof value.dead !== 'boolean') {
      throw new TypeError('dead must be a boolean');
    }
    if (!Number.isSafeInteger(value.coins) || value.coins < 0) {
      throw new TypeError('coins must be a non-negative safe integer');
    }
    return { dead: value.dead, coins: value.coins };
  },
  resourceReferences: () => [],
});

const unitPrefab = definePrefab({
  schema: PREFAB_DEFINITION_SCHEMA,
  id: 'game/state',
  revision: 1,
  gameplayType: 'game.state',
  events: ['explode'],
  root: {
    components: [
      {
        key: 'status',
        type: UnitStatusBehaviour.typeId,
        properties: { dead: false, coins: 0 },
      },
    ],
    children: [],
  },
  resolveState(state) {
    return {
      components: {
        '$root/status': {
          dead: state.dead,
          coins: state.coins,
        },
      },
    };
  },
});

const prefabRegistry = createPrefabRegistry([unitPrefab]);
const displayKindRegistry = createDisplayKindRegistry([defineDisplayKind({
  id: 'display.game/state@1',
  gameplayType: 'game.state',
  revision: 1,
  authorityPrefabIds: [unitPrefab.id],
  defaultPrefabId: unitPrefab.id,
})]);
const authorityStateSchemas = [
  { gameplayType: 'game.state', schemaId: 'game.state.authority', revision: 1 },
];

// Pass componentRegistry, displayKindRegistry, prefabRegistry, the Scene/Resource registries and
// authorityStateSchemas to the existing createDisplayRuntime(...) composition root.
```

`'$root/status'` addresses the `status` Component on this Prefab definition instance's root Node. A handler that starts an
animation can use the controlled animation methods and declarations from [Display-local animator](display-animation.md); the
event itself never carries animation progress or renderer state.

These three similarly named values belong to different layers:

| Value | Owner and update path | Checkpoint behavior |
| --- | --- | --- |
| authority property such as `dead` | Python's canonical World; `set_property` changes one top-level member of the outer complete authority state | must be rebuilt in the next `DisplayNode.state` |
| `component.properties.dead` | Display-owned frozen Component configuration derived by `resolveState` and registry normalization | rebuilt by resolving the authority state |
| `explode` event | one ordered Python command synchronously dispatched to subscribed Behaviours | never synthesized by a checkpoint |

There is no `onPropertyChanged` callback. Each `set_property`, `unset_property` or `set_state` operation builds a complete outer
authority-state candidate, reruns `resolveState` and reconciles its declarative Node/Component patches. Product code must not
call `setNodeProperty` or `emitNodeEvent` directly in production; `SceneEngineClient` invokes the Authority surface inside the
commit gate.

Event delivery requires all of the following: the current outer Prefab declares the name in `events`, the Component class is
registered and attached, the Behaviour is enabled, and its normalized `static eventNames` includes the name. Ordinary child
Nodes belonging to that same Prefab definition participate in preorder delivery; fixed or dynamic nested Prefab records do not.
Python cannot address a nested Prefab's event surface through its outer authority Node. A declared event with no enabled
subscriber is a successful empty delivery.

`onEvent(display, event)` receives one deeply frozen `{eventName, payload, commandSeq, sourceTick}` record and must return
synchronously. Throwing or returning a Promise fails the commit barrier, emits no ACK and invalidates the projection. Property,
event, Transform and reparent commands share one exact order: if a property command precedes an event, the handler observes the
new resolved Component properties; if the event comes first, it observes the old properties. Increase the Prefab `revision`
when resolver semantics change, and use a new versioned Component `typeId` when Behaviour, subscription or normalization
semantics change.

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

## Pointer interaction

`@scene-engine/display@0.16.0` adds a renderer-neutral single-pointer controller for the nine application events `click`,
`context-click`, `double-click`, `drag-grab`, `drag-move`, `drag-drop`, `proximity-enter`, `proximity-move` and
`proximity-leave`. `onPress` is an optional notification after claim; `onCancel` and `onError` report abnormal local lifecycle
instead of fabricating a completed click or drop.

The built-in non-rendering `PointerTargetComponent` has `typeId: 'interaction.pointer-target@1'`, `allowMultiple: false`, and
closed properties `{roles, data}`. `roles` is a required non-empty duplicate-free subset of `proximity`, `select`,
`drag-source`, `drop-surface` and `drop-target`; `data` is a required deeply frozen strict JSON object interpreted only by the
application. Display resolves a renderer binding to the nearest enabled pointer-target Component on its Node-parent chain,
including nested Prefab Nodes, without constructing `currentView()`.

DisplayRuntime exposes:

```js
pickInteraction({ clientX, clientY })
pickInteractionProximity({ clientX, clientY, radiusPixels })
screenPointToWorldRay({ clientX, clientY })
```

Exact interaction picking uses the backend's ordinary pick. Proximity uses a renderer-owned screen bound or pick proxy and a
finite `0..256` CSS-pixel radius; zero is exact-hit mode. The radius is not a world-space distance or pen altitude. The world
ray is finite plain data with a normalized direction and supports perspective and orthographic cameras.

`createPointerInteractionController(...)` defaults to primary/secondary buttons `0/2`, a `4` CSS-pixel drag threshold,
`350 ms` and `6` CSS pixels for double-click matching, and a `12` CSS-pixel proximity radius. `claim(sample)` synchronously
returns an opaque token or `null`. A claim captures and isolates that pointer sequence from camera controls; an unclaimed
sequence and all proximity observation pass through unchanged. A claimed secondary sequence suppresses only its corresponding
native `contextmenu`.

A primary selectable target released within threshold emits click; the second matching click is delivered first as click and
then double-click. Crossing threshold on a drag source emits exactly one drag-grab, later moves emit drag-move, and normal
release emits exactly one drag-drop. Cancellation never masquerades as drop. Drag move/drop expose the current exact target;
the application inspects `drop-target` or `drop-surface` and decides validity.

For an authority-owned target, every one of the nine completion/observation phases also emits a frozen
`{nodeId, eventName, payload}` record. `nodeId` is the same numeric ID as Python's `DisplayNode.node_id`; nested visual targets
resolve to their outer authority owner. `PointerNodeEventHub` registers Display listeners by that ID and name. Passing the
hub as `nodeEventHub` routes those events directly; passing the existing connection's `sendInput` forwards the canonical
`display.pointer-event` input without adding a Wire kind. Python `PointerNodeEventHub.dispatch_engine_input(request)` performs
the same lookup inside product `handle_input`. Scene-local targets expose `authorityNodeId: null` and remain browser-only
because no Python Node corresponds to them.

Idle mouse and hovering-pen moves can emit proximity; touch and a pen in contact never synthesize it. Proximity has no token,
capture or propagation side effect. Each accepted Pointer Event performs at most one interaction query and one world-ray query,
retains only bounded active state, schedules no RAF, and mutates no Node. Component/session/backend/disposal boundaries clear
active state exactly once. Recognition and Display listeners remain outside the commit/ACK barrier. Only a configured existing
input sender crosses to Python, where normal input transaction and recording rules apply. See the
[complete implementation contract and tests](pointer-interaction-plan.md).

## Render-state validation before seal

Display owns the full schema for built-in renderer properties. It validates nested values before any node mutation or commit
seal, including:

- model material overrides;
- sprite material and atlas frame bounds;
- surface material, family and parameter records;
- particle capacity, vectors and parameters;
- camera, background and all light-specific fields.

The renderer-owned animation fields of the previous model, sprite and particle component versions are rejected
fail-closed by the new component normalizers; model/sprite/particle use `render.model@2` / `render.sprite@3` /
`render.particle@2`. Sprite frame sequences belong to the Display animator, not renderer properties. See
[Display animator](display-animation.md).

Resource-dependent checks use the registered descriptor, for example resource-kind compatibility and texture-atlas frame bounds. The
Three backend keeps defensive validation, but an invalid business record must not first fail on the next RAF after ACK.

Material records own their depth behavior in every Scene. Alongside tint, opacity, emissive and alpha fields, the closed
record accepts `depthTest` and `depthWrite`. Omitted values preserve the safe defaults: every material tests depth; opaque and
masked materials write depth, while blended materials do not. A material may explicitly disable either operation, but
`depthTest=false, depthWrite=true` is rejected because the backend cannot honor that pair as two independent operations.
Model overrides inherit omitted depth fields from their source material. These fields belong to Material Resource properties
or inline render-component material records; Scene definitions do not enable or override them.

## Selective depth composition

Scene definition `scene-engine-scene-definition@3` may supply `compositionPlan`; omission or `null` selects the ordinary
single-pass renderer. A composed Scene supplies one closed `scene-engine-render-composition@1` value:

```js
{
  schema: RENDER_COMPOSITION_SCHEMA,
  id: 'gameplay-view',
  revision: 1,
  defaultGroup: 'ordinary-ground',
  groups: [
    { id: 'terrain' },
    { id: 'ordinary-ground' },
    { id: 'foreground-subject' },
  ],
  passes: [
    { id: 'base', kind: 'protected-base', groups: ['terrain'] },
    { id: 'ordinary', kind: 'ordinary', groups: ['ordinary-ground'] },
    { id: 'foreground', kind: 'foreground', groups: ['foreground-subject'] },
  ],
}
```

The three pass kinds and their order are fixed. Every pass is non-empty, every declared group belongs to exactly one pass,
group and pass IDs are unique, `defaultGroup` is declared, and at most 30 groups may use the backend layer budget. The complete
plan is part of the Scene description and therefore the Scene catalog identity. There is no pass graph, saved-depth name or
product-role branch in version 1.

`render.composition@1` is a non-rendering, non-multiple Component with closed properties `{group}`. A drawable binding uses the
nearest enabled membership on its Node-parent chain, otherwise the plan's explicit default. A child membership therefore lets a
contact shadow remain ordinary while its subject body is foreground. Camera, background and light bindings have no membership.
Declaring the Component without a plan, naming an unknown group in static content or resolving one dynamically fails before the
candidate can be committed. Membership changes dirty only drawable descendants and are sent as complete binding state.

Composition remains browser-local. It adds no Python record, Wire command, gameplay tick or packet-log field. Replay selects
the same result through its Display artifact identity and the live Client/Display/backend path.

## Checkpoint, commit and summary

A checkpoint carries Scene name, command cursor, the complete matrix pool and parent-first authority-root kind/state metadata.
Client creates a fresh session, installs the Scene and pool, bootstraps roots by ID,
activates and starts it, then swaps the session.

A commit closes the draw gate, stages the one dirty matrix block and applies every command in order. Property candidates reuse
complete state reconciliation and events dispatch synchronously at their sequence positions. One set-transforms command
atomically consumes the existing-row prefix at its sequence position; create commands claim new-row suffix rows. It then flushes
transforms and seals the exact cursor. JavaScript run-to-completion
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

### Fixed panel facing

`behavior.billboard@2` owns panel orientation in the shared Display transform pipeline. Its closed properties are
`mode: 'initialize' | 'continuous'`, `axisMode: 'full' | 'y-axis'`, optional `facing: 'fixed' | 'camera'`
and optional `cameraName`. The default `facing: 'fixed'` solves local rotation through the inverse parent world 3x3 so world
+Z forward (six o'clock) remains exact; camera position, elevation, yaw and roll do not participate. World +Y up is exact when
one orthogonal local basis can represent both requested axes, including rotated and non-uniformly scaled parent cases. Under
general inherited shear, +Z remains exact and the quaternion basis uses the closest representable up direction. A driver
preserves its local translation and column magnitudes while replacing its local basis. The driver's own local 3x3 must be a
positive-scale, no-shear basis; otherwise it fails closed rather than silently discard authored shear. General Nodes and
driver ancestors may still contain shear.

Fixed orientation is established on attach. `continuous` reasserts it before rendering after parent/authority updates;
`initialize` only sets it on attach. An application that explicitly needs camera-facing panels must declare `facing: 'camera'`;
only that mode may name a camera. Version 1 is not registered or aliased.

The backend receives the resulting Node world matrix unchanged. Ground decals and models without this behaviour retain their
declared transforms; there is no renderer-only rotation, product-name branch or second picking transform.

### Fixed panel projection

`render.sprite@3` retains the closed sprite properties and adds shared anchor-relative vertex compensation. Display resolves
the nearest `behavior.billboard@2` ancestor, including the sprite's own Node. An enabled fixed-facing ancestor contributes its
world position as `panelAnchorWorld`; a camera-facing or disabled nearest billboard, or no billboard, contributes `null`.
This is a derived render-binding input, not a Prefab property or another Node transform. A child card's center offset remains
part of its ordinary world matrix, so its parent's footpoint stays the projection anchor. Ground decals without a billboard
keep ordinary projection. Sprite version 1 is not registered or aliased.

The backend removes the off-axis perspective term relative to that anchor. The anchor still moves normally with the scene;
pan does not pin a sprite to the screen. Camera pitch foreshortening and distance scaling are retained. Orthographic cameras
need no compensation. Render and pick apply the same vertex formula to both ordinary and instanced sprites; world-point
projection continues to project the supplied world point normally. See [RenderBackend](render-runtime.md#fixed-panel-vertices).
RenderSystem recomputes this derived input when the Sprite/Node changes or when its nearest Billboard is attached, detached,
enabled, disabled, or patched. A nearer Billboard blocks invalidation from an ancestor just as it blocks anchor lookup, so a
clean frame does not rescan every Sprite in the scene.

### Frame order

Frame order is:

```text
update
AnimationSystem.sample
world-transform flush
before-render
world-transform flush
RenderSystem.prepareFrame
RenderBackend.render()
```

`sourceTick` is simulation time. `visualSeconds` and `deltaSeconds` are visual-only and cannot create gameplay facts. The
animator samples each player against its own `visualSeconds` origin; loop animations keep the frame loop scheduled while
requested-draw scenes otherwise stay idle. See [Display animator](display-animation.md).

One backend binding is identified by `(nodeName, componentKey)`. Runtime disposal stops RAF, closes the gate, aborts pending
work, unloads Scene and Prefab materializations, clears the private ledger, disposes Components and RenderSystem, empties
NodeIndex and releases references.
Repeated `dispose()` calls return the same completion operation.

Renderer failure can use explicit `rebuildRenderBackend()` when recoverable; this remounts declarative bindings while preserving
Node and Component identity. Authority/Display projection failure instead requires a fresh checkpoint/session.
