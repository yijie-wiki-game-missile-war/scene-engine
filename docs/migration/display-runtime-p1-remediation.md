# Scene Engine Display P1 收口执行说明

## 1. 目标

一次性修复 2026-08-25 审核确认的四个 P1，并让仓库中的源码、跨语言协议、fixtures、测试、文档和 Agent Skill
重新一致：

1. Prefab 注册身份错误：当前按 `(sceneProfile, logicalType)` 注册，导致同一个游戏逻辑类型不能有多个 Prefab。
2. Definition 暴露了错误或多余的实例化入口：`PrefabDefinition.instantiate()` 运行时必然报错，
   `SceneDefinition.instantiate()` 又形成第二条 Scene 安装路径。
3. `ResourceRegistry` 接受 `SceneDefinition`/`PrefabDefinition` 等非资产对象，注册边界没有封闭校验。
4. 三组 catalog hash 只是固定版本字符串的 SHA-256，不是实际 Scene/Prefab/Resource/state 合同内容的身份。

这是破坏性迁移，不兼容旧合同。不要添加适配层、双字段、旧注册键、fallback decoder 或第二套 catalog。

## 2. 迁移后的唯一身份模型

必须固定为三层身份：

```text
Node name / entity id   = 某一次运行实例的唯一身份，例如 py/aircraft/42
PrefabDefinition.id     = 可复用显示定义的唯一注册身份
Prefab gameplayType     = 所消费的游戏逻辑状态类型；允许多个 Prefab 共用
```

例如：

```js
const fighter = definePrefab({
  schema: 'scene-engine-prefab-definition@2',
  id: 'missile-war/flight/aircraft/fighter-a',
  revision: 2,
  gameplayType: 'flight.aircraft',
  root: { /* ... */ },
  resolveState(state) { /* ... */ },
});

const bomber = definePrefab({
  schema: 'scene-engine-prefab-definition@2',
  id: 'missile-war/flight/aircraft/bomber-a',
  revision: 1,
  gameplayType: 'flight.aircraft',
  root: { /* ... */ },
  resolveState(state) { /* ... */ },
});
```

两个定义可以同时注册。运行时必须明确发送 `prefabId`，不得根据 `gameplayType` 猜测具体 Prefab。

## 3. P1-A：Prefab 注册身份与游戏逻辑类型分离

### 3.1 Display package

修改：

```text
js/packages/display/src/resource/prefab-definition.js
js/packages/display/src/resource/registries.js
js/packages/display/src/resource/scene-definition.js
js/packages/display/src/runtime/authority-port.js
js/packages/display/src/component/authority-component.js
js/packages/display/test/
```

要求：

- `PREFAB_DEFINITION_SCHEMA` 从 `scene-engine-prefab-definition@1` 提升到 `@2`。
- `PrefabDefinition.logicalType` 改为 `gameplayType`。
- `PrefabDefinition.id` 是唯一主键；`gameplayType` 不唯一。
- `compile()` 的结果显式保留 `id`/`prefabId` 和 `gameplayType`，不要只保留逻辑类型。
- `PrefabRegistry.register(definition)` 直接接受 `PrefabDefinition`。
- Registry 的主 Map 只按 `definition.id` 建索引。
- 最小公开接口保持：`register(definition)`、`get(prefabId)`、`require(prefabId)`、`seal()`。
- 删除 `(sceneProfile, logicalType)` 注册键和 `display-prefab-type-duplicate` 逻辑。
- 如诊断或编辑器确实需要，可以建立只读 `gameplayType -> prefabId[]` 次级索引；它不能参与生产实例化，
  也不能隐式选默认 Prefab。
- `SceneDefinition.prefabInstances` 的字段从 `prefabType` 改为 `prefabId`，通过
  `prefabRegistry.require(prefabId)` 精确编译。
- `AuthorityPort.createNode()` 和 `replaceNodePrefab()` 接收 `prefabId`。
- `AuthorityComponent` 保存 `prefabId`；`gameplayType` 从当前 Definition 派生，不建立第二份可变权威状态。
- `sceneProfile` 继续作为 Scene/Resolver context 即可，不再参与 Prefab 注册身份。

目标接口：

```js
const prefabRegistry = createPrefabRegistry([fighter, bomber]);

runtime.authority.createNode({
  name: 'py/aircraft/42',
  parentName: null,
  prefabId: fighter.id,
  transformMode: 'live',
  transform,
  visible: true,
  state,
});

runtime.authority.replaceNodePrefab({
  name: 'py/aircraft/42',
  prefabId: bomber.id,
  state,
});
```

### 3.2 Python Display contract

修改：

```text
src/scene_engine/display.py
scripts/generate_fixtures.py
fixtures/
tests/test_display.py
tests/test_display_benchmark.py
docs/display.md
docs/wire.md
```

要求：

- `DisplayNode.prefab_type` 改为 `prefab_id`。
- `DisplayCommand.replace_prefab(..., prefab_id, state)`。
- JSON 精确字段从 `prefab_type` 改为 `prefab_id`。
- `MAXIMUM_PREFAB_TYPE_BYTES` 改为 `MAXIMUM_PREFAB_ID_BYTES`。
- 两端使用同一份 Prefab ID 字符语法和 192-byte 上限。若采用 `/` 分层 ID，Python 和 JavaScript 必须同时允许；
  不要一端允许、一端拒绝。
- 由于 exact-field contract 变化，将以下 Display schema 从 `@2` 提升到 `@3`：

```text
scene-engine-display-node
scene-engine-display-checkpoint
scene-engine-display-command-stream
scene-engine-node-command
```

- 外层 `scene-engine-wire@2` 只有在 packet framing 和 section 编码不变时才可保留；不要因为字段改名无理由重做
  整个 wire envelope，但 fixture 必须全部重生成。
- 明确拒绝旧字段 `prefab_type`，不做别名兼容。

### 3.3 JavaScript client

修改：

```text
js/packages/client/src/display.js
js/packages/client/src/index.js
js/packages/client/test/
```

要求：

- wire 读取 `prefab_id`，客户端对象输出 `prefabId`。
- exact-key validator 明确拒绝 `prefab_type`。
- checkpoint 和 command 两条路径都向 `AuthorityPort` 传精确 `prefabId`。
- ACK 边界不变；不要让 Prefab/资源加载进入 ACK 等待范围。

### 3.4 产品投影与 Arts

跨仓库同步修改：

```text
python-game/adapters/scene_projection.py
arts/web3d/src/catalog/missileWarCatalog.js
arts/web3d/src/showcase/
arts/web3d/scenes/
arts/code/**/prefab.js 或 index.js
arts/code/**/package.json
相关 tests、architecture checker 和 docs
```

要求：

- Python 游戏核心仍不持有模型、材质、URL 或 Prefab-local 节点。
- `scene_projection.py` 在显示投影边界把游戏实体映射到精确 `prefab_id`。
- Arts catalog 改为 `PREFAB_BY_ID`；唯一性只检查 `definition.id`。
- package metadata 中 `logicalType` 改为 `prefabId` + `gameplayType`，或只保留确实被工具使用的字段。
- Showcase、静态 Scene 和测试使用 `prefabId`。
- 删除 `get...PrefabDefinition(logicalType)` 这类单值查找；正式路径只能按 ID 获取。

### 3.5 必须通过的身份测试

1. 两个不同 `id`、相同 `gameplayType` 的 Prefab 可以同时注册。
2. 两个相同 `id` 的 Prefab 在第二次注册时失败，Registry 无部分写入。
3. `require(prefabId)` O(1) 精确返回对应 Definition。
4. Scene 静态实例通过 `prefabId` 编译。
5. Authority 可以创建相同 gameplayType、不同 prefabId 的节点。
6. `replaceNodePrefab` 可在两个相同 gameplayType 的 Prefab 之间原子替换，并保留 authority Node name、父子关系、
   Transform mode 和子 authority 节点。
7. 未注册 ID 在第一次 live mutation 前失败。
8. Python/JS fixture 只接受 `prefab_id`/`prefabId`，旧字段必须失败。
9. 500 节点热路径不扫描 gameplayType，仍为 O(1) Prefab lookup。

## 4. P1-B：删除 Definition 的伪实例化 API

当前问题：

```text
PrefabDefinition.instantiate()
  -> scope.instantiator.instantiateCompiled(...)
  -> 仓库中不存在 instantiateCompiled()
```

同时 `SceneDefinition.instantiate(scene)` 绕开公开的 `runtime.installScene()`，形成第二条生命周期路径。

修改：

```text
js/packages/display/src/resource/prefab-definition.js
js/packages/display/src/resource/scene-definition.js
js/packages/display/src/resource/registries.js
js/packages/display/src/runtime/prefab-instantiator.js
js/packages/display/test/
```

要求：

- 删除 `PrefabDefinition.instantiate()`。
- 删除 `SceneDefinition.instantiate()`。
- 从 `assertFinalDefinition()` 的 final method 列表删除 `instantiate`。
- 删除无调用的 `PrefabInstantiator.prepareSceneInstance()`。
- 保留 SceneLoader 当前的单一路径：静态 Scene Prefab root 已由 SceneLoader 创建，然后调用
  `prepareExistingRoot()`。
- 保留 AuthorityPort 当前的单一路径：authority root 由 AuthorityPort 创建，再调用 `prepareExistingRoot()`。
- 不要补 `instantiateCompiled()`，不要新增 Definition factory façade。

公开生命周期必须只有：

```text
Scene install/uninstall        -> DisplayRuntime / SceneLoader
Authority create/replace/remove -> AuthorityPort / package-private PrefabInstantiator
Definition                     -> declaration + compile + resolve/validate only
```

新增测试：

- `instantiate` 不属于 `SceneDefinition`/`PrefabDefinition` 的公开合同。
- Scene 只能通过 `runtime.installScene({ sceneName })` 安装。
- Authority Prefab 只能通过 `createNode`/`replaceNodePrefab` 进入运行时。
- 删除方法后，没有未引用的 `instantiateCompiled`、`prepareSceneInstance` 或第二条安装路径。

## 5. P1-C：ResourceRegistry 只接受资产 descriptor

当前 `ResourceRegistry.register()` 对任意 `Resource` 子类直接 `describe()`，导致 `SceneDefinition` 和
`PrefabDefinition` 可以进入资产 Registry。

修改：

```text
js/packages/display/src/resource/resource-registry.js
js/packages/display/test/definitions.test.mjs
```

采用最小方案：

```js
register(value) {
  if (this._sealed) fail('display-registry-sealed');
  const descriptor = normalizeDescriptor(value); // 永远校验 kind 与 shape
  const id = descriptor.id;
  if (this._resources.has(id)) fail('display-resource-id-duplicate');
  const resource = new Resource({
    id,
    schema: descriptor.schema ?? `scene-engine-${descriptor.kind}-resource@1`,
    revision: descriptor.revision ?? 0,
    descriptor,
  });
  Object.freeze(resource);
  this._resources.set(id, resource);
  return resource;
}
```

要求：

- 删除 `value instanceof Resource ? ... : ...` 分支。
- `register()` 始终经过 `normalizeDescriptor()`。
- 不接受任意预构造 `Resource`、`SceneDefinition` 或 `PrefabDefinition`。
- 当前仓库没有公开的 `Resource` 构造 API 需求，不要为未来假设增加 `AssetResource` 层。
- 若未来确有预构造资产需求，另行设计包内 brand；本轮不添加。

新增测试：

- 注册 `SceneDefinition` 立即失败。
- 注册 `PrefabDefinition` 立即失败。
- 缺少 `kind`、未知 `kind`、shape 字段错误立即失败。
- 每次失败后 `size`、`values()` 和 `snapshot()` 均无部分写入。
- 普通 model/mesh/texture/material 等 descriptor 行为保持不变。

## 6. P1-D：Catalog hash 必须由真实合同内容生成

当前三组 hash 只是以下固定字符串的 SHA-256：

```text
missile-war-scene-catalog@display-1
missile-war-prefab-catalog@display-1
missile-war-authority-state@display-1
```

这不能发现 Prefab、Scene、Resource、Component 或 authority state schema 的实际变化。

### 6.1 不增加运行时服务

只增加产品构建期工具和一个 canonical manifest，不引入 catalog server、运行时协商层或动态 fallback。

推荐产物：

```text
arts/web3d/src/catalog/display-catalog.identity.generated.json
python-game/adapters/display_catalog_identity_generated.py
```

两份产物必须来自同一次 canonical input，禁止人工复制三组 hash。

### 6.2 Canonical input

至少包含：

```json
{
  "schema": "missile-war-display-catalog-identity-input@1",
  "scenes": [],
  "prefabs": [],
  "resources": [],
  "components": [],
  "authorityStateSchemas": []
}
```

生成规则：

- 顶层集合按稳定主键排序：Scene 按 `id`，Prefab 按 `id`，Resource 按 `id`，Component 按 `typeId`，
  state schema 按 `gameplayType`。
- 对象 key 递归字典序排列；数组内部如果具有语义顺序则保留原顺序。
- UTF-8、无额外空白的 canonical JSON 后计算 SHA-256。
- 禁止把函数源码字符串化。`resolveState` 行为或字段语义变化时，必须提升 Prefab revision 或 state schema revision。

三组 hash 的输入：

```text
sceneCatalogHash
  = Scene descriptor + Scene revision + renderer profile

prefabCatalogHash
  = Prefab id/revision/gameplayType/root/component definitions
    + 被引用 Resource descriptor/revision/content hash
    + 所需 Component type/schema revision

stateSchemaHash
  = gameplayType -> authority-state schema id/revision
```

同一 `gameplayType` 新增第二个纯视觉 Prefab 时：

- `prefabCatalogHash` 必须变化；
- authority state schema 未变时，`stateSchemaHash` 不应变化。

### 6.3 生成与校验

建议增加：

```text
arts/scripts/generate-display-catalog-identity.mjs
arts/scripts/check-display-catalog-identity.mjs
```

职责：

1. 从实际 SceneDefinition、PrefabDefinition、Resource descriptors 和 Component registrations 构造 canonical input。
2. 合并产品显式声明的 `authorityStateSchemas`。
3. 计算三组 hash。
4. 生成 JS/JSON 与 Python 常量产物。
5. `--check` 模式重新计算并与已提交产物比较；不一致时 CI 失败。

现有 `check-display-architecture.mjs` 必须调用 `--check` 或同一纯函数，不再只验证 64 位十六进制格式。

Python `scene_projection.py` 只导入生成的身份，不再计算固定字符串 hash。Arts catalog 同样只导入生成产物。

新增测试：

- 改 Scene renderer profile，只有预期的 identity 变化且 checker 报 stale。
- 改 Prefab revision/root/resource hash，`prefabCatalogHash` 变化。
- 改 state schema revision，`stateSchemaHash` 变化。
- 新增相同 gameplayType 的视觉 Prefab，`prefabCatalogHash` 变化而 `stateSchemaHash` 不变。
- Python 与 Arts 读取完全相同的三组值。
- 旧的固定字符串常量在全仓库不存在。

## 7. 执行编排

为减少文件冲突，按以下顺序执行：

### 阶段 1：确定一次性新合同

同一负责人先固定：

- PrefabDefinition `@2` 字段；
- Display record `@3` 字段；
- Prefab ID 字符语法；
- catalog canonical JSON 规则。

把决定直接写入当前文档和正式 `docs/display.md`/`docs/wire.md`，不写兼容方案。

### 阶段 2：可并行工作流

**工作流 A — Display runtime owner**

- P1-A 的 Display package 部分；
- P1-B Definition API 收口；
- P1-C ResourceRegistry；
- Display 单元测试。

这些修改共同触及 `registries.js`，必须由一个 owner 完成，避免多 Agent 相互覆盖。

**工作流 B — Python/wire/client owner**

- `prefab_id`/`prefabId` 跨语言迁移；
- Display `@3` schemas；
- fixtures、client tests、Python tests、benchmark 输入。

**工作流 C — Product catalog owner**

- `python-game` projection；
- Arts Prefab/Scene/catalog/showcase；
- canonical identity generator 和 checker。

### 阶段 3：合并验证

- 全仓库搜索旧词；
- 重新生成 fixtures 和 identity 产物；
- 更新包版本、lockfile 和正式文档；
- 运行完整测试、500 节点 benchmark、资源泄漏验证和构建检查；
- 最后再把 `.agents/skills/scene-engine/SKILL.md` 作为现行用法提交。

## 8. 禁止留下的旧合同

完成后以下内容必须全仓库为零，历史审计文档除外：

```text
prefab_type
prefabType
PrefabDefinition.logicalType
PREFAB_BY_LOGICAL_TYPE
getMissileWarPrefabDefinition(logicalType)
PrefabDefinition.instantiate
SceneDefinition.instantiate
instantiateCompiled
prepareSceneInstance
sha256(b"missile-war-scene-catalog@display-1")
sha256(b"missile-war-prefab-catalog@display-1")
sha256(b"missile-war-authority-state@display-1")
```

不要机械删除普通业务文档中“逻辑类型”的概念；只清除它作为 Prefab 注册键和 wire 字段的用法。

## 9. 验收命令

在完整 checkout、完整 binary fixtures 和依赖均存在的环境执行：

```bash
# Python
uv run pytest
uv run python scripts/verify_cutover.py

# JavaScript workspace
npm ci
npm test

# 关键专项
npm test --workspace @scene-engine/display
npm test --workspace @scene-engine/client
npm test --workspace @scene-engine/renderer-three
node scripts/verify_display_leaks.mjs
node scripts/benchmark_display_runtime_500.mjs
node scripts/benchmark_client_ack_500.mjs
uv run python scripts/benchmark_scene_500.py

# Product/Arts（按仓库现有脚本名称执行）
node arts/scripts/check-display-architecture.mjs
node arts/scripts/check-display-catalog-identity.mjs --check
```

若仓库脚本名不同，可以调整命令，但不能省略对应验证范围。

## 10. 最终验收条件

只有同时满足以下条件才算完成：

- 同一 gameplayType 可注册并使用多个 Prefab ID。
- Scene 和 Authority 正式路径只按 prefabId O(1) 查找。
- Definition 不再暴露实例化 API，运行实例只有 Runtime/Loader/AuthorityPort 一条生命周期路径。
- ResourceRegistry 在 register 边界拒绝任何非资产 Definition，失败无部分写入。
- 三组 catalog hash 由真实 canonical contract 生成，checker 能发现任何 stale 产物。
- Python、JS client、Display、Arts、fixtures 和文档不再接受旧字段。
- ACK 仍不等待资源、observer、RAF 或 draw。
- 500 节点目标与现有泄漏门禁不退化。
- 完整测试在完整交付包中通过，不再依赖审核者自行补 binary fixture 或依赖目录。
