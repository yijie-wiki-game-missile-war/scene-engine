# 从 current Python runtime 的并行抽取计划

本项目采用“先复制通用边界并用 contract tests 固定，再由 adapter 接入”的方式；当前完成的是
kernel/pre-slice，不是计划第 24 节的完整纵向切片，也不会从 `python-game` 删除文件。

| Current Python 能力 | Engine 目标 | 首切片处理 |
| --- | --- | --- |
| `core/runtime_driver.py` clock/deadline/catch-up | `scene_engine.clock` / `runtime` | 重写为 engine-owned tick，保留逐 tick catch-up 思路 |
| `core/simulation.py` / `WorldState.tick` | gameplay adapter | 留在 `python-game`，不进入 engine |
| `core/domain_runtime.py` display/view 语义 | `write_display_frame` adapter | 领域映射留在 `python-game` |
| `core/authority_projection.py` full v5 projection/diff | complete-frame exporter | 不搬迁；未来旁路 exporter 重新实现 |
| `core/authority_state_stream.py` ACK/retention/resync | latest mailbox | current v5 原样保留；实现独立 experimental mailbox |
| `adapters/web/socket_server.py` JSON ordered queue | binary latest-only Web adapter | 首切片不实现 WebSocket server |
| Demo1 raw tape / Replay | strict gameplay Replay | 完全不由 display frame/capture 替代 |
| Rule Transform / PositionRef / hex / WDU | gameplay/profile | 不进入 renderer-neutral engine core |

## 阶段门禁

1. runtime、binary schema 和 golden vector 在本项目内通过；
2. 用纯测试 gameplay 完成 60 tick / 30 sample / 稀疏 consumer 纵向切片；
3. 在 engine runtime 增加独立的 post-step authority commit port：每个 committed tick 必调一次，
   失败必须停止后续 tick，且其顺序先于可降采样 display export；
4. 用双支路测试证明 60 gameplay tick 产生 60 份 current v5 authority frame，同时只产生 30 份
   experimental display frame，之后才可添加 `python-game` adapter；
5. 实现 bootstrap/profile、真实 frame pool、event/resource/diagnostics 门禁后，才添加非 current
   Web binary 入口；
6. C++/C ABI 复用 canonical bytes；
7. 是否切换 current 必须另立跨项目合同与迁移任务。
