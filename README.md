# Scene Engine 0.6

Scene Engine 是 renderer-neutral 的 60 Hz fixed-step runtime。`0.6` 只有一条状态链：一次已改变的
world transaction 产生一个 `scene-engine-wire@1` commit；checkpoint、WorldState、complete scene tree、
events、ACK 与 packet log 共用同一 stream/commit cursor。

当前发布物只有：

- Python `scene-engine==0.6.1`：runtime、wire、JSON tree、scene body、session、recording；
- JavaScript `@scene-engine/client@0.6.0`：统一 decoder、atomic WorldState/tree client、packet-log reader；
- JavaScript `@scene-engine/renderer-three@0.8.0`：完整、不可透传 Three 对象的 Render Runtime，
  消费 client 的 `{plan, view}` 与产品纯数据 render composition。runtime、resource catalog、composition、
  snapshot、batch schema 都是 `@2`；固定管线只有 `model@2`、`sprite@2`、`surface@2`、
  `particle@2`、`scene-pass@2`。没有旧合同解析或 alias。

产品通过 `EngineProgram` 端口提供计数器读写、tick/input mutation、checkpoint 与 commit body。产品提交
`SceneNode`/`SceneEvent` records；Engine 用缓存的 bootstrap view 验证并只编码一次 complete frame。Engine 不解释
玩法字段、HTTP、WebSocket 框架、资产或产品 visual catalog。构造后 mutable world 只能在 EngineProgram callback
期间借用；没有公共 world getter。

## 时间与提交

- 唯一规则频率为 `60 tick/s`；wall clock 只决定应按顺序补多少整数 tick。
- 每个 tick 必须逐个提交，不能跳过或合并；tick commit 必带 complete scene frame。
- changed input 在同 tick 增加 world revision 与 commit sequence；视觉确无变化时可省略 frame。
- rejected/no-op input 不改变 tick、revision 或 commit cursor。
- renderer、observer 和 draw 不推进规则时间，也不参与同步 barrier。

## 渲染边界

Renderer 0.8 唯一拥有 Three.js、WebGLRenderer、Scene、PerspectiveCamera、pan/zoom controls、资源缓存、
ResizeObserver 和 render RAF。产品只提供 immutable resource catalog 与同步纯数据 composition；Runtime 在
任何投影 mutation 前按 node/scene scope 全量校验。它不创建默认灯光或 RenderTarget；背景和灯光只能由
`scene-pass@2` 的 scene layers 明确声明。

投影异常发生在客户端原子 install/ACK barrier 之后，不会回滚 WorldState 或 scene tree。错误通过
`onHealth` 报告；恢复只能用当前 `view` 和重新编译的完整 snapshot 执行 `rebuild()`。其中
`render-draw-failed` 会让 Runtime 在恢复时清空旧投影和资源、销毁 owned WebGLRenderer，并在同一 canvas 按原
profile/size 重建 renderer 后安装最新 snapshot；其他 health failure 不替换 renderer。完整规范见
[Three Render Runtime V2](docs/render-runtime.md)。

## 验证与打包

```bash
uv run python -m pytest -q
uv run python -m compileall -q src tests
npm ci
npm test --workspace @scene-engine/renderer-three
npm test
uv run python scripts/verify_cutover.py
uv run python scripts/benchmark_scene_500.py --quick
node --expose-gc js/packages/client/scripts/benchmark-500.mjs --quick
npm pack --workspace @scene-engine/client --pack-destination dist
npm pack --workspace @scene-engine/renderer-three --pack-destination dist
```

Python 需要 `>=3.10`；仓库当前验证使用 `uv` 锁定的 Python 3.12+ 与 Node
20.19+/22.12+。若已激活符合版本的环境，上述 `uv run python` 可等价替换为该环境的
`python`。

## 当前合同

- [架构](docs/architecture.md)
- [Runtime 与 60 Hz](docs/runtime.md)
- [Wire v1](docs/wire.md)
- [JavaScript client](docs/client.md)
- [Three Render Runtime](docs/render-runtime.md)
- [Recording 与 Replay](docs/recording-replay.md)
- [Transform](docs/transform.md)
- [切换报告](docs/cutover-report.md)
