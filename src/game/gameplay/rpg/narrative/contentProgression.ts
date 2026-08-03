import type {
  GameState,
  QuestId,
  ScenarioBlueprint,
  StoryPacing
} from "@/game/domain";
import { finalMainActOf, storyMemoryOf } from "@/game/domain";

// Phase 11 内容推进器：从当前主线状态派生受约束的章节/节奏。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §5。
// 纯函数：不读 IO/Date/process.env/随机数；不从 narrative prose 推断章节；
// 不改写任务、战斗、结局或行动候选。director 提案 pacing 必须属于 allowedPacing。

/** 内容推进结果：主线阶段、允许的节奏集合与当前 active 任务（蓝图顺序）。 */
export type ContentProgression = {
  readonly mainStage: number | null;
  readonly allowedPacing: readonly StoryPacing[];
  readonly activeQuestIds: readonly QuestId[];
};

export type DeriveContentProgressionInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
};

/**
 * 派生内容推进（幕数由 BudgetPolicy 驱动，可变）：
 * - 存在 active 主线任务时取其 stage：末幕 → climax，第 1 幕 → setup|develop，中间幕 → develop|turn。
 * - 新局已完成至少两幕叙事且尚未出现 turn 时，中段下一场强制 turn，保证生成级故事弧不被
 *   连续 develop 吃掉；旧存档缺少结构化记忆时保持原有安全回退。
 * - 无 active 主线且至少一个主线已完成（completed 或 closed）→ resolution。
 * - 其他合法旧存档状态安全回退 setup|develop，不抛错、不阻断流程。
 * activeQuestIds 只含当前 active 任务（含支线），顺序沿用蓝图。
 */
export function deriveContentProgression({
  blueprint,
  state
}: DeriveContentProgressionInput): ContentProgression {
  const statusByQuestId = new Map(state.quests.map((quest) => [quest.questId, quest.status]));
  const activeQuestIds: QuestId[] = [];
  let activeMainStage: number | null = null;
  let hasCompletedMain = false;

  for (const quest of blueprint.quests) {
    const status = statusByQuestId.get(quest.id);
    if (status === "active") {
      activeQuestIds.push(quest.id);
    }
    if (quest.kind === "main") {
      if (status === "active" && activeMainStage === null) {
        activeMainStage = quest.stage;
      }
      if (status === "completed" || status === "closed") {
        hasCompletedMain = true;
      }
    }
  }

  return {
    mainStage: activeMainStage,
    allowedPacing: allowedPacingFor(
      activeMainStage,
      hasCompletedMain,
      finalMainActOf(blueprint),
      state,
      blueprint
    ),
    activeQuestIds
  };
}

function allowedPacingFor(
  activeMain: number | null,
  hasCompletedMain: boolean,
  finalAct: number,
  state: Pick<GameState, "storyMemory">,
  blueprint: Pick<ScenarioBlueprint, "budgetPolicy">
): readonly StoryPacing[] {
  if (activeMain !== null) {
    if (activeMain >= finalAct) return ["climax"];
    const recentScenes = storyMemoryOf(state).recent.filter((entry) => entry.kind === "scene");
    if (activeMain === 1) {
      if (blueprint.budgetPolicy?.gameLength === "long" && recentScenes.length === 0) return ["setup"];
      return ["setup", "develop"];
    }
    const hasRecentTurn = recentScenes.some((entry) => entry.pacing === "turn");
    // 三幕以内的短 fixture 没有独立中段空间；长蓝图才强制留出一次转折。
    if (finalAct >= 4 && recentScenes.length >= 2 && !hasRecentTurn) return ["turn"];
    return ["develop", "turn"];
  }
  if (hasCompletedMain) return ["resolution"];
  return ["setup", "develop"];
}
