# 0.5 cutover report

Scene Engine 0.5 replaces parallel state/display coordination with one Engine commit cursor and removes the prior compatibility
surface in one release. Production Python/JavaScript source changed from 25 files and 10,872 physical lines at baseline to 17
files and 7,070 lines after cutover (`*.py`/`*.js` under package source directories; generated files and tests excluded).

Reusable work retained in the new design includes fixed-step catch-up, strict binary body validation, parent/local tree and
world-pose derivation, display-ID lifetime checks, linear renderer plans, async resource invalidation, and deterministic
fixtures. Stream identity, transaction cursor, session credit, recorder framing, and browser atomic installation were rewritten
around the unified packet.

## Repository commit tuple

W0 did not create commits. The root integrator must replace each pending cell after all four repositories pass W5.

| Repository | Baseline commit | Migration commit |
| --- | --- | --- |
| scene-engine | `d648f2b` | pending root commit |
| python-game | pending W5 capture | pending W5 commit |
| arts | pending W5 capture | pending W5 commit |
| replay | pending W5 capture | pending W5 commit |

## Built artifacts

Built from the final source tree on 2026-08-23:

| Artifact | SHA-256 |
| --- | --- |
| `scene_engine-0.5.0-py3-none-any.whl` | `232c36381aac9149c20c91b1b92983b0be1590bb05b48e576ea57593e0efce31` |
| `scene-engine-client-0.5.0.tgz` | `c9d9c3b1699ca5bc396cca50afdbb91b73d383c13fe615b6fc7a7975157518d0` |
| `scene-engine-renderer-three-0.5.0.tgz` | `9e3ced083f0737343714946ee012e87647d090dc5649918b976e02e6e7c0802e` |

## W0 gate evidence

| Gate | Result |
| --- | --- |
| Python 3.12 pytest | pass, 49 tests |
| Python compileall over `src`, `tests`, `scripts` | pass |
| npm workspace tests | pass, client 10 + renderer 9 |
| `scripts/verify_cutover.py` | pass |
| attachment-manifest identity scan plus current scene-field scan | pass, zero matches |
| package locks and workspace graph | pass, version 0.5.0 and two JS packages only |
| `git diff --check` | pass |
| isolated wheel install/import with module allowlist | pass |
| isolated npm tarball install/import and packaged packet-log read | pass, 4 records and 2 checkpoints |

The client archive contains its valid and malformed packet-log fixtures. The wheel contains only initialization plus the eight
current implementation modules. The two npm roots export 7 client names and 4 renderer names respectively.

## Performance evidence still required from W5

W0 did not run the integrated product workload, so it makes no latency claim.

| Measurement | Current evidence |
| --- | --- |
| runtime/gameplay p50 | not measured in W0 |
| runtime/gameplay p95 | not measured in W0 |
| runtime/gameplay p99 | not measured in W0 |
| gameplay samples above 16.67 ms | not measured in W0; no conclusion |

W5 must replace these entries with measured commands, sample counts, and values. It must also append the final four-repository
commit tuple and integrated clean-checkout evidence; W0 package tests are not a substitute for that cross-product run.
