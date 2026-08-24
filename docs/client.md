# JavaScript client and renderer

`@scene-engine/client@0.6.0` exports exactly `SceneEngineClient`, `SceneEngineClientError`, `encodeEngineInput`,
`encodeEngineAck`, `readEnginePacket`, `readPacketLog`, and `DEFAULT_ENGINE_LIMITS`.

```js
const engine = new SceneEngineClient({
  limits,
  onCommit({ kind, commit, view, plan, events }) {},
});
```

There is no subscription state machine. The optional constructor observer runs in a protected microtask after the synchronous
barrier. Its payload kind is `checkpoint|commit`; checkpoint plan kind is `bootstrap`, a framed commit plan kind is `frame`,
and a same-tick input commit with no visual change has `plan === null`. `events` is the frozen `SceneEvent[]` decoded from the
optional scene frame; there is no independent product-event attachment. Observer exceptions are isolated.

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

`@scene-engine/renderer-three@0.8.0` exports the closed `ThreeRenderRuntime` surface documented in
[`render-runtime.md`](render-runtime.md). It owns Three.js, WebGLRenderer, Scene, PerspectiveCamera, controls, root, the sole render RAF,
fixed technical pipelines, and renderer resources. It consumes ordered `{plan, view}` plus product pure-data snapshot/batch
records, creates anchors before parent linking, and can rebuild only from the current view plus a freshly compiled full
render snapshot. A `render-draw-failed` recovery may internally replace the owned WebGLRenderer on the same canvas after
releasing the failed projection; other health failures rebuild without replacing it. Neither path exports Three objects or
calls product visual factories.

The client contract did not change for renderer 0.8. In particular, a visually unchanged same-tick input commit still
reports `plan === null` while its new `commit.sourceTick` remains authoritative. The product sends an empty visual batch at
that exact cursor; the renderer advances simulation-clock sampling without inventing a frame plan. UI-local composition
changes use the already installed cursor and likewise do not mutate client state or advance Engine time.
