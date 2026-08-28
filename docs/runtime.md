# Runtime and 60 Hz rule

This document is binding for simulation, transport scheduling, recording, Replay timing, animation and Display publication.

## Fixed contract, variable implementation

The authoritative rate is exactly `60 tick/s`; one tick is `1/60` simulation second. Integer `source_tick` is the sole logical
clock. Wall time, WebSocket arrival, `requestAnimationFrame`, media time and encoder frame numbers may be derived from it but
never advance or rewrite it.

The implementation still carries the rate through `RuntimeConfig.ticks_per_second` and every callback context so calculations
do not scatter a literal `60`. This field is a contract value, not a selectable frame rate: `RuntimeConfig` rejects every value
other than `TICKS_PER_SECOND`, currently 60.

`TickContext`, `InputContext`, `CheckpointContext`, and `CommitContext` all expose the same `ticks_per_second` contract value.

Catch-up executes every overdue tick in order and publishes every intermediate changed transaction. A normal tick is exactly
`N -> N+1`; no sampling, merge, latest-only replacement or interpolation creates rule facts. Same-tick changed input increments
commit and revision but not tick. Replay speed changes only wall scheduling.

## Product port

`EngineProgram` is the only code allowed to borrow the mutable World:

```python
read_counters(world) -> WorldCounters
write_counters(world, counters) -> None
step(world, TickContext) -> MutationResult
handle_input(world, EngineInput, InputContext) -> MutationResult
build_checkpoint(world, CheckpointContext) -> ProductCheckpoint
build_commit(world, MutationResult, CommitContext) -> ProductCommit
```

`MutationResult` is one of:

```python
MutationResult.changed(commit_context=...)
MutationResult.no_op(reason_code=..., result_payload=...)
MutationResult.rejected(reason_code=..., result_payload=...)
```

`commit_context` exists only on `changed` and carries opaque product data from mutation to `build_commit`; it is not an
informal engine message bag. `no-op` and `rejected` cannot carry it. Only `changed` creates a commit. Product mutation and
commit construction run on the runtime thread and must be synchronous.

Current publication records are:

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

The display identity is loaded from the JSON artifact produced by the JavaScript catalog build:

```python
identity = DisplayCatalogIdentity.from_record(record)
```

Checkpoint nodes are complete parent-first `py/` authority roots. Product code chooses stable names, exact registered
`prefab_id`, transform mode, one local Transform, visibility and complete authority state. After checkpoint it publishes only
single-target commands created through named constructors:

```python
DisplayCommand.create_node(node)
DisplayCommand.set_transform(name, transform)
DisplayCommand.set_parent(name, parent_name)
DisplayCommand.set_visible(name, visible)
DisplayCommand.set_state(name, complete_state)
DisplayCommand.replace_prefab(name, prefab_id, complete_state)
DisplayCommand.remove(name)
```

Generic `DisplayCommand(kind=..., **fields)` construction is intentionally unavailable. Engine owns `command_seq`,
`source_tick`, stream/commit/revision and encoded bytes.

## Transaction order

A tick transaction is:

1. reserve proposed counters;
2. write proposed tick into the borrowed World;
3. call `step` and require `changed`;
4. write proposed revision;
5. call `build_commit` with the mutation's `commit_context`;
6. validate World patch and every Display command;
7. assign command sequence;
8. encode/record once and publish shared immutable bytes;
9. expose the committed counters.

Any uncaught mutation, build, validation, encoding or recorder error is fatal. The runtime does not retry the same tick against a
possibly partially mutated World.

Inputs are decoded, bounded and queued per client, then serialized on the runtime thread. `rejected` and `no-op` leave counters
unchanged. `changed` keeps tick fixed, increments revision/commit once and records the input ID as causation.

`start()` always builds and validates a checkpoint, even without clients or a recorder. Scene name, World codec, Display codec
and catalog identities are frozen for one stream. Later checkpoints must match them.

## Client barrier and ACK

Every connection receives a checkpoint before commits. A commit carries a World patch and a Display command-stream attachment,
even when its command list is empty. Commands preserve strict stream-global `command_seq` order.

Client validates the full packet and next World before opening the Display gate. It applies every command, seals the exact
cursor, then publishes pointers and generates ACK. Resource loading, observers, RAF and draw are outside the barrier. A command
failure invalidates the projection, emits no ACK and requires a fresh checkpoint/session.

## Sessions and retention

Sessions have bounded in-flight commits, pending bytes, input count and ACK timeout. Packet bodies are encoded once and shared.
Checkpoints and commits occupy one global count/byte ring; eviction closes only lagging sessions, so slow clients never block
simulation or recorder append.

Input IDs are idempotent within a bounded session ledger. An identical completed request replays its exact result; a changed
request never executes twice; conflicting bytes close that session. Disconnect or same-ID replacement removes queued input from
the old session before a new baseline is installed.
