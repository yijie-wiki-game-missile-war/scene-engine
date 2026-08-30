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

The JavaScript reader validates fields, hashes, byte counts, packet framing, full stream progression, rebuilt index equality,
and manifest cursors using the same decoder as live.

Packet-log schema is `@3`: it records opaque Wire v3 bytes and does not interpret Transform layout. Current logs carry
`display_codec=scene-engine-display-node@5` and SDCP/SDCS payload v2 in those exact packets; an old Display codec fails at
the normal Wire/Client boundary rather than being migrated during Replay.

Linear Replay creates one `SceneEngineClient`, applies the initial checkpoint, and applies subsequent commits in order while
skipping same-cursor seek anchors. Seek chooses the nearest earlier checkpoint, creates a fresh client and Display session,
then reapplies exact recorded commit bytes. Replay has no alternate decoder, synthetic display baseline, or duplicate Node
graph. Playback speed changes wall scheduling only; record order and integer tick remain authoritative.
