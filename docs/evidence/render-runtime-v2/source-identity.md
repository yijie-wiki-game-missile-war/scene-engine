# Renderer 0.8/V2 final source identity

The cutover was tested from uncommitted working trees. The base commits are not
cutover commits; the exact tested source is the base commit plus the tracked
binary diff and the listed untracked-file manifest below.

| Repository | Base commit | Tracked diff SHA-256 | Untracked manifest SHA-256 |
| --- | --- | --- | --- |
| `scene-engine` | `711b6dc3af9f1ca9b16e46f336fc54734a804907` | `97ca8633e97b940d16cd433d9071101bf4890f818f667c9e10414f00f5265e76` | `1e5cf2d4c4d79cbc3e8b164bb3be0d7417303dcebc8e3ce8e63169442fd33353` (13 files) |
| `arts` | `67b4ba6aae421740a1031153e8fc2063ff7c953c` | `cac95e3b3a10392fd67fe2aa45b7e5841d823009774e03219899880cbb41601b` | `3c4e7299297510d1173827a92f3b7d6089dd2f9597b68e71ffba193a2a307d32` (118 files) |

The tracked diff hashes use `git diff --binary --no-ext-diff HEAD` while
excluding only the repository's cutover report, which is filled from this
evidence after testing. The untracked manifests exclude generated builds,
renderer tarballs, evidence, cutover reports and `.DS_Store`; the exact
per-file hashes are in each repository's
`docs/evidence/render-runtime-v2/untracked-source.sha256`.

The unchanged Replay base/tested commit is
`001f0109101a3410905aaec1d04009a7a5924a45`.

Artifact and generated identities:

- renderer artifact SHA-256: `b51dc2d7ef4c7ed234de56335896b6577254506fcc58d3ef0c7f4b3923796d28`
- Scene Engine lock SHA-256: `9ca8b758fee1cf9afaf6e17b081cf4a543090ecef4ae911cd876fa4a9bfd22d6`
- Arts lock SHA-256: `a2e0cd17db8d72cf200800b5d1833eb4724126963dec995a5b0314d159a5da5f`
- Arts production build SHA-256: `91750dfc64cca3ab6f05e6ee75eb621abee48f1c0617744fe40eaf6b5dfa019d`
