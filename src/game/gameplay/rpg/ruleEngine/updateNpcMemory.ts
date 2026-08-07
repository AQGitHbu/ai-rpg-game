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

export function appendInteraction(
  history: readonly NpcInteraction[],
  interaction: NpcInteraction,
): readonly NpcInteraction[] {
  return trimInteractionHistory([...history, interaction]);
}

function emotionForOutcome(
  outcome: NpcInteraction["outcome"],
  prevEmotion: NarrativeEmotion,
): NarrativeEmotion {
  if (outcome === "positive") return "warm";
  if (outcome === "negative") return "guarded";
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
