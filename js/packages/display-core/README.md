# `@scene-engine/display-core`

This package exposes the single public `SceneDisplayEngine` facade. Its
`PresentationSceneTree`, dense stores, scene views and prepared candidates are
internal implementation details.

Construct the Engine with only these exact options:

```js
new SceneDisplayEngine({
  captureHook: null,
  limits: {
    maximumFramesPerBatch: 8,
    maximumNodes: 10_000,
    maximumTreeDepth: 64,
  },
});
```

Unknown option or limit names fail closed. In particular,
`maximumFramesPerCorrelation` is not a compatibility alias.

`prepareFrames(nonEmptyFrames)` returns the exact prepared-token surface
`{steps, assertCommittable, commitValidated, abort}`. After validation,
`commitValidated()` performs only the final tree pointer swap and Engine
counters. It never invokes the capture observer and never queues a microtask.

A product coordinator first completes every jointly-owned business/tree/cursor
pointer swap, then calls `schedulePostCommitCapture()`. That method only queues
a coalesced protected microtask; a throwing observer or disposal before the
microtask runs cannot alter or roll back committed state.
