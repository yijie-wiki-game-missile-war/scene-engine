# Scene Engine Wire v2

The only wire identity is `scene-engine-wire@2`. One WebSocket binary message is one complete packet. Multibyte container integers
are little-endian.

The fixed header is `<4sBBHIHH>`: magic `SENG`, major `2`, packet kind, zero flags, JSON-header length, attachment count and zero
reserved. Each attachment starts with `<BBHI>`: kind, encoding (`0=raw`, `1=JSON`), zero flags and length. Unknown fields or kinds,
duplicate JSON keys, invalid UTF-8, BOM, nonfinite values, unsafe integers, truncation, trailing bytes, nonzero reserved bits and
hard-limit violations fail closed.

Packet kinds are:

```text
1 checkpoint
2 commit
3 input
4 ACK
5 input result
6 fatal diagnostic
```

Attachment kinds are World snapshot `1`, World patch `2`, Display checkpoint `3`, Display command stream `4`, input payload `6`
and result payload `7`.

Exact layouts:

- checkpoint: JSON World snapshot + JSON Display checkpoint;
- commit: JSON World patch + JSON Display command stream;
- input: one JSON payload;
- input result: zero or one JSON result;
- ACK/error: no attachments.

Checkpoint and commit headers carry `stream_id`, `commit_seq`, `source_tick`, `world_revision`, `last_command_seq`, `world_codec`
and `display_codec=scene-engine-display-node@3`. Commit adds cause and causation ID. ACK is cumulative over stream, commit and
last command cursor.

The Display checkpoint contains:

```text
scene_name
scene_catalog_hash
prefab_catalog_hash
state_schema_hash
last_command_seq
parent-first complete py/ roots
```

The three hashes come from `scene-engine-display-catalog-manifest@1`: JavaScript canonicalizes the installed Scene,
Prefab/Resource/Component and authority-state schema definitions, writes a build identity artifact, and Python loads those exact
values. Wire transports the identities; it does not invent or recompute product catalog content.

The command stream contains base/last cursors and strict `scene-engine-node-command@3` records. Every command has one target and
is create, transform, reparent, visibility, complete state replacement, exact Prefab replacement or remove.

World patch identity is `scene-engine-json-tree@1`; operations are `set`, `unset` and `append`. All paths and values are validated
before mutation. Raw packet bytes are immutable after first encode, and packet logs never decode/re-encode them. Cross-language
fixtures live under `fixtures/wire-v2`, `fixtures/display-catalog-v1` and the Client fixture directories.
