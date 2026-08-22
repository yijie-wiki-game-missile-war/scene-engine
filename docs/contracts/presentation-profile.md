# Scene Presentation V3 mechanical contract

状态：Scene Engine `0.4.0`；破坏性 V3，production 不提供 V1/V2 decoder fallback。

本文冻结通用 `SceneBootstrapV3`、`PresentationFrameV3`、opaque authority cursor 与
`scene-presentation-control-v2@1`。所有整数和 IEEE-754 `float32` 均为 little-endian。section offset 从
inner message byte 0 计算；section 按下表固定顺序连续排列、4-byte aligned、无 native padding。

## 共用 packet 与 directory

packet envelope 仍为 24-byte `<4sHBBHHIII>`：magic `SEDF`、packet version `1`、message type
`1 = scene.bootstrap / 2 = presentation.frame`、codec `0 = none`、header bytes `24`。flags/reserved 必须为
零；stored/uncompressed length 必须相等；truncation 和 trailing bytes 均拒绝。

每个 inner message 使用 20-byte section directory entry `<HHIIIHH>`：

```text
section_type:u16, flags:u16, record_count:u32, byte_offset:u32,
byte_length:u32, record_stride:u16, reserved0:u16
```

V3 的每个列出 section 都带 `required = 1`。unknown/reordered/duplicate section、offset hole/overlap、非 4-byte
alignment、错误 stride/count/length、非零 reserved 和尾随字节全部 fail closed。byte blob 的
`record_count` 是逻辑 byte 数，`byte_length = align4(record_count)`，padding 必须为零。

## SceneBootstrapV3

header 是精确 96-byte `<HHHHQQHHfIIII32s16s>`：

| offset | 类型 | 字段 |
| ---: | --- | --- |
| 0 | u16 | schema_version = 3 |
| 2 | u16 | flags = complete-static-set (`1`) |
| 4 | u16 | header_bytes = 96 |
| 6 | u16 | section_count = 11 |
| 8 | u64 | scene_epoch，positive |
| 16 | u64 | bootstrap_id，positive |
| 24 | u16 | ticks_per_second = 60 |
| 26 | u16 | coordinate_profile = `RH / Y-up / Z-forward / xyzw / f32` (`1`) |
| 28 | f32 | world_units_per_meter，finite positive |
| 32 | u32 | maximum_dynamic_nodes |
| 36 | u32 | maximum_frame_bytes，positive |
| 40 | u32 | directory_bytes = 220 |
| 44 | u32 | payload_bytes |
| 48 | byte[32] | SHA-256(directory + payload) |
| 80 | byte[16] | zero reserved |

11 个 required sections：

| type | 内容 | stride |
| ---: | --- | ---: |
| 1 | session identity | variable / 0 |
| 2 | authority baseline envelope | variable / 0 |
| 3 | complete static `PresentationNodeRecordV3` set | 80 |
| 4 | 每个 static node 的 profile ref | 24 |
| 5 | profile opaque bytes | 1 |
| 6 | 每个 static node 的 interaction ref | 24 |
| 7 | interaction opaque bytes | 1 |
| 8 | scene metadata refs | 16 |
| 9 | scene metadata opaque bytes | 1 |
| 10 | visual type registry | 16 |
| 11 | animation state registry | 16 |

session identity header 为 `<HHHIH>`，随后依次是 non-empty NFC UTF-8 `run_id/viewer_scope/profile_id`；三段
UTF-8 bytes 的总长度不得超过 `4096`。authority baseline header 为 `<HIIH>`，随后是 codec identity UTF-8
与 non-empty opaque canonical cursor bytes。codec identity 必须是 NFC canonical ASCII identity、匹配
`[A-Za-z0-9][A-Za-z0-9._:@/-]*` 且不超过 `160` bytes；cursor bytes 不得超过 `16 KiB`。binary decoder
与 control `AuthorityCursorEnvelope` 使用同一组 identity/cursor 上限，不允许 binary Bootstrap 绕过 control
envelope validator。

scene metadata ref 是 `<IIII>`：`metadata_type_id, flags, blob_offset, blob_length`。type 严格递增；V3 flags
为零；bytes non-empty、连续且无尾随。Engine 保留这些通用 typed opaque refs，产品 adapter 按明确 type ID
查询，Engine 不解释 payload。

visual type record 是 `<IIII>`：`visual_type_id, flags, profile_type_id, interaction_type_id`。animation state
record 是 `<IIII>`：`animation_state_id, flags, duration_ticks, reserved0=0`。registry ID 严格递增，引用必须存在。

Bootstrap static set 自身必须形成闭合 parent tree；不能引用未来 frame 才会出现的 parent。Python encoder、
decoder 和通用 tree helper 都显式验证 parent closure、cycle、maximum depth 与 pose。

## PresentationFrameV3

header 是精确 80-byte `<HHHHQQQQQHHIIIIIII>`：

| offset | 类型 | 字段 |
| ---: | --- | --- |
| 0 | u16 | schema_version = 3 |
| 2 | u16 | flags = complete-dynamic-set (`1`) |
| 4 | u16 | header_bytes = 80 |
| 6 | u16 | section_count = 7 |
| 8 | u64 | scene_epoch |
| 16 | u64 | bootstrap_id |
| 24 | u64 | frame_seq |
| 32 | u64 | source_tick |
| 40 | u64 | projection_id |
| 48 | u16 | ticks_per_second = 60 |
| 50 | u16 | reserved0 = 0 |
| 52 | u32 | node_count |
| 56 | u32 | non-empty profile_count |
| 60 | u32 | non-empty interaction_count |
| 64 | u32 | payload_bytes |
| 68 | u32 | directory_bytes = 140 |
| 72 | u32 | event_count |
| 76 | u32 | reserved1 = 0 |

7 个 required sections：

| type | 内容 | stride |
| ---: | --- | ---: |
| 1 | complete dynamic `PresentationNodeRecordV3` set | 80 |
| 2 | 每个 node 的 profile ref | 24 |
| 3 | profile opaque bytes | 1 |
| 4 | 每个 node 的 interaction ref | 24 |
| 5 | interaction opaque bytes | 1 |
| 6 | presentation events | 48 |
| 7 | event opaque bytes | 1 |

每帧都是当前完整 dynamic set，不是 patch。`scene_epoch/bootstrap_id` 必须匹配已安装 Bootstrap；正常 epoch
内 frame sequence 连续，source tick 只能保持不变或前进一个 60 Hz tick。同 tick 多帧按 frame sequence 排序。

## PresentationNodeRecordV3

static 与 dynamic 共用精确 80-byte `<QQII3f4f3fIQI>`：

| offset | 类型 | 字段 |
| ---: | --- | --- |
| 0 | u64 | display_id |
| 8 | u64 | parent_display_id；0 = scene root |
| 16 | u32 | visual_type_id |
| 20 | u32 | flags；bit 0 = visible |
| 24 | f32[3] | local_position |
| 36 | f32[4] | local_rotation_xyzw |
| 52 | f32[3] | local_scale |
| 64 | u32 | animation_state_id；0 = none |
| 68 | u64 | animation_start_tick |
| 76 | u32 | animation_flags |

`local_*` 是当前完整 local pose，不是 delta。position/rotation/scale 必须 finite，quaternion normalized，scale
每轴 positive。scene root child 的 local pose 等价于 world pose；其余 world pose 只由 Engine 按 parent chain
派生。node 按 positive `display_id` 严格递增；非零 parent 必须是静态节点或 canonical 顺序中已出现的同帧
dynamic node。完整 static+frame tree 必须满足 closure、无环和配置的 maximum depth。

一个 scene epoch 内 static ID 先分配，dynamic ID 只能从更高值继续单调分配。Engine 仅保留
`max_seen_display_id` 标量；一个 ID 从完整 dynamic set 消失后不得重新出现，不维护随 session 增长的 retired set。

## Typed opaque node payload

profile 和 interaction 都使用精确 24-byte `<QIIII>` ref：

```text
display_id:u64, payload_type_id:u32, flags:u32,
blob_offset:u32, blob_length:u32
```

每个 node 在两个 ref section 中各有且只有一条同序 ref，因此按 slot O(1) 查询。absent payload 固定为
`payload_type_id=0, flags=0, blob_length=0`；present payload type positive、bytes non-empty。offset 必须从零连续，
不得 alias、overlap、hole 或 trailing。V3 通用 Engine 把 MW profile payload 保持为 opaque borrowed view；节点
实际 payload type 必须与 visual registry 声明严格相等，absent payload 的实际 type 按 `0` 比较。因此 registry
声明 non-zero type 时 payload 必须存在，registry 声明 `0` 时 payload 必须 absent；字段解释属于 MW adapter。

## PresentationEventV3

event record 是精确 48-byte `<QIIQQQII>`：

```text
event_id:u64, event_type_id:u32, flags:u32,
source_display_id:u64, target_display_id:u64, start_tick:u64,
payload_offset:u32, payload_length:u32
```

event ID positive 严格递增；type positive；`start_tick <= source_tick`；payload offsets 连续。event bytes 可为空。

## Decoder 与 tree ownership

JavaScript codec 的 `SceneBootstrapV3View` / `PresentationFrameV3View` 保留 raw `Uint8Array`，通过
`displayIdAt/parentDisplayIdAt/.../readLocalPose/readProfileStateAt/readInteractionAt` borrowed accessors 读取；
decode 不构造每节点 object/pose arrays。Bootstrap decoder 拥有 registry 上下文，因此必须立即验证 static
node 的 visual/payload type；standalone Frame codec 只验证 frame 自身的结构，因为 frame bytes 不重复携带
visual registry。Frame 的 registry/required-payload 校验必须在已安装 Bootstrap 上下文中由唯一公共
`SceneDisplayEngine.prepareFrames(frames)` 完成；live 与 Replay ingest 都不得绕过该 gate。内部
`PresentationSceneTree` 是 static + dynamic node、parent/local/world pose、profile/interaction、metadata、
frame sequence、source tick、projection 与 ID lifecycle 的唯一 owner；correlation 顺序只属于 session 和
产品 coordinator，不进入 tree/view/capture。

常驻状态是 bounded dense SoA typed storage；old/new dynamic set 通过按 ID 双指针线性 merge 生成
create/remove/reparent/pose/visibility/visual/profile/animation/interaction change plan。
`prepareFrames(frames)` 只接受 `1..maximumFramesPerBatch` 份完整 frame，并返回有序 frozen
`steps: [{plan, view, events}]`。renderer plan 不含 events。prepared token 必须先同步调用
`assertCommittable()`，之后 `commitValidated()` 只做最终 state pointer swap 与必要 counters；失败或放弃时
调用 `abort()` 释放 borrowed payload。`commitValidated()` 不调用 capture observer、也不排 microtask；产品
coordinator 必须先完成 business/tree/joint cursor 三个 pointer swap，再调用
`schedulePostCommitCapture()` 排入 coalesced、受保护的 observer microtask。零 frame 的 business-only
correlation 不调用 Engine frame prepare，但联合 pointer barrier 后仍可调度最新 Engine capture。

## Control、Archive 与 conformance

control identity 仍为 `scene-presentation-control-v2@1`（canonical UTF-8 JSON）；V3 指的是 binary scene
contract，不重解释 control schema。Archive identity 为 `scene-presentation-archive-v3@1`，Node 包为
`@scene-engine/presentation-archive-node`，其 Node production surface 只读取、验证和 seek；exact V3
packet/correlation bytes 由 Python writer 保存并使用 checkpoint directory。

Python/JavaScript 必须对 shared V3 golden 和 malformed corpus 得到相同 bytes/结论。任何不兼容 layout
必须增加 schema version，并同步 workspace generated profile、writer/decoder、tree、Archive verifier、下游包
SHA 与 release manifest；不得在 production 以 alias 或 dual decoder 保留旧 schema。
