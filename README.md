# Scene Engine

`scene-engine` 是 renderer-neutral 的 fixed-step runtime 与 presentation platform。Python 和
JavaScript 包统一发布为 `0.4.0`，业务项目只能通过明确 adapter/profile 接入，不得把玩法、产品 API
或资源目录反向写入 Engine。

正式 V3 能力包括：

- `SceneEngineRuntime`：整数 tick、逐 tick catch-up、fatal boundary，以及严格 authority + presentation 提交；
- `SceneBootstrapV3`、完整 parent/local `PresentationFrameV3`、packet codec 和 opaque authority cursor；
- `PresentationIdAllocator` 与 Python parent closure/cycle/depth/world-pose validator；
- `scene-presentation-control-v2@1` 与有界 `OrderedPresentationSession`；
- `scene-presentation-archive-v3@1` 的流式 Python writer、checkpoint directory 与 Node-only byte-range reader；
- 唯一公共 `SceneDisplayEngine`（内部一个 `PresentationSceneTree`）：dense SoA static/dynamic tree、world
  pose、metadata/profile/interaction 查询、linear merge change plan 与非空 frame batch 原子 prepare/commit；
  correlation 顺序只由 session/coordinator 持有；`commitValidated()` 不运行 observer，产品 coordinator
  完成 business/tree/cursor 联合 pointer swap 后才调用 `schedulePostCommitCapture()` 排入受保护 microtask；
- transport-neutral Replay timeline、authority/presentation composite session；
- transport-neutral session admission、credit、ACK、reset 与 deadline mechanics。

production Python/JavaScript presentation surface 只导出 V3 codec，不提供 V1/V2 alias 或 decoder fallback。
旧 DisplayFrame V1、latest-only mailbox、consumer、legacy host 与 experimental import 已从 production、包和
测试中删除。

## 快速验证

```bash
python3 -m pytest -q
python3 -m compileall -q src tests
npm install --ignore-scripts
npm test
```

## 包边界

```text
gameplay adapter
  -> SceneEngineRuntime
       -> authority commit
       -> complete presentation export
       -> OrderedPresentationSession / Archive V3

Archive V3 + authority lane
  -> CompositeReplaySession

Bootstrap + ordered frames
  -> @scene-engine/display-core
       -> product-composed Three backend
       -> product-owned visual factories/resources
```

JavaScript workspace 包：

- `@scene-engine/presentation-codec`
- `@scene-engine/presentation-session`
- `@scene-engine/presentation-archive-node`
- `@scene-engine/replay-core`
- `@scene-engine/display-core`
- `@scene-engine/renderer-three`

Engine 不包含 WorldState、MW v5 字段、规则坐标、FeatureOwner 内容、录像元数据、HTTP/API 或资源选择。
authority cursor 在通用层始终是 `{ codecIdentity, canonicalBytes }`；字段解释属于产品 adapter。
authority lane 可通过 `transmissionsOf(record)` 提供以该 authority wire 开头、随后为原始 outbound control
的有界数组；Replay Core 不解释 control 内容。Composite 每次先整体预检并释放 authority 主帧与对应
presentation correlation，尾随 control 可以跨 transport batch，但不会被下一条 authority 越过。
Composite 的 `openCheckpoint()` authority port 同时给出当前 checkpoint 的
`endRecordIndexExclusive`；一个 generation 只播放该 segment，绝不把下一 snapshot/new epoch 注入当前
Engine 世代。

## Python 最小入口

```python
from scene_engine import ManualClock, RuntimeConfig, SceneEngineRuntime

clock = ManualClock()
runtime = SceneEngineRuntime(
    simulation,
    config=RuntimeConfig(ticks_per_second=60, display_frames_per_second=60),
    clock=clock,
    frame_export=export_complete_frame,
)
```

严格 authority/presentation profile 需要每 tick 一帧，并同时提供 `authority_commit` 与
`frame_export`：

```python
RuntimeConfig(
    ticks_per_second=60,
    display_frames_per_second=60,
    strict_authority_presentation=True,
)
```

## 合同

- [`docs/contracts/runtime.md`](docs/contracts/runtime.md)：runtime 提交、失败与严格 profile；
- [`docs/contracts/presentation-profile.md`](docs/contracts/presentation-profile.md)：V3 Bootstrap/Frame packed layout、
  parent/local tree、borrowed codec 与 dense display core；
- [`docs/contracts/presentation-session.md`](docs/contracts/presentation-session.md)：有界 retry、credit/deadline 与 product-owned reset identity；
- [`docs/contracts/presentation-archive.md`](docs/contracts/presentation-archive.md)：Node-only Archive V3 精确物理格式与 checkpoint directory；
- [`docs/contracts/current-v5-boundary.md`](docs/contracts/current-v5-boundary.md)：MW adapter 与 Engine 边界；
- [`docs/integration-plan.md`](docs/integration-plan.md)：当前跨项目 V3 composition 和发布门禁。

schema/profile 变更必须同步升级跨语言 golden、malformed corpus、Archive reader、共享 generated profile
与 release manifest。任何不兼容物理布局必须增加 schema version。
