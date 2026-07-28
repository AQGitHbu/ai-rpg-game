import type { GameState, GameTypeId, ScenarioBlueprint } from "@/game/domain";
import {
  projectAvailableActions,
  type AvailableAction
} from "@/game/gameplay/rpg/actions";
import type { GameId } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// OpeningGameView（Phase 2 + Phase 3）：面向浏览器的开场 read model。
// 只从已编译蓝图 + 当前 GameState 投影，UI 不得自行拼装规则事实。
// Phase 3 扩展：revision、availableActions、knownFacts。
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
  /** 已知的基础数值；战斗中的当前生命由 GameSessionView.battle 单独投影。 */
  readonly stats: { readonly hp: number; readonly attack: number; readonly defense: number };
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

/** UI 安全的可用行动视图：品牌化 ID 降级为 plain string，附展示用 label。 */
export type AvailableActionView =
  | { readonly type: "observe"; readonly locationId: string; readonly label: string }
  | { readonly type: "talk"; readonly npcId: string; readonly label: string }
  | { readonly type: "investigate"; readonly factId: string; readonly label: string };

/** 已发现事实的展示视图：只含文本，不含 ID 或来源等内部信息。 */
export type OpeningFactView = {
  readonly text: string;
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
  // Phase 3 扩展：
  /** 当前存档 revision：客户端提交行动时必须附带此值。 */
  readonly revision: number;
  /** 当前可执行的行动列表：由蓝图 + 状态投影，UI 不得自行猜测。 */
  readonly availableActions: readonly AvailableActionView[];
  /** 已发现的世界事实：只展示已发现的，不泄漏未发现事实。 */
  readonly knownFacts: readonly OpeningFactView[];
};

export type ProjectOpeningGameViewInput = {
  readonly gameId: GameId;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  /** 当前存档 revision：初始为 0，每次成功行动递增。 */
  readonly revision: number;
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

/** 将 actions facade 的 AvailableAction 转为 UI 安全的 AvailableActionView。 */
function toActionView(
  action: Extract<AvailableAction, { type: "observe" | "talk" | "investigate" }>
): AvailableActionView {
  switch (action.type) {
    case "observe":
      return { type: "observe", locationId: action.locationId, label: action.label };
    case "talk":
      return { type: "talk", npcId: action.npcId, label: action.label };
    case "investigate":
      return { type: "investigate", factId: action.factId, label: action.label };
  }
}

export function projectOpeningGameView(input: ProjectOpeningGameViewInput): OpeningGameView {
  const { gameId, blueprint, state, revision, worldName } = input;
  const currentLocation = requireEntity(
    blueprint.locations.find((entry) => entry.id === state.currentLocationId),
    "当前地点"
  );
  const npcById = new Map(blueprint.npcs.map((npc) => [npc.id, npc]));
  const itemById = new Map(blueprint.items.map((item) => [item.id, item]));
  const factById = new Map(blueprint.world.facts.map((fact) => [fact.id, fact]));

  return {
    gameId,
    world: {
      name: worldName,
      summary: blueprint.world.summary,
      gameType: blueprint.gameType
    },
    player: {
      name: state.player.name,
      identity: state.player.identity,
      stats: state.player.stats
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
    },
    revision,
    // Phase 4 Task 1 新增 move 投影：opening view 的 move 展示由 Task 3/4 接入，此处先过滤。
    // Phase 6：start_battle / battle_action 也不属于 opening view，由会话视图与 BattlePanel 接入。
    availableActions: projectAvailableActions(blueprint, state)
      .filter(
        (action): action is Extract<AvailableAction, { type: "observe" | "talk" | "investigate" }> =>
          action.type === "observe" || action.type === "talk" || action.type === "investigate"
      )
      .map(toActionView),
    // 已发现事实：只展示文本，不泄漏未发现事实的 ID 或内容。
    knownFacts: state.worldFacts
      .filter((f) => f.discovered)
      .map((f) => {
        const fact = requireEntity(factById.get(f.factId), "已发现事实");
        return { text: fact.text };
      })
  };
}
