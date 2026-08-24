# JavaScript client 0.7

`@scene-engine/client@0.7.0` exports:

```text
SceneEngineClient
SceneEngineClientError
DEFAULT_ENGINE_LIMITS
encodeEngineInput
encodeEngineAck
readEnginePacket
readPacketLog
```

The constructor requires a synchronous `createDisplaySession(metadata)` function. A session has exactly:

```text
runtime.installScene / activate / start
authorityPort create/set/reparent/state/replace/remove methods
commitGate begin / seal / fail
displayViewProvider
dispose
```

Checkpoint processing builds a complete World candidate, validates the Display baseline and catalog identities, creates a
fresh session, installs `sceneName`, applies every authority root parent-first, activates the exact cursor, obtains one
read-only DisplayView, starts the runtime, swaps state, and disposes the previous session. Any failure disposes the candidate
and makes the client fail closed.

Commit processing first validates the entire command stream and World patch. It then opens the exact cursor gate, invokes one
AuthorityPort method per command, seals the cursor, swaps the WorldState pointer, and creates the cumulative ACK. A command
failure calls `gate.fail`, publishes no ACK, and leaves the projection invalid. Resource completion, drawing and observers are
outside this synchronous barrier.

The client has no product Node graph or transform cache. Replay feeds the same exact packet bytes through the same client and
AuthorityPort path.
