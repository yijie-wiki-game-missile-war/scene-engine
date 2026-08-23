# Scene Engine 0.6

Scene Engine 是 renderer-neutral 的 60 Hz fixed-step runtime。`0.6.0` 只有一条状态链：一次已改变的
world transaction 产生一个 `scene-engine-wire@1` commit；checkpoint、WorldState、complete scene tree、
events、ACK 与 packet log 共用同一 stream/commit cursor。

当前发布物只有：

- Python `scene-engine==0.6.0`：runtime、wire、JSON tree、scene body、session、recording；
- JavaScript `@scene-engine/client@0.6.0`：统一 decoder、atomic WorldState/tree client、packet-log reader；
- JavaScript `@scene-engine/renderer-three@0.6.0`：只消费 client 的 `{plan, view}`。

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

## 验证与打包

```bash
python3 -m pytest -q
python3 -m compileall -q src tests
npm install --ignore-scripts
npm test
python3 scripts/verify_cutover.py
python3 scripts/benchmark_scene_500.py --quick
node --expose-gc js/packages/client/scripts/benchmark-500.mjs --quick
npm pack --workspace @scene-engine/client --pack-destination dist
npm pack --workspace @scene-engine/renderer-three --pack-destination dist
```

Python 需要 `>=3.10`；仓库当前验证使用 Python 3.12+ 与 Node 20.19+/22.12+。

## 当前合同

- [架构](docs/architecture.md)
- [Runtime 与 60 Hz](docs/runtime.md)
- [Wire v1](docs/wire.md)
- [JavaScript client](docs/client.md)
- [Recording 与 Replay](docs/recording-replay.md)
- [Transform](docs/transform.md)
- [切换报告](docs/cutover-report.md)
