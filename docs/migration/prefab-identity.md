# Scene Engine Prefab 身份合同修正

## 结论

当前实现把“Prefab 的注册身份”和“它对应的游戏逻辑类型”混成了一个键，必须拆开。

正确的三层身份是：

```text
Node name / entity id   = 场景中某一次实例的唯一身份
PrefabDefinition.id     = 可复用显示预制体定义的唯一注册身份
Prefab gameplayType     = 预制体所表现的游戏逻辑类型；允许重复
```

例如两个不同的飞机显示预制体可以消费同一个飞机 authority state：

```js
const fighterPrefab = definePrefab({
  id: 'missile-war/flight/aircraft/fighter-a',
  gameplayType: 'flight.aircraft',
  revision: 2,
  root: { /* ... */ },
  resolveState(state) { /* ... */ },
});

const bomberPrefab = definePrefab({
  id: 'missile-war/flight/aircraft/bomber-a',
  gameplayType: 'flight.aircraft',
  revision: 1,
  root: { /* ... */ },
  resolveState(state) { /* ... */ },
});
```

这两个定义的 `gameplayType` 相同，但 `id` 不同，因此可以同时注册、分别实例化，也可以在保留同一个 authority Node 身份的情况下进行 Prefab 替换。

## 当前实现的问题

本次交付中 `PrefabDefinition` 已经要求 `id`，但 `PrefabRegistry` 没有用它作为主键：

```text
scene-engine/js/packages/display/src/resource/registries.js
```

当前注册接口是：

```js
register({ sceneProfile, logicalType, definition })
```

并以以下内容作为唯一键：

```js
`${sceneProfile}\u0000${logicalType}`
```

因此当前行为是：

- 同一个 Scene Profile 中，两个 Prefab 不能使用同一个逻辑类型；
- `PrefabDefinition.id` 只是 descriptor 字段，没有承担注册和查找身份；
- Authority 命令、静态 Scene Prefab 实例和 Showcase 都用 `prefabType` 查找具体定义；
- `arts/web3d/src/catalog/missileWarCatalog.js` 建立单值 `PREFAB_BY_LOGICAL_TYPE`，并强制逻辑类型唯一。

这与目标语义相反，应新增为正式上线前的 P1 问题。

## 目标合同

### 1. PrefabDefinition

推荐一次性把含义不清的 `logicalType` 改名为 `gameplayType`：

```js
{
  schema: 'scene-engine-prefab-definition@2',
  id: 'missile-war/flight/aircraft/fighter-a',
  revision: 2,
  gameplayType: 'flight.aircraft',
  root: { /* ... */ },
  resolveState(state, context) { /* ... */ },
}
```

规则：

- `id` 在一个 Prefab catalog 内必须唯一，是注册、查找、实例化、替换和 catalog hash 的主身份；
- `gameplayType` 不唯一，只说明该 Prefab 消费哪一类完整 authority state；
- 同一个 `gameplayType` 下的所有 Prefab 应遵守同一份 authority-state schema；各 resolver 可以忽略字段，但不能要求该 schema 之外的私有 authority 字段；
- `revision` 与 `id` 分离。内容或结构发生不兼容变化时提高 revision，不要依靠在 id 后附加版本号来代替 revision；
- Prefab `id` 不是 Node 实例 id，也不是模型 URL、包路径或资源文件名。

### 2. PrefabRegistry

Registry 应直接接受 Definition，并只按 `definition.id` 建主索引：

```js
const prefabRegistry = createPrefabRegistry([
  fighterPrefab,
  bomberPrefab,
]);

prefabRegistry.require('missile-war/flight/aircraft/fighter-a');
prefabRegistry.require('missile-war/flight/aircraft/bomber-a');
```

最小接口：

```js
register(definition)
get(prefabId)
require(prefabId)
seal()
```

行为：

- 重复 `prefabId` 必须在 `register()` 时失败；
- 重复 `gameplayType` 必须允许；
- Runtime 不按 `gameplayType` 自动猜测具体 Prefab；
- 如编辑器或诊断确实需要，可维护 `gameplayType -> prefabId[]` 的只读次级索引，但它不参与正式实例化路径，也不能产生隐式默认 Prefab；
- `sceneProfile` 可以继续作为 Scene 和 resolver context，但不再参与 Prefab 注册主键。需要不同显示实现时使用不同 Prefab id。

### 3. Authority 与静态 Scene 使用精确 prefabId

正式命令必须指定精确的注册 ID：

```js
runtime.authority.createNode({
  name: 'py/aircraft/42',
  parentName: null,
  prefabId: 'missile-war/flight/aircraft/fighter-a',
  transformMode: 'live',
  transform,
  visible: true,
  state,
});

runtime.authority.replaceNodePrefab({
  name: 'py/aircraft/42',
  prefabId: 'missile-war/flight/aircraft/bomber-a',
  state,
});
```

静态 SceneDefinition 的 `prefabInstances` 同样使用 `prefabId`。

不要在命令中同时发送 `prefabId` 和 `gameplayType`。后者可以从已注册 Definition 唯一得到，同时发送会形成两个可能不一致的权威字段。

Python 游戏核心不需要保存美术资源信息。精确 `prefabId` 由 `python-game/adapters/scene_projection.py` 这一显示投影边界根据游戏状态和正式显示合同选择；核心 World 仍然不包含模型、材质、URL 或 Prefab-local 路径。

### 4. 字段与合同一次性迁移

建议不保留兼容别名，统一改名：

```text
Python / JSON: prefab_type -> prefab_id
JavaScript:    prefabType  -> prefabId
Definition:    logicalType -> gameplayType
```

这是 wire 中 Display attachment 的破坏性字段变化，应同步提升相应 Display schema 版本、fixtures 和包版本；不要同时接受旧字段与新字段。

## 最小代码修改范围

### Scene Engine Python

- `scene-engine/src/scene_engine/display.py`
  - `DisplayNode.prefab_type` 改为 `prefab_id`；
  - `DisplayCommand.replace_prefab(..., prefab_id, state)`；
  - checkpoint/command JSON 字段改为 `prefab_id`；
  - validator、错误码和 schema 常量同步更新。
- `scene-engine/scripts/generate_fixtures.py`
- `scene-engine/fixtures/display-v2/` 或新版本 fixture 目录
- Python tests、benchmarks 和协议文档。

### Scene Engine JavaScript Client

- `scene-engine/js/packages/client/src/display.js`
  - 解析 `prefab_id`，输出 `prefabId`；
  - 更新 exact-field sets、验证器和错误码。
- `scene-engine/js/packages/client/src/index.js`
  - 将 `prefabId` 传入 AuthorityPort。
- client tests、fixtures 和 benchmarks。

### Display package

- `scene-engine/js/packages/display/src/resource/prefab-definition.js`
  - `logicalType` 改为非唯一的 `gameplayType`；
  - 编译结果保留 `id` 与 `gameplayType`。
- `scene-engine/js/packages/display/src/resource/registries.js`
  - `PrefabRegistry` 改为按 `definition.id` 注册；
  - 删除 `(sceneProfile, logicalType)` 主键和逻辑类型重复错误。
- `scene-engine/js/packages/display/src/runtime/authority-port.js`
  - `createNode`、`replaceNodePrefab` 和 `_resolvePrefab` 使用 `prefabId`。
- `scene-engine/js/packages/display/src/component/authority-component.js`
  - 保存 `prefabId`；`gameplayType` 如需展示应从当前 compiled Definition 派生，不建立第二个可变权威副本。
- `scene-engine/js/packages/display/src/resource/scene-definition.js`
  - 静态实例使用 `prefabId`。
- tests、benchmarks、leak verification 和 docs。

### Missile War product / Arts

- `python-game/adapters/scene_projection.py`
  - Projection record 和 diff 改为 `prefab_id`；
  - 显式映射到正式 Prefab ID。
- `arts/web3d/src/catalog/missileWarCatalog.js`
  - 改为 `PREFAB_BY_ID`；
  - 唯一性只检查 `definition.id`；
  - 删除 logical/gameplay type 唯一约束；
  - manifest 使用 `prefabIds`，另可列出去重后的 `gameplayTypes`。
- Showcase 和 Scene files 使用 `prefabId`。
- 所有 Arts owner 的 Definition 更新为 `gameplayType`。

## Catalog identity

`prefabCatalogHash` 至少应包含按 `id` 排序后的：

```text
Prefab id
Prefab revision
Prefab gameplayType
Prefab Node/Component descriptor
引用的 Resource id/revision/content hash
相关 Component type/schema
```

`stateSchemaHash` 应按 `gameplayType -> authority state schema identity` 计算。同一 gameplayType 新增第二个纯视觉 Prefab 时：

- `prefabCatalogHash` 会变化；
- authority-state schema 未改变时，`stateSchemaHash` 不应因为多了一个视觉实现而改变。

## 必须新增的测试

1. 两个不同 `id`、相同 `gameplayType` 的 Prefab 可以同时注册。
2. 两个相同 `id`、任意 `gameplayType` 的 Prefab 在第二次注册时失败，且 Registry 无部分写入。
3. `require(prefabId)` 精确返回对应 Definition。
4. Authority 可以创建两个相同 gameplayType、不同 prefabId 的 Node。
5. `replaceNodePrefab` 可以在相同 gameplayType 的两个 Prefab ID 之间原子替换。
6. 未注册 prefabId 在任何 Node/Component live mutation 前失败。
7. Scene static Prefab instance 按 prefabId 编译。
8. Catalog 允许 gameplayType 重复，拒绝 prefabId 重复。
9. Fixture 和跨语言测试只接受 `prefab_id`，明确拒绝旧 `prefab_type`。
10. 500 节点 benchmark 不增加按 gameplayType 扫描；正式热路径仍是 O(1) prefabId lookup。

## 对上一版审核与 Skill 的修正

上一版中以下表述不准确：

```text
A PrefabDefinition is ... selected by a logical type.
```

应替换为：

```text
A PrefabDefinition is registered and addressed by its unique prefab id.
Its gameplay type is a non-unique compatibility/state-contract classification.
```

上一版提出的三个 P1——Definition 公开坏实例化入口、ResourceRegistry 接受非资产 Definition、catalog hash 不是实际内容 hash——仍然成立；本文件所述的“Prefab id 与 gameplayType 混用”应作为新增且优先级更高的 P1 一并处理。
