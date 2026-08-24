# Python static/dynamic cutover report

Final Python-only evidence for 2026-08-24 (Asia/Shanghai).

## Release tuple and scope

```text
scene-engine Python                         scene-engine==0.6.1
scene-engine JavaScript client              0.6.0 (unchanged)
scene-engine wire                           scene-engine-wire@1 (unchanged)
scene codec                                 scene-engine-scene@1 (unchanged)
Missile War WorldState                      missile-war-world-state@2 (unchanged)
Python Game                                 0.6.1
vendor wheel SHA-256                        b4beab00d756ddba7b446e1169d521a0b3c7f98979f12d5def64525f00a74d63
```

The implementation changed only Scene Engine Python, Python Game and their
release evidence. The already-active `scene-engine/js/**` and Arts worktrees
were treated as frozen baselines; Replay was clean. No JavaScript package,
tgz, package lock, Arts file or Replay file was changed for this cutover.

Scene Engine changes are limited to `scene.py`, `runtime.py`, their tests and
benchmarks, Python package/version files, and Python release documentation.
Python Game changes are limited to `scene_projection.py`, tests and benchmark,
Python package/version/requirements/vendor files, and Python release evidence.

## Static/dynamic boundary

- `parse_scene_bootstrap()` performs the complete static duplicate-ID,
  missing-parent, cycle, maximum-depth, catalog and node-field validation once.
  Its immutable view caches static IDs/depths and visual/animation indexes;
  it does not compute static world poses.
- A normal frame validates only 500 dynamic nodes against those indexes. Formal
  probes report zero static-node iteration, zero static pose composition, zero
  static registry rebuild and zero cached-index source iteration per frame.
- Product static validation runs exactly once. Across the formal workload and
  the test covering 600 commits plus three later checkpoints, full static scans
  after bootstrap are zero. Later calls use only `map_id`, world geometry
  revision and coordinate-service geometry revision identity checks.
- A static identity change fails closed with
  `missile_war_scene_static_change_requires_new_stream` and requires a new
  runtime/stream.

## Checkpoint materialization

`start()` calls each expensive checkpoint layer exactly once: product
`build_checkpoint`, WorldState snapshot encode, scene bootstrap encode,
checkpoint frame encode and checkpoint wire encode. The first client adds zero
calls and reuses the retained start `PacketRef`.

After a new revision without a periodic recorder anchor, the first late client
materializes one checkpoint (`build/snapshot/frame/wire +1`; bootstrap encode
`+0` because its bytes are stream-frozen). The same-revision second client and
100 direct cache hits add zero calls in every layer, return the same `PacketRef`
and share the same raw `bytes`. Cache-hit latency was p50 `0.013979 ms`, p95
`0.014169 ms`, p99 `0.015584 ms`.

The periodic-recorder branch is separately exercised: the recorder-built
current-revision checkpoint is cached, so both later clients add zero calls.
Recorder and sessions consume the same immutable raw bytes. Late clients decode
and validate the snapshot, bootstrap registry, current canonical scene frame and
cursor before cumulative ACK; every backlog is zero after ACK.

The initial checkpoint remains `26,672,372` bytes, exactly the W0 baseline
(`0.0%` increase; allowed maximum `1%`).

## Byte and contract equivalence

Fixed seed `42` evidence is byte-identical to W0:

| Body | SHA-256 |
| --- | --- |
| full checkpoint packet | `854241ed6912112eb8641757313a6033ca4780106a742a98834b024b2c9192f6` |
| WorldState snapshot attachment | `70fb9cab0aaf6acc29246547e19e2a0aba483747421d1ff080daef75d5f094de` |
| product scene bootstrap | `4f70d431e8d140046daf84ffb2977fdf7820cfa8a874ce988e900bf326a81bf1` |
| product checkpoint frame | `7ea3571ad8866ff19a2e945ffe360f7892facfc4a0c26380c0e66a735891cc74` |
| commit packet 1 | `b7ee022cf7c4b51ffe39fd688dcf4f2123f81db7a813dc280c62c075b406eb2d` |
| commit packet 2 | `e921132a6b238fc38b61b882fbae30bbd7fcbfe8aaf422c3518512cdf0775558` |
| commit packet 3 | `129c812e90793dc70752632eabfbdfebdd4087af51fd539c950bfa7692595df6` |
| small fixed WorldState snapshot | `d1241c1560cef029e4bde1217d847a3a91c3241331fc1e2b6c784a8d7435f88c` |

The generic bootstrap/frame fixtures also retain SHA-256
`b0a188494c22508b400d43024a8b4a391eb7157e4ed48685c92cfba3be0e7370`,
`9681db27bf52362390a3d1c5f9c4954184c2d01118547309993cffdbff1229e2`
and `abacf13c1c163de2f7220d014041ffb2192cffa93659fd7e7478dd68cdd1c39c`.
Tests parse and independently re-encode them byte-for-byte. Frozen wire,
recording, session, JSON-tree, WorldState model, idle-wander, codec and journal
files are identical to W0. The full root fields and every
`PersonIdleWanderPlan` encoded field are asserted; there is no hidden `@2`
shape change.

## Formal 632 + 500 performance

Scene evidence: [python-static-dynamic-500.json](evidence/python-static-dynamic-500.json),
SHA-256 `aaae010b33bd29cbba1ef360d2aed6c28618df2d4d25cbfa64f6731a6818988b`.

| Workload | frame validate+encode p50 / p95 / p99 | frame+wire p50 / p95 / p99 |
| --- | --- | --- |
| steady | `2.143 / 2.180 / 2.217 ms` | `2.174 / 2.213 / 2.247 ms` |
| motion | `2.161 / 2.225 / 2.473 ms` | `2.193 / 2.259 / 2.509 ms` |
| churn-25 | `2.152 / 2.214 / 3.040 ms` | `2.184 / 2.256 / 3.127 ms` |

Product/runtime evidence:
[python-runtime-static-dynamic-500.json](../../python-game/docs/evidence/python-runtime-static-dynamic-500.json),
SHA-256 `272bd363e1747231f55393fa3d19f9488c2fe3a5bdae353c3de18084ee43c6ba`.

| Server metric | p50 / p95 / p99 | gate |
| --- | --- | --- |
| direct dynamic projection | `3.337 / 3.871 / 4.336 ms` | p95 <= 4, p99 <= 7 |
| publication after step | `8.303 / 9.050 / 19.306 ms` | p95 <= 14 |
| step + publication | `10.149 / 10.999 / 24.204 ms` | p95 <= 16.67 |
| real `SceneEngineRuntime.pump()` | `10.328 / 11.032 / 24.579 ms` | p95 <= 16.67 |

All formal time and structural gates passed. This is server-side 60 Hz
evidence; it is not a claim that the independently evolving Web display path
has completed end-to-end 60 Hz acceptance. The 3,600-commit soak preserved all
configured retention/session/transport bounds and exact tick ordering.

## Frozen consumers and regression evidence

W0-to-final content fingerprints are identical:

| Frozen scope | status SHA-256 | tracked diff SHA-256 | untracked-content SHA-256 |
| --- | --- | --- | --- |
| `scene-engine/js/**` | `a91cf0191411b5e0274f142959ef401512241da5267bcae6066b4f8883d7a915` | `7c9b328df4b6b977a80cb6ecdb4bfc0edaca23c6892f24c013520768ce496ff6` | `fe15bd3f825a1f3cd3362d80008ac4f646712da8589e7a41ea63e85605c017d6` |
| Arts | `815ec9f20979da408a581ddcc187a9b03e11b8864f9860dd3b7260568560d5cd` | `cac95e3b3a10392fd67fe2aa45b7e5841d823009774e03219899880cbb41601b` | `ea4ffc77aa00f32c4658b6efa4e9f1d68194d479ce122e9e07e8ae4bf3750ab0` |
| Replay | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | same empty SHA | same empty SHA |

These hashes prove zero task-induced Web/Arts/Replay diff while preserving the
user's pre-existing Scene renderer and Arts changes.

Final validation:

- Scene Engine Python: `79 passed`; compileall passed.
- Python Game: `246 passed`.
- Scene Engine JavaScript client/renderer: `75 passed` (`16 + 59`).
- Arts: `34/34` logical gates passed.
- Replay: `23 passed`.
- clean Python 3.12 venv, no workspace `PYTHONPATH`: installed both 0.6.1
  wheels from final artifacts, `pip check` passed, Scene Engine `70` core tests
  and Python Game `53` core tests passed from site-packages.
- strict cutover verifier: passed.

## Subtraction and release decision

Removed hot-path behavior includes full static tuple traversal, static registry
rebuild, static parent/depth revalidation, static pose composition, repeated
large `_static_contract` comparison, discarded start checkpoints and repeated
same-revision checkpoint encodes. The old 0.6.0 vendored Python wheel was
removed; no legacy wrapper, feature flag or dual path remains.

No public service, manager, pipeline, repository, event bus, ECS, second
WorldState, second scene tree, delta protocol or compatibility layer was added.

Release decision: READY

Known issues: zero
