# Ordered presentation session

状态：Scene Engine V3 candidate；60 Hz ordered production path。

`OrderedPresentationSession` 是 transport-neutral、viewer-scoped 的可靠发送状态机。它接收已经验证的
Bootstrap、完整 frame 与 correlation bytes，但不拥有产品 scene identity 的分配策略。

## Retry 与 sequence

client `session_seq` 只能是下一条 sequence，或最后一条消息的 byte-identical retry。Session 常驻只保存：

```text
last_client_session_seq
last_client_message_bytes
```

更早 sequence 的 retry、sequence gap，以及相同 sequence 的不同 bytes 都 fail closed。control codec 的
256 KiB 上限同时约束 retry bytes；不保存随 session 生命周期增长的 message map。

## Reset ownership

Session 失效只产生 `PresentationResetRequired` / `resetRequired`：

```text
reason
current scene_epoch / bootstrap_id / viewer_scope
last acknowledged authority cursor（ready 前为 null）
last acknowledged frame sequence
last acknowledged correlation sequence
```

它不会计算 `scene_epoch + 1` 或 `bootstrap_id + 1`，也不会自行编码带 next identity 的产品 reset。
产品 coordinator 根据上述 cursor 分配新 identity、编码控制消息，并把新 epoch/bootstrap 注入替换 session。
失效时本 session 立即释放 pending/in-flight frame 与 correlation retention。

## Deadlines 与 retention

Bootstrap ready deadline 和 active ACK-progress deadline 独立。ACK deadline 从第一批 admission 真正进入
sent window 时开始，并在每次合法累计 ACK 后推进；ready 等待不能被 ACK timeout 代替。

每个 viewer session 同时受以下 hard limit 约束：in-flight frame credit、queued correlation count、queued
frame count、queued bytes、queued source-tick span、单 packet bytes。任何一个 high-water 都只使当前 viewer
session backpressure/失效，不允许覆盖或跳过中间 frame，也不能关闭其他 viewer session。

单个 correlation 的 frame 数不得超过 in-flight credit，否则该队首永远无法发送，admission 必须立即
fail closed。默认 credit 为 8；product composition 必须令它与 display-core
`maximumFramesPerCorrelation` 使用同一个显式配置值。

`frames` 可以是 iterable，但 admission 必须逐项消费，并在取得超过 credit 的下一项 packet 前拒绝；不得先
用 spread/`Array.from` 无界展开。Bootstrap、frame packet 与 control/correlation 也必须先读取 view 长度并
应用各自 hard limit，再进行 owned-byte copy 或 JSON decode。

Codec 的 `maximumStoredBytes` / `maximum_frame_bytes` 是 SEDF header 之后的
payload 上限；session 的 `maximumPacketBytes` / `maximum_packet_bytes` 是完整
wire packet 上限。默认 8 MiB payload 对应 `8 MiB + 24 bytes` packet，live、
Archive ingest 与 Replay playback 必须使用同一换算，不能把 codec 已接受的边界
packet 延迟到 session 阶段再拒绝。
