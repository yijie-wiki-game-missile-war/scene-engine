# Scene Engine Wire v1

The only wire identity is `scene-engine-wire@1`. One WebSocket binary message is one complete packet. All multibyte container
integers are little-endian.

## Container

The 16-byte fixed header is `<4sBBHIHH>`: magic `SENG`, major `1`, packet kind, zero flags, UTF-8 JSON header length,
attachment count, and zero reserved. Each attachment begins with `<BBHI>`: attachment kind, `0=raw` or `1=JSON`, zero flags,
and payload length. Unknown kinds/fields, duplicate JSON keys, invalid UTF-8, BOM, truncation, trailing bytes, nonzero reserved
values, and hard-limit violations fail closed.

Packet kinds are checkpoint `1`, commit `2`, input `3`, ACK `4`, input result `5`, and fatal diagnostic `6`. Attachment kinds
are world snapshot `1`, world patch `2`, scene bootstrap `3`, scene frame `4`, input payload `6`, and result payload `7`.
Numeric attachment kind `5` is unassigned and rejected. The exact ordered layouts are:

- checkpoint: JSON snapshot, raw bootstrap, raw complete frame;
- commit: JSON patch, optional raw complete frame;
- input: one JSON payload;
- input result: zero or one JSON result;
- ACK and fatal diagnostic: none.

Checkpoint/commit headers carry `stream_id`, `commit_seq`, `source_tick`, `world_revision`, world codec, and scene codec.
Commit additionally carries cause `tick|input|system` and nullable causation ID. Input carries input ID, observed stream/commit,
command, and args. Header fields are exact and discrete counters are non-negative JavaScript-safe integers.

## JSON numbers and canonical bytes

Product snapshot, patch values, input args, and result values allow safe Python integers plus any finite IEEE-754
float, including `1.0`, `-0.0`, `1e-7`, and `1e20`. `NaN`, both infinities, and lexical integers outside the JavaScript-safe
range are rejected. Boolean is not treated as a number. A larger product integer must use a product-defined tagged string.

Raw packet bytes are canonical and immutable after their first producer encode; consumers and packet logs never decode then
re-encode them. Cross-language compatibility requires equal numeric meaning on decode, not equal number spelling from two
independent native encoders. Python state encoding uses `json.dumps(..., allow_nan=False)`: it writes `1.0` and `-0.0`, and JS
decode preserves the latter as negative zero. JS input encoding uses ECMAScript spelling, normalizes negative zero to `0`, and
uses exponent spelling for finite integral-valued Numbers outside the safe integer range so Python treats them as floats.
Neither side claims JCS equivalence.

## JSON tree patch

World patch identity is `scene-engine-json-tree@1` with exact `{schema, changes}`. Operations are `set`, `unset`, and `append`.
Paths are nonempty arrays of bounded string or non-negative safe-integer segments. Changes use UTF-8 path order, cannot repeat
or overlap as ancestor/descendant, and reject dangerous object path segments. All operations are validated before one commit.
The JS client clones only changed ancestors, freezes new values/ancestors, and reuses every untouched branch by identity.
Sibling array changes address the original array: implementations apply numeric siblings high-to-low, so multiple unsets and
mixed set/unset operations have identical Python/JavaScript results. Dangerous keys are rejected in snapshots and patch values
as well as paths. A custom packet `maximum_json_depth` applies to header and attachment encode/decode on both languages.
The product snapshot validator permits up to 4,000,000 JSON values. The shared wire defaults use a 64 MiB packet/session
ceiling and permit one attachment up to 48 MiB. This covers both the initial and 600-tick reconnect/recording checkpoints for
the frozen 500-node Missile War world while retaining explicit finite bounds.

Scene events exist only as binary `SceneEvent` records inside the raw scene-frame attachment; there is no independent product
JSON event attachment. The hard-limit defaults live in both codecs and the cross-language fixture corpus under
`fixtures/wire-v1`.
