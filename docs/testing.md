# 测试方法和标准

Scene Engine 的测试验证当前产品定义、架构所有权和技术合同。测试必须通过正式运行路径观察行为，不能为了测试
建立第二套 World、时钟、协议解码器、Client 状态、Display Node 树或渲染路径。

具体测试文件及其覆盖范围见[测试项目](tests/README.md)。

## 整体与性能测试分类

新增的整体与性能测试分为两大类；两类都沿生产边界验证正确性，性能时间先作为观测数据，不改变项目只有两条
全量测试命令的完成标准。

### 1. 显示引擎功能与性能

这一类从 `DisplayRuntime` 进入，经唯一 NodeGraph、Component/Animation 系统和 RenderSystem 到 Three backend，覆盖
简单几何体、固定与动态嵌套 Prefab、Node 增删与 reparent、位置/旋转/缩放、visibility、完整 state replacement、
Display-local sprite animation，以及 mesh、sprite、model、surface、particle 渲染路径。

默认门禁只执行小规模、离线、确定性的 foundation 与 scale smoke。真实 Three backend 的 Node 测试使用确定性
TestRenderer，因此验证 CPU 侧绑定、矩阵、批处理、资源和生命周期，但不把 GPU、驱动或浏览器调度时间混入默认
门禁。10,000、30,000、50,000 bindings 的规模运行，以及真实 Chrome/WebGL 运行，必须显式调用对应 runner。
规模 runner 为仓库内部 CPU harness，可读取 package-private diagnostics 来核对所有权归零，但不会把这些入口提升为
产品 API。浏览器 runner 的时间项是 commit、Display prepare 与 WebGL CPU submit，不等同于 GPU 完成时间或 FPS。

### 2. 通讯性能

这一类从 Python `EngineProgram` 和 `SceneEngineRuntime` 出发，经 exact Wire bytes、长度帧本地子进程、
`SceneEngineClient`、真实 `DisplayRuntime` 与无绘制 fake backend，再以 exact ACK bytes 返回 Python session。它测量
checkpoint、commit、command、ACK、pending/in-flight 和最终状态一致性，不运行 RAF、draw 或 renderer 资源工作，
因此时间中不混入渲染成本。

默认门禁只执行 32 roots 的确定性跨语言 smoke；更多 roots、commits、update ratio 和 roundtrip/windowed profile
通过显式 benchmark runner 运行。

## 测试方法

### 合同与单元测试

对一个公开合同或一个明确的内部不变量做最小验证，例如固定 60 Hz、Wire 字段、命令顺序、Node 名称、资源类型、
公共导出和生命周期状态。测试同时覆盖合法输入和合同边界上的非法输入。

### 生产路径集成测试

跨层行为使用真实公开边界连接，不另建测试捷径。Python Runtime、Wire、JavaScript Client、DisplayRuntime 和 Three
RenderBackend 的集成测试应沿正式数据流验证状态发布、ACK、显示提交、渲染绑定、恢复和释放。

### 跨语言一致性测试

Python 与 JavaScript 共享的协议、Display 记录、目录身份和 packet log 使用仓库内 canonical fixtures 校验。涉及
跨语言布局或身份的变更，必须在同一变更中更新两端实现、两端测试和对应 fixture；不保留旧格式兼容分支。

### 失败、原子性与生命周期测试

失败测试不仅检查抛错，还检查失败发生的边界：候选必须在写入前完整校验，非法提交不得 ACK；承诺原子性的单目标
操作失败后不能留下部分 Node、Component、binding、resource lease 或 pending load。跨多命令失败必须使投影失效，
并要求从新 checkpoint 恢复。创建、替换、重建、移除和 dispose 必须覆盖成功、取消、迟到完成和重复释放。

### 规模回归与资源现场测试

默认规模 smoke 通过固定的小数量 roots、commits、嵌套实例和生命周期循环，验证同一套功能合同仍成立，并作为
全量测试的一部分。10,000、30,000、50,000 等大规模用例由显式 runner 执行，避免把开发机性能和本地 Chrome/GPU
条件变成默认门禁。资源现场测试在进程内实际执行创建、故障注入、重建和销毁，并以最终所有权计数归零作为
断言。

性能 runner 必须同时报告结构、cursor、最终状态、健康和释放正确性。p50、p95、p99、maximum、吞吐与内存数据
现阶段用于观察和建立基线；在没有固定硬件、运行环境和经确认的基线前，不设置跨机器绝对时间硬阈值。

### 类型兼容测试

TypeScript 严格模式编译真实的 Client、Display 和 renderer-three 组合，验证三个包的公开声明可以互操作，并验证
同步事务边界不会被异步实现替代。

## 编写标准

- 测试名称描述可观察行为和预期结果，不以实现步骤或缺陷编号代替合同语义。
- 每项新行为至少覆盖正常路径和关键拒绝路径；涉及事务或生命周期时，还要验证失败后状态与资源所有权。
- 测试必须确定、离线且可重复，不依赖网络服务、墙钟日期、执行顺序或开发机已有状态。
- 临时包、录制目录和生成数据写入测试提供的临时目录，并由测试负责清理；仓库不保存测试运行结果。
- 性能与浏览器 runner 只向 stdout 输出 JSON；不得创建、更新或要求提交持久化性能报告或历史结果文件。
- 共享 fixture 是测试输入，不是另一套实现。测试必须通过生产编码器、解码器或公开运行边界消费它。
- 测试可以检查 package-private 不变量，但不能把内部入口包装成新的产品 API。
- 修复实现时不得仅为通过测试而放宽现行合同、增加 fallback，或把应失败的输入改成兼容接受。
- 新增、删除或重命名测试文件时，同步更新[测试项目](tests/README.md)。

## 执行方式

开发过程中可以先运行受影响范围的局部测试：

```bash
uv run python -m pytest -q tests/test_runtime.py
npm test --workspace @scene-engine/client
npm test --workspace @scene-engine/display
npm test --workspace @scene-engine/renderer-three
```

局部测试只用于缩短反馈时间，不能代替完整测试。

默认全量门禁只运行小规模确定性 smoke，不自动执行 10,000、30,000、50,000 规模 runner 或真实 Chrome/WebGL
runner。需要规模或浏览器时间数据时，按[测试项目](tests/README.md)中的命令显式运行。

## 完成标准

项目只有一个完成标准：从仓库根目录运行以下两个命令，Python 与 JavaScript 全量测试全部通过。

```bash
uv run python -m pytest -q
npm test
```

判定规则：

- 两个命令都以状态码 0 完成；
- 所有发现的测试均通过，不以 skip、todo、只运行局部测试或只运行一个语言的测试代替；
- `npm test` 统一执行各 JavaScript workspace 测试、资源泄漏现场测试和跨包 TypeScript 声明兼容测试；
- 测试结果以本次命令的状态和输出判定，不要求生成或提交运行结果文件；
- benchmark 工具和 release verifier 的行为可以由全量测试中的普通测试文件覆盖，但它们不是独立完成条件。
- 大规模与浏览器 runner 的时间数据不构成跨机器硬门槛；runner 的正确性检查失败仍视为该次显式运行失败。
