# Scene Engine 显示壳一次性集成方案反馈

状态：设计反馈 / draft / non-binding  
反馈对象：`scene-engine-display-shell-first-one-shot-plan.md`  
更新时间：2026-08-21

## 0. 文档边界与总体结论

本文只审阅并反馈上述一次性集成方案。原方案中的“执行要求”不是本文的工作指令，本文也不表示相关代码已经完成。

整体方向可以继续，不需要推倒重做：

- `SceneEngineRuntime` 最终成为唯一 fixed-step tick owner；
- Arts 继续只有一个 DisplayShell、一个 renderer、一个 scene/camera、一个 StageRegistry 和一个 RAF；
- Scene Engine 向显示端提供 renderer-neutral 的 Bootstrap、完整动态帧、实体生命周期和跨语言合同；
- `python-game` 继续拥有玩法、`WorldState`、viewer 可见性、领域命令和 v5 authority 语义；
- Arts 继续拥有 SceneManifest、FeatureOwner、资源 authority、Three.js backend、UI 和绘制；
- v5 raw tape 继续是 strict Replay 和验收的权威记录。

原方案的主要问题不是核心架构错误，而是 60Hz、Replay、Bootstrap、动态字段、命令映射、验收和现有代码接点没有同时闭合。按下文修订后，可以保留“一次最终生产切换”的目标；但开发和 CI 仍必须有阶段门禁。

## 1. 已确定的 60Hz 决议

本次不采用 30Hz current display，也不把 latest-only mailbox 提升为 current 产品链路。Missile War 正式 profile 全部保持以 tick 派生的 60Hz：

| 环节 | 正式要求 |
| --- | --- |
| 规则模拟 | 精确 `60 tick/s`，整数 tick 逐个提交 |
| v5 authority projection | 每个 committed tick 至少一份，不能 catch-up 合并 |
| 同 tick 命令事务 | 不额外推进 tick；只要产生新的 committed v5 cursor，就继续按 `state_seq` 形成有序 authority 状态 |
| raw tape | 保存全部 authority/control 原始记录，不抽样、不改写 |
| binary display projection | 每个 committed tick 导出一份完整 frame；同 tick产生新的 presentation state 时导出额外 frame；独立 correlation record把 v5 cursor 映射为零/一/多份 frame |
| binary transport | 可靠、按序、有界，以 cumulative presentation ACK/credit 限制 in-flight；不能 latest-only 覆盖中间 frame |
| SceneDisplayEngine 安装 | 按 `frame_seq` 逐份原子安装，`source_tick` 非递减且正常时间推进不得跳 tick |
| Replay 1× 调度 | 相邻 tick 为 `1000/60 ms`；同 tick frame 延迟为 0 |
| Arts draw | 目标 60fps；设备掉帧时可在一次绘制机会前依次安装积压状态，最后只画一次 |
| 录像 | 目标 60fps，不能把插值状态冒充权威事实 |
| presentation/animation clock | 直接由 `source_tick` 和 `animation_start_tick` 派生；wall-clock 只负责调度和性能测量 |

这里需要区分“状态安装”和“GPU 绘制”：浏览器短暂掉帧时，可以不为每个已安装状态单独 draw，但不能跳过协议接收、校验、store commit、实体生命周期和 tick 派生动画进度。MW 正式 profile 默认不做 wall-clock pose 插值；`performance.now()` 只能触发绘制和记录指标，不能成为第二套动画或 Replay 时间。

现有 [`MW 全局 60Hz 时间规则`](https://gitlab.standlee.cc/missile-war/workspace/-/blob/main/.engineer/contracts/mw-global-time-rule.md) 已约束 current v5、Replay 和 Arts。若 binary frame 成为 Arts 的唯一动态渲染输入，需要同步修订该 binding contract，明确“动态显示可由已验证的 60Hz binary projection 驱动”，不能只改 runtime 配置或局部文档。

现有 Scene Engine 的 latest-only mailbox 可以继续作为实验能力、诊断能力或非 current profile 使用，但不进入本次正式 MW StateSource。

## 2. Replay：当前情况与新引擎需求

### 2.1 当前 Replay 实际设计

当前录像和回放链路为：

```text
Demo1 V5RuntimeApplication
  -> {channel, direction, raw} 原始记录
  -> 完整 tape JSON + tape_sha256
  -> Replay ingest 校验后原样保存
  -> Replay WebSocket 原样播放 Python-to-Display v5 frame
  -> Arts createTarget7DisplayProtocol
  -> StateEpochMirror
  -> world.snapshot / world.delta / core.events
  -> WorldStore + target7RenderReconciler
```

当前代码的重要事实如下：

1. `python-game/cli/demo1.py` 独立驱动 `V5RuntimeApplication` 生成 tape。它同时记录 Python→Display 的 authority/control 和 Display→Python 的 control，每条记录精确为 `{channel, direction, raw}`。
2. `replay/src/store.js` 接收完整 tape 文本，校验后原样保存为 `tape.json`；读取时再次核对 `tape_sha256` 并重新验证协议。
3. `replay/src/protocol.js` 只用解析结果做校验，保留每份 v5 frame 的原始 bytes；要求首帧是 `state_seq = 0` 的 snapshot、后续 `state_seq` 连续、普通时间推进 tick 不得跨越大于 1。
4. `replay/src/server.js::V5PlaybackSession` 先发送录制的原始 snapshot，等待新显示端回送四字段完全匹配的 ACK，然后才发送后续 Python→Display 记录。
5. control/result frame 继承最近的 authority tick。同 tick frame 的播放延迟为 0；不同 tick 的延迟为 `(nextTick - currentTick) * 1000 / 60 / speed`。倍速只改 wall-clock，不改逻辑样本。当前对外播放控制只有 pause/resume；代码中虽有选择既有 snapshot baseline 的 helper，但尚没有完整 seek session。
6. Arts 的 `live` 和 `replay` 当前都走 `createTarget7DisplayProtocol`；首个 v5 snapshot 到来以前，不创建 WebGL runtime、baseline 或 FeatureOwner。
7. 当前 tape、Replay metadata 和 WebSocket 均没有 `SceneBootstrap`、`DisplayFrame` 或 presentation profile identity。

因此，若按原方案删除 v5→动态 renderer 的路径而不增加 Replay display source，v5 mirror/control 仍可工作，但动态场景将没有输入；当前 UI 又与 WorldStore/reconciler 耦合，所以 UI 也必须先完成第 9 节的 business-store 拆分，不能假定自然保留。

### 2.2 新架构下必须继续保持的 Replay 语义

- v5 raw tape 仍是规则事实、因果顺序和验收证据的唯一权威记录；
- 原始 v5 bytes、`tape_sha256`、首 snapshot ACK gate、连续 `state_seq`、tick 检查、暂停、倍速和既有 snapshot-baseline 选择规则保持不变；实际 seek session、重新 ACK 和双 lane checkpoint 属于新增能力；
- presentation 数据是 v5/玩法状态的派生物，不能反向修改 raw tape，也不能被当作碰撞、路径、命令结果或规则恢复来源；
- 老 tape 不能因为缺少新 presentation 数据而被静默标记为“新显示壳可播放”。必须有明确兼容策略或迁移结果。

### 2.3 推荐的 Replay 接入方式

建议为新录制增加一个与 raw tape 分离的 presentation sidecar，而不是把 binary packet 混入现有 v5 tape：

```text
authoritative artifact
  tape.json
  tape_sha256

derived presentation artifact
  scene-bootstrap.bin
  display-frames.bin / indexed frame records
  presentation-index.bin
  presentation_sha256
  source_tape_sha256
  scene-engine schema/profile identity
  exporter revision + Arts manifest/resource identity
```

sidecar 必须由与 live 相同、版本固定的 `MissileWarDisplayExporter` 生成。可以在录制时生成，也可以在 Replay ingest 前离线生成；不能在 Replay Node 服务里另写一套领域可见性、坐标或 visual mapping 逻辑。

sidecar container 还必须冻结 record framing、offset/length、canonical index、checkpoint、压缩边界、截断/重复/尾随字节规则，以及 `v5 cursor -> Bootstrap/checkpoint/frame offset` 映射；这些内容进入 Replay malformed corpus，不能只用文件名和整体 SHA 代替结构合同。

如果确认 current v5 tape 永久包含重建全部动态显示所需的字段，也可以在 ingest 时通过共享、版本化的投影器确定性生成 sidecar。但必须用 golden/parity 测试证明输出与 live exporter 一致。缺少字段时必须 fail closed，不能猜测或补造。

### 2.4 Replay 播放要求

新显示壳需要一个 composite `ReplayStateSourceController`。它内部包含两个逻辑上关联、协议上分离的 lane，但对 DisplayShell 只暴露一个生命周期控制器，并且只有 binary lane 是 SceneDisplayEngine 的动态 StateSource：

```text
v5 Replay source
  -> StateEpochMirror / UI / business state / ACK

Scene Engine Replay source
  -> reliable SceneBootstrap
  -> ordered 60Hz DisplayFrame
  -> SceneDisplayEngine / Three backend
```

要求：

1. Replay 先完成 v5 snapshot 校验和 SceneBootstrap 校验/安装；客户端分别提交精确 v5 snapshot ACK 与 `presentation.ready`，Replay 只有在两者都到齐并匹配同一 baseline 后才释放联合 gate、开始两个 lane 的后续播放。不能沿用“v5 ACK 一到就立即放行”的现有 session 实现。
2. presentation commit 使用当时即可分配的 `projection_id`；独立 `PresentationCorrelationRecord` 在 v5 frame真正 materialize 后，把完整 committed v5 cursor 映射到零/一/多份 `frame_seq`，并保留 origin `projection_id`。frame 与 raw tape 必须共同绑定 run、viewer和 source tick，不能只靠两个 socket 的到达时间对齐。
3. 正常 1× 播放时逐 tick发送 60Hz frame；同 tick command projection 继续按 `frame_seq` 顺序发送，延迟为 0。
4. pause/resume/speed 必须同时控制两条 source，不能出现 UI 已到 tick N 而动态场景长期停在 N-1。
5. 新增 seek session 时只能落到已有可靠基线。每个 seek baseline 必须有对应 snapshot、Bootstrap 和 presentation checkpoint，并重新完成 ACK/ready 联合 gate；Replay 不在中间合成规则状态。
6. presentation frame 不允许 latest-only。网络过慢时应暂停、断开或建立显式 reset/new bootstrap 边界，不能静默丢 frame。
7. 老 tape 的处理需要二选一：使用固定旧 Arts artifact 继续播放，或通过受版本控制的迁移任务生成 sidecar。无法确定性迁移的 tape 保留归档，但不宣称兼容新 renderer。

两个 lane 必须由 cursor correlation/barrier 协调。每个 `PresentationCorrelationRecord` 包含完整 v5 cursor、`presentation_required` 和关联 frame 列表：

- 关联一份或多份 frame时，先安装 v5 business state和全部关联 binary frame，联合完成后该 cursor才对 UI/交互可见；
- `presentation_required = false` 的 business/event-only cursor可以沿用最近已安装动态 frame，只提交 v5/business cursor，不等待不存在的 binary frame；
- 绑定该 cursor 的 command result按 correlation决定走双 barrier还是仅 v5 barrier；
- event 的可见时机也必须在 correlation 中明确；
- 任一 lane 落后时，未匹配 correlation/frame 进入有 frame/byte hard limit 的 join buffer，不能无界积压。

这样既避免 HUD 已显示 N 而动态场景仍显示需要更新的 N-1，也不会让 UI-only cursor因没有 presentation frame而死锁。

`presentation_required` 的组合必须机械冻结：`false` 必须且只能对应空 frame列表；`true` 必须引用至少一份同 session/epoch中已知的 frame。complete presentation bytes、visibility/lifecycle、interactive capability、display→domain interaction mapping或任何 renderer owner state发生变化时必须为 `true`。标志、列表、projection identity或frame内容互相矛盾时，live和 Replay consumer都 fail closed。

### 2.5 Replay 验收

- raw tape 与迁移前 byte-for-byte 相同，SHA 不变；
- 连续一秒有 60 个时间推进样本，presentation 也有对应 60 个 source tick；
- 精确 v5 snapshot ACK 与匹配 Bootstrap 的 `presentation.ready` 两者都到齐前，两个 lane 都不发送后续状态或动态 frame；
- pause/resume、0.5×、1×、2× 只缩放 wall-clock；
- 同 tick command delta/result 与对应 presentation frame 顺序稳定；
- 播放已录制 sidecar 时，Replay bytes 必须与录制时完全一致；若采用确定性再生成，则只有在 viewer/session identity、allocator seed、exporter/profile revision 全部冻结时，才要求 live 与 Replay 的 Bootstrap identity、display IDs、TRS、animation 和 owner-specific fields 相同；
- sidecar 缺失、hash 错误、profile 不匹配、frame gap 或旧 epoch 数据均 fail closed；
- Replay 模式仍只有一个 DisplayShell、一个动态 StateSource、一个 renderer 和一个 RAF。

## 3. SceneBootstrapV1 不足以安装当前静态世界

### 3.1 当前代码设计

当前 Arts 的静态启动不是单一来源：

- SceneManifest/SceneCatalog 决定允许激活的代码、FeatureOwner、资源与 StateSource；
- `live/replay` 必须先收到 v5 snapshot；
- `arts/web3d/src/main.js` 从 snapshot 的 map/terrain facts 生成 authority-driven manifest；
- baseline pipeline 使用 terrain types/tiles 安装静态模板；
- `target7RenderReconciler` 再从 WorldStore 中的 islands、tiles、adjacencies 和 Rule Transform 建立真实 MapTransform 与权威摆放；
- map 成功安装后才隐藏模板内容并开放动态实体。

这意味着“静态美术资源”与“本局静态实例/拓扑/位置”是两类数据：前者属于 Arts 信任目录，后者来自 authority snapshot。

Scene Engine 当前也没有可用 Bootstrap：

- [`display-frame.md`](contracts/display-frame.md) 明确 Bootstrap、坐标、单位和 visual/resource manifest 尚未实现；
- `src/scene_engine/packet_codec.py` 当前只接受 `message_type = 2 / display.frame`；
- 原方案列出的 `static_content_dependencies[]` 只是依赖清单，不能实例化岛屿、地块、建筑或静态 transform。

### 3.2 问题

如果 v5 在 Arts 中只保留 UI/business 角色，同时删除其 render projection，那么当前 map、terrain 和静态 placement 的输入也会被一起删除。仅靠资源依赖和 visual manifest 无法重建场景。

原方案的启动顺序也有矛盾：网络 Bootstrap 不能先于本地 catalog/base SceneManifest 建立信任范围，否则远端数据可能反向决定加载哪些代码或任意资源；但 current authority-driven manifest 又确实要用首 snapshot/Bootstrap 中的 terrain facts 从 allowlist 里筛选最终 owner。因此不能在 Bootstrap 前假定最终 activation plan 已经形成。

### 3.3 修正要求

Bootstrap 与 SceneManifest 的职责固定为：

| 所有者 | 内容 |
| --- | --- |
| Arts catalog/base SceneManifest | 可加载的 owner、代码入口、资源 allowlist、renderer profile、静态模板上限 |
| Arts derived activation plan | 在 base allowlist 内，依据已验证 Bootstrap 选择本局真正激活的 owner/resource |
| SceneBootstrap | 本 session/viewer 的协议 identity、坐标和单位、静态实例/拓扑、visual/animation ID 绑定、limits、内容 hash |

`SceneBootstrap` 至少需要冻结：

- packet/header/section directory 的完整物理布局；
- schema/profile、`scene_epoch`、`bootstrap_id`、`ticks_per_second = 60`；
- viewer/filter identity，以及与 v5 `state_stream_id`、字符串 `state_epoch`、`snapshot_id` 的关联；
- handedness、up/forward axis、world unit、quaternion order、float policy；
- islands、tiles、adjacencies、static nodes、parent relation、absolute/static transform；
- static node 的 `visual_type_id`、variant/owner binding 和 content identity；
- dynamic/extension capabilities、animation registry、hard limits；
- 字符串编码、整数宽度、offset/stride/alignment、canonical 排序、重复项和 unknown-required 处理；
- producer limit 与 consumer local hard limit 的合并规则；
- Bootstrap 及各静态内容 section 的 hash。

正确启动顺序为：

```text
解析并验证本地 catalog / base SceneManifest
  -> 建立 owner/resource/profile 最大 allowlist
  -> 可靠取得并验证 SceneBootstrap
  -> Bootstrap 只能在 allowlist 内选择本局 terrain/owner/resource
  -> 派生并验证最终 SceneManifest / activation plan
  -> 在现有 StageRegistry 的 PREPARE/BAKE/MOUNT 中安装静态场景
  -> DISPLAY_READY barrier
  -> ACTIVATE ordered 60Hz dynamic source
```

Bootstrap 必须可靠送达并确认安装，不进入可覆盖队列。Python/TypeScript 必须共享 byte-exact golden 和 malformed corpus；未实现的 Bootstrap message type 必须 fail closed。

## 4. DisplayFrameV1 无法覆盖全部动态 FeatureOwner

### 4.1 当前代码设计

当前 experimental `DisplayFrameV1` 已冻结的机械内容为：

- 64-byte header；
- 20-byte section directory entry；
- 当前只注册一个 required dynamic entity section；
- 72-byte entity record，只含 `display_id`、`visual_type_id`、`visible`、absolute TRS、animation state/start tick/flags；
- `event_count = 0`，不支持 extension section；
- entity record 表示完整替换，帧中缺席表示 remove；
- epoch 内退休 ID 不得复用。

当前 Arts FeatureOwner 的实际输入比这更丰富。例如 small-person renderer 仍读取 `position_ref`、`position_sampled_at_tick`、owner profile 和 animation；其他 owner 还需要 side、颜色、variant、damage、construction state、attachment、assignment、label 或 effect 参数。

### 4.2 问题

- 原方案使用 teleport/no-interpolation 和 interactive flags，但 V1 只注册了 `visible` bit；
- “适配全部动态 FeatureOwner”没有冻结准确 owner 清单和每类字段；
- `visual_type_id + TRS + animation` 不足以表达当前全部 renderer 输入；
- complete frame 为 60Hz 后，短命 effect 仍可能在两个 committed presentation state 之间产生并结束；只写 `event_count = 0` 会让效果永远不可见；
- 在 schema 1 下静默添加字段或重新解释 reserved bits 会破坏现有 Python golden 和未来 Web/C++ consumer。

### 4.3 修正要求

先生成一份受测试保护的 owner/字段 inventory，每个已激活动态 owner 必须映射到以下之一：

1. base entity record 已有字段；
2. 新的 typed complete-state section；
3. 可靠 event/effect lane；
4. 明确保留的非动态/业务/UI owner。

建议把公共 TRS 留在 base record，把复杂状态放在以 `display_id` 关联、按 ID canonical 排序的 typed sections。至少需要决定：

- Bootstrap 冻结 run/viewer/session 与初始 v5 baseline identity；binary `frame_seq` 在 presentation commit 时分配，和 `source_tick` 一起区分同 tick 的多份 presentation state；
- 独立 `PresentationCorrelationRecord` 在 v5 frame materialize 时携带完整五字段 cursor（`state_stream_id/state_epoch/snapshot_id/state_seq/world_revision`）、`presentation_required` 和零/一/多个关联 `frame_seq`；
- teleport/no-interpolation 的正式 bit；
- interactive 是每实体动态 bit，还是 Bootstrap/visual manifest 中的固定能力；
- MW-specific interaction mapping section 如何把 `display_id` 映射为现有 v5 command 所需的 domain ID/TileRef；该 section 只进入 business/input adapter，不进入通用 renderer core；
- attachment parent、mount point 和相对/绝对 transform；
- owner variant、damage/construction/assignment 等状态；
- animation clock、loop/once、blend、start tick 和 reset 规则；
- transient effect 的最小 presentation lifetime，或带 ID/去重窗口的可靠 event section；
- unknown message/schema/required section 必须 fail closed；unknown optional section 只能按协商 profile 的冻结规则 skip 或拒绝，当前 V1 consumer仍全部拒绝未注册 section；
- 每类 section 的 record size、count/byte limit 与 malformed 规则。

这些属于不兼容 profile 扩展，应发布新 schema version 和新的 Python/TypeScript golden vectors，不能继续称为当前 V1。

cursor correlation 是 presentation-control/sidecar 的物理合同，不是旁路日志。完整性校验必须覆盖 correlation record、所引用 frame bytes 和完整五字段 cursor。任何 v5 reset/new snapshot 都必须原子建立新 binary scene epoch + Bootstrap，旧 frame、correlation和 ACK 随即失效。Arts 按 correlation 决定：presentation-required cursor 等待关联 frame 后联合提交；business-only cursor沿用上一动态 frame并只提交 v5 store。

另外，“FeatureOwnerVisualRegistry”不能成为第二套 owner authority。visual binding 应由已验证 SceneManifest 编译进 activation plan；Three backend 只持有已经激活的 descriptor/createHandle hook，不能从网络字符串任意 import，也不能复制 owner 的尺寸、placement、resource 或 animation authority。

## 5. display_id 交互命令与 current v5 不兼容

### 5.1 当前代码设计

当前 `mw-display-command-v5@1` 有严格 envelope：

- protocol/schema/type/message ID；
- `client_instance_id`、`intent_seq`、`intent_id`；
- `observed_state`，包含用户实际看到的 v5 cursor 和 `world_revision`；
- closed command/query kind 与 closed args；
- byte-equivalent retry、ledger 去重、权限与 capability 校验；
- command 成功后，结果绑定 committed cursor，显示端必须等该 cursor 安装后才能把视觉变化视为成功。

`python-game/core/runtime_application.py` 当前在 control 到达时立即处理命令。接受的命令可以在不推进 tick 的情况下修改 world，立刻产生同 tick v5 delta，再返回 `command.result`。因此 tick 不是所有状态的唯一序号，`state_seq` 才是 authority 全序。

Scene Engine 当前 `enqueue_command()` 则把命令分配到下一个尚未开始的 tick。两者语义不同，不能在首次 runtime 切换时直接替换。

### 5.2 问题

原方案的裸结构 `{scene_epoch, display_id, intent}` 会被 current v5 validator 拒绝，也丢失 observed cursor、幂等、因果结果和权限语义。

`display_id` 是 `u64`；超过 `2^53 - 1` 后 JavaScript `number` 会丢精度，`BigInt` 又不能由当前 `JSON.stringify` 直接发送。

display ID 还是 viewer-scoped presentation handle，不是 domain object ID。若只做全局 `lookup_domain(display_id)`，可能出现跨 viewer 查询、旧 epoch handle 复活或不可见对象越权访问。

### 5.3 修正要求

首切换保持 current command envelope 和即时处理语义，`SceneEngine` 的 frozen command tuple 固定为空。命令批次正式迁移另立合同，不和 tick driver/display 切换捆绑。

首切换选择“不修改 `mw-display-command-v5@1`”。因此需要在 Arts business/input adapter 增加 viewer-scoped `DisplayInteractionResolver`：

```text
(viewer_scope, binary_scene_epoch, bootstrap_id, display_id)
  -> active presentation instance
  -> MW-specific interaction mapping section
  -> existing domain ID / TileRef
  -> current v5 closed command/query args
```

规则：

- `display_id` 在 JavaScript map、日志和任何 JSON side metadata 中使用 canonical decimal string：正则为 `[1-9][0-9]*`、无前导零、数值范围 `1..2^64-1`，解析后重新编码必须 byte-equivalent；binary record 中仍为 u64；
- 首切换不把 `display_id` 发送给 Python；resolver 先映射成 current v5@1 已注册的 `entity_id`、`person_id`、`tile_ref` 等 closed args；
- resolver 必须校验 viewer、epoch、bootstrap、active membership、interactive capability；Python 仍按现有 domain args、observed cursor 和 viewer 权限重新授权，客户端检查不是安全边界；
- 缺席退休、remove、viewer change、reset、reconnect 后的 handle 必须拒绝；
- 不可见对象不能用 `visible = false` 留在未授权 viewer 的 complete set 中；重新可见时创建新的 presentation lifecycle ID；
- Bootstrap 固定初始 v5 baseline identity，`PresentationCorrelationRecord` 把完整 v5 cursor关联到已安装 `frame_seq`；点击只能使用 correlation barrier 已公开的 cursor构造 `observed_state`；
- UI-only 本地 selection 可以不发 Python；需要业务 query/command 时才经过 resolver 和 v5 command lane；
- command result 的成功 barrier由该 cursor 的 correlation决定：`presentation_required` 时等待 v5 cursor和全部关联 binary frame；business-only cursor或没有新 cursor的 query/control result只走现有 v5/control barrier；
- Replay 默认只允许播放控制，不向历史 Python runtime 发送领域修改命令。

如果未来确实要让 Python 直接接收 display handle，必须发布新的 command schema/version并同步迁移 tape、Replay validator、Arts mapper 和权限合同；不能在 v5@1 closed args 中静默添加字段。

## 6. 最终验收目前不足

### 6.1 当前代码已有的验收基础

- `python-game` 已有测试锁定 batch 60 tick 仍产生 tick 1…60 的逐 tick v5 delta；
- current `RuntimeDriver` 在 catch-up 中逐次调用 `advance_ticks(1)` 和 `publish_pending()`；
- Replay ingest 已验证连续 `state_seq`、snapshot ACK、普通 tick gap、raw tape SHA；
- Replay playback 已测试基于 authority tick 的 `1000/60 ms` 调度；
- Scene Engine 已有 runtime、binary golden/malformed、identity、mailbox lease 和 complete consumer 测试；
- Arts 已有 StateEpochMirror、WorldStore、DisplayShell lifecycle 和 FeatureOwner activation 边界。

这些基础可以复用，但原方案只验证“60 gameplay tick + 30 display frame”和最终视觉结果，不能证明 current 60Hz 语义未被改变。

### 6.2 删除旧路径前的硬门禁

| 类别 | 必须证明 |
| --- | --- |
| Tick | 每个模拟秒恰好 60 个连续 committed tick；catch-up 可在一个 wall-clock 调用内补做，但不能合并；只有 Scene Engine 一个 tick owner |
| Authority port | 60 committed ticks 精确触发 60 次 projection commit；state-changing command 产生的同 tick authority frame也按 `state_seq` 进入有序 sink |
| Current v5 parity | 新旧 composition 的 frame count、顺序、canonical raw bytes、world revision、event cursor、ACK/reset 一致 |
| Binary display | 每个 committed tick至少一份 complete frame，presentation-changing同 tick事务可增加 frame；`frame_seq = previous + 1`、时间推进 tick无 gap；duplicate/out-of-order拒绝；reset后只接受新 Bootstrap规定的首序号 |
| Cursor correlation | 每个实际 v5 cursor都有完整五字段 correlation，显式映射零/一/多份 frame；business-only不阻塞，presentation-required必须联合提交；join backlog有 frame/byte hard limit |
| Raw record/tape | 双向 authority/control raw recorder 保持记录结构与共同顺序；Demo1 tape逐 record/逐 byte不变；另有经过新 SceneEngine composition 的 live-facade deterministic recording harness |
| Replay | ingest、ACK gate、pause/resume/speed、seek baseline、旧 tape 策略和新 presentation sidecar 全通过 |
| Bootstrap/schema | Python/TypeScript byte-identical golden；unknown message/schema/required section、corrupt/oversize/truncated/duplicate 均 fail closed；optional section按冻结 profile处理 |
| Complete state | create/update/hide/remove/replace、ID retire、viewer change 和 epoch reset 正确 |
| Commands | v5 envelope、same-tick commit、observed cursor、display-handle 解析、stale/unauthorized 拒绝正确 |
| Static scene | map topology、terrain、static building/owner、content hash 与当前视觉基线一致 |
| Arts architecture | 唯一 shell/renderer/RAF/StageRegistry；无第二 owner/resource/position authority |
| Fault isolation | gameplay、authority commit、display export、socket、decode、resource、dispose 故障分别符合冻结语义 |
| Global 60Hz evidence | snapshot `ticks_per_second = 60`；person `position_sampled_at_tick` 连续；移动语义为 `move`；Arts 不预载或补造权威位置 |
| Presentation flow control | 独立 control schema；cumulative ACK只在 browser store commit 后前进；max-in-flight/credit/timeout和跨 lane join backlog有界；ACK/correlation/frame不匹配则 fail closed |
| Performance | 冻结设备/浏览器/分辨率/场景后，100/1000/3000/5000 entities 通过数值预算和 soak |
| Rollback | 按冻结 commit tuple 整体回滚后，旧 v5/tape/Replay 无数据转换即可运行 |

“最终状态相同”不能替代逐 tick、逐 `state_seq`、逐 byte 证据。Demo1 不经过 RuntimeDriver/bridge，因此其 tape parity 只能证明 v5 projector/tape producer 未变；新 tick composition 还必须由 live-facade harness 单独验证。旧 RuntimeDriver 和旧 dynamic renderer path 在 parity 门禁完成前还是对照 oracle，不能提前删除。

### 6.3 性能门禁必须有数字

当前 72-byte base record 在 5000 entities、60Hz 下仅 record payload 就约为 `21.6 MB/s`，相当于每个未压缩 projection 约 `77.8 GB/h`，尚未包含 header、extension、Bootstrap、索引、WebSocket framing、复制和多 viewer 成本。因此完成定义不能只写“5000 entities 可以运行”。

发布 profile 必须冻结：

- 目标机器、CPU/GPU、浏览器版本、分辨率和 DPR；
- entity 类型构成、steady update、全 create/remove、effect burst 等 workload；
- warmup、采样和 soak 时长；
- Python export、encode、socket enqueue；Web decode、validate、store commit、reconcile、update、draw 的 p50/p95/p99；
- 并发 viewer 数、viewer-specific filter/export CPU、可共享 frame 条件和 aggregate egress；
- GC pause、JS heap、Python RSS、frame-pool reuse、内存平台期；
- 每连接 queue frame/byte high-water、server transport/library write-buffer、browser application decode queue、presentation ACK lag、send timeout 和断开次数；DOM `WebSocket.bufferedAmount` 只描述本端待发送数据，不能单独证明 server→browser 入站有界；
- Replay sidecar 的压缩率、每小时存储、ingest 时间、index/checkpoint 开销、seek 延迟、保留和清理预算；
- 60Hz deadline miss、积压恢复和视觉降级规则。

具体数值可以在目标硬件基线完成后冻结，但最终切换前不能仍为 TBD。

## 7. Python runtime 接点与 authority observer

### 7.1 当前代码设计

当前实时 composition 为：

```text
WorldState
  -> V5RuntimeApplication
  -> V5RuntimeBridge
  -> RuntimeDriver
```

`RuntimeDriver.step()` 每轮先 `process_inputs()`，再计算 overdue ticks；catch-up 对每个 tick 逐次执行：

```text
V5RuntimeBridge.advance_ticks(1)
  -> V5RuntimeApplication.advance_ticks(1)
  -> core.simulation.tick_runtime_ticks(..., 1)
  -> _commit_projection()
  -> stream.drain()
  -> bridge 立即 broadcast 返回的 authority frames
V5RuntimeBridge.publish_pending()
  -> require_ack_before(current tick)
  -> drain ACK timeout / retention / reset 等维护产生的 pending frames
  -> bridge broadcast
```

因此 `publish_pending()` 不是正常 tick frame 的唯一出口；projection commit 返回的 frame 已经由
`advance_ticks()` 路径广播。control 也有独立出口：command 可以返回
`authority frames -> command.result`，query/protocol error 可能只有 control frame，ACK 是入站 control raw，
resync 才可能触发 reset/snapshot。raw tape 记录的又是双向 authority/control 共同顺序，不能把这些都称为
一个 authority callback。

当前 `SceneEngineRuntime` 已有 engine-owned tick、逐 tick catch-up、frozen command tuple 和 sampled display export，但没有“每个 committed tick 必达”的 authority commit port。它在 gameplay 正常返回后直接记 tick committed，再尝试 display export；display 失败被隔离。

### 7.2 问题与修正

1. 原方案 observer 只接收 `TickContext`，不能精确表达这一 tick 实际生成的全部 authority frame，也覆盖不了 command、query、ACK/resync 的非 tick 输出。
2. `V5RuntimeApplication.advance_ticks()` 当前已经推进玩法并执行 `_commit_projection()`。adapter 若在 observer 中再次调用 projection，会重复提交；若只观察 context，又可能漏 frame。
3. current command 在 tick 前立即执行并可产生同 tick delta/result，不能直接改成 `SceneEngine.enqueue_command()` 的 next-tick 语义。
4. current catch-up 每个 tick 后都做 `publish_pending()/require_ack_before()`；若挪到整个 `pump()` 后，会改变 ACK timeout、reset tick、frame 顺序和 tape。
5. gameplay 已原地修改后 projection encode/durable enqueue 失败无法 rollback，必须冻结 fail-stop、幂等恢复和 partial-success 语义。
6. current experimental consumer允许 frame/source-tick gap，runtime export 失败也会跳过 sample；正式 MW adapter 必须覆盖这些策略，否则 60Hz 文档不会变成运行时保证。

需要在 `python-game` 增加公开单 tick facade，并明确区分四类不可变结果。原因是 current
`authority_state_stream` 在未收到 snapshot ACK 时只保存 pending payload，精确 `state_seq` 和 raw frame
可能到后续 `drain()` 才 materialize：

- `ProjectionCommitBatch`：表示一次 committed world projection，使用独立、单调的 `projection_id`，包含 source tick、world revision、待排入 v5 stream 的 payload和是否产生 presentation frame；此时不能假定已有最终 v5 cursor/raw bytes；
- `WirePublicationBatch`：在 stream真正 emit/drain 后保存 Python→Display authority/control 的共同发送顺序；每个 frame 自带实际 tick/cursor，并保留其 origin `projection_id`；
- `PresentationCorrelationRecord`：依据 origin projection把每个实际 v5 cursor映射到零/一/多个 binary `frame_seq`，并标记 `presentation_required`；
- `RawRecordBatch`：保存双向 `{channel, direction, raw}` tape 顺序。入站在应用接受原始 bytes 时追加；出站在 exact `WirePublicationBatch` 完成 durable global admission 后、任何 per-client fan-out 前只追加一次。它不依赖某个 socket 是否成功写出。

这要求重构 state stream 的 pending item，使其在排队时保存 origin `projection_id`；但 raw v5 frame仍只在
实际 materialize并完成 durable publication admission后写 tape，不能为了方便 correlation 提前伪造 `state_seq` 或改变 wire顺序。

建议 service composition 为：

```text
process current inputs once
  -> record inbound raw control
  -> application handles ACK/resync/command/query
       -> zero or more ProjectionCommitBatch / presentation frame
       -> state-changing projection先进入与 tick相同的 mandatory durable authority outbox
       -> stream drain produces zero or more WirePublicationBatch
       -> emit PresentationCorrelationRecord for materialized v5 cursors
       -> durable admit WirePublicationBatch
       -> append outbound RawRecordBatch once, then per-client fan-out
       -> command.result只能在关联 projection durable commit成功后发布
  -> SceneEngineRuntime.pump()
       -> gameplay facade step exactly one tick
       -> obtain immutable ProjectionCommitBatch
       -> append projection/pending payload to idempotent authority outbox
       -> mandatory complete DisplayFrame export for this tick
       -> normal stream drain
       -> require_ack_before / retention / reset maintenance
       -> recovery drain（包含 maintenance 新建的 reset/snapshot）
       -> 按两次 drain 的共同顺序生成 WirePublicationBatch + correlation
       -> durable admit publication，append outbound raw record once
       -> per-client fan-out不改变 tape
  -> bounded service-loop sleep
```

普通匹配 ACK 若只解除 gate/排空 pending，不为 ACK 本身额外导出 binary frame；`state.resync_request`、reset、reconnect 即使 world未变化，也必须创建新 binary scene epoch、Bootstrap、首份 complete frame和新的 correlation baseline。接受的领域命令若在
同 tick 产生新的 presentation state，则用递增 `frame_seq` 导出同 tick frame。业务/UI/event-only v5 cursor
通过 `presentation_required = false` correlation 前进。这样 60Hz 是基础时间推进频率，独立
`projection_id`、实际 `state_seq` 和 binary `frame_seq` 共同表达 deferred emit 与同 tick事务顺序。

失败语义按层冻结：

1. gameplay step 异常：当前 tick 不提交、不重试该 step；
2. projection encode 在生成 canonical batch 前失败：world 已修改则记录 committed fatal tick，该 run/tape证据无效；只能用新 stream和完整 snapshot恢复，不能声称补齐原 tick；
3. canonical ProjectionCommitBatch 已生成、但 mandatory durable enqueue失败：保留相同 batch identity/bytes并幂等重试，不能重新执行玩法或生成另一份 projection；
4. durable/outbound/raw-record sink partial success：使用 batch/record identity幂等提交；无法证明 tape连续的 run判为无效，不能用新 snapshot掩盖 raw tape gap；
5. v5 ACK timeout/retention overflow：继续使用 current 同 stream/epoch 的 reset + snapshot 恢复语义，不自动升级为 runtime fatal；同时原子建立新 binary epoch/Bootstrap/correlation baseline；
6. global transport admission/queue 故障：停止接收后续 commit或 fail-stop，并保留可重发的 exact outbox bytes；
7. 单个慢客户端：只剔除该客户端，不影响 gameplay、authority outbox、tape或其他 viewer；
8. global binary exporter/encode 失败：当前 presentation epoch立即失效，禁止下一成功 complete frame跨 gap继续；authority/tape可继续，但该显示 session 必须以新 scene epoch + Bootstrap +完整 frame恢复，严格验收 run记为 display failure。

正式 MW binary consumer 必须拒绝 uninterrupted epoch 中的 `frame_seq` gap 和时间推进 `source_tick` gap；只有显式 reset/new Bootstrap 才能建立恢复边界。

首切换保留 `V5RuntimeApplication`、`authority_projection`、`authority_state_stream`、`display_command_protocol`、viewer projection 和 `V5RuntimeBridge` 的协议/transport职责，但必须把 bridge 当前 `process_inputs()/advance_ticks()/publish_pending()` 内的直接 broadcast 副作用重构为“纯 batch producer + 唯一 ordered sink”，否则新 port 会重复发布。只替换 `RuntimeDriver` 的 tick/deadline composition；删除清单必须精确到符号，不能使用“旧 Python dynamic exporter”这种当前代码中并不存在的泛称。

## 8. Arts DisplayShell、StateSource 与构造顺序

### 8.1 当前代码设计

当前 `createDisplayShell.js` 已经实现需要保留的唯一壳：

- 先要求 activation plan 已验证；
- 壳内统一创建 RenderableStore、StageRegistry 和 SceneHost；
- 创建唯一 baseline runtime、renderer、scene/camera 和 dynamic reconciler；
- 每次 render 前调用 dynamic update；
- MOUNT 后 attach mapRoot，再应用首 snapshot；
- ACTIVATE 启动 StateSource，ACTIVE 才启动 runtime/RAF；
- dispose 先关闭 protocol ingress，再停 runtime 并反向释放生命周期。

当前 StateSource 还不是统一 adapter 接口：`none/display-fixture/replay/live` 只是策略 kind；`replay/live` 共用 v5 WebSocket/protocol，fixture helper 也没有真正接进统一 production 启动链。

### 8.2 问题与修正

原方案要求先 `installBootstrap()` 再 `start(source)`，但 Bootstrap 又来自 source；同时先建 shell、再把 shell 内部 renderer/scene/camera 传给外部 engine，会形成构造循环。

建议把 source 与 engine 分成两个阶段：

1. 解析本地 catalog/base SceneManifest，形成最大 owner/resource/profile allowlist；
2. `StateSourceController.preflight()`：连接、协商 profile、可靠取得 Bootstrap，不开始动态 frame；
3. 用已验证 Bootstrap 的 terrain/static facts 在 allowlist 内派生最终 SceneManifest/activation plan；
4. `createDisplayShell(...)`：在壳内部 baseline runtime 创建后、stage 执行前，通过 `dynamicEngineFactory(runtime, activationPlan, services, bootstrap)` 创建 SceneDisplayEngine/Three backend；
5. 静态内容仍通过同一个 StageRegistry 安装；
6. DISPLAY_READY 后调用 `StateSourceController.activate(engine)`；
7. dispose 先让 source epoch 失效并停止 ingress，再 abort resource jobs、停止 RAF、释放 StageRegistry。

不能由 Scene Engine 创建第二套 SceneHost、StageRegistry、renderer 或 RAF，也不能在 current v5 parser 中增加 binary sniffing/fallback。live binary、Replay binary、fixture binary 和 none 应实现同一显式 StateSource port，但一个 SceneManifest 只能选择一个动态 source。

## 9. WorldStore 与 UI/business projection 必须真实拆分

### 9.1 当前代码设计

`createTarget7DisplayProtocol()` 当前先把 v5 raw frame 提交给 `StateEpochMirror`，再调用 `materializeV5RenderSnapshot/Delta`。`target7RenderReconciler` 随后同时完成：

- WorldStore snapshot/delta；
- map 和 coordinate transform；
- dynamic handle create/update/remove；
- UI snapshot/delta；
- status、selection 和 control result 展示。

因此当前并不存在一个已经可用的“UI-only WorldStore”。把旧 reconciler 的 handle 写入删掉，并不会自动留下完整 UI 数据流。

### 9.2 修正要求

先定义 `V5BusinessProjectionStore`，直接从 committed StateEpochMirror 投影并拥有：

- HUD/world summary；
- viewer/business entities；
- selection/query context；
- command/query result 与 observed cursor；
- domain events 和 UI notification；
- 与 binary presentation frame 的 cursor correlation。

必须盘点所有 UI selector、debug panel、acceptance hook 和 input mapper，迁移完成后才能删除 current render projection/WorldStore 路径。静态 map facts若已迁入 Bootstrap，则 business store只保留 UI 所需摘要；若仍有 UI 依赖完整 map，则要显式保留相应 v5 projection，不能模糊称为“UI-only”。

## 10. FeatureOwner 适配不能另建第二套 authority

当前 Arts 的 owner 由 SceneCatalog/activation plan 激活，`runtimeElementRegistry` 只从已激活 definition 中唯一匹配并调用 owner `createHandle`。代码、资源、dimensions、placement、profile 和 animation authority 留在各 FeatureOwner 中。

因此：

- `visual_type_id` 必须解析到 activation plan 已激活的 descriptor；
- Scene Engine/Three backend 不得维护任意 factory/import catalog；
- 不得复制 owner 的资源路径、尺寸、placement 或动画规则；
- 每个 activated dynamic owner 都要进入自动生成的迁移清单；
- 未映射的 dynamic owner 使 architecture gate 失败；
- 某一 owner 切到 binary 后，其 pose/lifecycle 只能由 SceneDisplayEngine 写，v5 business lane不得再写同一 handle。

一次最终生产切换可以保持“所有 dynamic owner 同时改为单写入”，但实现过程中仍应 owner-by-owner 完成 adapter 和测试；这属于开发门禁，不是生产双跑。

## 11. ordered scheduler、异步资源与 buffer 生命周期

### 11.1 ordered 60Hz scheduler

原方案的 one-running + one-pending-latest 不再适用于正式 profile。需要的是每连接有界、可靠、按序的 frame queue：

- 每份 frame 必须 decode/validate/store commit；
- queue 达到 high-water 时不能覆盖中间 frame；
- 可以对慢客户端施加 backpressure、超时断开，并在重连时建立新 epoch/bootstrap/reset 边界；
- 一个慢 viewer 不能阻塞其他 viewer 或 gameplay；
- 只有 viewer scope、profile、Bootstrap 完全相同的连接才能共享 immutable encoded frame。

Renderer 可在一次 RAF 前完成多份 store commit 后只 draw 最新状态，但 frame sequence、lifecycle 和 animation clock 仍逐份处理。

### 11.2 异步资源

decode/store commit 不应等待 Three resource Promise。backend 应同步返回 placeholder/request token，异步任务携带：

- entity operation generation；
- `AbortSignal` 与 timeout；
- epoch/bootstrap/display ID/visual ID；
- 完成时再次检查 active membership 和 generation。

remove、replace、epoch reset 和 dispose 必须 abort 旧任务。迟到任务只能被丢弃，不能复活已删除 entity。generation 由 SceneDisplayEngine 唯一签发，backend 只校验，不能两边各维护一套生命周期。

### 11.3 frame buffer

typed-array view 指向原始 frame buffer。异步任务若跨 frame 使用该 view，previous/current 两帧保留不足以保证内存有效。必须二选一：

- 把异步任务需要的固定字段复制到小型 immutable request；或
- 为 frame buffer 建立显式 lease/refcount，最后一个任务完成后才归还 pool。

generation 检查只能防错误挂载，不能替代 buffer 所有权。

### 11.4 presentation/animation clock

当前 Arts 在 RAF 中把 wall-clock frame time 传给 dynamic handles，部分 FeatureOwner直接用该值推进动画。正式 60Hz profile 必须改为：

- `SceneDisplayEngine` 以最后联合安装的 `source_tick` 计算 presentation time；
- animation phase 由 `(source_tick - animation_start_tick) / 60` 和已注册 animation flags 计算；
- 同 tick的多个 `frame_seq` 不增加逻辑动画时间；
- Replay pause 时动画冻结，倍速只改变 frame 到达 wall-clock 间隔，安装每个 tick 后得到的动画采样仍由 tick决定；
- catch-up 在一次 RAF 前逐 tick更新 lifecycle/animation状态，最终可只 draw一次；
- wall-clock 只决定何时调用 update/draw和记录 deadline miss，不能反向推进动画；
- 若未来需要纯视觉插值，必须作为不参与 current evidence 的显式 optional profile，并单独冻结 pause/seek/reset语义。

需要逐个修改仍消费 wall time 的 owner adapter，并加入 live、Replay、pause、倍速、积压和录像一致性测试。

## 12. Display ID、viewer scope 与可见性

当前 `DisplayIdentityTracker` 只管理一个 `(scene_epoch, bootstrap_id)` active set，没有 viewer/filter identity，也没有 allocator、domain reverse mapping、恢复和多连接权限模型。

正式 exporter 必须消费现有 viewer-scoped `V5Projection` 或相同 visibility owner 的公开 facade，不能遍历裸 `WorldState` 重写过滤逻辑。

每个投影 session 独立拥有：

```text
viewer/filter identity
scene epoch + bootstrap ID
monotonic display ID allocator
active set + scalar max_seen/next_id（不保存无界 tombstone history）
active-only interaction/domain mapping
current observed cursor + viewer authorization context
```

未授权对象必须完全不出现在 frame 中，不能用 hidden flag 暗示其存在。因 viewer filtering 暂时离开 complete set 的实例视为该 presentation lifecycle 结束；重新可见时使用新 ID。renderer 层临时 occlusion/LOD 可以使用 `visible = false`，但它不是权限过滤机制。

测试必须覆盖多 viewer、visibility churn、viewer change、reconnect、epoch reset、stale command、跨 viewer display ID 和 allocator exhaustion。

## 13. 瞬时效果与 event 职责

原方案一处把 recent effect/event 去重列为 Engine 职责，另一处又固定 `event_count = 0` 并把效果全部建模成 complete-set entity，职责不一致。

60Hz complete frame 可以承载有持续状态的 effect entity，但仍要冻结：

- effect 至少存活到一个 committed presentation frame，必要时保证最小显示 tick 数；
- 同 tick create/remove 是否需要两个有序 frame；
- 音效、一次性粒子、镜头震动等不可持续状态是否进入可靠 event section；
- event ID、去重窗口、seek/reconnect/replay 行为；
- effect entity 与业务 domain event 的边界。

如果首版不实现 event lane，应从完成定义中删除“通用 recent-event window/去重已完成”的表述，只承诺有明确最小生命周期的 effect entity。

## 14. WebSocket 背压、连接隔离与恢复

当前 Scene Engine 只有进程内 latest mailbox；这不能证明实际 Python WebSocket、浏览器 socket buffer、decode queue 和 renderer 资源队列有界。

正式 60Hz transport 需要定义：

- binary subprotocol、Bootstrap/frame/reset message type；
- 独立 presentation-control schema，例如 `scene-display-control-v1@1`；它与 `mw-display-command-v5@1` 完全分离，禁止把 ready/ACK/correlation 塞进 current command envelope；
- presentation-control 使用 exact envelope，冻结 client→server `presentation.ready/presentation.ack/presentation.resync_request`、server→client `presentation.reset/presentation.correlation` 的方向、message/session sequence、message ID、幂等、重试、大小限制和 unknown-field规则；
- browser 在完成 decode/validate/CompleteFrameStore commit 后发送 cumulative `presentation.ack`，至少包含 viewer/session、scene epoch、bootstrap ID和已提交 frame seq；对已经收到 correlation 的联合 cursor另携带 correlation sequence/完整 v5 cursor。ACK 不能在只收到 bytes或仅排入 JS queue 时提前发送；
- server 按 ACK 维护 max-in-flight frame/byte credit、retention window和 ACK timeout；没有这一层，TCP/WebSocket 写成功不能证明 browser pending 有界；
- 每连接 queue 的 frame/byte hard limit；
- endpoint/library-specific transport write-buffer high-water，以及 browser application decode queue high-water；
- send timeout、慢客户端断开和健康指标；
- reconnect 后新 Bootstrap/epoch 与首份完整 frame；
- malformed、unknown-required、oversize、gap、duplicate、out-of-order 的 fail-closed 策略；
- reliable Bootstrap ACK 与动态 frame 开始 barrier；
- viewer-specific exporter 和 queue 隔离。

初始连接、v5 resync、binary reconnect 和 Replay seek 都必须重新建立同一个“精确 v5 snapshot ACK + 匹配 Bootstrap `presentation.ready`”联合 gate。Replay scheduler和 live composite controller按两 lane的联合 credit前进；未匹配 v5 cursor、correlation和 binary frame的 join backlog也有独立 frame/byte hard limit，不能只限制单 socket queue。

presentation ACK 是 transport flow-control cursor，不是规则 authority ACK，也不推进游戏时间。ACK 中的 frame/correlation不匹配、ACK 回退或超出已发送窗口都必须 fail closed。authority v5 queue 与 binary display queue 都不能 latest-only；两者故障需要分别记录，且 display client 故障不能减少任何 gameplay tick、v5 authority record 或 tape record。

## 15. 跨仓发布、阶段门禁与回滚

`scene-engine`、`python-game`、`arts`、`replay` 是独立 Git 仓库，workspace 不锁版本，所以不存在一个天然的跨仓原子 Git commit。“同一版本一次切换”必须由 release manifest 表达：

```text
scene-engine commit + package/schema identity
python-game commit + exporter revision
arts commit + SceneManifest/resource identity
replay commit + presentation artifact schema
binding contract revision
golden corpus revision
```

可以保留一次最终生产切换，但应区分：

- 不允许长期 production dual-run；
- 允许并且必须有非生产 conformance、shadow/parity 和 owner adapter 门禁；
- 切换前可预部署 dormant、版本兼容的新 endpoint/package；
- 最终由版本化 route/manifest 把 DisplayShell 切到新 source；
- 回滚使用冻结的上一组完整 commit tuple，不依赖新版本中的运行时 fallback。

建议开发顺序：

1. 修改并批准 60Hz binding/Replay/display source 合同；
2. 冻结 Bootstrap、DisplayFrame 新 schema、viewer/ID、command correlation 和 golden corpus；
3. 增加 Scene Engine mandatory authority port 和 Python 单 tick facade；
4. 完成新旧 runtime 的 v5/tape byte parity；
5. 完成 live + Replay presentation producer/sidecar 和 60Hz ordered transport；
6. 在唯一 DisplayShell 中接入 StateSource/SceneDisplayEngine/Three backend；
7. owner-by-owner 完成 adapter、UI store 拆分和 static scene parity；
8. 完成 fault、Replay、性能、视觉和多 viewer 验收；
9. 在候选 release tuple 中删除经符号清单确认的旧 tick composition/dynamic ingress，使其退出 production import graph；清理提交发生在切换前并进入候选版本；
10. 冻结包含上述删除的 release manifest，演练前向部署和反向回滚；
11. 一次生产切换到该完整 tuple；回滚则整体部署上一 tuple，不在新版本保留双写入或运行时 fallback。

“无中间生产切换”没有问题；“无中间验收门禁”必须从原方案中删除。

## 16. 原方案可保留与必须改写的内容

### 可保留

- 唯一 SceneDisplayEngine facade；
- CompleteFrameStore 的 parse/validate 后原子 commit；
- store commit 与 renderer reconcile 分离；
- 唯一 DisplayShell/renderer/RAF；
- FeatureOwner 和 Arts resource authority 保留；
- epoch/bootstrap/generation 防迟到；
- complete-set 的 absolute presentation state；
- 最终不保留两个 production tick owner 或两个 dynamic handle writer；
- 一次最终生产切换和整组版本回滚。

### 必须改写

- `30Hz/latest-only` 改为 current `60Hz ordered`；
- Replay“不迁移”改为“raw v5 不变，但新增版本绑定的 60Hz presentation source/sidecar”；
- Bootstrap 从依赖清单补成可安装静态世界的物理合同；
- DisplayFrame 从基础 72-byte V1 升级为覆盖全部 owner 的 typed schema；
- 裸 display ID command 改为 Arts viewer-scoped interaction mapping + 未变化的 current v5 domain args/envelope；
- 只接收 `TickContext` 的 observer 改为明确的 ProjectionCommitBatch、WirePublicationBatch、RawRecordBatch 和唯一 ordered sink；
- “UI-only WorldStore 已存在”改为明确的新 store 迁移任务；
- one-running + one-pending-latest 改为每连接有界 ordered 60Hz queue + cumulative presentation ACK/credit；
- “无中间验收门禁”改为“无中间生产切换，但有强制开发/CI 门禁”；
- 性能完成定义补齐具体数字和目标环境；
- 删除清单改成精确符号清单，并保留 current v5 producer、tape、Replay 与 control owner。

## 17. 完成判断

修订后的方案没有不可解决的架构阻断，但在以下事项完成前不能开始最终切换：

1. binding 60Hz 合同明确允许新的 binary dynamic source；
2. Replay presentation source/sidecar 和旧 tape 策略冻结；
3. Bootstrap、完整 owner schema、projection→v5 cursor correlation records 和独立 presentation-control ACK/credit 已跨语言冻结；
4. current v5 command、Arts display-handle→domain-args mapping 和双 cursor barrier 因果链闭合；
5. authority/durable outbox/tape/Replay/Arts 的 60Hz parity 与故障门禁通过；
6. 单壳、单写入、tick-derived animation、异步资源、viewer 隔离和性能门禁通过；
7. 跨仓 release manifest 与整体回滚演练通过。

达到这些条件后，可以执行一次最终生产切换；在此之前，Scene Engine 仍应保持 experimental，不得静默替换 current v5/Replay/Arts 链路。

## 18. 当前代码证据索引

下列路径是本文判断“当前代码设计”的主要依据，均以 Missile War workspace 根目录为基准：

| 路径 | 当前职责或事实 |
| --- | --- |
| `scene-engine/src/scene_engine/runtime.py` | engine-owned tick、catch-up、next-tick command queue、sampled display export；尚无 mandatory authority port |
| `scene-engine/src/scene_engine/display_frame.py` | V1 header/directory/72-byte record 的 writer/parser 和 complete-set 校验 |
| `scene-engine/src/scene_engine/packet_codec.py` | 24-byte packet envelope；当前只接受 `message_type = 2` |
| `scene-engine/src/scene_engine/identity.py` | 单 scene/bootstrap active set 与 retired ID 检查；尚无 viewer scope/allocator/reverse resolver |
| `scene-engine/src/scene_engine/latest_mailbox.py` | 实验 latest-only immutable bytes mailbox 和有界 lease，不是正式 60Hz transport |
| `python-game/core/runtime_driver.py` | current wall-clock deadline、逐 tick catch-up、每 tick `advance + publish` |
| `python-game/core/runtime_application.py` | mutable world、每 tick v5 projection、即时 command/query、同 tick authority commit |
| `python-game/core/authority_state_stream.py` | v5 state sequence、ACK、retention、reset/resync 和 pending ordered frames |
| `python-game/adapters/web/runtime_bridge.py` | current v5 input、ordered broadcast、reconnect snapshot |
| `python-game/adapters/web/socket_server.py` | current JSON WebSocket queue、raw input bytes 和慢连接处理 |
| `python-game/cli/demo1.py` | current Demo1 raw v5 tape producer 和 Replay 上传 |
| `replay/src/protocol.js` | raw v5 frame/tape 校验、连续 state/tick/cursor 规则，不做 renderer projection |
| `replay/src/store.js` | tape 文本原样保存、SHA 校验、current metadata identity |
| `replay/src/server.js` | snapshot ACK-gated playback、tick 派生 60Hz 延迟、暂停和倍速 |
| `arts/web3d/src/main.js` | live/replay protocol-first preflight，从首 snapshot 建 authority-driven scene manifest |
| `arts/web3d/src/state-sources/displayStateSourcePolicy.js` | `none/display-fixture/replay/live` kind 策略；replay/live 共用 protocol-connected 路径 |
| `arts/web3d/src/plugins/protocol/displayProtocol.js` | v5 StateEpochMirror、render snapshot/delta materialization、current command envelope |
| `arts/web3d/src/display-shell/createDisplayShell.js` | 唯一 runtime/renderer/RAF/SceneHost/StageRegistry、source activation 和 disposal 生命周期 |
| `arts/packages/display-runtime/worldStore.js` | committed v5 mirror 的 renderer-local map/entities projection |
| `arts/web3d/src/render-reconciler/target7RenderReconciler.js` | map/coordinate、dynamic handles、FeatureOwner、UI/status 的当前组合实现 |
| `arts/packages/display-sdk/runtimeElementRegistry.js` | 从 activation plan 唯一解析已激活 owner 并调用其 handle hook |
| `arts/web3d/review/display-fixture/displayFixtureSource.js` | fixture snapshot 生成辅助代码；当前尚未接成统一 production StateSource |
