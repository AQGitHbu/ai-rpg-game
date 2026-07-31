import type {
  GameState,
  QuestId,
  ScenarioBlueprint,
  StoryPacing
} from "@/game/domain";

// Phase 11 内容推进器：从当前主线状态派生受约束的章节/节奏。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §5。
// 纯函数：不读 IO/Date/process.env/随机数；不从 narrative prose 推断章节；
// 不改写任务、战斗、结局或行动候选。director 提案 pacing 必须属于 allowedPacing。

/** 内容推进结果：主线阶段、允许的节奏集合与当前 active 任务（蓝图顺序）。 */
export type ContentProgression = {
  readonly mainStage: 1 | 2 | 3 | null;
  readonly allowedPacing: readonly StoryPacing[];
  readonly activeQuestIds: readonly QuestId[];
};

export type DeriveContentProgressionInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
};

/**
 * 派生内容推进：
 * - 存在 active 主线任务时取其 stage：1 → setup|develop，2 → develop|turn，3 → climax。
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
  let activeMainStage: 1 | 2 | 3 | null = null;
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
    allowedPacing: allowedPacingFor(activeMainStage, hasCompletedMain),
    activeQuestIds
  };
}

function allowedPacingFor(
  activeMain: 1 | 2 | 3 | null,
  hasCompletedMain: boolean
): readonly StoryPacing[] {
  if (activeMain === 1) return ["setup", "develop"];
  if (activeMain === 2) return ["develop", "turn"];
  if (activeMain === 3) return ["climax"];
  if (hasCompletedMain) return ["resolution"];
  return ["setup", "develop"];
}
