# JavaScript client 0.8

`@scene-engine/client@0.8.0` exports:

```text
SceneEngineClient
SceneEngineClientError
DEFAULT_ENGINE_LIMITS
encodeEngineInput
encodeEngineAck
readEnginePacket
readPacketLog
```

The constructor requires a synchronous `createDisplaySession(metadata)` function. A session has exactly these fields, with no
optional or extra fields:

```text
runtime
authorityPort create/set/reparent/state/replace/remove methods
commitGate begin / seal / fail
dispose
```

`runtime` must synchronously provide `installScene`, `activate`, `start`, `summary` and `currentView`. Promise-returning session
factories, runtime methods, authority operations, commit-gate operations, summaries or current views fail closed.

Checkpoint processing builds a complete World candidate, validates the Display baseline and catalog identities, creates a
fresh candidate session, installs `sceneName`, applies every authority root parent-first, activates the exact cursor and starts
the runtime. It then obtains an O(1) summary, encodes ACK, atomically swaps the session/World/cursors, disposes the previous
session, and queues the observer. Any pre-swap failure completely disposes the candidate and leaves the previous session
active.

Commit processing first validates the entire command stream and World patch. It then opens the exact cursor gate, invokes one
AuthorityPort method per command, seals the cursor, publishes the WorldState and cursors, reads `runtime.summary()`, and encodes
the cumulative ACK. A command failure calls `gate.fail`, publishes no ACK, and leaves the projection invalid. Resource
completion, full-tree snapshots, HUD, drawing and observers are outside this synchronous barrier.

The `onCommit` payload is a frozen record with exactly:

```js
{
  kind,                 // 'checkpoint' | 'commit'
  commit,
  worldState,
  displaySummary,
}
```

The observer is queued with `queueMicrotask` only after the commit has succeeded and its ACK bytes exist. `applyPacket()`
returns those ACK bytes synchronously; the observer cannot delay, withhold or roll back them, and an observer exception does
not change the installed state.

`displaySummary` uses `scene-engine-display-summary@1` and is O(1): scene name, runtime revision, cursor, `NodeIndex.size` and
health only. A full immutable DisplayView is produced only by explicit `client.currentDisplayView()`. `client.capture()` is an
explicit complete snapshot and includes a DisplayView; neither operation is called for normal checkpoint/commit observation.

The client has no product Node graph or transform cache. Replay feeds the same exact packet bytes through the same client and
AuthorityPort path.
