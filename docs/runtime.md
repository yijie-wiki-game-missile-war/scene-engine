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
pool row with the same ID. The browser Client remains the first matrix-semantic validation gate.
After checkpoint it publishes one vector-targeted Transform command plus single-target structural/state commands through named
constructors:

```python
DisplayCommand.create_node(node)
DisplayCommand.set_transform_batch(node_ids)
DisplayCommand.set_parent(node_id, parent_id)
DisplayCommand.set_visible(node_id, visible)
DisplayCommand.set_state(node_id, complete_state)
DisplayCommand.set_property(node_id, property_name, value)
DisplayCommand.unset_property(node_id, property_name)
DisplayCommand.emit_event(node_id, event_name, payload={})
DisplayCommand.replace_prefab(node_id, prefab_id, complete_state)
DisplayCommand.remove(node_id)
```

Generic `DisplayCommand(kind=..., **fields)` construction is intentionally unavailable. Engine owns `command_seq`,
`source_tick`, stream/commit/revision and encoded bytes.

`set_property` and `unset_property` address one top-level member of the complete authority state. They are ordered delta
publication conveniences, not a second state owner: product code must mutate its canonical World/state model so any later
checkpoint contains the same complete result. `set_property(..., None)` writes JSON `null`; only `unset_property` removes the
member. A dot in `property_name` is a literal character and never means a nested path. Use `set_state` for an atomic candidate
that changes several mutually dependent fields. Product-wide projected data such as coins or score can use a dedicated
authority Node/Prefab; it follows the same property and checkpoint rules and does not require a second global-data channel.

`emit_event` publishes one transient JSON-object payload. It occupies one command sequence and shares exact FIFO order with
Transform, reparent and properties, but it never enters a checkpoint. A linear Replay therefore dispatches it again from the
recorded commit; seeking to a later checkpoint does not synthesize it. Facts that must survive reconnect/seek belong in state,
optionally with a logical start tick, rather than only in an event.

Every scalar command target and every Transform-batch ID is a checked `uint32` pool row. A commit has at most one non-empty
Transform batch; it occupies one `command_seq` regardless of row count. Its sorted existing-row IDs plus create targets must
correspond exactly to the sorted dirty IDs and aligned `(m,4,4)` tensor. Missing/extra dirty rows, overlap with create targets,
a second batch, a retired target for any non-remove command, a second removal, or a parent outside the active set
fails before publication. Successful packet encode
clears only the rows captured by that packet; an encoding failure does not silently lose dirty state.

## Nested Prefab projection

Nested Prefabs are entirely inside `@scene-engine/display@0.14.0` and Prefab definition schema
`scene-engine-prefab-definition@5`. Property/event commands use `scene-engine-display-node@8`; they do not add a Wire packet
kind, attachment, second event channel or packet-log schema.

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
8. encode/record once and publish shared immutable bytes to the bounded transport outbox;
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

One private `TransportSender` thread owns every call to `EngineTransport.send` and `EngineTransport.close`. The runtime thread
only submits already encoded immutable `bytes`; the worker never receives the World, `EngineProgram`, recorder,
`ClientSession`, `DisplayMatrixPool` or Runtime itself. Submission order is FIFO across clients. Per-session epochs cancel queued
packets after a disconnect and prevent a stale background result from removing another live session.

`client_id` is an opaque, hashable connection-lifetime key, not a player, account or reusable socket-map name. The transport
must keep it bound to the same physical endpoint until Engine's close call completes; a reconnect uses a fresh key. A duplicate
`client_connected` call for a live key closes and removes that session but does not install another baseline under the reused
key. This rule is what makes delayed worker calls safe on both Windows and Linux; an internal epoch cannot repair an adapter that
has already rebound the same key to a different socket.

The transport outbox is bounded independently by `RuntimeConfig.maximum_transport_pending_count`,
`maximum_transport_pending_bytes` and `maximum_transport_pending_control_count`; counts include an operation currently blocked
in the transport. The control limit must reserve at least one session-close and one rejected-connection-close slot per configured
client. A full send outbox rejects the submitting session without blocking simulation. If the reserved rejected-connection close
budget is already occupied, `client_connected` raises `RuntimeBusyError` and the network host remains responsible for closing
that not-admitted endpoint. A background send failure cancels later sends in that epoch but preserves an already accepted close,
and is reported through a thread-safe result inbox. The next serialized runtime boundary drops only the still-current matching
session. Session `last_sent`/in-flight cursors mean
accepted by this bounded outbox, not that an operating-system write has completed.

`stop()` seals recording first, submits a graceful close after each session's accepted packets, then drains and joins the worker
within `transport_shutdown_timeout_seconds`. Fatal shutdown first cancels session epochs and drains their close controls within
the same finite bound. A transport method already executing cannot be pre-empted; failure to join during normal stop makes the
runtime fatal instead of silently claiming a clean shutdown, while the daemon worker remains in draining state so a later
transport recovery can still deliver the accepted packets and close.

Input IDs are idempotent within a bounded session ledger. An identical completed request replays its exact result; a changed
request never executes twice; conflicting bytes close that session. Dropping a session removes all of its queued input before a
fresh connection-lifetime key may receive a baseline.
