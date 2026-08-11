import type { WorldState, LocationEntry } from "@/game/domain/worldState";
import { locationScaleOf } from "@/game/domain/worldEntity";
import type { TownRuntimeState } from "@/game/domain/townState";
import { generateTown } from "@/game/gameplay/rpg/town";

// ---------------------------------------------------------------------------
// Task 7 读模型：TownView 只暴露快照、展示标签与已绑定可交互建筑条目。
// 不暴露 seed、空闲 slot、生成器内部、隐藏 NPC 或未批准地点。
// ---------------------------------------------------------------------------

export type InteractiveBuildingEntry = {
  readonly buildingId: string;
  readonly displayName: string;
  readonly buildingType: string;
  readonly npcId: string;
  readonly npcName: string;
};

export type TownRenderSnapshot = {
  readonly grid: { readonly width: number; readonly height: number; readonly tiles: readonly import("@/game/domain/townState").TileType[] };
  readonly buildings: readonly {
    readonly buildingId: string;
    readonly buildingType: import("@/game/domain/townState").TownBuildingType;
    readonly displayName: string;
    readonly footprint: import("@/game/domain/townState").Rect;
    readonly entrance: { readonly x: number; readonly y: number; readonly direction: import("@/game/domain/townState").Direction };
    readonly storyRequired: boolean;
    readonly definitionState: import("@/game/domain/townState").BuildingDefinitionState;
  }[];
  readonly roadGraph: { readonly nodes: readonly import("@/game/domain/townState").RoadNode[]; readonly edges: readonly import("@/game/domain/townState").RoadEdge[] };
  readonly plots: readonly import("@/game/domain/townState").TownPlot[];
};

export type TownView = {
  readonly townName: string;
  readonly snapshot: TownRenderSnapshot;
  readonly interactiveBuildings: readonly InteractiveBuildingEntry[];
};

export function buildTownView(worldState: WorldState, locationId: string): TownView | null {
  const location = worldState.locations.find((loc) => loc.id === locationId);
  if (location === undefined) return null;
  if (locationScaleOf(location) !== "town") return null;
  if (location.town === undefined) return null;

  const snapshot = generateTown({ seed: location.town.seed });
  const townName = location.name;

  // 已绑定 NPC 的 slot → 可交互建筑条目
  const interactiveBuildings: InteractiveBuildingEntry[] = [];
  for (const slot of location.town.slots) {
    if (slot.boundNpcId === null) continue;
    const npc = worldState.npcs.find((n) => n.id === slot.boundNpcId);
    if (npc === undefined) continue;
    const building = snapshot.buildings.find((b) => b.buildingId === slot.buildingId);
    if (building === undefined) continue;
    interactiveBuildings.push({
      buildingId: slot.buildingId,
      displayName: building.displayName,
      buildingType: slot.buildingType,
      npcId: slot.boundNpcId,
      npcName: npc.name,
    });
  }

  return {
    townName,
    snapshot: {
      grid: { width: snapshot.grid.width, height: snapshot.grid.height, tiles: snapshot.grid.tiles },
      buildings: snapshot.buildings.map((b) => ({
        buildingId: b.buildingId,
        buildingType: b.buildingType,
        displayName: b.displayName,
        footprint: b.footprint,
        entrance: b.entrance,
        storyRequired: b.storyRequired,
        definitionState: b.definitionState,
      })),
      roadGraph: snapshot.roadGraph,
      plots: snapshot.plots,
    },
    interactiveBuildings,
  };
}