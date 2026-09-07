# Scene Engine 测试入口

通用测试选择、断言编写与成本规则只由 workspace [总则](../../testing.md)维护。
本页说明 Engine 特有的方法和命令；具体文件与 benchmark 参数见[测试项目](tests/README.md)。

## 按边界选择

| 修改边界 | 必要时选择的入口 |
| --- | --- |
| Python Runtime、事务与传输 | `uv run python -m pytest -q tests/test_runtime.py`；传输线程用 `tests/test_transport_sender.py` |
| Wire、Display binary、recording | 对应 Python/Client 文件和 canonical fixtures；布局变化验证两端 |
| Client | `npm test --workspace @scene-engine/client`，更小范围直接指定 `test/*.test.mjs` 中的文件 |
| Display | `npm test --workspace @scene-engine/display`，或直接指定相关文件 |
| Three backend | `npm test --workspace @scene-engine/renderer-three`，或直接指定相关文件 |
| 公开 TypeScript 声明 | `npm run typecheck` |
| 泄漏、异步释放、backend rebuild | 相关生命周期用例；需要重复创建/销毁和 GC 观测时用 `npm run test:resource-lifecycle` |

只有需要整仓覆盖时才运行 `uv run python -m pytest -q`（Python）或 `npm test`（JS packages 与类型）。
`npm run test:full` 另外包含资源泄漏现场 runner，适用于专项或完整发布检查。

## Engine 特有的验证方法

- 跨语言协议使用本仓 canonical fixtures，经过生产编码器/解码器，验证 exact bytes、cursor 和拒绝边界。
  布局变化时同步两端实现、受影响测试与 fixture。
- Runtime/Client/Display 集成沿正式公开边界观察 World、命令顺序和 ACK。非法提交不得 ACK；
  对承诺原子性的操作检查失败前零写入，多命令失败按合同检查投影失效与 fresh checkpoint 恢复。
- Transport sender 用确定性的 Event/Condition 控制阻塞与恢复，检查 FIFO、连接 epoch、队列界限和 worker 释放；
  不以 sleep 推测调度，worker 不接触权威 World 或 runtime 状态。
- Node 测试的 Three TestRenderer 检查 CPU 绑定、矩阵、资源与生命周期。需要真实画面时才调用 Chrome/WebGL runner；
  CPU submit 时间不等于 GPU 完成时间或 FPS。
- 默认套件保留小规模确定性 smoke：Display 12 bindings、通讯 32 roots；Python 矩阵池测试检查位布局、只读、
  dirty batch 与生命周期。10k/30k/50k、Matrix4 benchmark、真实浏览器与多轮 GC 检查均为显式入口。
- 性能 runner 输出与自身范围匹配的 correctness 和计时；内存需区分 tracemalloc 与 RSS。
  Engine runner 只向 stdout 输出 JSON，不要求持久化历史报告；结果不可作为跨机器绝对耗时门槛。
- 内部 diagnostics 可用于检查所有权归零，不为测试增加产品 API，也不建立第二套 World、Node 树或渲染路径。

新增、删除或重命名测试文件时更新[文件索引](tests/README.md)；普通实现修改不需要改写索引或增补测试数量。
