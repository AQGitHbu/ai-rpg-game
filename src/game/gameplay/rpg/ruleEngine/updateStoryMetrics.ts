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

// Spec §13.2：storyProgress 由主线 stage/目标比例推导，不在此固定 +10。
// 本模块只更新 tension（确定性张力指标），storyProgress 由 advanceStoryProgression 按
// 主线 stage 比例推导。此处保持 prev.storyProgress 不变。
export function updateStoryMetrics(prev: StoryState, newEvents: readonly GameEvent[]): StoryState {
  let tension = prev.tension;

  for (const event of newEvents) {
    switch (event.type) {
      case "battle_started": tension += TENSION_CHANGES.battle_started; break;
      case "battle_resolved":
        tension +=
          event.outcome === "victory"
            ? TENSION_CHANGES.battle_resolved_victory
            : event.outcome === "withdraw"
              ? TENSION_CHANGES.battle_resolved_withdraw
              : TENSION_CHANGES.battle_resolved_defeat;
        break;
      case "fact_discovered":
        // 保留既有基础张力 12，并加上所选调查方式的额外张力（缺省/自动揭示为 0）；
        // evidence quality 随事件留在 event ledger，供后续 narrative context 使用。
        tension += TENSION_CHANGES.fact_discovered + (event.tensionDelta ?? 0);
        break;
      case "quest_completed": tension += TENSION_CHANGES.quest_completed; break;
      case "npc_met": tension += TENSION_CHANGES.npc_met; break;
    }
  }

  const tension2 = clampTension(tension);
  const nextPacingNeed = derivePacingNeed({ ...prev, tension: tension2, storyProgress: prev.storyProgress });

  return { ...prev, tension: tension2, storyProgress: prev.storyProgress, nextPacingNeed };
}
