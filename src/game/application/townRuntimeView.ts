import type {
  ScenarioBlueprint,
  TownBuildingType,
  TownPlanSource,
  TownRuntimeState,
  TownSnapshot
} from "@/game/domain";
import {
  generateTown,
  projectTownSemanticView,
  type TownSemanticView
} from "@/game/gameplay/rpg/town";

// ---------------------------------------------------------------------------
// Town 层 read model：由 GameState.towns 条目（seed + plan）经 generateTown
// 确定性重建快照，再投影为 UI 渲染所需的小镇层视图。纯同步、无 IO/env/随机：
// 同条目深度相等。剧情建筑经 planKey（story_npc_<npcId>）反查绑定 NPC，
// 供第三层「点击建筑 → 打开该 NPC 对话」的纯 UI 导航使用。
// ---------------------------------------------------------------------------

/** 剧情建筑 key 前缀：与 gameplay 的 createTownPlanFromLocation 约定一致。 */
const STORY_NPC_KEY_PREFIX = "story_npc_";

/** snapshot 的数量投影：UI 展示用，逐项可与 snapshot 对账。 */
export type TownLayerStats = {
  readonly buildingCount: number;
  readonly storyBuildingCount: number;
  readonly plotCount: number;
};

/** 可交互剧情建筑：buildingKey ↔ NPC 绑定，UI 点击后打开对应 NPC 对话。 */
export type TownInteractiveBuildingView = {
  readonly buildingId: string;
  /** plan.requiredBuildings.key（story_npc_<npcId>）。 */
  readonly buildingKey: string;
  readonly displayName: string;
  readonly buildingType: TownBuildingType;
  readonly npcIds: readonly string[];
};

/** 剥离 seed 的渲染快照：镇 seed 派生自蓝图 seed，不得进入客户端 view。 */
export type TownRenderSnapshot = Omit<TownSnapshot, "seed">;

export type TownLayerView = {
  readonly locationId: string;
  readonly townName: string;
  readonly planSource: TownPlanSource;
  /** 权威快照（已脱敏）：由 seed+plan 重建，UI 直接渲染网格/道路/建筑。 */
  readonly snapshot: TownRenderSnapshot;
  readonly stats: TownLayerStats;
  readonly interactiveBuildings: readonly TownInteractiveBuildingView[];
  /** 语义投影：方位/邻近句子，UI 档案与叙事上下文共用。 */
  readonly semanticView: TownSemanticView;
};

/**
 * towns 条目 → 小镇层视图。地点引用缺失抛错（记录被改坏，由调用方映射
 * 稳定失败）；planKey 指向蓝图外 NPC 的建筑不投影为可交互建筑（AI 候选
 * 允许附加自创剧情建筑，跳过而非抛错）。
 */
export function projectTownLayerView(
  blueprint: ScenarioBlueprint,
  town: TownRuntimeState
): TownLayerView {
  const location = blueprint.locations.find(
    (entry) => String(entry.id) === String(town.locationId)
  );
  if (location === undefined) {
    throw new Error("小镇视图投影失败：地点引用在蓝图中不存在");
  }
  const snapshot = generateTown({ seed: town.seed, plan: town.plan });
  // 脱敏：逐字段重建渲染快照，剔除携带蓝图 seed 的 snapshot.seed。
  const renderSnapshot: TownRenderSnapshot = {
    snapshotVersion: snapshot.snapshotVersion,
    generatorVersion: snapshot.generatorVersion,
    plan: snapshot.plan,
    grid: snapshot.grid,
    roadGraph: snapshot.roadGraph,
    blocks: snapshot.blocks,
    plots: snapshot.plots,
    buildings: snapshot.buildings,
    mainGateNodeId: snapshot.mainGateNodeId,
    validation: snapshot.validation
  };
  const knownNpcIds = new Set(blueprint.npcs.map((npc) => String(npc.id)));

  const interactiveBuildings: TownInteractiveBuildingView[] = [];
  for (const building of snapshot.buildings) {
    const key = building.planKey;
    if (key === undefined || !key.startsWith(STORY_NPC_KEY_PREFIX)) continue;
    const npcId = key.slice(STORY_NPC_KEY_PREFIX.length);
    if (!knownNpcIds.has(npcId)) continue;
    interactiveBuildings.push({
      buildingId: building.buildingId,
      buildingKey: key,
      displayName: building.displayName,
      buildingType: building.buildingType,
      npcIds: [npcId]
    });
  }

  return {
    locationId: String(town.locationId),
    townName: location.name,
    planSource: town.planSource,
    snapshot: renderSnapshot,
    stats: {
      buildingCount: snapshot.buildings.length,
      storyBuildingCount: snapshot.buildings.filter((building) => building.storyRequired).length,
      plotCount: snapshot.plots.length
    },
    interactiveBuildings,
    semanticView: projectTownSemanticView(snapshot, location.name)
  };
}
