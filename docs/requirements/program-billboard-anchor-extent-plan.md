# 程序化面片与锚点展开组合能力调整计划

- 日期：2026-09-06。
- 状态：Engine 已实施并于 2026-09-07 完成本地包交付；通用验收通过，Arts 接入与美术验收待用户通知。
- 顺序：先完成 Engine 的 E0–E4 并交付包与证据；Arts 等用户明确通知后核验并继续，不自动实施、升级依赖或启动后台任务。
- 调查基线：Display `0.20.0` / renderer-three `0.17.0`。这是当前工作树及 Arts 已安装包的调查快照，不是本计划承诺的下一版本号。
- 配套：[Arts 云层修复计划](../../../arts/resources/environment/cloud/studies/far-sea-v10/cloud-layout-repair-plan.md)。跨仓链接只用于需求协调，Engine 实现与通用测试不得依赖产品代码、素材或数据。

## 1. 目标与原需求的关系

本计划是 [Far Sea 程序渲染与统一投影需求](far-sea-procedural-rendering-and-projection.md) 的组合能力补齐，主要细化 FSR-011/012/014/016/021/033/040。现有统一投影、程序资源和普通 Sprite 的锚点展开继续保留，不重建另一条渲染路径。

目标是让一个声明式面片同时具备：

1. 世界锚点经过统一投影，画面中的轮廓采用未被额外纵向压缩的面片尺寸；尺寸仍随透视距离变化，不是固定 CSS 像素。
2. 表面使用正式 `material.program`、命名纹理和类型化参数，保留颜色、alpha、过滤和显示时间合同。
3. 在已投影锚点处按显式图像 pivot 展开，支持中间、底部以及偏底部定位；不通过修改世界高度模拟 pivot。
4. 最终覆盖、UV、深度、剔除、拾取、定格、资源更新和重建一致。

Engine 只提供通用表示。云的数量、分层、布局、海岸避让、风向与美术尺寸由 Arts 负责，不进入引擎内置分支。

## 2. 调查基线的已有能力与组合缺口（已补齐）

本节记录实施前的调查基线；新增能力现已接通。现行行为以 [Display](../display.md)、[渲染后端](../render-runtime.md) 和 [程序资源](../procedural-programs.md) 为准。不能因为几项能力各自存在，就宣称它们可以组合使用。

| 当前入口 | 已有行为 | 本次需要补齐 |
| --- | --- | --- |
| [Sprite 校验](../../js/packages/display/src/render/components.js) | `render.sprite@3` 要求 `textureResourceId`、宽高，支持 `projectionSemantics:'anchor-extent'` | 不能直接引用程序材质；需要明确的程序资源分支与依赖校验 |
| [纹理校验](../../js/packages/display/src/resource/texture-sampling.js) | 普通 Sprite 路径拒绝需要程序采样的预乘来源或关联过滤 | 程序面片必须走已有命名色槽归一化，不删除普通采样的保护性校验 |
| [锚点展开](../../js/packages/renderer-three/src/anchor-extent.js) | 云片式中心矩形、恒定锚点深度、普通贴图 UV 与 CPU 代理 | 需与程序 evaluator 共用，并增加投影后的图像 pivot |
| [程序材质](../../js/packages/renderer-three/src/program-material.js) | 程序表面从普通网格的世界坐标和 UV 取样 | 新表示必须定义最终矩形 UV、锚点和片元空间输入，不能沿用未变形网格插值 |
| [程序参数系统](../../js/packages/display/src/render/program-input-system.js) | 同 Node Behaviour 可更新程序 mesh/background 的受控参数 | 新程序面片也要进入同一所有权、验证、释放与恢复路径 |

现有 `anchorOffset` 先移动 Node-local 世界锚点，再进行投影；它不是图像内部 pivot。当前实现的展开矩形仍以锚点为中心。两者必须分开定义，否则用世界偏移模仿图像底部定位会随投影强度和距离产生不同结果。

## 3. 接口设计方向与不变边界

### 3.1 采用的路线

优先扩展现有 Sprite 表示，以闭合、互斥的资源分支接入程序材质，并复用现有 anchor-extent 后端实现。不把任意 mesh 自动解释为 billboard，不开放用户顶点入口，不要求 Arts 提供最终 clip position。

E0 已冻结：保持 `render.sprite@3`，以闭合、互斥的资源联合增加能力，省略新增字段的普通纹理分支行为不变。发布目标 Display `0.21.0` / renderer-three `0.18.0`，不接受其他 Sprite schema 或兼容别名。

- 普通分支继续使用 `textureResourceId`；程序分支使用 `materialResourceId`，只接受 surface-stage `material.program`，必须显式声明 `projectionSemantics:'anchor-extent'`，可带受控 `parameters`。
- 两个分支都要求正有限 `width`、`height`；anchor-extent 接受 `anchorOffset`（默认 `[0,0,0]`）和 `pivot`（默认 `[0.5,0.5]`）。geometry 拒绝这两项。程序分支拒绝 `textureResourceId`、inline `material`、`alpha` 和 `frame`。
- `ProgramInput.hasAnchor` 是 bool；程序面片为 true，`anchorWorldPosition` 为实际世界锚点。普通 mesh/background 为 false，`anchorWorldPosition` 明确为 `vec3(0)`，其他已有空间输入保持原合同。
- 程序面片 `uv` 来自最终未裁剪图像矩形；`worldPosition` 为最终像素逆射线与锚点 view-depth 平面交点；颜色、深度与查询复用同一覆盖。所有程序面片初期走 ordinary 路径。
- T13 引擎通用档位为 32 / 128 / 512 个透明程序面片；固定通用面片尺寸和相机，分别记录透明覆盖、draw calls、内存与 CPU 提交。设备信息由实际浏览器 runner 读取，不设跨机器 FPS 门槛。

字段实现后以现行专项合同为唯一权威；Arts 仍等实际包交付与用户通知后接入。

| 概念 | 目标要求 |
| --- | --- |
| 普通纹理分支 | 保持现有 texture/atlas、frame、材质属性和默认 geometry 行为；省略新字段不改变旧内容 |
| 程序材质分支 | 显式引用 `material.program` Resource；程序必须是 surface stage；命名纹理与默认参数仍归 Material Resource |
| 互斥与覆写 | 拒绝同时声明纹理分支、程序材质分支；程序分支不再接受另一份 inline material、普通 atlas frame 或重复 alpha/tint 来源；动态参数只覆盖 updateable 项 |
| 投影语义 | 新程序分支首阶段明确要求 anchor-extent，其他未支持组合同步拒绝；普通纹理分支的 geometry 内容和既有 fixed-panel 补偿不被全局切换；继续拒绝 anchor-extent 与 inherited fixed-panel compensation 混用 |
| 世界锚点 | 继续使用 Node world transform 与现有 Node-local anchorOffset 语义 |
| 图像 `pivot` | 新的二维归一化 pivot，默认中心 `[0.5,0.5]`，范围 `[0,1]`；只改变投影后展开方向，不移动世界锚点，不旋转或镜像 UV |
| 对外版本 | 按最终变更确定 package/public Component schema 策略并同步消费者；不创建兼容别名或两套渲染定义；最终版本见现行 release tuple |

### 3.2 统一图像展开定义

沿用 [现行锚点展开合同](../render-runtime.md#sprite-projection-semantics)，不另设 upper-field 正逆公式。新增 pivot 的定义应为：以图像左下角为 `(0,0)`，顶点展开偏移按 `(imageUv - pivot) × 已投影尺寸` 计算，中心位于该像素区域中的哪一点由 pivot 决定。

- `[0.5,0.5]`：中心定位，保持现有 anchor-extent 的结果。
- `[0.5,0]`：底部中心定位，图像从已投影锚点向上展开。
- 非中心 pivot 必须在透视、正交、identity 和 upper-field 下语义相同。
- Node 基向量的长度、旋转与负缩放继续遵守现行锚点展开尺寸合同；不在这次增量里暗改镜像、尺度或 fixed-panel 行为。
- 宽高有限且为正，pivot 与 anchorOffset 有限，非法数据在 Display 候选暴露前失败；隐藏的零尺度实例继续不绘制、不参与查询。
- 图像越出视口时，先按最终矩形处理裁剪，再进入共用采样阶段；UV 不得因为裁剪而拉伸，pivot 在视口外也不能错误丢弃仍可见的图像。

世界锚点、图像 pivot 和云层世界高度是三个独立概念。产品可以用该通用能力表达偏底部的云图，但 Engine 不内置特定云层的 lift 常量。

### 3.3 不变边界

- 保持唯一 DisplayRuntime、NodeGraph、RenderSystem、active Camera、Scene 与 RAF；复用已存在的 upper-field 中间目标和最终采样阶段。
- Arts 不新增 Three 对象、shader hook、CPU/GPU 投影公式、私有渲染循环、屏幕贴图背景或第二份世界位置缓存。
- Python authority、Wire、Client commit/ACK、Replay packet 格式及产品身份不变。合法状态确认不等待纹理解码、GPU 编译或绘制。
- 不为本任务重做天空、水面、全局投影或地形；真正光源空间的阴影保持其原合同。
- 不将普通 Sprite 的关联采样校验直接放开，不移除校验来强行接受程序纹理。

## 4. 必须共同完成的工程项

### PB-01：闭合数据与资源依赖

调整 Sprite normalizer、公开类型、组件注册/编译、RenderSystem 资源依赖及 renderer 防御校验。程序分支必须解析 Material → Program 以及 Material → named textures 的完整依赖，不能只等待普通 `textureResourceId`。

非法组合、错误 stage、未知/不可变参数、错误资源种类、非法 pivot/anchor 以及 fixed-panel 混用均应在 Display 暴露前同步拒绝。保留现有精确校验与候选操作的原子性。

### PB-02：共用几何覆盖与程序 evaluator

将 anchor-extent 的矩形、UV 和覆盖准备抽为引擎内部可复用能力，接入程序材质生成器。避免两个 `onBeforeCompile`/生成步骤互相覆盖，或普通纹理 map 逻辑误用于命名程序采样。

仍在现有世界绘制和最终采样流程中完成，不做 owner 自定义 warp。最终矩形边界、内部 UV、透明度和 mask 覆盖都要正确，不以多细分网格近似代替未压缩的图像展开语义。

### PB-03：明确定义程序空间输入

E0 应把以下语义写成现行合同与公共类型后再实现；已选定的 `hasAnchor` / `anchorWorldPosition` 见程序合同，不由 Arts 传入私有 uniform。

- `data.uv`：最终图像矩形的原始 `[0,1]` 坐标，独立于 pivot、视口裁剪与 upper-field 压缩；atlas 内缩与帧选择继续由程序执行。
- `data.screenUv`：最终视口、左下角原点的归一化坐标；沿用 CSS/buffer、DPR、host 偏移和 source expansion 口径，不额外执行一次投影。
- 面片世界锚点：增加或通过正式通用输入提供只读世界锚点，供距离淡化等程序使用；不能把每个片元的世界坐标误当共同云中心。
- `data.worldPosition`：对 anchor-extent 程序面片，明确为最终片元反向射线与锚点 view-depth 平面的交点，与现有 display-hit 代理一致；它不是未变形实体表面。不得伪装成具有真实体积的云表面。
- 其他已有 mesh/background 的 `worldPosition`、UV 和 ray 含义保持不变；新增锚点输入在非面片路径中的可用性与默认行为必须显式定义，不能留下未初始化值或隐式意义。
- 相机矩阵、深度、ray、viewport 与视觉时间来自同一个 prepared frame，颜色与深度重复绘制不产生第二个时间样本。

### PB-04：颜色、alpha 与过滤不退化

程序面片复用现有程序命名 sampler 的 sRGB 解码、线性关联过滤、source alpha 编码归一化和 straight RGBA 输出约定。程序不重复 gamma 或乘 alpha；材质 tint/opacity 和最终混合只应用一次。

至少用引擎自有透明边缘、彩色透明像素、纯色卡和多帧 atlas 测试 straight 来源＋关联过滤及已预乘来源；atlas 内缩、翻转、minification、mipmap 开关必须保留。不能通过忽略 alphaSampling、改源编码标志或更换成有底色图片绕过问题。

### PB-05：深度、排序、查询与批处理

颜色、mask 和选择性深度保护重绘使用同一 pivot/矩形/UV；所有片元继续采用锚点深度。保留 Material-owned depthTest/depthWrite，不把云设成永远盖住地形的屏幕覆盖层。

CPU bounds、exact pick、proximity、offscreen extent、near/behind/far 和公开 hit/project 往返都使用最终矩形。普通查询仍不猜测产品角色，矩形代理仍不承诺逐 alpha 像素拾取。

透明程序面片初期保持 ordinary 排序路径，与外部透明物体正确交错；不为了增加云数量强制进入不能交错的实例批次。若实现者同时提供其他合法批处理组合，必须补对应 ordinary/batch parity、pivot 指纹和实例参数隔离测试；不能暗改现有程序 mesh 的批处理资格。

### PB-06：类型化动态参数与时间

将新程序面片纳入现有 `setProgramParameters` 目标识别、单 Behaviour owner、整包校验、release、retained Prefab reconciliation、失败恢复及 backend rebuild。无需把纯显示变化回写 catalog 或 authority。

独立 timeChannel 的暂停、速率、定格、全局暂停和相位连续性保持既有行为；隐藏、暂停或资源失败的面片不应独自维持无用连续绘制。云风向与运动算法不是本次引擎内置能力，不能借此开放任意顶点代码。

### PB-07：完整生命周期、错误与预算

程序/材质/纹理按已有 ResourceManager lease、generation 和 AbortSignal 管理。覆盖 pending load 时删除、同身份重建、资源替换、共享纹理复用、恢复后重挂与幂等释放。

GPU 程序失败沿用当前按 resource/revision 隔离的行为，不绘制、不拾取、不循环编译；健康对象继续显示，合法 ACK 继续推进。非法 Display 描述仍在同步屏障失败。通用 terminal/device 失败不伪装成一片云的局部失败。

复用现有投影缓冲预算，不新增每云 RenderTarget。采样归一化缓冲与材质实例应有可核验释放证据。性能分别报告 CPU 提交、绘制调用、透明覆盖、纹理/目标内存和测试设备；不把 CPU 提交时间当 GPU 帧耗时。

## 5. 执行顺序与阶段门槛

| 阶段 | 工作与主要入口 | 退出条件 |
| --- | --- | --- |
| E0：冻结公开合同 | 本文＋display/render-runtime/procedural-programs；决定闭合资源联合、pivot、锚点输入、worldPosition 和版本策略 | 所有字段均有唯一语义、非法组合和测试表；不以“以后再接程序采样”缩减范围 |
| E1：Display 数据与参数链 | `render/components.js`、`render/render-system.js`、`render/program-input-system.js`、`src/index.d.ts`、资源校验与 types interop | 普通分支不回归；程序分支资源/参数/事务和行为释放测试通过 |
| E2：Backend 表示组合 | `anchor-extent.js`、`program-material.js`、`resources.js`、相关查询/资源管理 | 程序 sampler＋pivot＋统一矩形/UV/深度/查询一起工作，生命周期与失败隔离测试通过 |
| E3：真实 GPU 与回归 | 现有 anchor/program/program-frame/texture-alpha fixture 扩展，或同正式 runtime 的新通用组合 fixture | 第 6 节全部必要组合有真实证据；旧 upper-field、fixed-panel、程序 mesh/background 不退化 |
| E4：发布与交接 | 当前合同、公开类型、package tuple、打包与只依赖已打包产物的 consumer smoke | 第 7 节交付完整；Arts 源码和依赖仍不由本轮自动修改 |

E1 与测试夹具准备可在 E0 完成后并行；E2 不能跳过 E1 的公开数据合同。E4 不能只引用旧 `anchor` 与旧 `program` 各自通过的结果，必须包含新组合能力的 GPU 测试。

## 6. 必须通过的验收矩阵

以下为本轮 Engine 验收条件。2026-09-07 已完成通用实现、真实 GPU 验证及本地打包；覆盖入口见第 6.1 节，已知边界见第 6.2 节。

| ID | 检查组合 | 通过条件 |
| --- | --- | --- |
| T01 | 普通 Sprite 默认 geometry、旧 anchor-extent | 省略新增字段时保留原位置、UV、alpha、查询与有效类型 |
| T02 | 程序分支＋非法资源/参数/pivot/固定面片组合 | 同步拒绝且不暴露部分候选；错误码有界；合法 ACK 不被 GPU 工作拖住 |
| T03 | 透视/正交 × identity/upper-field × 中心/底部/偏底 pivot | 真实 GPU 的四边、四角与目标矩形偏差不超过 1 CSS px，且尺寸仍服从所选相机距离规则 |
| T04 | 跨压缩起点、原始 NDC 顶部以外、最终视口四边、中心在屏外 | 不丢失仍可见片元，不拉伸 UV，不跨越逆投影奇点；near/behind/far 规则一致 |
| T05 | UV 色块网格、atlas 多帧与非对称图案 | 最终矩形内部 UV 正确，不止中心和边界正确；裁剪/pivot 不造成倒置、拉伸、串帧 |
| T06 | 同 sampler 的程序 mesh 与程序面片；两种 source alpha 编码 | 相同纹理/程序/输入输出颜色与 alpha 一致；关联过滤、透明彩边、opacity 不回归 |
| T07 | DPR1/2、1280×720、1920×1080、720×960、host 移动与 resize | final screenUv、CSS/buffer、片元 ray、锚点输入同帧正确；投影预算超限明确拒绝 |
| T08 | exact pick/proximity、边界/角部及 display-hit 往返 | CPU 可见矩形与 GPU 一致；查询不承诺 alpha-hole picking，不重定义通用 world-point project |
| T09 | blend/mask、普通外部透明物、protected 深度重绘 | 遮挡与排序一致；无重复 alpha/tint；depth flags 按正式材质声明执行 |
| T10 | 多实例/共享 Resource、参数更新、Behaviour 禁用/移除/重建 | 参数隔离，非法更新不部分生效，保留/释放规则一致，不因数字变化重编译纹理/程序 |
| T11 | 独立暂停/速率/定格、全局暂停、隐藏和 fresh backend rebuild | 同相位图像可重复，恢复连续；无第二时钟/RAF；隐藏或暂停不维持无用绘制 |
| T12 | pending 删除、替换、故障程序与健康对象并存、dispose | 无迟到复活/资源泄漏，局部隔离边界正确，后续合法状态仍能确认 |
| T13 | 目标消费者预期的低/中/高密度透明面片档位 | E0 冻结档位和机器信息；报告 draw/覆盖/内存与实测时间，不强制不正确透明批处理，不凭空宣称 FPS |
| T14 | 普通 mesh、GLB、fixed-panel、粒子、sky/water 类程序背景/表面 | 既有统一投影与深度流程不退化，不引入额外 Scene/Camera/RAF/每云目标 |
| T15 | 已打包 release 的独立 consumer | 仅从公开 package root 导入即可构建并渲染新组合；无 sibling src、私有模块或产品仓依赖 |

引擎 fixture 使用自有矩形、透明图案和程序，不复制 Arts atlas、云数量或布局。1 CSS px 是轮廓一致性门槛，不是云美术构图标准，也不保证每种设备的性能。

### 6.1 实际验证入口

| 覆盖 | 本轮验证 |
| --- | --- |
| T01–T02 | `npm test`：Client 51、Display 267、renderer 105 项通过，另含公开 TypeScript 与资源生命周期检查；Sprite normalizer、完整 Prefab 候选与直接 Component 修改均在同步边界拒绝非法组合 |
| T03–T09 | `--fixture=program-sprite`：1280×720、1920×1080、720×960，各 DPR 1/2，六组全部 READY；每组含透视/正交、identity/upper-field、三种 pivot、四边裁剪、atlas、UV/空间输入、查询、alpha、mask、深度与排序 |
| T10–T12 | 同一组合 fixture 验证共享资源下的参数隔离、暂停/定格/恢复、backend rebuild、故障程序隔离与替换；Display/renderer 测试覆盖 Behaviour 生命周期、事务恢复、pending 删除和资源释放 |
| T13 | `--fixture=program-sprite-scale --bindings=32\|128\|512 --ticks=120 --update-ratio=0.1 --viewport=1280x720 --dpr=1` 三档逐次运行通过；每次参数选择一个 bindings 数值。CPU 提交分布、透明覆盖、draw calls、目标内存和设备由 stdout JSON 返回 |
| T14 | `npm test` 及真实 `upper-field`、`anchor`、`program-frame`、`program-batch`、`texture-alpha`、`generated` fixture 通过，复用既有 mesh/GLB/fixed-panel/粒子/背景与深度路径 |
| T15 | `node scripts/verify_far_sea_package_consumer.mjs --client=... --display=... --renderer=... --browser` PASS；仓外临时目录只安装实际 tarball，公开类型、runtime smoke 和同一程序 Sprite GPU fixture 全部通过 |

Windows runner 通过 `SCENE_ENGINE_BENCHMARK_CHROME` 指定实际 Chrome；本轮设备为 Intel Arc / ANGLE D3D11，Chrome 152。
完整命令用法见[测试索引](../tests/README.md)。组合 fixture 轮廓按线性覆盖的 50% 等值线量测，验收阈值保持 1 CSS px；
六组最大误差小于 0.49 CSS px，内部 UV 与公开 hit 往返均通过。旧 upper-field fixture 已改正 sRGB 阈值及像素中心量化偏差，并保留同帧旧量测值便于核对。
runner 只输出 JSON，不新增持久化性能报告。`--evidence` 可附实际 GPU PNG，代表图随本地包提供。

### 6.2 已知边界

- 程序 Sprite 保持 ordinary，每个可见面片需要单独 draw；规模测试测量的是本机 CPU 提交时间，不能解释为 GPU 帧耗时或跨设备 FPS 保证。投影目标仍为全场共用，其预算由现行后端合同约束。
- identity 与 upper-field 的既有透明混合目标色彩空间不同，重叠透明片亮度可能不同。本轮证明同一 profile 内程序 mesh/Sprite 的颜色及 alpha 一致，未改全局混合管线；详见[渲染合同](../render-runtime.md)。
- 本轮覆盖程序编译故障的局部隔离；URL 加载或生成纹理上传失败继续遵循既有后端健康/重建流程。原 Far Sea 的“全部资源错误局部隔离”仍未关闭。
- 通用矩形查询不承诺逐 alpha 像素拾取；Arts 的生产素材、云布局和完整产品场景验收仍待用户通知后执行。本轮未修改 Python，工作树原有录制改动的 Python 测试未在本机运行。

## 7. 引擎完成后必须交付给 Arts 的内容

- [x] 最终 Display/renderer-three package 版本、包文件、完整性 hash 和可复现安装方式；发布边界只涉及实际变更的包，不无故升级 Wire/Client/Python。
- [x] 现行合同与公共类型：程序面片声明、pivot、锚点、图像 UV、worldPosition、动态参数、透明度和错误限制。
- [x] 一个仅用公开包与通用素材的最小示例：程序材质＋关联过滤＋anchor-extent＋偏底 pivot 必须在同一个对象上生效。
- [x] T01–T15 的命令、配置、设备、通过/失败记录；新 GPU 测试的图像、矩形误差与内部 UV 证据。
- [x] 资源故障、取消/释放、参数隔离、定格与 rebuild 的证据，以及已知性能和批处理限制。
- [x] 记录仍未覆盖的组合；如果程序采样或 pivot 尚未接通，状态继续为未完成，不交给 Arts 用局部公式补偿。

本地交付位于 `dist/program-sprite-0.21.0/`（忽略的构建产物目录）：Display 0.21.0、renderer-three 0.18.0 及未改版本的 Client 0.16.0 tarball、`SHA256SUMS`、安装说明和两张实际 GPU 图像。最小声明示例在[程序合同](../procedural-programs.md#program-sprites)，完整可运行示例复用组合验收 fixture。本轮没有向 npm registry 发布。

交付之后，用户通知 Arts 继续。Arts 先验证实际安装产物包含本能力，再按[云层修复计划](../../../arts/resources/environment/cloud/studies/far-sea-v10/cloud-layout-repair-plan.md)执行。引擎通用验收通过不等于云层构图已经修好。

## 8. 本计划明确不做

- 本轮实施 Engine 工程项并同步其版本、锁文件与合同；不修改 Arts 已安装包、vendor、Prefab、atlas、布局或 current profile。
- 不把原云层压扁、中心排布和高度乘数当成引擎通用参数；不在 Engine 内置产品名字、云族、岛形或地图尺度。
- 不自动开始后续美术工作，不创建监控、定时续跑或完成通知自动化。
- 不扩大为真实海岸场、云影、完整风场、GPU 场生成或通用 render graph 项目；这些仍按原专项需求处理。
