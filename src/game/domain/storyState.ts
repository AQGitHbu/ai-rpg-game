import type { GameLength } from "./newGame";
import type { StoryBudget } from "./storyBudget";
import { createStoryBudget, TARGET_ACTS } from "./storyBudget";
import type { NarrativeRuntimeState } from "./narrative";
import type { EventCandidate } from "./candidateEvent";

// 结构化候选事件契约由 candidateEvent.ts 定义并在此再导出，保持既有调用点兼容。
export type { EventCandidate, EventCandidateKind, ProposedEffect } from "./candidateEvent";

export const STORY_STATE_SCHEMA_VERSION = 3 as const;

export type StoryStateSchemaVersionErrorCode =
  | "UNSUPPORTED_RECORD"
  | "UNSUPPORTED_STORY_STATE_VERSION";

export type StoryStateSchemaVersionClassification =
  | { readonly ok: true; readonly version: typeof STORY_STATE_SCHEMA_VERSION }
  | { readonly ok: false; readonly code: StoryStateSchemaVersionErrorCode };

/**
 * 只分类存档 schema，不执行迁移。DB revision 与回合号由各自契约维护。
 */
export function classifyStoryStateSchemaVersion(
  version: unknown,
): StoryStateSchemaVersionClassification {
  if (version === STORY_STATE_SCHEMA_VERSION) {
    return { ok: true, version: STORY_STATE_SCHEMA_VERSION };
  }
  if (version === 2) {
    return { ok: false, code: "UNSUPPORTED_RECORD" };
  }
  return { ok: false, code: "UNSUPPORTED_STORY_STATE_VERSION" };
}

export type PacingNeed = "reveal" | "develop" | "complicate" | "escalate" | "climax" | "resolve";

export type ThreadId = string;

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
  readonly recentBeats: readonly unknown[];
  readonly npcContacts: readonly unknown[];
  readonly reducedThroughEventCount: number;
};

export function createInitialStoryState(input: {
  gameLength: GameLength;
  initialEntityCounts: { locations: number; npcs: number; quests: number; events: number };
  mainThreadId?: ThreadId;
}): StoryState {
  const budget = createStoryBudget(input.gameLength, input.initialEntityCounts);
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
    narrative: {
      currentScene: null,
      generation: { status: "idle" },
      mode: "offline",
    },
    prologueShown: false,
    recentBeats: [],
    npcContacts: [],
    reducedThroughEventCount: 0,
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
