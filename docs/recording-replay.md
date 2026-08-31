# Recording and Replay

The only packet-log identity is `scene-engine-packet-log@3`. A sealed directory contains `manifest.json`, `index.json`, and
`packets.bin`; `INCOMPLETE` exists until seal succeeds. `packets.bin` repeats `[u64 LE length][exact Engine packet]`.

Index records contain:

```text
stream_id, commit_seq, source_tick, world_revision, last_command_seq,
offset, packet_length, checkpoint
```

Recording begins with a checkpoint. Commits advance commit/revision exactly once, obey tick/cause progression, and carry a
command stream whose base cursor equals the previous record cursor. Periodic checkpoints repeat the immediately preceding
World and Display cursor and serve only as seek anchors. The manifest hashes packets and index bytes and records first/last
commit, tick, and command cursors.

The recorder validates each Engine packet once through the live Wire decoder. After that validation, progression indexing reads
the decoder's package-private Display result; the public raw attachment remains exact bytes, and recording does not decode the
matrix tensor and command stream a second time.

Packet-log validation also preserves the stream-wide Authority MatrixPool lifecycle. The initial checkpoint establishes the
pool size, active IDs and the complementary historical tombstone IDs. A commit cannot shrink the pool or create an already
allocated ID; every newly allocated suffix ID must be both dirty and created in that commit, and successful removes become
permanent tombstones. A same-cursor periodic checkpoint must repeat exactly the current pool size and active-ID set. Therefore
linear Replay and seek cannot fork ID meaning by shrinking the pool or resurrecting a removed row.

The JavaScript reader validates fields, hashes, byte counts, packet framing, full stream progression, rebuilt index equality,
and manifest cursors using the same decoder as live.

Packet-log schema is `@3`: it records opaque Wire v3 bytes and does not interpret Transform layout. Current logs carry
`display_codec=scene-engine-display-node@8` and SDCP/SDCS payload v5 in those exact packets; an old Display codec fails at
the normal Wire/Client boundary rather than being migrated during Replay.

Node properties are durable authority state and must be present in a later checkpoint's complete state. Node events are
transient SDCS commands: linear Replay dispatches each recorded event at its original command position, while a seek beginning
from a later checkpoint does not invent events that occurred before that anchor. A lasting death/explosion phase therefore
needs a property (optionally with its logical start tick); an event alone represents only the one-time notification.

Linear Replay creates one `SceneEngineClient`, applies the initial checkpoint, and applies subsequent commits in order while
skipping same-cursor seek anchors. Seek chooses the nearest earlier checkpoint, creates a fresh client and Display session,
then reapplies exact recorded commit bytes. Replay has no alternate decoder, synthetic display baseline, or duplicate Node
graph. Playback speed changes wall scheduling only; record order and integer tick remain authoritative.
