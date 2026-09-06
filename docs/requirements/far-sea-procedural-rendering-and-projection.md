# 远海程序渲染与全场景上部投影压缩需求

- 状态：**partially implemented（统一投影与程序资源已实施，完整需求及验收尚未关闭）**。
- 日期：2026-09-06。
- 实施版本：Display `0.21.0` / renderer-three `0.18.0`。统一投影、公开查询、程序材质/背景、类型化参数、同 Node 视觉参数写入、程序批处理、全局/独立视觉暂停、CPU 生成纹理、锚点展开及 alpha/sampler 已实现。Engine 通用能力与 Arts 完整海岸/云运动视觉验收分别记录，不能互相替代。
- 已确认决策：Missile War 全部场景、全部世界渲染着色器适配统一 upper-field projection（画面上部投影压缩）。启用目标已经批准，不再保留“是否启用”的待确认项。
- 当前有效行为仍由 [Display](../display.md)、[渲染后端](../render-runtime.md)、[指针交互](../pointer-interaction-plan.md)和[显示动画](../display-animation.md)合同定义。已发布字段以现行合同和公共类型为准；本文未落实的建议字段仍是目标。

## 1. 目的、配套文档与职责

目标是让 Arts 通过正式声明式资源，在唯一 DisplayRuntime / RenderBackend 内表达 `far-sea-v10.html` 默认采用的 V09 海水、程序天空及云环境，并使地形、建筑、GLB、固定面片、粒子、特效、深度和交互遵循同一投影。只给环境材质增加压缩不能完成本需求。

配套文档：

- [Arts 投影标准与全场景推广计划](../../../arts/docs/architecture/far-sea-v10-projection-standard-and-rollout-plan.md)：负责美术标准、场景覆盖、视觉验收及资源接入次序。
- [真实海岸与浅水适配计划](../../../arts/resources/environment/ocean/studies/far-sea-v10/shoreline-adaptation-plan.md)：负责项目地块、海岸、浅滩、岸浪与云避岛的数据制作，等待后续实现。

配套链接用于跨仓需求协调，不构成 Engine 代码或测试对产品仓的依赖。

云层复查暴露的组合缺口另见[程序化面片与锚点展开调整计划](program-billboard-anchor-extent-plan.md)：程序材质、关联 alpha 采样、anchor-extent 和图像 pivot 已在同一 Sprite 表示接通，并通过真实 GPU 矩阵与隔离 tarball 消费者验证。Engine 包已在本地交付；Arts 仍等用户通知后继续。

本需求阶段的正逆公式、有效域、模式语义和 CPU/GPU 一致性合同只在本文详细维护。Arts 文档引用本文并记录所选参数，不复制公式或 renderer 实现合同。实现发布时，将这些合同转入 Engine 对应现行专项文档，并把本文改为链接及完成状态，避免维护两套权威说明。

Engine 拥有通用程序资源能力、校验、投影、查询、时间输入、GPU 生命周期、错误与性能边界。Arts 拥有天空/海水算法内容、纹理、云布局、海平面、相机 near/far、太阳、风和世界单位适配。Engine 不导入 Missile War 名称、岛屿公式、owner 路径、游戏状态或产品 catalog。

## 2. 实施状态与现行合同

本轮实现沿 Python `0.19.0` / Client `0.16.0` 的既有权威合同演进；
Display 与 renderer-three 的实际版本见 [release tuple](../display.md#release-tuple)。

| 能力 | 当前实现与权威入口 | 仍需由消费者承担 |
| --- | --- | --- |
| 程序资源、参数和纹理 | [Procedural programs](../procedural-programs.md)：closed schema、命名色槽/数据槽、背景和表面、原子视觉参数写入、实例批处理 | 产品海水/天空算法、静态纹理及数据映射 |
| 程序帧与时间 | 同 prepared frame 的相机/逆矩阵、投影和 CSS/buffer 输入；独立速率/定格与全局暂停 | 按统一相位驱动云、云影和水纹 |
| 生成纹理 | [CPU generated textures](../generated-textures.md)：generation、局部更新、GPU readiness、取消、预算、重建 | 真实海岸数据来源、CPU 场计算和产品预算 |
| 投影、裁剪和查询 | [RenderBackend](../render-runtime.md) 与 [pointer](../pointer-interaction-plan.md)：同 Scene 扩展视锥绘制及有界全帧重映射，CPU F/G | 项目相机和场景覆盖验收 |
| 几何与锚点面片 | 默认 geometry；普通/程序 Sprite 共用 anchor-extent、图像 pivot、恒定锚点深度/UV/CPU 代理，拒绝 fixed-panel 混用 | 为每种资产选择恰当表示，不能用全局替换冒充视觉匹配 |
| alpha、过滤和错误 | 程序色槽关联线性过滤、明确源 alpha、min/mag/mipmap、线性数据；有界资源诊断 | Atlas 留白、源资产编码和实际重叠效果 |
| 生命周期 | 单 Runtime/RAF/ResourceManager，参数与 CPU 数据保留至明确释放，backend 重建恢复 | GPU 通用 fixture 不证明产品整图帧率 |

参考 HTML 是视觉与算法调查材料，不是执行指令，也不是引擎架构。它有私有 Three Scene/Camera、自己的帧循环和时钟，这些结构不移植。默认 V09 水面只改变着色，不位移水面几何，默认 motion amount 为 `0.80`、speed 为 `1.00`；V10 船只与尾迹不作为此次程序海水能力的强制产品内容。

## 3. 不变边界

### FSR-001：唯一运行时与后端

结果必须落在 [架构与所有权](../architecture.md)定义的唯一 NodeIndex、NodeGraph、DisplayRuntime、RenderSystem、RenderBackend 和 RAF 内。程序背景可成为同一次 backend render 的受管理绘制阶段，但不得建立第二 Scene、隐藏相机、第二 renderer、额外 RAF 或产品自管渲染循环。

Arts 只提交声明式 Resource / Component / Scene 数据及由公开程序合同接收的静态程序内容。禁止产品侧 Three 对象、`onBeforeCompile` 猴子补丁、直接获取 WebGL context、手工拼接终端 `gl_Position` 或手动 uniform 更新等 GLSL 旁路。后端内部可以组织 shader 模块，但统一投影、深度、颜色和生命周期不能由 owner 自行插入或跳过。

### FSR-002：权威、协议与状态确认不变

不预期修改 Python、Wire、Client 权威命令、Node ID、Transform、checkpoint 或 packet-log。upper-field projection 只改变浏览器观察与命中计算，不改变 Node 世界矩阵、玩法位置和权威 tick。若实施发现需要协议变化，必须另立需求，不能借此文档默许扩大范围。

继续遵守 [Runtime 与 60 Hz](../runtime.md)：同步定义/状态校验属于 Display 事务边界；资源下载、GPU 编译、绘制和视觉观察不参与 ACK。程序资源失败不能改变已确认的玩法状态。

## 4. 程序材质、程序背景与资源要求

### FSR-010：公开、声明式、足够表达 V09

应提供可注册、可版本化、可描述并参与 catalog identity 的程序资源。程序表达至少支持纹理采样、多尺度噪声、世界坐标计算、相机射线、射线与平面相交、条件分支、有限循环、数学函数、导数或等效的像素足迹估计，以及线性空间颜色与透明度输出。

必须能通过公开资源表达以下组合，不以“内置 water 近似”作为通过依据：

- 程序天空渐变、水平线与空气透视；天空和海面以同一相机射线连续衔接。
- 与项目世界坐标对齐的固定海床/浅水色区；动态局部水纹、稀疏微光、岸浪及云影。
- 海床、大尺度色块、岸线保持固定，局部表面着色随视觉时间变化；水面保持平面。
- 海水可选择明确的 `depthTest=false, depthWrite=false`，云可选择 `true/false`；保持当前禁止 `false/true` 的材质约束。

程序语言、模块格式和实际 schema 由实现设计确定。若选择受版本管理的 GLSL 模块，仍须通过公开 Resource 注册与引擎编译流程，声明允许的输入/输出，并由引擎掌握投影和颜色终端；不接受 owner 提交任意完整主渲染流程。首版无需发展成任意 pass graph 或通用着色器编辑器。

### FSR-011：typed params / textures

每个参数显式声明类型、默认值、合法范围和可更新性；至少覆盖有限 float、integer、boolean、vec2/3/4、颜色、具有固定上限的数组与纹理槽。相机矩阵等引擎输入是保留的只读输入，不作为可被 Arts 覆盖的普通参数。

纹理输入按名称绑定 Resource ID，并声明输入用途和采样要求。不得依赖“第几张纹理恰好是海床”这种隐含排序。校验类型、向量长度、数组上限、缺失/多余字段、非有限值、纹理 kind、引用环及不受支持的组合；在资源/目录编译或对应 Display 状态提交前完成可同步判断的校验。

静态程序结构与动态实例参数分离。实例参数变化不能修改共享材质，也不应每帧触发 shader 编译或全量 batch 重建。程序版本、内容身份、参数 schema、纹理引用及采样语义必须进入可重复的资源/目录身份；仅 URL 相同不足以证明内容相同。

### FSR-012：统一 frame、camera 和 viewport

所有程序消费同一个 prepared frame：共享视觉时间、有效相机及逆矩阵、相机世界位置、投影模式及参数、viewport 原点与尺寸。须同时区分 CSS 像素和 drawing-buffer 像素，处理 DPR、嵌套 canvas、resize、相机切换与截图尺寸。

CPU 查询、所有 draw pass、背景射线以及需要重建世界坐标的深度采样不得读取不同版本的相机或 viewport。相机改变后，查询准备状态和下一个画面的更新次序必须明确；禁止画面使用新相机而点击仍使用旧相机。

### FSR-013：程序背景与平面海水

程序背景通过最终屏幕坐标重建未压缩的相机射线；满屏 primitive 自身覆盖最终 viewport，不再做几何压缩。必须使用第 6 节的 inverse，不能同时压缩满屏顶点再 inverse 射线。

应能表达水平面高度参数、无正向交点时的天空分支、近水平射线的稳定处理、正交相机的平行射线，以及与主相机颜色/深度合成的确定顺序。背景只有一个明确的组合入口，不允许 sky 与 ocean owner 各自创建满屏 renderer。

平面海水的世界相交距离与几何 near/far 是否相同是绘制域合同：本目标允许背景海水作为延伸到地平线的环境层，不依靠远裁面产生海天线；有限距离的云和实体仍按主相机 near/far 裁剪。背景算法不能因此生成无界数值，须在接近水平时稳定进入远海/天空极限。背景不自动成为可拾取物体；若后续需要海面输入，应使用同一射线与显式平面高度求交。

### FSR-014：生命周期、共享和重建

资源依赖、下载、编译、纹理上传、参数实例、GPU program、绑定和 batch 均纳入现有 ResourceManager 所有权。覆盖共享引用、AbortSignal、generation token、迟到完成、取消、同 ID 销毁重建、实例克隆隔离及幂等 dispose。

仅数值参数变化不重复加载纹理；隐藏资源不能继续无意义采样或维持 requested-mode 帧循环。异步替换须原子呈现一个完整可用版本，移除后不得迟到挂回。backend rebuild 从 Display 声明和保留的显示参数恢复投影、纹理、材质及相位，不修改 Node/Component identity，不重置全局程序时间。

### FSR-015：错误边界与诊断

定义错误、参数/纹理不匹配、非法投影和确定可知的不支持能力应在 Display 暴露候选前拒绝。涉及 Authority 状态解析的非法候选沿现有事务失败路径处理，不能 ACK 后等到 RAF 才发现结构错误。

下载、GPU 编译/链接、设备限制和 context loss 属于资源/后端健康错误：定位到 Resource ID/revision、程序阶段、参数槽或 binding，提供有界诊断，按现有健康流程处理。不得每帧无限重试、输出海量完整 shader，或无提示回落为标准投影、默认蓝色水面并声称验收成功。局部资源失败应隔离受影响绑定；无法维持一致投影的后端故障停止该后端并进入明确恢复流程。失败不回滚已 ACK 的合法玩法事务。

### FSR-016：色彩、alpha、过滤与 mipmap

颜色纹理声明 sRGB，进入着色计算时只解码一次；mask、距离/深度、噪声、海床数据通道、云影权重等按用途声明线性数据，不应用 sRGB 曲线。海床若存的是已绘制颜色，其颜色通道仍应声明 sRGB；不得仅凭文件叫“seabed”判断所有通道都是数据。

程序在引擎定义的线性空间计算，由引擎统一完成 tone mapping / 输出转换。参考中的 `pow(2.2)` 和手工 gamma 输出不能原样叠加到现有颜色流水线上。

纹理需区分源像素是否已预乘、解码/上传是否预乘、shader 输出是否预乘及 blend 约定，确保只预乘一次。分别定义 min/mag filter、mipmap 生成、wrap、atlas 边缘留白与低 mip 串色规则；云边缘在放大、缩小、透明度变化及不同背景上均不得出现黑边、白边或亮度跳变。Engine 提供明确能力，Arts 决定每份资产的声明和生产处理，不能用调整相机 far 解决 alpha 错误。

### FSR-017：海岸表示路线触发的生成资源增量（CPU 路线已实现）

若 Arts 的海岸方案选择 world-derived texture、CPU 距离场或 GPU 距离场，须在接入前补齐相应生成资源的公开合同。现有 URL texture 与新 generated-texture 是不同资源类型；CPU 路线的当前 API 见 [生成纹理合同](../generated-textures.md)。反复创建 data/blob URL、替换 URL 或直接修改 Three Texture 不能替代该合同。

触发时至少需要声明：生成资源的注册与类型/尺寸/格式/数据用途；输入世界数据与 generation/revision 的关联；生成任务所有者及调度阶段；局部更新区域、合并和原子可见性；依赖就绪与可采样状态；取消、迟到结果丢弃和销毁；CPU/GPU/上传/内存预算与超限行为；backend rebuild 后重新生成或重新上传的来源、就绪与恢复语义。生成任务不能另起 RAF 或拥有游戏世界，GPU 生成也必须在现有 backend 调度内；资源就绪仍不阻塞合法玩法 ACK。

这是依赖海岸表示路线的增量门槛，不是首阶段必须实现通用 render graph 的要求。若最终采用现有公开资源可以完整表达的静态预计算输入，可不触发动态生成能力；若采用运行期生成或局部更新输入，则该能力成为海岸方案接入的前置条件，不能标记豁免。CPU 与 GPU 路线仅实现所选路线必要的公开能力；公共生命周期、错误与恢复行为必须一致。Arts 在 P0 选定路线后记录 FSR-017 是否触发及预算测量结果，Engine 据此确定本项发布范围。

## 5. 共享显示时间

### FSR-020：唯一时间输入

程序动画唯一时间来源为 Display 的 `visualSeconds`；`deltaSeconds` 只是该时间相邻样本的派生差值，不能成为 renderer 另一个自主累计时钟。程序资源、Arts Behaviour 和 backend 不直接调用 `performance.now()`、`Date.now()` 或采样 `sourceTick` 推进水纹与云。

现有 Display 的帧调度器可在内部读取调度时间以产生 visualSeconds；本需求禁止的是消费者绕过这个公共时间源。视觉运动不产生 gameplay facts，也不要求不同客户端或历史 Replay 自动达到像素相同的相位。

### FSR-021：暂停、独立速率、定格与恢复

共享 Display 时间/支持的显示参数应表达全局暂停、指定 visualSeconds 定格，以及水面局部运动和云漂移的独立速率/暂停。暂停保持当前相位，恢复连续；改速率不使相位跳到另一时刻。云影跟随所选云运动相位；暂停水纹不默认冻结云影。

如需速率变化的相位偏移或暂停基准，该状态由 Display 的共享视觉支持管理，在现有帧流程中计算最终采样值。它们是同一 visualSeconds 的派生显示参数，不是第二个墙钟，不是 renderer-private playable timeline。需要扩展 Animator 时，沿现有封闭通道设计扩展；不能声称当前 sprite-only Animator 已支持这些通道。

同一 runtime 内 backend rebuild、资源重新就绪或 batch 切换不得重启水云相位。整个 DisplayRuntime 被销毁重建时允许沿现行本地视觉合同重新开始；验收可重新设定同一 visualSeconds、参数、种子和资源身份恢复可比较画面。定格需保证所有 pass 使用同一时刻，资源异步到达后不会自行开始播放。所有动态关闭且无其他活动时允许 requested-mode 停止连续绘制。

## 6. 统一 upper-field projection 权威目标合同

### FSR-030：坐标、参数与正逆公式

以下公式是本需求的权威目标定义，不是当前引擎实现。NDC 的 x 向右、y 向上，viewport 顶边为 `y=1`。upper-field 仅作用于主观察相机的 NDC y；相机矩阵、世界矩阵和原始深度不被修改。

设标准齐次投影为 `c = P · V · worldPosition`，标准 NDC y 为 `y=c.y/c.w`；压缩起点为 `s`，强度为有限的 `k>=0`。定义：

```text
F(y) = y                                      , y <= s
F(y) = s + (y-s) / (1 + k*(y-s))               , y > s

G(q) = q                                      , q <= s
G(q) = s + (q-s) / (1 - k*(q-s))               , q > s，且 1-k*(q-s) > 0

c' = (c.x, F(c.y/c.w)*c.w, c.z, c.w)
```

`k=0` 为数学恒等模式，用于通用引擎未选择压缩的内容及回归对照；它不是 Arts 本次推广中的“待确认开关”。已选择 upper-field 的 Arts 场景中，任何世界着色器都不得私自使用恒等模式。

F 在接点连续且一阶导数连续，严格单调；上段导数为 `1/(1+k*(y-s))²`。`k>0` 时 F 的上界是 `L=s+1/k`，有限 y 不到达 L。G 只在 `q<L` 的上段有效；不能采用参考代码 `max(denominator, .01)` 把域外输入强行钳成某条射线，该处理不具备真正的双向可逆性。

参考透视相机的水平地平线映射仅在无 roll、标准对称透视、向下俯角 p 的条件下使用：

```text
H = tan(p) / tan(verticalFov/2)
k = 1/(h-s) - 1/(H-s)

p = 35°
verticalFov = 34°
h = 0.79
s = 0.10
H ≈ 2.290275659835563
k ≈ 0.9927118263504608
F(H) = h
顶部留白比例 = (1-h)/2 = 10.5%
```

此派生方式要求 `s<h<H` 并满足下节完整 viewport 有效域。p/FOV/h/s 是参考构图参数，不是引擎产品默认值。运行时统一消费已校验的投影模式及规范化参数；若公开支持目标地平线高度模式，其派生计算也必须由引擎同一实现提供。不能在 Arts 或多个 shader 中分别推导 k。相机 FOV/pitch 改变时，明确保留显式 k 或重新求目标 h 的模式，禁止模糊混用。

### FSR-031：有效域、near/behind 与裁剪

注册/更新时校验所有数值有限、`-1<s<1`、`k>=0`。首版压缩配置必须让完整可见 NDC 区间 `[-1,1]` 可逆；要求 `1-k*(1-s) >= 0.01`，并把这个安全裕量作为版本化合同而非 shader 的临时钳制。参考配置满足该约束。内部浮点零判定采用 CPU/GPU 一致常量；验收以第 9 节屏幕误差为准。

最终屏幕外的指针坐标仍可能超出 G 的有效域。直接 ray 查询遇到域外或非有限派生结果，返回明确的有界投影域错误，不能返回 NaN/Infinity；指针控制器将可预期的域外情况作为无命中/无法产生移动样本处理，保留已有 drag cancel/drop 生命周期，不把它当作 backend 损坏。缺少相机、非法输入结构仍沿现行错误合同。

透视几何先处理有效的相机前方区域及 near/far，再进行非线性除法。不得对 `w≈0` 或 behind-camera 顶点直接计算 G/F，或只把单个顶点扔到屏幕外导致三角形横穿全屏。跨 near/眼平面的 primitive 必须稳定裁剪；不能因一个顶点在后方而丢弃仍可见的整片几何。正交相机虽 `w=1`，也必须通过 view depth 判定 near/behind。

最终 x/y 屏幕裁剪按压缩后的范围执行。原始 `y>1` 的几何可能经 F 进入画面，不得提前用标准主相机上裁面剔除。应使用保守的逆映射观察体、正确变形后的 bounds 或等效保守策略；普通对象、GLB、batch、粒子及锚点展开后的 sprite 均需覆盖。不得只关闭少数 owner 的 culling 作为通用解决。

保留标准主相机深度含义及 near/far；不能用 warp 改写世界距离或偷偷扩大 far。无穷远地平线属于背景射线层，有限云朵和实体不豁免远裁剪。

### FSR-032：所有世界绘制路径及 double-warp 防止

统一投影必须成为引擎编译/渲染管线中的终端阶段，不能让各材质手抄公式。对于所有已支持的世界 drawable，包括后续新增 shader，必须显式归属一个受支持的投影语义：

| 路径 | 目标语义 |
| --- | --- |
| standard / unlit / 自定义程序 mesh | 世界/视空间顶点处理完成后使用 F |
| GLB 导入材质及材质 override | 覆盖加载产生的全部材质与当前支持的顶点变形组合，不因异步加载、clone 或材质替换漏装 |
| 普通 Sprite / decal / fixed-panel | 按 FSR-033 的显式模式处理，不按 owner 名推断 |
| InstancedMesh、sprite batch、其他受支持 batch | 与普通表示一致的投影、锚点、可见性、资源和深度，切换不能跳变 |
| surface.standard / surface.water / 新程序 surface | 几何表面使用 F；射线背景式表面按 FSR-013 使用 G |
| particle、effect、ribbon、trail、光晕等世界表现 | 明确真实几何或锚点展开模式，顶点位移/展开顺序与 CPU 代理一致 |
| 主相机 depth / depth-only / selective-depth protected 重绘 | 同一顶点阶段、projection、alpha test、discard 和 depth-write 语义 |
| 主相机深度采样/重建、屏幕空间遮挡计算 | 已在最终屏幕坐标上取样；重建世界射线使用 G，不再次 F |
| ray background | 满屏覆盖只执行一次，射线使用 G；不对满屏 primitive 做 F |
| screen HUD | 屏幕布局不做几何投影；world anchor 必须来自统一 project 查询 |

对未实现的粒子/特效种类不要求新增玩法内容，但新增世界 shader 的实现必须接入此表的投影合同。编译缓存键和相关变体包含投影语义，禁止以遗漏 variant 换取部分画面“基本一致”。禁止在世界顶点已经 F 后再用全画面后处理 F，或在锚点已 F 后又压缩展开尺寸。

### FSR-033：真实几何、固定面片和锚点展开的区别

至少定义以下两个通用语义，名称在第 10 节只是建议：

1. **完整几何投影**：先完成模型/实例变换、受支持的局部变形以及现有 fixed-panel 离轴补偿，再对最终各顶点执行 F。固定朝向、脚点锚定、pitch 缩短和距离缩放沿现行 fixed-panel 合同保持；上部压缩是其后的共同观察变换。
2. **锚点投影后展开**：先标准投影锚点并执行 F，再按明确的视空间 billboard 尺寸展开局部 xy。参考云采用这一方式，远云位置压到地平线而自身高度保留。尺寸单位、锚点偏移、朝向、投影缩放、depth/near 裁剪及 bounds 必须显式声明，不从云 owner 或纹理名称猜测。透视尺寸随锚点深度缩放，正交尺寸按正交跨度缩放；不是固定 CSS 像素尺寸。

锚点模式的局部尺寸不再做 F，因此不能把它当成“对原世界 quad 每个顶点执行 F”。fixed-panel 默认采用完整几何语义，不自动改为云式 billboard；初版应拒绝未明确定义的“fixed-panel 离轴补偿 + 锚点展开”组合，避免为了保云尺寸破坏建筑脚点与俯角。模式是公共几何/渲染合同，不能按产品、owner、Node 前缀或 composition group 分支。

锚点模式以锚点 view depth 为基准，锚点在 near 前或 behind 时整片不可见；锚点在屏幕外但展开区域进入 viewport 时仍应保留。真实几何模式逐 primitive 裁剪，不沿用这个整片裁剪规则。

### FSR-034：非线性曲边、插值与巨大三角形

只改变三个顶点的 clip y 后让 GPU 做线性三角形光栅化，并不等价于对三角形内部所有点应用 F；大海面、地形大面、长尾迹和跨 s 的 primitive 会产生曲边近似、UV/世界位置/深度插值误差，且与 inverse ray 命中不一致。

实现必须给出通用的有界误差方案，例如受管理的细分、参数化几何分段或可证明等效的采样方式，并在共享资源生命周期内处理其成本。不能仅在某个 Arts 岛模型上临时加顶点，或声明“公式一致”就忽略光栅化误差。背景射线海水可避免其自身大平面的该项误差，但不能豁免地形与其他世界几何。

目标是：已声明支持的 viewport、相机参数和几何规模范围内，可见锚点、最终轮廓及边缘相对数学投影的误差不超过 `1 CSS px`，CPU 命中回投影与可见像素误差不超过 `1 CSS px`，与 Arts 主计划的锚点目标一致。测试必须覆盖跨 s、屏幕上沿、近相机、大三角形内部和深度插值；不能只测物体中心或顶点。若预算内不能满足，应有界拒绝相应配置或报告明确不支持，不能静默降级投影。

### FSR-035：正交相机

正交相机仍支持同一 F/G 的 NDC 变换，但没有可用 `tan(p)/tan(FOV/2)` 求得的有限透视地平线。对正交相机采用显式 s/k 模式，禁止读取不存在的 FOV 或假设背景射线从同一相机位置发散。把“透视目标地平线模式”直接配给正交相机应在校验时拒绝，不静默关闭 warp。

screen ray 先对屏幕 y 应用 G，再用正交 inverse projection 得到随屏幕位置改变的 origin；所有射线 direction 平行。程序海面、project、pick、bounds、sprite 尺寸和 focus 都按该语义验收。现有 fixed-panel 离轴补偿在正交相机仍为恒等步骤，但上部压缩继续生效。

### FSR-036：主相机深度与真正灯光空间阴影

主相机 depth-only 和 selective-depth 的 protected 重绘必须与颜色 pass 一致使用 F；它们虽不输出颜色，仍表示最终主相机画面的几何覆盖，不能退回标准投影。

真正 shadow map / point-light distance map 以灯光相机为投影空间，**不得套主相机的 F**。接收材质在世界/灯光空间求 shadow lookup，再在主相机阶段输出经 F 的位置。用于主相机深度重建的逆变换与 light-space 阴影投影分别维护明确的 pass role，不以“shader 名里有 depth”统一替换。

参考 cloud-shadow 纹理是世界平面的程序遮光输入，不等于灯光 shadow map；其世界 UV 与视觉相位保持稳定。验收要同时证明主相机 depth 覆盖吻合、真实阴影没有被二次弯曲，以及 selective-depth 不重复推进时间或重复更新阴影。

## 7. CPU 查询、交互和聚焦

### FSR-040：pick / ray / project 共用投影

`screenPointToWorldRay` 对 host-relative CSS 坐标转 NDC 后应用 G，再通过当前相机逆投影构造射线；`projectWorldPoint` 对有效前方世界点应用 F 并返回最终 client 坐标。透视 ray 方向必须归一化，正交 origin/direction 按 FSR-035。函数不得暴露 Three 对象。

普通完整几何模式的拾取以逆射线与有效世界几何相交，考虑现有 panel compensation、clip、实例可见性及 FSR-034 的光栅化误差。锚点展开模式须用与最终画面一致的屏幕覆盖/UV/depth 代理求命中，不能用 G 射线直接撞原始未展开 quad。返回世界 hit point 应从该像素及命中深度按同一 inverse 重建，以保证回投影一致；它是显示命中点，不能声称是未变形原始模型表面点。

一般 world-point project 只投影输入的世界点，不猜测某张 sprite 的局部语义。面片脚点等真实世界锚点可直接调用；若后续需要 sprite 局部视觉标记，应提供明确的 binding/local-anchor 查询合同，不能给通用 project 偷加产品分支。

### FSR-041：visible、proximity、拖拽与 focus

新投影下 `projectWorldPoint.visible` 应明确表示：点在相机前方、满足 near/far、投影有效且位于最终 viewport 范围；它不表示已通过遮挡测试。当前实现只看 NDC depth，改变该语义需要同步更新现行合同、类型/测试与调用方。

对于有效但屏幕外的点，可返回有限 client 坐标与 `visible=false`；无法投影的 near/behind/奇异点，目标返回明确“不可投影”结果，不伪造 `(0,0)`、无限值或可见点。可采用 nullable 坐标或显式结果分支，最终形状需随公开类型确定；当前旧返回结构不能被当作已支持这些分支。

proximity 使用实际表示的最终屏幕 bounds/代理，距离仍是 CSS px；保持半径 `0` 与 exact pick 一致，保持 selective-depth 的保护遮挡、pass 顺序、深度和稳定身份排序。代理只反映它宣称的覆盖精度，不把正半径 proximity 伪称逐像素 alpha 精确拾取。

拖拽起点、当前 ray、世界平面求交及屏幕标记必须在同一投影下；上部压缩强处或接近水平射线时，明确“无前方平面交点”并保留手势生命周期，不能产生超大世界位移。世界 focus bounds 的适配应考虑最终投影后的视野占用，不能只用标准 FOV 的球半径估算而截掉对象；`focusWorldPoint` 继续返回建议，不在 backend 私自改变相机或拥有相机动画。

## 8. Arts 参数适配与引擎能力的界线

以下内容由 Arts 在其计划中确定并验收，Engine 提供声明能力与合法性校验，不写入产品默认值：

| 项目 | 参考/项目差异 | 归属 |
| --- | --- | --- |
| 海平面 | HTML 为 `Y=0`，现有 Arts 共享环境为 `Y=-1.45` | Arts 统一水面交点、岸线数据和物体接触关系；Engine 使用显式平面参数 |
| camera near/far 与云尺度 | HTML 相机 `.2 / 16000`；调查时 Arts far 为 `2400`，参考远云跨度更大 | Arts 决定缩放/布局和可见距离；Engine 正确执行范围与裁剪，不擅自扩大 far |
| 光照 | 参考太阳方向与当前环境不同 | Arts 统一世界方向及材质输入；Engine 保持空间定义和光照管线 |
| alpha 与颜色资产 | 参考远云有特定边缘/预乘处理 | Arts 声明和处理每份资产；Engine 保证 FSR-016 所述解码、过滤与混合 |
| 地形/浅滩 | HTML 海床、岸线与岛形绑定 | Arts 生成真实海岸输入；Engine 不移植其岛屿数组或 outline 函数为内置算法 |

更大的 far 不会修复纹理黑边；改海平面必须同步海岸数据；主相机投影压缩不会自动改变世界尺度。上述参数适配应与引擎缺口分开安排，以免把美术调参误当成引擎功能开发。

## 9. 验收矩阵

本矩阵保留跨仓目标。Engine 已运行独立数学、公开 API、事务/生命周期、类型及真实 WebGL 验证；
其中 `upper-field`、`anchor`、`program`、`program-batch`、`program-frame`、
`texture-alpha`、`generated` 为 Engine 自有 fixture。执行入口为
`node scripts/benchmark_display_browser.mjs --fixture=<name>`，DPR 2 添加 `--dpr=2`。
不得把这些通用结果写成 Arts 的真实海岸/整图视觉验收。各项的标准保持如下，覆盖与未关闭范围见表后。

| 验收 ID | 关联需求 | 输入/场景 | 通过标准 |
| --- | --- | --- | --- |
| A01 | 010–011 | 通过公开注册的通用海面程序、named textures、typed params | 能表达固定海床+局部水纹/微光/岸浪/云影，数据声明可描述、可散列；无产品依赖或私有 renderer |
| A02 | 011、015 | 错类型、NaN、越界数组、缺纹理、未知字段、不支持的模式组合 | 在所属同步边界拒绝，候选不半生效；有定位明确的错误 |
| A03 | 030–031 | s 两侧、h/H、上下边界、k=0、随机有效域样本 | 正逆往返、单调性、接点连续和导数符合合同；CPU/GPU 样本误差满足屏幕预算 |
| A04 | 030 | pitch35/FOV34/h=.79/s=.10 的相机 | 世界水平地平线在距顶 10.5%，背景与几何锚点对齐 |
| A05 | 031 | 超域屏幕坐标、非法配置、分母安全边界 | 明确拒绝或可预期无样本，无 NaN/Infinity、clamp 伪射线和异常拖拽 |
| A06 | 032 | standard/unlit、GLB 多材质、override、程序材质 | 同世界点的轮廓/锚点一致；异步加载和 clone 不漏投影 |
| A07 | 032–033 | 普通 sprite/decal、固定面片、云式锚点展开 | 每种模式符合合同；fixed-panel 脚点/俯角保留，云尺寸不被二次压缩 |
| A08 | 032–033 | ordinary ↔ batch、实例移动/隐藏、材质替换 | 切换无可见跳变、无重复 drawable、pick 身份一致、bounds 不漏物 |
| A09 | 032 | 现有 surface.water/standard、粒子与特效支持路径 | 全部 shader 使用所属投影模式；位移后位置、深度与查询吻合 |
| A10 | 013、035 | 程序背景、平面海水、透视/正交相机 | 射线仅 inverse 一次；天空/海面连续，正交 origin 正确，远海数值稳定 |
| A11 | 031 | 原标准上裁面外但 F 后在画内、near-crossing、behind/far | 可见部分不误剔除，无穿屏三角形、远裁面闪现及隐藏实例复活 |
| A12 | 034 | 跨 s 的巨大三角形、长 ribbon、近距离大面 | 含边缘与内部的投影误差 ≤1 CSS px，命中回投影 ≤1 CSS px；记录细分成本 |
| A13 | 036 | 三阶段 selective-depth、mask/blend、depthWrite=false | 颜色和 protected depth 覆盖一致，材质自身深度设置保持；pass 顺序/拾取保持 |
| A14 | 036 | 有真实 light-space 阴影的通用实体 | 灯光空间无主相机 F；接收点与主画面一致，重绘不重复更新时间 |
| A15 | 040–041 | 上/中/下屏 pick、ray、world project、proximity 0/正半径 | 实际可见目标/代理对应一致，误差满足预算；world hit 不冒充原模型点 |
| A16 | 041 | 地块抓取、拖拽穿越压缩接点、平面无交点 | 稳定连续，域外无巨大跳跃，cancel/drop 生命周期正常 |
| A17 | 012、040–041 | DPR1/2、resize、canvas 偏移、相机切换、截图 | CSS/buffer 单位正确，同帧输入一致；screen HUD 不变形，world HUD anchor 对齐 |
| A18 | 035、041 | 正交/透视聚焦，靠上沿的高实体/大半径目标 | 明确模式，目标可按约定安全边距装入最终视野；backend 只给建议 |
| A19 | 020–021 | 暂停、恢复、改速率、水云独立、多个固定时刻 | 相位连续；海床固定；云影随云；定格覆盖所有 pass，sourceTick 不驱动程序 |
| A20 | 014、021 | 编译中移除、重复 dispose、context loss/rebuild、共享纹理 | 迟到任务不挂回、资源所有权归零；同 runtime rebuild 相位/模式不重置 |
| A21 | 015 | 纹理请求失败、shader compile/link 失败、设备不支持 | 有界诊断、正确隔离/恢复；无静默标准投影 fallback，合法 ACK 不等待 GPU |
| A22 | 016 | 云透明边缘、atlas mip、mask 纹理、sRGB 色卡 | 不双重 gamma/预乘；mask 数值不被颜色曲线改变；缩放无边缘污染 |
| A23 | 001、011、014 | 稳态、全暂停/隐藏、大量实例、重复 resize/rebuild | 唯一 RAF；静态时可 idle；参数采样不逐帧重编译或全量 batch rebuild；资源无持续增长 |
| A24 | 全部 | 已打包 Engine + Arts Baseline + 每个生产/验收场景 | 全部世界路径适配投影；按 Arts 场景清单核查环境实际实例，不能只检查 lights/renderer/projection 参数 |
| A25（条件性） | 017 | 所选海岸路线使用生成纹理/CPU 或 GPU 距离场 | 公开注册/generation/局部更新/就绪/取消/预算/rebuild 均有正反例；无 data/blob URL 生命周期旁路。静态路线未触发时记录理由 |

数值测试使用独立数学样本与公开路径交叉验证；GPU shader compile、真实绘制、depth/alpha 和像素边缘必须有真实浏览器证据，不能仅靠源码字符串断言。Engine 使用自有通用 fixture，不加载产品仓 HTML 或资源；Arts 自己承担参考视觉与真实岛屿的验收。

性能测试在声明的浏览器/GPU、viewport、DPR、实例数和最大几何规模上记录 frame time 分布、draw calls、程序编译次数、三角形数量与资源计数。资源和性能预算在 P0 完成基线测量后冻结，再用于后续阶段验收；不得预先宣称性能达标或虚构固定 FPS，跨机器时间不设虚假统一硬门槛。遵循[测试标准](../testing.md)：Engine 性能/浏览器 runner 输出 stdout JSON，不要求提交持久化性能报告。

### 当前覆盖与剩余范围

- A01–A03：程序/纹理/参数 closed schema、非法候选、独立投影数学及事务回滚已有单元和公开路径验证；产品海岸算法另验。
- A04–A08、A10–A15、A17：upper-field、anchor、program-frame 和 batch 真实 GPU fixture 覆盖对应视口/模式、轮廓/回投影、深度/阴影、实例切换与帧输入。锚点展开的已声明轮廓预算为 1 CSS px；超出投影采样预算明确拒绝。不能把中心点样本代替轮廓。
- A09、A16、A18：现有 surface/particle/effect、pointer 生命周期和 focus 查询回归继续通过；复杂产品拖拽、粒子遮挡与整图 focus 的完整视觉矩阵仍由 Arts 正式验收记录，不据此宣称逐 alpha 像素拾取。
- A19–A22、A25：独立与全局暂停、same-runtime rebuild、共享/迟到资源、CPU generation/GPU fence、透明和色卡都有针对性验证。A25 关闭的是 CPU 上传路线，未开放任意 GPU 生成 pass。A21 的程序编译失败已局部隔离；URL 加载与生成纹理上传失败仍沿后端健康/重建流程，全部资源错误局部隔离的目标尚未关闭。
- A23：有界参数/纹理规模、无逐帧重编译、局部参数行更新、隐藏/暂停 idle、资源归零已有验证；性能数值按实际设备记录，不设未经测量的跨机器 FPS 承诺。
- A24：真实 tarball、隔离消费者、Arts Baseline 与各正式消费者需与本轮最终包一致。Arts 的真实浅水/岸浪、云漂移/云影/避岛和整图最终视觉匹配仍未完成，跨仓总验收因此保持 open。

## 10. 能力要求与建议 API 分离

前述 FSR 条目是行为要求。下表保留原设计名称与决策点，不是独立 API 合同；已实现字段以 [程序](../procedural-programs.md)、[生成纹理](../generated-textures.md)、[Display](../display.md)、[渲染](../render-runtime.md) 及公共 TypeScript 类型为准。

| 必需能力 | 建议名称/形状 | 实施时必须说明 |
| --- | --- | --- |
| 版本化程序资源 | `programResourceId`、`programRevision` | 使用 Resource 新 kind 或现有 family 扩展；静态模块与内容 hash 的关系 |
| 类型化输入 | `parameters` / `parameterSchema`、`textures` / `textureSlots` | 类型/默认/范围/数量上限，实例值如何原子更新 |
| 引擎内置只读输入 | `frame.visualSeconds`、camera/viewport 输入集 | 保留命名空间、单位、阶段可用性、同帧快照 |
| 统一相机投影 | `projectionProfile: { mode, startNdcY, strength }` | 显式 s/k 与透视目标地平线派生模式互斥；内容身份与切换语义 |
| 顶点覆盖语义 | `projectionSemantics: 'geometry' | 'anchor-extent'` | 尺寸单位、锚点来源、fixed-panel 组合拒绝规则及 CPU 代理 |
| 程序背景 | `backgroundProgramResourceId` | 唯一背景入口、ray 输入、深度策略及组合阶段 |
| 时间采样控制 | Display 共享视觉控制/封闭显示参数 | 暂停、独立速率、定格的状态所有者，不新增 renderer timeline |
| 纹理采样合同 | color encoding / alpha encoding / sampler 描述 | 数据/颜色、预乘、filter、mipmap、atlas 与设备支持范围 |
| 不可投影查询结果 | 显式 invalid 分支或 nullable 坐标 | 与旧 projectWorldPoint 类型/调用方的版本迁移及错误边界 |
| 生成纹理/距离场（条件性） | generated resource / generation / dirty region / readiness 描述 | CPU 路线为 runtime.generatedTextures；见现行合同，不暗示 URL texture 可动态更新 |

不要求开放任意 JavaScript shader callback、任意 uniform 字典、产品自定义渲染 pass 或 shader 自选是否压缩。这些做法无法保证本需求的统一终端与错误边界。

## 11. 实施、发布与 Arts 接入顺序

以下顺序仍是跨仓完成条件。步骤 1–5 的通用 Engine 能力已实施并持续按验收矩阵验证；步骤 6–8 以真实包及 Arts 正式入口证据闭环，不因能力已存在而自动完成全部产品美术项。

1. **冻结通用合同与测试输入**：确定程序表达方式、closed schema、s/k 与派生模式、sprite 模式、逆域/near/orthographic、query 结果及 Display 时间控制。本文的启用决策已定；此步处理实现设计，不重新征求是否做 upper-field。
2. **实现投影核心与 CPU 查询**：提供引擎唯一的数学/采样来源，完善有效域、保守裁剪、非线性细分/误差策略、pick/proximity/project/focus；准备独立数值及几何 fixture。
3. **贯通全部世界 shader 和 pass**：standard/unlit/GLB/sprite/fixed-panel/batch/surface/particle/effect 同步接入，覆盖主相机 depth 与 selective-depth，分清 light-space 阴影。部分环境能显示不能作为阶段最终交付。
4. **实现程序资源与共享时间输入**：接入 ResourceManager、typed 参数、named textures、程序背景、颜色/alpha/sampler、Display 暂停/速率/定格以及 rebuild；用引擎自有通用样例验证海水所需表达能力。根据 Arts P0 海岸路线决策判断 FSR-017 是否触发；若触发，完成必要的生成资源合同、实现及 A25 后才能接入该海岸路线，不要求为此先建设通用 render graph。
5. **完成 Engine 验证与现行文档更新**：按矩阵完成单元、公开 API 集成、类型、生命周期、真实 WebGL 和必要性能检查。同一实现变更更新 [Display](../display.md)、[render-runtime](../render-runtime.md)、[pointer](../pointer-interaction-plan.md)、[animation](../display-animation.md)、[architecture](../architecture.md)、公开 `.d.ts`、根 exports、受影响 schema、测试索引及 release tuple。本文与 requirements 索引届时按完成状态同步。
6. **正式版本与包产物**：确定 Display / renderer-three 的实际新版本，必要时更新 Client 的类型配套依赖；不预先杜撰版本号。根导出可访问新增 API，npm 包的 `files` 必须包含程序模块/类型/必需 shader 资源。在隔离消费者中用真实打包产物验证导入、类型、加载与资源恢复，不能只测试 sibling 源码。检查包依赖、lockfile 和 release tuple 一致。Python/Wire 不因纯显示能力顺带升协议。
7. **Arts 先 Baseline 集成**：Arts 更新其正式依赖/锁文件及项目既有 vendor 产物流程，核验安装内容与发布包一致；随后用现有 sky/ocean/cloud owner 与共享组合入口替换资源，按真实海岸计划生成输入，完成 Baseline 视觉、动态、深度及交互验收。
8. **Arts 全场景推广**：按配套 Arts 清单更新 main、各验收面、战斗组合与公司编辑等场景；逐一核查实际环境实例及所有世界 shader。单项隔离验收的对象范围由 Arts 清单明确，但投影不得例外。全场景通过后再将 Arts 计划标记完成。

Engine 测试通过和正式发布是 Arts 生产接入前置条件；Arts 全场景验收则是跨仓目标完成条件。整个序列保持现有唯一生产/验收链路，不提供临时 HTML review route 或第二 catalog。旧部署如需保留历史外观，使用已有历史 Display artifact 管理，不增加线上兼容着色器分支。

## 12. 未实现风险与完成条件

- 最大技术风险是非线性投影的三角形插值/裁剪与 CPU 命中一致性；仅 shader include 和正逆数学测试不能消除此风险。
- GLB 导入材质、实例化、既有面片补偿和主相机 depth 变体可能形成漏接路径；必须用同一编译终端与矩阵逐项证明覆盖。
- 远云采用锚点后展开，会与普通世界几何具有不同覆盖语义；缺少明确模式和代理会导致云正确而建筑/拾取错误。
- 更大远景尺度和细分可能增加 GPU 成本、降低深度精度；far/near 调参归 Arts，但 backend 对数值、裁剪和退化情况负责。
- 参考 alpha、颜色和水云独立时钟不能直接复制；否则可能出现亮度差、云边污染、改速率跳相或 rebuild 重播。
- 程序格式、公开字段和包版本已落库；性能规模受声明预算约束，实际产品帧时间须用目标内容测量。
- 海岸路线若依赖生成纹理或距离场，会触发 FSR-017 的条件性增量；仅提供 URL texture 或程序材质本身不足以证明动态海岸资源接入就绪。

完成必须同时满足：公共声明可表达目标程序环境；全部世界渲染/深度/查询路径使用同一有效投影；颜色、时间与资源生命周期通过矩阵；现行合同、类型、测试与正式包版本同步；Arts 通过 Baseline 后完成其全场景接入。只更新文档、只接天空海水或只通过旧 parity 测试，均不能标记本需求已实现。
