import {
  TOWN_GENERATOR_VERSION,
  tileIndex,
  type Cell,
  type Direction,
  type Rect,
  type TileType,
  type TownBlock,
  type TownBuilding,
  type TownPlot,
  type TownSemanticPlan,
  type TownSnapshot
} from "@/game/domain/townState";
import { createTownRng, hashTownSeed } from "./townRandom";
import { createFallbackTownPlan } from "./fallbackTownPlan";
import { generateTerrain } from "./terrain";
import { placeAnchors } from "./anchors";
import { buildRoadNetwork } from "./roads";
import { buildBlocksAndPlots } from "./blocks";
import { placeBuildings } from "./buildings";
import { computeRoadReachable, validateTownDraft, type TownDraft, type TownValidationIssue } from "./validateTown";

// 顶层编排：terrain → anchors → roads → blocks/plots → buildings → validate。
// 有 issue 时按序局部修复（换入口方向 → 开 1–3 格门前巷道 → 舍弃非剧情建筑，
// footprint 回写地面、地块回退 generic，理由见 discardBuilding），每轮修复后重验；
// 修复以「验证轮次」计数 ≤ 20（一轮批量处理
// 当轮全部可修 issue —— 若按建筑逐个计数，plot 环带导致的高频
// ENTRANCE_UNREACHABLE 会耗尽预算）。仍失败以 hashTownSeed(seed+"#retry"+n)
// 派生 seed 重跑整镇 ≤ 3 次；全败抛 TownGenerationError。
// 纯函数：随机只来自 seed，同 seed 深度相等。

/** 修复轮次上限（Spec §5：单次生成 ≤ 20 次修复）。 */
const MAX_REPAIR_PASSES = 20;

/** seed 变体重试上限（Spec §5）。 */
const MAX_RETRIES = 3;

/** 门前巷道最大开凿格数（Spec §5：1–3 格）。 */
const MAX_ALLEY_LENGTH = 3;

/** 巷道可穿越的瓦片：草/林/裸地块/预留地（不穿建筑/道路/水/城外）。 */
const CARVABLE_TILES: ReadonlySet<TileType> = new Set<TileType>(["grass", "forest", "plot", "reserved"]);

/** 4 朝向固定序（北南西东，与 buildings.ts 一致）：修复扫描的平局裁决。 */
const SIDES: readonly Direction[] = ["north", "south", "west", "east"];

const SIDE_OFFSETS: Readonly<Record<Direction, { readonly dx: number; readonly dy: number }>> = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 }
};

export type TownGenerationInput = {
  readonly seed: string;
  readonly plan?: TownSemanticPlan;
};

export class TownGenerationError extends Error {
  readonly issues: readonly TownValidationIssue[];

  constructor(message: string, issues: readonly TownValidationIssue[]) {
    super(message);
    this.name = "TownGenerationError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// 可变工作草稿（仅本模块内部；对外仍是不可变 TownDraft/TownSnapshot）
// ---------------------------------------------------------------------------

type WorkingDraft = {
  readonly width: number;
  readonly height: number;
  readonly groundTiles: TileType[];
  readonly tiles: TileType[];
  readonly roadGraph: TownDraft["roadGraph"];
  readonly blocks: readonly TownBlock[];
  plots: TownPlot[];
  buildings: TownBuilding[];
  readonly mainGateNodeId: string;
};

/** footprint 某边的边界格（坐标升序，与 buildings.ts 一致）。 */
function boundaryCells(footprint: Rect, side: Direction): Cell[] {
  const cells: Cell[] = [];
  const right = footprint.x + footprint.width - 1;
  const bottom = footprint.y + footprint.height - 1;
  if (side === "north" || side === "south") {
    const y = side === "north" ? footprint.y : bottom;
    for (let x = footprint.x; x <= right; x += 1) cells.push({ x, y });
  } else {
    const x = side === "west" ? footprint.x : right;
    for (let y = footprint.y; y <= bottom; y += 1) cells.push({ x, y });
  }
  return cells;
}

/** 入口改写：旧入口格回写 building，新入口格写 building_entrance。 */
function moveEntrance(draft: WorkingDraft, building: TownBuilding, entrance: TownBuilding["entrance"]): void {
  draft.tiles[tileIndex(draft, building.entrance.x, building.entrance.y)] = "building";
  draft.tiles[tileIndex(draft, entrance.x, entrance.y)] = "building_entrance";
  const index = draft.buildings.findIndex((item) => item.buildingId === building.buildingId);
  draft.buildings[index] = { ...building, entrance };
}

/**
 * 修复①（优先，见上游提醒：兜底门可能开向邻居的墙）：换入口方向。
 * 扫描序 = 当前朝向 → 其余固定序、边界格升序，找门前格已是
 * 「主城门可达道路」的边界格。
 */
function tryReselectEntrance(
  draft: WorkingDraft,
  building: TownBuilding,
  roadReachable: readonly boolean[]
): boolean {
  const sides = [building.entrance.direction, ...SIDES.filter((side) => side !== building.entrance.direction)];
  for (const side of sides) {
    for (const cell of boundaryCells(building.footprint, side)) {
      const x = cell.x + SIDE_OFFSETS[side].dx;
      const y = cell.y + SIDE_OFFSETS[side].dy;
      if (x < 0 || y < 0 || x >= draft.width || y >= draft.height) continue;
      if (!roadReachable[tileIndex(draft, x, y)]) continue;
      moveEntrance(draft, building, { x: cell.x, y: cell.y, direction: side });
      return true;
    }
  }
  return false;
}

/**
 * 修复②：开 1–3 格门前巷道。从边界格沿朝向直线外探，若 ≤3 格可穿越
 * 瓦片后碰到主城门可达的道路，则把沿途格开为 alley 并把入口移到该
 * 边界格。取（巷道最短 → 朝向固定序 → 边界格升序）的首个方案，确定性。
 */
function tryCarveAlley(
  draft: WorkingDraft,
  building: TownBuilding,
  roadReachable: readonly boolean[]
): boolean {
  const sides = [building.entrance.direction, ...SIDES.filter((side) => side !== building.entrance.direction)];
  let best: { readonly entrance: TownBuilding["entrance"]; readonly carve: readonly number[] } | null = null;
  for (const side of sides) {
    const offset = SIDE_OFFSETS[side];
    for (const cell of boundaryCells(building.footprint, side)) {
      const carve: number[] = [];
      for (let step = 1; step <= MAX_ALLEY_LENGTH + 1; step += 1) {
        const x = cell.x + offset.dx * step;
        const y = cell.y + offset.dy * step;
        if (x < 0 || y < 0 || x >= draft.width || y >= draft.height) break;
        const index = tileIndex(draft, x, y);
        if (roadReachable[index]) {
          // step=1 属修复①范围；这里只接需要真开凿的方案（carve ≥ 1）。
          if (carve.length >= 1 && (best === null || carve.length < best.carve.length)) {
            best = { entrance: { x: cell.x, y: cell.y, direction: side }, carve: [...carve] };
          }
          break;
        }
        if (!CARVABLE_TILES.has(draft.tiles[index]) || carve.length >= MAX_ALLEY_LENGTH) break;
        carve.push(index);
      }
    }
  }
  if (best === null) return false;
  for (const index of best.carve) {
    draft.groundTiles[index] = "alley";
    draft.tiles[index] = "alley";
  }
  moveEntrance(draft, building, best.entrance);
  return true;
}

/**
 * 修复③：舍弃非剧情建筑。建筑移除、footprint 格回写 plot、地块回退
 * generic（不强制降 reserved：预留率由 Task 5 按 0.2 控制，这里再加
 * reserved 会把小镇占比抽出批量回归的 [0.1, 0.35] 区间）。
 */
function discardBuilding(draft: WorkingDraft, building: TownBuilding): void {
  draft.buildings = draft.buildings.filter((item) => item.buildingId !== building.buildingId);
  const plotIndex = draft.plots.findIndex((plot) => plot.id === building.plotId);
  if (plotIndex !== -1) draft.plots[plotIndex] = { ...draft.plots[plotIndex], status: "generic" };
  const { footprint } = building;
  for (let y = footprint.y; y < footprint.y + footprint.height; y += 1) {
    for (let x = footprint.x; x < footprint.x + footprint.width; x += 1) {
      const index = tileIndex(draft, x, y);
      draft.tiles[index] = draft.groundTiles[index];
    }
  }
}

/** 地块降 reserved：残留 plot/building 格回写 reserved（已开的巷道保留）。 */
function downgradePlot(draft: WorkingDraft, plotId: string): void {
  const plotIndex = draft.plots.findIndex((plot) => plot.id === plotId);
  if (plotIndex === -1) return;
  const plot = draft.plots[plotIndex];
  draft.plots[plotIndex] = { ...plot, status: "reserved" };
  for (const cell of plot.cells) {
    const index = tileIndex(draft, cell.x, cell.y);
    if (draft.tiles[index] === "plot" || draft.tiles[index] === "building" || draft.tiles[index] === "building_entrance") {
      draft.tiles[index] = "reserved";
    }
    if (draft.groundTiles[index] === "plot") draft.groundTiles[index] = "reserved";
  }
}

/**
 * 单轮修复：批量处理当轮全部可修 issue，返回是否有任何修复动作。
 * 建筑类 issue 按「换入口 → 开巷道 → 舍弃泛化建筑」次序尝试；
 * 剧情建筑不可舍弃，三招落空即本轮无解（交由 seed 变体重试）。
 */
function repairPass(draft: WorkingDraft, issues: readonly TownValidationIssue[]): boolean {
  let applied = false;
  const buildingById = (): Map<string, TownBuilding> =>
    new Map(draft.buildings.map((building) => [building.buildingId, building]));

  for (const issue of issues) {
    if (issue.code === "ANCHOR_UNREACHABLE") continue; // 局部不可修，只能重试
    if (issue.code === "PLOT_FRONTAGE_TOO_SMALL") {
      // 临街不足：地块连同其上建筑（若有且非剧情）一并降 reserved。
      const building = draft.buildings.find((item) => item.plotId === issue.plotId);
      if (building !== undefined) {
        if (building.storyRequired) continue;
        discardBuilding(draft, building);
      }
      downgradePlot(draft, issue.plotId);
      applied = true;
      continue;
    }
    const building = buildingById().get(issue.buildingId);
    if (building === undefined) continue; // 已被前序修复移除
    if (issue.code === "BUILDING_OVERLAP" || issue.code === "BUILDING_ON_FORBIDDEN_TILE") {
      if (building.storyRequired) continue;
      discardBuilding(draft, building);
      applied = true;
      continue;
    }
    // ENTRANCE_MISSING / ENTRANCE_UNREACHABLE：换入口 → 开巷道 → 舍弃。
    const roadReachable = computeRoadReachable(draft);
    if (tryReselectEntrance(draft, building, roadReachable)) applied = true;
    else if (tryCarveAlley(draft, building, roadReachable)) applied = true;
    else if (!building.storyRequired) {
      discardBuilding(draft, building);
      applied = true;
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

/** 单次完整管线：派生 seed → 五阶段 → 可变草稿。 */
function runPipeline(effectiveSeed: string, plan: TownSemanticPlan): WorkingDraft {
  const terrain = generateTerrain(plan, createTownRng(`${effectiveSeed}:terrain`));
  const anchors = placeAnchors(plan, terrain, createTownRng(`${effectiveSeed}:anchors`));
  const roads = buildRoadNetwork(anchors, terrain, createTownRng(`${effectiveSeed}:roads`));
  const blockPlots = buildBlocksAndPlots(roads, terrain, plan, createTownRng(`${effectiveSeed}:blocks`));
  const placement = placeBuildings(plan, blockPlots, roads, createTownRng(`${effectiveSeed}:buildings`));
  // 地面层 = 建筑写入前的 blocks 瓦片 + placement 的 reserved 覆写。
  const groundTiles = [...blockPlots.tiles];
  for (let i = 0; i < placement.tiles.length; i += 1) {
    if (placement.tiles[i] === "reserved") groundTiles[i] = "reserved";
  }
  return {
    width: plan.gridSize.width,
    height: plan.gridSize.height,
    groundTiles,
    tiles: [...placement.tiles],
    roadGraph: roads.roadGraph,
    blocks: blockPlots.blocks,
    plots: [...placement.plots],
    buildings: [...placement.buildings],
    mainGateNodeId: roads.mainGateNodeId
  };
}

/**
 * 剧情建筑齐全性：Task 5 无可用地块时静默跳过（不产出建筑），验证
 * issue 码不含「建筑缺失」专码 → 归入最贴近的 ENTRANCE_MISSING
 * （建筑不存在自然无入口），buildingId 用 requiredBuilding.key。
 * 不可局部修复，出现即触发 seed 变体重试。
 */
function collectStoryIssues(plan: TownSemanticPlan, draft: WorkingDraft): TownValidationIssue[] {
  const issues: TownValidationIssue[] = [];
  for (const required of plan.requiredBuildings) {
    const exists = draft.buildings.some(
      (building) => building.storyRequired && building.buildingType === required.buildingType
    );
    if (!exists) issues.push({ code: "ENTRANCE_MISSING", buildingId: required.key });
  }
  return issues;
}

export function generateTown(input: TownGenerationInput): TownSnapshot {
  const plan = input.plan ?? createFallbackTownPlan(input.seed);
  let lastIssues: readonly TownValidationIssue[] = [];

  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    const effectiveSeed = retry === 0 ? input.seed : hashTownSeed(`${input.seed}#retry${retry}`);
    const draft = runPipeline(effectiveSeed, plan);

    // 剧情建筑缺失局部不可修 → 直接进入下一轮重试。
    const storyIssues = collectStoryIssues(plan, draft);
    if (storyIssues.length > 0) {
      lastIssues = storyIssues;
      continue;
    }

    let repairCount = 0;
    let issues = validateTownDraft(draft);
    while (issues.length > 0 && repairCount < MAX_REPAIR_PASSES) {
      if (!repairPass(draft, issues)) break; // 无可修动作 → 重试
      repairCount += 1;
      issues = validateTownDraft(draft);
    }
    lastIssues = issues;
    if (issues.length > 0) continue;

    return {
      snapshotVersion: 1,
      seed: input.seed,
      generatorVersion: TOWN_GENERATOR_VERSION,
      plan,
      grid: { width: draft.width, height: draft.height, tiles: draft.tiles },
      roadGraph: draft.roadGraph,
      blocks: draft.blocks,
      plots: draft.plots,
      buildings: draft.buildings,
      mainGateNodeId: draft.mainGateNodeId,
      validation: { valid: true, repairCount, retryCount: retry }
    };
  }

  throw new TownGenerationError(
    `generateTown: seed "${input.seed}" 修复与重试均失败（issue ${lastIssues.length} 个）`,
    lastIssues
  );
}
