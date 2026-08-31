# Scene Engine 0.6 / 500 节点架构迁移验收报告

日期：2026-08-23

> 历史证据：本报告只证明 2026-08-23 的 structured-scene/core 0.6
> 迁移及当时的 renderer 0.6 tuple，不证明当前 renderer 0.8 Render Runtime
> 切换。当前合同和验证方式以
> [当前技术文档索引](../../../README.md)与
> [Three 渲染后端合同](../../render-runtime.md)为准。

本轮按一次切换完成，当前运行组合只有 Scene Engine 0.6 与
`missile-war-world-state@2`。旧合同没有 alias、fallback、双解码器或双发布路径。500 动态节点是本轮
功能验收上限；按最终交付决定，耗时数值保留为诊断证据，不作为本轮提交阻塞项。

## 最终合同

- `ProductCheckpoint` 只接收 `world_codec/world_snapshot/scene_bootstrap/scene_nodes/scene_events`；
- `ProductCommit` 只接收 `world_codec/world_patch/scene_nodes/scene_events`；
- 产品返回结构化 `SceneNode`/`SceneEvent`，Engine 针对缓存 bootstrap 验证并只编码一次 frame；
- tick commit 始终携带 complete dynamic frame；仅视觉不变的同 tick input commit 可以不带 frame；
- Missile War 玩法事件只写入 `WorldState.events`，scene event 只存在于 scene frame；
- attachment kind 5 已从 Python/JavaScript attachment 枚举删除，遇到旧 kind 5 时 fail closed；
- Arts 只接受 world-state @2，Replay 只保存并原样播放当前 Engine packet log。

产品 JSON 数字接受有限浮点数，包括负零和指数形式；NaN 与正负 Infinity 拒绝。枚举、kind、长度、
tick、revision、commit sequence、数组路径下标等离散协议字段仍要求安全整数。超出 JavaScript 安全整数
范围的产品整数继续使用产品 codec 的无损 tagged form。

## 删除与唯一所有权

- 物理删除 `python-game/adapters/scene_projection_data.py` 及旧 scene DTO/deep-copy 投影图；
- 删除 `_INPUT_FIELDS`、`input_scope_fields`、tick boundary 猜测集合和 dispatcher 局部 rollback；
- 删除产品 encoded scene-frame 入口、parse-after-encode 和独立 product-events attachment；
- 删除普通 frame 的静态 registry/map/pose 重建与 combined static+dynamic 数组；
- 运行期保持一个 `SceneEngineRuntime`、一个可变 `WorldState` owner、一个 packet stream、一个客户端
  WorldState pointer、一棵 SceneTree、一个累计 ACK cursor；Arts 架构扫描结果 `stateOwners == 1`。

## 正确性证据

- input no-op、rejected、预期异常和意外异常均在原 root identity 上恢复完整 before-image；changed input
  通过 `record_input_diff` 产生可重建 after snapshot 的 patch；
- 600 tick 链式 patch oracle 与完整 snapshot 严格相等；investment、diplomacy、combat、occupation、
  production 等 mutation boundary 使用真实 journal hook；
- idle wander plan 是稳态权威，普通 tick 不再写 500 个 person position；显示位置由唯一纯 resolver 按 tick
  采样；
- Python、JavaScript、Arts 与 Replay 的最终测试命令和数量记录在 Scene Engine cutover report；
- forbidden scan 对 `.engineer`、旧 owner/bridge、旧 scene 投影入口、猜测式 journal scope、world-state @1、
  退役 vendor 身份与兼容入口均为零。

## 500 节点证据

真实产品 workload 使用 seed 42、500 个可见动态实体、60 Hz complete frame。类型组成是 489 person、
4 company address、2 building 和 5 weapon；另有约 632 个静态地图节点只在 bootstrap 构建。正式报告包含
5 轮、每轮 600 个样本，真实 runtime 每 tick ACK 600 次，并运行 3600 commit soak。

正式结果的关键值如下（p95）：step `3.277 ms`、journal finalize `0.721 ms`、直接投影
`7.528 ms`、Engine scene validate + single encode `8.169 ms`、wire encode `1.124 ms`、step 后 publication
`20.554 ms`、step + publication `23.833 ms`。完整 frame 固定 `98,632 bytes`；world patch p95
`26,806 bytes`，60 tick 边界最大 `156,368 bytes`；combined commit p95 `125,737 bytes`、最大
`255,304 bytes`，均在本轮包大小合同内。

600 tick 的 tick/commit 序列精确、patch reconstruction oracle 通过、每次 ACK 后 session pending 与 in-flight
均为零。3600 tick soak 的 retained packet count/bytes 受配置上限约束，结束时 session/transport backlog 为零；
后半段 RSS 不是单调增长且净减少 `74,530,816 bytes`。`tracemalloc` current 在后半段增加
`37,942,791 bytes`，与达到 256 MiB 上限前的 raw packet retention 和持续增长的产品历史状态同时存在，作为
后续内存诊断项保留，不阻塞本轮交付。

标准 packet log 共 602 条记录（起止 2 个 checkpoint，commit sequence 0–600），`packets.bin` SHA-256 为
`ff3991fdc70d74a4434a53128cbdc649886c72cbf9a0815ec8c34acea1bb50cb`。Replay 使用自身
`validateEnginePacketLog` 与同一 `SceneEngineClient` 播放 601 个选定记录，每帧严格 500 个动态节点；从
commit 300 seek 后可继续到 commit 600。受并行验收负载影响的 apply p50/p95/p99 为
`8.151 / 13.489 / 24.808 ms`，仅作诊断记录。

Scene Engine 合成 workload 与客户端均覆盖 steady、motion、churn-25，每个场景 3,000 个正式样本：

| 场景 | Python publication p95 | JavaScript client p95 |
| --- | ---: | ---: |
| steady | 10.493 ms | 2.239 ms |
| motion | 7.715 ms | 1.675 ms |
| churn-25 | 6.519 ms | 1.957 ms |

这些基准是在最终验收并行负载期间采集；本轮不把绝对耗时作为提交门禁。节点数、complete frame、包大小、
ACK 无积压、packet byte identity、Replay 可播放和有界 retention 仍是硬正确性条件。

## 发布工件

| 工件 | SHA-256 |
| --- | --- |
| `scene_engine-0.6.0-py3-none-any.whl` | `6cf8eba39d097fc210f220c259f7d5781152c366f06c5ed4f4f6d4c8ae893491` |
| `scene-engine-client-0.6.0.tgz` | `e7feeb9d197616f36379443e86e51157d0440cf022dbf4d4cb668df7a4936abb` |
| `scene-engine-renderer-three-0.6.0.tgz` | `5763e54b4725108ec6e87e990af22181514974c388563f2ad1ee78b62871e0f0` |

consumer vendor 与 lockfile 指向上述唯一 0.6 工件。Replay 的 ignored 部署 staging 已用最终 Arts build
原子替换，487 个文件、272,287,358 bytes 与源构建逐文件一致；旧 staging 已移到系统废纸篓，未触碰
`replay/data`。

## 提交与源码包

| Repository | Tested source commit | Pre-cutover rollback commit |
| --- | --- | --- |
| scene-engine | `ad6a023` | `60fc064` |
| python-game | `b29ba57` | `93b03f8` |
| Arts | `67b4ba6` | `790f322` |
| Replay | `001f010` | `29e220c` |

回滚必须四个运行仓整体切换到迁移前 tuple，并使用该 tuple 产生的录制；迁移前与当前 packet history
不混用。

正式产品证据位于 `python-game/docs/evidence/runtime-500.json`，SHA-256 为
`ec8c179419490547dce7d0c8270ec3118a95d2eae7e755762940b320c32e91b3`。

最终交付为轻量源码包 `missile-war-scene-engine-0.6.0-500-node-source-2026-08-23.zip`，只包含四个迁移仓的
源码、测试、lockfile、合同、代码相关文档与验收证据，以及本工作区报告；不包含 `.git`、`node_modules`、
虚拟环境、cache、build/dist、Replay 录制与部署 staging、嵌套压缩包或任何媒体资源。包内生成的
`SOURCE-MANIFEST.json` 逐文件记录路径与 SHA-256。

源码包在无 `.git`、清空继承 Python/Node module path 的独立目录完成复验：Scene Engine Python 60 项、
benchmark 入口 4 项、client 16 项、renderer 9 项与 cutover verifier 全部通过；python-game 220 项通过；
Replay 23 项通过；Arts 的 architecture/workspace/authoring 以及 manifest、transform、projection、lifecycle、
controller、backend、summary 代码门禁全部通过，controller soak 为 5000 commits / 5000 ACKs 且 retained
world 始终为 1。

由于源码包按用户要求排除媒体文件，独立解压目录不声称执行 Arts production build 或
`check:runtime-projection`；这两个依赖媒体的门禁已在打包前针对完整工作树通过。源码包最终大小与
SHA-256 在交付回执中给出。
