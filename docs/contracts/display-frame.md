# Experimental DisplayFrame binary profile

状态：`scene-engine-display-frame-v1@experimental`。它只约束本仓代码与 fixtures，尚未成为
Missile War current wire。目前冻结的是 dynamic frame 的机械物理布局，不代表完整 renderer-neutral
profile 已冻结；bootstrap、坐标轴/单位、visual/resource manifest 和 extension channel 仍未实现。

## Canonical bytes

所有整数和 IEEE-754 `float32` 使用 little-endian。所有 offset 从 canonical message 第一个
byte 开始。编码不使用 native struct padding、指针或字符串字段。

### DisplayFrameHeaderV1

固定 64 bytes，格式为 `<HHHHQQQQHHIIIII>`：

| Offset | 类型 | 字段 |
| ---: | --- | --- |
| 0 | u16 | schema_version = 1 |
| 2 | u16 | flags，bit 0 = complete dynamic set |
| 4 | u16 | header_bytes = 64 |
| 6 | u16 | section_count |
| 8 | u64 | scene_epoch |
| 16 | u64 | bootstrap_id |
| 24 | u64 | frame_seq |
| 32 | u64 | source_tick |
| 40 | u16 | ticks_per_second |
| 42 | u16 | reserved0 = 0 |
| 44 | u32 | entity_count |
| 48 | u32 | event_count；首切片固定为 0 |
| 52 | u32 | payload_bytes |
| 56 | u32 | directory_bytes = section_count * 20 |
| 60 | u32 | reserved1 = 0 |

总长度必须精确等于 `64 + directory_bytes + payload_bytes`。

### SectionDirectoryEntryV1

固定 20 bytes，格式为 `<HHIIIHH>`。目录按 `section_type` 严格递增，payload 与目录同序，
range 不得重叠或越界，payload 至少 4-byte aligned。

当前只注册：

- `section_type = 1`：required dynamic entity records；
- `flags bit 0 = required`。

### DynamicEntityRecordV1

当前 AoS record 固定 72 bytes，格式为 `<QII3f4f3fIQI>`：

| Offset | 类型 | 字段 |
| ---: | --- | --- |
| 0 | u64 | display_id，必须大于 0且逐 record 严格递增 |
| 8 | u32 | visual_type_id，必须大于 0 |
| 12 | u32 | flags，首切片只定义 bit 0 = visible；其他位尚未成为 profile 语义 |
| 16 | f32[3] | absolute world position |
| 28 | f32[4] | absolute world quaternion xyzw |
| 44 | f32[3] | absolute world scale |
| 56 | u32 | animation_state_id |
| 60 | u64 | animation_start_tick |
| 68 | u32 | animation_flags |

Quaternion 必须有限且归一化误差不超过 `1e-3`。其他 float 也必须有限。record 表示完整替换，
不允许从上一帧继承字段。

一个 epoch 内的新 `display_id` 必须由单调 allocator 产生。一旦某 ID 从某份 producer frame 缺席，
后续任何 frame 都不能再次使用它；`DisplayIdentityTracker` 观察 mailbox 覆盖前的每份 producer frame，
用 current active set + `max_seen_display_id` 有界验证该规则。consumer 的检查只是额外防线，不能从
自己跳过的 frame 推断 lifecycle。ID 即将耗尽前必须建立新 epoch；自动 rollover 尚未实现。

## Limits

首切片由 runtime/config 显式提供 `maximum_frame_entities` 和 `maximum_frame_bytes`；decoder 在遍历
record 前先检查 header、directory、总长度和这些预算。首切片不支持 event 或 extension section。
结构 parser 只验证 `ticks_per_second > 0`；具体 profile consumer/host 必须冻结精确值，Missile War
实验 profile 使用 60。

## PacketHeaderV1

transport envelope 固定 24 bytes，格式为 `<4sHBBHHIII>`：

- magic = `SEDF`；packet_version = 1；
- message_type 目前只接受 `2 = display.frame`；
- compression_codec 目前只接受 `0 = none`；
- header_bytes = 24，reserved0 = 0；
- codec-none 要求 `stored_bytes == uncompressed_bytes`；
- packet 总长度精确等于 `24 + stored_bytes`。

未来 compression codec 必须逐 packet 独立并发布新的跨语言 golden vectors。

任何 header、directory、record offset/stride 或已定义 flag 语义的不兼容变化，都必须使用新的
`schema_version` 和独立 golden fixture；不能只改本文与现有 fixture 后继续声明 schema 1。
