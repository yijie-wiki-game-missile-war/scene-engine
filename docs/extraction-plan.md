# 从 current Python runtime 的并行抽取计划

本项目采用“先复制通用边界并用 contract tests 固定，再由 adapter 接入”的方式；当前完成的是
kernel/pre-slice，不是计划第 24 节的完整纵向切片，也不会从 `python-game` 删除文件。

| Current Python 能力 | Engine 目标 | 首切片处理 |
| --- | --- | --- |
| `core/runtime_driver.py` clock/deadline/catch-up | `scene_engine.clock` / `runtime` | 重写为 engine-owned tick，保留逐 tick catch-up 思路 |
| `core/simulation.py` / `WorldState.tick` | gameplay adapter | 留在 `python-game`，不进入 engine |
| `core/domain_runtime.py` display/view 语义 | `write_display_frame` adapter | 领域映射留在 `python-game` |
| `core/authority_projection.py` full v5 projection/diff | authority owner + display exporter input facade | 不搬迁；visibility/transform owner 继续唯一 |
| `core/authority_state_stream.py` ACK/retention/resync | v5 lane + projection correlation | current v5 原样保留；pending item 增加 origin projection identity |
| `adapters/web/socket_server.py` JSON ordered queue | 分离的 binary ordered ACK/credit Web adapter | 首切片不实现 WebSocket server |
| Demo1 raw tape / Replay | strict gameplay Replay + derived presentation sidecar | raw tape 不变；正式迁移新增同 exporter sidecar |
| Rule Transform / PositionRef / hex / WDU | gameplay/profile | 不进入 renderer-neutral engine core |

## 阶段门禁

1. runtime、binary schema 和 golden vector 在本项目内通过；
2. 用纯测试 gameplay 完成 60 tick / 30 sample / 稀疏 consumer 纵向切片；
3. 冻结新 Bootstrap/DisplayFrame/Correlation/Control schema 和跨语言 corpus；
4. 在 engine runtime 增加 mandatory authority port 与 MW per-tick display export；
5. 证明 60 gameplay tick 产生 60 份 current v5 projection 和至少 60 份 ordered complete frame，
   且 v5/raw tape 每 byte parity；
6. 实现 ordered ACK/credit Web transport、Replay sidecar 与 Arts single-shell adapter；
7. C++/C ABI 若实施必须复用 canonical bytes；
8. 只有完整 release manifest 和整体 rollback 演练通过后才切换 current。
