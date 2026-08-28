# Scene Engine 0.9

Scene Engine 是一个面向**服务端权威游戏**的确定性世界发布、浏览器同步与 3D 显示投影运行时。玩法状态和规则留在
Python；引擎把每次已提交事务发布为 World patch 与逻辑 Display command；JavaScript Client 原子应用并累计 ACK；
DisplayRuntime 维护唯一节点树；Three backend 只管理渲染资源与绘制。

它是 **renderer-isolated**，不是试图统一所有渲染器的通用游戏引擎：产品和美术壳不直接接触 Three.js，但当前
Display API 明确面向浏览器显示环境。

```text
Python authoritative World（固定 60 Hz）
  -> scene-engine-wire@2 checkpoint / commit
  -> @scene-engine/client 原子同步、WorldState、ACK
  -> @scene-engine/display 唯一 Node/Transform/Component/RAF
  -> @scene-engine/renderer-three GPU 资源、binding、draw
```

## 它负责什么

| Scene Engine 负责 | 产品或宿主负责 |
|---|---|
| 固定步进、事务、checkpoint、commit、session 与 recording | 玩法规则、物理与可变 World 数据结构 |
| 精确 wire、Client WorldState、累计 ACK 与 Replay 同路复用 | HTTP/WebSocket 框架、连接轮询与进程生命周期 |
| Scene/Prefab/Resource/Component 合同和唯一 Display 节点树 | 游戏 Scene/Prefab、资产、状态 schema、UI 与视觉设计 |
| Three.js 隔离、资源生命周期、binding、pick、capture 与 draw | 编辑器、资产生产、产品控制器和平台级界面 |

不存在第二套 World、节点树、Transform、RAF、ACK cursor、packet decoder 或兼容旧合同的 fallback。

## 最小接入

### Python：发布权威事务

合同帧率固定为 60 Hz；代码仍通过变量传递该值，避免在计算和上下文中散落字面量。`RuntimeConfig` 只接受
`TICKS_PER_SECOND`，当前等于 60。

```python
import json
from scene_engine import (
    DisplayCatalogIdentity,
    DisplayCommand,
    MutationResult,
    ProductCheckpoint,
    RuntimeConfig,
    SceneEngineRuntime,
    TICKS_PER_SECOND,
)

catalog = DisplayCatalogIdentity.from_record(
    json.loads(open("display-catalog-identity.json", encoding="utf-8").read())
)

# EngineProgram.build_checkpoint 中把同一构建产物身份写入 checkpoint：
checkpoint = ProductCheckpoint(
    world_codec="product-world@1",
    world_snapshot=world_snapshot,
    scene_name="main",
    display_catalog=catalog,
    display_nodes=display_nodes,
)

runtime = SceneEngineRuntime(
    world=world,
    program=program,
    transport=transport,
    recorder=recorder,
    config=RuntimeConfig(ticks_per_second=TICKS_PER_SECOND),
)

# EngineProgram.step / handle_input 中：
mutation = MutationResult.changed(commit_context={"changed_units": [42]})

# EngineProgram.build_commit 中只使用命名构造器：
command = DisplayCommand.set_state("py/unit/42", {"animation": "walk"})
```

`EngineProgram` 的六个回调、完整 checkpoint/commit 结构和事务顺序见
[Runtime 与 60 Hz](docs/runtime.md)。

### JavaScript：构建目录并创建投影

```js
import { SceneEngineClient } from '@scene-engine/client';
import {
  buildDisplayCatalogManifest,
  computeDisplayCatalogIdentity,
  createDisplayRuntime,
  toDisplayCatalogIdentityRecord,
} from '@scene-engine/display';
import { createThreeRenderBackend } from '@scene-engine/renderer-three';

const authorityStateSchemas = [
  { gameplayType: 'unit.basic', schemaId: 'unit.basic.state', revision: 1 },
];

const manifest = buildDisplayCatalogManifest({
  sceneRegistry,
  prefabRegistry,
  resourceRegistry,
  componentRegistry,
  authorityStateSchemas,
});
const catalogIdentityRecord = toDisplayCatalogIdentityRecord(
  computeDisplayCatalogIdentity(manifest),
); // 构建时写入 display-catalog-identity.json，供 Python 原样加载。

function createProductDisplaySession() {
  const runtime = createDisplayRuntime({
    hostElement,
    canvas,
    sceneRegistry,
    prefabRegistry,
    resourceRegistry,
    componentRegistry,
    authorityStateSchemas,
    createRenderBackend: createThreeRenderBackend,
  });
  return {
    runtime,
    authorityPort: runtime.authority,
    commitGate: runtime.commitGate,
    dispose: () => runtime.dispose(),
    debugName: 'main-projection', // Client 只提取上面四项，包装字段可保留在调用侧。
  };
}

const client = new SceneEngineClient({
  createDisplaySession: createProductDisplaySession,
  onCommit({ worldState, commit, displaySummary }) {
    updateHud(worldState, commit, displaySummary);
  },
});
```

## 必须保持的合同

- **时间固定，代码可变量化**：权威率严格为 `60 tick/s`；`ticks_per_second` 用于传值和计算，不是可选帧率。
- **Python 权威**：Python 决定每个 `py/` 根节点的存在、父级、Transform、可见性、精确 `prefabId` 和完整状态。
- **提交门禁**：checkpoint 初始化可在激活前装载节点；激活后所有 Authority 修改必须位于同一个
  `commitGate.begin -> apply -> seal` 内，门外修改直接失败。
- **目录身份真实可重建**：Scene、Prefab/Resource/Component、authority-state schema 分域生成 SHA-256；Client 在
  `installScene` 前比较本地身份与 checkpoint，任何不匹配都拒绝 session。
- **校验先于 ACK**：内建 model/material/animation/sprite/surface/particle/light/camera 状态在 Display 侧完整
  normalize 后才改变节点；非法嵌套字段不能拖到下一次 RAF 才报错。
- **Behaviour 只拿窄能力**：组件只能读取冻结的 NodeView 和 Display 查询面；不能接触 NodeIndex、NodeGraph、
  Authority、RenderSystem，也不能修改 Python 权威根节点。
- **ACK 语义有限且明确**：ACK 表示 World candidate、全部 Display commands 与 cursor 已同步通过提交屏障；它不等
  资源加载、HUD、observer、RAF 或 draw。
- **静态与动态分离**：Scene、Prefab、Resource、Component 定义在 runtime 构造前注册；逐事务只传 World patch 和
  单目标 Display command。

## 当前发布组合

| 层 | 版本 / schema |
|---|---|
| Python | `scene-engine==0.9.0` |
| Client | `@scene-engine/client@0.10.0` |
| Display | `@scene-engine/display@0.4.0` |
| Three backend | `@scene-engine/renderer-three@0.9.3` |
| Wire | `scene-engine-wire@2` |
| Display codec | `scene-engine-display-node@3` |
| Packet log | `scene-engine-packet-log@2` |
| Catalog manifest | `scene-engine-display-catalog-manifest@1` |

JavaScript 三个包都随包发布 `src/index.d.ts`。当前 tuple 不提供旧 decoder、别名、双写、旧包重定向或 fallback
renderer。

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

- [架构与所有权](docs/architecture.md)
- [Runtime 与 60 Hz](docs/runtime.md)
- [Display Node、Prefab、Component 与目录身份](docs/display.md)
- [Wire v2](docs/wire.md)
- [JavaScript Client](docs/client.md)
- [Three backend](docs/render-runtime.md)
- [Recording 与 Replay](docs/recording-replay.md)
- [Transform](docs/transform.md)
- [Agent 使用说明](.agents/skills/scene-engine/SKILL.md)

迁移方案、旧审计、旧发布验收和 0.9.2 renderer patch 属于历史资料，分别位于 `docs/migration/`、`docs/reviews/`、
`docs/cutover-report.md`、`docs/evidence/` 和 `docs/renderer-three-0.9.2-patch.md`，不作为当前 API 事实。
