# Display Kind authority projection migration

> Status: implemented in Scene Engine 0.19 / Client 0.16 / Display 0.15 with
> `scene-engine-display-node@9` and SDCP/SDCS v6. Product coordination for the repository-wide cutover is
> defined in the [workspace migration contract](https://gitlab.standlee.cc/missile-war/workspace/-/blob/main/display-kind-migration.md).

## Engine responsibility

Scene Engine must carry an opaque, versioned display requirement kind from the product to the browser without
knowing Missile War requirements or selecting product Prefabs. Display remains the sole owner of Authority root,
NodeGraph, Prefab materialization and ACK barriers.

The target outer record is:

```text
nodeId / parentNodeId / displayKindId / MatrixPool row / transformMode /
visible / complete state
```

Nested and Scene-owned composition remains exact `prefabId` inside Display definitions. The migration changes only
the product-controlled outer Authority boundary.

## Implemented API changes

### Python publication

- Replace `DisplayNode.prefab_id` with `display_kind_id`.
- Replace outer `DisplayCommand.replace_prefab(...)` with a kind-change constructor that carries
  `node_id + display_kind_id + complete state`.
- Remove `DisplayCatalogIdentity` from `ProductCheckpoint`. The producer still supplies `scene_name`, the matrix
  pool and parent-first nodes, but no Arts Scene/Prefab/Resource hash.
- Keep MatrixPool, command ordering, tick, revision, checkpoint and recording semantics unchanged.

### Binary Display attachment and Client

- Bump the Display record/binary schema; do not reinterpret old `prefab_id` bytes in place.
- Encode/decode `display_kind_id` for checkpoint create and kind-change commands.
- Remove producer catalog hashes from checkpoint metadata and the Client equality comparison against
  `DisplayRuntime.catalogIdentity()`.
- Keep the Runtime's local catalog identity API for build/artifact integrity and diagnostics.
- Update TypeScript records, Python/JavaScript codecs, fixtures and cross-language byte tests together.

No online compatibility decoder is added. Old recordings remain owned by their old deployment.

## DisplayKindRegistry

Add one generic registry supplied to `createDisplayRuntime(...)`. A kind definition contains:

```text
id                         versioned displayKindId
gameplayType               complete-state schema compatibility key
revision                   selector/adapter semantic revision
authorityPrefabIds         closed allowlist; may be empty
defaultPrefabId            explicit optional default
resolvePrefab(state)       optional synchronous deterministic selector
```

Rules:

- an empty allowlist means a known requirement with no implementation;
- a non-empty allowlist requires exactly one of an explicit default or a resolver that returns one allowed Prefab;
- resolver source is not hashed, so semantic changes increment the kind definition revision;
- selected Prefabs must be registered and compatible with the kind's `gameplayType`;
- registration order never selects an implementation;
- Prefab-internal fixed children and dynamic slots continue using their existing exact-ID rules.

The local Display catalog manifest includes kind definitions and implementation allowlists. This local hash is not
sent by the producer.

## Missing implementation lifecycle

AuthorityPort always creates the outer Authority Node after validating node ID, parent, matrix row, kind syntax,
visibility and JSON limits.

| Resolution | Materialization | Diagnostic | ACK |
| --- | --- | --- | --- |
| kind absent from registry | no Prefab-local subtree | `display-kind-unknown-requirement` warning | yes |
| known kind, empty implementation list | no Prefab-local subtree | `display-kind-unimplemented` warning | yes |
| implementation list cannot select | no Prefab-local subtree | `display-kind-selection-unresolved` error diagnostic | yes |
| selected Prefab or state invalid | operation fails closed | existing projection error | no |

An unresolved root still participates in the Authority matrix pool, parent graph, visibility, state replacement and
removal lifecycle. A child whose parent is unresolved remains correctly parented because the outer Node exists.

`setNodeState` reruns kind resolution synchronously. If a valid selector changes its selected Prefab, Display performs
the existing staged materialization replacement in the same command transaction. Missing-art diagnostics never
write state, advance gameplay or create another tree.

Keep a bounded current gap map keyed by Authority node ID. Emit diagnostics only when the node's current gap code or
kind changes; expose current counts/details through diagnostics rather than an unbounded event history.

`currentDiagnostics()` returns
`{schema, warningCount, errorCount, gaps:[{nodeId,displayKindId,code,severity}]}`. Optional `onDiagnostic` receives
`{nodeId,previous,current}` transitions. An event targeting an empty gap root is a successful no-op because there is no visual
event surface to dispatch to.

## State compatibility

`gameplayType` remains a state-schema compatibility key and is not the product selection identity. An incompatible
state contract requires a new versioned `displayKindId`; a Prefab/resource replacement does not.

Malformed complete state, selector exceptions and invalid selected Prefabs remain projection defects. Only absence of
an implementation becomes a successful degraded projection.

## Catalog and Replay boundary

- Runtime validates its complete local Scene/Kind/Prefab/Resource/Component catalog before installation.
- Client no longer requires that catalog to equal producer bytes.
- Packet logs record kind/state exactly; Replay uses the same Client and does not resolve kinds server-side.
- A product that needs historical visual fidelity pins a separate Display artifact identity in Replay metadata.

## Implementation areas

- Python: `display.py`, `display_binary.py`, `runtime.py`, exports and tests.
- JavaScript Client: binary records, session metadata, Authority payloads, declarations and fixtures.
- JavaScript Display: kind registry, catalog manifest, AuthorityPort, placeholder roots, diagnostics and typings.
- Documentation: architecture, runtime, display, client, wire, recording/replay and release tuple.

## Required tests

- cross-language byte fixtures for checkpoint create and kind change;
- unknown and known-unimplemented kinds retain hierarchy/state and ACK;
- unresolved parent plus implemented child retains one correct graph;
- state update can select, replace, lose and regain a Prefab deterministically;
- invalid state/Prefab still produces no ACK;
- changing only local Prefab/Resource content does not change producer packet bytes;
- real-time and Replay Client apply identical kind/state sequences;
- full Python and JavaScript suites pass before release.
