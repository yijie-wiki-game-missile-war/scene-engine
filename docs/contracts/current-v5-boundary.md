# Current v5 迁移边界

状态：experimental project boundary，不修改 workspace binding contract。

## Current 链路保持不变

以下路径仍由 Python 产生并逐 tick 保留 60 Hz 状态：

```text
python-game -> mw-authority-state-v5@1 -> raw tape / Replay -> Arts Web3D
```

因此在显式跨项目切换前：

- current Python 仍是权威 tick 的唯一生产者；
- catch-up 的每个已推进 tick 都必须发布 current v5 authority state；
- current transport、tape 和 Replay 不允许 latest-only 覆盖；
- current consumer 仍拒绝普通状态流中的 forward tick gap；
- renderer 插值不构成新的规则事实或 60 Hz 验收证据。

## Engine 实验路径

本项目的 complete frame 是独立 presentation projection：

- 可以低于 simulation tick rate 采样；
- mailbox 可以覆盖尚未 acquire 的旧帧；
- consumer 可以跳到更新的完整绝对状态；
- display capture 不是 strict gameplay Replay。

任何接入必须使用独立入口和 identity，不能让 current v5 parser 猜测或双读新格式。
当前 engine runtime 尚无“每个 committed tick 必达”的 authority commit port，因此现在不能接管
current Missile War simulation；display sampling callback 不能兼任 v5 authority publication。

## 切换条件

若未来要把 latest-only 路径提升为 current，必须先显式修改全局 60 Hz binding contract，
并联合迁移 `python-game`、`replay`、`arts` 和 acceptance。仅把 display publish rate 配成
60 Hz 不足以满足现有合同，因为背压覆盖仍会丢失中间 authority frame。
