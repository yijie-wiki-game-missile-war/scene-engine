# Scene Engine 0.7

Scene Engine 是 renderer-neutral 的 60 Hz fixed-step runtime。当前架构只有一条发布与显示链：

```text
EngineProgram
  -> scene-engine-wire@2
  -> SceneEngineClient 0.7
  -> DisplayRuntime 0.1
  -> ThreeRenderBackend 0.9
```

发布 tuple：

- Python `scene-engine==0.7.0`：规则事务、wire、Display authority records、session 与 recording；
- `@scene-engine/client@0.7.0`：唯一 wire/packet-log decoder、WorldState 指针和 Display session bridge；
- `@scene-engine/display@0.1.0`：唯一 Node、Transform、Component、Scene、Prefab、Resource 和 RAF owner；
- `@scene-engine/renderer-three@0.9.0`：只实现平面的 RenderBackend port，不拥有业务 Node 树或 RAF。

没有兼容 decoder、别名、双写、旧包重定向或 fallback renderer。

## 核心约束

- 权威时间只有整数 `source_tick`，固定为 60 tick/s；wall time 和 render callback 不推进玩法。
- 每个改变状态的事务逐条提交；每个 commit 都携带 World patch 和一个有序 Display command stream。
- checkpoint 携带完整 World snapshot、`scene_name`、catalog hashes、command cursor 和 parent-first `py/` baseline。
- Engine 分配全流唯一 `command_seq`；每条命令只有一个 authority node target。
- Client 在一个同步 barrier 内完成：decode/validate、World candidate、commit gate、Authority 调用和 cursor seal；成功后立即生成 ACK，不等待资源或 draw。
- DisplayRuntime 拥有唯一 NodeIndex、唯一 local Transform、Component scheduler、RenderSystem 和应用 RAF。
- Three 后端只有 `(nodeName, componentKey)` binding；不镜像 Node parent tree，也不返回 Three 对象。

## 验证与打包

```bash
uv run python -m pytest -q
npm ci
npm test
uv run python scripts/verify_cutover.py
uv run python scripts/benchmark_scene_500.py --quick
node --expose-gc js/packages/client/scripts/benchmark-500.mjs --quick
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
