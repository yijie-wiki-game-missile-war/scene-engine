# Recording and Replay

The packet-log identity is `scene-engine-packet-log@1`. A sealed directory contains:

```text
manifest.json
index.json
packets.bin
```

While writing, `INCOMPLETE` is present. `packets.bin` is authoritative and repeats `[u64 LE packet_length][exact packet]`.
The index is canonical JSON records with exact fields
`{stream_id,commit_seq,source_tick,world_revision,offset,packet_length,checkpoint}`; offset points to the first packet byte after
its length prefix. It is rebuildable from the packet file.

Recording starts with a checkpoint, then contains only state commits plus optional periodic checkpoints. Every record stays in
one stream. Commits advance commit and revision by one and obey cause/tick progression. A periodic checkpoint repeats the
immediately preceding cursor exactly and never creates a commit. Seal flushes packets, writes and hashes the index, writes the
manifest, then removes the incomplete marker. Writer/encode/seal failure is runtime-fatal.

The JS reader accepts only bytes:

```js
readPacketLog({
  manifest: Uint8Array,
  index: Uint8Array,
  packets: Uint8Array,
})
// -> {manifest, entries, records, packetAt(index)}
```

It validates exact fields/types, safe integers, hashes, byte counts, framing, packet kinds, full stream progression, index
equality, and manifest cursors. Each record is `{entry,rawBytes,packet}` using the same decoder as live.

Linear Replay creates one client, applies the selected initial checkpoint, then applies commits. It skips later same-cursor
periodic checkpoints; they are seek anchors, not live resets. Seek chooses the nearest earlier checkpoint, creates a fresh
`SceneEngineClient`, applies that checkpoint, and continues commits. Playback/transmission uses exact recorded packet bytes and
never copies the decoder or synthesizes a state checkpoint.

The npm package contains valid fixture files at `fixtures/packet-log/{manifest.json,index.json,packets.bin}` and a malformed
variant under `fixtures/packet-log/malformed/`. The valid fixture contains an initial checkpoint, two commits, and a second
same-cursor periodic checkpoint so both linear-skip and fresh-client seek behavior are testable from the published package.
