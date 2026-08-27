# Display repair and Showcase cutover report

> Historical closeout: this report records the 0.9.1 renderer tuple. The current
> renderer patch is 0.9.2; see `docs/renderer-three-0.9.2-patch.md`.

Release state: `READY`.

## Released tuple

```text
scene-engine Python                 0.8.0
@scene-engine/client               0.9.0
@scene-engine/display              0.3.0
@scene-engine/renderer-three     0.9.1
@missile-war-art/web3d           0.3.0
wire                             scene-engine-wire@2
display codec                    scene-engine-display-node@3
packet log                       scene-engine-packet-log@2
browser products                 production + read-only Showcase
```

## Source identity for the 2026-08-25 closeout

| Identity | Scene Engine | Python Game | Arts |
| --- | --- | --- | --- |
| Implementation base | `4b7843f312c70743bb0edc15621cdc9ccbe9b7ac` | `4eb74f5a946abab233da2849642bcf587cdde415` | `30529c999fcd8b92b0988c6ae46984d22ecb99d4` |
| Final tested commit | `4b7843f312c70743bb0edc15621cdc9ccbe9b7ac` | `4eb74f5a946abab233da2849642bcf587cdde415` | `005ecd7a6b0a5a506b5587aaff3a8db94f46d0a5` |
| Delivered commit | `$Format:%H$` | delivery manifest | delivery manifest |

The implementation base is the tuple at the start of this closeout. Final
Engine, gameplay, Arts, clean-install, capture, and browser tests ran against
the final tested tuple. Scene Engine has no runtime or package change in this
closeout; its only tracked descendant is this report and its Git archive
substitution rule. The affected documentation and cutover gates were rerun.

A tracked report cannot contain the hash of the commit that contains itself.
Git expands the Scene Engine value above to the exact commit in the delivered
`git archive`; the delivery manifest shipped beside the archive records the
exact delivered tuple for all three repositories and the outer archive
SHA-256.

The `main` catalog identity remains frozen to scene
`dc7e8a975d55636722e54203c54fb3148703d2206e9d26033e0fe0e05baa6673`, Prefab
`753d6cb688677072452a551d9686f7f36d8d11dabe5e2534dacd459b87d254d3`, and state
`61578f58f0ffd077cbc6da6d65967d72bd59a612bee9f280a6a8511996c3b46d`.
Python stays on the current 0.8 line; the wire fields, ACK packet, authority commands, tick
ownership, and catalog identity contract are unchanged.

## Runtime result

- Client checkpoint and commit observers publish immutable commit metadata,
  world state, and an O(1) display summary. A complete `DisplayView` is built
  only by an explicit current-state query or capture.
- Failed authority commands fail the commit gate and produce no ACK. Observer
  failures do not roll back a successful commit. Rejected thenables from
  factories, gates, and disposal are consumed without unhandled rejections.
- DisplayRuntime owns the single NodeIndex and the only Transform for every
  Node. Component property changes pass registry normalization and resource-kind
  validation before atomic installation.
- Runtime disposal releases Scene references, loader and Prefab scopes,
  scheduler handlers, render leases, pending loads, RAF callbacks, and backend
  resources. Duplicate disposal is idempotent.
- Renderer Three keeps ordinary and batched representations mutually exclusive.
  The regression suite covers batch creation, transform updates, logical
  visibility toggles, hidden-instance matrices, batch exit, one-member collapse,
  replacement, single-hit picking, rebuild, and diagnostic counts.
- Production exposes Live and Replay only. Showcase uses the same formal Scene,
  Prefab, Resource, DisplayRuntime, and Three backend objects without transport,
  selection, or browser mutation surfaces. The former browser editing workspace
  is physically absent.

## Automated verification

Final clean-install verification completed from the locked dependency trees:

- Scene Engine JavaScript: 109/109 tests — Client 27, Display 50, Renderer 32.
- Scene Engine Python: 72/72 tests.
- `uv run python scripts/verify_cutover.py`: package source, exact public APIs,
  tarballs, Arts vendor bytes, dependency locks, clean installed bytes, removal
  checks, and current-document checks passed.
- Arts `npm run check` and `npm run build`: passed; Web3D Showcase tests are
  46/46 in the workspace gate, including 30 create/dispose cycles and both
  fullscreen transitions. The separate real Chromium capture run is 32/32.
- Python Game: 250/250 tests.
- Physical-removal and final forbidden-surface scans are clean.

Fresh package evidence from the final tested tuple is included by filename and
SHA-256: Python 500-node
`scene-engine-python-500-quick-20260825.json`
(`22bcc78c6e17bb3546bd030514bbe6ee49558e22e3fce9f1ef5dcceee289cdd8`),
client ACK 500-node `scene-engine-client-ack-500-quick-20260825.json`
(`656f20d36a912c625d825d3743fdc750c3ecd8e56245f587aa8b6a8514288564`),
display 500-node evidence
(`1a0d973877889d9def4ec7045e74dbb05965e7907a41482f9b403816291513e3`),
and the resource leak matrix
`scene-engine-display-resource-leak-matrix-20260825.json`
(`0ed98fc24d50a9e2b168f567deafbc813254fb7bb61393d8abf1ea8f246050e2`).

## Client ACK evidence

[`js-client-ack-500-formal.json`](evidence/display-node-cutover/js-client-ack-500-formal.json)
is `READY` with 500 authority roots, 1,503 total Nodes, and 10,000 individually
ACKed commits. Checkpoint apply-to-ACK was 78.071 ms. Commit timing was:

| Client-to-ACK metric | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| milliseconds | 0.081 | 0.195 | 0.370 |

There were 10,001 summary calls, zero complete-view materializations, and zero
readiness waits on the ACK path. The stable memory window ended 14,272 bytes
below its start and was not monotonically increasing. Evidence SHA-256 is
`63662e82314761450435ee37eee9ac7f2bfde4ec1ff518d92571f8b48110b4b9`.

## 500-root Display evidence

The generated evidence indexed by the
[`500-root Display evidence guide`](evidence/display-node-cutover/README.md) is
`READY`: 500 authority roots, 1,000 Prefab-local Nodes, 1,503 indexed Nodes,
501 bindings, one 500-instance batch, and 20 scheduled behaviours. All 600
validation ticks and 36,000 soak ticks were individually committed with 40 real
target commands per tick, for 1,464,000 total commands.

| 36,000-tick soak metric (ms) | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| command apply | 0.366 | 0.813 | 1.307 |
| transform flush | 0.050 | 0.134 | 0.216 |
| RenderSystem prepare | 0.979 | 1.690 | 2.335 |
| total CPU pre-draw | 1.372 | 2.496 | 3.511 |

Six samples exceeded 16.67 ms and the longest consecutive run was two ticks.
Post-validation heap growth was 179,696 bytes, or 4.992 bytes per soak tick,
within the 8 MiB bound. The independently tracked semantic hash matched; measured
paths performed 3,184,192 direct lookups and zero full-index traversals. Final
disposal returned Node, Component, scheduler, loader scope, Prefab scope,
binding, resource, pending-load, RAF, and renderer counts to zero. Evidence
SHA-256 is
`024d561292e832287c9bc569a4c574b98346a1c002fef25d710116df79924a28`.

## Leak and rebuild evidence

[`display-resource-leak-matrix.json`](evidence/display-resource-leak-matrix.json)
is `READY` after 100 authority create/remove cycles and 20 backend rebuilds.
Every authority cycle returned to baseline, each of 20 retired backends returned
to zero, and Node and Component identity survived every rebuild. Injected GLTF
failure, partial LOD failure, and disposal during a pending texture binding all
settled with zero bindings, leases, pending resources, geometry, materials, and
textures; no late binding attached. Evidence SHA-256 is
`3681be5c2a925797c0302675eaed54adcad436c652385cf419a74e2b1150d136`.

## Browser and build evidence

Arts records the final browser matrix in
[`browser-acceptance.json`](../../arts/docs/evidence/display-repair-showcase/browser-acceptance.json).
It covers a real 60 Hz Python Live stream, authority picking and HUD focus,
natural packet-log Replay with stable pause/resume, all 18 Showcase entries,
four camera presets, three UI kits, reset, unknown-parameter failure, no Canvas
selection, single-shell entry switching, and a real backend rebuild. Production
and Showcase both reached healthy ready state with no pending resources in the
recorded cases.
Browser evidence SHA-256 is
`192b511e8bb5a38067dafe03c890933da0f6805e5c047c82951463d4b49739a2`.

The closeout also generated package delivery evidence from the final tested
Arts commit: all 18 Showcase entries, four Camera presets, three UI kits,
Reset, Fullscreen wiring, and no Canvas selection passed. Its SHA-256 is
`99d2ab4f5fa993667095317aa5c11de9eb358b7f7d2f91421779bd20bba4a9da`.

The final Web3D build contains 84 files, 77 emitted media files, 13 inline media
items, and exactly `index.html` plus `showcase.html` as entry pages. Build
SHA-256 is
`9f1e02cac13ad203461780407ff7e7160f704aff86c9dfcac791e2feeabddbef`.
The removed browser product has no source workspace or build directory.

## Closed artifacts

| Artifact | SHA-256 |
| --- | --- |
| `scene-engine-client-0.9.0.tgz` | `6a55cce126e6fa53ac9a9742af24d5eb018e34a0fbdb89d1c62430eb1ba776e7` |
| `scene-engine-display-0.3.0.tgz` | `537236091d4cd4805624e018d3de7d1fa127b4bc42afdb2dbfa3671f31b9c8d3` |
| `scene-engine-renderer-three-0.9.2.tgz` | `70f16f844915ca63bcffe4a9deaafb87632ae5e41200bb5ec9ae162b40aaf7d8` |
| `scene_engine-0.8.0-py3-none-any.whl` | `3bdba2201f8239c63653c02b43c5169aab6c8d17d4d085e295f7e06824087856` |

Scene Engine `dist` contains the npm tuple plus the Python wheel. Arts `vendor`
contains the npm tuple and is byte-identical for those tarballs. Lock SHA-256
values are Scene Engine npm
`d09b32cbea06c2e0cfb47076440ed0b134c14a6b5bcfb4332433fd8784404ad5`
and Arts npm
`0f9a9e9b184e933eab6c0d638a402de0504a98f395944af34d6bcae1a7ec064b`.

All P0 architecture, ACK, correctness, batching, browser, lifecycle, artifact,
clean-install, build, and removal gates are closed. The 19 asset-specific
capture scripts, shared legacy helper, unpromoted billboard candidate, obsolete
coast HTML, and flat agent guide are absent with no compatibility replacement.
