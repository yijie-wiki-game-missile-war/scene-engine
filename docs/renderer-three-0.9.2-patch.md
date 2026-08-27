# Three RenderBackend 0.9.2 texture-orientation patch

Release date: 2026-08-25

`@scene-engine/renderer-three@0.9.2` fixes URL texture orientation without changing
the RenderBackend port, Display component schemas, catalog identities, wire data,
or the 60 Hz runtime contract.

## Fix

The 0.9.1 URL loader created an `ImageBitmap` without an orientation option.
Three does not apply `Texture.flipY` to ImageBitmap uploads, so image-backed
planes sampled the source vertically inverted. The loader now decodes with
`imageOrientation: 'flipY'` and installs the already-oriented bitmap with
`Texture.flipY = false`. This matches standard Three UV orientation exactly once
for sprites, atlases, materials, surfaces, particles and backgrounds.

The regression test captures the ImageBitmap decode options, verifies the final
texture flag, and checks bitmap disposal.

## Artifact and verification

- Artifact: `scene-engine-renderer-three-0.9.2.tgz`
- SHA-256: `70f16f844915ca63bcffe4a9deaafb87632ae5e41200bb5ec9ae162b40aaf7d8`
- Scene Engine JavaScript tests: 110 passed (Client 27, Display 50, Renderer 33)
- Resource leak/rebuild matrix: passed
- `uv run python scripts/verify_cutover.py`: passed
- Arts architecture/workspace checks and production build: passed
- Baseline Prefab preview build: passed
- Browser smoke: city, building-card and weapon-card planes render upright

Scene Engine `dist` and Arts `vendor` contain byte-identical copies of the
0.9.2 renderer artifact. The 0.9.1 closeout report remains historical evidence
for its original tuple and hashes.
