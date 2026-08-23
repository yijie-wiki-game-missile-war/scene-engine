# Scene Engine 0.5 cutover report

Scene Engine 0.5.0 cutover complete. The runtime, wire, recording, JavaScript client, scene tree, Arts display path, and Replay
path now share one commit stream without a compatibility layer. Production Python/JavaScript source in Scene Engine changed
from 25 files and 10,872 physical lines at the rollback point to 17 files and 7,070 lines in the cutover source.

## Commit and rollback tuple

The Scene Engine report commit contains evidence only; the source tuple below is the code and artifact tuple that was tested.
No repository was pushed by the cutover task.

| Repository | Cutover source | Rollback point |
| --- | --- | --- |
| workspace root | `62f7636` | `b065b2f` |
| scene-engine | `4ba6cac` | `d648f2b` |
| python-game | `93b03f8` | `cdbbf4b` |
| Arts | `790f322` | `7e82ddc` |
| Replay | `29e220c` | `0f35d34` |

Rollback is tuple-atomic: stop producers and consumers, deploy all four product rollback points together, and use recordings
created by that deployment. Packet histories from the two tuples are intentionally not mixed.

## Built artifacts

| Artifact | SHA-256 |
| --- | --- |
| `scene_engine-0.5.0-py3-none-any.whl` | `232c36381aac9149c20c91b1b92983b0be1590bb05b48e576ea57593e0efce31` |
| `scene-engine-client-0.5.0.tgz` | `c9d9c3b1699ca5bc396cca50afdbb91b73d383c13fe615b6fc7a7975157518d0` |
| `scene-engine-renderer-three-0.5.0.tgz` | `9e3ced083f0737343714946ee012e87647d090dc5649918b976e02e6e7c0802e` |

The client archives in Arts and Replay and the renderer archive in Arts are byte-identical to these artifacts. Isolated wheel
and npm installs resolve only from the built artifacts and import from their isolated installation roots.

## Test and package gates

| Gate | Result |
| --- | --- |
| Scene Engine Python | 49 passed; compileall and isolated wheel import passed |
| Scene Engine JavaScript | client 10 passed; renderer 9 passed; isolated archive consumer passed |
| python-game clean archive | 206 passed in 311.94 seconds; compileall passed |
| Arts clean archive | install, build, check, client integration, and 5,000-controller soak passed |
| Replay clean archive | 23 passed; fresh Arts artifact staging and playback passed |
| final source, test, documentation, lock, vendor, and generated-output scans | zero deleted-path, retired-identity, or retired-dependency matches |
| dependency graphs | one client and one renderer at 0.5.0 where applicable |

Product JSON numbers accept native finite floating-point values in both languages, including signed zero and exponent forms.
Non-finite values are rejected. Enumerations and discrete protocol metadata such as kinds, lengths, ticks, revisions, and
commit counters remain safe integers; larger product integers use the product's lossless tagged form. Python and JavaScript
encoders are directionally deterministic, while cross-language validation compares decoded semantics rather than requiring
the two native JSON encoders to choose identical number spelling.

## Integrated scenarios

| Scenario | Evidence |
| --- | --- |
| fixed-seed product run | 600 ticks, one changed input commit, two duplicate no-op results, one rejection, and final cursor `601/600/602` |
| multi-client session behavior | eight healthy clients, one slow timeout and reconnect, four malformed-client isolations, and zero shared-packet identity violations |
| recording identity | 602 live state packets equal the recorded and Replay WebSocket payloads byte for byte |
| Replay | start playback and seek from commit 300 through target 350 both reach the live final world, tree, and cursor |
| Arts | 602 acknowledgements and state commits plus three input results; final UI and scene equal live output |
| production WebSocket | two real clients receive and acknowledge the same seven state packets; a text client is isolated without affecting them |
| domain equivalence | rollback core and current EngineProgram produce 7,961 events and the same revision-normalized full business-state hash after the same seed/tick/input script |
| strict node-scale run | exactly 500 scene nodes, one checkpoint, 600 complete frames, 601 acknowledgements, and zero tree or renderer identity violations |
| long stability run | 5,000 commits to eight clients, 40,000 sends, bounded 64-packet retention, and no latter-half linear memory growth |
| failure boundaries | malformed packets, progression gaps, overlapping patches, scene cycles, invalid acknowledgements, oversize input, recorder failure, and observer failure all fail closed |

Key semantic hashes from the fixed-seed product run:

| Value | SHA-256 |
| --- | --- |
| revision-normalized pre/post domain state | `ee2de34b7b0427e9a4c543c1c713f15c95119dbf26f252db242d1ccee739c145` |
| final cross-language world | `264a1b0420470f7b84450d26fd076da90e4ad3795a7b9e3193a3e14bc627d6a2` |
| final scene tree | `fe6c59373db22b3c58974fcb88c7b9274d6f9d68fdb217e466c58b17bafba3cf` |
| final selected UI | `5a33517315a659b70626894adb681b822dab06997ad9ce60ba5055c1ba953d38` |
| live, recorded, and Replay payload sequence | `b5a9ced1ef587f7586534f50844d0d30820f73804d5eec0d4427505f9a519079` |
| packet log body | `3a17dc6df739e0356326879c1543e1cc9b00c73cdb382f4ed79ffadd21e328d7` |
| strict 500-node packet sequence | `cf9cc186bb01d5648ff0912794d593c6b4b62d18f0ba943a5c56bcb72568ccdf` |

## Performance

The 600-tick product run used seed 42 while a user-owned process continuously occupied one CPU core. Values are milliseconds;
each row reports p50 / p95 / p99.

| Producer phase | Samples | p50 / p95 / p99 |
| --- | ---: | ---: |
| gameplay step | 600 | `4.576 / 5.009 / 9.544` |
| journal finalization | 601 | `0.643 / 0.727 / 16.830` |
| scene construction | 601 | `36.348 / 43.180 / 45.652` |
| wire encoding | 601 | `1.027 / 1.175 / 22.160` |
| session fan-out, excluding transport work | 601 | `0.022 / 0.027 / 0.031` |
| Engine sync overhead | 601 | `1.691 / 1.848 / 39.677` |

Engine sync p95 passes the 4 ms gate. No gameplay sample exceeded 16.67 ms. The full-domain one-second commits account for the
journal and wire p99 tail and remain intentionally complete.

| Consumer measurement | Samples | p50 / p95 / p99 | Gate |
| --- | ---: | ---: | --- |
| product ordinary client apply | 601 | `3.626 / 5.488 / 45.197` | p95 <= 8 ms, pass |
| strict 500-node client apply | 600 | `0.676 / 1.323 / 1.750` | pass |
| strict 500-node renderer apply | 600 | `0.062 / 0.139 / 0.254` | pass |
| strict 500-node atomic client/renderer barrier | 600 | `0.742 / 1.419 / 1.958` | pass |
| generic 5,000-commit client apply | 5,000 | `0.025 / 0.048 / 0.098` | stability evidence |

At 500 nodes, initial client plus renderer installation took 6.35 ms. The 600 ordinary frames performed 300,000 pose updates,
created exactly 500 visuals once, and recreated none. From commit 300 through 600, heap grew by 96,008 bytes and resident memory
by 950,272 bytes.

Network evidence for the product run:

| Measurement | Result |
| --- | ---: |
| initial checkpoint | 4,552,641 bytes |
| commit p50 / p95 / p99 | `85,848 / 85,864 / 1,818,812` bytes |
| largest commit | 1,935,044 bytes |
| largest state packet | 13,281,413 bytes of a 33,554,432-byte limit |
| one-client 60 Hz state traffic | 7,385,139 bytes/second |
| eight-client test fan-out | 5,212 sends and 599,717,070 bytes |
| sealed log | 608 records and 131,359,594 bytes |
| final runtime retention | 64 packets and 9,117,522 bytes |

## Known non-blocking product limits

- Node-scale acceptance is temporarily capped at exactly 500 nodes. The fixed-seed Missile War run currently has 16 scene
  nodes; the independent strict 500-node run proves the Engine/client/renderer path only. No claim is made above 500 nodes.
- Missile War product-side scene construction remains the dominant server cost at 43.180 ms p95. It is outside a 16.67 ms
  wall-clock frame budget even though gameplay, Engine sync, consumer, and the strict 500-node Engine path pass their gates.
  Product scene-source optimization is a follow-up before claiming real-time headroom.
- A clean Arts source archive must be built before its complete check because that check validates generated runtime output.
