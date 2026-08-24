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
           -> product pure-data RenderSnapshot / RenderBatch
              -> ThreeRenderRuntime 0.8 / Render schema V2
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
| Three objects/resources and draw scheduling | `ThreeRenderRuntime` | opaque pure-data diagnostics only |
| recorded state stream | `packets.bin` | rebuildable index records |

Engine code is generic. A product owns its world codec, change journal, commands, structured scene projection, binary
`SceneEvent` schema, transport
adapter, visual catalog, and pure-data render compositions. Replay validates a packet-log container and feeds its exact records to the
same client; it does not implement another wire decoder or scene tree.

The product port never supplies an encoded frame or a second JSON event channel. Runtime parses and freezes bootstrap bytes
once, validates each `SceneNode`/`SceneEvent` publication against that cached view, and performs the sole frame encoding.

## Render projection boundary

`SceneEngineClient` continues to own the sole node tree, ordered lifecycle plan, pose, visibility, profile, animation,
interaction, generation, commit cursor, and source tick. A product such as Arts maps that immutable view to synchronous
plain-data resources and compositions; it does not receive Three objects and does not create another tree.

`@scene-engine/renderer-three@0.8.0` owns one WebGLRenderer, Scene, PerspectiveCamera, pan/zoom controls, projection roots,
resource manager, ResizeObserver and render RAF. It accepts only the five fixed V2 pipelines. Node composition and scene
layers are distinct validation scopes: `scene-pass@2` is scene-only, each node composition identifies a real view node,
and background/lights are singleton scene passes. Runtime creates neither hidden default lights nor a WebGLRenderTarget;
background and lighting exist only when the complete scene layers declare them. Only a scene-pass binding change triggers
global background/light reevaluation; churn in node or other scene-layer bindings cannot repeatedly replace those objects.

Wall time and RAF schedule drawing and visual-clock sampling only. A no-frame Engine commit still advances the renderer's
`sourceTick`, so simulation-clock animation samples the new authoritative tick without manufacturing a scene lifecycle
plan. Several ordered operations may share one final matrix barrier/draw, but lifecycle steps are never dropped or merged.

## Failure domains

Gameplay, checkpoint/commit construction, wire encoding, recorder append, or recorder seal failure permanently quarantines
the runtime because the authoritative chain may already have changed. A transport send, malformed client packet, invalid ACK,
timeout, or per-session limit closes only that client. Browser decode/prepare failure changes no installed pointer and returns
no ACK. Observer or renderer failure occurs after the barrier and never rolls back trusted client state.

Renderer validation failure is atomic and mutates no projection. An error after GPU mutation, during RAF sampling, batch
refresh, or draw marks the projection unhealthy and emits a plain-data health event. The only recovery path is a complete
`rebuild()` from the latest client view and a freshly compiled snapshot; a successful idle/resource barrier restores health.
A `render-draw-failed` event additionally taints the owned WebGLRenderer: recovery clears bindings and resource leases,
disposes that renderer, recreates it on the same canvas with the same profile and size, then installs the snapshot. Other
controls, sample, batch, or diagnostics failures rebuild the projection without replacing WebGLRenderer. This distinction
is internal and does not expose a Three object or change the installed client state.
