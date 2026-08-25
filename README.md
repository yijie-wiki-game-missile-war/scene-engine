# Scene Engine 0.7

Scene Engine 是 renderer-neutral 的 60 Hz fixed-step runtime。当前只有一条生产发布与显示链：

```text
EngineProgram
  -> scene-engine-wire@2
  -> SceneEngineClient 0.8
  -> DisplayRuntime 0.2
  -> ThreeRenderBackend 0.9.1
```

发布 tuple：

- Python `scene-engine==0.7.0`：规则事务、wire、Display authority records、session 与 recording；
- `@scene-engine/client@0.8.0`：唯一 wire/packet-log decoder、WorldState 指针、同步 ACK barrier 和 Display session bridge；
- `@scene-engine/display@0.2.0`：唯一 Node、Transform、Component、Scene、Prefab、Resource 和 RAF owner；
- `@scene-engine/renderer-three@0.9.1`：只实现平面的 RenderBackend port，不拥有业务 Node 树或 RAF。

Wire、Display codec 和 packet-log 仍分别为 `scene-engine-wire@2`、`scene-engine-display-node@2` 和
`scene-engine-packet-log@2`。当前 tuple 没有兼容 decoder、别名、双写、旧包重定向或 fallback renderer。

## 核心约束

- 权威时间只有整数 `source_tick`，固定为 60 tick/s；wall time 和 render callback 不推进玩法。
- 每个改变状态的事务逐条提交；每个 commit 都携带 World patch 和一个有序 Display command stream。
- checkpoint 携带完整 World snapshot、`scene_name`、catalog hashes、command cursor 和 parent-first `py/` baseline。
- Engine 分配全流唯一 `command_seq`；每条命令只有一个 authority node target。
- Client 在同步 barrier 内完成校验、World candidate、Authority 调用和 cursor seal，然后以 O(1)
  `displaySummary` 生成累计 ACK。ACK 不等待完整 DisplayView、资源、HUD、observer、RAF 或 draw。
- `onCommit` 只携带 `displaySummary`，并在 ACK 已生成后排入 microtask；observer 失败不能阻塞或回滚 ACK。
- 完整 DisplayView 只由显式 `currentDisplayView()` 或 `capture()` 查询生成，不属于逐 commit 热路径。
- Display session 只有 `runtime`、`authorityPort`、`commitGate` 和 `dispose`；额外字段直接拒绝。
- DisplayRuntime 拥有唯一 NodeIndex、唯一 local Transform、Component scheduler、RenderSystem 和应用 RAF。
- Component property 更新只经 ComponentRegistry；normalize 与 Resource id/kind 校验全部成功后才原子替换。
- Runtime dispose 停止调度并释放 Scene、Node、Component、Prefab scope、resource lease 和 backend 强引用。
- Three 后端的一个 `(nodeName, componentKey)` binding 在 ordinary object 与 batch instance 之间只能有一种可绘制表示。

## 浏览器产品面

浏览器只保留生产 Live/Replay 页面和 Arts 的只读 Showcase。Showcase 直接复用正式 Scene、Prefab、Resource、
registries、DisplayRuntime、RenderSystem 与 Three backend；它不创建 Client、WebSocket 或 ACK，也不提供节点选择、
修改、保存或导出。Showcase catalog、Camera preset 与 UI kit 的产品细节由 Arts current 文档定义。

## 验证与打包

```bash
uv run python -m pytest -q
npm ci
npm test
uv run python scripts/verify_cutover.py
uv run python scripts/benchmark_scene_500.py --quick
node --expose-gc scripts/benchmark_client_ack_500.mjs --quick
node --expose-gc scripts/benchmark_display_runtime_500.mjs --quick
npm pack --workspace @scene-engine/client --pack-destination dist
npm pack --workspace @scene-engine/display --pack-destination dist
npm pack --workspace @scene-engine/renderer-three --pack-destination dist
```

Python 需要 `>=3.10`；Node 需要 `^20.19.0 || >=22.12.0`。

## 当前合同

- [架构](docs/architecture.md)
- [Runtime 与 60 Hz](docs/runtime.md)
- [Display Node/Component](docs/display.md)
- [Wire v2](docs/wire.md)
- [JavaScript client](docs/client.md)
- [Three backend](docs/render-runtime.md)
- [Recording 与 Replay](docs/recording-replay.md)
- [Transform](docs/transform.md)
- [切换报告](docs/cutover-report.md)
