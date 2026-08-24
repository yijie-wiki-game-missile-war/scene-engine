# Scene Engine Wire v2

The only wire identity is `scene-engine-wire@2`. One WebSocket binary message is one complete packet. Multibyte container
integers are little-endian.

The 16-byte fixed header is `<4sBBHIHH>`: magic `SENG`, major `2`, packet kind, zero flags, JSON-header length, attachment
count, and zero reserved. Each attachment starts with `<BBHI>`: kind, encoding (`0=raw`, `1=JSON`), zero flags, and length.
Unknown fields/kinds, duplicate JSON keys, invalid UTF-8, BOM, nonfinite values, unsafe integers, truncation, trailing bytes,
reserved bits, and hard-limit violations fail closed.

Packet kinds remain checkpoint `1`, commit `2`, input `3`, ACK `4`, input result `5`, and fatal diagnostic `6`.
Attachment kinds are World snapshot `1`, World patch `2`, Display checkpoint `3`, Display command stream `4`, input payload
`6`, and result payload `7`.

Exact state layouts:

- checkpoint: JSON World snapshot + JSON Display checkpoint;
- commit: JSON World patch + JSON Display command stream;
- input: one JSON payload;
- input result: zero or one JSON result;
- ACK/error: no attachments.

Checkpoint and commit headers carry `stream_id`, `commit_seq`, `source_tick`, `world_revision`, `last_command_seq`,
`world_codec`, and `display_codec=scene-engine-display-node@2`. Commit adds cause and causation ID. ACK is cumulative over
`stream_id`, `commit_seq`, and `last_command_seq`.

The Display checkpoint schema contains `scene_name`, three lowercase SHA-256 catalog identities, its command cursor, and a
parent-first array of complete `py/` roots. The command-stream schema contains base/last cursors and strict sequence records.
Every command carries its exact source tick, has one target name, and is one of create, transform, reparent, visibility,
state, Prefab replacement, or remove.

World patch identity is `scene-engine-json-tree@1`. Operations are `set`, `unset`, and `append`; all paths and values are
validated before mutation. Raw packet bytes are immutable after first encode and packet logs never decode/re-encode them.
Cross-language fixtures live under `fixtures/wire-v2` and `js/packages/client/fixtures/wire-v2`.
