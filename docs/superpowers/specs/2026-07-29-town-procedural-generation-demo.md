# 小镇程序化生成 Demo 设计

> 日期：2026-07-29
> 状态：设计已确认
> 关联设想：`docs/设想/AI驱动RPG_大地图-小镇地图-场景与小镇生成方案_v0.1.md`（v0.1，简称"方案文档"）
> 目标分支：`codex/town-generation-demo`（工作区 `.worktrees/town-generation-demo`）
> 唯一修改仓库：`ai-rpg-game`（不触碰 foundation / shared package / MVP 主线 current-phase.json）

## 1. 决策与目标

本 demo 验证方案文档的核心生成算法（RFP-Town：道路优先、临街地块、延迟实例化）在本项目架构中的可行性，交付：

1. 一个**确定性小镇生成器**（gameplay 纯函数门面）：语义规划 + seed → 权威小镇快照（网格、道路图、街区、地块、建筑、入口、验证报告）。
2. 一个**开发演示页面** `/town-demo`：输入 seed 立即生成并以 SVG 渲染小镇逻辑地图，点击建筑查看档案。
3. **批量生成回归**：1000 seed 全部满足可达性/合法性断言，同 seed 深度相等复现。

demo 是独立支线，**不接入游戏主循环**：不修改 `GameState`、`ScenarioBlueprint`、`CONTENT_BUDGET`、行动裁决、SQLite schema 或任何现有 API。验证通过后，接入三层地图体系另起 Spec。

## 2. 范围与非目标

### 包含

- 领域纯类型：小镇快照、语义规划、格子/道路/地块/建筑/入口、验证问题码。
- 生成管线全部阶段：地形边界 → 锚点 → A* 候选路 → MST → 环路 → 栅格化 → Flood Fill 街区 → 临街地块切分 → 建筑放置（剧情 → 基础 → 泛化 → 预留） → 入口 → 全局验证 → 局部修复。
- 确定性 fallback 语义规划（不调 AI）：由 seed 派生主题/区域/剧情建筑清单。
- application 门面投影 demo 视图；预留 AI 语义规划与 AI 生图的纯 port（仅类型 + unavailable 实现）。
- SVG 逻辑地图渲染与 SVG 占位建筑外观图（按建筑类型程序绘制）。
- 依赖边界守卫扩展与同目录测试。

### 不包含（本 demo 明确排除）

- **AI 生图与任何图片网络请求**：所有图片一律用程序生成的 SVG 占位图；只预留 `TownIllustrationSource` port（模式同 Phase 4A 的 `ScenarioCandidateSource`），生产注入 unavailable 实现。
- 真实 AI 语义规划调用（预留 port，demo 用确定性 fallback plan）。
- 接入 `GameState` / 蓝图 / 任务 / NPC 日程 / 移动耗时 / 封路事件 / 世界大地图层级。
- 建筑内部场景、动态新增建筑（§24）、玩家认知锁定运行时（§26）、资产队列与优先级调度（§33–§35）。
- SQLite 持久化小镇快照（demo 页按 seed 即时生成，天然可复现，无存档需求）。
- 逐格自由行走、碰撞、角色动画、超大城市单图。

## 3. 架构落位

严格遵守现有四层与依赖边界：

```text
src/game/domain/townSnapshot.ts          纯类型 + 常量（不依赖任何上层）
src/game/gameplay/rpg/town/              生成器门面（只依赖 domain；index.ts 唯一出口）
src/game/application/townDemo.ts         demo 视图投影（经 gameplay 门面）
src/game/application/townAssets.ts       预留生图 port（纯类型，无 IO）
src/app/town-demo/page.tsx               demo 页面（只经 @/game/application）
src/components/town/                     SVG 地图 / 建筑档案 / 占位图组件
```

- 生成器为纯函数：无 `Math.random` / `Date` / IO / env；随机只来自 seed（FNV-1a + mulberry32，town 模块内自持实现，**不改动** `createFallbackBlueprint.ts` 以免波及钉值 fixture）。
- demo 页是 client 组件，直接调用 application 门面的纯生成函数（无 API/持久化）；`dependencyBoundaries.test.ts` 增加 `gameplay/rpg/town` 的 deep-import 拦截（同 scenario/actions/quests/battle）。

## 4. 数据契约（关键类型）

```ts
// domain/townSnapshot.ts（节选，均 readonly）
type TileType =
  | "outside" | "grass" | "forest" | "water"
  | "road_main" | "road_minor" | "alley" | "square"
  | "plot" | "building" | "building_entrance" | "reserved";

type TownDistrictType = "market" | "residential" | "craft" | "reserved";

type TownSemanticPlan = {
  planVersion: 1;
  theme: string;
  gridSize: { width: number; height: number };      // 24–40，默认 32
  terrain: { river: "north" | "south" | "none"; externalRoad: "east_west" | "north_south" };
  districts: readonly { type: TownDistrictType; preferredArea: AreaHint; weight: number }[];
  requiredBuildings: readonly {
    key: string; buildingType: TownBuildingType;
    preferredDistrict: TownDistrictType; importance: "story_required";
  }[];
  landmarks: readonly { type: "well"; preferredArea: AreaHint }[];
};

type RoadNode = { id: string; x: number; y: number; kind: "gate" | "intersection" | "square" | "poi" };
type RoadEdge = { id: string; from: string; to: string; roadType: "main" | "minor" | "alley";
                  cells: readonly Cell[]; cost: number };

type PlotStatus = "occupied" | "generic" | "reserved";
type BuildingDefinitionState = "generic" | "named";   // demo 只用生成期两态

type TownBuilding = {
  buildingId: string; plotId: string;
  definitionState: BuildingDefinitionState;
  buildingType: TownBuildingType;                     // tavern/blacksmith/house/... 封闭 union
  displayName: string; district: TownDistrictType;
  footprint: Rect; entrance: { x: number; y: number; direction: Direction };
  storyRequired: boolean;
};

type TownSnapshot = {
  snapshotVersion: 1;
  seed: string;
  generatorVersion: string;                           // "town-gen-0.1.0"
  plan: TownSemanticPlan;
  grid: { width: number; height: number; tiles: readonly TileType[] };  // 行优先扁平数组
  roadGraph: { nodes: readonly RoadNode[]; edges: readonly RoadEdge[] };
  blocks: readonly Block[];
  plots: readonly Plot[];
  buildings: readonly TownBuilding[];
  mainGateNodeId: string;
  validation: { valid: true; repairCount: number; retryCount: number };  // 失败不产出快照
};
```

```ts
// application/townAssets.ts —— 预留生图接口（demo 零实现，仅 unavailable）
type TownAssetKind = "building_exterior" | "town_illustration";
type TownAssetStatus = "not_requested" | "queued" | "generating" | "ready" | "failed";
type TownIllustrationSource = {
  request(descriptor: { kind: TownAssetKind; targetId: string; prompt: string }):
    Promise<{ status: TownAssetStatus; assetUrl?: string }>;
};
function createUnavailableTownIllustrationSource(): TownIllustrationSource; // 恒返回 not_requested
```

## 5. 固定算法参数（方案文档 §41 MVP 裁剪）

| 参数 | 值 |
|---|---|
| 网格 | 默认 32×32（合法域 24–40，方形） |
| 城镇边界 | 椭圆模板 + seed 噪声扰动 ±2 格 |
| 锚点 | 2 城门（外路方向两端）+ 中心广场 + 每区域 1 中心 + 水井；锚点最小间距 4 格 |
| A* 代价 | 平地 1 / 草地 1.2 / 森林 3 / 河 20 / 已有道路 0.4；转弯惩罚 0.3 |
| 连通 | Prim MST；环路：绕路系数 ≥ 1.8 补边，附加边 ≤ 25% |
| 道路宽度 | 主路 3 / 支路 2 / 巷道 1 / 广场 5×5 |
| 地块 | 最小临街 2 格，深度 3–8 格；面积 < 6 的街区转绿地 |
| 建筑 | 占地 = 地块内缩 1 格；放置顺序 剧情→基础→泛化；地块占用率 0.65，预留率 0.2 |
| 评分 | districtMatch·30 + areaFit·20 + roadFrontage·15 + landmarkProximity·15 + storyPreference·25 |
| 修复 | 顺序：换入口方向 → 开 1–3 格门前通道 → 降级/舍弃泛化建筑；单次生成 ≤ 20 次修复 |
| 重试 | 修复后仍无效 → seed 派生变体重试 ≤ 3 次；剧情建筑失败必须重试，全败抛 `TownGenerationError` |

## 6. 验证规则（生成器内置，全部通过才产出快照）

1. 主城门存在，且从主城门 BFS 可达全部道路锚点。
2. 每栋剧情/可交互建筑：入口相邻门前格为道路，且门前格从主城门可寻路。
3. 建筑之间不重叠；建筑不覆盖道路/水/城外。
4. 每个 occupied/generic/reserved 地块临街 ≥ 2 格。
5. 同 seed 输出深度相等（含数组顺序）。

## 7. Demo 页面

- 路径 `/town-demo`（无环境门禁：纯确定性演示，不触碰存档/AI/env）。
- seed 输入框 + 「生成」+ 「随机种子」；显示统计（建筑数/地块占用/修复次数/生成耗时）。
- SVG 地图：格子按 TileType 着色，剧情建筑高亮描边，入口标记，广场/水井图标；hover 提示，点击建筑打开档案面板。
- 建筑档案面板：名称、类型、区域、状态、占地、入口方位 + **SVG 占位外观图**（按 buildingType 程序绘制的简笔立面）+ 资产状态标签「AI 生图未接入（预留接口）」。
- 图例与调试开关：显示/隐藏 街区边界、地块边界、道路图节点。

## 8. 验收标准

- [ ] 同 seed 快照深度相等；不同 seed 布局不同。
- [ ] 1000 seed 批量回归全部通过 §6 验证，单镇生成（32×32）平均 < 50ms。
- [ ] `/town-demo` 可生成、渲染、点击查看建筑档案与 SVG 占位图。
- [ ] 无任何网络生图调用；`TownIllustrationSource` port 存在且生产实现为 unavailable。
- [ ] `npm run lint` / `npm test` / `npm run typecheck` / `npm run test:boundaries` / `npm run build` 全绿。
- [ ] 现有全部测试不回归；未改动 GameState / 蓝图 / SQLite / 现有 API。
- [ ] `docs/agent/小镇程序化生成.md` 建立并登记 `docs/Agent文档索引.md`。
