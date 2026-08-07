import type { StoryState } from "@/game/domain/storyState";
import { clampTension, derivePacingNeed } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";

export const TENSION_CHANGES = {
  battle_started: 15,
  battle_resolved_victory: 20,
  battle_resolved_defeat: -12,
  battle_resolved_withdraw: -12,
  fact_discovered: 12,
  quest_completed: 8,
  npc_met: 3,
} as const;

export function updateStoryMetrics(prev: StoryState, newEvents: readonly GameEvent[]): StoryState {
  let tension = prev.tension;
  let storyProgress = prev.storyProgress;

  for (const event of newEvents) {
    switch (event.type) {
      case "battle_started": tension += TENSION_CHANGES.battle_started; break;
      case "battle_resolved":
        tension += event.outcome === "victory" ? TENSION_CHANGES.battle_resolved_victory : TENSION_CHANGES.battle_resolved_defeat;
        break;
      case "fact_discovered": tension += TENSION_CHANGES.fact_discovered; break;
      case "quest_completed":
        tension += TENSION_CHANGES.quest_completed;
        storyProgress = Math.min(100, storyProgress + 10);
        break;
      case "npc_met": tension += TENSION_CHANGES.npc_met; break;
    }
  }

  const tension2 = clampTension(tension);
  const nextPacingNeed = derivePacingNeed({ ...prev, tension: tension2, storyProgress });

  return { ...prev, tension: tension2, storyProgress, nextPacingNeed };
}
