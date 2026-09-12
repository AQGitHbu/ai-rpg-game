import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeEventDraft } from "@/game/domain/events";
import { derivePacingNeed } from "@/game/domain/storyState";
import { unresolvedStoryThreadIds } from "@/game/domain/storyThreads";

export type StoryProgressionResult = {
  readonly nextStoryState: StoryState;
  readonly drafts: readonly NarrativeEventDraft[];
};

// 主线 thread 的固定命名（Spec §13.3：开局 thread ID 与主线一致，不得出现
// main_thread 初始 + act_N 推进的命名不一致）。实际主线 thread ID 由调用方
// 传入 mainThreadId（compile 用 thread_main），此处以 mainThreadId 归一。
function mainThreadId(ss: StoryState): string {
  return ss.threads.find((thread) => thread.kind === "question")?.id
    ?? ss.threads[0]?.id
    ?? "main_thread";
}

function actProgressThreshold(act: number, targetActs: number): number {
  return Math.floor((act - 1) / targetActs * 100);
}

function shouldAdvanceAct(ws: WorldState, ss: StoryState, drafts: readonly NarrativeEventDraft[]): boolean {
  const mainQuestCompleted = drafts.some(
    (e) => e.payload.type === "quest_completed" &&
    ws.quests.find((q) => q.id === (e.payload as { questId: string }).questId)?.kind === "main",
  );
  if (!mainQuestCompleted) return false;

  const currentActMainQuests = ws.quests.filter(
    (q) => q.kind === "main" && q.stage === ss.currentAct,
  );
  return currentActMainQuests.every((q) => q.status === "completed" || q.status === "failed");
}

function allMainQuestsResolved(ws: WorldState): boolean {
  const mainQuests = ws.quests.filter((q) => q.kind === "main");
  if (mainQuests.length === 0) return false;
  return mainQuests.every((q) => q.status === "completed" || q.status === "failed" || q.status === "closed");
}

function hasCurrentActMainQuest(ws: WorldState, currentAct: number): boolean {
  return ws.quests.some((q) => q.kind === "main" && q.stage === currentAct);
}

function hasAbandonedMainQuest(ws: WorldState, drafts: readonly NarrativeEventDraft[]): boolean {
  const abandonedQuestIds = new Set([
    ...ws.eventLedger
      .flatMap((event) => {
        const payload = event.payload;
        return payload.type === "quest_abandoned" ? [String(payload.questId)] : [];
      }),
    ...drafts
      .flatMap((draft) => draft.payload.type === "quest_abandoned" ? [String(draft.payload.questId)] : []),
  ]);
  return ws.quests.some((quest) => quest.kind === "main" && abandonedQuestIds.has(String(quest.id)));
}

export function advanceStoryProgression(
  ws: WorldState,
  ss: StoryState,
  newDrafts: readonly NarrativeEventDraft[],
): StoryProgressionResult {
  let currentAct = ss.currentAct;
  let storyProgress = ss.storyProgress;
  let endingAllowed = ss.endingAllowed;
  let threads = ss.threads;
  // Keep accepting legacy in-memory fixtures that override only the
  // compatibility projection; persisted v11 records validate the projection
  // against threads at the boundary.
  let unresolvedThreads = ss.unresolvedThreads;
  const thread = mainThreadId(ss);
  const abandonedQuestIds = new Set(
    newDrafts
      .flatMap((draft) => draft.payload.type === "quest_abandoned" ? [String(draft.payload.questId)] : []),
  );
  if (abandonedQuestIds.size > 0) {
    threads = threads.map((entry) => (entry.id === thread || entry.questIds.some((questId) => abandonedQuestIds.has(String(questId))))
      ? { ...entry, status: "abandoned" as const }
      : entry);
    unresolvedThreads = unresolvedStoryThreadIds(threads);
  }

  // 主线 thread 始终以主线 ID 命名，随幕推进保持 unresolved；最终幕完成主线后回收。
  const advanced = shouldAdvanceAct(ws, ss, newDrafts) && currentAct < ss.targetActs;
  if (advanced) {
    currentAct += 1;
    storyProgress = Math.max(storyProgress, actProgressThreshold(currentAct, ss.targetActs));
  }

  const currentActMainQuestExists = hasCurrentActMainQuest(ws, currentAct);
  const mainQuestsResolved = allMainQuestsResolved(ws);

  // 最终幕主线全部解决 → 回收主线 thread。
  if (currentAct >= ss.targetActs && currentActMainQuestExists && mainQuestsResolved) {
    threads = threads.map((entry) => entry.id === thread ? { ...entry, status: "resolved" as const } : entry);
    unresolvedThreads = unresolvedStoryThreadIds(threads);
  }

  // storyProgress：按主线已完成/失败任务占总主线比例推导（Spec §13.2），
  // 不依赖任意任务 +10。支线不直接推进主幕进度。
  const totalMain = ws.quests.filter((q) => q.kind === "main").length;
  if (totalMain > 0) {
    const resolvedMain = ws.quests.filter((q) => q.kind === "main" && (q.status === "completed" || q.status === "failed")).length;
    const byStage = Math.floor(resolvedMain / totalMain * 100);
    storyProgress = Math.max(storyProgress, byStage, actProgressThreshold(currentAct, ss.targetActs));
  }

  // endingAllowed：最终幕 + progress≥80 + 无未决主线 thread（Spec §13.3）。
  if (
    currentAct >= ss.targetActs
    && currentActMainQuestExists
    && mainQuestsResolved
    && !hasAbandonedMainQuest(ws, newDrafts)
    && storyProgress >= 80
    && unresolvedThreads.length === 0
  ) {
    endingAllowed = true;
  } else {
    endingAllowed = false;
  }

  const nextPacingNeed = derivePacingNeed({
    ...ss,
    currentAct,
    storyProgress,
    endingAllowed,
    unresolvedThreads,
  });

  // Task 3：演化状态消费方是世界演化派生（deriveEvolutionNeed）。
  // 非终幕主线解决 → 请求下一幕主线的具象化；终幕主线全部解决 → 请求结局对。
  const evolutionStatus = advanced
    ? "needs_next_act"
    : currentAct >= ss.targetActs && !currentActMainQuestExists
      ? "needs_next_act"
      : currentAct >= ss.targetActs && mainQuestsResolved
      ? "needs_ending_pair"
      : ss.evolution.status;

  return {
    nextStoryState: {
      ...ss,
      threads,
      currentAct,
      storyProgress,
      endingAllowed,
      unresolvedThreads,
      nextPacingNeed,
      evolution: { ...ss.evolution, status: evolutionStatus },
    },
    drafts: [],
  };
}
