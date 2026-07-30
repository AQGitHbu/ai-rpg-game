# 小镇生成 Demo 记录

> 记录日期：2026-07-29 ｜ 分支：`codex/town-generation-demo` ｜ 演示页：`/town-demo`

## 一、这次 Demo 做了什么

基于 `docs/设想/AI驱动RPG_大地图-小镇地图-场景与小镇生成方案_v0.1.md`，在独立分支实现了**小镇程序化生成的可玩 Demo**：输入任意种子，确定性生成一座带路网、街区、建筑的小镇，SVG 地图可交互查看每栋建筑的档案。共 9 个开发任务 + 质量修复 + AI 生图贴图试验。

## 二、实现内容

### 1. 生成管线（`src/game/gameplay/rpg/town/`）

按方案文档六步管线实现，全部纯函数、由 seed 完全确定（同 seed 深度相等）：

| 步骤 | 模块 | 说明 |
|---|---|---|
| 语义规划 | `fallbackTownPlan.ts` | 无 AI 时的规划兜底：城门/河流/区块意图 |
| 地形 | `terrain.ts` | 椭圆小镇边界 + 可选河带 + 森林散布 |
| 锚点 | `anchors.ts` | 城门/广场/水井/各区中心，螺旋探测 + 最小间距约束 |
| 路网 | `roads.ts` | A*（转弯罚分 + 已有路吸附）+ Prim MST + 补环 + 栅格化 |
| 街区地块 | `blocks.ts` | Flood Fill 提取街区 → 临街切分地块 → 尾并（有面积上限） |
| 建筑放置 | `buildings.ts` | 地块评分（区域匹配/面积/临街/地标邻近）+ 剧情建筑优先 + 入口开在临街边 |
| 验证修复 | `validateTown.ts` + `generateTown.ts` | 连通性/覆盖校验，修复链：换入口→开 1-3 格巷道→舍弃建筑，整镇重试 ≤3 |

- 随机性只来自 `townRandom.ts` 的 seeded RNG，所有平局按固定序裁决。
- domain 类型（`TownSnapshot` 等）在 `src/game/domain/townSnapshot.ts`，application 门面 `generateTownDemoView`（`src/game/application/townDemo.ts`）纯同步、稳定错误码。
- 依赖边界：`dependencyBoundaries.test.ts` 增加 TOWN_DEEP_IMPORT 规则，UI 只能经 application 门面访问 town 模块。

### 2. 演示 UI（`/town-demo`）

- `TownMapSvg`：每格 12px 的 SVG 底图（12 种瓦片色表），建筑为可点击/可键盘操作的透明覆盖矩形，剧情建筑高亮描边；调试开关：地块边界、路网节点。
- `BuildingProfilePanel`：建筑档案（名称/类型/区域/占地/入口方位）+ 程序生成的 SVG 占位外观图。
- 页面控制：种子输入、生成、随机种子、错误文案（aria-live）。
- **生图预留 port**：`townAssets.ts` 定义 `TownIllustrationSource` 契约（town-assets-v0），demo 阶段生产实现恒返回 `not_requested`，未来真实生图实现同一接口即可替换。

### 3. 生成质量修复（用户试玩反馈驱动）

试玩发现三个问题，经诊断脚本（6 seed 证据）定位根因并修复：

| 问题 | 根因 | 修复 | 效果 |
|---|---|---|---|
| 道路一条直线无分岔 | 各区锚点全被映射到地图中轴线，7 锚点共线；最小间距 4 过小 | 锚点间距 4→8；区中心沿区域切向 ±(边长/4) 散布 | 支路稳定出现（复验 8 镇 road_minor 22–50 格） |
| 大片无用深色格子 | 地块尾并无面积上限，出现 116 格怪物地块 | 尾并封顶 `PLOT_AREA_MAX=24`，吞不下的格子留作草地；reserved 分配按面积升序 | 最大地块 116→32，出现绿色留白 |
| 建筑似乎不通路 | footprint 四边内缩 1，建筑与路永隔一圈 plot，入口靠修复管线硬开巷道 | 临街边贴街不内缩；边长上限 `ceil(√期望面积)` | 入口门前直接是道路，巷道补丁 6/10→≈0，畸形建筑（2×9）消失 |

### 4. AI 生图贴图试验（spike）

评估"真实 AI 生图放进格子地图是否和谐"，**尚未建立正式生图管线**：

- 工具脚本 `scripts/genTownBuildingImages.mjs`：调 ModelScope `Tongyi-MAI/Z-Image-Turbo`（异步任务 + 轮询），为 8 种建筑类型各生成一张俯视贴图存入 `public/assets/town-experiment/`。Token 读 `.env.local` 的 `AI_MODEL_SCOPE`（server 侧，绝不进浏览器/日志）。
- 提示词迭代 3 轮的教训已记在脚本注释：泛泛说"俯视"→整片镇子斜 45° 鸟瞰；必须用"垂直向下、只有一座建筑、屋顶被画框裁剪无留白"逼出满幅正俯视。
- `TownMapSvg` 增加试验开关 `showAiBuildingArt`（页面「实验：AI 建筑贴图」，默认开）：按 `buildingType` 把贴图以 `slice` 裁剪填充到 footprint，交互不受影响。
- 已知局限（评估用，非缺陷修复项）：贴图未按入口朝向旋转；同类型建筑共用一张图；个别图仍偏斜视角（blacksmith）；1024px 原图缩到 24–48px 会损失细节。
- 后续方向（待定）：确认和谐度后再设计正式管线——供应商可切换的 provider 架构（ModelScope 只是其一）、异步队列、按 seed/类型缓存复用。

## 三、进行了哪些测试

| 测试 | 范围 | 结果 |
|---|---|---|
| 单元/组件测试 | 全仓 63 个文件（town 模块 10 个：terrain/anchors/roads/blocks/buildings/validate/generateTown/random/plan/batch，UI：TownMapSvg、BuildingProfilePanel、town-demo 页） | 865/865 通过 |
| 1000-seed 批量回归 | `townGenerationBatch.test.ts`：剧情建筑 3 栋齐全、路网图与门前格从主城门可达、footprint 不重叠不压非法瓦片、reserved 地块占比 ∈ [0.1,0.35]、repair ≤20、retry ≤3、总耗时 <60s | 通过（约 7–9s） |
| 确定性验证 | 同 seed 两次生成深度相等；seed trim 一致性 | 通过 |
| 浏览器功能验收 | 11 项：生成/随机种子/建筑点选/档案面板/调试开关/错误处理/确定性复现/零控制台错误/零外部请求 | 全部通过 |
| 修复后视觉复验 | 浏览器实测 8 个种子统计 SVG 瓦片：支路数、reserved 占比（2.4%–11.5%）、grass 留白（31–113 格） | 三项修复指标全部改善 |
| AI 贴图验证 | 12 栋建筑贴图渲染、8 种类型资源 200、开关切换、控制台干净 | 通过 |
| 静态检查 | `tsc --noEmit`、`eslint .` | 通过 |

## 四、遗留事项

- AI 生图正式管线未建：等待贴图和谐度结论后再做 provider 抽象设计（多供应商可切换）。
- `docs/设想/` 方案文档尚未入主仓 git 库，合并前需在 main 补提交。
- Demo 独立于游戏主循环，未接入大地图/场景切换。
