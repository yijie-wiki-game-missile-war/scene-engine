# Scene Engine

`scene-engine` 是 renderer-neutral 的 fixed-step runtime 与 presentation platform。Python 和
JavaScript 包统一发布为 `0.2.0`，业务项目只能通过明确 adapter/profile 接入，不得把玩法、产品 API
或资源目录反向写入 Engine。

正式 V2 能力包括：

- `SceneEngineRuntime`：整数 tick、逐 tick catch-up、fatal boundary，以及严格 authority + presentation 提交；
- `SceneBootstrapV2`、完整 `PresentationFrame V2`、packet codec 和 opaque authority cursor；
- `scene-presentation-control-v2@1` 与有界 `OrderedPresentationSession`；
- `scene-presentation-archive-v2@1` 的流式 Python writer、Node/browser byte-range reader；
- renderer-neutral display transaction core、Three lifecycle backend；
- transport-neutral Replay timeline、authority/presentation composite session；
- Node WebSocket 有界写队列和独立 write deadline。

旧 latest-only mailbox、consumer 与 `SceneEngine` host 仅从 `scene_engine.experimental` 暴露，不能进入
Missile War production import graph。旧 presentation-control/session 实现已删除；V2 不提供双实现 fallback。

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
       -> OrderedPresentationSession / Archive V2

Archive V2 + authority lane
  -> CompositeReplaySession

Bootstrap + ordered frames
  -> @scene-engine/display-core
       -> @scene-engine/renderer-three
       -> product-owned visual factories/resources
```

JavaScript workspace 包：

- `@scene-engine/presentation-codec`
- `@scene-engine/presentation-session`
- `@scene-engine/presentation-archive`
- `@scene-engine/replay-core`
- `@scene-engine/display-core`
- `@scene-engine/renderer-three`
- `@scene-engine/transport-node-websocket`

Engine 不包含 WorldState、MW v5 字段、规则坐标、FeatureOwner 内容、录像元数据、HTTP/API 或资源选择。
authority cursor 在通用层始终是 `{ codecIdentity, canonicalBytes }`；字段解释属于产品 adapter。

## Python 最小入口

```python
from scene_engine import ManualClock, RuntimeConfig, SceneEngineRuntime

clock = ManualClock()
runtime = SceneEngineRuntime(
    simulation,
    config=RuntimeConfig(ticks_per_second=60, display_frames_per_second=30),
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
- [`docs/contracts/presentation-profile.md`](docs/contracts/presentation-profile.md)：V2 Bootstrap、Frame、cursor 与 control；
- [`docs/contracts/display-frame.md`](docs/contracts/display-frame.md)：隔离保留的 experimental V1 slice；
- [`docs/contracts/current-v5-boundary.md`](docs/contracts/current-v5-boundary.md)：MW adapter 与 Engine 边界；
- [`docs/integration-plan.md`](docs/integration-plan.md)：当前跨项目 V2 composition 和发布门禁。

schema/profile 变更必须同步升级跨语言 golden、malformed corpus、Archive reader、共享 generated profile
与 release manifest。任何不兼容物理布局必须增加 schema version。
