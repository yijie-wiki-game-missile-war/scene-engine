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
- [Display animator](../../../docs/display-animation.md)
- [Three RenderBackend](../../../docs/render-runtime.md)
- [recording and Replay](../../../docs/recording-replay.md)
- [Transform encoding](../../../docs/transform.md)
- [testing methods and standards](../../../docs/testing.md)
- [test items](../../../docs/tests/README.md)

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

- `step` is called for each ordered tick and must return `MutationResult.changed(...)`. Pass any opaque product data needed by
  `build_commit` as `commit_context`; do not use the removed generic `detail` bag.
- Input may return `changed`, `no_op`, or `rejected`; only `changed` creates a same-tick commit and increments revision.
- Product code mutates the World only while the runtime has loaned it through one of these callbacks.
- Use integer tick for gameplay and real mathematical motion (trajectories, physics-like sequences). Never use wall time, RAF
  time, WebSocket arrival time, or frame count to create rule facts. Python never publishes keyframes, animation progress or
  animation clocks; semantic state such as `{"motion": "moving"}` is the only animation-related payload.
- `ProductCheckpoint` is a complete World snapshot plus one Scene name, three catalog identities, and a parent-first baseline
  of complete `DisplayNode` records.
- `ProductCommit` is a World JSON patch plus an ordered tuple of logical `DisplayCommand` values. It is not a rendered frame.
- The product display-projection boundary chooses stable full `py/` names, an exact registered `prefab_id`, one local
  Transform, visibility, and complete authority state. Core gameplay state does not contain model URLs, textures, materials,
  lights, cameras, pipelines, or Prefab-local paths.
- `PrefabDefinition.id` is the unique display-catalog identity. `PrefabDefinition.gameplayType` is a non-unique
  gameplay/state-contract classification; multiple Prefabs may share it.
- `DisplayCommand.set_state` replaces the complete state object; it is not a merge patch. Construct commands only through the
  named `DisplayCommand.create_node`, `set_transform`, `set_parent`, `set_visible`, `set_state`, `replace_prefab`, and `remove`
  constructors; the generic `kind + fields` constructor is not public.
- The Engine, not the product, assigns `command_seq`, commit sequence, stream identity, revision, and encoded bytes.
- The contract rate is exactly `TICKS_PER_SECOND == 60`. Carry it through `RuntimeConfig.ticks_per_second` and runtime contexts as
  a variable; it is not a configurable alternate frame rate.

Typical host loop:

```python
runtime = SceneEngineRuntime(
    world=world,
    program=program,
    transport=transport,
    recorder=recorder,
    config=RuntimeConfig(ticks_per_second=TICKS_PER_SECOND),
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
  createDisplaySession() {
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

A display session must provide these four capabilities. The caller may keep wrapper/debug fields; the Client validates and
extracts only the four required fields into its own frozen session record:

```js
Object.freeze({
  runtime,
  authorityPort: runtime.authority,
  commitGate: runtime.commitGate,
  dispose: () => runtime.dispose(),
});
```

Client rules:

- `createDisplaySession`, `catalogIdentity`, `installScene`, `activate`, `start`, authority operations,
  `commitGate.begin`, `commitGate.seal`, `summary`, and `currentView` are synchronous. A Promise from any of them fails closed.
  Cleanup-only `dispose` and error-path `commitGate.fail` may return a Promise; Client observes but never awaits them.
- A checkpoint creates a fresh candidate Display session, compares its locally generated catalog identity before Scene
  installation, installs the Scene, creates all authority roots parent-first, activates the exact cursor, starts the runtime,
  then atomically replaces the prior session.
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

Create registries and the complete authority-state schema list before constructing the runtime. `DisplayRuntime` builds its
canonical manifest and identity, then seals all four registries in its constructor. Generate the same identity record beside the
Arts/product build and let Python load it into `DisplayCatalogIdentity`; do not hand-write placeholder hashes.

```js
import { writeFileSync } from 'node:fs';
import {
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
  createComponentRegistry,
  createDisplayRuntime,
  createPrefabRegistry,
  createResourceRegistry,
  createSceneRegistry,
  toDisplayCatalogIdentityRecord,
} from '@scene-engine/display';
import { createThreeRenderBackend } from '@scene-engine/renderer-three';

const componentRegistry = createComponentRegistry();
registerProductComponents(componentRegistry);

const resourceRegistry = createResourceRegistry(resourceDefinitions);
const prefabRegistry = createPrefabRegistry(prefabDefinitions);
const sceneRegistry = createSceneRegistry(sceneDefinitions);
const authorityStateSchemas = [
  { gameplayType: 'unit.basic', schemaId: 'unit.basic.state', revision: 1 },
];

const manifest = buildDisplayCatalogManifest({
  sceneRegistry,
  prefabRegistry,
  resourceRegistry,
  componentRegistry,
  authorityStateSchemas,
});
const catalogIdentity = computeDisplayCatalogIdentity(manifest);
writeFileSync(
  'display-catalog-identity.json',
  `${JSON.stringify(toDisplayCatalogIdentityRecord(catalogIdentity), null, 2)}\n`,
);

const runtime = createDisplayRuntime({
  hostElement,
  canvas,
  sceneRegistry,
  prefabRegistry,
  resourceRegistry,
  componentRegistry,
  authorityStateSchemas,
  createRenderBackend: createThreeRenderBackend,
  onHealth: (event) => reportDisplayHealth(event),
});
```

Every `PrefabDefinition.gameplayType` must have exactly one entry in `authorityStateSchemas`; extra entries and missing entries
fail manifest construction. Scene, Prefab/resources/components, and authority-state schemas are hashed in separate domains. The
Client calls `runtime.catalogIdentity()` and compares all three hashes with the checkpoint before `installScene`.

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

For Client-driven live or Replay use, return the runtime through an object containing the four required session capabilities and
let the Client call `installScene`, checkpoint bootstrap authority creation, `activate`, and `start`.

### Resource definitions

Resources are immutable renderer-independent descriptors registered before runtime construction. Supported kinds are:

```text
model, mesh, texture, texture-atlas, material, animation, surface, particle
```

Use a `model` for an externally loaded model hierarchy, a `mesh` for mesh data or a mesh URL, and a `material` for the material
family and closed properties. An `animation` is one Display visual timeline (schema `scene-engine-animation-resource@2`); it
has no URL and is never loaded by the renderer. Scene Nodes do not contain raw Three objects, loaders, `Object3D`, geometry,
texture, or material instances.

Resource rules:

- IDs are stable catalog identities.
- URLs exist only in Resource descriptors, never in Python authority records or component state.
- Add `revision` and a lowercase SHA-256 `hash` when the content identity must be frozen.
- Component definitions refer to Resources by ID; ComponentRegistry validates allowed kinds before mutation.
- Register only asset Resource descriptors in ResourceRegistry. SceneDefinition and PrefabDefinition belong only in their own
  registries.
- Loading is asynchronous inside the renderer backend and is outside the commit/ACK barrier. Animation Resources are pure
  Display data with no renderer asset, lease or dispose.

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
    components: [{
      key: 'animator',
      type: 'animation.player@1',
      properties: { animationId: 'anim.unit.idle' },
    }],
    children: [{
      localName: 'body',
      visible: true,
      components: [{
        key: 'sprite',
        type: 'render.sprite@3',
        properties: {
          textureResourceId: 'tex.unit-blue-basic',
          width: 1,
          height: 1,
          frame: 0,
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
        'body/sprite': { frame: state.damaged ? 5 : 0 },
      },
    };
  },
});
```

The declarative `animationId` starts from frame 0 when the Prefab instance attaches. Python state stays semantic
(`moving`, `damaged`, sequence counters); the display side maps it onto visual timelines.

Prefab identity rules:

- `PrefabDefinition.id` is unique within the Prefab catalog and is the only primary registry/lookup key.
- `gameplayType` is intentionally non-unique. Do not reject two definitions because they share it.
- Prefabs sharing one gameplay type must consume the same complete authority-state schema. A resolver may ignore fields but
  must not require private authority fields outside that schema.
- Keep `revision` separate from `id`. Raise revision when the declaration or `resolveState` semantics change; resolver function
  source is deliberately not hashed. Do not use a version suffix in the id as a substitute for revision.
- Runtime commands and Scene static instances use exact `prefabId`. Do not ask the Registry to guess one Prefab from a
  gameplay type, and do not introduce an implicit default.
- A Node name is an instance identity; a Prefab id is a reusable definition identity; a gameplay type is only semantic/state
  compatibility metadata. Never interchange the three.

Prefab structure rules:

- The current schema is `scene-engine-prefab-definition@3`. Fixed children use
  `prefabInstances: [{key, parentLocalPath, prefabId, transform?, visible?, state?}]`; dynamic children use
  `prefabSlots: [{key, parentLocalPath, allowedPrefabIds, maximumInstances}]`.
- The root Transform is identity. Give independently posed parts child Nodes.
- Child names are Prefab-local paths only. Python never addresses them.
- A fixed child always exists. Its resolver override is `{transform?, visible?, state?}`; an omitted override resets it to the
  declaration baseline. Use a slot with `maximumInstances: 1` for an optional singleton.
- A slot resolver output maps stable instance keys to `{prefabId, transform?, visible?, state?}`. It is the complete desired set,
  not a delta: an omitted slot is empty. Enforce the slot allowlist and `maximumInstances` before live mutation.
- `parentLocalPath` may mount only on the current definition's own root-tree Node, never inside another child Prefab.
- `resolveState(state, context)` is pure, synchronous and deterministic. Its only closed outputs are `nodes`, `components`,
  `prefabInstances` and `prefabSlots`.
- Authority state is a complete replacement. The outer resolver receives the complete game-owned state; every child resolver
  receives the complete child state derived for it. Neither may rely on hidden prior calls.
- Nested definitions recursively materialize as ordinary Nodes and Components in the sole NodeIndex/NodeGraph. Keep only a
  package-private flat provenance/diff ledger; do not expose runtime child-Prefab objects or create a second tree.
- The same slot key, instance key and `prefabId` retain Node/Component identity. Add missing-new keys, remove absent keys and
  replace a retained key when its `prefabId` changes.
- Build canonical descendant names from the outer Scene/authority owner plus the accumulated instance/local path, with exactly
  one `prefab/` prefix. Never build `prefab/prefab/...`.
- Do not call `PrefabDefinition.instantiate()` or construct internal scope/Node objects. Runtime installation and AuthorityPort
  are the supported instance owners.
- Dynamic structure may change only through synchronous complete-state resolution. Do not let a Behaviour, RAF callback,
  Resource load or renderer add/remove/replace child instances. Use a registered `BehaviourComponent` only for visual-only
  component behavior that genuinely needs the sole Display RAF.

Authority creation and replacement use exact ids. Checkpoint bootstrap may create authority Nodes after Scene
installation and before activation. After activation, every authority mutation must be inside one active commit gate:

```js
// Checkpoint bootstrap: allowed only before runtime.activate(...).
runtime.authority.createNode({
  name: 'py/unit/42',
  parentName: null,
  prefabId: 'product/unit/blue-basic',
  transformMode: 'live',
  transform,
  visible: true,
  state,
});

runtime.activate(checkpointCursor);

// Later commit: all target operations belong to the same cursor barrier.
runtime.commitGate.begin(commitCursor);
try {
  runtime.authority.replaceNodePrefab({
    name: 'py/unit/42',
    prefabId: 'product/unit/red-basic',
    state,
  });
  runtime.commitGate.seal(commitCursor);
} catch (error) {
  runtime.commitGate.fail(error);
  throw error;
}
```

Do not carry both `prefabId` and `gameplayType` in an authority command. The registered Definition determines gameplay type;
duplicating it would create two fields that can disagree.

The game controls only the outer Scene instance or `py/` authority root. Nested definition-owned children are not new Authority
targets and receive no Python commands; `setNodeState` on the outer root drives the complete recursive desired materialization.

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
    state: {},
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
render.model@2
render.mesh@1
render.sprite@3
render.surface@1
render.particle@2
render.camera@1
render.background@1
render.ambient-light@1
render.directional-light@1
render.point-light@1
render.spot-light@1
```

The Display-local animator component is `animation.player@1` (each Prefab definition-instance root only, `allowMultiple` with
distinct keys). Sprite frame sequences belong to the animator; the renderer-owned animation fields of the previous model,
sprite and particle component versions are rejected fail-closed.

`BillboardComponent` (`behavior.billboard@2`) defaults to fixed world +Z forward / +Y up in Display's shared
transform pipeline. Camera-facing behavior requires explicit `facing: 'camera'`; version 1 is not registered.
`render.sprite@3` derives `panelAnchorWorld` from its nearest enabled fixed billboard ancestor. The backend applies
anchor-relative perspective compensation to vertices and picking, including instances; it never changes Node TRS,
expands height for camera pitch, or pins the anchor to the screen. See `docs/render-runtime.md` for the exact formula.
`LookAtComponent` remains a separate built-in visual Behaviour. For a product-specific component:

1. Extend `Component` or `BehaviourComponent`; do not override final lifecycle/mutation methods.
2. Give it one versioned static `typeId` and, for a Behaviour, one `tickPhase` of `update` or `before-render`. Bump the
   `typeId` version whenever its property schema or lifecycle semantics change; catalog hashing cannot serialize function bodies.
3. Register a descriptor with `ComponentClass`, a complete synchronous `normalizeProperties`, and a synchronous
   `resourceReferences` function. When any of those semantics change, publish a new versioned `typeId`; function source is not
   part of the catalog manifest.
4. Keep properties closed, plain, deeply frozen data. Do not store a second Transform in component properties.
5. Use `onAttach`, `tick`, and `onDispose` only as synchronous optional handlers. Promise-returning handlers fail.
6. Only BehaviourComponents tick. RenderComponents are declarative and may not implement handlers.
7. Replace properties only through `componentRegistry.patchComponentProperties(...)`; never mutate the properties object.
8. Component hooks receive only the public read-only Display query surface and frozen `NodeView` values. They do not receive
   NodeIndex, NodeGraph, AuthorityPort, CommitGate, scheduler, or RenderSystem.
9. A transform-driving Behaviour may call `setDrivenLocalTransform(...)` only for its own non-authority Node. It cannot mutate a
   Python-owned `py/` authority root or any other Node.
10. Built-in renderer component properties, including nested material, surface, particle, light, camera, and background
    values, are completely normalized before Node mutation and commit-gate seal.
11. The animation operations `setAnimation`, `playAnimation` and `stopAnimation` are final base-class methods; they address an
    `animation.player@1` on the caller's own Node and cannot be overridden.

### Display animator

The animator is a Display-only visual timeline. First version: `sprite.frame` channel, `step` interpolation, per-player local
`visualSeconds` origin. One Animation Resource is one timeline; one `animation.player@1` is one local player.

Resource (uniform frame replacement):

```js
import { defineFrameAnimation } from '@scene-engine/display';

const walk = defineFrameAnimation({
  id: 'anim.unit.walk',
  target: { node: 'body', component: 'sprite' },
  frames: [0, 1, 2, 1],
  fps: 10,
  loop: true,
});
```

For unequal dwell times use `defineAnimation()` with explicit `{atMs, value}` keyframes. Both helpers and the ResourceRegistry
share one normalizer; the schema is exactly `scene-engine-animation-resource@2`.

Runtime control from a Behaviour on the same Node as the player:

```js
class UnitVisualBehaviour extends BehaviourComponent {
  static typeId = 'visual.unit@1';
  static tickPhase = 'update';

  tick() {
    if (this.properties.fireSequence !== this._lastFire) {
      this._lastFire = this.properties.fireSequence;
      this.playAnimation('animator', 'anim.unit.fire');
      return;
    }
    this.setAnimation(
      'animator',
      this.properties.moving ? 'anim.unit.walk' : 'anim.unit.idle',
    );
  }
}
```

| Intent | API |
|---|---|
| Sustained idle/walk, repeated calls keep the phase | `setAnimation(playerKey, id)` |
| One-shot fire/hit/flash, same clip replays from zero | `playAnimation(playerKey, id)` |
| Stop and restore base properties | `stopAnimation(playerKey)` |

Rules:

- Player placement is each Prefab definition-instance root only; its ordinary child nodes and plain Scene nodes are rejected at
  compile time.
- Track targets are local to that exact materialization Scope (`$root` or one own local path); never global `py/...` names and
  never a path through a nested child Prefab.
- Resolve animation roots by package-private Scope identity/provenance, not by a `prefab/` Node-name prefix. Same-key/id nested
  retention preserves player phase; replacement/re-add starts a new player, and removal releases transient ownership.
- The first-version target must be `render.sprite@3` with a `texture-atlas`; keyframe values stay below `columns * rows`.
- Sampling never mutates `component.properties`; stop restores the newest base values.
- Non-loop clips hold the final keyframe; returning to idle needs an explicit `setAnimation`.
- Do not use `sourceTick` for animator sampling, and do not re-trigger one-shot clips from a boolean every tick — detect
  sequence/edge changes instead.
- Do not implement state machines, transitions, layers, blend trees, event tracks or arbitrary property paths; future channels
  join this timeline as closed unions only.

See [Display animator](../../../docs/display-animation.md).

If an object needs an independent pose, create a child Node instead of adding position, rotation, matrix, or Transform fields to
a Component.

## Use the Three backend only at composition root

Application and product modules import renderer-isolated `@scene-engine/display` contracts. Only the browser composition root imports
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

- Rule time is `source_tick / TICKS_PER_SECOND`; the contract value is exactly 60. `sourceTick` marks the authoritative
  simulation commit position and never advances an animation. The Display animator samples each player against its own local
  `visualSeconds` origin; global procedural renderer effects may sample `visualSeconds` directly. Visual time never changes
  the World.
- Node names are immutable lowercase canonical paths under exactly `sys/`, `scene/`, `py/`, or `prefab/`.
- Full `py/` authority name is the runtime instance identity. `PrefabDefinition.id` is the reusable definition identity;
  `gameplayType` is non-unique state-contract metadata. Never use one in place of another.
- Authority create/replace operations carry exact `prefabId`; Registry lookup by gameplay type is forbidden on the production
  path.
- `null` authority parent means `sys/authority-root`; a non-null authority parent must be an existing `py/` Node.
- Each Node owns exactly one local TRS. World Transform is derived by the sole NodeGraph.
- Each authority operation has exactly one target and validates before mutation. Before activation this is only checkpoint
  bootstrap; after activation it is legal only while one commit gate is active.
- `setNodeState` is complete replacement and synchronously resolves/validates the full nested desired candidate. Stage nested
  additions/replacements before adoption; retained same-key/id records keep identity, and removed records dispose
  child-before-parent only after success.
- `replaceNodePrefab` takes an exact `prefabId`, stages and validates a shadow materialization, then swaps it atomically for that
  target operation. Built-in render-state validation completes before mutation/seal, never first in a later RAF.
- A full DisplayView is an explicit diagnostic/query snapshot, not a state owner and not a per-commit cache.

## Failure and disposal

- Product mutation/commit construction failure makes the Python runtime fatal; do not retry the same tick against a partially
  mutated World.
- Client command/application failure emits no ACK and leaves the projection invalid; replace the client/session from a new
  checkpoint.
- Component tick failure halts Display scheduling and marks the runtime unhealthy.
- Renderer health failure is recoverable only through the explicit backend rebuild path when the event is marked recoverable.
- Disposal must release session, RAF, Scene/Prefab materializations and their private ledger, Nodes, Components, resource
  leases, pending loads, backend bindings, renderer resources, listeners, and recorder state owned by that layer.
- Keep disposal idempotent. Await `DisplayRuntime.dispose()` and renderer readiness/disposal where the public API is async.

## Do not introduce

- a second mutable World, Scene tree, Node map, Transform cache, simulation clock, RAF, ACK cursor, or packet decoder;
- compatibility aliases, dual writes, fallback decoders, fallback renderer, or legacy package redirects;
- product rules or state schemas inside Scene Engine;
- raw asset URLs or renderer details in Python DisplayNode/DisplayCommand state;
- direct Three imports outside `@scene-engine/renderer-three` and the composition root;
- hidden default camera, light, material, or model behavior in the backend;
- asynchronous session factories, catalog-identity calls, authority operations, state resolvers, Component handlers, or
  registry normalizers;
- mutation of registries after DisplayRuntime construction;
- full-tree `currentDisplayView()` generation inside the normal commit observer;
- direct construction of internal Node, Scene, scope, NodeIndex, NodeGraph, AuthorityComponent, RenderSystem, or
  backend-binding classes;
- a public runtime child-Prefab object, nested Prefab tree, child Authority command surface or Behaviour-driven structure path;
- a Prefab Registry keyed by gameplay type, a uniqueness rule on gameplay type, or an implicit default Prefab selector;
- animation clocks, keyframes, progress or player origins in Python, wire, checkpoint, Replay or Client commands;
- renderer-owned playable timelines (model mixer playback, sprite frame timelines, particle clocks) or sampling animation
  from `sourceTick`;
- animation state machines, transitions, layers, blend trees, event tracks, or arbitrary keyframe property paths;
- authority fields named `prefab_type`/`prefabType`; the formal contract uses `prefab_id`/`prefabId`;
- calls to `SceneDefinition.instantiate()` or `PrefabDefinition.instantiate()`; use `runtime.installScene` and AuthorityPort;
- authority mutation outside checkpoint bootstrap or an active commit gate;
- manual/fake catalog hashes instead of the canonical manifest-derived build artifact;
- game-art production instructions, visual style guidance, Showcase catalog work, capture composition, or asset review in this
  Skill.

## Test the change

Follow [testing methods and standards](../../../docs/testing.md) and the current
[test item index](../../../docs/tests/README.md). Focused commands may shorten feedback while editing:

```bash
# Display definitions/compiler, nested materialization/diff/rollback, animation Scope, lifecycle, and scale coverage
npm test --workspace @scene-engine/display

# Client packet, WorldState, ACK, session, and packet-log coverage
npm test --workspace @scene-engine/client

# Three binding, loading, batching, pick, rebuild, and disposal coverage
npm test --workspace @scene-engine/renderer-three
```

When changing a cross-language protocol or identity, update Python and JavaScript implementations, tests, canonical fixtures,
package versions/locks, and binding documents in one change. Do not make one side accept both the old and new contract.

Completion has one standard: both complete test commands pass.

```bash
uv run python -m pytest -q
npm test
```
