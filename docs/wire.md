# Scene Engine Wire v3

The only wire identity is `scene-engine-wire@3`. One WebSocket binary message is one complete packet. All multibyte Wire
integers and scalars, including values inside raw Display payloads, are little-endian.

The fixed header is `<4sBBHIHH>`: magic `SENG`, major `3`, packet kind, zero flags, JSON-header length, attachment count and zero
reserved. Each attachment starts with `<BBHI>`: kind, encoding (`0=raw`, `1=JSON`), zero flags and length. Unknown fields or kinds,
duplicate JSON keys, invalid UTF-8, BOM, nonfinite JSON values, unsafe integers, truncation, trailing bytes, nonzero reserved bits and
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

- checkpoint: JSON World snapshot + raw Display checkpoint;
- commit: JSON World patch + raw Display command stream;
- input: one JSON payload;
- input result: zero or one JSON result;
- ACK/error: no attachments.

Checkpoint and commit headers carry `stream_id`, `commit_seq`, `source_tick`, `world_revision`, `last_command_seq`, `world_codec`
and `display_codec=scene-engine-display-node@8`. Commit adds cause and causation ID. ACK is cumulative over stream, commit and
last command cursor.

The Display checkpoint contains:

```text
last_command_seq
matrix_pool_size
matrix_pool[n, 4, 4]
scene_name
scene_catalog_hash
prefab_catalog_hash
state_schema_hash
parent-first active authority-root metadata keyed by node_id
```

The three hashes come from `scene-engine-display-catalog-manifest@2`: JavaScript canonicalizes the installed Scene,
Prefab/Resource/Component and authority-state schema definitions, writes a build identity artifact, and Python loads those exact
values. Wire transports the identities; it does not invent or recompute product catalog content.

The command stream contains a base cursor, source-tick seal, the resulting matrix-pool size, one sorted dirty-ID vector, its
aligned matrix tensor and strict `scene-engine-node-command@8` records. Sequence is the base plus one-based record order, last
cursor is base plus count and the sealed source tick must equal the packet header. Structural/state commands have one target;
one optional Transform-batch command has an arbitrary sorted ID vector and occupies one sequence regardless of its row count.

An authority `node_id` is a little-endian `u32` matrix-pool row in the range `0..0xfffffffe`; `0xffffffff` is reserved solely
for a null parent. IDs are stable for the lifetime of one stream. The pool allocates monotonically, never reuses a removed ID,
and keeps a zero-filled tombstone row until a new stream may compact and renumber. Python never transmits a `py/` name. Client
and Display derive the internal canonical root name `py/<decimal-node-id>`; Scene/Prefab-local canonical paths remain a
browser-only concern.

## Binary Display payloads

Both raw Display payloads begin with a four-byte kind magic (`SDCP` checkpoint or `SDCS` command stream), payload version `5`,
scalar code `1` (`float32`) and zero `u16` flags. Strings are fatal UTF-8 prefixed by `u16` byte length and cannot use length
`0xffff`. Complete state and event payloads are canonical JSON objects; property values may be any canonical JSON value. Every
JSON body is prefixed by a `u32`
byte length. SHA-256 identities are transported as their 32 raw bytes. Python's structural decoder rejects unknown scalar
codes, opcodes or flags, malformed UTF-8 or JSON, invalid lengths, truncation and trailing bytes. Matrix semantics are checked
later by the JavaScript Client before Authority mutation or ACK.

Checkpoint then stores `last_command_seq` as `u64`, `pool_size` and active-Node count as `u32`, followed immediately by the
complete contiguous `pool_size * 16 * f32` matrix tensor. Scene name, the three hashes and the parent-first metadata records
follow the tensor. Each metadata record stores `node_id`, `parent_id` (`0xffffffff` for no parent), Prefab ID, one flags byte
(`bit 0=visible`, `bit 1=live Transform`, all other bits zero) and state. It carries no name or inline matrix. Active IDs are
unique and below `pool_size`; a non-null parent ID must identify an earlier active record. Every inactive/tombstone pool row is
exact positive-zero bits.

Command stream then stores `base_command_seq` and `source_tick` as `u64`, followed by `command_count`, `pool_size_after` and
`dirty_count` as `u32`. The next blocks are exactly `dirty_count` strictly increasing `u32` IDs and one contiguous
`dirty_count * 16 * f32` matrix tensor in the same row order. `0 <= dirty_count <= pool_size_after`; a fully dirty pool where
`dirty_count == pool_size_after` is legal. One SDCS payload has a fixed maximum of `65,536` commands; this is a codec invariant,
not an `EngineLimits` option, and both encoders and decoders reject a larger count before traversing or allocating command
records. Command records follow the tensor. Scalar records start with one opcode byte followed by a target `node_id`; opcode 2
instead carries only a batch-row count because its IDs and matrices already occupy the global dirty blocks:

```text
1 create          node_id, parent_id, Prefab ID, flags byte, state
2 set-transforms  transform_count
3 set-parent      node_id, parent_id
4 set-visible     node_id, u8 boolean (0 or 1)
5 set-state       node_id, state
6 replace-Prefab  node_id, Prefab ID, state
7 remove          node_id
8 set-property    node_id, property name, JSON value
9 unset-property  node_id, property name
10 emit-event     node_id, event name, JSON-object payload
```

Property and event names are `u16`-length fatal UTF-8 with a semantic maximum of 192 bytes. They are non-empty Unicode scalar
sequences and reject `__proto__`, `prototype` and `constructor`. Their forbidden-code-point table is frozen by Display @8:
Unicode 16.0 White_Space plus `Cc`/`Cf`/`Cs`/`Co`, all Unicode noncharacters, but not `Cn`. This fixed table—not the host
runtime's Unicode database—keeps Python 3.11–3.14 and Node 20+ name admission identical; future assignments such as U+088F remain
valid. A dot is an ordinary name character, not a path separator. `null` is a valid set-property value and is distinct from
unset-property.
`maximumJsonDepth` applies to the complete authority state: an opcode 8 property value therefore has a maximum body depth of
`maximumJsonDepth - 1`, because its property member adds one level below the state root. With the default 256, value depth 255
is accepted and 256 is rejected. Event payloads are transient standalone JSON bodies and retain the full limit.
Event metadata `command_seq` and `source_tick` is derived from the normal command-stream cursor; it is not redundantly encoded.
There is no event attachment kind: events use opcode 10 in the same ordered SDCS transaction as every other Display command.

At most one non-empty Transform batch is legal. Its targets are exactly the first `transform_count` dirty IDs; remaining dirty
IDs must exactly equal the create targets. Existing IDs precede newly appended create IDs, so the globally sorted table forms
this partition without transmitting a second ID vector. The two target sets may not overlap. The entire batch remains at one
logical sequence position and increments the cursor once. Safe-integer cursor bounds and exact packet-header cursor/tick
agreement remain mandatory.

The semantic `node-set-transform-batch` record exposes those targets as `node_ids`; only the binary record reduces that field to
`transform_count`, because the exact IDs are already the dirty-table prefix.

Within a stream, `pool_size_after` never shrinks. If it grows from `n` to `n+k`, every new suffix ID `n..n+k-1` must appear in
the dirty table and in a create command in that commit. A create cannot target an older ID, and a removed/tombstoned ID can
never be claimed again. These rules make browser allocation proportional to transmitted matrix data and forbid sparse-ID memory
amplification.

Every transmitted Transform is the complete 16-value, column-major 4x4 local matrix carried as `64` little-endian IEEE-754
binary32 bytes. Python authority roots share one resident `DisplayMatrixPool`. Its backing storage is one contiguous `<f4`
tensor with shape `(n, 4, 4)` and axes `[node, column, row]`, so each pool row is already the exact 64-byte column-major wire
matrix. A checkpoint snapshots all `n` rows once; a commit gathers the sorted dirty IDs and their aligned `(m,4,4)` tensor in
one NumPy operation. The encoder emits those buffers without per-command matrix serialization, composition, negative-zero
normalization, finite checks, affine-row checks or determinant checks.

The Python structural decoder exposes the full/dirty matrix tensor as a read-only C-contiguous `<f4` NumPy array and dirty IDs
as a read-only C-contiguous `<u4` array. These are zero-copy views over the decoder's immutable payload bytes, including the
exact empty shapes `(0,4,4)` and `(0,)`; it does not expand matrix values into nested Python lists. Passing that decoded plain
record back to the semantic encoder is supported without list conversion and preserves every binary32 bit pattern, including
signaling NaN payload bits.

`DisplayTransform(matrix_bytes=...)` accepts only an immutable `bytes` object of
exactly 64 bytes and copies those sixteen bit patterns into the array owner; `from_matrix(...)` converts exactly sixteen
column-major numeric values to little-endian float32 and likewise does not inspect matrix semantics. `matrix` returns the
immutable 16-value public representation. `matrix_bytes` returns an exact temporary 64-byte serialization; it is not the
persistent owner and callers must not rely on object identity with constructor input.

The JavaScript Client is the first semantic validation gate. It copies each checkpoint or dirty tensor into exactly one owned
`Float32Array`, converts negative zero to positive zero and validates every active/dirty row for finite values, the exact affine
row (`m[3]=m[7]=m[11]=0`, `m[15]=1`) and a strictly positive upper-left 3x3 determinant. This admits right-handed affine shear
and rejects reflections and singular matrices before Authority mutation or ACK. Display repeats the same checks defensively,
stages an incremental tensor once; one set-transforms operation atomically consumes the existing-row prefix at the command's
sequence position, while create records claim new-row suffix rows, and each
authority Node reads its local row without TRS decomposition. float16 and the old TRS object shape are not part of the wire
contract.

World patch identity is `scene-engine-json-tree@1`; operations are `set`, `unset` and `append`. All paths and values are validated
before mutation. Raw packet bytes are immutable after first encode, and packet logs never decode/re-encode them. Cross-language
fixtures live under `fixtures/wire-v3`, `fixtures/display-v8`, `fixtures/display-catalog-v2` and the Client fixture directories.
`scripts/generate_fixtures.py` is their sole writer; the Client package's JavaScript generator delegates to it. The canonical
cross-language corpus includes a sheared affine matrix and the Client asserts its packaged Wire files are byte-identical to the
root corpus.
