# Scene Engine

`scene-engine/` 是从 Missile War 玩法项目中并行抽取的场景运行时实验仓库。当前切片实现：

- runtime 独占整数 tick，gameplay 只实现 `step(context, commands)`；
- gameplay 异常逃逸后 runtime 进入 fatal，失败 tick 不提交也不重试；
- simulation rate 与 display sampling rate 分离；
- 完整动态显示帧使用 little-endian canonical packed bytes；
- latest-only mailbox 提供有界 lease；
- transport packet envelope 的首个基线只实现 `compression_codec = 0`；
- producer identity tracker 观察每份已导出帧并禁止 ID 复用；
- 无 renderer 的 complete-set consumer 验证跳帧、绝对状态、移除和隐藏语义。
- migration candidate 已冻结 packed SceneBootstrapV1、DisplayFrameV2 typed sections、canonical
  correlation/control、跨语言 golden 与 malformed corpus；runtime 已有 dormant MW 60Hz mandatory
  authority/display ports，尚未接入 ordered transport/renderer。

这是 `complete-dynamic-frame-binary-v4` 计划的内核预切片，不是该计划第 24 节完整纵向切片，
也不是 current 产品协议。
当前 `python-game -> v5 -> replay/arts` 链路仍逐 tick 保留 60 Hz authority frame；本项目的
latest-only frame 不能作为 raw tape、strict Replay 或当前验收证据。

物理目录与 GitLab repository 最后路径段统一使用 `scene-engine`；Python package 名继续使用
`scene_engine`。

## 快速验证

项目只依赖 Python 标准库；测试使用工作区现有 pytest：

```bash
PYTHONPATH=src python3 -m pytest
python3 -m compileall -q src tests
```

## 包边界

```text
gameplay GameSimulation
        |
        | step(TickContext, frozen command batch)
        v
SceneEngine / SceneEngineRuntime -> DisplayFrameWriter -> canonical bytes
        |                                           |
        |                                           v
        +--------------------------------> LatestFrameMailbox
                                                    |
                                                    v
                                         CompleteFrameConsumer
```

`scene_engine` 不包含玩法规则、WorldState、路径、碰撞、资源选择、WebSocket server、Replay、
Unity/Godot 对象或 Three.js 场景。当前实现也不修改任何现有 v5 入口。

## 实现边界

| 已实现 | 明确延后 |
| --- | --- |
| engine-owned tick、catch-up、fatal、MW 60Hz mandatory authority/display ports | Python facade 的 composition adapter 与 durable transport |
| experimental V1 及 candidate BootstrapV1/FrameV2/control/correlation golden | Python exporter、ordered transport、Replay sidecar 与 Arts store/binder |
| producer ID tracker、latest mailbox、complete-set consumer | recent-event window、renderer resource generation |
| 24-byte packet envelope、bootstrap/frame message type 与 codec-none | MW ordered 60Hz WebSocket、ACK/credit 与可选压缩 |
| experimental 60 tick / 30 frame / 稀疏消费测试 | MW 每 tick complete frame、严格 consumer、可复用 pool、diagnostic 与性能门禁 |
| Python polling host | C++ core/C ABI、Unity/Godot/Web renderer adapter |

最小组合入口：

```python
from scene_engine import ManualClock, RuntimeConfig, SceneEngine

clock = ManualClock()
engine = SceneEngine(
    simulation,  # 实现 step() 和 write_display_frame()
    config=RuntimeConfig(ticks_per_second=60, display_frames_per_second=30),
    clock=clock,
)
```

## 当前冻结项

本仓库的 experimental schema 细节记录在
[`docs/contracts/display-frame.md`](docs/contracts/display-frame.md)，迁移隔离规则记录在
[`docs/contracts/current-v5-boundary.md`](docs/contracts/current-v5-boundary.md)。只有这些本地
合同和 golden vectors 一起升级时，schema 才能变化；任何不兼容物理布局必须增加
`schema_version`，不能在 `schema_version = 1` 下静默改写。

正式 MW candidate 的 Bootstrap V1、DisplayFrame V2、correlation/control 与 owner inventory 物理合同见
[`docs/contracts/presentation-profile.md`](docs/contracts/presentation-profile.md)；它使用独立 schema/version，
不修改 experimental DisplayFrame V1 fixture。

runtime 的提交/失败/命令边界见 [`docs/contracts/runtime.md`](docs/contracts/runtime.md)，现有能力
到目标模块的迁移映射见 [`docs/extraction-plan.md`](docs/extraction-plan.md)。
已完成工作、目标双支路架构以及接入 `python-game` / Arts Web3D 显示壳的分阶段方案见
[`docs/integration-plan.md`](docs/integration-plan.md)。

## 下一步

1. 将 `python-game` 单 tick facade 通过 composition adapter 接入 dormant MW runtime profile；
2. 实现 ordered ACK/credit Web transport 与 Replay sidecar，不把 latest mailbox接入 MW StateSource；
3. 完成 Arts 单 DisplayShell/business store/owner adapters 与 100/1000/3000/5000 entities 性能门禁；
4. C++ core 与 C ABI 若实施，必须复用相同 canonical bytes，不能暴露 native struct layout。
