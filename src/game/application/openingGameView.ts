import type { GameState, GameTypeId, ScenarioBlueprint } from "@/game/domain";
import type { GameId } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// OpeningGameView（Task 1）：面向浏览器的开场 read model。
// 只从已编译蓝图 + 初始 GameState 投影，UI 不得自行拼装规则事实。
// 刻意不包含：完整蓝图、隐藏地点、未解锁任务、结局、敌人数值、
// seed / inputDigest（可复现生成的内部信息）以及任何 repository 实体。
// ---------------------------------------------------------------------------

export type OpeningWorldView = {
  /** 展示用世界名称：蓝图暂无独立世界名，Phase 2 取类型 profile 的 label。 */
  readonly name: string;
  readonly summary: string;
  readonly gameType: GameTypeId;
};

export type OpeningPlayerView = {
  readonly name: string;
  readonly identity: string;
};

export type OpeningLocationView = {
  readonly name: string;
  readonly description: string;
};

export type OpeningNpcView = {
  readonly name: string;
  readonly role: string;
};

export type OpeningItemView = {
  readonly name: string;
  readonly description: string;
};

/** generation metadata 中允许展示的非敏感字段（seed/inputDigest 不外泄）。 */
export type OpeningGenerationView = {
  readonly generationId: string;
  readonly templateVersion: string;
};

export type OpeningGameView = {
  readonly gameId: GameId;
  readonly world: OpeningWorldView;
  readonly player: OpeningPlayerView;
  readonly currentLocation: OpeningLocationView;
  readonly visibleNpcs: readonly OpeningNpcView[];
  readonly initialItems: readonly OpeningItemView[];
  readonly openingNarration: string;
  readonly suggestedActions: readonly string[];
  readonly generation: OpeningGenerationView;
};

export type ProjectOpeningGameViewInput = {
  readonly gameId: GameId;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  /** 展示用世界名称：由 use case 从类型 profile 的 label 提供（非规则事实）。 */
  readonly worldName: string;
};

/** 编译与初始化保证引用完整；命中缺失说明调用方传入了不配套的蓝图/状态。 */
function requireEntity<T>(entity: T | undefined, kind: string): T {
  if (entity === undefined) {
    throw new Error(`开场视图投影失败：${kind}引用在蓝图中不存在`);
  }
  return entity;
}

export function projectOpeningGameView(input: ProjectOpeningGameViewInput): OpeningGameView {
  const { gameId, blueprint, state, worldName } = input;
  const currentLocation = requireEntity(
    blueprint.locations.find((entry) => entry.id === state.currentLocationId),
    "当前地点"
  );
  const npcById = new Map(blueprint.npcs.map((npc) => [npc.id, npc]));
  const itemById = new Map(blueprint.items.map((item) => [item.id, item]));

  return {
    gameId,
    world: {
      name: worldName,
      summary: blueprint.world.summary,
      gameType: blueprint.gameType
    },
    player: {
      name: state.player.name,
      identity: state.player.identity
    },
    currentLocation: {
      name: currentLocation.name,
      description: currentLocation.description
    },
    // 可见 NPC 只来自开场场景的在场名单，不暴露全体 NPC 分布。
    visibleNpcs: blueprint.openingScene.presentNpcIds.map((npcId) => {
      const npc = requireEntity(npcById.get(npcId), "开场 NPC");
      return { name: npc.name, role: npc.role };
    }),
    initialItems: state.inventory.map((itemId) => {
      const item = requireEntity(itemById.get(itemId), "初始物品");
      return { name: item.name, description: item.description };
    }),
    openingNarration: blueprint.openingScene.narration,
    suggestedActions: [...blueprint.openingScene.suggestedActions],
    generation: {
      generationId: blueprint.generationId,
      templateVersion: blueprint.templateVersion
    }
  };
}
