---
name: scene-engine
description: Use, integrate, extend, test, or debug Scene Engine's Python fixed-step runtime, wire/client boundary, DisplayRuntime Scene/Prefab/Resource/Component model, Three RenderBackend, and recording/replay path. Use for engine and application-integration work; do not use for game-art asset production, visual direction, owner art workflows, or Showcase review.
---

# Scene Engine usage and integration

Use the public engine boundary that owns the requested concern. Keep product rules, display content, browser transport, and
renderer implementation separate. Do not create a shortcut path for tests, review, migration, or debugging.

If this Skill conflicts with current source, repository instructions, or a binding document, the current source and binding
document win.

## Read first

Read the repository instructions and only the current documents relevant to the task:

- [README](../../../README.md)
- [repository instructions](../../../AGENTS.md)
- [current architecture](../../../docs/architecture.md)
- [runtime and 60 Hz](../../../docs/runtime.md)
- [wire v2](../../../docs/wire.md)
- [JavaScript client](../../../docs/client.md)
- [Display Node and Component](../../../docs/display.md)
- [Three RenderBackend](../../../docs/render-runtime.md)
- [recording and Replay](../../../docs/recording-replay.md)
- [Transform encoding](../../../docs/transform.md)

Use the package entry points as the public API reference:

- [Python package exports](../../../src/scene_engine/__init__.py)
- [Python runtime port](../../../src/scene_engine/runtime.py)
- [Python Display records](../../../src/scene_engine/display.py)
- [JavaScript client exports](../../../js/packages/client/src/index.js)
- [Display exports](../../../js/packages/display/src/index.js)
- [Three backend exports](../../../js/packages/renderer-three/src/index.js)

## Route the task to one owner

| Task | Owner and public boundary |
|---|---|
| Gameplay rules, mutable World, tick mutation, input mutation | Product `EngineProgram` implementation |
| Tick, revision, commit sequence, command sequence, sessions | Python `SceneEngineRuntime` |
| Packet layout, limits, codecs, cross-language fixtures | `scene-engine-wire@2` in Python and `@scene-engine/client` |
| Exact packet decode, immutable WorldState, ACK, observer scheduling | `SceneEngineClient` |
| Node names, parent graph, local Transform, Scene/Prefab instances | `DisplayRuntime` and its `AuthorityPort` |
| Scene, Prefab, Resource, Component declarations | `@scene-engine/display` immutable definitions and registries |
| Renderer bindings, model loading, batching, GPU resources, draw | `@scene-engine/renderer-three` through `createThreeRenderBackend` |
| Exact recording bytes, seek and Replay validation | `scene-engine-packet-log@2` and the same client path |
| Rule-space fixed-point matrices and coordinate verification | `scene-engine-transform@1` |

Game-specific Scene, Prefab, Resource, state-decoder, UI, and visual definitions belong in the product or Arts repository, not
in Scene Engine. Raw models, textures, materials, lighting choices, camera presets, and visual acceptance are content concerns;
the engine owns only their formal runtime contracts.

## Preserve the one production path

```text
mutable product World
  -> EngineProgram
  -> SceneEngineRuntime at exactly 60 Hz
  -> scene-engine-wire@2 exact packet bytes
  -> SceneEngineClient
  -> DisplayRuntime AuthorityPort
  -> RenderSystem
  -> flat Three RenderBackend
```

There is exactly one owner for each of these:

- one mutable World;
- one integer `source_tick` clock at 60 Hz;
- one Engine packet stream and cumulative command cursor;
- one Client WorldState pointer and ACK boundary;
- one DisplayRuntime NodeIndex and parent graph;
- one local Transform per Node;
- one application RAF;
- one renderer binding per `(nodeName, componentKey)`.

Do not add another cache or façade that becomes an owner of the same state.

## Use the Python runtime

Implement exactly the six `EngineProgram` callbacks:

```python
class GameProgram:
    def read_counters(self, world) -> WorldCounters: ...
    def write_counters(self, world, counters: WorldCounters) -> None: ...
    def step(self, world, context: TickContext) -> MutationResult: ...
    def handle_input(
        self, world, request: EngineInput, context: InputContext
    ) -> MutationResult: ...
    def build_checkpoint(
        self, world, context: CheckpointContext
    ) -> ProductCheckpoint: ...
    def build_commit(
        self, world, mutation: MutationResult, context: CommitContext
    ) -> ProductCommit: ...
```

Rules:

- `step` is called for each ordered tick and must return `MutationResult.changed(...)`.
- Input may return `changed`, `no_op`, or `rejected`; only `changed` creates a same-tick commit and increments revision.
- Product code mutates the World only while the runtime has loaned it through one of these callbacks.
- Use integer tick for gameplay and simulation animation. Never use wall time, RAF time, WebSocket arrival time, or frame count
  to create rule facts.
- `ProductCheckpoint` is a complete World snapshot plus one Scene name, three catalog identities, and a parent-first baseline
  of complete `DisplayNode` records.
- `ProductCommit` is a World JSON patch plus an ordered tuple of logical `DisplayCommand` values. It is not a rendered frame.
- The product display-projection boundary chooses stable full `py/` names, an exact registered `prefab_id`, one local
  Transform, visibility, and complete authority state. Core gameplay state does not contain model URLs, textures, materials,
  lights, cameras, pipelines, or Prefab-local paths.
- `PrefabDefinition.id` is the unique display-catalog identity. `PrefabDefinition.gameplayType` is a non-unique
  gameplay/state-contract classification; multiple Prefabs may share it.
- `DisplayCommand.set_state` replaces the complete state object; it is not a merge patch.
- The Engine, not the product, assigns `command_seq`, commit sequence, stream identity, revision, and encoded bytes.

Typical host loop:

```python
runtime = SceneEngineRuntime(
    world=world,
    program=program,
    transport=transport,
    recorder=recorder,
    config=RuntimeConfig(ticks_per_second=60),
)

runtime.start()
try:
    while running:
        # Route transport events onto the runtime thread.
        # runtime.client_connected(client_id)
        # runtime.receive_client_packet(client_id, raw_bytes)
        # runtime.client_disconnected(client_id)
        runtime.pump()
finally:
    runtime.stop()
```

The host owns network polling and process lifecycle. `SceneEngineRuntime` owns fixed-step progression, packet publication,
session retention, input serialization, ACK handling, and recorder append/seal.

## Use the JavaScript client

Create one `SceneEngineClient` for one current live or Replay projection:

```js
import { SceneEngineClient } from '@scene-engine/client';

const client = new SceneEngineClient({
  createDisplaySession(metadata) {
    verifyCatalogIdentity(metadata);
    return createProductDisplaySession();
  },
  onCommit({ kind, commit, worldState, displaySummary }) {
    updateHudFromWorld(worldState, commit);
    updateHealthIndicator(displaySummary.health);
  },
});

function receiveEnginePacket(rawBytes) {
  const result = client.applyPacket(rawBytes);
  if (result.ackPacket !== null) transport.send(result.ackPacket);
  if (result.inputResult !== null) handleInputResult(result.inputResult);
}
```

A display session has exactly four fields and no extras:

```js
Object.freeze({
  runtime,
  authorityPort: runtime.authority,
  commitGate: runtime.commitGate,
  dispose: () => runtime.dispose(),
});
```

Client rules:

- `createDisplaySession`, `installScene`, authority operations, commit-gate operations, `summary`, and `currentView` are
  synchronous. A Promise from any of them fails closed.
- A checkpoint creates a fresh candidate Display session, installs the Scene, creates all authority roots parent-first,
  activates the exact cursor, starts the runtime, then atomically replaces the prior session.
- A commit validates the complete World candidate and command stream before opening the Display commit gate.
- Send `result.ackPacket` immediately after successful `applyPacket`. ACK does not wait for model/texture loading, HUD,
  observers, RAF, or draw.
- `onCommit` receives only O(1) `displaySummary`; it runs later as a microtask and cannot block ACK.
- Use `currentWorldState()` and `currentCommit()` for explicit queries.
- Use `currentDisplayView()` only for an explicit full-tree query such as product picking, focus resolution, diagnosis, or
  tests. Never call it from every `onCommit`.
- Use `encodeInput({inputId, command, args})` so the input carries the current observed stream and commit.
- After a client or projection failure, discard the client/session and require a fresh checkpoint. Do not repair it by
  partially replaying local state.
- Replay feeds exact recorded Engine packet bytes through the same `applyPacket` and AuthorityPort path.

## Build a Display catalog

Create registries before constructing the runtime. `DisplayRuntime` seals all four registries in its constructor, so complete
registration first.

```js
import {
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
} from '@scene-engine/display';
import { createThreeRenderBackend } from '@scene-engine/renderer-three';

const componentRegistry = createComponentRegistry();
registerProductComponents(componentRegistry);

const resourceRegistry = createResourceRegistry(resourceDefinitions);
const prefabRegistry = createPrefabRegistry(prefabDefinitions);
const sceneRegistry = createSceneRegistry(sceneDefinitions);

const runtime = createDisplayRuntime({
  hostElement,
  canvas,
  sceneRegistry,
  prefabRegistry,
  resourceRegistry,
  componentRegistry,
  createRenderBackend: (options) => createThreeRenderBackend(options),
  onHealth: (event) => reportDisplayHealth(event),
});
```

For a standalone read-only display surface, use the runtime directly:

```js
runtime.installScene({ sceneName: 'main' });
runtime.activate({ commitSeq: 0, sourceTick: 0, lastCommandSeq: 0 });
runtime.start();
await runtime.whenReady();       // UX/capture readiness only; never part of ACK.

const summary = runtime.summary();
const hit = runtime.pick({ clientX, clientY });
const screenPoint = runtime.projectWorldPoint({ position: [x, y, z] });
const focus = runtime.focusWorldPoint({ position: [x, y, z], radius });
const capture = runtime.capture();

await runtime.dispose();
```

For Client-driven live or Replay use, return the same runtime through the four-field session object and let the Client call
`installScene`, `activate`, and `start`.

### Resource definitions

Resources are immutable renderer-neutral descriptors registered before runtime construction. Supported kinds are:

```text
model, mesh, texture, texture-atlas, material, animation, surface, particle
```

Use a `model` for an externally loaded model hierarchy, a `mesh` for mesh data or a mesh URL, and a `material` for the material
family and closed properties. Scene Nodes do not contain raw Three objects, loaders, `Object3D`, geometry, texture, or material
instances.

Resource rules:

- IDs are stable catalog identities.
- URLs exist only in Resource descriptors, never in Python authority records or component state.
- Add `revision` and a lowercase SHA-256 `hash` when the content identity must be frozen.
- Component definitions refer to Resources by ID; ComponentRegistry validates allowed kinds before mutation.
- Register only asset Resource descriptors in ResourceRegistry. SceneDefinition and PrefabDefinition belong only in their own
  registries.
- Loading is asynchronous inside the renderer backend and is outside the commit/ACK barrier.

### Prefab definitions

A `PrefabDefinition` is an immutable reusable Node/component declaration. It is registered and addressed by one unique
`id`. Its `gameplayType` is a non-unique classification describing the complete authority-state contract it consumes; any
number of Prefab definitions may share the same gameplay type.

```js
import { PREFAB_DEFINITION_SCHEMA, definePrefab } from '@scene-engine/display';

export const blueUnitPrefab = definePrefab({
  schema: PREFAB_DEFINITION_SCHEMA,
  id: 'product/unit/blue-basic',
  revision: 2,
  gameplayType: 'unit.basic',
  root: {
    components: [],
    children: [{
      localName: 'body',
      visible: true,
      components: [{
        key: 'model',
        type: 'render.model@1',
        properties: {
          modelResourceId: 'model/unit-blue-basic',
          pickable: true,
        },
      }],
      children: [],
    }],
  },
  resolveState(state) {
    return {
      nodes: {},
      components: {
        'body/model': {
          animation: state.animation === null ? null : {
            clip: state.animation,
            sourceTick: state.animationSourceTick,
          },
        },
      },
    };
  },
});

export const redUnitPrefab = definePrefab({
  schema: PREFAB_DEFINITION_SCHEMA,
  id: 'product/unit/red-basic',
  revision: 1,
  gameplayType: 'unit.basic',
  root: {
    components: [],
    children: [{
      localName: 'body',
      visible: true,
      components: [{
        key: 'model',
        type: 'render.model@1',
        properties: {
          modelResourceId: 'model/unit-red-basic',
          pickable: true,
        },
      }],
      children: [],
    }],
  },
  resolveState(state) {
    return {
      nodes: {},
      components: {
        'body/model': {
          animation: state.animation === null ? null : {
            clip: state.animation,
            sourceTick: state.animationSourceTick,
          },
        },
      },
    };
  },
});
```

Prefab identity rules:

- `PrefabDefinition.id` is unique within the Prefab catalog and is the only primary registry/lookup key.
- `gameplayType` is intentionally non-unique. Do not reject two definitions because they share it.
- Prefabs sharing one gameplay type must consume the same complete authority-state schema. A resolver may ignore fields but
  must not require private authority fields outside that schema.
- Keep `revision` separate from `id`. Raise revision when the definition contract changes; do not use a version suffix in the
  id as a substitute for revision.
- Runtime commands and Scene static instances use exact `prefabId`. Do not ask the Registry to guess one Prefab from a
  gameplay type, and do not introduce an implicit default.
- A Node name is an instance identity; a Prefab id is a reusable definition identity; a gameplay type is only semantic/state
  compatibility metadata. Never interchange the three.

Prefab structure rules:

- The root Transform is identity. Give independently posed parts child Nodes.
- Child names are Prefab-local paths only. Python never addresses them.
- `resolveState(state, context)` is pure, synchronous, deterministic, and returns only `{nodes, components}` patches.
- Authority state is a complete replacement. The resolver must handle the complete current state, not rely on hidden prior
  calls.
- A runtime Prefab instance is an ordinary Node subtree created by SceneLoader or AuthorityPort.
- Do not call `PrefabDefinition.instantiate()` or construct internal scope/Node objects. Runtime installation and AuthorityPort
  are the supported instance owners.
- Do not add a per-instance update loop to a Prefab. Use a registered `BehaviourComponent` only for visual-only component
  behavior that genuinely needs the sole Display RAF.

Authority creation and replacement use exact ids:

```js
runtime.authority.createNode({
  name: 'py/unit/42',
  parentName: null,
  prefabId: 'product/unit/blue-basic',
  transformMode: 'live',
  transform,
  visible: true,
  state,
});

runtime.authority.replaceNodePrefab({
  name: 'py/unit/42',
  prefabId: 'product/unit/red-basic',
  state,
});
```

Do not carry both `prefabId` and `gameplayType` in an authority command. The registered Definition determines gameplay type;
duplicating it would create two fields that can disagree.

### Scene definitions

A `SceneDefinition` declares static Scene Nodes, static Prefab instances, renderer profile, and the active camera.

```js
import { SCENE_DEFINITION_SCHEMA, defineScene } from '@scene-engine/display';

export const mainScene = defineScene({
  schema: SCENE_DEFINITION_SCHEMA,
  id: 'main',
  sceneProfile: 'product.profile',
  rendererProfile: {
    drawMode: 'requested',
    maximumPixelRatio: 2,
    clearRgba: 0x000000ff,
    antialias: true,
    alpha: false,
    shadows: true,
    toneMapping: 'aces-filmic',
  },
  activeCameraLocalName: 'camera',
  nodes: [{
    localName: 'camera',
    parentLocalName: null,
    transform: {
      position: [0, 8, 12],
      rotationXyzw: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    components: [{
      key: 'camera',
      type: 'render.camera@1',
      properties: {
        projection: 'perspective',
        fovYDegrees: 50,
        near: 0.1,
        far: 2000,
      },
    }],
  }],
  prefabInstances: [{
    localName: 'preview-unit',
    parentLocalName: null,
    prefabId: 'product/unit/blue-basic',
    visible: true,
    state: {
      animation: null,
      animationSourceTick: 0,
    },
  }],
});
```

Scene rules:

- `SceneDefinition` is data; install it only with `runtime.installScene({sceneName})`.
- The current active camera must be a direct Scene Node containing one `render.camera@1` component.
- Camera, background, and lights are normal Scene Nodes with RenderComponents; they do not belong to the renderer backend as
  hidden defaults.
- Static `prefabInstances` reference an exact `prefabId`, never a gameplay type.
- Static Scene names compile under `scene/`; Python authority roots compile under `py/`; Prefab-local descendants compile
  under `prefab/`. Do not invent another identity domain.
- The Scene does not declare Python-owned authority roots. Checkpoint/commit authority operations create and mutate them.

### Components

Built-in RenderComponent types are:

```text
render.model@1
render.mesh@1
render.sprite@1
render.surface@1
render.particle@1
render.camera@1
render.background@1
render.ambient-light@1
render.directional-light@1
render.point-light@1
render.spot-light@1
```

`BillboardComponent` and `LookAtComponent` are built-in visual Behaviours. For a product-specific component:

1. Extend `Component` or `BehaviourComponent`; do not override final lifecycle/mutation methods.
2. Give it one stable static `typeId` and, for a Behaviour, one `tickPhase` of `update` or `before-render`.
3. Register a descriptor with `ComponentClass`, a complete synchronous `normalizeProperties`, and a synchronous
   `resourceReferences` function.
4. Keep properties closed, plain, deeply frozen data. Do not store a second Transform in component properties.
5. Use `onAttach`, `tick`, and `onDispose` only as synchronous optional handlers. Promise-returning handlers fail.
6. Only BehaviourComponents tick. RenderComponents are declarative and may not implement handlers.
7. Replace properties only through `componentRegistry.patchComponentProperties(...)`; never mutate the properties object.

If an object needs an independent pose, create a child Node instead of adding position, rotation, matrix, or Transform fields to
a Component.

## Use the Three backend only at composition root

Application and product modules import renderer-neutral `@scene-engine/display` types. Only the browser composition root imports
`createThreeRenderBackend` and supplies it to `DisplayRuntime`.

The Three backend owns:

- model/texture/material loading and cancellation;
- Three objects and renderer resources;
- flat RenderComponent bindings;
- batching and instance representation;
- resize, prepare, draw, pick, projection, focus, capture, diagnostics, and disposal.

It does not own:

- the product World;
- Node names, parent graph, local Transform, or Component lifecycle;
- the application RAF;
- cameras or lights not declared by the Scene;
- product controls or callbacks;
- caller-visible Three objects.

A renderer failure may call `runtime.rebuildRenderBackend()`. This remounts declarative renderer bindings while preserving Node
and Component identity. A Display/authority projection failure is different: it requires a fresh checkpoint and session.

Do not wait for model or texture completion before ACK. Use `runtime.whenReady()` only for loading UX, deterministic capture,
or explicit acceptance work.

## Time, identity, and mutation rules

- Rule time is `source_tick / 60`. Display may derive visual sampling from source tick or use an explicitly visual-only clock,
  but visual time never changes the World.
- Node names are immutable lowercase canonical paths under exactly `sys/`, `scene/`, `py/`, or `prefab/`.
- Full `py/` authority name is the runtime instance identity. `PrefabDefinition.id` is the reusable definition identity;
  `gameplayType` is non-unique state-contract metadata. Never use one in place of another.
- Authority create/replace operations carry exact `prefabId`; Registry lookup by gameplay type is forbidden on the production
  path.
- `null` authority parent means `sys/authority-root`; a non-null authority parent must be an existing `py/` Node.
- Each Node owns exactly one local TRS. World Transform is derived by the sole NodeGraph.
- Each authority operation has exactly one target and validates before mutation.
- `setNodeState` is complete replacement. `replaceNodePrefab` takes an exact `prefabId`, stages and validates a shadow scope,
  then swaps it atomically for that target operation.
- A full DisplayView is an explicit diagnostic/query snapshot, not a state owner and not a per-commit cache.

## Failure and disposal

- Product mutation/commit construction failure makes the Python runtime fatal; do not retry the same tick against a partially
  mutated World.
- Client command/application failure emits no ACK and leaves the projection invalid; replace the client/session from a new
  checkpoint.
- Component tick failure halts Display scheduling and marks the runtime unhealthy.
- Renderer health failure is recoverable only through the explicit backend rebuild path when the event is marked recoverable.
- Disposal must release session, RAF, Scene/Prefab scopes, Nodes, Components, resource leases, pending loads, backend bindings,
  renderer resources, listeners, and recorder state owned by that layer.
- Keep disposal idempotent. Await `DisplayRuntime.dispose()` and renderer readiness/disposal where the public API is async.

## Do not introduce

- a second mutable World, Scene tree, Node map, Transform cache, simulation clock, RAF, ACK cursor, or packet decoder;
- compatibility aliases, dual writes, fallback decoders, fallback renderer, or legacy package redirects;
- product rules or state schemas inside Scene Engine;
- raw asset URLs or renderer details in Python DisplayNode/DisplayCommand state;
- direct Three imports outside `@scene-engine/renderer-three` and the composition root;
- hidden default camera, light, material, or model behavior in the backend;
- asynchronous session factories, authority operations, state resolvers, Component handlers, or registry normalizers;
- mutation of registries after DisplayRuntime construction;
- full-tree `currentDisplayView()` generation inside the normal commit observer;
- direct construction of internal Node, Scene, scope, RenderSystem, or backend-binding classes;
- a Prefab Registry keyed by gameplay type, a uniqueness rule on gameplay type, or an implicit default Prefab selector;
- authority fields named `prefab_type`/`prefabType`; the formal contract uses `prefab_id`/`prefabId`;
- calls to `SceneDefinition.instantiate()` or `PrefabDefinition.instantiate()`; use `runtime.installScene` and AuthorityPort;
- game-art production instructions, visual style guidance, Showcase catalog work, capture composition, or asset review in this
  Skill.

## Validate the affected boundary

Run the smallest focused tests while editing, then the complete repository gates before handoff:

```bash
uv run python -m pytest -q
npm ci
npm test
uv run python scripts/verify_cutover.py
```

Useful focused commands:

```bash
# Display definitions, Node graph, runtime, lifecycle, and 500-node coverage
npm test --workspace @scene-engine/display

# Client packet, WorldState, ACK, session, and packet-log coverage
npm test --workspace @scene-engine/client

# Three binding, loading, batching, pick, rebuild, and disposal coverage
npm test --workspace @scene-engine/renderer-three

# Performance evidence when the affected hot path changes
uv run python scripts/benchmark_scene_500.py --quick
node --expose-gc scripts/benchmark_client_ack_500.mjs --quick
node --expose-gc scripts/benchmark_display_runtime_500.mjs --quick
```

When changing a cross-language protocol or identity, update Python and JavaScript implementations, tests, canonical fixtures,
package versions/locks, and binding documents in one change. Do not make one side accept both the old and new contract.

Before handoff, verify:

- the change is owned by exactly one layer;
- no second clock, graph, cursor, RAF, or decoder was added;
- public examples use only package entry-point exports;
- definitions and registries remain immutable and complete before runtime construction;
- duplicate Prefab ids fail at registration while duplicate gameplay types are accepted;
- Scene and authority paths resolve Prefabs in O(1) by exact `prefabId`;
- ACK remains synchronous and independent of resource loading/draw;
- failure recovery uses fresh checkpoint/session or explicit backend rebuild, not local repair;
- focused tests, full gates, current docs, and benchmark/evidence claims agree.
