import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ObjectiveRef, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import { isObjectiveSatisfied, objectiveLabel } from "./objectiveRules";

export type DeriveObjectiveTransitionInput = {
  readonly beforeWorldState: WorldState;
  readonly beforeStoryState: StoryState;
  readonly afterWorldState: WorldState;
  readonly afterStoryState: StoryState;
};

function refsEqual(a: ObjectiveRef | null, b: ObjectiveRef | null): boolean {
  if (!a || !b) return a === b;
  return a.questId === b.questId && a.objectiveIndex === b.objectiveIndex && a.label === b.label;
}

// authoritative：当前幕第一个 active 主线任务的首个未完成目标；无则回退到第一个 active 任务。
export function currentObjectiveOf(ws: WorldState, ss: StoryState): ObjectiveRef | null {
  const mainline = ws.quests.find(
    (q) => q.status === "active" && q.kind === "main" && q.stage === ss.currentAct,
  );
  const quest = mainline ?? ws.quests.find((q) => q.status === "active");
  if (!quest) return null;
  const reveal = ss.reveal !== undefined && ss.reveal !== null
    && String(ss.reveal.questId) === String(quest.id)
    ? ss.reveal
    : null;
  const maxVisibleIndex = reveal === null
    ? quest.objectives.length - 1
    : Math.min(reveal.visibleObjectiveIndex, quest.objectives.length - 1);
  const firstOpen = quest.objectives.findIndex((obj, index) =>
    index <= maxVisibleIndex && !isObjectiveSatisfied(ws, obj),
  );
  const objectiveIndex = firstOpen === -1
    ? Math.max(0, maxVisibleIndex)
    : firstOpen;
  return {
    questId: quest.id,
    objectiveIndex,
    label: objectiveLabel(ws, quest.objectives[objectiveIndex]),
  };
}

function completedObjectives(
  beforeW: WorldState,
  afterW: WorldState,
  before: ObjectiveRef | null,
): ObjectiveRef[] {
  if (!before) return [];
  const beforeQuest = beforeW.quests.find((q) => q.id === before.questId);
  const afterQuest = afterW.quests.find((q) => q.id === before.questId);
  if (!beforeQuest || !afterQuest) return [];
  const completed: ObjectiveRef[] = [];
  for (let i = 0; i <= before.objectiveIndex && i < beforeQuest.objectives.length; i += 1) {
    const objective = beforeQuest.objectives[i];
    if (objective && !isObjectiveSatisfied(beforeW, objective) && isObjectiveSatisfied(afterW, objective)) {
      completed.push({
        questId: before.questId,
        objectiveIndex: i,
        label: objectiveLabel(afterW, afterQuest.objectives[i] ?? objective),
      });
    }
  }
  return completed;
}

export function deriveObjectiveTransition(input: DeriveObjectiveTransitionInput): ObjectiveTransition {
  const { beforeWorldState, beforeStoryState, afterWorldState, afterStoryState } = input;
  const before = currentObjectiveOf(beforeWorldState, beforeStoryState);
  const after = currentObjectiveOf(afterWorldState, afterStoryState);

  if (afterStoryState.endingAllowed || afterStoryState.evolution.status === "needs_ending_pair") {
    return { before, completed: [], after, mode: "ready_for_ending" };
  }

  const completed = completedObjectives(beforeWorldState, afterWorldState, before);
  const actAdvanced = afterStoryState.currentAct > beforeStoryState.currentAct;

  if (actAdvanced) {
    return { before, completed, after, mode: "advanced_act" };
  }
  if (completed.length > 0 || !refsEqual(before, after)) {
    return { before, completed, after, mode: "progressed" };
  }
  return { before, completed: [], after, mode: "unchanged" };
}
