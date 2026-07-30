import type { GameState, NpcId, ScenarioBlueprint } from "@/game/domain";
import { isQuestObjectiveSatisfied } from "../quests";

// ---------------------------------------------------------------------------
// NPC 对白组合规则（对话布局重构）：由蓝图 NPC 资料 + 当前任务状态确定性
// 组合出多句对白文本，供 application 投影并分页展示。
// 组合语义（封闭）：
//   - 基底：npc.description（缺终止符时补句号）；
//   - 未结识：追加自我介绍句；已结识：追加重逢句；
//   - 未结识且存在未满足的 active 主线 talk_to_npc 目标指向该 NPC：
//     再追加任务求助句（引用任务 name + description）；
//   - 未知 NPC / 不在当前地点：空串。
// 不依赖 application、repository、UI、Date、Math.random 或 AI。
// ---------------------------------------------------------------------------

/** 结尾无句读时补句号，保证句子之间边界稳定。 */
function ensureTerminated(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return /[。！？…!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/** 找到把该 NPC 作为未满足 talk_to_npc objective 目标的第一个 active 主线任务。 */
function findUnmetMainTalkQuest(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
) {
  return blueprint.quests.find((quest) => {
    if (quest.kind !== "main") return false;
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

export function composeNpcSpeech(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
): string {
  const npc = blueprint.npcs.find((n) => n.id === npcId);
  const npcState = state.npcs.find((n) => n.npcId === npcId);
  if (npc === undefined || npcState === undefined) return "";
  if (npcState.locationId !== state.currentLocationId) return "";

  const sentences: string[] = [ensureTerminated(npc.description)];
  if (npcState.met) {
    sentences.push("又见面了，若有新的发现，随时可以来找我。");
    return sentences.join("");
  }
  sentences.push(`初次见面，我是${npc.name}，${npc.role}。`);
  const talkQuest = findUnmetMainTalkQuest(blueprint, state, npcId);
  if (talkQuest !== undefined) {
    sentences.push(
      `最近发生了一些奇怪的事情——${ensureTerminated(talkQuest.description)}你愿意帮我们调查吗？`
    );
  }
  return sentences.join("");
}
