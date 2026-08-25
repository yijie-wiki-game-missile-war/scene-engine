# Display repair and Showcase cutover report

Release state: `READY`.

## Released tuple

```text
scene-engine Python              0.7.0
@scene-engine/client             0.8.0
@scene-engine/display            0.2.0
@scene-engine/renderer-three     0.9.1
@missile-war-art/web3d           0.3.0
wire                             scene-engine-wire@2
display codec                    scene-engine-display-node@2
packet log                       scene-engine-packet-log@2
browser products                 production + read-only Showcase
```

The implementation source is Scene Engine commit
`0c9b77f4687a7ed72de53a4ff7fadef7431f0a9f`. The Arts implementation is
`e1c103a368c329be9a097db7934720dbd195e0d7`, followed by fullscreen lifecycle
coverage at `57f5f30cc6c3400c027589dc34c9fd272485daf6`.

The `main` catalog identity remains frozen to scene
`dc7e8a975d55636722e54203c54fb3148703d2206e9d26033e0fe0e05baa6673`, Prefab
`753d6cb688677072452a551d9686f7f36d8d11dabe5e2534dacd459b87d254d3`, and state
`61578f58f0ffd077cbc6da6d65967d72bd59a612bee9f280a6a8511996c3b46d`.
Python stays at 0.7.0; the wire fields, ACK packet, authority commands, tick
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
  11/11, including 30 create/dispose cycles and both fullscreen transitions.
- Physical-removal and final forbidden-surface scans are clean.

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

The final Web3D build contains 84 files, 77 emitted media files, 13 inline media
items, and exactly `index.html` plus `showcase.html` as entry pages. Build
SHA-256 is
`c05d04b6080ae4132b0c7450e36095b978106a639760f155e10960104cae3adc`.
The removed browser product has no source workspace or build directory.

## Closed artifacts

| Artifact | SHA-256 |
| --- | --- |
| `scene-engine-client-0.8.0.tgz` | `8e52022a9ab5589423b0ce0ba0d97e10622c440f0f532305bb42b949d5d00e0e` |
| `scene-engine-display-0.2.0.tgz` | `38460bd3963f6a0683a73c7190a72af50e873d0366ca36d77bcdb060c7f33d48` |
| `scene-engine-renderer-three-0.9.1.tgz` | `5135d9b5b050c94ea556feaf6990363e2832798030e1d0aaabe6abbb7b73950d` |

Scene Engine `dist` and Arts `vendor` contain only this tuple and are
byte-identical. Lock SHA-256 values are Scene Engine npm
`3f43865900616d045e88a40a1b1c5923738d66ed918ccb8cc3f0b9738b35dd28`
and Arts npm
`0e209f72614f464248916bc1942c2a41e484bfbdf54978df175dacfd83c87d86`.

All P0 architecture, ACK, correctness, batching, browser, lifecycle, artifact,
clean-install, build, and removal gates are closed.
