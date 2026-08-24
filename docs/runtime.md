# Runtime and 60 Hz rule

This document is binding for simulation, transport scheduling, recording, Replay timing, animation, display publication, and
acceptance evidence.

## Sole time base

The authoritative rate is exactly `60 tick/s`; one tick is `1/60` simulation second. Integer tick is the only logical clock.
Wall-clock time, WebSocket arrival, `requestAnimationFrame`, media time, and encoder frame numbers may be derived from tick but
never advance or rewrite it.

Catch-up executes every overdue tick in order and publishes every intermediate commit. A normal tick is exactly `N -> N+1`;
no sampling, merge, latest-only replacement, or interpolation creates rule facts. Same-tick changed input increments commit
and revision but not tick. Replay speed changes wall scheduling only.

Every changed transaction carries a World patch and a Display command-stream attachment, even when its command list is empty.
Commands within one tick keep strict `command_seq` order. Display may apply multiple queued commits before one draw, but it
must apply each transaction barrier in order.

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

The current publication records are:

```python
ProductCheckpoint(
    world_codec: str,
    world_snapshot: Mapping[str, Any],
    scene_name: str,
    display_catalog: DisplayCatalogIdentity,
    display_nodes: tuple[DisplayNode, ...],
)

ProductCommit(
    world_codec: str,
    world_patch: Mapping[str, Any],
    display_commands: tuple[DisplayCommand, ...] = (),
)
```

Checkpoint nodes are complete `py/` authority roots in parent-first order. Products choose stable node names, logical Prefab
types, transform mode, one local Transform, visibility and complete authority state. After checkpoint, products publish only
single-target logical commands. Engine owns `command_seq`, source tick, stream/commit/revision and encoded packet bytes.

`start()` always builds and validates a checkpoint, even without recorder or clients. Scene name, World codec, Display codec
and catalog identities are frozen for one stream. Every later checkpoint must match them. Product fields are plain data, never
pre-encoded protocol bytes.

## Transactions

Tick order is: reserve next counters; write proposed tick; call `step` and require changed; write proposed revision; build and
fully validate ProductCommit; assign command sequence; encode/record once; publish shared bytes; expose counters. Any exception
is fatal and the tick is not retried.

Inputs are decoded and queued per client, then serialized on the runtime thread. `rejected` and `no-op` do not change counters.
`changed` keeps tick fixed and increments revision/commit once; the commit causation ID is the input ID. An uncaught product
mutation error quarantines the runtime and leaves the recording incomplete.

## Client barrier and ACK

Every connection receives a checkpoint before commits. For checkpoint, the client creates a fresh Display session, installs
the Engine-provided scene, injects every authority baseline node, activates/starts, then swaps the World/Display projection.
For commit, it validates the complete stream and World candidate, opens the exact commit gate, invokes every AuthorityPort
operation, seals the cursor, then swaps state.

ACK is cumulative over commit and command cursors and is generated only after that synchronous barrier succeeds. It does not
wait for asynchronous resources, observers, RAF or drawing. A command failure invalidates the projection, produces no ACK,
and requires a fresh checkpoint/session.

## Sessions and retention

Sessions have bounded in-flight count, pending bytes, input count and ACK timeout. Packet bodies are encoded once and shared.
Checkpoints and commits occupy the global count/byte ring. Eviction closes only lagging sessions; slow clients never block tick
progression or recorder append.

Input IDs are idempotent within a bounded session ledger. Identical completed requests replay their exact result; a changed
request never executes twice; conflicting bytes close that session. Disconnect or same-ID replacement discards queued input
from the old session before installing a new baseline.
