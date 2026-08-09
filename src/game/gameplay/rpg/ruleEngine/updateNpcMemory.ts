import type { NpcEntry, NpcInteraction } from "@/game/domain/worldState";
import { clampAffinity } from "@/game/domain/relationship";
import type { NarrativeEmotion } from "@/game/domain/narrative";

export const NPC_INTERACTION_HISTORY_LIMIT = 10;

export function trimInteractionHistory(
  history: readonly NpcInteraction[],
): readonly NpcInteraction[] {
  if (history.length <= NPC_INTERACTION_HISTORY_LIMIT) return history;
  return history.slice(history.length - NPC_INTERACTION_HISTORY_LIMIT);
}

/** 是否已存在同 actionId 的记录（CAS 失败路径的零写入保护）。 */
export function hasInteractionForAction(
  history: readonly NpcInteraction[],
  actionId: string,
): boolean {
  return history.some((h) => h.actionId === actionId);
}

export function appendInteraction(
  history: readonly NpcInteraction[],
  interaction: NpcInteraction,
): readonly NpcInteraction[] {
  // 同 actionId 不因错误重试追加两次：命中即返回原 history（零写入）。
  if (hasInteractionForAction(history, interaction.actionId)) return history;
  return trimInteractionHistory([...history, interaction]);
}

function emotionForOutcome(
  outcome: NpcInteraction["outcome"],
  prevEmotion: NarrativeEmotion,
): NarrativeEmotion {
  if (outcome === "positive") return "warm";
  if (outcome === "negative") return "guarded";
  // mixed：至少一方态度缓和（关系不净变负），情绪靠向中性偏暖。
  if (outcome === "mixed") return prevEmotion === "guarded" || prevEmotion === "angry" ? "neutral" : prevEmotion;
  return prevEmotion;
}

export function updateNpcMemory(npc: NpcEntry, interaction: NpcInteraction): NpcEntry {
  const newAffinity = clampAffinity(
    npc.memory.relationship.affinity + interaction.relationshipDelta,
  );
  const newHistory = appendInteraction(npc.memory.interactionHistory, interaction);
  const newEmotion = emotionForOutcome(interaction.outcome, npc.memory.emotion);

  return {
    ...npc,
    memory: {
      ...npc.memory,
      interactionHistory: newHistory,
      relationship: { affinity: newAffinity },
      emotion: newEmotion,
    },
  };
}
