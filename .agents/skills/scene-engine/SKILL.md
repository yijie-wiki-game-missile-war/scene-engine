---
name: scene-engine
description: Use, integrate, extend, test, or debug Scene Engine's Python fixed-step runtime, wire/client boundary, DisplayRuntime Scene/Prefab/Resource/Component model, Three RenderBackend, and recording/replay path. Use for engine and application-integration work; do not use for game-art asset production, visual direction, owner art workflows, or Showcase review.
---

# Scene Engine routing guide

Use this Skill to find the authoritative owner, public boundary, current contract, and test surface for Scene Engine work.
Keep this file as a route map; put API syntax and behavioral details in the linked current documents.

If this Skill conflicts with repository instructions, current source, or a current contract document, those sources win.

## Read before changing the repository

Always read:

- [repository instructions](../../../AGENTS.md)
- [product definition and technical-document index](../../../README.md)
- [current architecture and ownership](../../../docs/architecture.md)

Then read only the current documents for the affected boundary:

| Concern | Current document |
|---|---|
| Python runtime, scheduling, transactions, input, sessions | [Runtime and fixed 60 Hz](../../../docs/runtime.md) |
| Node property/event product integration | [Python publication quickstart](../../../docs/runtime.md#node-property-and-event-publication-quickstart) and [Display consumption quickstart](../../../docs/display.md#property-projection-and-event-handling-quickstart) |
| Packet schemas, limits, encoding and cross-language fixtures | [Wire protocol](../../../docs/wire.md) |
| JavaScript decode, WorldState, ACK and Display session | [Client](../../../docs/client.md) |
| Scene, Prefab, Resource, Component and Display lifecycle | [Display](../../../docs/display.md) |
| Display-local visual timelines | [Display animation](../../../docs/display-animation.md) |
| Three bindings, loading, batching, projection and disposal | [Render runtime](../../../docs/render-runtime.md) |
| Exact packet recording, seek and Replay | [Recording and Replay](../../../docs/recording-replay.md) |
| Fixed-point transform encoding and coordinates | [Transform](../../../docs/transform.md) |
| Test methods and commands | [Testing](../../../docs/testing.md) |
| Test inventory and suites | [Test items](../../../docs/tests/README.md) |

Historical reviews, migration notes, and patch reports are context only. They do not override the current documents above.

## Route work to the sole owner

| Task | Sole owner | Public boundary |
|---|---|---|
| Gameplay rules and mutable product World | Product | `EngineProgram` callbacks |
| Tick, revision, commits, commands and sessions | Python runtime | `SceneEngineRuntime` |
| Packet layout and exact codec | Python runtime + JavaScript Client | `scene-engine-wire@3` |
| WorldState, ACK and observer scheduling | JavaScript Client | `SceneEngineClient` |
| Node graph, local Transform and Prefab instances | Display | `DisplayRuntime` / `AuthorityPort` |
| Scene, Prefab, Resource, Component and state-schema catalog | Display composition | immutable definitions and registries |
| Renderer resources, bindings, batching and draw | Three backend | flat `RenderBackendPort` |
| Recorded bytes, seek and Replay validation | recorder + Client | `scene-engine-packet-log@3` and the live Client path |
| Rule-space matrix encoding and coordinate checks | transform codec | `scene-engine-transform@1` |

Product gameplay, product World schemas, network frameworks, HTTP, UI, game assets, visual direction, and concrete product
Scene/Prefab/Resource definitions belong outside this repository. Integrate them through the public boundaries above.

## Preserve the only production path

```text
mutable product World
  -> EngineProgram
  -> SceneEngineRuntime at exactly 60 Hz
  -> scene-engine-wire@3 exact packet bytes
  -> SceneEngineClient
  -> DisplayRuntime AuthorityPort
  -> RenderSystem
  -> flat Three RenderBackend
```

Recording stores exact Engine packets. Replay sends those bytes through the same Client, Display, and renderer path.
Tests, diagnostics, migration, and verification work must not introduce alternate state or decode paths.

## Public API entry points

Use package exports before reaching into implementation files:

- [Python exports](../../../src/scene_engine/__init__.py)
- [Python runtime port](../../../src/scene_engine/runtime.py)
- [Python Display records](../../../src/scene_engine/display.py)
- [JavaScript Client exports](../../../js/packages/client/src/index.js)
- [Display exports](../../../js/packages/display/src/index.js)
- [Three backend exports](../../../js/packages/renderer-three/src/index.js)

The corresponding checked declarations are:

- [Client declarations](../../../js/packages/client/src/index.d.ts)
- [Display declarations](../../../js/packages/display/src/index.d.ts)
- [Three backend declarations](../../../js/packages/renderer-three/src/index.d.ts)

Do not import package-private Node, graph, scope, materialization, scheduler, renderer-binding, or codec implementation types.

## Non-negotiable ownership rules

- Keep one mutable World, one ordered integer gameplay clock at exactly 60 Hz, one Engine packet stream, one cumulative ACK
  cursor, one Client WorldState pointer, one Display NodeIndex/NodeGraph, one local Transform per Node, and one application RAF.
- Keep the 60 Hz value variable-driven through the documented constant/configuration/context fields, but do not make another
  simulation rate legal.
- Wall time, RAF time, resource completion, and rendering never advance gameplay state or authoritative animation state.
- Keep every changed transaction independently committed; do not merge distinct mutations into a hidden aggregate commit.
- After Display activation, mutate Python-owned authority state only inside the active Client commit gate. Before activation,
  authority mutation is checkpoint bootstrap only.
- Compare canonical catalog identities before Scene installation. Generate them from the documented manifest; do not fabricate
  hashes or add fallback identity paths.
- Validate complete built-in renderer state and nested Prefab candidates before visible Node mutation and gate seal.
- Treat the Three backend as a flat renderer port. It owns renderer resources and bindings, not the business Node graph,
  application loop, product callbacks, hidden cameras/lights, or caller-visible Three objects.
- Keep Display animation visual-only and local to Display. Python, wire, checkpoints, Replay, and Client commands carry no
  keyframes, player clocks, progress, or visual-time origins.
- Keep product Behaviours on read-only views/query capabilities. They do not receive NodeIndex, NodeGraph, AuthorityPort,
  CommitGate, scheduler, or RenderSystem ownership.

Read the linked contract before changing any exact schema, version, name domain, validation order, lifecycle, animation rule,
Prefab composition rule, or failure behavior. Do not restate those details here.

## Do not add compatibility paths

Do not introduce:

- second owners, shadow stores, parallel cursors, duplicate transforms, secondary clocks, secondary RAFs, or packet decoders;
- aliases, dual writes, fallback decoders/renderers, legacy redirects, implicit defaults, or best-effort repair after failure;
- renderer URLs, raw assets, Three objects, or visual implementation state in Python authority records;
- renderer-owned playable timelines or gameplay mutation driven by visual time;
- public nested-Prefab runtime trees, child Authority command surfaces, or Behaviour-driven structural mutation;
- registry mutation after runtime construction or asynchronous code in boundaries documented as synchronous;
- direct construction of internal Scene, Prefab, Node, scope, graph, scheduler, or renderer-binding objects;
- full-tree Display snapshots in the normal per-commit observer path;
- test-only production shortcuts or alternate production paths.

When replacing a contract, remove the old production path. Do not keep both versions accepted unless a current contract
explicitly defines a migration boundary.

## Coordinate cross-boundary changes

For wire, catalog identity, public schema, or cross-language behavior changes, update together:

- Python implementation and tests;
- JavaScript implementation, declarations, and tests;
- canonical fixtures;
- package versions and locks when the public contract changes;
- the current owning document.

Keep implementation, declarations, fixtures, tests, and current docs consistent in the same change.

## Test references

The [testing guide](../../../docs/testing.md) documents available commands and the
[test inventory](../../../docs/tests/README.md) maps tests to their affected boundaries.
