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

The experimental `0.4.0-worldstate-test.1` candidate adds
`prepareCommit({aggregateCandidate, engineCommit, frames})`. The aggregate is
opaque JSON that must already have been validated by the product adapter;
display-core validates only its generic identity, immutability, resource
limits, commit ordering, and correlation with frame ticks. It never interprets
Missile War fields or codecs.

`prepareCommit(...)` returns the exact prepared-token surface
`{aggregate, engineCommit, steps, assertCommittable, commitValidated, abort}`.
After validation, `commitValidated()` performs only the final aggregate and
tree pointer swaps plus Engine counters. It never invokes the capture observer
and never queues a microtask. The initial checkpoint, every tick-advancing
commit, and every generation checkpoint require a non-empty frame batch;
additional publications of the installed commit and same-tick data-only
commits may use an empty batch.

`prepareFrames(nonEmptyFrames)` remains a presentation-only compatibility path
for isolated package fixtures. Product integration should use `prepareCommit`
so data and presentation cross one synchronous barrier.

A product coordinator first completes every jointly-owned business/tree/cursor
pointer swap, then calls `schedulePostCommitCapture()`. That method only queues
a coalesced protected microtask; a throwing observer or disposal before the
microtask runs cannot alter or roll back committed state.
