# JavaScript Client 0.14

`@scene-engine/client@0.14.0` is the only browser packet decoder, immutable WorldState owner, cumulative ACK barrier and Display
session bridge. Its root exports:

```text
SceneEngineClient
SceneEngineClientError
DEFAULT_ENGINE_LIMITS
encodeEngineInput
encodeEngineAck
readEnginePacket
readPacketLog
```

The package also publishes `src/index.d.ts`.

## Session contract

The constructor requires synchronous `createDisplaySession(metadata)`. The returned object must contain:

```text
runtime
  catalogIdentity / installScene / activate / start / summary / currentView
authorityPort
  installNodeMatrixPool / applyNodeTransformBatch
  createNode / setNodeTransforms / setNodeParent / setNodeVisible / setNodeState / replaceNodePrefab / removeNode
commitGate
  begin / seal / fail
dispose
```

A product wrapper may contain extra fields. Client validates the required capabilities, extracts only these four fields into its
own frozen session wrapper and ignores the extras. A missing required field fails closed.

The transaction barrier is synchronous. `createDisplaySession`, `catalogIdentity`, `installScene`, `activate`, `start`, every
Authority operation, `commitGate.begin`, `commitGate.seal`, `summary`, and `currentView` must return directly; a Promise from any
of them fails closed. Cleanup is deliberately different: `dispose` and error-path `commitGate.fail` may return a Promise, but the
Client observes it only to suppress an unhandled rejection and never waits for it before replacement, failure propagation, or
ACK handling.

`applyPacket` runs to completion. Reentry from a synchronous acceptance callback is rejected, poisons the Client and emits no ACK.
Reentry attempted by the previous session's post-swap `dispose` cleanup is also rejected, but cleanup cannot roll back or poison the
already completed replacement.

## Checkpoint

Checkpoint processing:

1. validates the packet, World snapshot, numeric IDs and parent-first binary Display metadata, including every active float32
   matrix row; for a later checkpoint in the same stream it also rejects pool shrinkage or resurrection of any historical
   tombstone ID;
2. creates a fresh candidate session;
3. reads `runtime.catalogIdentity()` and compares all three SHA-256 values with the checkpoint;
4. installs `sceneName` only after identity matches;
5. transfers the one owned full matrix tensor, then creates every authority root parent-first by ID;
6. activates the exact cursor and starts the runtime;
7. reads O(1) summary and builds ACK bytes;
8. atomically swaps session, WorldState and cursors;
9. disposes the previous session and queues the observer.

Any pre-swap failure disposes the candidate and leaves the previous active session untouched. A catalog mismatch therefore
cannot partially install the wrong Scene.

## Commit

Commit processing validates the complete command stream and next immutable World before it opens the Display gate. Pool size
cannot shrink; every newly allocated suffix ID must have a dirty row and create command, so a small packet cannot request an
unrelated large resident allocation. The SDCS codec also rejects more than `65,536` commands per payload before constructing
the command list; the fixed protocol bound is deliberately not configurable through `EngineLimits`. It then:

```text
commitGate.begin(cursor)
  -> one applyNodeTransformBatch call to stage the sorted dirty IDs and contiguous matrix tensor
  -> ordered AuthorityPort calls; one setNodeTransforms consumes the existing-row ID prefix atomically, while create consumes suffix rows
commitGate.seal(cursor)
  -> publish WorldState and cursors
  -> runtime.summary()
  -> encode cumulative ACK
  -> queue onCommit microtask
```

A command failure calls `commitGate.fail`, emits no ACK and leaves the projection invalid. The Client never performs local repair;
recovery requires a fresh checkpoint/session.

ACK means WorldState, all synchronous Authority operations and the cursor were accepted. It does not wait for resources,
DisplayView construction, HUD, observers, RAF or draw.

## Observation and explicit queries

`onCommit` receives a frozen record:

```js
{
  kind,                 // 'checkpoint' | 'commit'
  commit,
  worldState,
  displaySummary,
}
```

It is queued only after ACK bytes exist. Observer failure cannot delay, withhold or roll back the commit.

Use:

- `currentWorldState()` and `currentCommit()` for current pointers;
- `currentDisplayView()` only for explicit full-tree picking, focus, diagnosis or tests;
- `capture()` for an explicit complete snapshot;
- `encodeInput(...)` so input carries the current observed stream and commit.

Replay feeds exact recorded Engine packet bytes through the same `applyPacket` and AuthorityPort path. The Client owns no second
Node graph or Transform cache.

The Client reads a checkpoint `(n,4,4)` tensor or commit `(m,4,4)` dirty tensor into exactly one owned Float32Array and is the
first semantic acceptance gate for Python's opaque float32 payload. It validates each active/dirty row's finite
affine/right-handed contract, canonicalizes negative zero, and transfers the tensor to Authority without TRS decomposition.
Packet storage is never aliased: mutating or releasing the input packet after `applyPacket` cannot alter the installed matrix
pool. A commit transfers one pool batch; create/set-transform-batch consumes rows by ID without placing matrix bytes back in command
objects, so command-observable order remains unchanged.
