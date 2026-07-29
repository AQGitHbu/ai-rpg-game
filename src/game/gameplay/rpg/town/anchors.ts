import { tileIndex, type Cell, type TownDistrictType, type TownSemanticPlan, type AreaHint } from "@/game/domain";
import type { TownRng } from "./townRandom";
import type { TerrainLayout } from "./terrain";

// 锚点阶段：在地形上放置城门/广场/区域中心/水井，供道路管线连通。
// 纯函数：随机只来自传入 rng；约束不满足时向外螺旋探测重选（不放弃产出）。

/** 锚点两两最小曼哈顿间距（Spec §5）。 */
const MIN_ANCHOR_DISTANCE = 4;

/** 区域中心目标点的 rng 抖动幅度（±2 格）。 */
const CENTER_JITTER = 2;

export type TownAnchor = {
  readonly id: string;
  readonly kind: "gate" | "square" | "district_center" | "poi";
  readonly cell: Cell;
  readonly districtType?: TownDistrictType;
};

function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function isBuildable(terrain: TerrainLayout, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) return false;
  return terrain.buildableMask[tileIndex(terrain, x, y)];
}

function farEnough(cell: Cell, placed: readonly TownAnchor[]): boolean {
  return placed.every((anchor) => manhattan(anchor.cell, cell) >= MIN_ANCHOR_DISTANCE);
}

/** 从目标点按曼哈顿菱形环向外螺旋，取首个「可建 + 满足间距」格。 */
function spiralProbe(
  target: Cell,
  terrain: TerrainLayout,
  placed: readonly TownAnchor[]
): Cell {
  const maxRadius = terrain.width + terrain.height;
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const dyAbs = radius - Math.abs(dx);
      for (const dy of dyAbs === 0 ? [0] : [dyAbs, -dyAbs]) {
        const cell = { x: target.x + dx, y: target.y + dy };
        if (isBuildable(terrain, cell.x, cell.y) && farEnough(cell, placed)) return cell;
      }
    }
  }
  throw new Error(`placeAnchors: 在 (${target.x},${target.y}) 附近找不到满足约束的可建格`);
}

/** 沿外路轴从边界向内扫描，取首个可建格（城门原始落点）。 */
function scanGateCell(
  terrain: TerrainLayout,
  side: "west" | "east" | "north" | "south"
): Cell | null {
  const midX = Math.floor(terrain.width / 2);
  const midY = Math.floor(terrain.height / 2);
  if (side === "west" || side === "east") {
    const step = side === "west" ? 1 : -1;
    for (let x = side === "west" ? 0 : terrain.width - 1; x >= 0 && x < terrain.width; x += step) {
      if (isBuildable(terrain, x, midY)) return { x, y: midY };
    }
    return null;
  }
  const step = side === "north" ? 1 : -1;
  for (let y = side === "north" ? 0 : terrain.height - 1; y >= 0 && y < terrain.height; y += step) {
    if (isBuildable(terrain, midX, y)) return { x: midX, y };
  }
  return null;
}

/** 区位提示 → 网格目标点（edge 仅 reserved 使用，不在本阶段出现，兜底给北侧）。 */
function areaTarget(area: AreaHint, terrain: TerrainLayout): Cell {
  const { width, height } = terrain;
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  switch (area) {
    case "center":
      return { x: midX, y: midY };
    case "north":
      return { x: midX, y: Math.floor(height / 4) };
    case "south":
      return { x: midX, y: Math.floor((height * 3) / 4) };
    case "east":
      return { x: Math.floor((width * 3) / 4), y: midY };
    case "west":
      return { x: Math.floor(width / 4), y: midY };
    case "edge":
      return { x: midX, y: Math.floor(height / 4) };
  }
}

export function placeAnchors(
  plan: TownSemanticPlan,
  terrain: TerrainLayout,
  rng: TownRng
): readonly TownAnchor[] {
  const anchors: TownAnchor[] = [];
  const place = (id: string, kind: TownAnchor["kind"], target: Cell, districtType?: TownDistrictType): void => {
    const cell = spiralProbe(target, terrain, anchors);
    anchors.push(districtType === undefined ? { id, kind, cell } : { id, kind, cell, districtType });
  };

  // 1. 城门：externalRoad 方向两端边界内侧首个可建格；主门固定取西/北端。
  const [mainSide, secondarySide] =
    plan.terrain.externalRoad === "east_west" ? (["west", "east"] as const) : (["north", "south"] as const);
  const midCell = { x: Math.floor(terrain.width / 2), y: Math.floor(terrain.height / 2) };
  place("anchor_gate_main", "gate", scanGateCell(terrain, mainSide) ?? midCell);
  place("anchor_gate_secondary", "gate", scanGateCell(terrain, secondarySide) ?? midCell);

  // 2. 广场：最靠近网格中心的可建格（螺旋自证最近）。
  place("anchor_square", "square", midCell);

  // 3. 区域中心：每个非 reserved district 一个，目标点带 ±2 格 rng 抖动。
  for (const district of plan.districts) {
    if (district.type === "reserved") continue;
    const base = areaTarget(district.preferredArea, terrain);
    const target = {
      x: base.x + rng.nextInt(CENTER_JITTER * 2 + 1) - CENTER_JITTER,
      y: base.y + rng.nextInt(CENTER_JITTER * 2 + 1) - CENTER_JITTER
    };
    place(`anchor_district_${district.type}`, "district_center", target, district.type);
  }

  // 4. 水井地标：按 plan.landmarks 区位（缺省居中）。
  const wellArea = plan.landmarks.find((landmark) => landmark.type === "well")?.preferredArea ?? "center";
  place("anchor_poi_well", "poi", areaTarget(wellArea, terrain));

  return anchors;
}
