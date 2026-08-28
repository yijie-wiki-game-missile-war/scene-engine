# JavaScript DisplayRuntime formal acceptance evidence


> **历史验收证据：** 本目录保存旧发布组合的正式测量，不代表当前 0.9/0.10/0.4/0.9.3 组合已经由这些文件验收。

`js-display-runtime-500-formal.json` and `js-client-ack-500-formal.json` are generated,
not hand-authored. Reproduce both from the Scene Engine repository with the cutover
runbook commands:

```bash
node scripts/benchmark_display_runtime_500.mjs
node scripts/benchmark_client_ack_500.mjs
```

Both scripts restart themselves with explicit GC when necessary and write their formal
evidence files at the paths above.

The formal run commits 600 validation ticks followed by a 36,000-tick logical soak. Every
tick is committed individually at the 60 Hz authority cursor and contains 40 real
single-target AuthorityPort operations. No timing sample is excluded.

The fixture contains 500 `py/` authority roots (250 `initial`, 250 `live`), exactly 1,000
prefab-local Nodes, 501 real Three bindings, one 500-instance batch, and 20 scheduled
BehaviourComponents. It uses the production DisplayRuntime and ThreeRenderBackend code.
The injected renderer replaces only the unavailable Node WebGL context; Three objects,
bindings, batching, matrices, ResourceManager leases, scheduling, and disposal remain the
real implementations.

The evidence records command apply, transform flush, complete RenderSystem prepare,
backend prepare, total CPU before draw, command payload size, forced-GC memory checkpoints,
NodeIndex lookup diagnostics, a separately tracked correctness hash, cardinalities, and
the final disposal baseline. Formal status is `READY` only when every gate passes.

For a short development check that does not qualify as formal evidence:

```bash
node --expose-gc scripts/benchmark_display_runtime_500.mjs --quick
```
