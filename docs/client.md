# JavaScript client and renderer

`@scene-engine/client@0.5.0` exports exactly `SceneEngineClient`, `SceneEngineClientError`, `encodeEngineInput`,
`encodeEngineAck`, `readEnginePacket`, `readPacketLog`, and `DEFAULT_ENGINE_LIMITS`.

```js
const engine = new SceneEngineClient({
  limits,
  onCommit({ kind, commit, view, plan, events }) {},
});
```

There is no subscription state machine. The optional constructor observer runs in a protected microtask after the synchronous
barrier. Its payload kind is `checkpoint|commit`; checkpoint plan kind is `bootstrap`, a framed commit plan kind is `frame`,
and a same-tick input commit with no visual change has `plan === null`. Events are frozen
`{product: attachmentValueOrNull, scene: SceneEvent[]}`. Observer exceptions are isolated.

`applyPacket(raw)` returns `{kind, commit, ackPacket, inputResult}`. Checkpoint/commit return a non-null ACK and null input
result. An input result returns null ACK and `{inputId,status,reasonCode,result}` without changing the cursor or firing the
observer. The frozen camel-case commit is:

```js
{
  kind: 'checkpoint' | 'commit',
  streamId, commitSeq, sourceTick, worldRevision,
  cause, causationId,
}
```

Checkpoint cause/causation are null. The first state packet must be a checkpoint. A commit must be same-stream, exactly next
commit/revision, and obey cause/tick progression. An equal-cursor checkpoint is rejected; a higher same-stream checkpoint may
atomically replace local state. Failure leaves world, tree, and cursor pointers unchanged and marks the client failed.

Public methods are `applyPacket`, `currentWorldState`, `currentCommit`, `currentView`, `getNode`, `getWorldPose`,
`getInteraction`, `getProfile`, `encodeInput`, `capture`, and `dispose`. `encodeInput` fills the current observed cursor.
Profiles/interactions are `null | {typeId,flags,bytes}`. The view exposes node counts/lookups plus read-only
`sceneMetadataAt/getSceneMetadata`, `visualTypeAt`, and `animationStateAt` registries.

`@scene-engine/renderer-three@0.5.0` exports `THREE_SCENE_BACKEND_SCHEMA`, `ThreeSceneBackend`,
`ThreeSceneBackendError`, and `createThreeSceneBackend`. It consumes only `{plan, view}`, creates all anchors before parent
linking (so ID order need not be parent-first), owns only renderer handles/resources, and can rebuild from `currentView()`.
