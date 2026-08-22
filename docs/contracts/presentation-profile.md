# Scene Presentation V2 mechanical contract

状态：Scene Engine `0.2.0`；MW 业务 registry/identity 由 workspace generated profile 绑定。

本文冻结通用 `SceneBootstrapV2`、`PresentationFrame V2`、opaque authority cursor 与
`scene-presentation-control-v2@1`。所有整数与 IEEE-754 `float32` 使用 little-endian；section offset
从 inner message byte 0 计算；所有 section 按 type 递增、4-byte aligned、无 native padding。

## Packet envelope

24-byte `<4sHBBHHIII>`：magic `SEDF`、packet version `1`、message type
`1 = scene.bootstrap / 2 = display.frame`、codec `0 = none`、header bytes `24`。flags/reserved 必须为零；
stored/uncompressed length 必须相等；truncation 和 trailing bytes 均拒绝。

共用 20-byte section directory `<HHIIIHH>`：type、required flags、record count、offset、length、stride、
reserved。unknown required、duplicate/reordered/overlap/hole/misalignment、bad stride/count 和非零 reserved 拒绝。

## SceneBootstrapV2

96-byte header `<HHHHQQHHfIIII32s16s>`，schema 为 `2`，complete-static-set flag，7 个 required
sections，positive scene epoch/Bootstrap ID，60 TPS，right-handed Y-up Z-forward、quaternion xyzw、f32。
header 同时声明 producer entity/frame limits，并保存 directory+payload SHA-256。

required sections：

| type | 内容 | stride |
| ---: | --- | ---: |
| 1 | session identity：run/viewer/profile 三个 NFC UTF-8 string | variable |
| 2 | static node | 80 |
| 3 | topology node | 32 |
| 4 | adjacency | 16 |
| 5 | visual registry | 32 |
| 6 | animation registry | 16 |
| 7 | authority baseline：codec identity + opaque canonical bytes | variable |

session identity header 是 `<HHHIH>`；authority baseline header 是 `<HIIH>`。长度必须精确，padding
必须为零。Engine 只验证 cursor envelope 的 canonical bytes 和 codec identity，不解释产品字段。

static/topology/adjacency/visual/animation 的已冻结 packed record 继续使用内部 `*V1` 类型名；该后缀是
record layout revision，不代表 Bootstrap protocol V1。所有 ID 顺序、parent/cross-reference、flags、finite
float、normalized quaternion、limits 和 hash 在安装前完整校验。

## PresentationFrame V2

80-byte header `<HHHHQQQQQHHIIIIIII>`：schema `2`、complete-dynamic-set flag、5 个 required sections、
scene epoch、Bootstrap ID、frame sequence、source tick、projection ID、60 TPS，以及实体/事件/interaction/
owner-state 数量与 payload/directory 长度。

| type | 内容 | stride |
| ---: | --- | ---: |
| 1 | complete base entity | 72 |
| 2 | complete owner state | 64 |
| 3 | interaction mapping | 32 |
| 4 | interaction NFC UTF-8 table | variable |
| 5 | reliable presentation event | 40 |

base entity 使用 absolute world TRS，flags 仅允许 visible、teleport/no-interpolation、interactive；display ID
positive 严格递增，owner state 与 entity 一一同序。interaction 与 interactive set 必须完全一致；event ID
严格递增且 start tick 不晚于 source tick。consumer 还必须拒绝同 epoch frame/source-tick gap。

## Control V2

control 是最多 256 KiB 的 canonical UTF-8 JSON：key 排序、无空白、NFC string、无 unknown/missing field、
无 NaN/Infinity。u64 使用 canonical decimal string。

envelope 精确字段：

```text
bootstrap_id, message_id, payload, protocol, scene_epoch,
schema_version, session_seq, type, viewer_scope
```

client→server：`presentation.ready`、`presentation.ack`、`presentation.resync_request`；server→client：
`presentation.reset`、`presentation.correlation`。cursor JSON 只有
`codec_identity/canonical_bytes_base64`。correlation 绑定 cursor、correlation sequence、source tick、
projection ID 和 `{frame_seq, sha256}` refs；`presentation_required` 当且仅当 refs 非空。

## Archive V2

`scene-presentation-archive-v2@1` 由 canonical manifest、binary index 和 independently hashed blocks 组成。
每个 segment 从唯一 checkpoint/Bootstrap 开始，scene epoch 与 Bootstrap ID 严格递增，并至少含一份 frame
与 correlation。index/block offset 必须连续，count/sequence/tick/identity/hash/trailing/truncation 全部验证。
reader 必须支持 byte-range/random access；跨 segment 相同 sequence 的非 scoped lookup 属于歧义并拒绝。

## Conformance

Python 与 JavaScript 必须对 shared golden/malformed corpus 得到相同 bytes/结论。profile 变更必须同时更新
workspace generated profile、两个语言实现、Archive verifier、下游 vendored package SHA 和 release manifest。
