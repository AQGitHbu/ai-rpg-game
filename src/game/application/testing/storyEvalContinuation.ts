import type { GameState, ScenarioBlueprint } from "@/game/domain";
import {
  projectAvailableActions,
  type AvailableAction,
  type PlayerIntent,
} from "@/game/gameplay/rpg/actions";
import { actionKeyOf } from "@/game/gameplay/rpg/narrative";

/**
 * 评测驱动器的规则续行：当规则层只剩一个合法的非战斗行动时，直接执行
 * 该行动，让“可玩但没有足够选项生成叙事”的状态继续推进。它不改变生产
 * eligibility（生产叙事仍要求两个候选），只避免把 runner 的停止误报成死局。
 */
export type StoryEvalContinuation = Readonly<{
  actionKey: string;
  label: string;
  intent: PlayerIntent;
  reason: "single_legal_action";
}>;

type NonBattleAction = Exclude<AvailableAction, { readonly type: "battle_action" }>;

function intentOf(action: NonBattleAction): PlayerIntent {
  switch (action.type) {
    case "observe": return { type: "observe", locationId: action.locationId };
    case "talk": return { type: "talk", npcId: action.npcId };
    case "investigate": return { type: "investigate", factId: action.factId };
    case "move": return { type: "move", locationId: action.locationId };
    case "take_item": return { type: "take_item", itemId: action.itemId };
    case "start_battle": return { type: "start_battle", enemyId: action.enemyId };
  }
}

export function projectStoryEvalContinuation(
  blueprint: ScenarioBlueprint,
  state: GameState,
): StoryEvalContinuation | null {
  const actions = projectAvailableActions(blueprint, state);
  if (actions.length !== 1 || actions[0]?.type === "battle_action") return null;
  const action = actions[0] as NonBattleAction;
  return {
    actionKey: actionKeyOf(action),
    label: action.label,
    intent: intentOf(action),
    reason: "single_legal_action",
  };
}
