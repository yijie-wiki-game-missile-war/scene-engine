# Engine-owned Tick Runtime contract

状态：`scene-engine-runtime-v2@1`。

## Tick ownership

- `SceneEngineRuntime.current_tick` 是 runtime 唯一 source tick；从配置的 initial tick 开始，只在
  `GameSimulation.step()` 正常返回后递增。
- gameplay 每次只收到一个不可变 `TickContext`；wall clock 只能决定补做多少整数 tick，不能成为规则时间。
- `pump()` 不可重入；单次 catch-up 受 `maximum_ticks_per_pump` 限制，不合并、跳过或回退 tick。
- 未开始命令受 hard limit 约束；严格 authority/presentation profile 的命令由 authority facade 处理。

## Commit 与失败边界

普通 profile 中，display sampling 是可配置的完整状态投影；一次 export 失败记录 health，但不回滚已提交玩法 tick。

`strict_authority_presentation=True` 时，顺序固定为：

```text
gameplay.step(exactly one tick)
  -> immutable authority commit
  -> mandatory complete presentation export for the same tick
```

严格 profile 要求 `display_frames_per_second == ticks_per_second`，并必须注入 `authority_commit` 与
`frame_export`。它不硬编码具体游戏的 60Hz；MW adapter 依据 workspace 全局时间合同把两者配置为 60。

异常语义：

- gameplay 异常：失败 tick 不提交、不重试，runtime 永久 fatal；
- authority commit 异常：玩法 tick 已提交，runtime 进入 `AuthorityCommitFatalError`，不得重跑玩法；
- strict presentation export 异常：当前 presentation epoch 失效，不能跨 gap 继续；外层必须创建更高
  `scene_epoch/bootstrap_id` 并重新 Bootstrap。

## Ordered presentation session

`OrderedPresentationSession` 以 viewer、scene epoch、Bootstrap 和 profile 为作用域：

- Bootstrap 只打开一次；匹配 V2 `presentation.ready` 前不释放 frame；
- admission 原子包含零/多份连续 complete frame 与一份 correlation；
- session 校验 frame sequence/source tick、projection、frame SHA 和 opaque authority cursor；
- cumulative ACK 只有与已发送 frame/correlation/cursor 完全匹配时才归还 credit；
- pending + in-flight 同时受 frame、correlation、packet 与 byte hard limit 约束；
- ready deadline 与 active ACK deadline 独立；timeout/resync 使 generation 失效并要求新 Bootstrap。

每个 viewer 使用独立 session；慢客户端的 backpressure 不得改变 authority tick 或其他 viewer。
