# Scene Engine 0.6 structured-scene and 500-node cutover report

Scene Engine 0.6 is a one-step, breaking cutover. Product programs now submit structured complete `SceneNode` records and
frame-scoped `SceneEvent` records. The Engine validates those records against its cached bootstrap and encodes the raw frame
once. There is no encoded-frame product port, parse-after-encode path, independent product-events attachment, compatibility
constructor, alias, or fallback decoder.

Missile War consumers move atomically with this release to `missile-war-world-state@2`. Recordings created by an older
deployment are retained by that deployment and are not accepted by the current Replay service.

## Frozen runtime contract

| Boundary | Current contract |
| --- | --- |
| checkpoint product port | `world_codec`, `world_snapshot`, `scene_bootstrap`, `scene_nodes`, `scene_events` |
| commit product port | `world_codec`, `world_patch`, `scene_nodes`, `scene_events` |
| product JSON numbers | finite native floating-point values and safe integers; non-finite values fail closed |
| discrete protocol values | safe integers for kinds, lengths, ticks, revisions, commit counters, limits, and path indices |
| checkpoint wire layout | world snapshot JSON, scene bootstrap bytes, scene frame bytes |
| commit wire layout | world patch JSON and an optional same-tick scene frame |
| scene events | binary records inside the scene frame only |
| default limits | 64 MiB packet, 48 MiB attachment, 64 MiB session pending, 4,000,000 JSON values |

Attachment kind 5 is deliberately unassigned. Both Python and JavaScript reject it; numeric value 5 remains valid only as the
unrelated `engine.input_result` packet kind.

## Deleted paths and hot-path work

- The product `scene_frame: bytes` fields and independent product `events: bytes` route were physically removed.
- `ProductCheckpoint` and `ProductCommit` reject legacy keyword arguments rather than adapting them.
- The runtime caches one parsed bootstrap validation view per generation and never parses a frame it just encoded.
- The sole JavaScript `SceneTree` caches static registry, topology, world poses, and visual/profile lookup data after checkpoint.
  Ordinary frames process only the complete dynamic node set and reuse the static cache.
- The Missile War producer removed its intermediate scene DTO graph, static-map rebuild, static fingerprint, guessed journal
  scopes, partial input rollback, and per-tick idle-position writes.

## Artifact tuple

| Artifact | SHA-256 |
| --- | --- |
| `scene_engine-0.6.0-py3-none-any.whl` | `6cf8eba39d097fc210f220c259f7d5781152c366f06c5ed4f4f6d4c8ae893491` |
| `scene-engine-client-0.6.0.tgz` | `e7feeb9d197616f36379443e86e51157d0440cf022dbf4d4cb668df7a4936abb` |
| `scene-engine-renderer-three-0.6.0.tgz` | `5763e54b4725108ec6e87e990af22181514974c388563f2ad1ee78b62871e0f0` |

The wheel and archives installed in the three consumers are byte-identical to this tuple. Lockfiles contain only version
0.6.0. Ignored development output containing retired artifacts was removed; it is not a compatibility source.

## Correctness and integration gates

| Gate | Result |
| --- | --- |
| Scene Engine Python | 59 passed |
| Scene Engine JavaScript | client 16 passed; renderer 9 passed |
| Scene Engine cutover verifier | passed |
| python-game | 219 passed in 480.03 seconds |
| Arts | `npm run check` passed; `npm run build` passed |
| Replay | 23 passed |
| 500-node product packet log | 602 byte-exact records, 2 checkpoints, 600 commits, every selected frame has 500 dynamic nodes |
| Replay product playback | full playback and seek from commit 300 to 600 passed through the shared client |
| forbidden and retired-contract scan | zero production matches |

Input fault tests cover complete rollback after no-op, rejection, expected exceptions, and unexpected exceptions before the
runtime becomes fatal. Chained patch oracles reconstruct the complete product snapshot across 600 ticks and targeted
investment, diplomacy, combat, occupation, and production mutations.

## 500-node evidence

Synthetic Scene Engine and JavaScript client reports cover steady, full-motion, and 5% churn workloads with five rounds of
600 measured samples per scenario. The real Missile War report uses exactly 500 visible dynamic entities, complete frames,
600 acknowledged commits, periodic checkpoints, and a 3,600-commit bounded-retention soak.

| Scenario | Python publication p95 | JavaScript apply p95 |
| --- | ---: | ---: |
| steady | 10.493 ms | 2.239 ms |
| motion | 7.715 ms | 1.675 ms |
| churn-25 | 6.519 ms | 1.957 ms |

The real-product aggregate p95 values are 3.277 ms for gameplay step, 0.721 ms for journal finalization, 7.528 ms for direct
projection, 8.169 ms for scene validation plus the single encode, 1.124 ms for wire encoding, 20.554 ms for publication after
step, and 23.833 ms for step plus publication. A complete frame is 98,632 bytes. World patch p95 is 26,806 bytes and the
one-second boundary maximum is 156,368 bytes; combined commit p95 is 125,737 bytes and the maximum is 255,304 bytes.

The 3,600-commit soak finishes with zero session and transport backlog and configured global retention bounds intact. Latter
half RSS is not monotonic and decreases by 74,530,816 bytes. Traced live allocations rise by 37,942,791 bytes while the raw
packet retention window reaches its 256 MiB cap and product history continues to grow; that value is retained as a diagnostic
rather than treated as a latency release gate.

Absolute latency is recorded for diagnosis but is not a release blocker for this delivery, per the final acceptance decision.
Node count, complete-frame semantics, packet limits, exact ACK progression, no pending backlog, replayability, and bounded
retention remain correctness gates.

Evidence files:

- `docs/evidence/scene-engine-500.json`
  (`dfafb8899944e6f1c3cf5fd7a04a9a375808629e79667578c93c46258869fd5f`)
- `docs/evidence/client-500.json`
  (`cbc791a3576864defef3c88e2bce7aa02086c8b3d31865473cb3cb029b34ea13`)
- `../python-game/docs/evidence/runtime-500.json`
  (`ec8c179419490547dce7d0c8270ec3118a95d2eae7e755762940b320c32e91b3`)

## Commit and rollback tuple

| Repository | Tested source commit | Pre-cutover rollback commit |
| --- | --- | --- |
| scene-engine | `be1575d` | `60fc064` |
| python-game | `aeb184f` | `93b03f8` |
| Arts | `67b4ba6` | `790f322` |
| Replay | `001f010` | `29e220c` |

The tested source commits precede this evidence-only report commit where necessary. Rollback is tuple-atomic: stop producer
and consumers, deploy all four pre-cutover commits together, and use packet logs produced by that tuple. Cross-version packet
history mixing is intentionally unsupported.
