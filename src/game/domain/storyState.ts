import type { GameLength } from "./newGame";
import type { StoryBudget } from "./storyBudget";
import { createStoryBudget, TARGET_ACTS } from "./storyBudget";
import type { NarrativeRuntimeState } from "./narrative";
import type { EventCandidate } from "./candidateEvent";
import type { StoryContract } from "./storyContract";
import { createStoryContract } from "./storyContract";
import type { StoryEvolutionState } from "./worldDelta";
import type { QuestId } from "./worldEntity";
import { createEmptyEpisodicMemory, type EpisodicMemoryState } from "./episodicMemory";
import type { Decision } from "./narrativeBranch";

// 结构化候选事件契约由 candidateEvent.ts 定义并在此再导出，保持既有调用点兼容。
export type { EventCandidate, EventCandidateKind, ProposedEffect } from "./candidateEvent";

export const STORY_STATE_SCHEMA_VERSION = 9 as const;

export type StoryStateSchemaVersionErrorCode =
  | "UNSUPPORTED_RECORD"
  | "UNSUPPORTED_STORY_STATE_VERSION";

export type StoryStateSchemaVersionClassification =
  | { readonly ok: true; readonly version: typeof STORY_STATE_SCHEMA_VERSION }
  | { readonly ok: false; readonly code: StoryStateSchemaVersionErrorCode };

/**
 * 只分类存档 schema，不执行迁移。DB revision 与回合号由各自契约维护。
 * v2/v3/v4/v5 均按旧 record 分类，不提供迁移或兼容读取。
 */
export function classifyStoryStateSchemaVersion(
  version: unknown,
): StoryStateSchemaVersionClassification {
  if (version === STORY_STATE_SCHEMA_VERSION) {
    return { ok: true, version: STORY_STATE_SCHEMA_VERSION };
  }
  if (version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 || version === 8) {
    return { ok: false, code: "UNSUPPORTED_RECORD" };
  }
  return { ok: false, code: "UNSUPPORTED_STORY_STATE_VERSION" };
}

export type PacingNeed = "reveal" | "develop" | "complicate" | "escalate" | "climax" | "resolve";

export type ThreadId = string;

/**
 * 动态主线的可见释放游标。
 *
 * 世界演化可以提前物化完整的一幕，但读模型和动作入口只允许看到当前
 * 游标及之前的目标。旧存档没有该字段时由各投影按兼容行为处理。
 */
export type StoryRevealState = {
  readonly questId: QuestId;
  readonly visibleObjectiveIndex: number;
};

export type StoryState = {
  readonly version: typeof STORY_STATE_SCHEMA_VERSION;
  /** 已提交的玩家回合数；不等于 event ledger 长度或 DB revision。 */
  readonly turnNumber: number;
  readonly currentAct: number;
  readonly targetActs: number;
  readonly storyProgress: number;
  readonly tension: number;
  readonly nextPacingNeed: PacingNeed;
  readonly budget: StoryBudget;
  readonly unresolvedThreads: readonly ThreadId[];
  readonly candidateEventPool: readonly EventCandidate[];
  readonly endingAllowed: boolean;
  readonly endingProposed: boolean;
  readonly narrative: NarrativeRuntimeState;
  readonly prologueShown: boolean;
  /** 开局生成并审批通过的序幕文本（Task 2 起由开局编译写入，UI 据此展示）。 */
  readonly prologueText: string;
  readonly memory: EpisodicMemoryState;
  /** 开局生成的故事契约：只含抽象方向，不含未来实体 ID（Task 2 起由开局生成写入）。 */
  readonly contract: StoryContract;
  /** 运行时具象化账本：实体序号与演化状态（Task 3 起由世界演化推进）。 */
  readonly evolution: StoryEvolutionState;
  /** 动态主线的分阶段释放游标；旧存档缺失时保持既有可见性。 */
  readonly reveal?: StoryRevealState | null;
  /**
   * 已审批的路线分支 registry：decisionId → Decision。
   * 只存在于服务端权威状态，不进客户端 DTO；分支只能由服务端从此处取值，
   * 不接受客户端提交 Decision。
   */
  readonly branchDecisions: Readonly<Record<string, Decision>>;
  /** 已选择的分支：decisionId → candidateId。每个 decisionId 只写一次。 */
  readonly selectedBranches: Readonly<Record<string, string>>;
};

export type CreateInitialStoryStateInput = {
  readonly gameLength: GameLength;
  readonly initialEntityCounts: {
    readonly locations: number;
    readonly npcs: number;
    readonly quests: number;
    readonly events: number;
  };
  readonly initialNarrative: NarrativeRuntimeState;
  readonly mainThreadId?: ThreadId;
};

export function createInitialStoryState(input: CreateInitialStoryStateInput): StoryState {
  const budget = createStoryBudget(input.gameLength, input.initialEntityCounts);
  const contract = createStoryContract({
    // 默认契约只区分短/中档；long/open 暂按 medium（5 幕）处理，后续任务覆盖。
    gameLength: input.gameLength === "short" ? "short" : "medium",
    centralConflict: "",
    endingThemes: { trust: "", doubt: "" },
  });
  return {
    version: STORY_STATE_SCHEMA_VERSION,
    turnNumber: 0,
    currentAct: 1,
    targetActs: TARGET_ACTS[input.gameLength],
    storyProgress: 0,
    tension: 30,
    nextPacingNeed: "reveal",
    budget,
    unresolvedThreads: [input.mainThreadId ?? "main_thread"],
    candidateEventPool: [],
    endingAllowed: false,
    endingProposed: false,
    narrative: input.initialNarrative,
    prologueShown: false,
    prologueText: "",
    memory: createEmptyEpisodicMemory(),
    contract,
    evolution: {
      nextLocationOrdinal: 0,
      nextNpcOrdinal: 0,
      nextItemOrdinal: 0,
      nextEnemyOrdinal: 0,
      nextFactOrdinal: 0,
      nextQuestOrdinal: 0,
      nextEndingOrdinal: 0,
      status: "stable",
    },
    reveal: null,
    branchDecisions: {},
    selectedBranches: {},
  };
}

export function derivePacingNeed(ss: StoryState): PacingNeed {
  if (ss.currentAct === 1) return "reveal";
  if (ss.endingAllowed && ss.unresolvedThreads.length === 0) return "resolve";
  if (ss.currentAct >= ss.targetActs && ss.storyProgress > 85) return "climax";
  if (ss.tension < 30 && ss.currentAct >= 2) return "complicate";
  if (ss.storyProgress > 70 && !ss.endingAllowed) return "escalate";
  return "develop";
}

export function clampTension(value: number): number {
  return Math.max(0, Math.min(100, value));
}
