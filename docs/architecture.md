# Current architecture

Scene Engine 0.7 owns one authoritative transaction and synchronization boundary. The JavaScript packages in that boundary
are Client 0.8, Display 0.2 and Three backend 0.9.1:

```text
mutable product world (60 Hz integer tick owner)
  -> ProductCheckpoint / ProductCommit
  -> wire@2 exact packet bytes
  -> recorder + sessions
  -> SceneEngineClient 0.8
       -> immutable WorldState + cumulative ACK + O(1) DisplaySummary
       -> DisplayRuntime 0.2 AuthorityPort
            -> one NodeIndex / one Transform / Component scheduler
            -> RenderSystem
                 -> flat ThreeRenderBackend 0.9.1 bindings
```

## Ownership

| Concern | Sole owner | Boundary |
|---|---|---|
| gameplay state and rules | product | `EngineProgram` callbacks |
| tick, commit, revision and command sequence | Python Engine | wire header/attachments |
| exact packet decode, WorldState pointer, ACK and observer scheduling | JavaScript client | client public API |
| Node names, parent graph and Transform | DisplayRuntime | `AuthorityPort` and read-only runtime queries |
| Scene, Prefab, Component and Resource registries | DisplayRuntime | immutable definitions |
| property normalization and Resource reference validation | ComponentRegistry | registry-controlled property replacement |
| renderer bindings, batches and GPU resources | Three backend | `RenderBackend` methods |
| recording/playback bytes | packet-log@2 | exact Engine packets |

Products publish only `py/` authority roots and logical Prefab types. Arts owns the matching Scene/Prefab/Resource definitions.
Prefab-local nodes are instantiated into the same NodeIndex and retain their authority owner name. Production UI requests a
complete immutable DisplayView only for explicit picking, focus, capture or diagnosis; it never mutates Nodes or parses Prefab
paths for product identity.

## Commit and observation boundary

The Client validates the full packet and World candidate, applies each single-target command behind the exact commit gate,
seals the cursor, publishes its new pointers, reads `DisplayRuntime.summary()` in O(1), and encodes the cumulative ACK. The
`onCommit` payload is `{kind, commit, worldState, displaySummary}` and runs later as a microtask. Full-tree view construction,
resources, HUD, observers, RAF and drawing are outside the ACK barrier; observer failure cannot undo a commit or withhold ACK.

## Display and renderer lifecycle

DisplayRuntime owns the only application RAF. Its frame order is
`update -> transform flush -> before-render -> transform flush -> prepare -> render`.
Component property changes pass through ComponentRegistry normalization and Resource id/kind validation before mutation.
Dispose stops scheduling, aborts pending work, empties scopes and indexes, releases Scene/Node/Component/backend references,
and is idempotent. Backend rebuild replaces only bindings/resources; Node and Component identity stays intact.

For each `(nodeName, componentKey)`, Three retains logical visibility independently from its representation. An ordinary object
is drawable only when the binding is not batched; a batch instance is drawable only while batched and logically visible.
Transform, visibility, replacement and batch-exit updates preserve that exclusivity. A Display/Component failure makes the
projection invalid and requires a fresh checkpoint/session.

## Browser surfaces

The browser product surface consists only of the production Live/Replay page and a read-only Arts Showcase. Showcase uses the
same formal definitions, registries, DisplayRuntime, RenderSystem and Three backend, but creates no SceneEngineClient,
WebSocket, ACK or authority fixtures. It exposes fixed catalog entries, Camera presets and UI kits without node selection,
mutation, save or export; Arts owns those product details.
