import type { GameState, QuestObjective, ScenarioBlueprint } from "@/game/domain";
import {
  projectAvailableActions,
  type AvailableAction
} from "@/game/gameplay/rpg/actions";
import { isQuestObjectiveSatisfied } from "@/game/gameplay/rpg/quests";
import {
  projectOpeningGameView,
  type AvailableActionView,
  type OpeningGameView,
  type OpeningNpcView,
  type ProjectOpeningGameViewInput
} from "./openingGameView";

// ---------------------------------------------------------------------------
// GameSessionView（Phase 4 Task 3）：OpeningGameView 演进出的语义中性场景
// read model。plan 固定规则：availableActions 不再过滤 move、追加运行时
// presentNpcs 与 active 任务摘要；仍不泄漏锁定任务、隐藏地点、完整蓝图、
// seed / inputDigest。OpeningGameView 类型原样保留（Task 4 前 UI 仍引用）。
// ---------------------------------------------------------------------------

/** 会话视图的可用行动：在 opening 三种之上追加 move（UI 安全的 plain string）。 */
export type SessionActionView =
  | AvailableActionView
  | { readonly type: "move"; readonly locationId: string; readonly label: string };

/** 任务 objective 的展示视图：未支持类型（obtain_item/defeat_enemy）标记为后续阶段能力。 */
export type QuestObjectiveView = {
  readonly label: string;
  readonly completed: boolean;
  /** false = 本阶段无法推进的 objective（后续阶段能力），UI 不得显示为可完成。 */
  readonly supported: boolean;
};

export type ActiveQuestView = {
  readonly name: string;
  readonly description: string;
  readonly kind: "main" | "side";
  readonly objectives: readonly QuestObjectiveView[];
};

export type GameSessionView = Omit<OpeningGameView, "availableActions"> & {
  readonly availableActions: readonly SessionActionView[];
  /** 运行时位于当前地点的 NPC：与 visibleNpcs（开场名单快照）语义区分。 */
  readonly presentNpcs: readonly OpeningNpcView[];
  /** 仅 active 任务：locked/completed/closed 一律不出现，名称与 ID 不泄漏。 */
  readonly activeQuests: readonly ActiveQuestView[];
};

/** 输入与 opening 投影完全一致：调用方无需区分两个 read model 的装配来源。 */
export type ProjectGameSessionViewInput = ProjectOpeningGameViewInput;

function toSessionActionView(
  action: Exclude<AvailableAction, { type: "take_item" }>
): SessionActionView {
  switch (action.type) {
    case "observe":
      return { type: "observe", locationId: action.locationId, label: action.label };
    case "talk":
      return { type: "talk", npcId: action.npcId, label: action.label };
    case "investigate":
      return { type: "investigate", factId: action.factId, label: action.label };
    case "move":
      return { type: "move", locationId: action.locationId, label: action.label };
  }
}

/**
 * objective 展示标签：只描述目标，不泄漏未解锁的世界内容。
 * 未解锁地点 / 未发现事实 / 物品与敌人一律用中性文案。
 */
function projectObjectiveView(
  blueprint: ScenarioBlueprint,
  state: GameState,
  objective: QuestObjective
): QuestObjectiveView {
  const completed = isQuestObjectiveSatisfied(state, objective);
  switch (objective.kind) {
    case "visit_location": {
      const unlocked = state.unlockedLocationIds.includes(objective.locationId);
      const location = blueprint.locations.find((entry) => entry.id === objective.locationId);
      return {
        label: unlocked && location !== undefined ? `到访${location.name}` : "探寻未知之地",
        completed,
        supported: true
      };
    }
    case "talk_to_npc": {
      const npc = blueprint.npcs.find((entry) => entry.id === objective.npcId);
      return {
        label: npc !== undefined ? `与${npc.name}交谈` : "寻访关键人物",
        completed,
        supported: true
      };
    }
    case "discover_fact":
      return { label: "查明相关线索", completed, supported: true };
    case "obtain_item":
      // Phase 4 未支持：永不完成，UI 应标注为后续阶段能力。
      return { label: "取得关键物品", completed: false, supported: false };
    case "defeat_enemy":
      return { label: "战胜强敌", completed: false, supported: false };
  }
}

export function projectGameSessionView(input: ProjectGameSessionViewInput): GameSessionView {
  const { blueprint, state } = input;
  const base = projectOpeningGameView(input);
  const npcById = new Map(blueprint.npcs.map((npc) => [npc.id, npc]));
  const questById = new Map(blueprint.quests.map((quest) => [quest.id, quest]));

  return {
    ...base,
    // 不再过滤 move：完整的可用行动投影（观察/交谈/调查/前往）。
    // take_item 暂不进入会话视图：由 Phase 5 Task 3/4 接入 read model 与 UI。
    availableActions: projectAvailableActions(blueprint, state)
      .filter(
        (action): action is Exclude<AvailableAction, { type: "take_item" }> =>
          action.type !== "take_item"
      )
      .map(toSessionActionView),
    // 运行时在场 NPC：按 GameState 中的 NPC 位置投影，不读开场名单。
    presentNpcs: state.npcs
      .filter((npcState) => npcState.locationId === state.currentLocationId)
      .map((npcState) => {
        const npc = npcById.get(npcState.npcId);
        if (npc === undefined) {
          throw new Error("会话视图投影失败：在场 NPC 引用在蓝图中不存在");
        }
        return { name: npc.name, role: npc.role };
      }),
    activeQuests: state.quests
      .filter((questState) => questState.status === "active")
      .map((questState) => {
        const quest = questById.get(questState.questId);
        if (quest === undefined) {
          throw new Error("会话视图投影失败：active 任务引用在蓝图中不存在");
        }
        return {
          name: quest.name,
          description: quest.description,
          kind: quest.kind,
          objectives: quest.objectives.map((objective) =>
            projectObjectiveView(blueprint, state, objective)
          )
        };
      })
  };
}
