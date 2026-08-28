# Scene Engine 显示端改动审核与收口建议


> **历史审核记录：** 本文保存 2026-08-25 审核时的结论，不能用来判断当前 API。当前实现请以 `README.md`、`docs/` 当前合同和源码为准。

审核日期：2026-08-25
审核对象：`missile-war-display-closeout-code-docs-20260825` 中的 `scene-engine`、`python-game`、`arts` 三个独立仓库快照
目标：确认通用显示运行时是否已经正确收回 `scene-engine`，检查公开合同、测试和交付材料，并补充一份面向 Agent 的 Scene Engine 使用 Skill。

## 一、结论

这次改动的**总体架构方向正确，可以作为后续正式架构的基础**：

```text
Python authoritative World / EngineProgram
  -> scene-engine-wire@2
  -> SceneEngineClient
  -> DisplayRuntime
  -> RenderSystem
  -> ThreeRenderBackend
```

目前已经基本实现：

- Python 只发布稳定 `py/` 节点名、逻辑 `prefab_type`、Transform、可见性和完整状态；
- `@scene-engine/display` 统一拥有 Node、Transform、Scene、Prefab、Component、Resource、NodeIndex 和 RAF；
- `@scene-engine/renderer-three` 只实现平面的渲染后端端口，不持有第二棵业务节点树；
- Arts 正式浏览器代码不直接导入 Three，也不再维护自己的显示运行时；
- Live、Replay 和只读展示使用相同正式定义和 DisplayRuntime；
- ACK 屏障没有等待资源加载、观察者、RAF 或绘制；
- 当前 Display 核心的 50 项测试全部通过。

但现在还不适合把“显示合同已经完全收口”标记为完成。审核发现 **3 个需要正式发布前修复的 P1 合同问题**：

1. 公开的 `PrefabDefinition.instantiate()` 调用了不存在的方法；
2. `ResourceRegistry` 会接受 `SceneDefinition`/`PrefabDefinition`，绕过资产资源校验；
3. 三组 catalog hash 不是实际合同内容的 hash，只是共享的人工常量。

另外还有交付包不可自验证、旧命名残留和一处无调用代码需要清理。

**审核判断：架构通过；公开 API 和跨仓库身份合同需要再做一轮小范围收口。不要增加新层。**

---

## 二、已经做对的部分

### 2.1 通用显示运行时已经回到 Scene Engine

`scene-engine/README.md` 和实际代码一致地形成了四段发布链：

```text
scene-engine Python 0.7.0
@scene-engine/client 0.8.0
@scene-engine/display 0.2.0
@scene-engine/renderer-three 0.9.1
```

其中：

- Python Runtime 负责固定步进、事务、packet、session、ACK 接收与 recording；
- Client 负责唯一 wire 解码、WorldState 指针、同步 ACK 屏障和 Display session 替换；
- DisplayRuntime 负责唯一 NodeIndex、NodeGraph、Transform、Component scheduler、RenderSystem 和应用 RAF；
- Three 后端只负责加载、binding、batch、GPU 资源、draw、pick、project、capture 和 dispose。

没有发现新的第二套节点树、第二个显示时钟或第二个产品渲染循环。

### 2.2 Python 与显示内容边界正确

`python-game/adapters/scene_projection.py` 输出的是逻辑显示事实：

- 稳定的完整 `py/` 名称；
- authority parent；
- 逻辑 Prefab 类型；
- 一个 local Transform；
- visibility；
- 完整 authority state。

Python 没有发送模型 URL、材质、网格、灯光、摄像机、渲染管线或 Prefab-local 路径。这与 `scene-engine/docs/display.md` 的边界一致。

### 2.3 Arts 不再拥有通用引擎

Arts 的正式 Web3D 代码通过中央 catalog 注册 Scene、Prefab、Resource 和 Component，然后创建正式 DisplayRuntime 和 Three 后端。架构检查会阻止正式浏览器源直接导入 Three；展示页也复用正式定义，而不是使用评审专用运行时。

现有 `arts/.agents/skills/missile-war-display/SKILL.md` 适合处理 Arts owner、资源、Showcase 和视觉验证，但不适合解释 Scene Engine 本身。此次已经新增独立 Scene Engine Skill，见第七节。

### 2.4 Display 核心结构简洁且自洽

`DisplayRuntime` 构造时封存四个 registry，并创建唯一：

```text
NodeIndex
NodeGraph
ComponentScheduler
RenderSystem
Scene
PrefabInstantiator
AuthorityPort
SceneLoader
commitGate
```

Scene 和 Prefab Definition 是不可变声明，Prefab 运行实例是普通 Node 子树；Mesh/Model/Material 是 Resource descriptor，显示实例由 RenderComponent 表达。这一结构比把所有内容塞进一个业务 Model 或 Prefab 基类更清晰。

### 2.5 ACK 与渲染异步边界正确

Client 在同步屏障中完成：

1. packet 与完整 command stream 校验；
2. World candidate 构造；
3. commit gate begin；
4. 单目标 Authority 操作；
5. cursor seal；
6. World/commit 指针发布；
7. O(1) summary；
8. ACK 编码。

资源加载、完整 DisplayView、observer、HUD、RAF 和 draw 均在 ACK 之外。这个边界应保留。

---

## 三、P1：公开 Definition 实例化接口未收口

### 3.1 现象

公开导出的 `PrefabDefinition` 含有：

```js
instantiate(scope) {
  return scope.instantiator.instantiateCompiled(
    scope,
    this.compile(scope.registries),
  );
}
```

位置：

```text
scene-engine/js/packages/display/src/resource/prefab-definition.js:138
```

但整个仓库中没有 `instantiateCompiled()` 方法。`PrefabInstantiator` 的实际入口是 `prepareExistingRoot()` 等内部方法。

审核复现结果：

```text
TypeError: scope.instantiator.instantiateCompiled is not a function
```

现有 50 项 Display 测试没有调用该公开方法，所以测试全部通过仍未发现问题。

`SceneDefinition.instantiate(scene)` 虽然能调用内部 `scene.loader.installCompiled(...)`，但同样把内部 Scene/Loader 结构暴露成了 Definition 的伪公开实例化合同。正常公开路径已经是：

```js
runtime.installScene({ sceneName })
```

另外，registry 还把 `instantiate` 当成需要禁止覆盖的 final method：

```text
scene-engine/js/packages/display/src/resource/registries.js:18
scene-engine/js/packages/display/src/resource/registries.js:36
```

这会把一个不应存在的实例化入口进一步固化为 API。

### 3.2 架构判断

Definition 应当只负责：

```text
immutable declaration
compile
state resolution / patch validation
```

运行实例的创建、挂载、激活、替换和销毁应由：

```text
DisplayRuntime
SceneLoader
AuthorityPort
PrefabInstantiator（包内）
```

统一拥有。不要让 Definition 同时兼任工厂和运行时入口。

### 3.3 最小修复

1. 删除 `SceneDefinition.instantiate()`；
2. 删除 `PrefabDefinition.instantiate()`；
3. 从 `registries.js` 的 final method 列表删除 `instantiate`；
4. 删除无调用的 `PrefabInstantiator.prepareSceneInstance()`，或证明其唯一必要调用并接入唯一 SceneLoader 路径；当前全仓库只有定义，没有调用：

```text
scene-engine/js/packages/display/src/runtime/prefab-instantiator.js:42-73
```

5. 增加 public contract 测试，明确 Definition 的公开方法集合；
6. 增加测试，证明 Scene 只能通过 `runtime.installScene()` 安装，authority Prefab 只能通过 AuthorityPort 创建/替换。

不要补一个新的 `instantiateCompiled` 公共层；那会重新制造第二条实例生命周期路径。

---

## 四、P1：ResourceRegistry 可注册非资产 Definition

### 4.1 现象

`ResourceRegistry.register(value)` 对任意内部 `Resource` 子类直接调用 `describe()`，不执行资产 descriptor 的 `kind` 和字段校验：

```js
const descriptor = value instanceof Resource
  ? value.describe()
  : normalizeDescriptor(value);
```

位置：

```text
scene-engine/js/packages/display/src/resource/resource-registry.js:63-79
```

而 `SceneDefinition` 与 `PrefabDefinition` 都继承内部 `Resource`。因此下面的调用会成功：

```js
const resources = createResourceRegistry();
resources.register(prefabDefinition);
```

审核实际得到：

```text
resource-registry-accepted-prefab: prefab.test {
  schema: 'scene-engine-prefab-definition@1',
  id: 'prefab.test',
  logicalType: 'test.prefab',
  root: ...
}
```

这个 descriptor 没有 `kind`，却已经进入资产 registry。错误会在后续组件引用或 renderer 读取时才暴露，破坏了“registry 边界一次性封闭校验”的合同。

### 4.2 架构判断

以下三类注册表必须互斥：

```text
SceneRegistry       只接受 SceneDefinition
PrefabRegistry      只接受 PrefabDefinition
ResourceRegistry    只接受 model/mesh/texture/material/... 资产 descriptor
```

“它们都继承 Resource”不应成为跨 registry 接受的理由。

### 4.3 最小修复

优先选择最简单方案：

- `ResourceRegistry.register()` 只接受普通、封闭的资产 descriptor，并始终经过 `normalizeDescriptor()`；
- 不再接受任意 `Resource` 实例。

若确实需要预构造资产对象，则新增包内私有的 `AssetResource` brand，并只接受该 brand；不要继续接受通用 `Resource` 基类。

需要增加：

- 拒绝 `SceneDefinition` 的测试；
- 拒绝 `PrefabDefinition` 的测试；
- 拒绝缺少 `kind` 的测试；
- 证明失败发生在 `register()`，且 registry 没有部分写入。

---

## 五、P1：Catalog hash 不是实际合同内容的 hash

### 5.1 现象

Python 端的三组身份由三个固定字符串计算：

```python
sha256(b"missile-war-scene-catalog@display-1")
sha256(b"missile-war-prefab-catalog@display-1")
sha256(b"missile-war-authority-state@display-1")
```

位置：

```text
python-game/adapters/scene_projection.py:25-35
```

Arts 端直接复制三个结果常量：

```text
arts/web3d/src/catalog/missileWarCatalog.js:81-85
```

当前 architecture checker 只验证：

- Scene/Prefab/Resource ID 不重复；
- 三个字符串符合 64 位小写十六进制格式；
- 正式 registry 可以编译和启动。

位置：

```text
arts/scripts/check-display-architecture.mjs:377-425
```

它没有验证 hash 是否来自：

- 实际 SceneDefinition；
- 实际 PrefabDefinition；
- Resource ID、revision、hash 或 descriptor；
- Component type/schema；
- Prefab resolver revision；
- Python authority state schema。

因此，修改 Prefab 结构、资源、resolver 或状态字段后，只要没有人工改动这三个字符串，Python 和 Arts 仍会认为身份相同，session 也会通过 catalog mismatch 门禁。

### 5.2 风险

这不是普通版本号命名问题，而是破坏了 checkpoint 中三组 SHA-256 身份的主要用途：

```text
在 DisplayRuntime 激活前发现生产者与消费者的合同不一致
```

当前实现实际上是“双方共享三个版本字符串的 hash”，不是“合同内容身份”。

### 5.3 最小修复

不要增加 catalog 服务或运行时协商层。只建立一个小型、可重复生成的 canonical identity manifest：

```json
{
  "schema": "missile-war-display-catalog-identity-input@1",
  "scenes": [...],
  "prefabs": [...],
  "resources": [...],
  "components": [...],
  "authorityStateSchemas": [...]
}
```

建议规则：

- `sceneCatalogHash`：对按稳定顺序排列的 Scene descriptor、scene revision 和 renderer profile 做 canonical JSON SHA-256；
- `prefabCatalogHash`：对 Prefab descriptor/revision、Resource descriptor/revision/content hash、所需 Component type/schema 做 canonical JSON SHA-256；
- `stateSchemaHash`：对每个逻辑 Prefab 类型的显式 authority-state schema ID/revision 做 canonical JSON SHA-256；
- resolver 函数体不直接序列化；resolver 或字段语义变化必须提高 Prefab/state schema revision；
- Python 和 Arts 使用相同生成产物或在 CI 中分别计算并强制相等；
- architecture checker 必须重新计算，而不是只做正则检查。

只需要一个 manifest、一个 canonical JSON/hash 工具和一组跨仓库检查，不需要引入新运行时层。

---

## 六、其他问题

### 6.1 P2：当前交付 ZIP 不能自验证

`SOURCE-MANIFEST.md:5-10` 明确说明该包不是完整可运行 checkout，并排除了 binary fixture 和 dependency directory。这与“代码/文档交付包”的定位一致，但也意味着它无法作为可独立复核的正式执行结果。

本地实际结果：

#### Python

完整测试有 2 项失败，均为缺少：

```text
fixtures/wire-v2/checkpoint.bin
fixtures/wire-v2/nonfinite.bin
```

其余测试通过；不依赖这些 binary fixture 的 50 项核心 Python 测试全部通过。

#### JavaScript

- `@scene-engine/display`：50/50 通过；
- `@scene-engine/client`：21/27 通过，6 项失败均因缺少 `checkpoint.bin` 或 `packets.bin`；
- `@scene-engine/renderer-three`：因交付包没有安装依赖，6 个测试文件都无法导入 `three`。

`scripts/verify_cutover.py` 自身也直接读取 `fixtures/wire-v2/checkpoint.bin`，所以当前快照不能执行 README 中声明的完整收口命令。

建议把交付分成两种明确制品：

1. `source-docs`：允许排除二进制和依赖，明确仅用于审阅；
2. `reproducible-verification`：必须包含 canonical binary fixture、lockfile，并能在 clean install 后执行所有 gate。

不要在报告中把第二种的“全部通过”能力赋予第一种包。

### 6.2 P3：旧 Presentation 术语仍留在显示投影错误码

以下错误码仍使用已废除的 Presentation 名称：

```text
python-game/adapters/scene_projection.py:326
presentation_terrain_prefab_unregistered

python-game/adapters/scene_projection.py:424
presentation_animation_unregistered

python-game/adapters/scene_projection.py:600
presentation_owner_color_unregistered
```

这些名称容易让 Agent 误认为仍存在 Presentation 层。若没有外部消费者依赖，直接改为：

```text
display_terrain_prefab_unregistered
display_animation_unregistered
display_owner_color_unregistered
```

空间坐标 canonical vector 中作为“表现偏移”语义使用的 `presentation_*` 不一定属于旧架构层，不能机械全局替换；只清理明确指代旧显示层的错误码和文档。

### 6.3 P3：无调用的 `prepareSceneInstance()`

`PrefabInstantiator.prepareSceneInstance()` 当前没有任何调用者，SceneLoader 已经通过 `prepareExistingRoot()` 完成静态 Prefab instance 安装。它与 Definition 上未收口的 `instantiate()` 很可能来自同一条废弃设计路径。

删除前补一项搜索/测试确认即可；不应为保留它而制造新调用。

### 6.4 文档缺少“如何用引擎”的实践入口

现有 `docs/*.md` 对合同冻结得很完整，但偏向描述“不允许什么”和底层不变量。Agent 执行具体工作时缺少：

- 任务属于 Python、Client、Display 还是 renderer 的判断；
- EngineProgram 六个方法如何使用；
- Client session 四字段如何组装；
- Registry/Scene/Prefab/Resource/Component 的创建顺序；
- Live/Replay 与直接只读 runtime 的区别；
- 常见错误恢复与测试命令。

这也是 Agent 容易转去使用 Arts Skill、把引擎工作理解为“做美术”的主要原因。本次新增的 Scene Engine Skill用于补足该入口。

---

## 七、新增 Scene Engine Agent Skill

已新增：

```text
scene-engine/.agents/skills/scene-engine/SKILL.md
```

并修改：

```text
scene-engine/AGENTS.md
```

让 Agent 在开始 Scene Engine 的使用、集成、扩展、测试和调试任务前读取该 Skill。

Skill 重点覆盖：

- 按职责选择 `EngineProgram`、Runtime、wire、Client、Display、Three、recording/Replay；
- 唯一正式数据流和状态所有权；
- Python Runtime 与六个 Product Port 方法；
- Client `applyPacket`、ACK、input、session factory、观察者；
- Display registry 创建顺序和 runtime 组装；
- Resource、Prefab、Scene、Component 的正式用法；
- Camera、Background、Light、Model、Mesh、Material 对应的资源/组件边界；
- Three 后端只在 composition root 接入；
- 时间、身份、完整状态替换、故障恢复和 dispose；
- 完整禁止项与验证命令。

它明确排除：

- 游戏美术资产生产；
- 视觉风格与构图；
- owner 美术工作流；
- Showcase 目录、评审和截图编排；
- 具体产品的 Scene/Prefab/Resource 内容制作。

这些仍由 Arts Skill 和产品仓库负责。

Skill 本身已经完成：

- YAML frontmatter 校验；
- 16 个相对文档/源码链接存在性校验；
- 示例中公共 JS/Python 符号存在性校验；
- 独立仓库检查，未引用 sibling Arts Skill 或 Arts 私有路径。

---

## 八、实际验证结果

### 8.1 通过

```text
scene-engine/js/packages/display
node --test ./test/*.test.mjs
=> 50 tests, 50 passed
```

```text
scene-engine Python focused core
pytest:
  test_display.py
  test_display_benchmark.py
  test_import_surface.py
  test_json_tree_v1.py
  test_runtime.py
=> 50 passed
```

```text
Scene Engine Skill
frontmatter/link/public-symbol/independent-repository checks
=> passed
```

### 8.2 受交付包内容限制，未能完整通过

```text
Python full suite
=> 2 failures, both missing wire-v2 binary fixtures
```

```text
JavaScript workspace
client: 21/27 passed; 6 missing binary fixture failures
display: 50/50 passed
renderer-three: dependency `three` absent, 6 test files cannot start
```

源清单声称完整仓库的实现提交曾通过 109/109 JavaScript 和 72/72 Python 测试；该声明与本次可见材料没有直接矛盾，但当前 ZIP 本身无法独立复现该结果。

---

## 九、建议的最小执行顺序

### 第一组：Scene Engine 内部，可并行

A. Definition API 收口

- 删除两个 Definition 的 `instantiate()`；
- 删除 final method 列表中的 `instantiate`；
- 删除无调用 `prepareSceneInstance()`；
- 补 public surface 与唯一实例化路径测试。

B. ResourceRegistry 收口

- 只接受资产 descriptor 或私有 AssetResource brand；
- 拒绝 Scene/Prefab Definition；
- 补失败原子性测试。

这两组都不需要修改 Python、Client、Three 或 Arts，也不应增加兼容层。

### 第二组：跨仓库 catalog identity

- 定义一个小型 canonical identity input；
- 生成三组真实 hash；
- Python checkpoint 与 Arts expected identity 使用同一生成结果；
- architecture checker 重新计算并比较；
- 修改任何 Scene/Prefab/Resource/state schema 时，测试必须证明 identity 变化。

### 第三组：清理与交付

- 清理三个旧 `presentation_*` 显示错误码；
- 生成包含 binary fixtures 的可复现验证包；
- clean install 后执行 Python、JS、cutover verifier 与三项 500 节点 benchmark；
- 更新最终报告，只引用该可复现包的实测结果。

---

## 十、最终验收条件

只有同时满足以下条件，才建议标记为“显示合同正式收口”：

- `PrefabDefinition`/`SceneDefinition` 没有第二条公开实例化路径；
- ResourceRegistry 无法接收 Scene/Prefab Definition；
- catalog hash 会随实际 Scene/Prefab/Resource/state schema 合同变化而变化；
- Python 与 JS 完整测试可从交付包 clean-run；
- cutover verifier 可执行且通过；
- `@scene-engine/display` 仍只有一个 NodeIndex、Transform 图和 RAF；
- Three 后端仍不拥有业务树、产品 controls 或隐式摄像机/灯光；
- Python 仍只发送逻辑 authority facts；
- Arts 正式浏览器代码仍不直接导入 Three；
- 新 Scene Engine Skill 继续描述引擎用法，不吸收美术生产流程。
