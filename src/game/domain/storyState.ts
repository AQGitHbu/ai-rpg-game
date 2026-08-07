import type { GameLength } from "./newGame";
import type { StoryBudget } from "./storyBudget";
import { createStoryBudget, TARGET_ACTS } from "./storyBudget";
import type { NarrativeRuntimeState } from "./narrative";

export type PacingNeed = "reveal" | "develop" | "complicate" | "escalate" | "climax" | "resolve";

export type EventCandidate = {
  readonly id: string;
  readonly description: string;
  readonly proposedAtTurn: number;
};

export type ThreadId = string;

export type StoryState = {
  readonly version: 2;
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
    version: 2,
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
