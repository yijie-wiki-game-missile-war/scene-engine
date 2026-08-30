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
and `display_codec=scene-engine-display-node@5`. Commit adds cause and causation ID. ACK is cumulative over stream, commit and
last command cursor.

The Display checkpoint contains:

```text
last_command_seq
scene_name
scene_catalog_hash
prefab_catalog_hash
state_schema_hash
parent-first complete py/ roots
```

The three hashes come from `scene-engine-display-catalog-manifest@2`: JavaScript canonicalizes the installed Scene,
Prefab/Resource/Component and authority-state schema definitions, writes a build identity artifact, and Python loads those exact
values. Wire transports the identities; it does not invent or recompute product catalog content.

The command stream contains a base cursor, source-tick seal and strict `scene-engine-node-command@5` records. Sequence is the
base plus one-based record order, last cursor is base plus count and the sealed source tick must equal the packet header. Every command has one target and is
create, transform, reparent, visibility, complete state replacement, exact Prefab replacement or remove.

Python's typed outbound mutation path treats each target name as a product-owned string already established by the baseline,
so it checks only the string type, encoding and byte bounds while writing the hot command stream. Python raw-record/binary
decoders and the JavaScript Client still validate canonical `py/` syntax; Client performs that validation before any Authority
mutation or ACK. New checkpoint Nodes and structural parent names remain fully Python-validated.

## Binary Display payloads

Both raw Display payloads begin with a four-byte kind magic (`SDCP` checkpoint or `SDCS` command stream), payload version `2`,
scalar code `1` (`float32`) and zero `u16` flags. Strings are fatal UTF-8 prefixed by `u16` byte length. Nullable strings use
length `0xffff`; ordinary strings cannot use that length. State remains canonical finite/safe-integer JSON prefixed by a `u32`
byte length. SHA-256 identities are transported as their 32 raw bytes. Python's structural decoder rejects unknown scalar
codes, opcodes or flags, malformed UTF-8 or JSON, invalid lengths, truncation and trailing bytes. Matrix semantics are checked
later by the JavaScript Client before Authority mutation or ACK.

Checkpoint then stores `last_command_seq` as `u64`, scene name, the three hashes and a `u32` Node count. The cursor seal must
equal the packet header. Each parent-first Node stores name, a `u32` parent
index (`0xffffffff` for no parent), Prefab ID, one flags byte (`bit 0=visible`, `bit 1=live Transform`, all other bits zero), one
matrix and state. A non-null parent index must refer to an earlier Node.

Command stream then stores `base_command_seq` and `source_tick` as `u64`, followed by command count as `u32`. Each record starts
with one opcode byte and the target name, followed by exactly these variant fields in order:

```text
1 create          nullable parent name, Prefab ID, flags byte, matrix, state
2 set-transform   matrix
3 set-parent      nullable parent name
4 set-visible     u8 boolean (0 or 1)
5 set-state       state
6 replace-Prefab  Prefab ID, state
7 remove          no variant fields
```

Safe-integer cursor bounds and exact packet-header cursor/tick agreement remain mandatory.

Every transmitted Transform is the complete 16-value, column-major 4x4 local matrix carried as `64` little-endian IEEE-754
binary32 bytes. The typed Python publication path's sole persistent Transform storage is one private NumPy `ndarray` with
shape `(4, 4)`, dtype `<f4`, Fortran-contiguous column-major layout and `writeable=False`. The SDCP/SDCS encoder reads this owner
in column-major order and emits its exact 64 bytes without composition, negative-zero normalization, finite checks,
affine-row checks or determinant checks.

The existing public API remains stable. `DisplayTransform(matrix_bytes=...)` accepts only an immutable `bytes` object of
exactly 64 bytes and copies those sixteen bit patterns into the array owner; `from_matrix(...)` converts exactly sixteen
column-major numeric values to little-endian float32 and likewise does not inspect matrix semantics. `matrix` returns the
immutable 16-value public representation. `matrix_bytes` returns an exact temporary 64-byte serialization; it is not the
persistent owner and callers must not rely on object identity with constructor input.

The JavaScript Client is the first semantic acceptance gate. It converts negative zero to positive zero and requires finite
values, the exact affine row (`m[3]=m[7]=m[11]=0`, `m[15]=1`) and a strictly positive upper-left 3x3 determinant. This admits
right-handed affine shear and rejects reflections and singular matrices before Authority mutation or ACK. Display repeats the
same check defensively and stores the accepted matrix without TRS decomposition. float16 and the old TRS object shape are not
part of the wire contract.

World patch identity is `scene-engine-json-tree@1`; operations are `set`, `unset` and `append`. All paths and values are validated
before mutation. Raw packet bytes are immutable after first encode, and packet logs never decode/re-encode them. Cross-language
fixtures live under `fixtures/wire-v3`, `fixtures/display-v5`, `fixtures/display-catalog-v2` and the Client fixture directories.
`scripts/generate_fixtures.py` is their sole writer; the Client package's JavaScript generator delegates to it. The canonical
cross-language corpus includes a sheared affine matrix and the Client asserts its packaged Wire files are byte-identical to the
root corpus.
