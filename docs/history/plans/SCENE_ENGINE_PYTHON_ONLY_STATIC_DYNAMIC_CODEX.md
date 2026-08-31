# Scene Engine 静态初始化 / 动态帧彻底分离
## Python-only Codex 一次性执行文档

> 历史计划：仅用于追溯 Scene Engine Python 0.6.0 阶段的迁移决策，不是当前执行指令。
> 当前实现与验证口径以仓库根目录 README 所列合同为准。

**历史状态：当时替代上一版跨 Web 执行计划的执行指令**

**适用基线：Scene Engine Python 0.6.0 / `scene-engine-wire@1` / `scene-engine-scene@1` / `missile-war-world-state@2`**

**修改范围：仅 `scene-engine` Python 端与 `python-game`**
**切换策略：内部实现一次切换，不保留双路径、feature flag、兼容 wrapper 或旧热路径**

---

# 0. 计划调整结论

本轮可以、也应该限制在：

```text
scene-engine Python runtime / scene codec
python-game product program / scene projection
```

以下仓库和目录正在进行独立架构调整，本轮全部只读：

```text
scene-engine/js/**
arts/**
replay/**
```

因此，本轮不再执行上一版计划中的：

```text
Scene Engine JS Client 修改
Arts schema / selector 修改
Replay fixture / playback 修改
missile-war-world-state@3
Idle wander 紧凑 wire 形状
Scene Engine JS package 升级
客户端性能重构
```

这不是保留旧架构，而是冻结当前外部边界。服务端内部旧热路径仍然要一次性物理删除。

---

# 1. 本轮唯一目标

> **在不改变当前 wire、场景二进制格式和完整 WorldState JSON 合同的前提下，让服务端真正做到：静态场景只在 stream 初始化时构建与验证；普通 tick 只处理 500 个动态节点。**

目标运行规模：

```text
约 632 个静态节点：岛屿、地形格、静态拓扑
500 个动态节点：person / company address / building / weapon
60 Hz
普通 tick 继续发送一份完整动态 SceneFrame
```

完成后的服务端路径必须是：

```text
首次 checkpoint / stream 初始化
  ├─ 完整扫描并验证静态地图一次
  ├─ 构建静态 bootstrap bytes 一次
  ├─ parse bootstrap 一次
  ├─ 建立静态验证索引一次
  ├─ 构建完整 WorldState snapshot
  └─ 投影并编码当前动态 frame

普通 tick
  ├─ gameplay step
  ├─ WorldState patch
  ├─ 投影 500 个动态 SceneNode
  ├─ 只校验动态节点及其父链
  ├─ 编码动态 SceneFrame
  └─ 编码 engine.commit
```

普通 tick 必须满足：

```text
静态节点遍历次数 = 0
静态 registry 重建次数 = 0
静态 parent graph 重验次数 = 0
静态 depth 重算次数 = 0
静态 world pose 计算次数 = 0
terrain/bootstrap 重建次数 = 0
```

---

# 2. 外部边界完全冻结

## 2.1 不得变化的合同

以下合同必须保持当前值和当前语义：

```text
scene-engine-wire@1
scene-engine-scene@1
missile-war-world-state@2
```

不得修改：

```text
engine.checkpoint 字段集合与语义
engine.commit 字段集合与语义
engine.input / engine.ack / engine.input_result
Scene Bootstrap binary schema version
Scene Frame binary schema version
JSON patch schema
完整 WorldState 根 schema
ACK、session、retention、Replay packet 语义
```

对同一固定输入，优化前后应保持：

```text
bootstrap bytes byte-identical
scene frame bytes byte-identical
WorldState snapshot bytes byte-identical
engine packet bytes byte-identical
```

若某项无法 byte-identical，必须证明是原实现非确定性 bug；否则视为越界修改。

## 2.2 只读路径

总控必须在开始和结束时检查以下路径无 diff：

```text
scene-engine/js/**
arts/**
replay/**
```

同时禁止修改：

```text
scene-engine/js/package*.json
scene-engine/js/packages/*/package.json
arts/package*.json
replay/package*.json
Arts / Replay vendor tgz
JS client / renderer 版本和 lockfile
```

可以运行这些项目现有测试，但不得为了让测试通过去修改它们。若现有 Web 测试因服务端输出变化而失败，应修正 Python 输出，恢复当前合同。

## 2.3 本轮明确延期的内容

以下问题存在，但与当前 Web 边界有直接耦合，本轮不处理：

```text
PersonIdleWanderPlan wire 形状压缩
删除 plan 中输出给消费端的 tile graph / tile centers
missile-war-world-state@3
WorldState checkpoint 从约 26 MiB 压到 6 MiB
客户端 checkpoint install 性能
JS SceneTree / SceneEngineClient 进一步优化
Arts selector 调整
Replay packet fixture 换代
```

不得通过偷偷改变 `@2` 内部字段形状来绕过 schema 升级。延期就是延期，不做隐式合同漂移。

---

# 3. 允许修改的范围

## 3.1 Scene Engine Python

主要允许：

```text
scene-engine/src/scene_engine/scene.py
scene-engine/src/scene_engine/runtime.py
scene-engine/tests/test_scene_v1.py
scene-engine/tests/test_scene_benchmark.py
scene-engine/tests/test_runtime.py
scene-engine/scripts/benchmark_scene_500.py
```

最终集成阶段如确需发布 Python wheel，可修改：

```text
scene-engine/pyproject.toml
```

但只能升级 Python distribution 的 patch 版本；不得联动 JS package 版本或协议版本。

## 3.2 Python Game

主要允许：

```text
python-game/adapters/scene_projection.py
python-game/tests/test_scene_projection.py
python-game/tests/test_scene_engine_program.py
python-game/scripts/benchmark_runtime_500.py
```

最终集成阶段如需安装新 Python wheel，可修改：

```text
python-game/pyproject.toml
python-game/requirements.lock
python-game/vendor/scene_engine-*.whl
```

## 3.3 本轮冻结的 Python Game 文件

为避免触碰完整数据合同，本轮不修改：

```text
python-game/core/models.py
python-game/core/idle_wander.py
python-game/adapters/world_state_codec.py
python-game/core/world_change_journal.py
```

除非总控发现当前静态投影优化存在无法绕开的直接编译错误；即使如此，也不得改变对外 JSON 形状或 schema。

---

# 4. 必须保持的架构

继续保持：

```text
SceneEngineRuntime        唯一服务端 runtime
SceneBootstrapView        bootstrap 的唯一 Python 解析结果
MissileWarEngineProgram   唯一产品端口
MissileWarSceneProjection 产品场景投影
WorldChangeJournal        当前真实数据变更记录
一条 Engine packet 流
一个 WorldState owner
一个 ACK 序列
一棵消费端 SceneTree
```

本轮不是建立一套新的“静态系统”。只允许在现有对象内部缓存已验证的派生信息。

---

# 5. 严格禁止新增的架构

不得新增：

```text
StaticSceneService
DynamicSceneService
ScenePipeline
SceneProjectionRegistry
BootstrapManager
CacheService
TerrainRepository
WorldRepository
EventBus / MessageBus
ECS
UnitOfWork / TransactionManager
worker / job queue
第二份 WorldState
第二份场景模型
scene delta wire
bootstrap patch
网络压缩层
兼容 decoder
legacy adapter
feature flag 双路径
```

本轮生产代码最多允许新增：

1. `SceneBootstrapView` 内的私有只读派生索引；
2. `scene.py` 内一个私有动态树校验函数；
3. `runtime.py` 内一个私有 current-checkpoint helper；
4. `MissileWarSceneProjection` 内少量静态身份缓存字段；
5. 测试用计数器、benchmark 与断言。

任何超出以上范围的新公共类型都需要删除，而不是在报告中解释其必要性。

---

# 6. Scene Engine Python：静态验证索引只建立一次

## 6.1 当前问题

当前 frame 热路径近似执行：

```python
encode_scene_frame_against_bootstrap(...)
    -> _validate_nodes(... bootstrap.visual_types, bootstrap.animation_states ...)
    -> _validate_tree(dynamic_nodes, bootstrap.static_nodes, ...)
```

导致每帧：

```text
从 visual tuple 重建 map
从 animation tuple 重建 set
拼接 static + dynamic
重建完整 by_id
重验静态 parent
重算静态 depth
计算静态 world pose
```

而 frame encoder 并不使用完整 world pose。

## 6.2 扩展现有 SceneBootstrapView

直接在现有 frozen dataclass 内增加私有、只读、非 wire 字段，例如：

```python
_visual_by_id
_animation_ids
_static_by_id
_static_depth_by_id
_maximum_static_depth
```

要求：

- map 使用 `MappingProxyType` 或等价只读包装；
- animation ID 使用 `frozenset`；
- 字段 `repr=False`；
- 派生字段不参与 binary schema；
- 只由 `parse_scene_bootstrap()` 构造；
- 调用方不得传入第二份可变 registry；
- 不新增公共 `SceneBootstrapValidationIndex` 类型。

如果 dataclass 的构造兼容会妨碍实现，直接修改 Python 内部构造点；不保留旧 constructor wrapper。

## 6.3 Bootstrap 冷路径完成全部静态校验

`parse_scene_bootstrap()` 必须完成：

```text
visual registry 校验
animation registry 校验
static node field 校验
static ID 唯一性
static parent 完整性
static graph 无环
static depth 计算与上限检查
```

成功后保存动态 frame 后续真正需要的：

```text
visual_by_id
animation_ids
static_by_id 或 static ID set
static_depth_by_id
```

服务端 frame encoder 不需要保存、也不应计算静态 world pose。

现有公共 `validate_scene_tree()` 若被测试或其他冷路径使用，可以继续计算完整 pose；但它不得进入 Engine 正常 frame 热路径。

## 6.4 动态节点字段校验使用缓存 registry

普通 frame 必须直接使用：

```text
bootstrap._visual_by_id
bootstrap._animation_ids
```

不得再从：

```text
bootstrap.visual_types
bootstrap.animation_states
```

构造 map/set。

可以修改现有私有 `_validate_nodes()` 的参数，也可以新增：

```python
_validate_dynamic_nodes_against_bootstrap(...)
```

但不得增加 validator 类、registry service 或 pipeline。

## 6.5 动态父链校验

增加一个 `scene.py` 内部私有函数，例如：

```python
_validate_dynamic_tree_against_bootstrap(
    nodes,
    *,
    static_by_id,
    static_depth_by_id,
    maximum_depth,
)
```

它只能遍历动态节点，并满足：

1. 动态节点仍按 `display_id` 严格排序；
2. 动态 ID 不得与静态 ID 冲突；
3. parent 必须存在于静态索引或动态索引；
4. 只对动态子图做 cycle 检查；
5. parent 指向静态节点时，以缓存的静态 depth 为基底；
6. parent 指向动态节点时，递归/迭代计算动态链 depth；
7. 超过最大深度时 fail closed；
8. 时间复杂度 `O(dynamic_node_count)`；
9. 不计算任何 world pose；
10. 不读取或迭代 `bootstrap.static_nodes`。

## 6.6 最终 frame 热路径

`encode_scene_frame_against_bootstrap()` 最终只能做：

```text
校验 source_tick / node count / byte limit
materialize dynamic nodes 一次
用缓存 registry 校验动态字段
校验 scene events
用缓存静态 ID/depth 校验动态 parent graph
编码动态 frame 一次
检查最终 byte limit
返回 bytes
```

必须从该调用链物理删除：

```text
_validate_tree(dynamic, bootstrap.static_nodes, ...)
tuple(static_nodes) + tuple(dynamic_nodes)
静态 _compose_pose
完整 static by_id 重建
```

## 6.7 字节结果不得变化

对同一 bootstrap、source tick、dynamic nodes、events：

```text
优化前 frame bytes == 优化后 frame bytes
```

校验优化不能改变排序、浮点编码、payload 顺序、header、directory 或 hash。

---

# 7. Scene Engine Runtime：同一当前 checkpoint 只物化一次

## 7.1 当前问题

当前流程近似：

```text
start()
  -> materialize checkpoint
  -> recorder append
  -> 丢弃 PacketRef

first client_connected()
  -> 再次 materialize 同一 checkpoint
  -> retain / enqueue
```

同一 world revision 被重复：

```text
build_checkpoint
完整 snapshot 编码
bootstrap/frame 组合
wire packet 编码
```

## 7.2 统一 current checkpoint helper

在 `SceneEngineRuntime` 内新增一个私有 helper，例如：

```python
_get_or_build_current_checkpoint()
```

职责只能是：

```text
若 cache 对应当前 stream/commit/tick/revision，且 PacketRef 仍 retained：直接返回
否则 materialize 一次
retain 一次
写入 cache
返回 PacketRef
```

不得新建 manager/service。

cache identity 至少应核对：

```text
stream_id
commit_seq
source_tick
world_revision
```

## 7.3 start() 直接建立当前 cache

目标流程：

```text
start()
  -> _get_or_build_current_checkpoint()
  -> recorder 写该 PacketRef.raw_bytes
  -> cache 与 retained 保留同一 PacketRef
```

若完整 checkpoint 大于 global retention capacity：

```text
start() 直接 fatal
```

不得启动一个首客户端永远无法接入的 runtime。

## 7.4 客户端连接复用

`client_connected()`：

```text
调用同一个 helper
把同一个 PacketRef enqueue 给 session
不得再次调用 product.build_checkpoint()
不得再次编码 snapshot 或 bootstrap/frame
```

同一 revision 下多个客户端必须：

```text
获得 byte-identical raw bytes
复用同一个 retained PacketRef
product build_checkpoint 调用次数不增加
```

## 7.5 cache 失效

成功发布新 commit 后：

```text
旧 current checkpoint cache 失效
```

下一次需要 checkpoint 时构建一次，并供该 revision 下后续客户端复用。

不得改变：

```text
commit sequence
ACK 语义
session window
pending / in-flight
retention 淘汰规则
客户端断开策略
```

## 7.6 Recorder

初始 recorder checkpoint 必须写 cache 中同一份 raw bytes。

periodic recording checkpoint：

- 若当前 revision 的 checkpoint 已存在，可复用相同 bytes；
- 若当前 cache 已失效，调用同一个 helper 构建一次；
- recorder 是否在日志中再次写 checkpoint 由当前 recording interval 语义决定；
- 不得为了复用而改变 packet log 时序合同。

---

# 8. Python Game：静态产品投影只扫描一次

## 8.1 当前问题

当前 `MissileWarSceneProjection.build_checkpoint()` 每次会调用：

```text
_validate_static_world(world)
```

并生成一个大型 `_static_contract` 用于与初始值比较。

这会在重连 checkpoint 再次遍历：

```text
world.islands
world.tiles
静态拓扑
坐标几何
```

## 8.2 首次 bootstrap

当 `_bootstrap is None` 时，只执行一次：

```text
完整 _validate_static_world(world)
构建 island/tile static nodes
构建 topology/metadata
构建 visual/animation registry
编码 bootstrap bytes
记录 map_id
记录 world geometry_revision
记录 coordinate service geometry_revision
```

可保留当前构建 bootstrap 所需的静态 display 映射，但不得保留一份为了每次深比较而存在的大型 `_static_contract`。

## 8.3 普通 commit

`build_commit()` 只做 O(1) 静态身份检查：

```text
world.map_id == 初始化 map_id
world.geometry_revision == 初始化 revision
coordinate_transform_service 存在
service.geometry_revision == 初始化 revision
```

之后直接投影动态节点。

普通 commit 禁止调用或间接触发：

```text
_validate_static_world
遍历 world.islands
遍历 world.tiles
重建 static nodes
重建 topology
重建 bootstrap
全地图 hash
全地图 tuple 比较
```

## 8.4 后续 checkpoint

后续 checkpoint 仍需：

```text
编码当前完整 WorldState snapshot
投影当前动态节点
```

但必须：

```text
复用同一 bootstrap bytes
只做 O(1) 静态 identity 检查
不扫描静态地图
```

## 8.5 静态变化 fail closed

若以下任一值变化：

```text
map_id
world.geometry_revision
coordinate service geometry_revision
```

立即：

```python
raise RuntimeError("missile_war_scene_static_change_requires_new_stream")
```

不在当前 stream 内：

```text
重建 bootstrap
发送 static delta
热更新 terrain
兼容旧 bootstrap
```

未来若确需改变静态世界，应创建新的 runtime/stream 和完整 checkpoint；本轮不设计该功能。

## 8.6 不修改完整数据合同

本轮保持：

```text
WORLD_STATE_CODEC = missile-war-world-state@2
WorldState dataclass 字段不变
PersonIdleWanderPlan 字段不变
snapshot JSON 形状不变
journal replace_record 输出形状不变
```

因此，本轮不会解决 idle wander 重复几何造成的 checkpoint 体积问题。这是为避免与正在调整的显示壳/Web 数据边界冲突而做的明确范围选择。

---

# 9. 并行执行方案

总控先冻结边界，然后 W1、W2、W3 并行。W4 只在三者合并后做接线、打包和验收。

## W0：总控与范围门禁

**不做大面积实现。**

任务：

1. 记录 `scene-engine` 与 `python-game` 当前 commit；
2. 记录以下只读路径初始 tree hash / Git 状态：

```text
scene-engine/js/**
arts/**
replay/**
```

3. 冻结外部合同：

```text
scene-engine-wire@1
scene-engine-scene@1
missile-war-world-state@2
```

4. 保存固定 seed 的基线：

```text
bootstrap bytes SHA-256
典型/边界 dynamic frame bytes SHA-256
WorldState snapshot bytes SHA-256
checkpoint / commit packet bytes SHA-256
```

5. 建立文件所有权；
6. 启动 W1–W3；
7. 禁止子 Agent 修改版本、vendor、lockfile。

## W1：Scene Engine Python frame 热路径

**独占文件：**

```text
scene-engine/src/scene_engine/scene.py
scene-engine/tests/test_scene_v1.py
scene-engine/tests/test_scene_benchmark.py
scene-engine/scripts/benchmark_scene_500.py
```

任务：

- 在 `SceneBootstrapView` 内建立只读派生索引；
- parse 阶段完成静态 graph/depth 校验；
- frame 热路径只校验动态节点；
- 禁止静态 tuple iteration 和静态 pose；
- benchmark 使用真实 632 static + 500 dynamic；
- 证明 frame bytes 不变。

完成门：

```text
encode_scene_frame_against_bootstrap 不调用完整 _validate_tree
不调用静态 _compose_pose
不迭代 bootstrap.static_nodes
```

## W2：Scene Engine Python checkpoint 复用

**独占文件：**

```text
scene-engine/src/scene_engine/runtime.py
scene-engine/tests/test_runtime.py
```

任务：

- 实现唯一 current-checkpoint helper；
- `start()` 即 retain/cache；
- 首客户端和同 revision 多客户端复用；
- 新 commit 后正确失效；
- recorder 复用相同 raw bytes；
- 不改变 session/ACK/retention 语义。

完成门：

```text
start 后首次 client_connected 不增加 build_checkpoint 调用
同 revision 第二客户端不增加 build_checkpoint 调用
缓存 PacketRef 被 retention 淘汰后能够正确重建
```

## W3：Python Game 静态投影

**独占文件：**

```text
python-game/adapters/scene_projection.py
python-game/tests/test_scene_projection.py
```

任务：

- `_validate_static_world` 只在首次 bootstrap 执行；
- 删除大型 `_static_contract` 热路径比较；
- 后续 commit/checkpoint 只做 O(1) revision 检查；
- 静态变化 fail closed；
- bootstrap/frame 输出保持不变；
- 不修改 models、idle_wander、world_state_codec。

完成门：

```text
首次 bootstrap 后 600 commits + 多次 checkpoint：静态全扫描计数仍为 1
```

## W4：集成、Python 发布与只读跨端验证

W1–W3 合并后由单一 Agent 执行。

**允许修改：**

```text
python-game/tests/test_scene_engine_program.py
python-game/scripts/benchmark_runtime_500.py
必要的 Python package/version/vendor 文件
scene-engine 与 python-game 内最终报告
```

任务：

1. 接线并解决冲突；
2. 运行所有 Python 测试；
3. 运行 500 节点服务器 benchmark；
4. 生成固定输入 byte-equivalence 证据；
5. 如需发布，Python distribution 仅做 patch bump，并更新 `python-game` 的 wheel/lock；
6. 不更新任何 JS tgz/package/lock；
7. 以只读方式运行现有 Scene Engine JS、Arts、Replay 核心测试；
8. 检查只读路径最终无 diff；
9. clean venv 安装最终 Python wheel，运行核心测试。

如果只读 Web 测试失败：

```text
修 Python 输出或撤销越界变化
不得修改 JS / Arts / Replay 来适配
```

## 合并顺序

```text
W0 冻结边界与基线
W1 + W2 + W3 并行
W4 单点集成
```

多个 Agent 不得同时修改：

```text
scene-engine/pyproject.toml
python-game/pyproject.toml
python-game/requirements.lock
python-game/vendor/**
最终报告
```

---

# 10. 必须增加的测试

## 10.1 Bootstrap 冷路径严格性

覆盖：

```text
静态 duplicate ID
静态 missing parent
静态 cycle
静态 depth overflow
unknown visual / animation
invalid payload type
```

优化后不得降低静态 bootstrap 校验。

## 10.2 Frame 热路径绝不访问静态 tuple

至少使用两种证明方式：

### 方法 A：monkeypatch

在 bootstrap 成功 parse 后，把完整 `_validate_tree` / 静态 pose helper monkeypatch 为抛错；调用 500 dynamic frame encode 必须成功。

### 方法 B：访问计数

通过测试内 instrumentation 统计：

```text
static node iteration
static pose composition
static registry rebuild
```

普通 frame 全部必须为 0。

不得为了测试把运行时改成长期 telemetry 架构。

## 10.3 动态父链

覆盖：

```text
dynamic -> static parent             成功
dynamic -> dynamic -> static         成功
dynamic missing parent               失败
dynamic/static ID collision          失败
dynamic cycle                         失败
dynamic depth overflow                失败
unknown visual                        失败
unknown animation                     失败
```

## 10.4 Byte equivalence

固定输入必须比较：

```text
bootstrap raw bytes
steady dynamic frame raw bytes
motion dynamic frame raw bytes
churn dynamic frame raw bytes
engine checkpoint raw bytes
engine commit raw bytes
WorldState snapshot raw bytes
```

除运行时生成的明确非确定字段外，必须 byte-identical；若存在非确定字段，先固定它，不得放宽成“语义相同”。

## 10.5 Checkpoint cache

覆盖：

```text
start 构建 checkpoint 恰好一次
start 后 cache 已 retained
首客户端连接不重建
第二客户端同 revision 不重建
两个 session 收到 byte-identical packet
新 commit 后 cache 失效
新 revision 第一个客户端只重建一次
cache 被 retention 淘汰后安全重建
checkpoint 超 retention capacity 时 start fatal
recorder 使用相同 raw bytes
```

## 10.6 产品静态扫描

用计数器或 monkeypatch 证明：

```text
首次 build_checkpoint 调用 _validate_static_world = 1
随后 600 build_commit 调用增量 = 0
同 stream 多次 build_checkpoint 调用增量 = 0
```

同时覆盖：

```text
map_id 改变 -> fail closed
geometry_revision 改变 -> fail closed
coordinate service revision 改变 -> fail closed
```

## 10.7 当前完整数据合同不变

断言：

```text
WORLD_STATE_CODEC == missile-war-world-state@2
固定 world 的 snapshot SHA-256 不变
PersonIdleWanderPlan 编码字段不变
Arts 当前读取的根字段不变
```

测试代码放在 Python 侧，不修改 Arts。

---

# 11. 500 节点服务器性能门

正式 workload：

```text
632 static nodes
500 dynamic nodes
steady / motion / churn-25
60 Hz
warmup >= 60
每轮 >= 600 samples
rounds >= 5
```

报告必须记录：

```text
硬件
OS
Python 版本
Git commit
working tree 状态
样本数
p50 / p95 / p99 / max
packet bytes
```

## 11.1 Scene Engine frame 热路径

在 Apple M5 或同级参考机：

```text
dynamic field validate + dynamic tree validate + frame encode
  p95 <= 4 ms
  p99 <= 6 ms

scene frame + Engine wire commit encode
  p95 <= 8 ms
```

结构硬门不受机器影响：

```text
static iteration per frame = 0
static pose per frame = 0
static registry rebuild per frame = 0
```

## 11.2 Python Game 投影

```text
direct dynamic projection
  p95 <= 4 ms
  p99 <= 7 ms
```

并且：

```text
static world full scan after bootstrap = 0
```

## 11.3 真实 runtime

```text
publication after step
  p95 <= 14 ms

step + publication
  p95 <= 16.67 ms
```

本轮若仍有非静态瓶颈，报告必须分项列出，但不得为了通过指标引入新架构。

## 11.4 Checkpoint 复用

本轮不对首个 26 MiB 左右 checkpoint 设置新的体积门，因为 WorldState 形状被冻结。

但必须满足：

```text
同一 revision 的第二次 current-checkpoint 获取：
  build_checkpoint 调用增量 = 0
  snapshot encode 调用增量 = 0
  bootstrap/frame encode 调用增量 = 0
  返回同一个 PacketRef 或同一 retained bytes
```

checkpoint packet 大小不得比基线增加超过 1%。

## 11.5 本轮不声明客户端性能完成

由于 Web 客户端和显示壳正在独立调整：

- 本轮不修改客户端性能代码；
- 不把新的客户端 p95/p99 作为本轮代码修改目标；
- 只要求现有客户端能够读取优化后完全相同的 packet；
- 最终端到端性能需在 Web 架构合并后重新统一验收。

Codex 不得在报告中把“服务器 60 Hz”写成“全链路 60 Hz”。

---

# 12. 物理删除与禁止残留

本轮完成后，Python 代码中不得保留：

```text
frame 热路径调用完整 static+dynamic _validate_tree
frame 热路径静态 _compose_pose
frame 热路径从 visual tuple 重建 registry
frame 热路径从 animation tuple 重建 registry
每次 checkpoint 的大型 _static_contract 全量比较
start checkpoint 构建后丢弃
首客户端再次构建同 revision checkpoint
legacy frame validation flag
旧/新 frame encoder 双路径
旧/新 checkpoint path 双路径
```

不得出现：

```text
legacy_encode_scene_frame_against_bootstrap
use_cached_static_validation=True/False
checkpoint_cache_v2
StaticSceneCacheService
0.6 compatibility adapter
```

历史由 Git 保存，不在运行仓库保留。

---

# 13. 不要顺手修改的内容

本轮禁止借机修改：

```text
WorldChangeJournal
input transaction
JSON patch validation次数
事件 retention
idle wander 数据模型
完整 WorldState schema
session / ACK / backpressure
wire packet layout
scene frame complete-frame 合同
WebSocket transport
JS SceneTree
renderer-three
Arts UI selector
Replay packet log
```

这些若有独立问题，另开任务；不要把本轮变成通用性能重构。

---

# 14. 最终验收命令

根据仓库实际环境调整命令，但至少执行：

```bash
# Scene Engine Python
cd scene-engine
python3 -m pytest
python3 scripts/benchmark_scene_500.py \
  --warmup 60 --samples 600 --rounds 5 \
  --output docs/evidence/python-static-dynamic-500.json

# Python Game
cd ../python-game
python3 -m pytest
python3 scripts/benchmark_runtime_500.py \
  --warmup 60 --samples 600 --rounds 5 \
  --runtime-commits 600 \
  --output docs/evidence/python-runtime-static-dynamic-500.json
```

只读回归：

```bash
# 不得因此修改下列仓库
cd ../scene-engine
npm test

cd ../arts
npm run check

cd ../replay
npm test
```

clean Python package：

```text
创建全新 venv
不继承 workspace PYTHONPATH
安装最终 scene-engine Python wheel
安装 python-game
运行 Scene Engine Python 与 Python Game 核心测试
```

最终检查：

```bash
git diff -- scene-engine/js arts replay
```

必须为空。

---

# 15. 最终报告必须回答

## 15.1 范围

1. 实际修改了哪些仓库和文件？
2. `scene-engine/js/**`、`arts/**`、`replay/**` 是否零 diff？
3. wire、scene codec、WorldState schema 是否保持原值？

## 15.2 静态/动态边界

1. bootstrap 静态全校验执行几次？
2. 正常 frame 是否迭代 static nodes？
3. 正常 frame 是否计算静态 pose？
4. 后续 checkpoint 是否重新扫描 world.tiles / islands？
5. 静态 revision 变化是否 fail closed？

## 15.3 Checkpoint

1. `start()` 调用了几次 product.build_checkpoint？
2. 首客户端是否复用 start 的 PacketRef？
3. 同 revision 第二客户端是否发生任何重新编码？
4. recorder、session 是否使用同一 raw bytes？

## 15.4 兼容边界

1. 固定输入的 bootstrap/frame/snapshot/packet SHA 是否不变？
2. 现有 JS client 是否无需修改即可读取？
3. 是否存在隐藏的 `@2` 数据形状漂移？

## 15.5 性能

1. 632 static + 500 dynamic 的 frame p50/p95/p99？
2. 产品动态投影 p50/p95/p99？
3. publication 与 step+publication p95？
4. 每帧静态访问计数？
5. 同 revision checkpoint cache hit 的调用计数与耗时？

## 15.6 减法

1. 删除了哪些旧热路径调用？
2. 是否新增了任何公共服务/manager/pipeline？
3. 若新增，为什么不能放进现有对象？原则上最终答案应为“没有”。

---

# 16. 可直接交给总控 Codex 的总提示词

```text
按本文执行一次性 Python-only 静态/动态分离。

修改范围严格限制为 scene-engine Python 端与 python-game。scene-engine/js、Arts、Replay 全部只读。冻结 scene-engine-wire@1、scene-engine-scene@1、missile-war-world-state@2，以及当前 packet 和 binary bytes 语义。

先保存固定输入的 bootstrap、dynamic frame、WorldState snapshot、checkpoint 和 commit SHA。然后建立文件锁，启动三个并行子 Agent：
W1 只负责 scene-engine/src/scene_engine/scene.py 的 bootstrap 派生索引与 dynamic-only frame validation；
W2 只负责 scene-engine/src/scene_engine/runtime.py 的 current checkpoint 单次物化和复用；
W3 只负责 python-game/adapters/scene_projection.py 的首次静态扫描与后续 O(1) revision 检查。

W1-W3 不修改版本、vendor、lockfile。合并后由单一 W4 负责 Python 接线、500 节点 benchmark、byte-equivalence、Python wheel、python-game wheel/lock 更新和 clean venv 验收。只读运行现有 JS/Arts/Replay 测试；若失败，修 Python 输出，不修改 Web 代码。

内部实现一次切换，不保留旧热路径、feature flag、legacy wrapper、双 validator、双 checkpoint path。不得新增 StaticSceneService、ScenePipeline、CacheService、Repository、EventBus、ECS、第二份 WorldState、第二棵树、scene delta 或网络压缩。

本轮明确不做 idle wander wire 压缩、不升级 WorldState @3、不改客户端或显示壳。最终报告必须给出零 Web diff、固定输入 byte-identical、每帧静态访问为零、checkpoint cache 调用计数和 632 static + 500 dynamic 性能证据。
```

---

# 17. 完成定义

只有同时满足以下条件才算完成：

```text
[ ] 只修改 scene-engine Python 与 python-game
[ ] scene-engine/js、Arts、Replay 零 diff
[ ] wire / scene / WorldState schema 不变
[ ] 固定输入 bootstrap/frame/snapshot/packet byte-identical
[ ] bootstrap 静态校验每 stream 一次
[ ] 普通 frame 静态遍历、registry 重建、静态 pose 全为零
[ ] 后续 commit/checkpoint 不全量扫描静态地图
[ ] 静态变化 fail closed 并要求新 stream
[ ] start checkpoint 被 retained/cache
[ ] 首客户端与同 revision 后续客户端不重新物化 checkpoint
[ ] 632 static + 500 dynamic 服务器性能门通过
[ ] 无新 service/manager/pipeline/兼容层
[ ] Python 全套测试和 clean venv 通过
[ ] 现有 Web 客户端只读回归通过
```

本轮完成后，服务端静态初始化与动态帧计算边界应彻底成立；Web 端可以继续独立调整，而不需要同步接收本轮的任何架构修改。
