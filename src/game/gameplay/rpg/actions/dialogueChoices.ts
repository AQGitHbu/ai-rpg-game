import type { GameState, NpcId, ScenarioBlueprint } from "@/game/domain";
import { isQuestObjectiveSatisfied } from "../quests";

// ---------------------------------------------------------------------------
// 封闭的 NPC 对话选择规则（Phase 7 Task 2）。
//
// choice 是封闭枚举：choiceId 只能是 `${npcId}:${kind}`，解析要求与
// makeDialogueChoiceId 的产出完全相等，禁止额外分隔符或任意 kind。
// 投影语义（互斥）：
//   - greet：NPC 位于当前地点、未结识，且不存在该 NPC 的未完成 active
//     talk_to_npc objective 时投影；
//   - ask_main_quest：NPC 位于当前地点、未结识，且 active 主线任务存在
//     未满足的 talk_to_npc objective 指向该 NPC 时投影（替代 greet 文案，
//     仍只产生既有 npc_met 事件）；
//   - 已结识 NPC：空数组。
// 不依赖 application、repository、UI、Date、Math.random 或 AI。
// ---------------------------------------------------------------------------

export const DIALOGUE_CHOICE_KINDS = ["greet", "ask_main_quest"] as const;
export type DialogueChoiceKind = (typeof DIALOGUE_CHOICE_KINDS)[number];

export type DialogueChoiceIntent = {
  readonly type: "dialogue_choice";
  readonly npcId: NpcId;
  readonly choiceId: string;
};

export type DialogueChoice = {
  readonly kind: DialogueChoiceKind;
  readonly choiceId: string;
  readonly label: string;
};

export function makeDialogueChoiceId(npcId: NpcId, kind: DialogueChoiceKind): string {
  return `${npcId}:${kind}`;
}

/** 解析 choiceId：只接受与 makeDialogueChoiceId 完全相等的值，否则返回 null。 */
export function parseDialogueChoiceKind(
  npcId: NpcId,
  choiceId: string,
): DialogueChoiceKind | null {
  for (const kind of DIALOGUE_CHOICE_KINDS) {
    if (choiceId === makeDialogueChoiceId(npcId, kind)) {
      return kind;
    }
  }
  return null;
}

/** 收集把该 NPC 作为未满足 talk_to_npc objective 目标的 active 任务。 */
function findActiveTalkObjectiveQuests(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
) {
  return blueprint.quests.filter((quest) => {
    const status = state.quests.find((qs) => qs.questId === quest.id)?.status;
    if (status !== "active") return false;
    return quest.objectives.some(
      (objective) =>
        objective.kind === "talk_to_npc" &&
        objective.npcId === npcId &&
        !isQuestObjectiveSatisfied(state, objective),
    );
  });
}

export function projectDialogueChoices(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
): readonly DialogueChoice[] {
  const npc = blueprint.npcs.find((n) => n.id === npcId);
  const npcState = state.npcs.find((n) => n.npcId === npcId);
  // 未知 NPC、不在当前地点或已结识：没有任何对话选择。
  if (npc === undefined || npcState === undefined) return [];
  if (npcState.locationId !== state.currentLocationId || npcState.met) return [];

  const talkQuests = findActiveTalkObjectiveQuests(blueprint, state, npcId);
  if (talkQuests.some((quest) => quest.kind === "main")) {
    return [
      {
        kind: "ask_main_quest",
        choiceId: makeDialogueChoiceId(npcId, "ask_main_quest"),
        label: "询问当前线索",
      },
    ];
  }
  // 存在非主线 talk 目标时同样抑制 greet（封闭语义：不投影就不可用）。
  if (talkQuests.length > 0) return [];
  return [
    {
      kind: "greet",
      choiceId: makeDialogueChoiceId(npcId, "greet"),
      label: `与${npc.name}初次交谈`,
    },
  ];
}
