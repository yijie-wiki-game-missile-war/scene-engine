# Current architecture

Scene Engine 0.9 owns one deterministic publication and browser-projection boundary:

```text
mutable product World
  -> EngineProgram at exactly 60 Hz
  -> ProductCheckpoint / ProductCommit
  -> scene-engine-wire@2 exact packet bytes
  -> recorder + sessions
  -> SceneEngineClient 0.10
       -> immutable WorldState + cumulative ACK + O(1) DisplaySummary
       -> DisplayRuntime 0.4 AuthorityPort
            -> one NodeIndex / one NodeGraph / one Component scheduler / one RAF
            -> RenderSystem
                 -> flat ThreeRenderBackend 0.9.3 bindings
```

The boundary is renderer-isolated: product code and Arts definitions use Display contracts, while only the browser composition
root imports the Three backend. The current Display API is browser-oriented and is not presented as a universal renderer API.

## Sole owners

| Concern | Sole owner | Public boundary |
|---|---|---|
| gameplay state and rules | product | six `EngineProgram` callbacks |
| logical tick, revision, commit and command sequence | Python runtime | checkpoint/commit packet headers |
| exact packet decode, WorldState pointer and ACK | JavaScript Client | `SceneEngineClient` |
| Node names, parent graph, local Transform and Prefab instances | DisplayRuntime | `AuthorityPort` plus read-only views |
| Scene, Prefab, Resource, Component and state-schema catalog | DisplayRuntime composition | immutable definitions and registries |
| renderer bindings, batching and GPU resources | Three backend | flat `RenderBackendPort` |
| recorded bytes and Replay seek | packet-log@2 | exact Engine packets |

There is no second mutable World, product Node tree, Transform cache, application RAF, ACK cursor, packet decoder or fallback
renderer.

## Product and catalog boundary

Python publishes only complete `py/` authority roots and later single-target mutations. It owns each root's stable name,
existence, parent, local Transform, visibility, exact `prefabId` and complete authority state. It never publishes URLs, models,
textures, materials, lights, cameras or Prefab-local paths.

Arts/product display code owns concrete Scene, Prefab, Resource and Component definitions. `PrefabDefinition.id` is the unique
lookup key; `gameplayType` is non-unique state-contract metadata, so multiple Prefabs may share it.

A build generates one canonical catalog manifest from:

- Scene descriptions;
- Prefab, Resource and Component descriptions;
- one authority-state schema identity for every used gameplay type.

The manifest produces three independent SHA-256 identities. The JavaScript build writes the snake-case identity record beside
the display artifact; Python loads that exact record into `DisplayCatalogIdentity`. Client compares the local runtime identity
with the checkpoint before it installs a Scene.

## Transaction and observation boundary

For a checkpoint, Client creates a new candidate Display session, verifies catalog identity, installs the Scene, creates all
baseline authority roots parent-first, activates the checkpoint cursor and starts the runtime. Only after the candidate is
complete does it replace the old session.

For a commit, Client:

1. validates the whole packet, World candidate and command stream;
2. opens the exact Display commit gate;
3. synchronously applies every single-target Authority operation;
4. seals the cursor;
5. publishes WorldState and cursors;
6. reads `runtime.summary()` and encodes cumulative ACK;
7. queues `onCommit` as a microtask.

After activation, Authority operations outside an open commit gate fail. A component cannot bypass this boundary: Behaviour
hooks receive read-only NodeView and Display query capabilities, not NodeIndex, NodeGraph, Authority or RenderSystem.

ACK means the World candidate, all Display operations and the cursor passed this synchronous barrier. It does not wait for
resource loading, a full DisplayView, HUD, observers, RAF or draw. Any projection error emits no ACK and requires a fresh
checkpoint/session.

## Display and renderer lifecycle

DisplayRuntime owns the only application RAF. Its frame order is:

```text
update Behaviour ticks
NodeGraph world-transform flush
before-render Behaviour ticks
NodeGraph world-transform flush
RenderSystem.prepareFrame
RenderBackend.render()
```

All built-in render properties, including nested model animation, material overrides, flipbooks, surface parameters and
particle animation, are normalized and resource-validated before node state changes or commit seal. The Three backend repeats
defensive checks but must not be the first layer to discover an invalid business record.

The backend owns only renderer resources and flat `(nodeName, componentKey)` bindings. It never reconstructs a business tree or
returns Three objects. Disposal stops scheduling, aborts pending work, unloads Scene/Prefab scopes, releases Components,
resource leases and backend bindings, and is idempotent.
