# JavaScript Client 0.10

`@scene-engine/client@0.10.0` is the only browser packet decoder, immutable WorldState owner, cumulative ACK barrier and Display
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
  createNode / setNodeTransform / setNodeParent / setNodeVisible / setNodeState / replaceNodePrefab / removeNode
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

## Checkpoint

Checkpoint processing:

1. validates the packet, World snapshot and parent-first Display baseline;
2. creates a fresh candidate session;
3. reads `runtime.catalogIdentity()` and compares all three SHA-256 values with the checkpoint;
4. installs `sceneName` only after identity matches;
5. creates every authority root parent-first;
6. activates the exact cursor and starts the runtime;
7. reads O(1) summary and builds ACK bytes;
8. atomically swaps session, WorldState and cursors;
9. disposes the previous session and queues the observer.

Any pre-swap failure disposes the candidate and leaves the previous active session untouched. A catalog mismatch therefore
cannot partially install the wrong Scene.

## Commit

Commit processing validates the complete command stream and next immutable World before it opens the Display gate. It then:

```text
commitGate.begin(cursor)
  -> one AuthorityPort call per command
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
