# Current v5 迁移边界

状态：experimental project boundary；迁移候选受 workspace binding contract 约束。

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

## Engine 实验路径与正式目标

本项目的 complete frame 是独立 presentation projection：

- 可以低于 simulation tick rate 采样；
- mailbox 可以覆盖尚未 acquire 的旧帧；
- consumer 可以跳到更新的完整绝对状态；
- display capture 不是 strict gameplay Replay。

以上四点只适用于非 MW experimental profile。它们不能成为正式 Missile War StateSource、Replay
presentation 或 acceptance 的依据。

正式 MW 候选 profile 受
[`mw-global-time-rule.md`](../../../.engineer/contracts/mw-global-time-rule.md) 与
[`mw-presentation-source.md`](../../../.engineer/contracts/mw-presentation-source.md) 约束：每个 committed
tick 至少一份 complete frame，reliable ordered bounded transport 不覆盖中间项，consumer 逐份 commit，
Replay 使用分离 sidecar 和 v5/binary 联合 gate。

任何接入必须使用独立入口和 identity，不能让 current v5 parser 猜测或双读新格式。
当前 engine runtime 尚无“每个 committed tick 必达”的 authority commit port，因此现在不能接管
current Missile War simulation；display sampling callback 不能兼任 v5 authority publication。

## 切换条件

latest-only 路径不会提升为 MW current。迁移必须新建正式 schema/control/transport/sidecar/Arts source，
完成跨仓 parity 和 release manifest 门禁后一次切换。仅把 `display_frames_per_second` 配成 60 仍不足，
因为当前 V1 schema、gap-tolerant consumer 和 mailbox 覆盖语义都不满足 binding 合同。
