import { tileIndex, type TileType, type TownSemanticPlan } from "@/game/domain";
import type { TownRng } from "./townRandom";

// 地形阶段：椭圆边界 + 河流水带 + 森林斑块，产出后续管线共用的底图三数组。
// 纯函数：随机只来自传入 rng；同 seed 同 plan 深度相等（见 terrain.test.ts）。

/** 底图寻路代价（Spec §5）：平地 1 与道路 0.4 由后续道路阶段引入，不在底图。 */
const ROAD_COST: Readonly<Record<"grass" | "forest" | "water", number>> = {
  grass: 1.2,
  forest: 3,
  water: 20
};

/** 椭圆边界的角度扰动桶数：每桶独立 ±2 格半径偏移。 */
const BOUNDARY_ANGLE_BUCKETS = 32;

/** forest 斑块总量上限：占全网格面积比例。 */
const FOREST_AREA_RATIO = 0.08;

export type TerrainLayout = {
  readonly width: number;
  readonly height: number;
  /** 扁平行优先；城外/水域 false，草地/森林 true。 */
  readonly buildableMask: readonly boolean[];
  /** outside/grass/forest/water 底图。 */
  readonly baseTiles: readonly TileType[];
  /** 草 1.2 / 林 3 / 水 20 / 城外 Infinity。 */
  readonly roadCost: readonly number[];
};

export function generateTerrain(plan: TownSemanticPlan, rng: TownRng): TerrainLayout {
  const { width, height } = plan.gridSize;
  const grid = { width };
  const baseTiles: TileType[] = new Array<TileType>(width * height).fill("outside");

  // 1. 椭圆边界：中心 (w/2,h/2)，半径 (w/2-3,h/2-3)，逐角度桶 ±2 格 rng 扰动。
  const offsets: number[] = [];
  for (let i = 0; i < BOUNDARY_ANGLE_BUCKETS; i += 1) offsets.push(rng.nextInt(5) - 2);
  const centerX = width / 2;
  const centerY = height / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      const angle = Math.atan2(dy, dx);
      const bucket =
        Math.floor(((angle + Math.PI) / (2 * Math.PI)) * BOUNDARY_ANGLE_BUCKETS) %
        BOUNDARY_ANGLE_BUCKETS;
      const radiusX = width / 2 - 3 + offsets[bucket];
      const radiusY = height / 2 - 3 + offsets[bucket];
      const normalized = (dx / radiusX) ** 2 + (dy / radiusY) ** 2;
      if (normalized <= 1) baseTiles[tileIndex(grid, x, y)] = "grass";
    }
  }

  // 2. 河流：north/south → 对应侧 2–3 行整幅水带（覆盖 outside/grass）。
  if (plan.terrain.river !== "none") {
    const bandHeight = 2 + rng.nextInt(2);
    const startRow = plan.terrain.river === "north" ? 0 : height - bandHeight;
    for (let y = startRow; y < startRow + bandHeight; y += 1) {
      for (let x = 0; x < width; x += 1) {
        baseTiles[tileIndex(grid, x, y)] = "water";
      }
    }
  }

  // 3. 森林斑块：随机游走将草地翻为森林，总量 ≤ 面积 8%。
  const forestBudget = Math.floor(width * height * FOREST_AREA_RATIO);
  const patchCount = 3 + rng.nextInt(3);
  let forestPlaced = 0;
  for (let patch = 0; patch < patchCount && forestPlaced < forestBudget; patch += 1) {
    let x = 4 + rng.nextInt(width - 8);
    let y = 4 + rng.nextInt(height - 8);
    const walkLength = 10 + rng.nextInt(11);
    for (let step = 0; step < walkLength && forestPlaced < forestBudget; step += 1) {
      const index = tileIndex(grid, x, y);
      if (baseTiles[index] === "grass") {
        baseTiles[index] = "forest";
        forestPlaced += 1;
      }
      const direction = rng.nextInt(4);
      if (direction === 0) x = Math.min(width - 1, x + 1);
      else if (direction === 1) x = Math.max(0, x - 1);
      else if (direction === 2) y = Math.min(height - 1, y + 1);
      else y = Math.max(0, y - 1);
    }
  }

  // 4. 由底图派生可建掩码与寻路代价。
  const buildableMask: boolean[] = new Array(width * height);
  const roadCost: number[] = new Array(width * height);
  for (let i = 0; i < baseTiles.length; i += 1) {
    const tile = baseTiles[i];
    buildableMask[i] = tile === "grass" || tile === "forest";
    roadCost[i] = tile === "outside" ? Number.POSITIVE_INFINITY : ROAD_COST[tile as keyof typeof ROAD_COST];
  }

  return { width, height, buildableMask, baseTiles, roadCost };
}
