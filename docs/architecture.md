# Current architecture

Scene Engine 0.18 owns one deterministic publication and browser-projection boundary:

```text
mutable product World
  -> EngineProgram at exactly 60 Hz
  -> ProductCheckpoint / ProductCommit
  -> scene-engine-wire@3 exact packet bytes
  -> recorder + sessions / bounded outbox
  -> one background transport sender
  -> SceneEngineClient 0.15
       -> immutable WorldState + cumulative ACK + O(1) DisplaySummary
       -> DisplayRuntime 0.14 AuthorityPort
            -> one NodeIndex / one NodeGraph / one Component scheduler / one RAF
            -> one private flat Prefab materialization ledger
            -> RenderSystem
                 -> flat ThreeRenderBackend 0.12.0 bindings
```

The boundary is renderer-isolated: product code and Arts definitions use Display contracts, while only the browser composition
root imports the Three backend. The current Display API is browser-oriented and is not presented as a universal renderer API.

## Sole owners

| Concern | Sole owner | Public boundary |
|---|---|---|
| gameplay state and rules | product | six `EngineProgram` callbacks |
| logical tick, revision, commit and command sequence | Python runtime | checkpoint/commit packet headers |
| exact transport call order and connection epochs | Python transport sender thread | bounded immutable-byte outbox |
| exact packet decode, WorldState pointer and ACK | JavaScript Client | `SceneEngineClient` |
| authority IDs/matrix pool, parent graph and Prefab instances | DisplayRuntime | `AuthorityPort` plus read-only views |
| Scene, Prefab, Resource, Component and state-schema catalog | DisplayRuntime composition | immutable definitions and registries |
| renderer bindings, batching and GPU resources | Three backend | flat `RenderBackendPort` |
| recorded bytes and Replay seek | packet-log@3 | exact Engine packets |

There is no second mutable World, product Node tree, Transform cache, application RAF, ACK cursor, packet decoder or fallback
renderer. The private Prefab materialization ledger records definition-instance provenance and owned ordinary Nodes/Components;
it is not a second hierarchy or a public child-Prefab object model.

The Python runtime thread remains the sole owner of World mutation, packet construction, recording, sessions and matrix-pool
lifecycle. After a packet is encoded and any configured recorder append succeeds, it may submit the same immutable byte object
to one private transport thread. That worker owns only `EngineTransport.send/close`; a bounded queue, per-connection epochs and a
runtime-drained result inbox prevent blocked I/O, stale session sends and background callbacks from crossing the authority
boundary. This scheduling change does not alter Wire bytes, command cursors, ACK meaning or Replay.

The transport key is unique for one physical connection lifetime and is never rebound to a replacement socket. Player/account
identity remains product or network-host data. A reconnect therefore receives a fresh transport key; this keeps already-entered
send/close calls attached to the endpoint for which they were accepted.

## Product and catalog boundary

Python publishes only complete authority roots and later structural/state/property/event mutations plus one vector-targeted
Transform batch per commit. It owns each root's stream-stable numeric ID,
existence, parent ID, row in one resident NumPy matrix pool, visibility, exact `prefabId` and complete authority state. It never
publishes a `py/` name, URL, model, texture, material, light, camera or Prefab-local path. Display deterministically maps an
authority ID to its internal canonical name `py/<id>`; authored Scene/Prefab paths and renderer `(nodeName,componentKey)` keys
therefore remain browser-local and unchanged.

Checkpoint roots and structural parent IDs are validated in Python. Later mutations address the same `uint32` row directly.
The browser Client validates the complete ID tables and every active/dirty matrix before it opens the Display commit gate; an
invalid target or tensor therefore produces no ACK.

Arts/product display code owns concrete Scene, Prefab, Resource and Component definitions. `PrefabDefinition.id` is the unique
lookup key; `gameplayType` is non-unique state-contract metadata, so multiple Prefabs may share it. Prefab definition schema
`scene-engine-prefab-definition@5` can compose exact child Prefab ids through fixed `prefabInstances`, bounded dynamic
`prefabSlots`. The catalog compiler validates every fixed reference and every slot allowlist, including missing definitions and
cycles, before the runtime installs any Scene.

`node-set-property` and `node-unset-property` update one top-level member of the root's complete authority state, then reuse the
same synchronous resolver/reconcile path as `node-set-state`; a dot in a name is literal, not a nested path. `null` is a value,
so removal has its own command. Product code remains the durable owner and must include the resulting complete state in later
checkpoints. `node-emit-event` is ordered but transient: the Prefab must declare the event, and only explicitly subscribed,
enabled Behaviour components in that outer Prefab definition receive its frozen payload. Events are recorded in exact commit
bytes and replay in order, but are absent from checkpoints.

Python still owns only the outer `py/` authority root and sends its complete state. A synchronous resolver may derive fixed-child
overrides and each slot's complete desired instance set; each child resolver then consumes the complete state assigned to that
child. Materialization recursively flattens all levels into the existing NodeIndex and NodeGraph as ordinary Nodes and
Components. It does not add child commands, another authority boundary or a nested runtime tree.

A build generates one canonical catalog manifest from:

- Scene descriptions;
- Prefab, Resource and Component descriptions;
- one authority-state schema identity for every used gameplay type.

The manifest produces three independent SHA-256 identities. The JavaScript build writes the snake-case identity record beside
the display artifact; Python loads that exact record into `DisplayCatalogIdentity`. Client compares the local runtime identity
with the checkpoint before it installs a Scene.

## Transaction and observation boundary

For a checkpoint, Client creates a new candidate Display session, verifies catalog identity, installs the Scene, transfers the
single owned full matrix tensor, creates all baseline authority roots parent-first by ID, activates the checkpoint cursor and
starts the runtime. Only after the candidate is complete does it replace the old session.

For a commit, Client:

1. validates the whole packet, World candidate, ID tables, matrix tensor and command stream;
2. opens the exact Display commit gate;
3. stages the one dirty tensor and synchronously applies ordered Authority operations, including property reconciliation and
   event dispatch; one Transform batch atomically consumes
   the existing-row ID prefix at its sequence position, while create commands claim the new-row suffix;
4. seals the cursor;
5. publishes WorldState and cursors;
6. reads `runtime.summary()` and encodes cumulative ACK;
7. queues `onCommit` as a microtask.

After activation, Authority operations outside an open commit gate fail. A component cannot bypass this boundary: Behaviour
hooks receive read-only NodeView and Display query capabilities, not NodeIndex, NodeGraph, Authority or RenderSystem.

For a state update, an instance with the same slot key, instance key and `prefabId` retains its Node/Component identity; a new
key is added, a missing key is removed and a changed `prefabId` is replaced. The runtime validates and stages the complete
candidate before exposing it. This is atomic for the single Authority operation; the commit contract still does not promise
rollback across multiple commands.

ACK means the World candidate, all Display operations and the cursor passed this synchronous barrier. It does not wait for
resource loading, a full DisplayView, HUD, observers, RAF or draw. Any projection error emits no ACK and requires a fresh
checkpoint/session.

## Display and renderer lifecycle

DisplayRuntime owns the only application RAF. Its frame order is:

```text
update Behaviour ticks
AnimationSystem sample
NodeGraph world-transform flush
before-render Behaviour ticks
NodeGraph world-transform flush
RenderSystem.prepareFrame
RenderBackend.render()
```

All built-in render properties, including nested material overrides, sprite atlas frames, surface parameters and particle
parameters, are normalized and resource-validated before node state changes or commit seal. The Three backend repeats
defensive checks but must not be the first layer to discover an invalid business record.

Visual timelines follow one path: an Animation Resource (one clip per Resource, schema `scene-engine-animation-resource@2`)
plus an `animation.player@1` on a Prefab-definition instance root, sampled by the Display AnimationSystem against each player's
local `visualSeconds` origin, delivered to the renderer as a transient override of the base properties. The renderer only
applies final effective values — it never interprets playable time. Global procedural effects (water, noise) keep sampling
`visualSeconds`, and procedural particle emitters use renderer-local origins. See [Display animator](display-animation.md).

Animation target scope is established from materialization identity/provenance, not by testing whether a canonical Node name
starts with `prefab/`. Each nested definition instance therefore gets its own `$root` and local-path namespace even though all
targets are ordinary Components in the one runtime graph.

The backend owns only renderer resources and flat `(nodeName, componentKey)` bindings. It never reconstructs a business tree or
returns Three objects. Disposal stops scheduling, aborts pending work, unloads Scene and Prefab materializations, clears the
private ledger, releases Components, resource leases and backend bindings, and is idempotent.

Transform has one logical representation end to end: a column-major local Matrix4, carried on Wire as exactly 64
little-endian binary32 bytes. Python authority roots share one `DisplayMatrixPool`: a contiguous `<f4` NumPy tensor shaped
`(n,4,4)` with `[node,column,row]` axes. A checkpoint emits the full tensor once; a commit emits sorted dirty IDs plus one
compact `(m,4,4)` tensor, rather than serializing matrices inside commands. Client decodes each tensor into one owned
Float32Array and is still the first semantic gate: it canonicalizes negative zero and rejects nonfinite, non-affine, reflected
or singular active rows before Authority opens. Display repeats that validation and its authority Nodes resolve their local
matrix directly from the shared pool by ID; Scene and Prefab-local Nodes keep their browser-owned matrices.
NodeGraph derives the sole world matrix with direct
`parentWorld * localMatrix` multiplication into Float64Array storage. No layer owns a parallel TRS or decomposes the matrix
during publication.

Python `DisplayTransform` and the JavaScript `DisplayTransform` facade expose pure Matrix4 convenience operations. They never
mutate a Node, bypass Authority, or cache position/rotation/scale beside the matrix. Python preserves the existing public
`matrix_bytes=`, `from_matrix()`, `matrix` and `matrix_bytes` APIs: byte construction copies the exact bit patterns into the
array, `matrix` returns the immutable 16-value tuple representation, and `matrix_bytes` creates an exact temporary serialization
rather than exposing a persistent owner. Python does not apply matrix-semantic validation; browser-side helpers continue to return
canonical accepted matrices.
