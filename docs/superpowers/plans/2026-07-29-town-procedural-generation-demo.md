# 小镇程序化生成 Demo 执行 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `codex/town-generation-demo` 分支交付确定性小镇生成器（RFP-Town 管线）+ `/town-demo` SVG 演示页 + 1000 seed 批量回归。

**Architecture:** 生成器是 gameplay 层纯函数门面（`src/game/gameplay/rpg/town/`，只依赖 domain 新类型文件），application 只做视图投影与预留 port，UI 用 SVG 渲染逻辑地图。全程无 AI/网络/持久化；图片一律 SVG 占位，生图仅预留 `TownIllustrationSource` port。

**Tech Stack:** TypeScript（零新依赖）、自写 A*/Prim MST/BFS/Flood Fill、FNV-1a + mulberry32 seeded RNG、React SVG、vitest。

**上游 Spec:** `docs/superpowers/specs/2026-07-29-town-procedural-generation-demo.md`

## Global Constraints

- 只修改 `ai-rpg-game`（当前 worktree）；不碰 `.foundation`、shared package、`current-phase.json`、MVP 主线文件。
- **禁止接入 AI 生图**：不发任何图片网络请求；所有图片用程序 SVG 占位；只预留 `TownIllustrationSource` port，生产实现恒为 unavailable。
- 不修改：`GameState`、`scenarioBlueprint.ts`、`CONTENT_BUDGET`、`createFallbackBlueprint.ts`、actions/quests/battle 门面、SQLite schema、现有 API 路由。
- 生成器纯函数：无 `Math.random` / `Date.now` / IO / `process.env`；随机只来自 seed 参数。
- 新目录必须有同目录测试；`gameplay/rpg/town` 只许经 `index.ts` 门面被 application 消费（`dependencyBoundaries.test.ts` 增拦截）。
- 固定参数以 Spec §5 为准：默认网格 32×32、主路宽 3/支路 2/巷道 1、临街 ≥2 格、地块深 3–8、修复 ≤20 次、重试 ≤3 次、`generatorVersion = "town-gen-0.1.0"`。
- 命名统一：快照类型 `TownSnapshot`，生成入口 `generateTown`，错误类 `TownGenerationError`。
- 每个 Task 结束：`npx vitest run src/game/gameplay/rpg/town`（或对应目录）通过后即 commit。

---

### Task 1: domain 类型 + seeded RNG + fallback 语义规划

**Files:**
- Create: `src/game/domain/townSnapshot.ts`
- Modify: `src/game/domain/index.ts`（追加 `export * from "./townSnapshot";`）
- Create: `src/game/gameplay/rpg/town/townRandom.ts`
- Create: `src/game/gameplay/rpg/town/fallbackTownPlan.ts`
- Create: `src/game/gameplay/rpg/town/index.ts`（门面，随任务推进追加导出）
- Test: `src/game/gameplay/rpg/town/townRandom.test.ts`、`src/game/gameplay/rpg/town/fallbackTownPlan.test.ts`、`src/game/domain/townSnapshot.test.ts`

**Interfaces (Produces):**

```ts
// domain/townSnapshot.ts —— 全部 readonly，纯类型 + 冻结常量，无函数逻辑
export type TileType =
  | "outside" | "grass" | "forest" | "water"
  | "road_main" | "road_minor" | "alley" | "square"
  | "plot" | "building" | "building_entrance" | "reserved";
export type Cell = { readonly x: number; readonly y: number };
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type Direction = "north" | "south" | "east" | "west";
export type AreaHint = "center" | "north" | "south" | "east" | "west" | "edge";
export type TownDistrictType = "market" | "residential" | "craft" | "reserved";
export type TownBuildingType =
  | "tavern" | "blacksmith" | "house" | "shop" | "workshop"
  | "warehouse" | "well" | "gatehouse";
export type TownSemanticPlan = { /* Spec §4 原样 */ };
export type RoadNode = { readonly id: string; readonly x: number; readonly y: number;
  readonly kind: "gate" | "intersection" | "square" | "poi" };
export type RoadEdge = { readonly id: string; readonly from: string; readonly to: string;
  readonly roadType: "main" | "minor" | "alley"; readonly cells: readonly Cell[]; readonly cost: number };
export type TownBlock = { readonly id: string; readonly cells: readonly Cell[];
  readonly roadBoundaryCells: readonly Cell[]; readonly districtType: TownDistrictType };
export type PlotStatus = "occupied" | "generic" | "reserved";
export type TownPlot = { readonly id: string; readonly blockId: string; readonly cells: readonly Cell[];
  readonly frontageCells: readonly Cell[]; readonly district: TownDistrictType; readonly status: PlotStatus };
export type BuildingDefinitionState = "generic" | "named";
export type TownBuilding = { /* Spec §4 原样 */ };
export type TownGrid = { readonly width: number; readonly height: number; readonly tiles: readonly TileType[] };
export type TownSnapshot = { /* Spec §4 原样 */ };
export const TOWN_GENERATOR_VERSION = "town-gen-0.1.0" as const;
export const TOWN_GRID_MIN = 24; export const TOWN_GRID_MAX = 40; export const TOWN_GRID_DEFAULT = 32;
export function tileIndex(grid: { width: number }, x: number, y: number): number; // y * width + x

// town/townRandom.ts
export type TownRng = { next(): number; nextInt(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T; shuffle<T>(items: readonly T[]): T[] };
export function createTownRng(seed: string): TownRng;   // FNV-1a → mulberry32；shuffle 为确定性 Fisher-Yates
export function hashTownSeed(seed: string): string;      // 16 位 hex，重试变体派生用

// town/fallbackTownPlan.ts
export function createFallbackTownPlan(seed: string): TownSemanticPlan;
// 固定 3 剧情建筑（tavern@market、blacksmith@craft、house@residential）+ well 地标 +
// market/residential/craft/reserved 四区域；theme 从固定列表按 rng 选取；gridSize 恒 32×32。
```

- [ ] **Step 1:** 写失败测试：`createTownRng("seed-a")` 两次实例产出前 20 个值完全一致；`"seed-a"` 与 `"seed-b"` 序列不同；`nextInt(10)` 恒在 `[0,10)`；`shuffle` 不修改原数组且同 seed 同结果。`createFallbackTownPlan` 同 seed 深度相等、planVersion=1、恒有 3 个 requiredBuildings、gridSize 32×32、districts 权重和为 100。`tileIndex({width:32}, 3, 2) === 67`。
- [ ] **Step 2:** `npx vitest run src/game/gameplay/rpg/town src/game/domain/townSnapshot.test.ts` → 预期 FAIL（模块不存在）。
- [ ] **Step 3:** 实现三个文件（RNG 实现参照 `createFallbackBlueprint.ts` 内私有 fnv1a/mulberry32 的写法**复制**，不 import 它）；`index.ts` 导出 `createFallbackTownPlan`、`createTownRng`（供后续任务内使用的内部函数不出门面）。
- [ ] **Step 4:** 重跑同命令 → PASS；`npm run typecheck` 通过。
- [ ] **Step 5:** Commit：`feat(town): domain types, seeded rng and fallback semantic plan`

---

### Task 2: 地形边界与锚点

**Files:**
- Create: `src/game/gameplay/rpg/town/terrain.ts`、`src/game/gameplay/rpg/town/anchors.ts`
- Test: `src/game/gameplay/rpg/town/terrain.test.ts`、`src/game/gameplay/rpg/town/anchors.test.ts`

**Interfaces:**
- Consumes: `TownSemanticPlan`、`TownRng`、`Cell`、`AreaHint`（Task 1）。
- Produces:

```ts
// terrain.ts
export type TerrainLayout = {
  readonly width: number; readonly height: number;
  readonly buildableMask: readonly boolean[];    // 扁平，城外/水域 false
  readonly baseTiles: readonly TileType[];       // outside/grass/forest/water 底图
  readonly roadCost: readonly number[];          // 平地1/草1.2/林3/水20/城外 Infinity
};
export function generateTerrain(plan: TownSemanticPlan, rng: TownRng): TerrainLayout;
// 椭圆边界（中心 w/2,h/2，半径 w/2-3, h/2-3，逐角度 ±2 格 rng 扰动）；
// river: "north" → 顶部 2–3 行水带；forest 斑块 ≤ 面积 8%。

// anchors.ts
export type TownAnchor = { readonly id: string; readonly kind: "gate" | "square" | "district_center" | "poi";
  readonly cell: Cell; readonly districtType?: TownDistrictType };
export function placeAnchors(plan: TownSemanticPlan, terrain: TerrainLayout, rng: TownRng): readonly TownAnchor[];
// 恒产出：anchor_gate_main + anchor_gate_secondary（externalRoad 方向两端边界内侧首个可建格）、
// anchor_square（最靠近网格中心的可建格）、每个非 reserved district 一个 center、anchor_poi_well。
// 约束：全部在 buildableMask 内；两两曼哈顿距离 ≥ 4（不满足时向外螺旋探测重选）。
```

- [ ] **Step 1:** 写失败测试：terrain 同 seed 复现；`buildableMask` 为 true 的格不含边界外；river="north" 时顶部存在 water 且其 roadCost=20；中心格可建。anchors 同 seed 复现；恒含 2 gate + 1 square + well；所有 anchor 落在可建格；两两距离 ≥ 4；gate 分别位于外路方向两侧半边。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现 `generateTerrain` 与 `placeAnchors`。
- [ ] **Step 4:** 运行 → PASS。
- [ ] **Step 5:** Commit：`feat(town): terrain boundary and anchor placement`

---

### Task 3: 道路管线（A* → MST → 环路 → 栅格化）

**Files:**
- Create: `src/game/gameplay/rpg/town/roads.ts`
- Test: `src/game/gameplay/rpg/town/roads.test.ts`

**Interfaces:**
- Consumes: `TerrainLayout`、`TownAnchor`、`TownRng`。
- Produces:

```ts
export type RoadPipelineResult = {
  readonly roadGraph: { readonly nodes: readonly RoadNode[]; readonly edges: readonly RoadEdge[] };
  readonly tiles: readonly TileType[];          // baseTiles 上写入 road_main/road_minor/square
  readonly mainGateNodeId: string;
};
export function buildRoadNetwork(
  anchors: readonly TownAnchor[], terrain: TerrainLayout, rng: TownRng
): RoadPipelineResult;

// 内部（不出门面，但需单独导出供测试）：
export function findRoadPath(from: Cell, to: Cell, terrain: TerrainLayout):
  { cells: readonly Cell[]; cost: number } | null;                    // 带转弯惩罚 0.3 的 A*（4 邻接）
export function minimumSpanningTreeEdges(
  nodeIds: readonly string[], candidates: readonly { from: string; to: string; cost: number }[]
): readonly { from: string; to: string; cost: number }[];             // Prim，candidates 顺序稳定
```

算法要点：全锚点两两跑 A* 得候选边（不可达对丢弃）→ Prim MST（起点 mainGate）→ 对剩余候选按绕路系数（图上距离 Dijkstra ÷ 直连成本）≥ 1.8 且附加边数 ≤ ceil(MST 边数 × 0.25) 补环 → 栅格化：gate↔square/gate↔gate 主干边宽 3 写 `road_main`，其余宽 2 写 `road_minor`；square 锚点处写 5×5 `square`；宽度膨胀不越出 buildableMask。

- [ ] **Step 1:** 写失败测试：`findRoadPath` 在无障碍地形返回曼哈顿最优且优先直线（转弯少于锯齿路径）；水域高代价被绕开；不可达返回 null。`minimumSpanningTreeEdges` 对 4 节点手工用例返回 3 条正确边。`buildRoadNetwork` 同 seed 复现；从 mainGate BFS（沿 edges）可达全部 nodes；tiles 中存在 road_main 与 square；道路格全部在 buildableMask 内。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现（A* 用二叉堆或排序数组均可，节点状态含进入方向以计转弯罚）。
- [ ] **Step 4:** 运行 → PASS。
- [ ] **Step 5:** Commit：`feat(town): road pipeline with a-star, mst, loops and rasterization`

---

### Task 4: 街区提取与临街地块切分

**Files:**
- Create: `src/game/gameplay/rpg/town/blocks.ts`
- Test: `src/game/gameplay/rpg/town/blocks.test.ts`

**Interfaces:**
- Consumes: `RoadPipelineResult.tiles`、`TerrainLayout`、`TownSemanticPlan.districts`、`TownRng`。
- Produces:

```ts
export function extractBlocks(
  tiles: readonly TileType[], terrain: TerrainLayout,
  districts: TownSemanticPlan["districts"], rng: TownRng
): readonly TownBlock[];
// Flood Fill 非道路可建格 → 面积 < 6 的连通域直接改写为 grass（调用方接收返回的新 tiles，见下）；
// district 分配：按区域 preferredArea 与街区质心的匹配度 + weight 加权确定性分配。

export function subdivideIntoPlots(
  block: TownBlock, tiles: readonly TileType[], gridWidth: number, rng: TownRng
): readonly TownPlot[];
// 从临街边界向内切分；frontage ≥ 2、深度 3–8；内部剩余并入相邻地块；
// 无临街面的候选一律不产出独立地块。

export type BlockPlotResult = { readonly tiles: readonly TileType[];  // plot 格写入 "plot"
  readonly blocks: readonly TownBlock[]; readonly plots: readonly TownPlot[] };
export function buildBlocksAndPlots(
  roadResult: RoadPipelineResult, terrain: TerrainLayout, plan: TownSemanticPlan, rng: TownRng
): BlockPlotResult;
```

- [ ] **Step 1:** 写失败测试：对手工 12×12 tiles（含十字路）`extractBlocks` 得 4 个街区且 roadBoundaryCells 正确；`subdivideIntoPlots` 产出的每个 plot `frontageCells.length ≥ 2`、cells 互不重叠、全部属于该 block；`buildBlocksAndPlots` 同 seed 复现、所有 plot 格在 tiles 中为 "plot"。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 运行 → PASS。
- [ ] **Step 5:** Commit：`feat(town): block extraction and frontage plot subdivision`

---

### Task 5: 建筑放置与入口分配

**Files:**
- Create: `src/game/gameplay/rpg/town/buildings.ts`
- Test: `src/game/gameplay/rpg/town/buildings.test.ts`

**Interfaces:**
- Consumes: `BlockPlotResult`、`TownSemanticPlan`、`RoadPipelineResult`、`TownRng`。
- Produces:

```ts
export type BuildingPlacementResult = {
  readonly tiles: readonly TileType[];       // building/building_entrance/reserved 写入
  readonly plots: readonly TownPlot[];       // status 更新为 occupied/generic/reserved
  readonly buildings: readonly TownBuilding[];
};
export function placeBuildings(
  plan: TownSemanticPlan, blockPlots: BlockPlotResult,
  roadResult: RoadPipelineResult, rng: TownRng
): BuildingPlacementResult;
```

算法要点：按 Spec §5 评分公式为每个 requiredBuilding 选最高分地块（确定性平局按 plot.id 字典序）；再放基础建筑（well 已是锚点、每 gate 一个 gatehouse）；再按占用率 0.65 放泛化建筑（definitionState:"generic"，displayName 用「一间临街店铺/普通民居…」模板）；剩余地块按预留率标 reserved。footprint = 地块 bounding box 内缩 1 格（最小 2×2，放不下则整地块降为 reserved）。入口：footprint 边界上选一个使「门前格为道路/巷道」的格，写 `building_entrance`；四方向都不邻路时暂缺入口（留给 Task 6 修复）。displayName：required 用固定中文名表（福来酒楼/铁匠铺/张宅），generic 按类型模板 + 序号。

- [ ] **Step 1:** 写失败测试：3 个剧情建筑全部放置且 `storyRequired === true`、落在 preferredDistrict（或评分次优区域时仍被放置）；建筑 footprint 两两不相交、不覆盖 road/water/outside；每个非 reserved 建筑有 entrance 且 entrance 在 footprint 边界；同 seed 复现；泛化建筑 definitionState 为 "generic"。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 运行 → PASS。
- [ ] **Step 5:** Commit：`feat(town): building placement, scoring and entrances`

---

### Task 6: 全局验证、局部修复与 generateTown 编排 + 批量回归

**Files:**
- Create: `src/game/gameplay/rpg/town/validateTown.ts`、`src/game/gameplay/rpg/town/generateTown.ts`
- Modify: `src/game/gameplay/rpg/town/index.ts`（门面最终导出：`generateTown`、`createFallbackTownPlan`、`TownGenerationError`、类型再导出）
- Test: `src/game/gameplay/rpg/town/validateTown.test.ts`、`src/game/gameplay/rpg/town/generateTown.test.ts`、`src/game/gameplay/rpg/town/townGenerationBatch.test.ts`

**Interfaces:**
- Consumes: Task 2–5 全部产物。
- Produces:

```ts
// validateTown.ts
export type TownValidationIssue =
  | { readonly code: "ANCHOR_UNREACHABLE"; readonly nodeId: string }
  | { readonly code: "ENTRANCE_MISSING"; readonly buildingId: string }
  | { readonly code: "ENTRANCE_UNREACHABLE"; readonly buildingId: string }
  | { readonly code: "BUILDING_OVERLAP"; readonly buildingId: string }
  | { readonly code: "BUILDING_ON_FORBIDDEN_TILE"; readonly buildingId: string }
  | { readonly code: "PLOT_FRONTAGE_TOO_SMALL"; readonly plotId: string };
export function validateTownDraft(draft: TownDraft): readonly TownValidationIssue[]; // collect-all
// TownDraft = generateTown 内部中间结构（tiles+roadGraph+plots+buildings+mainGateNodeId）

// generateTown.ts
export type TownGenerationInput = { readonly seed: string; readonly plan?: TownSemanticPlan };
export class TownGenerationError extends Error { readonly issues: readonly TownValidationIssue[] }
export function generateTown(input: TownGenerationInput): TownSnapshot;
// plan 缺省 = createFallbackTownPlan(seed)。管线：terrain→anchors→roads→blocks/plots→buildings
// →validate；有 issue 时按序修复（换入口方向→开1–3格门前巷道 alley→泛化建筑降 reserved），
// 每轮修复后重验，≤20 次；仍失败以 hashTownSeed(seed + "#retry" + n) 派生 rng 重跑整镇 ≤3 次；
// 全败 throw TownGenerationError。成功产出 TownSnapshot（validation.repairCount/retryCount 如实记录）。
```

- [ ] **Step 1:** 写失败测试：手工构造含「入口缺失」「建筑压路」的 draft，`validateTownDraft` 返回对应 issue 码；`generateTown({seed:"demo-1"})` 成功且零 issue、同 seed 两次深度相等（`toEqual`）、不同 seed 的 buildings 布局不同；对被围地块场景修复后 entrance 门前格为道路。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现 validate + repair + 编排。
- [ ] **Step 4:** 运行 → PASS。
- [ ] **Step 5:** 写批量回归 `townGenerationBatch.test.ts`：`for i in 0..999: generateTown({seed: "batch-" + i})` 不抛错，且每镇断言——剧情建筑 3 栋全存在、从 mainGate BFS 所有 roadGraph 节点可达、每栋非 reserved 建筑门前格可寻路至 mainGate、无 footprint 重叠、无建筑覆盖 road/water/outside、`plots` 中 reserved 占比 ∈ [0.1, 0.35]；另断言 1000 次总耗时 < 60s（性能护栏，宽松）。
- [ ] **Step 6:** 运行 `npx vitest run src/game/gameplay/rpg/town` → 全 PASS（批量失败时先修生成器，不放宽断言）。
- [ ] **Step 7:** Commit：`feat(town): validation, repair loop, generateTown orchestrator and 1000-seed batch regression`

---

### Task 7: application 门面、预留生图 port 与依赖边界守卫

**Files:**
- Create: `src/game/application/townDemo.ts`、`src/game/application/townAssets.ts`
- Modify: `src/game/application/index.ts`（追加导出）
- Modify: `src/dependencyBoundaries.test.ts`
- Test: `src/game/application/townDemo.test.ts`、`src/game/application/townAssets.test.ts`

**Interfaces:**
- Consumes: `generateTown`、`TownSnapshot`（经 `@/game/gameplay/rpg/town` 门面）。
- Produces:

```ts
// townDemo.ts —— 纯同步投影，无 IO
export type TownDemoStats = { readonly buildingCount: number; readonly storyBuildingCount: number;
  readonly plotCount: number; readonly occupiedPlotCount: number; readonly reservedPlotCount: number;
  readonly repairCount: number; readonly retryCount: number };
export type TownDemoView = { readonly snapshot: TownSnapshot; readonly stats: TownDemoStats };
export type GenerateTownDemoResult =
  | { readonly ok: true; readonly view: TownDemoView }
  | { readonly ok: false; readonly code: "GENERATION_FAILED" | "INVALID_SEED" };
export function generateTownDemoView(seed: string): GenerateTownDemoResult;
// seed trim 后非空且 ≤ 64 字符，否则 INVALID_SEED；TownGenerationError → GENERATION_FAILED（不外泄细节）。

// townAssets.ts —— 预留生图 port：纯类型 + unavailable 工厂，无 IO/env/网络
export const TOWN_ASSET_CONTRACT_VERSION = "town-assets-v0" as const;
export type TownAssetKind = "building_exterior" | "town_illustration";
export type TownAssetStatus = "not_requested" | "queued" | "generating" | "ready" | "failed";
export type TownAssetRequest = { readonly kind: TownAssetKind; readonly targetId: string; readonly prompt: string };
export type TownAssetResult = { readonly status: TownAssetStatus; readonly assetUrl?: string };
export type TownIllustrationSource = { request(req: TownAssetRequest): Promise<TownAssetResult> };
export function createUnavailableTownIllustrationSource(): TownIllustrationSource; // 恒 { status: "not_requested" }
```

- [ ] **Step 1:** 写失败测试：`generateTownDemoView("demo-1")` ok 且 stats 与 snapshot 一致（数量对得上）；空串/全空白/65 字符 → INVALID_SEED；unavailable source 恒返回 not_requested 且不含 assetUrl。
- [ ] **Step 2:** 运行 → FAIL。
- [ ] **Step 3:** 实现两文件并从 `application/index.ts` 导出（`generateTownDemoView`、`TownDemoView`、`TownDemoStats`、`GenerateTownDemoResult`、townAssets 全部类型与工厂）。
- [ ] **Step 4:** 修改 `dependencyBoundaries.test.ts`：新增 `TOWN_DEEP_IMPORT` 模式（`@/game/gameplay/rpg/town/` deep-import 禁止，仿照 `BATTLE_DEEP_IMPORT`），加入 `UI_LAYER_PATTERNS`、`game/application` 规则、`app/api` 规则与合成违例样本。
- [ ] **Step 5:** 运行 `npx vitest run src/game/application/townDemo.test.ts src/game/application/townAssets.test.ts src/dependencyBoundaries.test.ts` → PASS。
- [ ] **Step 6:** Commit：`feat(town): application demo facade, reserved illustration port and boundary guards`

---

### Task 8: SVG 地图组件、建筑档案、占位图与 /town-demo 页面

**Files:**
- Create: `src/components/town/TownMapSvg.tsx`、`src/components/town/BuildingProfilePanel.tsx`、`src/components/town/BuildingPlaceholderArt.tsx`
- Create: `src/app/town-demo/page.tsx`（`"use client"` 页面组件 `TownDemoPage`）
- Modify: `src/app/globals.css`（追加 `.town-demo-*` 样式区块）
- Test: `src/components/town/TownMapSvg.test.tsx`、`src/components/town/BuildingProfilePanel.test.tsx`、`src/app/town-demo/townDemoPage.test.tsx`

**Interfaces:**
- Consumes: `generateTownDemoView`、`TownDemoView`、`TownSnapshot`（仅 `@/game/application` 门面）；`Panel`/`InlineButton`/`Tag` 来自 `@ai-game/ui` 根入口。
- Produces:

```tsx
// TownMapSvg.tsx
type TownMapSvgProps = {
  snapshot: TownSnapshot;
  selectedBuildingId: string | null;
  onSelectBuilding: (buildingId: string | null) => void;
  showPlotBorders?: boolean; showRoadNodes?: boolean;
};
export function TownMapSvg(props: TownMapSvgProps): JSX.Element;
// <svg viewBox="0 0 width*12 height*12">；每格 12px rect，fill 按 TileType 色表
// （outside #1a1d24 / grass #3d5a3a / forest #2c4630 / water #2a4d6e / road_main #b8a888 /
//   road_minor #8f836c / alley #6e6454 / square #c9b98f / plot #4a4438 / building #7d6b58 /
//   building_entrance #d9a441 / reserved #55504a）；
// 建筑整体再画一个可点击 <rect>（role="button" aria-label=displayName），storyRequired 加高亮描边；
// 点击空白处 onSelectBuilding(null)。

// BuildingPlaceholderArt.tsx —— SVG 占位外观图（无网络图片）
export function BuildingPlaceholderArt({ buildingType, seed }: { buildingType: TownBuildingType; seed: string }): JSX.Element;
// 200×120 SVG 简笔立面：按类型选屋顶形状/招牌元素，用 seed 派生的 hue 微调配色；纯确定性。

// BuildingProfilePanel.tsx
export function BuildingProfilePanel({ building, onClose }:
  { building: TownBuilding; onClose: () => void }): JSX.Element;
// Panel 内展示名称/类型/区域/definitionState/占地/入口方位 + BuildingPlaceholderArt +
// <Tag variant="warning">AI 生图未接入（预留接口）</Tag>
```

页面 `TownDemoPage`：`useState` 保存 seed 文本（初始 `"demo-1"`）、`GenerateTownDemoResult | null`、选中建筑 ID、两个调试开关；「生成」按钮调 `generateTownDemoView`；「随机种子」用 `crypto.randomUUID().slice(0, 8)`（UI 层允许随机，生成器仍确定）；顶部统计行渲染 `TownDemoStats`；INVALID_SEED/GENERATION_FAILED 显示 aria-live 错误文案。

- [ ] **Step 1:** 写失败组件测试：`TownMapSvg` 渲染出与 buildings 数量一致的 role="button" rect，点击触发 `onSelectBuilding(buildingId)`；`BuildingProfilePanel` 显示 displayName 与「AI 生图未接入」标签；页面测试——初始渲染 seed 输入框与生成按钮，点击生成后出现统计行与 SVG，点击建筑出现档案面板，输入空 seed 点生成显示错误文案。
- [ ] **Step 2:** `npx vitest run src/components/town src/app/town-demo` → FAIL。
- [ ] **Step 3:** 实现组件与页面；globals.css 加布局样式（地图区 + 侧栏档案两栏，窄屏纵排）。
- [ ] **Step 4:** 运行 → PASS；`npm run build` 通过。
- [ ] **Step 5:** 手工冒烟：`npm run dev` 打开 `/town-demo`，换 3 个 seed 观察布局差异与建筑点击。
- [ ] **Step 6:** Commit：`feat(town): svg town map, building profile with placeholder art and /town-demo page`

---

### Task 9: 文档、索引与全量验收

**Files:**
- Create: `docs/agent/小镇程序化生成.md`（从 `docs/agent/template.md` 结构填写）
- Modify: `docs/Agent文档索引.md`（当前索引表追加一行）
- Modify: `docs/游戏开发规范.md`（若 Task 7 边界规则有新增约定，补一行说明；无则不动）

- [ ] **Step 1:** 写 `docs/agent/小镇程序化生成.md`：系统定位（demo 支线，未接入主循环）、规则摘要（RFP-Town 管线 + Spec §5 参数表引用）、实现现状、主要文件（town 门面/townDemo/townAssets/components/town、/town-demo）、主要测试（batch 回归）、修改注意事项（生成器纯函数约束；**AI 生图未接入，只有 unavailable port**；不改 createFallbackBlueprint 的 RNG）。
- [ ] **Step 2:** `docs/Agent文档索引.md` 索引表追加：`| 小镇程序化生成 | agent/小镇程序化生成.md | 设想/AI驱动RPG_大地图-小镇地图-场景与小镇生成方案_v0.1.md | Demo 已实现：确定性生成器 + /town-demo SVG 演示；未接入游戏主循环与 AI 生图 |`。
- [ ] **Step 3:** 全量验收：

```powershell
npm run lint
npm test
npm run typecheck
npm run test:boundaries
npm run build
```

全部通过；确认 `git status` 无 db/tmp/log/.env.local 入库，`git diff --check` 干净。
- [ ] **Step 4:** Commit：`docs(town): agent doc, index entry and demo acceptance`

---

## Self-Review 记录

- Spec §2 包含项 ↔ Task 1–8 全覆盖；§6 验证规则 ↔ Task 6；§7 页面要素 ↔ Task 8；§8 验收 ↔ Task 6/8/9。
- 生图约束贯穿：Task 7 port 恒 unavailable、Task 8 占位图纯 SVG、Task 9 文档标注。
- 类型命名跨任务一致：`TownSnapshot`/`TownDraft`/`TownDemoView`/`TownIllustrationSource`。
