# Missile War display closeout delivery manifest

> Historical delivery record for the 2026-08-25 display closeout; it is not a
> current build, release, or verification entry point.

Generated on 2026-08-25 (Asia/Shanghai).

## Deliverable

| Field | Value |
| --- | --- |
| Archive | `missile-war-display-closeout-code-docs-20260825.zip` |
| Byte size | `3,177,402` |
| SHA-256 | `a81a72beb82f42a00689d5696c17deb0f6568fc54a524f1289e7fc338c092e4f` |
| Files | `1,252` |
| Top-level directory | `missile-war-display-closeout-code-docs-20260825/` |

The ZIP contains code, tests, configuration, repository-scoped agent
instructions, code-related text documentation, and JSON acceptance evidence.
It intentionally excludes binary art resources, screenshots, dependencies,
build outputs, caches, temporary files, and Git metadata. Consequently, it is
a code-and-document delivery rather than an asset-complete runnable checkout.

## Exact delivered commits

| Repository | Branch | Delivered commit | Full-suite implementation commit |
| --- | --- | --- | --- |
| `scene-engine` | `codex/display-closeout-v2` | `583809c40ec008fe8775a9b90abce0223d1f8172` | `4b7843f312c70743bb0edc15621cdc9ccbe9b7ac` |
| `python-game` | `main` | `4eb74f5a946abab233da2849642bcf587cdde415` | `4eb74f5a946abab233da2849642bcf587cdde415` |
| `arts` | `codex/display-closeout-v2` | `a4c98e2a159b34278885ed8dbad777205a91d6d1` | `005ecd7a6b0a5a506b5587aaff3a8db94f46d0a5` |

The delivered Scene Engine and Arts descendants contain only their final
closeout reports and Git archive substitution rules. Those reports were
materialized with exact self-commit hashes in the ZIP.

## Final verification

- Scene Engine: 109/109 JavaScript tests, 72/72 Python tests, final cutover
  verifier passed, and fresh 500-node/ACK/display/leak evidence verified.
- Python Game: 250/250 tests passed at the delivered commit.
- Arts: clean install, full checks, architecture/removal scans, production
  build, document link audit, and repo-scoped Skill validation passed. Web3D
  passed 46/46 workspace tests and 32/32 real Chromium capture tests.
- Browser acceptance covered 18 Showcase entries, four Camera presets, three UI
  kits, Reset, Fullscreen wiring, and no Canvas selection.
- The generic capture was verified in single Scene, single Prefab, closed-plan,
  internal-server, and external-server modes with matching PNG hashes,
  metadata, and source revision.
- ZIP integrity: `unzip -t` passed; extraction reproduced all 1,252 source files
  byte-for-byte; path traversal, forbidden directory, binary extension, and
  deleted-legacy-path scans returned zero findings.

The archive includes `SOURCE-MANIFEST.md` with the full composition policy,
source tuple, evidence filenames, and evidence SHA-256 values. The adjacent
`.zip.sha256` file contains the archive checksum in standard `shasum` format.
