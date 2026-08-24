# Display Node/Component cutover report

Release state: `READY`.

## Frozen tuple

```text
scene-engine Python              0.7.0
@scene-engine/client             0.7.0
@scene-engine/display            0.1.0
@scene-engine/renderer-three     0.9.0
wire                             scene-engine-wire@2
display codec                    scene-engine-display-node@2
packet log                       scene-engine-packet-log@2
```

The `main` catalog identity is frozen to scene
`dc7e8a975d55636722e54203c54fb3148703d2206e9d26033e0fe0e05baa6673`, Prefab
`753d6cb688677072452a551d9686f7f36d8d11dabe5e2534dacd459b87d254d3`, and state
`61578f58f0ffd077cbc6da6d65967d72bd59a612bee9f280a6a8511996c3b46d`.

## Resulting architecture

- `@scene-engine/display` owns the only Scene, NodeGraph, NodeIndex, Transform,
  Component scheduler, RenderSystem, and application RAF.
- Scene and Prefab are Resources. Instantiation creates ordinary Nodes;
  authority roots retain their immutable `py/` identity and Prefab-local
  children live under `prefab/`.
- Client 0.7 validates wire/session/World patches and sends each ordered,
  single-target command directly through the Display AuthorityPort. It owns no
  SceneTree or renderer model.
- Renderer Three 0.9 owns flat render bindings and resources only. It has no
  application RAF, no mirrored business Node tree, and returns no raw Three
  objects.
- Live, Replay, acceptance, Scene Editor, and Prefab Editor all use the same
  definitions, DisplayRuntime, RenderSystem, and Three backend. Authoring adds
  only a restricted local edit port and disposable `editor/` Nodes.

The final implementation and validation commits are Scene Engine
`75fd50c`; Arts runtime `ceacb49` and validation `be4cc7b`; Python product
`47b69b2` and formal evidence documentation `4eb74f5`; and Replay `be783f1`.

## Closed artifacts

| Artifact | SHA-256 |
| --- | --- |
| `scene-engine-client-0.7.0.tgz` | `acbddf231b240083dcdd7991cc1e74ec426d283ddce34d74c966eb665b921cbb` |
| `scene-engine-display-0.1.0.tgz` | `09cae591ff000450e6a90d5bd539d8de196fa83e0a3e1a0a793ebd936b9d36ec` |
| `scene-engine-renderer-three-0.9.0.tgz` | `700a6c166710e7d9fadc797c8247fda72c7537daa5e68b0f9d008a2f8a16f6db` |
| `scene_engine-0.7.0-py3-none-any.whl` | `406c95e32bc8c27f746556bdbbe6e1024d7af460ea1f24b9f7b21aefb830775e` |

Scene Engine dist tarballs and all Arts vendor copies are byte-identical. Only
the listed current versions remain. Lock SHA-256 values are Scene Engine npm
`4d35a9bd2cf0115875378bcf5d6c1988964fab4c01be65515dcfbcf565315fdf`,
Arts npm `3a70bb5c29b596ed7953aa07a8d40d86fea4dfd6ace4bfe3e47b5a8a20620dac`,
Python requirements
`a1d867e145a0960c932dbdc60b5436a690bdc434ae635c4969629bdc45eec4a5`, and
Replay npm `9430caf2ad4265907a6b6480b60d21b579ee299d2b3e38deca4ca06a95c1aa4f`.

## Verification

- Scene Engine JavaScript: 86/86 tests (Client 18, Display 46, Renderer 22).
- Scene Engine Python: 72/72 tests.
- `scripts/verify_cutover.py`: package source/tarball/vendor/lock/install and
  Python wheel-content verification passed.
- Python product: 250/250 tests; formal 600/600 commit integration passed with
  exact tick/commit order, patch reconstruction, ACK cursors, bounded retention,
  and a fresh late-client checkpoint. Evidence SHA-256 is
  `7c37a36456432adb1742ad8fbca51ec98a68c3a0a678e1054a929c3710e715e9`;
  it was generated from Python source HEAD
  `1f6b3b393d1cea3225af31bf3abaceb1429ddad1` and is `overall_passed`.
- Python's 7,200-tick capacity run passed all 17 gates. Its evidence SHA-256 is
  `082ec2c76644861ac9b8ecfd21560e6754126cea44d44ea1626fec6ea8cbbb8a`:
  tick and commit both reached 7,200, session backlog returned to zero, maximum
  retained packet bytes were 268,435,427/268,435,456, maximum retained packets
  were 3,605/4,096, the largest packet was 12,449,863 bytes under 64 MiB, and
  the largest attachment was 11,830,762 bytes under 48 MiB.
- Replay: 37/37 tests, including bounded validated-log caching, reconnect and
  reload with a fresh control session, checkpoint seek, and zero outer-shell
  RAF.

## 500-root Display evidence

The generated evidence described by the
[`Display Node cutover evidence index`](evidence/display-node-cutover/README.md)
is `READY`. It contains 500 authority roots, 1,000 Prefab-local Nodes, 1,503
indexed Nodes, 501 bindings, one 500-instance batch, and 20 scheduled
behaviours. All 600 validation ticks and all 36,000 logical-tick soak ticks
were committed individually with 40 real target commands per tick. The 36,000
count is a logical simulation-tick soak, not a claim about measured wall-clock
duration.

| Soak metric (ms) | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| command apply | 0.400 | 1.121 | 2.286 |
| transform flush | 0.054 | 0.167 | 0.407 |
| RenderSystem prepare | 1.029 | 2.257 | 3.618 |
| total CPU pre-draw | 1.471 | 3.346 | 5.421 |

The independent correctness hash matched. Only 15 of 36,000 pre-draw samples
exceeded 16.67 ms, the longest run was two ticks, post-validation heap growth
was 114,896 bytes, and full-tree traversal diagnostics remained zero.

The formal JavaScript evidence's source inventory SHA-256 is
`834ef26adfdf40a4b4f79f443455456876915c68e00759a86ec9840951e0fb7f`.
That inventory matches the source at Scene Engine `75fd50c`; the evidence
metadata intentionally preserves the dirty, pre-commit starting identity from
the run that produced it.

Python's generated
[`product integration evidence`](../../python-game/docs/evidence/README.md)
covers the product-owned checkpoint/commit/ACK boundary: 632 static plus 500
dynamic authority roots, 40 tick behaviours, 600/600 commits, and an 11,355,152
byte late checkpoint under default limits. Renderer/prefab-local timing belongs
only to the JavaScript evidence above.

## Browser, rebuild, and lifecycle

The Arts
[`display-node-cutover evidence`](../../arts/docs/evidence/display-node-cutover/README.md)
contains production acceptance, pick identity, Authoring, Live, and exact
Replay captures. Two clean production builds reproduced the Web3D output at
SHA-256
`6855009518559e11a112f6ebd73bdc10ea95e1032d82d2ca9138f68ba3b3d5cb`
and the Authoring output at
`d6bee8ac823eb6869010ec44294cc899ef6ec43003cb357342742b9212d36024`.
The final served artifact remains exactly 80 files and 89,290,712 bytes, with
files SHA-256
`74e0c7842eb2ba571f5b1f06761ab19685a9f7807c4121602eb626194112b1e7`
and manifest SHA-256
`fd2a7a87f0cd9635181c0b7eff6b6dbb3bb01ed8918d211b61e444097774b54d`.

The formal browser chain used one stream from Live through recording and
Replay. Live was ready at tick 176; the naturally sealed packet log ended at
tick/commit 1,210. Replay paused, requested seek 700, selected checkpoint 600
in a fresh control session, and remained stable at tick 600 while paused. It
then resumed at 2x through tick 1,210, and reload established another fresh
control session. The 77,000,226-byte validated log remained within the
128-MiB cache bound, and the outer page plus embedded runtime reported zero
warnings and zero errors throughout. A final rebuilt-artifact Chrome refresh
repeated the entire fresh/reload/pause/seek/2x chain; its Replay capture
SHA-256 is
`a66749ff097927237365e1431e37a7eb6e284ce9d7b450c31ce2fa00530d4cf5`.

[`display-resource-leak-matrix.json`](evidence/display-resource-leak-matrix.json)
is `READY` after 100 create/remove cycles, 20 backend rebuilds, GLTF failure,
partial LOD, and pending-remove races. Nodes, Components, scheduler handlers,
bindings, resources, pending tokens, RAF callbacks, and renderer resources all
return to zero. Arts Authoring separately completes 20 Scene and 20 Prefab
open/close cycles with the same zero baseline.

## Removal and stale scan

The Client's former mirrored tree, Python scene-v1/frame adapters, former
renderer runtime surface, old wire/packet decoders, Arts composition path, and
all four retired shared Arts display packages were physically removed. Current
source scans find no compatibility
alias/fallback, old vendor tuple, direct browser Three import, public batch
authority API, or application RAF outside DisplayRuntime.

No release blocker or compatibility path is being carried. All architecture,
correctness, capacity, lifecycle, artifact, and browser gates are closed.
