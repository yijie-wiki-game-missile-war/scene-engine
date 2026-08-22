# Presentation Archive V3

状态：Scene Engine V3 candidate；schema `scene-presentation-archive-v3@1`。

Archive 保存 exact BootstrapV3、PresentationFrameV3 与 canonical correlation bytes，并绑定 source authority
artifact SHA-256。Python 提供 streaming writer；JavaScript 包正式命名为
`@scene-engine/presentation-archive-node`，依赖 `node:crypto` 与 Node file APIs，不声明 browser compatibility。

## 文件集合

一个 archive 恰好由三份正式文件组成：

```text
presentation-manifest.json
presentation-index.bin
presentation-segments.bin
```

manifest 是单行 canonical JSON。index 和 segment/block 都是 little-endian、无 native padding。

manifest exact-key set（unknown/missing field 拒绝）为：

```text
archive_root_sha256
authority_cursor_codec_identity
checkpoint_count
checkpoint_directory_sha256
compression_codecs
correlation_count
end_tick
entry_count
exporter_identity
frame_count
hard_limits
index_entries_sha256
index_payload_sha256
profile_identity
resource_manifest_identity
scene_engine_identity
schema_identity
segment_count
segments_sha256
source_authority_artifact_identity
source_authority_sha256
start_tick
visual_manifest_identity
```

`hard_limits` exact keys 为 `maximum_block_bytes/maximum_cursor_bytes/maximum_entries/maximum_segments`；
`compression_codecs` 当前只能是 `['none']`；`checkpoint_count == segment_count`。

## Index V3

112-byte index header：

```text
<4sHHHHQQQ32s32s12s>
magic = SEIX
version = 3
header_bytes = 112
index_entry_bytes = 112
checkpoint_directory_entry_bytes = 48
entry_count
checkpoint_count
checkpoint_directory_offset
index_entries_sha256
checkpoint_directory_sha256
zero reserved[12]
```

header 后先连续保存 `entry_count` 个 112-byte block index entry：

```text
<HHIQQQQQQQQII32s>
kind: u16
flags: u16 = 0
segment_id: u32
record_seq: u64
scene_epoch: u64
bootstrap_id: u64
correlation_seq: u64
frame_seq: u64
source_tick: u64
projection_id: u64
data_offset: u64
data_length: u32
uncompressed_length: u32
payload_sha256: bytes[32]
```

之后保存按 `checkpoint_id` 严格递增排序的 checkpoint directory。directory 固定记录为：

```text
<QI4xQQQQ>
checkpoint_id: u64
segment_id: u32
zero reserved: 4 bytes
index_entry_number: u64
scene_epoch: u64
bootstrap_id: u64
source_tick: u64
```

`index_entry_number` 是从零开始的 block index entry 编号，必须直接指向字段完全一致的 checkpoint block。
因此 `openCheckpoint()` 对已加载的小型目录做二分查找，复杂度为 `O(log C)`，随后从精确 index entry
顺序 iterate 当前 segment；不得扫描全部 frame/correlation index。

manifest 分别绑定 `index_entries_sha256`、`checkpoint_directory_sha256`、两者按物理顺序拼接后的
`index_payload_sha256`，并继续绑定 `segments_sha256` 与 archive root。block version 为 `3`，每次读取仍验证
block header、长度和 payload SHA-256。

segment block header 是 64-byte `<4sHHIIQII32s>`：magic `SEAB`、version `3`、kind、compression
`0 = none`、segment ID、record sequence、stored length、uncompressed length 和 payload SHA-256。
`archive_root_sha256 = SHA256(bytes(index_payload_sha256) || bytes(segments_sha256))`。

## API 与验证边界

Node reader 只保留 `manifest()`、`checkpoints()`、`openCheckpoint()`、`iterateFrom()`、`verify()` 与
`close()`。没有真实调用方的全局 `readFrame`、`readCorrelation`、`readBySequence` 已删除，避免维持会线性
扫描 index 的名义随机访问。

完整 `verify()` 用于 ingest/显式审计；它顺序验证 index、directory、所有 block、counts、identity、tick、
hash 和 root。正常 playback 先信任产品层保存的 verified root identity，再通过 checkpoint directory 定位，
并对实际读取的每个 block 做独立 hash 验证，而不是每次连接前全量扫描 archive。

Python writer 在 correlation 前最多暂存 8 个 frame，并要求 `frame_refs` 与刚写入的 pending frame 批次
顺序、数量完全一致；第 9 个未关联 frame 在写 block 前即被拒绝。Node package 不提供 writer 或 file sink；
其 reader conformance 测试读取由 Python 正式 writer 生成并提交的跨语言固定 fixture，覆盖 checkpoint/seek、
zero-frame correlation、multi-segment/new epoch、corruption、truncation 与 hash 验证。
