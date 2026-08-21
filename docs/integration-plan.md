# Scene Engine 工作总结与核心集成路线

状态：实现总结 + draft / non-binding 集成计划  
更新时间：2026-08-21

## 1. 目的与结论

本文回答两个问题：

1. 当前 `scene-engine` 已经完成了什么；
2. 后续怎样把它接入 `python-game` 和 Arts Web3D 显示壳，逐步成为二者共用的核心场景引擎。

这里的“核心引擎”有明确边界：

- 对 `python-game`，Scene Engine 最终负责固定步长、唯一整数 tick、命令批次边界、运行状态和显示帧导出调度；
- 对显示壳，Scene Engine 最终负责 renderer-neutral 的 bootstrap、完整动态帧、实体显示生命周期、帧消费和有界 latest-only 调度；
- 玩法规则、`WorldState`、命令合法性、业务事件和 viewer 可见性仍属于 `python-game`；
- Three.js、DisplayShell 生命周期、FeatureOwner、资源目录、UI 和最终绘制仍属于 `arts`；
- current v5 authority、raw tape 和 Replay 在另立 binding 迁移合同前保持不变。

因此，目标不是把 `python-game` 或 Arts 搬进本仓库，而是用稳定 ports 把通用运行机制抽出来。

## 2. 当前已经完成的工作

### 2.1 独立项目与约束边界

- 建立独立 GitLab 项目 `missile-war/scene-engine`，默认分支为 `main`；
- Python distribution 名为 `scene-engine`，import package 名为 `scene_engine`；
- 最低 Python 版本为 3.9，当前实现只使用标准库；
- 建立 runtime、binary frame、current-v5 boundary 和 extraction plan 文档；
- 明确本项目是 experimental kernel/pre-slice，不会静默替换 current v5 链路。

### 2.2 Engine-owned tick runtime

`src/scene_engine/clock.py` 与 `src/scene_engine/runtime.py` 已实现：

- `SystemMonotonicClock` 和可确定性测试用 `ManualClock`；
- runtime 默认从 0，或从显式校验的非负 `initial_tick` 恢复后递增整数 tick；
- wall clock 只计算应补做多少 tick，不直接成为玩法时间；
- catch-up 逐 tick 执行且受 `maximum_ticks_per_pump` 限制，不合并或跳过 overdue tick；
- `pump()` 非重入，并发或回调中重入会立即失败而不是死锁；
- gameplay 每次只收到一个只读 `TickContext` 和冻结的 command tuple；
- 未开始命令队列有 `maximum_pending_commands` 上限，overflow fail closed；
- gameplay 异常逃逸后失败 tick 不提交、不重试，runtime 永久进入 fatal；
- stop、fatal、health 和每次 pump 的结果都有显式状态。

### 2.3 simulation 与 display 调度分离

runtime 使用整数有理累加器决定 display sample，不建立第二套时间基准：

- 60 TPS / 30 FPS 在 completed tick 2、4、……、60 尝试导出；
- 非整除采样率也不会依赖累计浮点 deadline；
- display export、writer、seal 或 sink 失败只跳过该 presentation sample；
- display 失败会记录 health，但不回滚已提交玩法 tick，也不阻止后续 gameplay；
- 低层 runtime 在 exporter callback 正常返回后推进 `frame_seq`；标准 `SceneEngine` host 则只有在
  writer/seal、identity 检查和 mailbox publish 全部成功后才算该 sequence 成功。

这一“可降采样 display”能力当前只属于实验 presentation 支路。Missile War current 合同仍要求
60Hz 权威状态、60Hz 显示消费和 60fps 验收；若未修改该合同，正式 MW profile 必须使用 60 display FPS。

### 2.4 Canonical packed display frame

`src/scene_engine/binary_schema.py` 与 `src/scene_engine/display_frame.py` 已冻结第一版机械布局：

| 结构 | 固定大小 | 当前语义 |
| --- | ---: | --- |
| `DisplayFrameHeaderV1` | 64 bytes | epoch、bootstrap、frame seq、source tick、频率、计数和长度 |
| `SectionDirectoryEntryV1` | 20 bytes | required section 的 offset、length、stride 和 count |
| `DynamicEntityRecordV1` | 72 bytes | display/visual ID、visible、absolute world TRS 和 animation state |

编码统一使用 little-endian，不暴露 native struct、指针或可变 backing storage。writer 和 parser 会检查：

- frame entity/byte budget；
- header、directory、总长度、alignment、range 和 stride；
- reserved 字段、required section 和当前 `event_count = 0`；
- 正整数 ID、帧内严格递增的 `display_id`；
- finite `float32` 与归一化 quaternion；
- truncation、trailing bytes、重复 record 和非 canonical layout。

`tests/fixtures/display_frame_v1.hex` 是当前 156-byte byte-exact golden vector。任何不兼容物理变更必须
使用新 `schema_version` 和新 golden，不允许在 schema 1 下静默改写。

### 2.5 producer identity、latest mailbox 与 complete consumer

以下边界已经实现并相互组合：

- `DisplayIdentityTracker` 观察每份 producer frame，在 mailbox 覆盖前禁止 epoch 内退休 ID 复用；
- identity 更新使用 prepare → publish → commit，publish 失败不会污染 tracker；
- `LatestFrameMailbox` 只接收 immutable bytes，未 acquire 的旧 latest 可被覆盖；
- 已 acquire frame 在 lease release 前保持稳定，outstanding lease 数量有界；
- `CompleteFrameConsumer` 先完整解析和验证，再一次性替换状态，不产生 partial apply；
- complete-set 中缺席表示 remove，存在但 `visible = false` 表示 hidden-but-alive；
- frame/source-tick gap 对 presentation consumer 合法，旧帧可按策略 ignore 或 reject；
- consumer 检查 epoch、bootstrap、TPS、sequence、source tick 和 ID lifecycle。

`src/scene_engine/host.py` 中的 `SceneEngine` 已把 runtime、writer、producer identity tracker 和 mailbox
组合成一个 polling host，提供 `pump()`、command enqueue 和 display frame acquire/release。

### 2.6 Packet envelope 与测试证据

`src/scene_engine/packet_codec.py` 已实现固定 24-byte `PacketHeaderV1`：

- magic 为 `SEDF`；
- 当前只接受 `message_type = 2 / display.frame`；
- 当前只接受 `compression_codec = 0 / none`；
- packet budget 与内部 display frame budget 分层验证；
- stored/uncompressed length、截断和尾随数据严格检查。

当前首切片共有 100 项测试，覆盖 runtime、command queue、fatal、binary golden/malformed corpus、packet、
identity、mailbox 并发 lease、consumer 原子性和 host transaction。纵向测试证明：

```text
60 个有序 gameplay tick
  -> 30 份完整 display frame
  -> consumer 只安装 seq 1 / 4 / 9 / 15 / 30
  -> 仍得到 tick 60 的最终绝对位置、正确 hidden/remove 和 ID 生命周期
```

验证命令：

```bash
PYTHONPATH=src python3 -m pytest -q
PYTHONPYCACHEPREFIX=/tmp/scene-engine-pycache python3 -m compileall -q src tests
```

## 3. 目前还没有完成的部分

以下能力不能写成“已经实现”，也是跨仓接入前的真实 blocker：

- 每个 committed tick 必达、与 display sampling 分离的 authority commit port；
- packed `SceneBootstrap`、profile identity、坐标轴/单位和 viewer scope；
- `visual_type_id`、resource、animation 和 extension channel manifest；
- 可可靠送达的业务 event/control lane；
- WebSocket server、binary subprotocol 和 one-running + one-pending-latest backpressure；
- JavaScript/TypeScript browser decoder 与 complete-frame renderer adapter；
- 真正的 reusable frame pool、低分配/zero-copy 路径；
- async resource generation、capture/dump、diagnostics 和性能基线；
- C++ core、C ABI、Unity/Godot/Web 通用 renderer adapter；
- epoch 自动 rollover、bootstrap 更新和完整恢复流程；
- producer `display_id` allocator、domain object 映射、持久化/恢复与耗尽策略；
- current protocol、raw tape、Replay 或 acceptance 的正式迁移。

## 4. 目标双支路架构

接入期间必须同时保留“必达权威支路”和“可覆盖显示支路”：

```text
                         Missile War 玩法与业务所有权
                    +--------------------------------+
commands / queries ->| python-game adapter + WorldState |
                    +----------------+---------------+
                                     ^
                                     | step(tick, frozen commands)
wall clock -> SceneEngineRuntime -----+
              唯一 60Hz tick owner
                     |
                     | 每个 committed tick，严格有序、不可抽样
                     +--> AuthorityCommitPort
                     |      -> current v5 projection/stream
                     |      -> raw tape / Replay
                     |      -> current StateEpochMirror / UI / business facts
                     |
                     | 按 display rate 采样，完整绝对状态
                     +--> MissileWarDisplayExporter
                            -> canonical DisplayFrame bytes
                            -> bounded latest transport
                            -> SceneEngine StateSource
                            -> CompleteFrameStore / Binder
                            -> existing FeatureOwners / Three adapter
                            -> the one existing DisplayShell / renderer / RAF
```

两条支路必须有显式 session correlation，但不能假设 wire identity 类型相同：current v5
`state_epoch` 是字符串，而 binary `scene_epoch` 是 `u64`。adapter 维护二者的一一映射；整数
`source_tick` 必须直接一致，各自的 schema/profile identity 分别版本化。失败与背压语义也不同：

| 支路 | 是否允许丢中间项 | 失败语义 | 用途 |
| --- | --- | --- | --- |
| authority | 不允许 | callback/ordered sink 故障 fail-stop；协议级 reset/resync 保持 current 恢复语义 | 规则事实、命令结果、raw tape、Replay、验收 |
| display | 允许覆盖未消费 latest | 跳过 sample、保留最后已安装完整状态 | renderer presentation |

absolute `float32` pose 是显示事实，不是新的 RuleSpace 权威。规则位置、碰撞、路径和 Replay 仍由
`python-game` 的精确数据与 current authority 支路负责。

## 5. 各仓库最终职责

| 能力 | `scene-engine` | `python-game` | `arts` 显示壳 |
| --- | --- | --- | --- |
| fixed-step clock / tick / catch-up | 拥有 | 不再另建 driver | 不推进玩法时间 |
| command batch 机械边界 | 拥有 | 解释与裁决玩法命令 | 产生 intent，不裁决 |
| WorldState / 玩法规则 / AI / 战斗 | 不包含 | 拥有 | 不包含 |
| current v5 projection / ledger / ACK / Replay | 提供必达 port 机械能力 | 当前语义 owner | current consumer / UI |
| complete display bytes / ID lifecycle / limits | 拥有 schema 与 conformance | 导出 MW profile | 解码后原子安装 |
| visual/resource mapping | 定义通用 manifest 结构 | 选择 MW `visual_type_id` | 映射到已激活 FeatureOwner/resource |
| renderer / DOM / RAF / scene lifecycle | 不拥有 | 不拥有 | 拥有且保持唯一 |
| UI / selection / input presentation | 不拥有 | 提供业务结果 | 拥有 |

## 6. 接入 `python-game` 的计划

### PY0：先补 mandatory authority commit port

在 Scene Engine runtime 增加同步 post-commit port，执行顺序必须固定为：

```text
freeze commands
  -> gameplay.step(tick)
  -> mark tick committed
  -> authority commit/publish（每 tick 必调一次）
  -> optional sampled display export
  -> next tick
```

authority port 失败时，已经原地修改的 gameplay state 无法回滚，因此语义应是：当前 tick 保持已提交，
runtime 立即 fatal，不执行下一 tick，不自动重试 publication；外层以新 stream/epoch 和完整 snapshot 恢复。
这类失败必须与“gameplay step 异常、tick 未提交”区分记录。

这里的 port/sink 故障不等于 current v5 的 ACK timeout、retention overflow 或显式 resync。后几种情况
继续使用既有 reset + snapshot 恢复并继续模拟的语义，不能一律升级为 runtime fatal。

硬测试必须证明：60 个 committed gameplay tick 精确触发 60 次 authority callback；display rate 配为 30
时只触发 30 次 display export，且 display 失败不能减少 60 次 authority commit。

### PY1：增加 Missile War adapter，不直接搬现有模块

在 `python-game` 增加公开 adapter 层，建议拆为三个角色：

1. `MissileWarSimulationAdapter`
   - 持有 current `V5RuntimeApplication` 或其公开 gameplay facade；
   - 每次 `step(context, commands)` 只推进一个 tick；
   - step 前检查 `WorldState.tick == context.tick - 1`，正常返回后检查
     `WorldState.tick == context.tick`，并固定 `context.ticks_per_second == 60`；
   - 第一阶段 command tuple 保持为空，current v5 raw control/ledger 语义不变。
2. `V5AuthorityCommitPort`
   - 通过新的公开 API 取得该 tick 的全部 current v5 frames；
   - 逐 frame、原顺序交给现有 transport/tape；
   - 不调用 `V5RuntimeApplication._commit_projection()` 或 bridge `_broadcast_all()` 等私有方法。
3. `MissileWarDisplayExporter`
   - 首阶段消费现有 viewer-scoped `V5Projection` 或由同一 visibility owner 提供的公开 facade，不能
     遍历裸 `WorldState` 重新猜一套可见性；
   - 负责 MW object → stable `display_id` / registered `visual_type_id` 的 profile mapping；
   - 使用 Rule Transform 的最终结果生成 absolute world TRS，不把 hex、PositionRef 或玩法对象塞进 core。

当前精确接点是：

- `python-game/core/runtime_driver.py`：其 fixed-step deadline/tick 部分最终由 `SceneEngineRuntime` 替代；
- `python-game/core/runtime_application.py::V5RuntimeApplication`：继续作为 mutable world、ledger 和 v5
  projection owner，先补公开单 tick/commit facade；
- `python-game/core/simulation.py::tick_runtime_ticks`：仍是玩法推进实现；
- `python-game/adapters/web/runtime_bridge.py::V5RuntimeBridge`：拆出公开 ordered frame sink，不能让
  Scene Engine adapter穿透其私有 broadcast 状态；
- `python-game/cli/runtime.py::run_runtime_service`：只在 parity 门禁通过后，把 composition root 从
  `RuntimeDriver` 切到 `SceneEngine`。

`SceneEngine` 当前只有 polling `pump()`，不能直接替代 `RuntimeDriver.run()` 的全部职责。`python-game`
需要一个不拥有第二套 tick deadline 的 service loop，固定顺序为：

```text
drain/process current inputs once
  -> SceneEngine.pump()
       -> 对 pump 内每个 committed tick 执行 authority sink
       -> 对每个 tick 保持 publish_pending / ACK-timeout / reset 时机
  -> bounded sleep / run_seconds / stop handling
```

catch-up 一次 pump 可推进多个 tick；是否在这些 tick 中间重新 drain input 必须显式冻结。为保持 current
行为，首阶段不插入，仍只在本轮 catch-up 之前处理一次输入。

### PY2：旁路双跑，不立即替换 current CLI

先增加 opt-in experimental composition：

- current v5 input、ACK、query、command result、authority frames 和 tape 原样工作；
- Scene Engine 同时导出独立 identity 的 binary display frames；
- 相同 seed/input 下，对比旧 `RuntimeDriver` 与新 engine host 的 tick、world revision、world hash、
  v5 frame 数量/顺序/bytes 和 event cursor；
- catch-up、command during step、queue overflow、authority failure、display failure 和 shutdown 全部做 fault test。

current command 现在可以在同 tick 产生额外 delta，并由 intent ledger 绑定 observable cursor。不能为了
复用 `SceneEngine.enqueue_command()` 就提前改变这一语义；command batch 的正式迁移需要单独合同与 parity。

### PY3：通过门禁后让 Scene Engine 成为唯一 runtime driver

只有下列条件同时满足，`cli/runtime.py` 才切换默认 composition：

- `RuntimeDriver` 和 Scene Engine 在固定 seed/input 上 authority 输出一致；
- 60Hz catch-up 不丢任何 v5 authority frame；
- raw tape、Replay ingest/playback 和现有 acceptance 无回归；
- authority publish 失败明确 fail-stop，display publish 失败明确隔离；
- 运行指标能区分 gameplay、authority 和 display 三类 health；
- PY2 双跑阶段已证明关闭 experimental 开关即可回到旧 composition；PY3 切换后的版本回滚不需要
  转换存档或 tape。

切换后 `python-game` 只保留一个 tick owner；旧 driver 不能以 fallback 形式同时运行。
这一步只替换内部 driver，current v5 wire、tape 和 Replay 语义不变；未来若要替换 current v5 本身，
仍需另立 binding 迁移决议。

## 7. 接入 Arts Web3D 显示壳的计划

### D0：先冻结 bootstrap 与 profile

浏览器不能只靠 `DisplayFrame` 猜出坐标和资源语义。可靠 `SceneBootstrap` 至少需要冻结：

- schema/profile identity、scene epoch、bootstrap ID 和 TPS；
- 坐标轴、handedness、world unit、quaternion order 和 float policy；
- viewer/filter identity，保证 complete set 不泄露不可见对象；
- `visual_type_id` → FeatureOwner/resource/variant 的 registry；
- animation state registry、limits 和 extension channel capability；
- 静态场景依赖及其 content identity。

Bootstrap 必须可靠送达、完整验证并先于任何 dynamic frame 安装；它不进入 latest-only 覆盖队列。
SceneManifest/catalog 先决定允许的 experimental source、owner 和 resource 范围，网络 bootstrap 只能在
该范围内完成绑定，不能反过来影响 activation。

### D1：同一 DisplayShell 下增加独立 experimental StateSource

不能修改 current `createTarget7DisplayProtocol()` 让它同时猜 JSON v5 和 binary Scene Engine packet。
current protocol 继续绑定 `StateEpochMirror`、ACK/resync 和连续 tick；新格式使用独立 parser、identity 和
StateSource。

当前 `createDisplayShell.js` 无论 source kind 都默认持有 v5 `protocol`，并把 ingress、control 和 UI
emitter 合在同一对象。接入前应先抽出受 SceneHost 管理的 `stateSource` 生命周期端口，以及可选的
`controlChannel`；current v5 protocol 适配这两个端口，binary source 使用自己的 controller，不能伪装
成 v5 protocol object。

计划接点：

- 在 `arts/web3d/src/main.js` 增加 Scene Engine 专用 preflight：先 resolve/validate catalog
  SceneManifest 与 experimental source profile，再由专用 controller 取得并验证 bootstrap，随后才创建/
  启动 DisplayShell；冻结的 bootstrap 驱动既有 PREPARE/BAKE/MOUNT 静态安装，`DISPLAY_READY` 是完整
  安装后的 barrier，ACTIVATE 只启用 dynamic frame 消费并安装 pending latest；
- 保留 `arts/web3d/src/display-shell/createDisplayShell.js`，继续只有一个 renderer、一个 RAF、一个
  StageRegistry/SceneHost 生命周期和反向 dispose；
- 使用专用 non-current SceneManifest 固定选择 experimental profile；不能只向全局 URL source 白名单
  添加一个值，让任意 current 场景被 query 覆写到实验协议；
- 不在 `displayProtocol.js`、`StateEpochMirror` 或 current v5 parser 中增加 binary fallback/sniffing。

### D2：实现 Web decoder 与有界 latest scheduler

Web 侧 decoder 必须复用同一 schema、golden 和 malformed corpus，并先验证 packet/frame budget 后分配。
调度器不能直接复用当前 FIFO `messagePump` 作为 display backpressure，因为 FIFO pending 可以增长；需要：

```text
reliable bootstrap barrier
          |
          v
one running decode + CompleteFrameStore commit operation
+ at most one replaceable pending raw latest packet
```

新 epoch、bootstrap 变化或 DisplayShell dispose 必须让旧 pending/running 结果失效。decoder/store commit
不等待 renderer 资源加载；后续异步 reconcile 在资源完成后重新检查 generation，防止已经 remove 的实体
被迟到任务复活。

### D3：新增 complete-set store/binder，不伪装 current WorldStore

binary record 不能伪装成现有 `world.snapshot` / `world.delta`：current WorldStore 和 render projection 依赖
map、PositionRef、RuleTransformMirror 和 MW business shape，而 complete frame 只有 absolute presentation state。

需要把“原子状态安装”与“可重建 renderer reconcile”分成两层：

1. 完整 parse、profile/epoch/bootstrap/tick/ID 验证；
2. 在临时 candidate 中计算 create/update/hide/remove；
3. 所有验证成功后一次 commit `CompleteFrameStore`，corrupt/unknown/oversize 不改变上一状态；
4. renderer 从已提交 store reconcile，使用 absolute world TRS 更新 `TransformNode` / Three adapter；
5. 以 `{scene_epoch, display_id, visual_type_id, generation}` 保护 async resource lifecycle；
6. frame 中缺席在 store 中 remove/retire，renderer 随后 dispose；`visible = false` 只隐藏不退休；
7. `visual_type_id` 变化默认视为 replace，不能复用错误 FeatureOwner handle；
8. 异步 renderer create/update 失败记录 health，并从当前 committed store 重建；它不回滚 store，也不能
   阻塞下一份 complete frame 的 decode/commit。

consumer 只能检查自己实际观察到的帧；如果 removal 与非法 reuse 都落在它跳过的区间，就无法推断违规。
因此 epoch 内 ID 不复用的规范门禁仍是 producer `DisplayIdentityTracker`，Web 检查只是额外防线。

`visual_type_id` 只能解析到 SceneManifest 已激活的 catalog owner/resource，网络数据不能携带任意 import
字符串，也不能绕过 Arts 的 code/resource isomorphic owner 规则。

### D4：逐类迁移动态 renderer

当前 `target7RenderReconciler` 的部分 handle 强制需要 PositionRef。应先为最简单的动态实体增加
absolute-world-TRS presentation port，再按 owner 类型迁移：

1. 无资源或简单 sprite/effect；
2. projectile / aircraft；
3. small person 与 animation；
4. building/weapon attachment；
5. 需要异步 generation 或复杂资源依赖的 owner。

迁移某类实体后，该类 pose/lifecycle 只能由一个 ingress 更新。v5 可以继续作为独立的
business/control/UI lane 与 authority 校验来源，但不能成为该 DisplayShell 的第二个 StateSource，也不能
让 v5 render projection 和 complete binder 同时写同一个 render handle。

### D5：显示壳晋升条件

Scene Engine 只有满足以下条件，才可称为该显示壳的 dynamic core：

- 所有动态 create/update/hide/remove/animation 都从 Scene Engine complete frames 驱动；
- DisplayShell、renderer、RAF、FeatureOwner 和资源 authority 仍保持唯一；
- current v5 parser 没有兼容分支，实验入口可以完全关闭；
- unknown visual、corrupt/oversize frame、epoch reset 和 async dispose 全部 fail closed；
- 100/1000/3000/5000 entities 的 decode、reconcile、memory 和 RAF 性能预算已冻结并通过；
- current 60Hz authority mirror、raw tape、Replay 和验收没有被 latest-only 替代。

## 8. 跨仓验收矩阵

| 范围 | 必须证明 |
| --- | --- |
| Tick | 相同 seed/input 下恰好 60 step/s；只有 Scene Engine 一个 tick owner |
| Authority | 60 committed tick → 60 次必达 commit；catch-up 仍逐 tick、顺序不变 |
| Current v5 | 启用旁路前后 frame count/order/bytes、ACK、event cursor 和 tape 不变 |
| Display sampling | source tick 按配置采样；30fps 只用于实验，current MW 默认仍按合同 60fps |
| Binary conformance | Python 与 Web golden byte-identical；malformed corpus 结论一致 |
| Complete frame | 跳 1→4→9 后最终集合一致；absence/remove、hidden、ID retire 正确 |
| Atomicity | corrupt、unknown visual 或超预算帧零部分提交，上一已安装帧继续可绘制 |
| Backpressure | display pending 永远不超过 1；authority queue 不能 latest-only |
| Lifecycle | reconnect/epoch/bootstrap/dispose 后旧 async generation 不能复活对象 |
| Renderer | 唯一 shell/renderer/RAF；视觉基线、资源释放和 owner 边界通过 |
| Replay | current raw tape 不重采样、不合帧，Replay 定向测试与验收保持通过 |
| Performance | 100/1000/3000/5000 entities 在冻结设备与场景上通过已记录预算 |

## 9. 风险与待冻结决策

1. **双 tick owner**：Python `WorldState.tick` 与 Scene Engine tick 一旦可独立推进，会立即破坏确定性。
2. **post-commit 失败无 rollback**：必须 fail-stop 并建立新 epoch，不能自动 retry 同一 tick。
3. **profile 不完整**：没有 bootstrap 时，`visual_type_id`、坐标和 absolute f32 pose 没有跨端语义。
4. **viewer complete-set 泄露**：exporter 必须在 frame 生成前完成 viewer scope 过滤。
5. **把 presentation 当 authority**：latest frame/capture 不能成为碰撞、路径、命令结果或 strict Replay 来源。
6. **异步资源迟到**：resource create 必须携带 generation 并在 commit/dispose 前复核。
7. **ID/epoch 耗尽**：epoch rollover、bootstrap 更新和 allocator 恢复仍需冻结。
8. **分配压力**：当前 immutable bytes 和 polling lease 正确但尚未证明 3000/5000 实体预算。
9. **跨仓版本漂移**：Python、Web decoder、profile 和 golden 必须使用显式兼容 identity 与发布门禁。
10. **display rate 决议**：current 合同仍要求 60；若产品要将 presentation 降为 30，必须先修改 binding
    合同和 acceptance，不能只改 runtime config。

## 10. 建议实施顺序

```text
S0  authority commit port + failure semantics
S1  bootstrap/profile/visual registry
S2  python-game opt-in adapter + 60 authority / sampled display 双支路测试
S3  Python driver cutover，current v5 wire 保持不变
S4  binary Web transport + same-DisplayShell experimental StateSource + complete binder
S5  owner-by-owner dynamic renderer migration
S6  performance、fault、Replay、visual cross-project acceptance
S7  若未来替换 current v5/display 协议，另立 binding 迁移决议后再切换并删除旧协议 path
```

S3 以前必须保持默认 current runtime 可运行；S3 通过时可在 current wire 不变的前提下原子替换 Python
driver，并在同一迁移中删除旧 tick driver。其余阶段通过门禁后再删除被替换实现；不保留两个默认 tick
driver、两个 production parser 或两个 DisplayShell 作为永久 fallback。
