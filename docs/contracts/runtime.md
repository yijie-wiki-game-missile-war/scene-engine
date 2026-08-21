# Engine-owned Tick Runtime contract

状态：`scene-engine-runtime-v1@experimental`，不替换 current Missile War v5 runtime。

## Tick ownership

- `SceneEngineRuntime.current_tick` 是本 runtime 的唯一 source tick。
- tick 从 0 开始，只能在一次 `GameSimulation.step()` 正常返回后增加 1。
- gameplay 收到只读 `TickContext(tick, ticks_per_second, elapsed_ticks=1)`，不能要求 runtime
  跳过、回退或一次提交多个 tick。
- wall clock 只决定需要补做多少整数 tick，不能直接成为 gameplay 时间。

Missile War profile 使用精确 `60 ticks_per_second`。runtime 配置允许其他正整数，以便进行独立
conformance 测试；任何 current MW adapter 必须固定为 60。

## Pump 与 catch-up

`pump()` 读取 monotonic clock，计算目标 tick，并按顺序执行 overdue ticks。单次最多执行
`maximum_ticks_per_pump`；仍落后的 tick 留给下一次 pump，不能合并为一次 gameplay step。
`pump()` 不可重入；并发或 gameplay 回调中的第二次调用必须立即失败，不能等待自身造成死锁。

runtime 构造时建立 wall-clock origin；未经过相应 wall-clock 时间的 pump 不推进 tick。clock 回退或
非有限值是 runtime 错误。

## 命令边界

`enqueue_command()` 在 runtime lock 下把 intent 分配给尚未开始的明确 effective tick。每个 tick
开始前，runtime 冻结该 tick 的 tuple batch；step 执行期间新到命令只能进入后续 tick。
未开始命令总数受 `maximum_pending_commands` 限制，达到上限时 fail closed，不允许无界排队。

命令结果不是 display frame 的一部分，也不能依赖该帧被消费。

## Fatal tick

若 `step(tick=N)` 有未处理异常逃逸：

- N 不成为 `current_tick`；
- N 不触发 display export；
- runtime 进入永久 fatal，保存原始 cause；
- N 不自动 retry，N+1 永不执行；
- engine 不尝试 rollback gameplay 已经进行的原地写入。

恢复必须由外层创建新 gameplay/runtime，必要时建立新 scene epoch。

## Display sampling

Display sampling 使用整数比率调度，不反向影响 gameplay。首切片要求
`0 < display_frames_per_second <= ticks_per_second`。例如 60 TPS / 30 FPS 在 tick
2、4、…、60 各触发一次 sample attempt。

一次 export 失败只跳过该 display sample，并记录 health；已提交 gameplay tick 继续。只有完整、
通过验证并 seal 的 frame 可以 publish。latest-only 只属于这条实验 display 支路，不能用于 current
v5 authority publication。

## Missile War candidate profile

上述 sampling/failure 语义只适用于 experimental profile。正式 Missile War 候选必须增加 mandatory
authority commit port 和 mandatory per-tick presentation export：

```text
gameplay.step(exactly one tick)
  -> immutable ProjectionCommitBatch
  -> durable authority outbox admission
  -> mandatory complete DisplayFrame export for this tick
  -> ordered wire publication/correlation/raw-record sink
```

MW candidate 固定 `ticks_per_second = display_frames_per_second = 60`。同 tick presentation-changing
事务可以产生额外 frame。任一 binary export 失败使当前 presentation epoch 失效，下一成功帧不能跨 gap
继续；以 new epoch + Bootstrap + complete frame 恢复。authority/tape 能否继续由 binding fault contract
决定，不能复用 experimental “跳过 sample 后继续同 epoch”的策略。

首次 runtime 切换不使用本 runtime 的 next-tick command batch；current v5 command 仍由 Python input
composition 即时处理，frozen command tuple 固定为空。command batch 的正式迁移需要独立版本合同。
