# Runtime and 60 Hz rule

This document is binding for runtime, transport scheduling, recording, Replay timing, animation, and acceptance evidence.

## Sole time base

The authoritative rate is exactly `60 tick/s`; one tick is `1/60` simulation second. Tick is the only logical clock.
Wall-clock time, WebSocket arrival, `requestAnimationFrame`, video time, and encoder frame numbers may be derived from tick but
never advance or rewrite it.

Catch-up processes every overdue integer tick in order. It may execute several ticks in one `pump()`, but it publishes every
intermediate commit. A normal tick transition is exactly `N -> N+1`; no sampling, merging, latest-only replacement, or hidden
interpolation creates rule facts. Replay at 1× schedules a tick delta with `delta * 1000/60 ms`; speed scales wall time only.
Display may apply several queued commits before one draw, but must apply them in order.

Every committed tick includes one complete scene frame. Same-tick changed input includes a frame when visual state changed and
may omit it only when the scene is exactly unchanged. Animation time is derived from `source_tick`, `animation_start_tick`, and
60 TPS. A low-rate sprite may reuse artwork across ticks; its state consumption and clock checks still run at 60 Hz.

## Product port

`EngineProgram` is the only code allowed to borrow the mutable world:

```python
read_counters(world) -> WorldCounters
write_counters(world, counters) -> None
step(world, TickContext) -> MutationResult
handle_input(world, EngineInput, InputContext) -> MutationResult
build_checkpoint(world, CheckpointContext) -> ProductCheckpoint
build_commit(world, MutationResult, CommitContext) -> ProductCommit
```

The read/write counter port makes Engine ownership explicit without knowing product fields. Product snapshot and patch values
are plain mappings; they are not pre-encoded bytes. The breaking 0.6 product publication records are:

```python
ProductCheckpoint(
    world_codec: str,
    world_snapshot: Mapping[str, Any],
    scene_bootstrap: bytes,
    scene_nodes: tuple[SceneNode, ...],
    scene_events: tuple[SceneEvent, ...] = (),
)
ProductCommit(
    world_codec: str,
    world_patch: Mapping[str, Any],
    scene_nodes: tuple[SceneNode, ...] | None,
    scene_events: tuple[SceneEvent, ...] = (),
)
```

`scene_nodes` is a complete dynamic tree whenever present. A tick commit must provide it; a same-tick changed input may use
`None` only when its visual state is unchanged. `scene_events` are binary records inside that frame and therefore require
non-null `scene_nodes`. There is no encoded-frame product field, compatibility alias, or independent JSON product-events
attachment.

`start()` always builds and validates one checkpoint, even without a recorder or connected client. It parses bootstrap bytes
once and freezes the stream's world codec, immutable bytes, and validation view. Every later checkpoint must match both
identities and reuses the view. Each structured frame is validated directly against the frozen visual/animation registries,
static nodes, bootstrap byte/node limits, and complete parent/cycle/depth closure, then encoded exactly once before it can be
recorded or published. The retained bootstrap view is a catalog validator, not a second live scene tree.

## Transactions

Tick order is: reserve next commit/tick/revision; write next tick with the old revision; call `step` and require `changed`;
write the next revision; build and validate the product commit; encode and record once; publish one shared packet; then expose
the new counters. Any exception is fatal and the tick is never retried.

Inputs are decoded and queued per client, then serialized on the runtime thread. `rejected` and `no-op` return an optional
small result without changing counters. `changed` keeps tick fixed and increments revision and commit once; its commit
`causation_id` is the input ID. `MutationResult.changed()` has no result payload; the commit is the success fact.

The Engine deliberately does not copy an arbitrary world for generic rollback. A product command dispatcher must restore its
known fields before returning rejected/no-op and must own any recoverable command rollback. An uncaught mutation exception
quarantines the runtime, closes clients, leaves recording incomplete, and is never retried.

## Sessions and retention

Every connection first receives a checkpoint and then ordered commits. ACK is cumulative and means the client's WorldState,
scene tree, and cursor completed one synchronous barrier. It does not mean draw or observer completion.

Sessions have fixed in-flight count, pending byte, input count, and ACK-timeout limits. State packet bodies are encoded once.
Checkpoints at the same cursor are cached and shared; baseline checkpoints and commits both occupy the global count/byte ring.
When eviction reaches a packet still referenced by a lagging session, that session closes. If one checkpoint or commit cannot
fit in the global byte budget, no client may retain it. Slow clients never block tick progression or recorder append.

Input IDs are idempotent within the bounded session ledger: an identical no-op/rejected request replays its exact result bytes,
an identical changed request never executes twice, and conflicting bytes close only that session. Disconnect or same-ID
connection replacement discards every queued input belonging to the old session before the new baseline is installed.
