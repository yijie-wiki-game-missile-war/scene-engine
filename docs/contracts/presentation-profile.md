# Missile War Ordered Presentation Profile

状态：`mw-scene-presentation-v1@1` migration candidate；只有完整 workspace release manifest 才能激活。

本文冻结 `SceneBootstrapV1`、`DisplayFrameV2` 与 `scene-display-control-v1@1` 的物理合同。所有 binary
整数与 IEEE-754 `float32` 使用 little-endian；offset 从 inner message byte 0 计算；所有 section 按 type
递增、4-byte aligned、无 native padding。Python 与 JavaScript fixture 必须 byte-identical。

## 1. PacketHeaderV1

沿用 24-byte `<4sHBBHHIII>`：

- magic `SEDF`，packet version `1`；
- message type `1 = scene.bootstrap`，`2 = display.frame`；其他值拒绝；
- codec `0 = none`，flags/reserved 为 0，header bytes `24`；
- stored/uncompressed length 均为 u32，codec-none 时必须相同，packet 不得截断或尾随。

## 2. 共用 section directory

20-byte `<HHIIIHH>`：`section_type/flags/record_count/byte_offset/byte_length/record_stride/reserved0`。
所有当前 section 都带 required bit 0；unknown、duplicate、reordered、overlap、hole、misalignment、bad stride、
bad count/length 或 nonzero reserved 均拒绝。variable section 的 stride 为 0，其 canonical bytes 由对应章节定义。

## 3. SceneBootstrapV1

### 3.1 96-byte header

格式 `<HHHHQQHHfIIII32s16s>`：

| Offset | 字段 |
| ---: | --- |
| 0 | schema `1` |
| 2 | flags：bit 0 complete static set，且只能为该值 |
| 4 / 6 | header bytes `96` / section count `6` |
| 8 / 16 | positive u64 scene epoch / bootstrap ID |
| 24 | TPS，精确 `60` |
| 26 | coordinate profile `1`：right-handed、Y-up、Z-forward、quaternion xyzw、f32 |
| 28 | positive finite f32 world units per meter |
| 32 / 36 | producer maximum dynamic entities / maximum frame bytes |
| 40 / 44 | directory bytes `120` / payload bytes |
| 48 | SHA-256 of `directory + payload` |
| 80 | 16 zero reserved bytes |

consumer local hard limit 与 producer limit 取更严格值；header 不能放宽本地预算。

### 3.2 required sections

| type | record | stride | canonical rule |
| ---: | --- | ---: | --- |
| 1 | identity | 0 | exactly one variable record |
| 2 | static node | 80 | display ID strictly increasing |
| 3 | topology node | 32 | static display ID strictly increasing |
| 4 | adjacency | 16 | endpoint pair ascending，records lexicographic |
| 5 | visual registry | 32 | visual type ID strictly increasing |
| 6 | animation registry | 16 | animation state ID strictly increasing |

Identity header 为 32-byte `<HHHHHHIQQ>`：依次记录 run/viewer/profile/state-stream/state-epoch/snapshot UTF-8
byte lengths、总 string bytes、initial state seq 与 world revision，随后按同序紧密拼接 NFC UTF-8，尾部只允许
0-padding 到 4-byte alignment。字符串非空、无首尾空白/NUL、总计不超过 4096 bytes。

Static node 为 `<QQIIII3f4f3fII>`：display/parent、visual/owner、flags/reserved、absolute position/quaternion/
scale、variant/content。parent 必须为 0 或已出现 ID；flags 只定义 visible bit；visual/owner/content positive。

Topology node 为 `<QIIiiII>`：static display、island/tile registry、axial q/r、terrain registry、flags。
Adjacency 为 `<QQ>`，两端必须存在于 topology set。

Visual registry 为 `<IIIIIIII>`：visual、owner、variant、capability flags、resource content、placement profile、
animation range start/count。capability bits：interactive/attachment/effect。Animation 为 `<IIII>`：state、
loop/once/blend flags、positive duration ticks、zero reserved。所有 cross-reference 必须在完整验证后一起安装。

## 4. DisplayFrameV2

### 4.1 80-byte header

格式 `<HHHHQQQQQHHIIIIIII>`：

| Offset | 字段 |
| ---: | --- |
| 0 | schema `2` |
| 2 | complete dynamic set flag |
| 4 / 6 | header `80` / section count `5` |
| 8 / 16 | scene epoch / bootstrap ID |
| 24 / 32 / 40 | positive frame seq / source tick / positive projection ID |
| 48 / 50 | TPS `60` / zero reserved |
| 52 / 56 / 60 | entity / event / interaction count |
| 64 / 68 | payload / directory bytes (`100`) |
| 72 / 76 | owner state count（必须等于 entity count）/ zero reserved |

### 4.2 required sections

| type | record | stride |
| ---: | --- | ---: |
| 1 | complete base entity | 72 |
| 2 | complete owner state | 64 |
| 3 | interaction mapping | 32 |
| 4 | interaction NFC UTF-8 table | 0 |
| 5 | reliable presentation event | 40 |

Base entity 保留 V1 `<QII3f4f3fIQI>` layout，但 schema 2 flags 精确定义为 visible、teleport/no-interpolation、
interactive，其他 bit 拒绝。display ID positive/increasing，visual type positive，quaternion normalized，所有 f32
finite，animation start 不晚于 source tick。

Owner state `<QQIIIIIIII3fI>` 与 base record 一一同序：display/parent、mount、variant、damage、construction、
assignment、side、RGBA、owner flags、三个 profile scalar、zero reserved。完整 owner inventory 由 Arts activation
plan 编译并受测试保护；numeric registry 的业务含义由 Bootstrap profile/manifest identity 冻结。

Interaction `<QIIIIii>`：display、domain kind、positive capability flags、string offset/length、tile q/r。
domain kind `1 entity ID / 2 person ID / 3 TileRef island ID`。string table 按 interaction record 顺序紧密拼接
NFC UTF-8，不 deduplicate、不留 hole，末尾只允许 zero pad 到 4 bytes。interactive bit 与 mapping set 必须完全相等。

Event `<QIIQQQ>`：positive increasing event ID、effect type、flags、source/target display、start tick；当前只定义
once bit，start tick 不晚于 source tick。

正式 consumer 在同 epoch 额外拒绝 frame sequence gap、duplicate/out-of-order 和正常时间推进 source tick gap；
该 runtime 顺序规则位于 store/controller，不由结构 parser 猜测。

## 5. scene-display-control-v1@1

control 使用 canonical UTF-8 JSON：object key 按 code point 排序、无空白、NFC string、无 unknown/missing field、
无 NaN/Infinity。scene/bootstrap/frame/correlation/projection 等 u64 在 JSON 中一律为 canonical decimal string。

共同 envelope 精确字段：

```text
bootstrap_id, message_id, payload, protocol, scene_epoch,
schema_version, session_seq, type, viewer_scope
```

client→server：`presentation.ready`、`presentation.ack`、`presentation.resync_request`；server→client：
`presentation.reset`、`presentation.correlation`。反向发送即拒绝。

Correlation payload 精确包含完整五字段 v5 cursor、frame refs `{frame_seq,sha256}`、
`presentation_required/projection_id/record_seq`。frame refs 严格递增；required 为 false 当且仅当 refs 为空。
ACK 的 frame/correlation/cursor 只能在 browser store commit 后前进。

## 6. Owner inventory

Arts `presentationOwnerInventory.js` 当前冻结 7 个 dynamic FeatureOwner：ground-object runtime card、company
address、ground weapon、small person、battle effect、aircraft、projectile。每个 activation plan 中带
`runtime.createHandle` 的 descriptor 必须在 inventory 中唯一出现，否则 architecture gate 失败。

## 7. Golden 与 malformed corpus

共享 fixtures：

- `scene_bootstrap_v1.hex`（612 bytes）；
- `presentation_frame_v2.hex`（536 bytes）。
- `presentation_control_v1.json`（canonical ready envelope）。

corpus 至少拒绝：unknown message/schema/section/flags、hash mismatch、bad UTF-8/NFC、oversize、truncation、
trailing/unindexed bytes、bad offset/stride/alignment/count、duplicate/descending ID、missing cross-reference、
nonfinite f32、bad quaternion、interactive/mapping contradiction、correlation flag/ref contradiction与非 canonical JSON。
