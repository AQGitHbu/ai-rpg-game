import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";
import { derivePacingNeed } from "@/game/domain/storyState";

export type StoryProgressionResult = {
  readonly nextStoryState: StoryState;
  readonly events: readonly GameEvent[];
};

function actProgressThreshold(act: number, targetActs: number): number {
  return Math.floor((act - 1) / targetActs * 100);
}

function shouldAdvanceAct(ws: WorldState, ss: StoryState, events: readonly GameEvent[]): boolean {
  const mainQuestCompleted = events.some(
    (e) => e.type === "quest_completed" &&
    ws.quests.find((q) => q.id === e.questId)?.kind === "main",
  );
  if (!mainQuestCompleted) return false;

  const currentActMainQuests = ws.quests.filter(
    (q) => q.kind === "main" && q.stage === ss.currentAct,
  );
  return currentActMainQuests.every((q) => q.status === "completed" || q.status === "failed");
}

export function advanceStoryProgression(
  ws: WorldState,
  ss: StoryState,
  newEvents: readonly GameEvent[],
): StoryProgressionResult {
  let currentAct = ss.currentAct;
  let storyProgress = ss.storyProgress;
  let endingAllowed = ss.endingAllowed;
  let unresolvedThreads = ss.unresolvedThreads;

  if (shouldAdvanceAct(ws, ss, newEvents) && currentAct < ss.targetActs) {
    currentAct += 1;
    storyProgress = Math.max(storyProgress, actProgressThreshold(currentAct, ss.targetActs));

    const actThread = `act_${ss.currentAct}`;
    unresolvedThreads = unresolvedThreads.filter((t) => t !== actThread);
    if (!unresolvedThreads.includes(`act_${currentAct}`)) {
      unresolvedThreads = [...unresolvedThreads, `act_${currentAct}`];
    }
  }

  if (currentAct >= ss.targetActs && storyProgress >= 80) {
    endingAllowed = true;
  }

  const nextPacingNeed = derivePacingNeed({
    ...ss,
    currentAct,
    storyProgress,
    endingAllowed,
    unresolvedThreads,
  });

  return {
    nextStoryState: {
      ...ss,
      currentAct,
      storyProgress,
      endingAllowed,
      unresolvedThreads,
      nextPacingNeed,
    },
    events: [],
  };
}
