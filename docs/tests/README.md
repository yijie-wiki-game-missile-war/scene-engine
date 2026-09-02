# 测试项目

本页列出根级全量命令当前发现或调用的测试项目。测试数量随合同演进，不在文档中固定；新增、删除或重命名
项目时更新本索引。测试方法、编写要求和唯一完成标准见[测试方法和标准](../testing.md)。

## 整体与性能测试分类

| 类别 | 默认门禁中的小规模 smoke | 显式 runner |
| --- | --- | --- |
| Python Matrix4 操作与常驻成本 | `test_display.py` 与 `test_display_binary.py` 验证连续 NumPy 矩阵池、节点 ID、dirty tensor 和 exact binary32 编码。 | `benchmark_python_display_transform.py` 参数化操作次数、编码命令数和常驻矩阵池行数。 |
| 显示引擎功能与性能 | `display-runtime-foundation.test.mjs`；`display-runtime-scale.test.mjs` 调用 12-binding deterministic smoke。 | `benchmark_display_runtime_scale.mjs` 运行 10k/30k/50k bindings；`benchmark_display_browser.mjs` 在真实 Chrome/WebGL 中运行。 |
| 通讯性能 | `test_python_js_communication_e2e.py` 运行 32-root Python↔JavaScript roundtrip，并以小规模 windowed CLI smoke 检查 pending/in-flight。 | `benchmark_python_js_communication.py` 参数化 roots、commits、update ratio 和 roundtrip/windowed profile。 |

默认 `uv run python -m pytest -q` 与 `npm test` 只执行表中的小规模确定性 smoke，不自动运行 Python Matrix4
benchmark、10k/30k/50k 或 Chrome/WebGL runner。所有显式 runner 只向 stdout 输出 JSON，不创建或提交持久化
性能报告、历史结果文件。时间数据当前用于观察，不设置跨机器硬阈值；各 runner 与自身范围对应的 correctness
仍必须通过，状态与通讯 runner 另行检查结构、cursor、最终状态、健康和释放。

## Python

Python 测试由 `uv run python -m pytest -q` 按 `pyproject.toml` 的 `tests/` 路径发现。

| 测试项目 | 覆盖范围 |
| --- | --- |
| [`test_runtime.py`](../../tests/test_runtime.py) | 固定 60 Hz、tick 与 input 事务、commit/command cursor、会话幂等与隔离、checkpoint 缓存和全局保留、recorder 接入、Transform/reparent/property/event 同包后台顺序、fatal 边界、验证顺序与单次编码。 |
| [`test_transport_sender.py`](../../tests/test_transport_sender.py) | 有界 send/control 数量与字节 outbox、单 worker FIFO、不可变 bytes 共享、connection epoch 取消、失败 inbox、优雅/强制关闭、有限 shutdown 和元数据回收。 |
| [`test_wire_v3.py`](../../tests/test_wire_v3.py) | Wire v3 packet、raw binary32 matrix Display attachment 布局、golden bytes、非法 corpus、大小与深度限制、安全整数、Display cursor 对齐、旧版本和旧布局拒绝。 |
| [`test_display.py`](../../tests/test_display.py) | Python Display checkpoint、目录身份、parent-first baseline、流内单调且不复用的 uint32 Node ID、连续 `(n,4,4)` NumPy 矩阵池、增长与零墓碑、版本化 dirty 发布确认、严格命令序列、完整 state、顶层 property、瞬时 event，以及 Matrix4 便利构造和点/向量转换。 |
| [`test_display_binary.py`](../../tests/test_display_binary.py) | SDCP/SDCS v6 的 Display Kind、Node ID 表、只读连续且 bytes-backed 的完整/dirty NumPy matrix tensor 与 dirty ID、空 tensor shape、opcode 1–10、任意 JSON property value、事件载荷、固定 65,536 command 上限、cursor/tick seal、state JSON、opaque binary32 位模式保留与结构失败关闭。 |
| [`test_json_tree_v1.py`](../../tests/test_json_tree_v1.py) | JSON Tree set/unset/append、写入前完整验证、canonical path 顺序、数值与危险键限制、容量边界和数组原始索引语义。 |
| [`test_recording_v3.py`](../../tests/test_recording_v3.py) | packet-log 精确 packet bytes、command cursor 索引、每包 Display payload 单次解码、INCOMPLETE/seal 生命周期、stream/MatrixPool progression、周期 checkpoint 的 pool/active-ID 一致性、稀疏增长放大防护和损坏记录拒绝。 |
| [`test_catalog_identity.py`](../../tests/test_catalog_identity.py) | Python 公开 API 与 `ProductCheckpoint` 不再包含 Arts catalog identity。 |
| [`test_import_surface.py`](../../tests/test_import_surface.py) | Python 根包公开导出、版本和当前模块集合，防止旧模块或额外 API 回流。 |
| [`test_python_js_communication_e2e.py`](../../tests/test_python_js_communication_e2e.py) | 32 roots checkpoint、多次 transform commit、exact Wire/ACK bytes、长度帧本地 Node 子进程、浏览器本地 Display Kind/catalog、Client/Display cursor、最终 World 与 Transform digest；另以小规模 windowed CLI smoke 检查 in-flight/pending 峰值和最终归零。 |

## JavaScript Client

`@scene-engine/client` 使用 Node test runner 执行 `test/*.test.mjs`。

| 测试项目 | 覆盖范围 |
| --- | --- |
| [`client.test.mjs`](../../js/packages/client/test/client.test.mjs) | 精确公共导出与版本、Python Wire fixtures 逐字节同源、shear Matrix4 所有权、WorldState、checkpoint/session 原子替换、commit gate、ACK、observer、显式 DisplayView、input、JSON patch 和失败关闭。 |
| [`display-binary.test.mjs`](../../js/packages/client/test/display-binary.test.mjs) | 与 Python 一致的 SDCP/SDCS v6 Display Kind、Node ID 与 matrix tensor codec、opcode 1–10、property/event JSON、固定 65,536 command 上限、单 owned `Float32Array`、dirty ID 对齐，以及损坏 header、名称、矩阵、长度和 trailing bytes 拒绝。 |
| [`client-display-failure.test.mjs`](../../js/packages/client/test/client-display-failure.test.mjs) | Canonical Wire fixture 与 canonical Display catalog 的真实安装/提交、Client 与真实 DisplayRuntime 的同步屏障、异步清理拒绝观察、部分命令或 world 溢出提交失败、terminal 状态和无 ACK 保证。 |
| [`packet-log.test.mjs`](../../js/packages/client/test/packet-log.test.mjs) | packet-log 字段、cursor 与 MatrixPool 生命周期校验、通过唯一 Authority 路径 Replay、seek 新建 session、周期 checkpoint 分叉/稀疏增长放大、损坏记录和旧 manifest 拒绝。 |

## JavaScript Display

`@scene-engine/display` 使用 Node test runner 执行 `test/*.test.mjs`。

| 测试项目 | 覆盖范围 |
| --- | --- |
| [`public.test.mjs`](../../js/packages/display/test/public.test.mjs) | Display 根包精确公开导出（含 pointer-target、interaction query 与 controller）和内部 Authority mutation 类型隔离。 |
| [`authority-matrix-pool.test.mjs`](../../js/packages/display/test/authority-matrix-pool.test.mjs) | Authority 连续矩阵池的安装、几何增长、ID 行绑定、dirty batch 暂存与按命令序列消费、墓碑归零和失败关闭。 |
| [`display-transform.test.mjs`](../../js/packages/display/test/display-transform.test.mjs) | 公共不可变 Matrix4 便利 API、float32 canonicalization、self/parent 乘法次序、shear 保留、点/向量及完整 affine inverse。 |
| [`node-core.test.mjs`](../../js/packages/display/test/node-core.test.mjs) | Node 名称语法、float32 Matrix4 规范化、真实 NodeGraph `parentWorld*local`、shear、派生 world 溢出拒绝、NodeIndex、dirty-root 合并、最大深度、Billboard 和 LookAt。 |
| [`node-graph-forest-audit.test.mjs`](../../js/packages/display/test/node-graph-forest-audit.test.mjs) | forest detach/restore 的封闭性、兄弟顺序、身份、dirty 状态和失败前零写入。 |
| [`definitions.test.mjs`](../../js/packages/display/test/definitions.test.mjs) | Scene、Prefab、Resource 与 built-in Component 的封闭定义、注册、引用、嵌套依赖、深度/规模边界和 exact `prefabId`。 |
| [`display-kind.test.mjs`](../../js/packages/display/test/display-kind.test.mjs) | Display Kind 0..N Prefab 映射、显式 selector/default、unknown/unimplemented/unresolved 空根、父子层级、有界 diagnostics、state/property 驱动替换/失去/恢复，以及 selector 异常失败关闭。 |
| [`catalog-identity.test.mjs`](../../js/packages/display/test/catalog-identity.test.mjs) | canonical manifest、构建 artifact、SHA-256、注册顺序独立性、hash domain 隔离和 authority-state schema coverage。 |
| [`component.test.mjs`](../../js/packages/display/test/component.test.mjs) | Component 同步生命周期、只读能力、pointer-target 封闭角色/JSON data、scheduler 快照、显式事件订阅与同步 handler、final 方法、transform driver 唯一性和资源校验后的原子属性替换。 |
| [`pointer-interaction.test.mjs`](../../js/packages/display/test/pointer-interaction.test.mjs) | 最近启用 target 解析、点击/右键/双击、严格 drag-grab/move/drop、带半径 proximity、claim/相机隔离、目标/Session/捕获生命周期和监听器清理。 |
| [`runtime.test.mjs`](../../js/packages/display/test/runtime.test.mjs) | Authority commit gate、Transform、完整 state 与顶层 property reconcile、Prefab event allowlist/路由/失败、world 溢出、Scene 安装、kind-driven materialization replacement、exact/radius interaction query、world ray、summary/currentView、health、backend rebuild 和批量 dispose。 |
| [`nested-prefab.test.mjs`](../../js/packages/display/test/nested-prefab.test.mjs) | 固定与动态嵌套 Prefab 展开、0..N diff、same-key/id 身份保留、失败零变更、递归释放和静态 Scene 初始化。 |
| [`nested-prefab-runtime-audit.test.mjs`](../../js/packages/display/test/nested-prefab-runtime-audit.test.mjs) | 深度边界、路径冲突、事务最终候选可见性、attach 失败、NodeIndex 注册失败、复杂 rollback 和兄弟顺序恢复。 |
| [`nested-prefab-scale.test.mjs`](../../js/packages/display/test/nested-prefab-scale.test.mjs) | 640 个动态子实例下基于 ledger identity 的 reconcile，以及大候选 staging/adoption 失败后的完整回滚。 |
| [`animation.test.mjs`](../../js/packages/display/test/animation.test.mjs) | Animation Resource、Prefab Scope、player 放置与目标、visual clock 采样、set/play/stop、override、batch ownership、替换/回滚、rebuild 和冲突。 |
| [`display-500.test.mjs`](../../js/packages/display/test/display-500.test.mjs) | 500 个 authority roots 共享唯一 NodeIndex，并保持精确 canonical identity。 |

## JavaScript Three Renderer

`@scene-engine/renderer-three` 使用 Node test runner 执行 `test/*.test.mjs`。

| 测试项目 | 覆盖范围 |
| --- | --- |
| [`public.test.mjs`](../../js/packages/renderer-three/test/public.test.mjs) | renderer-three 精确公开 API、扁平 RenderBackendPort 和 Three 对象隔离。 |
| [`backend.test.mjs`](../../js/packages/renderer-three/test/backend.test.mjs) | 扁平 binding、首次更新前的完整 identity world matrix、world matrix、pick/project、相机与灯光、panel compensation、资源替换、sprite batching、surface 和 particle 视觉采样。 |
| [`pointer-queries.test.mjs`](../../js/packages/renderer-three/test/pointer-queries.test.mjs) | CSS 像素半径的 renderer-owned proximity proxy、零半径 exact pick、普通/批处理 binding、稳定距离/深度排序，以及透视/正交相机的有限归一化 world ray。 |
| [`pointer-display-integration.test.mjs`](../../js/packages/renderer-three/test/pointer-display-integration.test.mjs) | 真实 DisplayRuntime、PointerTarget、Three backend 与相机监听器组合下的 proximity、drag-grab/move/drop、指针捕获、backend rebuild 取消和最终释放。 |
| [`resource-lifecycle.test.mjs`](../../js/packages/renderer-three/test/resource-lifecycle.test.mjs) | pending load 去重与共享 AbortSignal 扇出取消、资源依赖回收、mesh/texture/model 处理、health envelope、GLTF 部分失败、destroy/recreate 和 backend replacement 释放。 |
| [`batch-representation.test.mjs`](../../js/packages/renderer-three/test/batch-representation.test.mjs) | ordinary object 与 InstancedMesh 唯一表示、scene traversal 排除、dirty matrix update range、保守 batch bounds、microtask Node root 与多 batch-group 批量回收、可见性、batch 重建、资源替换、pick、capture 和 diagnostics 计数。 |
| [`animation-port.test.mjs`](../../js/packages/renderer-three/test/animation-port.test.mjs) | 旧 renderer animation 字段拒绝、Animation Resource 不加载、animated sprite 退出静态 batch、frame 更新不 rebatch 和 eligibility transition。 |
| [`display-integration.test.mjs`](../../js/packages/renderer-three/test/display-integration.test.mjs) | Display RenderSystem 驱动精确 Three backend port，并从声明式 binding 重建。 |
| [`backend-500-lifecycle.test.mjs`](../../js/packages/renderer-three/test/backend-500-lifecycle.test.mjs) | 500 个真实 Three bindings 的 batching、frame sampling、backend rebuild、dispose 和最终零 resource lease。 |
| [`display-runtime-foundation.test.mjs`](../../js/packages/renderer-three/test/display-runtime-foundation.test.mjs) | 从 DisplayRuntime 到真实 Three backend 的整体基础测试：mesh/sprite/model/surface/particle、固定与动态嵌套 Prefab、Authority 增删/reparent、Matrix4、visibility、完整 state、Display-local sprite animation、backend rebuild 和零所有权释放。 |
| [`display-runtime-scale.test.mjs`](../../js/packages/renderer-three/test/display-runtime-scale.test.mjs) | 调用 scale runner 的 12-binding deterministic smoke，检查结构、cursor、计时报告形状、backend rebuild、健康和完整 dispose；不执行大规模时间门槛。 |

## Python Matrix4 性能

[`benchmark_python_display_transform.py`](../../scripts/benchmark_python_display_transform.py) 显式测量 Python
`DisplayTransform` 的 NumPy Matrix4 操作、`DisplayMatrixPool` 的连续常驻表示和 binary dirty-batch 编码，不进入默认门禁。例如：

```bash
uv run python scripts/benchmark_python_display_transform.py --iterations 100000 --repeats 7 --encode-commands 10000 --encode-repeats 7 --resident-count 100000
```

runner 报告 `environment`，identity、`from_trs`、composed、translate、rotate、scale、point、vector、inverse、
`matrix` 和 `matrix_bytes` 操作的 best/p50/p95，矩阵池 set/gather、dirty tensor encoding payload 与时延、
fresh-process startup、tracemalloc resident 以及 correctness。启动项包含子进程创建、根包 import、identity 与公开
accessor；内存当前值在初始 checkpoint 发布并 GC 后读取，表示 warm process 中矩阵池容量的稳态可追踪分配，peak
包含初始发布的瞬时 bookkeeping，两者都不是 RSS。binary encoder 一次读取 dirty ID 表和连续
`(m,4,4)` 张量。时间和内存字段只用于本机观测，不构成跨机器硬门槛，correctness 失败仍使该次
runner 失败。

## 显示引擎功能与性能

### Foundation

[`display-runtime-foundation.test.mjs`](../../js/packages/renderer-three/test/display-runtime-foundation.test.mjs) 使用
[`display-runtime-support.mjs`](../../js/packages/renderer-three/test/display-runtime-support.mjs) 建立真实
`DisplayRuntime → RenderSystem → ThreeRenderBackend` 路径。Node 环境只替换 WebGLRenderer 与资源入口为确定性测试实现；
Three Scene、Object、Geometry、Material、Texture、binding、batching、资源租约和生命周期均走正式 backend。

该测试随 `npm test` 运行，属于默认门禁的小规模功能 smoke。

### Scale runner 与 smoke

[`display-runtime-scale.test.mjs`](../../js/packages/renderer-three/test/display-runtime-scale.test.mjs) 是默认门禁中的
小规模 runner smoke。显式规模运行使用
[`benchmark_display_runtime_scale.mjs`](../../scripts/benchmark_display_runtime_scale.mjs)，支持 `static-mesh`、
`static-sprite`、`mixed`、`nested` 和 `animated-sprite` profile，最多 50,000 bindings。例如：

```bash
node scripts/benchmark_display_runtime_scale.mjs --bindings=10000 --profile=static-mesh --ticks=120 --warmup=5 --update-ratio=0.01
node scripts/benchmark_display_runtime_scale.mjs --bindings=30000 --profile=static-mesh --ticks=120 --warmup=5 --update-ratio=0.01
node scripts/benchmark_display_runtime_scale.mjs --bindings=50000 --profile=static-mesh --ticks=120 --warmup=5 --update-ratio=0.01
```

runner 报告创建、commit、frame、rebuild、dispose 的 p50/p95/p99/maximum、内存、结构和所有权计数。时间字段先用于
观察；`READY` 只表示该次结构、cursor、重建、健康和释放检查通过，不代表跨机器时间承诺。
其中 `nested` profile 每 tick 发送一个完整 desired-set state command；`update-ratio` 表示其中实际改变的条目比例，
报告会明确标出这种 reconcile 模式。该 runner 是内部 CPU harness，会读取 package-private diagnostics 核对资源归零，
这些入口不构成产品 API。

### Browser WebGL runner

[`benchmark_display_browser.mjs`](../../scripts/benchmark_display_browser.mjs) 配合
[`display_browser_benchmark.html`](../../scripts/support/display_browser_benchmark.html)，在本机 Chrome 的真实 WebGL
上下文中执行 DisplayRuntime 和公开 `createThreeRenderBackend()`：

```bash
node scripts/benchmark_display_browser.mjs --bindings=10000 --ticks=120 --update-ratio=0.01
```

它报告浏览器/GPU 信息、启动、`commitAndCpuSubmit` 分位数、binding/resource 状态与 dispose。
`commitAndCpuSubmit` 覆盖 commit、Display prepare 和 WebGL CPU 命令提交，不是 GPU fence/presentation 时间或 FPS；Three
`renderer.info.memory` 是驱动侧观测计数，释放判定以 backend binding/resource/pending/disposed 所有权字段为准。该
runner 依赖本机 Chrome/GPU，不进入默认门禁，也不设置跨机器时间硬阈值。

## 通讯性能

[`test_python_js_communication_e2e.py`](../../tests/test_python_js_communication_e2e.py) 是默认门禁中的 32-root
correctness smoke。它连接真实 Python `EngineProgram → SceneEngineRuntime`、exact Wire bytes、4-byte little-endian
长度帧 Node 子进程、`SceneEngineClient → DisplayRuntime` 与 exact ACK 回程。Display 使用无资源 fake backend 和不执行
回调的 frame adapter，因此结果不含 RAF、draw 或 renderer 时间。

显式通讯运行使用
[`benchmark_python_js_communication.py`](../../scripts/benchmark_python_js_communication.py)。JavaScript peer 与 canonical
catalog builder 分别是
[`python_js_communication_peer.mjs`](../../scripts/support/python_js_communication_peer.mjs) 和
[`communication_catalog.mjs`](../../scripts/support/communication_catalog.mjs)：

Benchmark World 持有一个覆盖所有 root 的 `DisplayMatrixPool`；step 只写本次实际更新的 Node ID。checkpoint 直接发送
完整 `(n,4,4)` pool，commit 一次发送排序后的 dirty ID 表和对应 `(m,4,4)` 连续张量；Python 与 JavaScript 最终
digest 都按 `u32le nodeId + 16*f32le` 计算，不把 position → Matrix4 重构时间混入 publication build。

```bash
uv run python scripts/benchmark_python_js_communication.py --roots 10000 --commits 200 --update-ratio 0.01 --profile roundtrip
uv run python scripts/benchmark_python_js_communication.py --roots 10000 --commits 200 --update-ratio 0.01 --profile windowed
```

报告包含 Python tick-to-transport、tick-to-ACK 与 length-frame-to-ACK 的 p50/p95/p99/max、bytes/s、commands/s、
commits/s、pending/in-flight 峰值与最终归零，以及 catalog、packet bytes、cursor、World 和 Display Transform 的正确性
检查。时间字段先观测，不设跨机器硬阈值。
`roundtrip` profile 逐包发送并读取 ACK；`windowed` profile 用于观察饱和窗口吞吐和排队，因此其延迟也包含生产端及
ACK 读取队列等待，不能解释为孤立的 Wire/Client 处理时间。

## 资源泄漏现场测试

[`verify_display_leaks.mjs`](../../scripts/verify_display_leaks.mjs) 在一个进程内执行 authority create/remove 循环、
RenderBackend 重建、异步 fault injection、动画 player 生命周期和完整 dispose，检查 Node、Component、scheduler、
binding、resource lease、pending load 以及 Three geometry/material/texture 最终归零。根 `npm test` 统一调用该测试；
它不是独立门禁，也不以持久化运行结果作为通过条件。

## TypeScript 声明兼容

[`interop.ts`](../../js/types/interop.ts) 由根 `npm test` 的严格 TypeScript 检查编译，验证 Client、Display 和
renderer-three 的公开 `.d.ts` 可以直接组合，并验证 Authority 与 Scene 安装等同步屏障拒绝异步签名。

## Fixtures 与测试支持代码

`scripts/generate_fixtures.py` 是跨语言 Wire/Display/packet-log fixture 的唯一生成源；Client package 的
`generate-fixtures.mjs` 只委托给该入口。`fixtures/`、各 package 的 `fixtures/`、`support.mjs` 和 `helpers.mjs` 为上述
测试提供 canonical 输入或测试环境，不单独构成测试项目。只有被全量命令实际消费的 fixture 才构成自动化覆盖；例如当前
`fixtures/transform-v1/rule-matrix.canonical-vectors.json` 尚未被 Python 或 JavaScript 测试引用。
