# Scene Engine 60Hz DisplayShell 集成迁移计划

状态：draft / non-binding implementation plan
更新时间：2026-08-22

## 1. 目标与 binding 边界

目标 release 中：

- `SceneEngineRuntime` 是唯一 fixed-step tick owner；
- `python-game` 继续拥有玩法、`WorldState`、viewer visibility、v5 authority/control 与 raw tape；
- Scene Engine 输出 renderer-neutral Bootstrap、ordered 60Hz complete frames、correlation/control 和实体生命周期；
- Replay 保留 byte-identical v5 raw tape，并增加与 live exporter 同源的 presentation sidecar；
- Arts 继续只有一个 DisplayShell、renderer、scene/camera、StageRegistry、RAF 与 FeatureOwner/resource authority；
- v5 只写 `V5BusinessProjectionStore`，binary lane 是动态 render handle 的唯一写入者。

本计划必须服从 workspace binding：

- [`MW 全局 60Hz 时间规则`](../../.engineer/contracts/mw-global-time-rule.md)
- [`MW Binary Presentation Source 迁移合同`](../../.engineer/contracts/mw-presentation-source.md)

当前 production route 在完整 release manifest 激活前保持不变。允许 conformance/shadow/parity，禁止长期
production dual-run 或 runtime fallback。

## 2. 当前实现证据与不可晋升项

仓库现有能力：

- engine-owned integer tick、逐 tick catch-up、fatal/reentrancy/health；
- experimental `DisplayFrameV1` base TRS/animation record 与 codec-none packet；
- producer identity tracker、latest mailbox lease、complete-set consumer；
- Python golden/malformed 和 vertical-slice tests。

以下实现不能直接晋升为 MW production：

- 30Hz/sampleable display；
- latest-only mailbox 与 gap-tolerant consumer；
- 缺少 static world/viewer/profile 的 Bootstrap；
- 只有 72-byte base record、没有 typed owner sections/interaction/event lane 的 V1；
- `enqueue_command()` next-tick 语义；
- 没有 projection→v5 cursor correlation、presentation control、ACK/credit transport 或 Replay sidecar。

它们可以继续服务独立实验和机械回归，但 production route 必须使用新 profile/schema/ports。

## 3. 目标 composition

```text
process current v5 inputs once
  -> immediate ACK/resync/command/query handling
  -> SceneEngineRuntime.pump()
       -> gameplay facade step exactly one tick
       -> ProjectionCommitBatch
       -> durable authority outbox admission
       -> mandatory complete DisplayFrame export
       -> state-stream drain + maintenance drain
       -> WirePublicationBatch + RawRecordBatch
       -> PresentationCorrelationRecord
       -> per-client fan-out
  -> bounded service-loop sleep
```

`projection_id` 在 projection commit 时分配；实际五字段 v5 cursor 只能在 stream materialize 后出现。
pending payload 保留 origin projection，不得提前伪造 `state_seq` 或 raw bytes。

Arts/Replay 消费端：

```text
local catalog/base SceneManifest
  -> composite StateSourceController.preflight()
       -> exact v5 snapshot
       -> reliable SceneBootstrap
  -> derive activation plan inside allowlist
  -> one DisplayShell installs static world
  -> exact v5 ACK + presentation.ready joint gate
  -> ordered v5/business + correlation + complete-frame join
  -> V5BusinessProjectionStore + SceneDisplayEngine
  -> one renderer / one RAF
```

## 4. 第 1 轮：合同与门禁

阶段任务：

1. binding 60Hz 合同允许已验证的 binary dynamic source；
2. 冻结 raw tape 不变、presentation sidecar、双 lane 联合 gate 和旧 tape 策略；
3. 否决 MW profile 的 30Hz/latest-only，冻结 ordered/ACK-credit/reset 语义；
4. 冻结单 DisplayShell、business store、interaction mapping 与 tick-derived animation 边界；
5. 冻结跨仓 release manifest 和整体 rollback tuple。

退出门禁：workspace 合同、Scene Engine 边界与本计划无 `30Hz/latest-only` production 冲突，索引完整，
文档链接和文本检查通过。

## 5. 第 2 轮：schema、owner inventory 与 vectors

### 5.1 SceneBootstrap

发布新 packet message type 和物理 layout，冻结：

- session/viewer/v5 baseline/scene epoch/bootstrap/schema/profile identity；
- axes/handedness/unit/quaternion/float；
- islands/tiles/adjacencies/static nodes/parents/absolute transforms；
- visual/variant/owner/content binding；
- dynamic/extension/animation registry、producer/local hard limits；
- canonical strings/sort/offset/stride/alignment/hash/unknown-required rules。

### 5.2 DisplayFrame 新 schema

从 Arts activation plan 生成 owner/field inventory。公共 absolute TRS 留在 base record，复杂状态使用按
`display_id` canonical 排序的 typed sections。冻结 teleport、interactive、attachment、variant、damage、
construction、assignment、animation 与 effect/event 生命周期。

当前 V1 保持 immutable experimental fixture；正式 profile 使用新 schema/version/golden。

### 5.3 Correlation 与 control

冻结：

- `PresentationCorrelationRecord` 的完整五字段 cursor、projection/frame mapping 和完整性校验；
- `scene-display-control-v1@1` ready/ack/resync/reset/correlation envelope；
- cumulative commit ACK、credit/retention/timeout/high-water；
- reset/new Bootstrap 的 sequence 和 stale data rejection。

### 5.4 证据

Python 与 TypeScript byte-exact golden；共同 malformed corpus 覆盖 unknown message/schema/required section、
oversize、truncated、duplicate、overlap、bad hash、bad UTF/sort/alignment、trailing bytes、gap 和 stale epoch。

退出门禁：所有 activated dynamic owner 有且仅有一个字段映射；两端对全部 corpus 结论一致。

## 6. 第 3 轮：Python runtime 与 v5/tape parity

### 6.1 公开 facade 与 immutable batches

在 `python-game` 增加：

- exactly-one-tick gameplay facade；
- `ProjectionCommitBatch`；
- `WirePublicationBatch`；
- `PresentationCorrelationRecord`；
- `RawRecordBatch`；
- durable idempotent authority/presentation outbox 与唯一 ordered sink。

bridge 的 input、advance 和 maintenance 不再直接 broadcast；outbound raw record 在 global durable admission
后、per-client fan-out 前只追加一次。current command 继续即时处理，Scene Engine command tuple 固定为空。

### 6.2 Scene Engine runtime port

增加 mandatory authority port 和 MW mandatory 60Hz display export。每 tick 顺序固定，catch-up 不合并。
display export 失败使 presentation epoch 失效，不能在同 epoch 跨 gap 继续。

### 6.3 parity harness

保留旧 RuntimeDriver 和 render path 作为非 production oracle，证明相同 seed/input 下：

- tick/world revision/event cursor 相同；
- v5 frame count/order/canonical raw bytes 相同；
- Demo1 tape 每 record/每 byte/SHA 相同；
- live-facade composition 的 input/command/reset/maintenance 顺序相同；
- 60 tick 精确产生 60 projection commits 和至少 60 complete frames。

退出门禁：parity/fault tests 全绿，候选 composition 可 dormant 运行；尚不删除 oracle。

## 7. 第 4 轮：ordered transport 与 Replay sidecar

### 7.1 Live transport

- reliable Bootstrap + `presentation.ready` barrier；
- ordered per-client frame queue，不覆盖；
- store-commit 后 cumulative ACK；
- max-in-flight/retention/timeout/frame+byte high-water；
- viewer-specific exporter/queue isolation；
- reconnect/reset 创建 new epoch/bootstrap/complete baseline；
- binary 与 v5/correlation join backlog 有界。

### 7.2 Replay artifacts

新增 sidecar container，冻结 record framing/index/checkpoint/compression/hash/truncation/trailing rules，绑定
`source_tape_sha256`、exporter/profile/manifest/resource identity。

同一 exporter 产生 live/record/migration bytes。老 tape 使用 frozen old Arts artifact，或通过版本化
deterministic migration 生成 sidecar；不可迁移则仅归档。

### 7.3 Replay session

一个 composite controller 同时管理 v5 与 binary lane。snapshot ACK + presentation.ready 联合 gate，
pause/resume/speed/seek 同步；seek 只落在双 checkpoint baseline 并重新 gate。

退出门禁：raw tape/SHA 不变，sidecar byte parity、malformed/fault、0.5×/1×/2×/pause/seek 和 slow client
隔离全部通过。

## 8. 第 5 轮：Arts 单壳迁移

### 8.1 构造与 state source

抽出统一 `StateSourceController.preflight()/activate()/dispose()`，由 `dynamicEngineFactory` 在现有
DisplayShell 内创建 SceneDisplayEngine。不能在 current v5 parser 中 sniff binary，也不能创建第二 renderer。

### 8.2 static 与 complete store

Bootstrap 在 base allowlist 内派生 activation plan，StageRegistry 安装 static topology/content。
CompleteFrameStore 完整 parse/validate 后原子 commit create/update/hide/remove/replace；正式 profile拒绝 gap。

### 8.3 business store 与 interaction

从 committed StateEpochMirror 投影 `V5BusinessProjectionStore`，迁移 HUD/selection/query/result/event/debug/
acceptance/input selectors。viewer-scoped resolver 将 canonical decimal display handle 映射为 current v5 domain
args，并校验 epoch/bootstrap/active/interactive/correlation barrier。

### 8.4 owner adapters

按 inventory owner-by-owner 完成 absolute presentation adapter，但最终 release 一次切成单写入。visual binding
只来自 activation plan。异步 resource request 携带 engine generation、AbortSignal/timeout 和 immutable fields
或 buffer lease；remove/reset/dispose 必须 abort。

### 8.5 clock

所有 dynamic owner 从 `source_tick/animation_start_tick` 派生 phase；同 tick frame 不推进，Replay pause 冻结，
speed 只缩放 arrival wall time；RAF time 只触发 draw/metrics。

退出门禁：static/visual parity、所有 owner mapped、单 shell/renderer/RAF/source/writer、UI/command causality、
async late completion 和 recording evidence 全部通过。

## 9. 第 6 轮：验收、删除、切换与回滚

### 9.1 Fault 与 correctness

逐项验证 gameplay、encode、durable enqueue、raw-record partial success、v5 reset、global transport、slow client、
binary export、decode/resource/dispose、multi-viewer visibility churn、allocator exhaustion 与 stale command。

### 9.2 性能

在冻结机器/浏览器/分辨率/DPR/workload/viewer 数上，测 100/1000/3000/5000 entities 的 Python encode/
enqueue、network、Web decode/validate/store/reconcile/update/draw p50/p95/p99，以及 GC/heap/RSS、queue/ACK lag、
egress、60Hz misses、sidecar storage/ingest/seek 和 soak plateau。最终数值不能为 TBD。

### 9.3 删除与 manifest

用精确符号清单删除旧 tick composition 和旧 dynamic renderer ingress，使其退出 production import graph；
保留 v5 producer/control/raw tape/Replay authority owner。候选 manifest 冻结各仓 commit、schema/profile、
exporter、SceneManifest/resource、corpus、route 和 rollback tuple。

### 9.4 演练

部署完整候选 tuple，运行 acceptance；再整体部署上一 tuple，证明无需 tape/data conversion 即恢复；最后
一次激活候选 production route。新版本不保留 runtime fallback 或双写入。

退出门禁：binding 合同的每项要求均有直接证据，forward/rollback 演练通过，release manifest 完整。

## 10. 统一失败语义

1. gameplay step 异常：tick 不提交、不重试；
2. world 已改但 canonical projection encode 失败：committed fatal，run/tape evidence 无效；
3. canonical batch 已生成、durable enqueue 失败：相同 identity/bytes 幂等重试，不重跑 gameplay；
4. durable/raw-record partial success无法证明连续：run 无效；
5. v5 ACK timeout/retention：current reset+snapshot，同时 new binary epoch/bootstrap；
6. global admission failure：停止后续 commit/fail-stop，保留 exact outbox bytes；
7. slow client：只剔除该 viewer；
8. binary export failure：presentation epoch 失效，以 new epoch/bootstrap/complete frame 恢复。

## 11. 完成定义

只有以下全部成立才完成迁移：

- binding 60Hz、presentation、Replay、command 和 release contracts 全满足；
- Bootstrap/Frame/Correlation/Control 跨语言冻结且 malformed fail closed；
- current v5/raw tape byte parity 通过；
- live/Replay ordered 60Hz、joint gate、ACK/credit 与 sidecar 通过；
- Arts 单壳、单 source、单 writer、business/UI/interaction/owner/static/animation 迁移完成；
- fault/multi-viewer/performance/visual/recording/acceptance 通过；
- 精确删除清单、release manifest 与整体 rollback 演练通过。

“最终画面相同”、窄测试通过或没有发现明显问题，都不能代替以上逐项证据。
