import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { budgetAllowsExpansion } from "@/game/domain/storyBudget";
import type { EvolutionNeed } from "@/game/domain/worldDelta";

// ---------------------------------------------------------------------------
// Task 3：从已提交状态派生下一个世界演化需求。
// 优先级：既有演化状态标记（下一幕 / 结局对）> 节奏需求 > 无需求。
// 节奏需求仅在终幕衔接（climax/resolve、结局对进行中）之外且事件预算充足时出现。
// ---------------------------------------------------------------------------

export function deriveEvolutionNeed(ws: WorldState, ss: StoryState): EvolutionNeed {
  const evolutionStatus = ss.evolution.status;
  if (evolutionStatus === "needs_next_act") {
    return { kind: "next_act", act: ss.currentAct };
  }
  if (evolutionStatus === "needs_ending_pair") {
    return { kind: "ending_pair", finalAct: ss.currentAct };
  }

  const pacing = ss.nextPacingNeed;
  if (pacing === "climax" || pacing === "resolve") {
    return { kind: "none" };
  }

  if (
    evolutionStatus === "stable" &&
    ss.currentAct >= 2 &&
    ss.tension < 30 &&
    budgetAllowsExpansion(ss.budget, "events")
  ) {
    return {
      kind: "pacing",
      pacingNeed: pacing === "escalate" ? "escalate" : "complicate",
    };
  }

  return { kind: "none" };
}
