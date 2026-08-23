# Architecture

Scene Engine 0.6 owns one transaction and synchronization boundary:

```text
product WorldState + EngineProgram
  -> SceneEngineRuntime
     -> one immutable checkpoint/commit packet
        -> bounded client sessions
        -> exact-byte PacketLogWriter

packet bytes
  -> SceneEngineClient.applyPacket()
     -> one frozen WorldState pointer + one scene tree + one cursor
        -> observer {plan, view}
           -> ThreeSceneBackend
```

## Ownership

| State | Sole owner | Other components may retain |
| --- | --- | --- |
| mutable product world | `SceneEngineRuntime` | only a callback-scoped borrow in `EngineProgram` |
| tick/revision/commit cursor | runtime | immutable `EngineCommit` values |
| encoded state packet | global retention ring | shared immutable `PacketRef` |
| immutable scene catalog/static validation view | runtime | commit publication checks only |
| per-connection credit/input ledger | one `ClientSession` | compact health snapshots |
| browser WorldState | one `SceneEngineClient` pointer | immutable selector references |
| static + dynamic scene nodes | client internal `SceneTree` | immutable view/payload slices |
| Three objects/resources | `ThreeSceneBackend` | product factory handles |
| recorded state stream | `packets.bin` | rebuildable index records |

Engine code is generic. A product owns its world codec, change journal, commands, structured scene projection, binary
`SceneEvent` schema, transport
adapter, visual catalog, and resource factories. Replay validates a packet-log container and feeds its exact records to the
same client; it does not implement another wire decoder or scene tree.

The product port never supplies an encoded frame or a second JSON event channel. Runtime parses and freezes bootstrap bytes
once, validates each `SceneNode`/`SceneEvent` publication against that cached view, and performs the sole frame encoding.

## Failure domains

Gameplay, checkpoint/commit construction, wire encoding, recorder append, or recorder seal failure permanently quarantines
the runtime because the authoritative chain may already have changed. A transport send, malformed client packet, invalid ACK,
timeout, or per-session limit closes only that client. Browser decode/prepare failure changes no installed pointer and returns
no ACK. Observer or renderer failure occurs after the barrier and never rolls back trusted client state.
