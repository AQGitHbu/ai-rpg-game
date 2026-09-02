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

/**
 * `NpcEntry.met` 只表示玩家已经接触过 NPC；两轮正式对白仍必须由同一
 * `dialogueSession` 结算后才能满足 talk_to_npc。否则第一轮规则回合写入
 * met=true 后，目标转换会提前生成 npc_handoff，下一幕就会按收尾合同省略
 * 两个正式对白选项。
 */
export function isObjectiveSatisfiedInStory(
  ws: WorldState,
  ss: StoryState,
  objective: WorldState["quests"][number]["objectives"][number],
): boolean {
  if (!isObjectiveSatisfied(ws, objective)) return false;
  if (objective.kind !== "talk_to_npc") return true;
  const session = ss.narrative.dialogueSession;
  if (session === undefined) return true;
  // 旧 NPC 的 completed 会话不能完成当前 NPC 的目标；规则层可能已经在
  // 本回合把新 NPC 标记为 met，但这只代表接触发生，不代表两轮对白结束。
  if (String(session.npcId) !== String(objective.npcId)) {
    return ws.eventLedger.some((event) =>
      event.kind === "npc_dialogue_completed" && (event.payload as { npcId: string }).npcId === objective.npcId);
  }
  return session.completed;
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
    index <= maxVisibleIndex && !isObjectiveSatisfiedInStory(ws, ss, obj),
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
  beforeS: StoryState,
  afterS: StoryState,
  before: ObjectiveRef | null,
): ObjectiveRef[] {
  if (!before) return [];
  const beforeQuest = beforeW.quests.find((q) => q.id === before.questId);
  const afterQuest = afterW.quests.find((q) => q.id === before.questId);
  if (!beforeQuest || !afterQuest) return [];
  const completed: ObjectiveRef[] = [];
  for (let i = 0; i <= before.objectiveIndex && i < beforeQuest.objectives.length; i += 1) {
    const objective = beforeQuest.objectives[i];
    if (
      objective
      && !isObjectiveSatisfiedInStory(beforeW, beforeS, objective)
      && isObjectiveSatisfiedInStory(afterW, afterS, objective)
    ) {
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

  const completed = completedObjectives(
    beforeWorldState,
    afterWorldState,
    beforeStoryState,
    afterStoryState,
    before,
  );
  const actAdvanced = afterStoryState.currentAct > beforeStoryState.currentAct;

  if (actAdvanced) {
    return { before, completed, after, mode: "advanced_act" };
  }
  if (completed.length > 0 || !refsEqual(before, after)) {
    return { before, completed, after, mode: "progressed" };
  }
  return { before, completed: [], after, mode: "unchanged" };
}
