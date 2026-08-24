# Current architecture

Scene Engine 0.7 owns one authoritative transaction and synchronization boundary:

```text
mutable product world (60 Hz integer tick owner)
  -> ProductCheckpoint / ProductCommit
  -> wire@2 exact packet bytes
  -> recorder + sessions
  -> SceneEngineClient 0.7
       -> immutable WorldState
       -> DisplayRuntime 0.1 AuthorityPort
            -> one NodeIndex / one Transform / Component scheduler
            -> RenderSystem
                 -> flat ThreeRenderBackend 0.9 bindings
```

## Ownership

| Concern | Sole owner | Boundary |
|---|---|---|
| gameplay state and rules | product | `EngineProgram` callbacks |
| tick, commit, revision and command sequence | Python Engine | wire header/attachments |
| exact packet decode and WorldState pointer | JavaScript client | client public API |
| Node names, parent graph and Transform | DisplayRuntime | `AuthorityPort` / local authoring port |
| Scene, Prefab, Component and Resource registries | DisplayRuntime | immutable definitions |
| renderer bindings and GPU resources | Three backend | `RenderBackend` methods |
| recording/playback bytes | packet-log@2 | exact Engine packets |

Products publish only `py/` authority roots and logical Prefab types. Arts owns the matching Scene/Prefab/Resource definitions.
Prefab-local nodes are instantiated into the same NodeIndex and retain their authority owner name. UI reads `DisplayView`;
it never mutates Nodes or parses Prefab paths for product identity.

DisplayRuntime owns the only application RAF. Its frame order is
`update -> transform flush -> before-render -> transform flush -> prepare -> render`.
Backend rebuild replaces only bindings/resources; Node and Component identity stays intact. A Display/Component failure makes
the projection invalid and requires a fresh checkpoint/session.
