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
    display_matrix_pool: DisplayMatrixPool,
    display_nodes: tuple[DisplayNode, ...],
)

ProductCommit(
    world_codec: str,
    world_patch: Mapping[str, Any],
    display_matrix_pool: DisplayMatrixPool,
    display_commands: tuple[DisplayCommand, ...] = (),
)
```

The display identity is loaded from the JSON artifact produced by the JavaScript catalog build:

```python
identity = DisplayCatalogIdentity.from_record(record)
```

One `DisplayMatrixPool` is resident for the whole stream. `append(transform)` allocates the next stable authority `node_id`;
`set(node_id, transform)` changes one row, `set_batch(node_ids, matrices)` validates then writes an aligned NumPy batch, and
`retire(node_id)` writes an all-positive-zero tombstone that is
never reused in the same stream. The same pool object must be supplied by every checkpoint and commit. Its NumPy backing tensor
has shape `(n,4,4)`, dtype `<f4`, and axes `[node,column,row]`, making every row the exact contiguous column-major wire matrix.
After the initial checkpoint, append/create and retire/remove are paired publication transitions: a new ID cannot be mutated as
an existing Node, a live ID cannot be removed before its row is retired, and an unpublished ID cannot be retired. Dirty IDs are
tracked directly, so sealing a sparse `m`-row update does not scan the full `n`-row pool.

`set_batch` preserves the caller's ID/row alignment even when IDs are not ordered. `set_transform_batch` owns a sorted,
read-only `<u4` copy of those IDs; sealing uses that vector to gather the corresponding pool rows once into the aligned
read-only `(m,4,4)` tensor. It does not construct, serialize or confirm one command per row.

Checkpoint nodes are complete parent-first authority roots. Product code supplies stable `node_id`/`parent_id`, exact
registered `prefab_id`, transform mode, visibility and complete authority state; the Node obtains its local Matrix4 from the
pool row with the same ID. The browser Client remains the first matrix-semantic acceptance gate.
After checkpoint it publishes one vector-targeted Transform command plus single-target structural/state commands through named
constructors:

```python
DisplayCommand.create_node(node)
DisplayCommand.set_transform_batch(node_ids)
DisplayCommand.set_parent(node_id, parent_id)
DisplayCommand.set_visible(node_id, visible)
DisplayCommand.set_state(node_id, complete_state)
DisplayCommand.replace_prefab(node_id, prefab_id, complete_state)
DisplayCommand.remove(node_id)
```

Generic `DisplayCommand(kind=..., **fields)` construction is intentionally unavailable. Engine owns `command_seq`,
`source_tick`, stream/commit/revision and encoded bytes.

Every scalar command target and every Transform-batch ID is a checked `uint32` pool row. A commit has at most one non-empty
Transform batch; it occupies one `command_seq` regardless of row count. Its sorted existing-row IDs plus create targets must
correspond exactly to the sorted dirty IDs and aligned `(m,4,4)` tensor. Missing/extra dirty rows, overlap with create targets,
a second batch, a retired target for any non-remove command, a second removal, or a parent outside the active set
fails before publication. Successful packet encode
clears only the rows captured by that packet; an encoding failure does not silently lose dirty state.

## Nested Prefab projection

Nested Prefabs are entirely inside `@scene-engine/display@0.13.0` and Prefab definition schema
`scene-engine-prefab-definition@4`. They do not change `scene-engine-wire@3`, `scene-engine-display-node@7`,
`scene-engine-packet-log@3`, checkpoint records, Display commands or ACK cursors.

Python still creates and controls only the outer `py/` authority root. `set_state` sends one complete outer state. Display calls
the registered synchronous resolvers, recursively derives fixed-child overrides and every dynamic slot's complete desired set,
and materializes the result as ordinary Nodes/Components in its one NodeIndex and NodeGraph. Definition-owned children do not
become independently addressable authority nodes or new runtime Prefab objects.

This resolution and diff is part of the synchronous command barrier. Retaining the same slot key, instance key and `prefabId`
preserves Node/Component identity; missing instances are removed, new instances are added and a changed `prefabId` is replaced.
An invalid nested candidate fails the Display operation, produces no ACK and requires the normal fresh-checkpoint/session
recovery if the projection becomes invalid. Resource readiness, animation sampling and rendering remain outside ACK.

Animation players use private Prefab materialization Scope identity to resolve `$root` and local targets. Canonical name prefixes
do not define animation ownership. Visual animation still samples only per-player `visualSeconds`; nested composition does not
introduce another clock or any Python/Replay animation state.

## Transaction order

A tick transaction is:

1. reserve proposed counters;
2. write proposed tick into the borrowed World;
3. call `step` and require `changed`;
4. write proposed revision;
5. call `build_commit` with the mutation's `commit_context`;
6. validate the World patch, matrix-pool lifecycle and every ID-targeted Display command;
7. assign command sequence;
8. encode/record once and publish shared immutable bytes;
9. expose the committed counters.

Any uncaught mutation, build, validation, encoding or recorder error is fatal. The runtime does not retry the same tick against a
possibly partially mutated World.

Inputs are decoded, bounded and queued per client, then serialized on the runtime thread. `rejected` and `no-op` leave counters
unchanged. `changed` keeps tick fixed, increments revision/commit once and records the input ID as causation.

`start()` always builds and validates a checkpoint, even without clients or a recorder. Scene name, World codec, Display codec
and catalog identities are frozen for one stream. Later checkpoints must match them and are read-only with respect to the
resident matrix pool. Runtime checks the pool generation so a new-client or periodic checkpoint cannot consume a change that
existing clients have not received through a commit.

## Client barrier and ACK

Every connection receives a checkpoint before commits. A commit carries a World patch and a Display command-stream attachment,
even when its command list and dirty matrix batch are empty. Commands preserve strict stream-global `command_seq` order; moving
matrix bytes into the aligned batch does not reorder their logical commands.

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
