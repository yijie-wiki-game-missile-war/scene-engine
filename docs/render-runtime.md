# Three Render Runtime V2 contract

本文档是 `@scene-engine/renderer-three@0.8.0` 以及所有消费该包的产品显示代码的约束性合同。
0.8 是一次原子、破坏性重切换：0.7、所有 Render schema `@1` 和所有 pipeline `@1` 已退役，Runtime
直接拒绝旧值；没有 alias、parser fallback、feature flag、legacy adapter 或双注册期。

Python `scene-engine==0.6.1`、`@scene-engine/client@0.6.0`、Engine wire、WorldState、SceneTree、
60 Hz tick 与 packet log 不在本次合同变更范围内。

## 版本和公共表面

包根只导出以下七项：

```js
THREE_RENDER_RUNTIME_SCHEMA
RENDER_COMPOSITION_SCHEMA
RENDER_SNAPSHOT_SCHEMA
RENDER_BATCH_SCHEMA
ThreeRenderRuntimeError
ThreeRenderRuntime
createThreeRenderRuntime
```

资源 catalog 常量、validator、Three 类型、固定管线实现、资源 handle、测试 adapter 和 host 内部状态都不是
包根 API。唯一当前身份是：

```text
package                                      @scene-engine/renderer-three@0.8.0
runtime schema                               scene-engine-three-render-runtime@2
resource catalog schema                      scene-engine-render-resource-catalog@2
composition schema                           scene-engine-render-composition@2
snapshot schema                              scene-engine-render-snapshot@2
batch schema                                 scene-engine-render-batch@2
pipelines                                    model@2
                                             sprite@2
                                             surface@2
                                             particle@2
                                             scene-pass@2
```

## 数据与数值规则

- `generation`、`commitSeq`、`sourceTick`、`renderRevision` 是非负安全 `Number` 整数。
- `displayId` 与 `animation.startTick` 是非负 `BigInt`；`displayId` 不能为 `0n`。
- pose、颜色参数、opacity、emissive、controls 与 pipeline 参数全部为有限 `Number`。
- 输入只能含 primitive、`BigInt`、数组、typed array 和 plain record。函数、Promise、DOM、Three、class
  instance、DataView、循环引用和可执行数据字段均拒绝。
- Runtime 在边界复制数组和 typed array，并深度冻结归一化结果；调用者之后的写入不能改变已验证操作。
- 所有 record 都是 closed shape。未知字段、缺少必填字段、未知枚举和不匹配引用在任何 GPU mutation 前失败。

## 构造、相机和所有权

```js
const runtime = createThreeRenderRuntime({
  hostElement,
  canvas,
  cameraProfile,
  rendererProfile,
  resourceCatalog,
  onHealth,
});
```

前五项必填，`onHealth` 可选。Runtime 唯一拥有 Three.js、WebGLRenderer、Scene、PerspectiveCamera、
pan/zoom controls、root、scene-layer root、batch root、ResizeObserver、资源缓存和唯一 render RAF。
调用者不能注入或读取这些对象。

`cameraProfile` 的唯一 closed shape 是：

```js
{
  projection: 'perspective',
  position: [x, y, z],
  target: [x, y, z],
  up: [x, y, z],
  fovYDegrees,                 // 0 < value < 180
  near,                        // > 0
  far,                         // > near
  minDistance,                // >= 0
  maxDistance,                // >= minDistance
  controls: {
    mode: 'pan-zoom',
    dampingFactor,             // 0 <= value < 1
    panSpeed,                  // > 0
    zoomSpeed,                 // > 0
    panBounds: null | {
      minX,
      maxX,
      minZ,
      maxZ,
    },
  },
}
```

controls 禁止旋转；左/右键拖动平移，中键/滚轮 dolly，单指平移，双指 dolly-pan。pan bounds 同时约束
target 与 camera 的 X/Z 平移。controls change 只请求 draw，controls update 只在 Runtime RAF 内执行。
`focusWorldPoint` 保持当前观察方向并按 radius 求距离。未经验证的 orthographic 与 `orthoHeight` 字段直接拒绝。

`rendererProfile` 的唯一 closed shape 是：

```js
{
  drawMode: 'requested' | 'continuous',
  maximumPixelRatio,
  clearRgba,
  antialias,
  alpha,
  shadows,
  toneMapping: 'none' | 'aces-filmic',
}
```

Runtime 不创建隐藏默认灯光。没有 `lights` scene pass 时场景中没有默认照明。

## ResourceCatalog V2

```js
{
  schema: 'scene-engine-render-resource-catalog@2',
  resources: {
    '<opaque-resource-id>': { kind: '<closed-kind>', ... },
  },
}
```

resource ID 是首尾无空白的非空 opaque string。URL 必须是浏览器可解析的 `http:`、`https:`、`blob:`、
`data:`、`file:` 或相对 URL。loader、callback、任意 GLSL、`onBeforeCompile` 和可执行产品数据均拒绝。
catalog 在 Runtime 构造时一次性全量归一化、解析引用并冻结。

支持以下 closed resource：

- `model-url`：必填 `url`；可选 `lodUrls`、`clipNames`。
- `primitive-model`：非空 `parts`。每个 part 有 `shape`、`dimensions`、可选 transform，以及必填 source
  material `{tintRgba, opacity, emissive}`。shape 仅 `box|sphere|cylinder|cone|plane|hex-prism`。
  cylinder/cone 的第四个 dimension 是 `>=3` 的安全整数 segments；cone 的 top radius 可以为 `0`，
  bottom radius 和 height 必须 `>0`。
- `texture`：`url`，可选 `colorSpace: 'srgb'|'linear'` 和 `wrap`。
- `texture-atlas`：texture 字段加正安全整数 `columns`、`rows`，cell 总数必须是安全整数。
- `surface`：必填 `family`、`geometry`、`textureResourceIds`、`defaults`。family 只允许
  `surface.standard|surface.water`；`textureResourceIds` 长度只能是 0 或 1，且只能引用 `texture`。
- `particle`：必填 `textureResourceId`（`null` 或一个 `texture` ID）和正安全整数 `maximumCapacity`。
- `scene-pass`：必填 `passKind` 与 `defaults`；pass kind 只允许 `background|lights`。

surface primitive geometry 的唯一形状是：

```js
{
  primitive: 'plane',
  width,
  height,
  segmentsX,   // positive safe integer
  segmentsY,   // positive safe integer, independent from segmentsX
}
```

也可使用 `{positions, normals?, uvs?, indices?}`。positions 至少三个顶点且长度为 3 的倍数；normals、UV、
triangle indices 的长度与索引范围必须完整闭合。

## Composition、snapshot、batch 与 scope

`RenderLayerSpec V2` 的 closed shape 是：

```js
{
  key,
  pipelineId,
  resourceId,
  transform: {
    position: [x, y, z],
    rotationXyzw: [x, y, z, w],
    scale: [x, y, z],
  },
  material: {
    tintRgba,
    opacity,
    emissive,
    alphaMode: 'inherit' | 'opaque' | 'mask' | 'blend',
    alphaCutoff,
  },
  animation: null | {
    stateId,
    clipId,
    startTick,
    flags,
    clock: 'simulation' | 'visual',
  },
  params,
  batchKey: null | string,
  pickable,
  renderOrder,
}
```

Normalizer 内部必须明确使用 `node-composition` 或 `scene-layers` scope：

- `scene-pass@2` 在 node composition 中一律拒绝；
- node composition 的 `displayId` 必须对应本次完整 view 中的 node；
- composition 内 layer key 唯一；完整 scene layers 中 key 全局唯一；
- scene pass 的 `background` 和 `lights` 各最多一个，singleton 由 resource 的 `passKind` 决定；
- pipeline/resource kind、catalog 引用、atlas 范围和动画能力必须在 mutation 前匹配。

`RenderComposition` 是 `{schema, displayId, renderRevision, layers}` 的 complete layer collection。
`RenderSnapshot` 带精确 `generation/commitSeq/sourceTick`、所有当前 composition 和完整有序 `sceneLayers`。
`RenderBatch` 带同一精确 cursor、完整 changed compositions、removed display IDs，以及 `null` 或完整新
`sceneLayers`。scene layers 按 Arts activation-plan 顺序、再按 owner layer 顺序聚合；多个 owner 可以贡献。

## 统一 material 语义

`tintRgba` 是 source color 的乘色，不是替换；最终 opacity 为：

```text
sourceOpacity * layer.opacity * tintAlpha
```

`emissive` 是非负强度。model、sprite、surface、particle 必须实现其明确视觉效果；`scene-pass@2` 不使用
emissive，因此只接受 `0`。alpha 规则是：

- `inherit`：仅 `model@2`，保留 source transparent、alphaTest、depthWrite 等语义；最终 opacity `<1`
  时切入 blend。
- `opaque`：`transparent=false`、`alphaTest=0`、`depthWrite=true`。
- `mask`：`transparent=false`、`alphaTest=alphaCutoff`、`depthWrite=true`。
- `blend`：`transparent=true`、`alphaTest=0`、`depthWrite=false`。
- `alphaCutoff` 始终在 `0..1`；只有 `mask` 可以使用非零值，其余 mode 必须明确为 `0`。
- sprite 不允许 `inherit`；particle 只允许 `blend`；surface 不允许 `inherit`；scene pass 只允许
  `opaque`，且 opacity/tint alpha 必须为 1。

模型 source material 的 color/emissive/opacity、贴图、vertexColors、alpha/depth、side、blending、skinning、
morph、defines 与 toneMapped 属性在 clone 后保留；layer 只按上述规则乘色或显式覆盖 alpha/depth。

## 五条固定管线

### `model@2`

资源仅 `model-url|primitive-model`。params allowlist：

```text
castShadow, receiveShadow, lodDistances, instance, clipLoop
```

LOD distance 必须严格递增并与 `lodUrls` 数量一致。声明了 `clipNames` 时 clip 必须存在。primitive model
不接受 animation。只有单 mesh、非 skin、无 morph、无独立 animation/LOD、材质兼容且所有 batch 指纹字段
相同的 layer 可实例化；任何不兼容条件明确降级为 non-batched。普通模型与实例批次必须共用同一 material
composition 规则。

### `sprite@2`

资源仅 `texture|texture-atlas`。params allowlist：

```text
orientation, width, height, atlasCell, flipbook
```

orientation 仅 `fixed|billboard|y-billboard|ground`。`atlasCell` 与 flipbook 只能使用 atlas，且必须满足：

```text
0 <= atlasCell < columns * rows
startCell >= 0
frameCount > 0
startCell + frameCount <= columns * rows
frameTicks is a positive safe integer
```

flipbook 必须同时提供 animation，其 simulation/visual clock 由 `animation.clock` 唯一决定；没有 flipbook
时 animation 必须为 `null`。静态 atlas sprite 可以 batch，flipbook 不 batch。billboard/y-billboard 在每次 draw
前按最新 anchor world matrix 和 camera 更新，固定/ground 不做 camera-dependent update。

### `surface@2`

资源仅 `surface`。只保留 `surface.standard|surface.water`；`terrain-blend|foam|unlit-atlas` 和 layer 端
width/height/segments/family 字段直接拒绝。params allowlist：

```text
surface.standard: textureScale
surface.water:    amplitude, speed, foam, textureScale
```

water 的四项 effective value 必须由 resource defaults 或 layer params 完整给出；amplitude 非负、foam 在
`0..1`、textureScale `>0`。water 是直接 ShaderMaterial draw，使用确定性波、local plane normal、time、
amplitude、speed、foam 与 textureScale；无 texture 时走明确的无采样 variant。它不创建反射/折射或任何
WebGLRenderTarget。surface animation 必须为 `null`，唯一 visual time 来自 Runtime RAF。

### `particle@2`

资源仅 `particle`。params 是以下完整必填集合：

```text
durationTicks, capacity, seed, rate, size, velocity, spread, gravity,
blendMode: 'normal' | 'additive'
```

capacity 不能超过 resource maximum。material 只允许 `blend`。animation 必填，clock 唯一决定使用
`sourceTick` 或 Runtime visual time；seed 在 rebuild/Replay 后产生相同结果。参数和材质更新应原位执行，
不能产生 per-particle RAF。

### `scene-pass@2`

资源仅 `scene-pass`，只允许 scene scope。params allowlist：

```text
passKind, colorRgba, intensity, direction
```

若给出 `passKind`，它必须与 resource 完全相同。background 的 effective `colorRgba` 必填，且拒绝 light
字段；lights 的 effective `colorRgba`、非负 `intensity` 和非零 `direction` 必填。一个 lights layer创建
ambient + directional。Runtime 从完整 sceneLayers 重新求值 background/lights 全局状态，不保存 binding-local
previous stack；删除 background 时恢复 `rendererProfile.clearRgba`，删除 lights 时场景无灯。animation 必须
为 `null`。只有 `scene-pass@2` binding 的 install、update 或 remove 会触发这次全局重求值；普通 node layer
以及其他 scene-layer pipeline 的 binding 变化不得销毁、重建或临时替换现有 background/lights。

## Runtime 方法、cursor 与恢复

```js
runtime.install({ view, snapshot });
runtime.apply({ plan, view, batch });
runtime.applyBatch([{ plan, view, batch }, ...]);
runtime.rebuild({ view, snapshot });
runtime.start();
runtime.stop();
runtime.requestDraw();
runtime.focusWorldPoint({ position, radius });
runtime.projectWorldPoint({ position });
runtime.pick({ clientX, clientY });
runtime.whenIdle();
runtime.capture();
runtime.dispose();
```

`install` 只用于首次 checkpoint；之后 checkpoint/Replay seek 使用 `rebuild`。plan、view、batch cursor 必须
一致，frame plans 不跳过任何 lifecycle；`applyBatch` 只能合并 matrix upload 与最终 draw，不能折叠状态。

`plan === null` 只有两种合法情形：

1. 新 Engine no-frame commit：cursor 前进且 batch 视觉内容为空；它仍更新 `sourceTick`、simulation animation、
   particle sample 并请求 draw。
2. shell-local display-state batch：使用当前已安装 cursor，可改变 compositions；不推进 Engine state。

任何其他 cursor 组合拒绝。完整操作先验证后 mutation；GPU mutation 后异常将 projection 标为 unhealthy，
唯一恢复是用最新 view 和新编译完整 snapshot 执行 `rebuild`。RAF 中 controls、sample、batch refresh、
diagnostics 或 render 异常同样进入该健康边界并停止继续提交 draw。

`render-draw-failed` 是唯一会在 Runtime 内部把其 owned `WebGLRenderer` 标为 tainted 的 health code。下一次完整
latest-view rebuild 必须先清空 projection 并释放旧 binding/resource lease，再 dispose 旧 WebGLRenderer，在同一
canvas 的 WebGL2 context 上恢复 PACK/UNPACK pixel-store 默认值，然后按原 `rendererProfile` 创建新
WebGLRenderer 并重新 resize，最后安装 fresh full snapshot。context reset 必须发生在新 renderer 构造前，避免其
默认 3D/array texture 继承旧 renderer 的 flip/premultiply/row/skip 状态。只有该安装的
idle/resource barrier 成功后才能恢复 healthy。controls、sample、batch 或 diagnostics failure 仍执行完整 projection
rebuild，但不会替换 WebGLRenderer；tainted 状态和 renderer 对象均不得通过 public API 或 diagnostics 暴露。

`start/stop` 只控制绘制。simulation animation 只读取 `sourceTick/startTick`；wall time 不创造规则事实。
`dispose` 幂等，取消 job、listener、observer 和 RAF，并释放 renderer-owned resources；其余方法在 dispose 后拒绝。

`capture()` 返回 V2 schema/cursor 与 node、layer、scene-layer、batch、resource、pending-job、draw、listener、
observer、RAF、rendererInfo 等纯标量诊断。当前 V2 不拥有 RenderTarget pass，因此该计数必须为 `0`。
它不暴露 Three 引用。health event 仍是冻结 plain record：

```js
{ severity: 'warning' | 'error', code, message, generation, commitSeq }
```

## Arts 边界

Arts 同步地把 activated FeatureOwners 和 Missile War profile 编排为完整纯数据 compositions；只可保留
UI-local display state 与每 display 单调 render revision。controller 表面保持：

```js
compileSnapshot({ view })
compileCommit({ plan, view, events })
updateDisplayState({ displayId, patch })
compileDisplayStateChange({ view, changedDisplayIds })
dispose()
```

Arts 只验证 owner 返回同步 plain-data array、layer key 唯一、resource ID 可达与 owner/visualType 映射；
pipeline/resource matrix、params allowlist、alpha、atlas、surface、scene pass scope 等技术合同只由 Runtime 验证。
Arts 不得 import renderer 内部 validator，不得创建 Renderer、Scene、Camera、Controls、Object3D、第二 SceneTree、
逐帧 Three callback 或 FeatureOwner RuntimeHandle。需要跨 rebuild/Replay seek 存活的效果必须来自 Engine node/
animation，而不是 Arts event history。
