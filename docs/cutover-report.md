# Three Render Runtime 0.8 cutover report

Final evidence frozen at 2026-08-24 14:59:52 CST (+0800).

## Frozen target

The atomic tuple is:

```text
scene-engine Python runtime                 0.6.0
@scene-engine/client                        0.6.0
@scene-engine/renderer-three                0.8.0
renderer artifact                           dist/scene-engine-renderer-three-0.8.0.tgz
runtime schema                              scene-engine-three-render-runtime@2
resource catalog schema                     scene-engine-render-resource-catalog@2
composition schema                          scene-engine-render-composition@2
snapshot schema                             scene-engine-render-snapshot@2
batch schema                                scene-engine-render-batch@2
pipelines                                   model@2, sprite@2, surface@2,
                                            particle@2, scene-pass@2
```

The Python runtime, JavaScript client, wire, WorldState, sole SceneTree, 60 Hz tick ownership, packet log and Replay packet
format are unchanged. Renderer 0.8 has no pre-V2 schema parser, package alias, feature flag, adapter or dual path.

The Runtime is the only production Three host. It owns the perspective camera, pure-data pan/zoom controls, resources,
projection roots, ResizeObserver and sole RAF. It validates node-composition and scene-layer scope before mutation. Materials
use explicit `alphaMode` and source-material multiplication. Surface is limited to standard/water; scene pass is limited to
background/lights. There is no hidden default light and no RenderTarget.

Recovery always uses the latest view and a newly compiled complete snapshot. `render-draw-failed` additionally retires the
tainted owned WebGLRenderer and creates a new one on the same canvas after releasing the failed projection; controls, sample,
batch and diagnostics failures rebuild the projection without replacing the renderer. Health returns to healthy only after
the idle/resource barrier succeeds.

Arts retains business interpretation, UI-local display state, immutable resource declarations and pure-data composition.
UI-local changes use `sceneLayers: null`. Review Three code is reachable only from explicit `./review` imports and is neither
imported by Live/Replay nor used as a production fallback.

## Final source and artifact tuple

The tested trees were intentionally uncommitted. Base commits are not mislabeled as cutover commits; the exact identity is
base commit plus tracked binary diff plus the untracked manifest in
[the source-identity record](evidence/render-runtime-v2/source-identity.md).

| Item | Final identity |
| --- | --- |
| date/time/timezone | `2026-08-24 14:59:52 CST (+0800)` |
| Scene Engine tested source | base `711b6dc3af9f1ca9b16e46f336fc54734a804907` + tracked diff `97ca8633e97b940d16cd433d9071101bf4890f818f667c9e10414f00f5265e76` + untracked manifest `1e5cf2d4c4d79cbc3e8b164bb3be0d7417303dcebc8e3ce8e63169442fd33353` (13 files) |
| Arts tested source | base `67b4ba6aae421740a1031153e8fc2063ff7c953c` + tracked diff `cac95e3b3a10392fd67fe2aa45b7e5841d823009774e03219899880cbb41601b` + untracked manifest `3c4e7299297510d1173827a92f3b7d6089dd2f9597b68e71ffba193a2a307d32` (118 files) |
| Replay tested commit | `001f0109101a3410905aaec1d04009a7a5924a45` |
| toolchain | Node `24.14.0`; npm `11.9.0`; uv `0.12.5`; Python `3.12.14` |
| browser / Three.js | Google Chrome `151.0.7922.172`; Three.js `0.181.2` |
| renderer artifact SHA-256 | `b51dc2d7ef4c7ed234de56335896b6577254506fcc58d3ef0c7f4b3923796d28` |
| renderer artifact integrity | `sha512-7IU6U83u8Xu7x6xMTR/iycIoMKn3jmHxjANpbgmYGS95zvpbJSW+H9UU9JB88IQzG+Ke91dA2S3u21LOuMj5pQ==` |
| Scene Engine `package-lock.json` SHA-256 | `9ca8b758fee1cf9afaf6e17b081cf4a543090ecef4ae911cd876fa4a9bfd22d6` |
| Arts `package-lock.json` SHA-256 | `a2e0cd17db8d72cf200800b5d1833eb4724126963dec995a5b0314d159a5da5f` |
| Arts production build SHA-256 | `91750dfc64cca3ab6f05e6ee75eb621abee48f1c0617744fe40eaf6b5dfa019d` |
| rollback tuple | Engine `711b6dc3af9f1ca9b16e46f336fc54734a804907` + Arts `67b4ba6aae421740a1031153e8fc2063ff7c953c` + Replay `001f0109101a3410905aaec1d04009a7a5924a45`; mixed rollback is forbidden |

`scene-engine/dist/scene-engine-renderer-three-0.8.0.tgz` and
`arts/vendor/scene-engine-renderer-three-0.8.0.tgz` are byte-identical. The final source hashes exclude only the two reports
filled from this evidence after testing, generated builds, tarballs, evidence output and `.DS_Store` as documented by the
source-identity record.

## Final automated evidence

| Gate | Exact command and final result |
| --- | --- |
| Scene Engine clean dependency install | `npm ci --ignore-scripts` — exit 0; audit found 0 vulnerabilities |
| JavaScript client | `npm test` (client workspace) — 16/16 passed |
| renderer V2 unit/runtime/real-Three adapter | `npm test` (renderer workspace) — 59/59 passed |
| Scene Engine Python | `uv run --with pytest python -m pytest -o addopts=''` — 60/60 passed |
| Python bytecode validation | `uv run python -m compileall -q src tests scripts` — exit 0 |
| strict cutover verifier | `uv run python scripts/verify_cutover.py` — exit 0 |
| Arts clean dependency install | `npm ci --ignore-scripts` in `arts/` — exit 0; audit found 0 vulnerabilities |
| Arts full check | `npm run check` in `arts/` — exit 0 |
| Arts production build | `npm run build` in `arts/` — exit 0; Web3D build transformed 674 modules |
| Web3D production check | `npm run check --workspace @missile-war-art/web3d` — exit 0; 18 scenes, 12 owners, 21 visuals; 5,000 ordered controller commits with one ACK each; 5/5 health tests; runtime projection 253 files / 23 bundles / 18 scenes |
| Web3D review check | `npm run check:review --workspace @missile-war-art/web3d` — exit 0; 7 review definitions and 14 fixture scenes |
| V2 composition inventory | `node web3d/scripts/checkSceneEngineRenderContractsV2.mjs` — exit 0; 18 descriptors, 15 render owners, 42 object compositions, 15 scene layers, 82 total layers and 80 resources |
| Arts architecture | `node scripts/check-display-architecture.mjs` — exit 0; 22 code/resource pairs, 18 scenes and 1 state owner |
| Replay regression | `npm test` in `replay/` — 23/23 passed |

## Final 500-node and lifecycle evidence

The real-Three `acceptance-v2.test.mjs` case passed within the 59-test renderer run:

- fixed mix: 200 sprite/card + 150 model + 100 terrain/model + 50 particle;
- 50 dirty instance slots and 25 material/UI-dirty nodes checked;
- three ordered commits retained transient create/remove/reparent lifecycle;
- 100 formal create/remove/rebuild rounds passed; the emitted full rebuild count was 101 including initial recovery;
- one Runtime, Renderer, Scene, camera and RAF; maximum RAF count was 1;
- pending jobs returned to zero, resources did not resurrect, and idempotent final disposal reported 510 disposed resources
  with no live handle, listener, observer or RAF.

The non-gating quick diagnostics also passed:

| Diagnostic | Command | p50 / p95 |
| --- | --- | --- |
| Python steady | `uv run python scripts/benchmark_scene_500.py --quick` | 3.539166 / 4.307598 ms |
| Python motion | same run | 3.113313 / 3.369944 ms |
| Python churn-25 | same run | 3.270312 / 3.658579 ms |
| JavaScript client steady | `node js/packages/client/scripts/benchmark-500.mjs --quick` | 1.204375 / 1.956292 ms |
| JavaScript client motion | same run | 1.154208 / 1.858208 ms |
| JavaScript client churn-25 | same run | 0.955042 / 1.524417 ms |

Both quick benchmark commands exited 0. Timings are diagnostic; lifecycle, matrices and bounded ownership are the release
conditions.

## Final browser, Live and Replay evidence

The final complete-media Live run used the tested vendor artifact and installed Chrome. The primary machine-readable record
is [`final-live-runtime-b51dc2d7.json`](../../arts/docs/evidence/render-runtime-v2/final-live-runtime-b51dc2d7.json)
(SHA-256 `dd7219c645391326ee7a448c481489e7f7a6a16f9fbcf9e0b1d42537b8896882`). Screenshots are
[main](../../arts/docs/evidence/render-runtime-v2/final-live-main-b51dc2d7.png)
(`11c4ff12a05364d138b28fef467222c44babdc823fef7be69002041eb5c2b976`),
[zoom](../../arts/docs/evidence/render-runtime-v2/final-live-zoom-b51dc2d7.png)
(`8383e2c4429e4dbc6863e2e865c9d8085ad5b98175743928b76eab64049b3bac`), and
[pan](../../arts/docs/evidence/render-runtime-v2/final-live-pan-b51dc2d7.png)
(`2484fae373d4c97e65187c7d9bf536f2811f618d1739506b7b914e427e593446`).

Observed Live facts:

- 648 presentation nodes = 16 dynamic + 632 static;
- 1,895 object layers, 15 scene layers, 84 batches, 54 resources, 0 pending jobs, 1 RAF, 6 listeners and 1 observer;
- commit sequence 1800 through 1929 was consecutive for 130 commits; packet delta and ACK delta were both 151;
- all 102 media dependencies loaded: 82 images and 20 GLBs;
- console errors, warnings, page errors, HTTP errors and non-abort request failures were all zero;
- 42 AbortController cancellations were expected loader cancellation events and were recorded separately, not counted as
  request failures.

The run exercised complete media, explicit alpha, source GLTF materials, water, singleton background/lights, perspective
pan/zoom and the absence of a RenderTarget.

Replay control evidence is
[`replay-500-control-smoke.json`](../../arts/docs/evidence/render-runtime-v2/replay-500-control-smoke.json)
(SHA-256 `75b9d1e4aa81ae601294d93632b6d7a7e0becee11086943d837e520effb4c94d`) with the
[seek-to-600 screenshot](../../arts/docs/evidence/render-runtime-v2/replay-500-control-seek-600.png)
(`155dc3679a70e8f951000dc23bc5d94e886eed7fbd625bbf793ac22dad4c4b33`). It observed 500 dynamic /
1,132 total nodes, a paused tick-0 checkpoint, 1x advance through tick 12, pause stable at tick 13 across two samples, and a
fresh Replay WebSocket seek to tick/commit 600. Console warnings and errors were zero.

The installed-Chrome draw-fault soak is
[`replay-500-webgl-rebuild-soak.json`](../../arts/docs/evidence/render-runtime-v2/replay-500-webgl-rebuild-soak.json)
(`cab793dbd0eba06624e786f6067ee77a0d2b8d6fac59ddea49feb6fb9bd9cb8e`) with
[PNG evidence](../../arts/docs/evidence/render-runtime-v2/replay-500-webgl-rebuild-soak.png)
(`a4a602d9a021ae0f918464bc00b32b5a11feb2c9a6952083e2e398e761cbdd54`). Three warmups plus 20
formal cycles produced 23/23 injected draw faults and 23/23 automatic rebuilds. Every stable sample returned to 38 textures,
564 geometries, 54 resources, zero pending jobs, 6 listeners, 1 observer and 1 RAF; console, page and request errors were
zero. The isolated Three root-cause record is
[`webgl-clear-fault-root-cause.json`](../../arts/docs/evidence/render-runtime-v2/webgl-clear-fault-root-cause.json)
(`36ab4820ce64d0454c2564695b3151343fa6a749d1f2590392ae88ac774842a5`).

## Physical deletion audit

The strict verifier and architecture gates confirmed:

- exactly one renderer artifact in Scene Engine `dist` and one byte-identical Arts vendor artifact, both 0.8.0;
- no obsolete renderer 0.6/0.7 artifact or current render schema/pipeline `@1` identity;
- zero production RuntimeHandle export and zero direct Three edge reachable from Live/Replay;
- 18 feature-owner package-level explicit `./review` exports (17 visual owners plus HUD), plus the display-sdk review-helper export;
- coast-cliff and reef have empty production runtime records; their fixed compositions exist only under `./review`;
- obsolete Three backends, the retired renderer-reconciler implementations and production compatibility paths are physically absent;
- current production composition uses only the five V2 pipelines with explicit alpha, no hidden light and no RenderTarget.

## Release decision

Release decision: READY
Known issues: zero
