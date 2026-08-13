import type { WorldState } from "@/game/domain/worldState";
import { locationScaleOf } from "@/game/domain/worldEntity";
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
  /** 只有当前主线目标人物所在的入口才显示“当前剧情”。 */
  readonly isCurrentFocus: boolean;
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

export function buildTownView(
  worldState: WorldState,
  locationId: string,
  currentFocusNpcId?: string | null,
): TownView | null {
  const location = worldState.locations.find((loc) => loc.id === locationId);
  if (location === undefined) return null;
  if (locationScaleOf(location) !== "town") return null;
  if (location.town === undefined) return null;

  const snapshot = generateTown({ seed: location.town.seed });
  const townName = location.name;

  // 已绑定 NPC 的 slot → 可交互建筑条目。
  // 旧存档/早期运行链可能只写了 NpcEntry.locationId（或 LocationEntry.npcIds），
  // 没有同步写回 slot.boundNpcId。读模型在不改变权威存档的前提下，用当前地点
  // 实际在场的已批准 NPC 补齐空闲剧情 slot，避免“目标 NPC 在镇里但没有建筑入口”。
  const presentNpcIds = worldState.npcs
    .filter((npc) => npc.locationId === location.id)
    .map((npc) => npc.id);
  const slotBindings = new Map<string, string>();
  const boundNpcIds = new Set<string>();
  for (const slot of location.town.slots) {
    if (slot.boundNpcId === null) continue;
    const npc = worldState.npcs.find((entry) => entry.id === slot.boundNpcId);
    if (npc === undefined || npc.locationId !== location.id) continue;
    slotBindings.set(slot.buildingId, slot.boundNpcId);
    boundNpcIds.add(String(slot.boundNpcId));
  }
  const freeStoryBuildingIds = location.town.slots
    .filter((slot) => !slotBindings.has(slot.buildingId))
    .map((slot) => slot.buildingId);
  for (const npcId of presentNpcIds) {
    if (boundNpcIds.has(String(npcId))) continue;
    const buildingId = freeStoryBuildingIds.shift();
    if (buildingId === undefined) break;
    slotBindings.set(buildingId, npcId);
    boundNpcIds.add(String(npcId));
  }

  const interactiveBuildings: InteractiveBuildingEntry[] = [];
  for (const slot of location.town.slots) {
    const boundNpcId = slotBindings.get(slot.buildingId);
    if (boundNpcId === undefined) continue;
    const npc = worldState.npcs.find((n) => n.id === boundNpcId);
    if (npc === undefined) continue;
    const building = snapshot.buildings.find((b) => b.buildingId === slot.buildingId);
    if (building === undefined) continue;
    interactiveBuildings.push({
      buildingId: slot.buildingId,
      displayName: building.displayName,
      buildingType: slot.buildingType,
      npcId: boundNpcId,
      npcName: npc.name,
      isCurrentFocus: String(boundNpcId) === String(currentFocusNpcId ?? ""),
    });
  }

  // 满槽小镇也不能把当前主线人物丢到一个“临时会面”开发入口里。
  // 若目标人物没有绑定 slot，就借用第一个剧情建筑作为当前镜头入口；
  // 建筑几何不变，旧 NPC 仍保留在世界状态，地图层只把入口焦点交给当前目标。
  const focusNpc = currentFocusNpcId === null || currentFocusNpcId === undefined
    ? undefined
    : worldState.npcs.find((npc) => String(npc.id) === String(currentFocusNpcId) && npc.locationId === location.id);
  if (focusNpc !== undefined && !boundNpcIds.has(String(focusNpc.id))) {
    const focusBuildingId = interactiveBuildings[0]?.buildingId
      ?? location.town.slots[0]?.buildingId;
    const focusBuilding = focusBuildingId === undefined
      ? undefined
      : snapshot.buildings.find((building) => building.buildingId === focusBuildingId);
    if (focusBuilding !== undefined) {
      const existingIndex = interactiveBuildings.findIndex((entry) => entry.buildingId === focusBuilding.buildingId);
      const focusEntry: InteractiveBuildingEntry = {
        buildingId: focusBuilding.buildingId,
        displayName: focusBuilding.displayName,
        buildingType: focusBuilding.buildingType,
        npcId: String(focusNpc.id),
        npcName: focusNpc.name,
        isCurrentFocus: true,
      };
      if (existingIndex >= 0) interactiveBuildings[existingIndex] = focusEntry;
      else interactiveBuildings.push(focusEntry);
    }
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
