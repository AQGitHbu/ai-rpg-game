import type { StoryState, EventCandidate } from "@/game/domain/storyState";
import { clampTension, derivePacingNeed } from "@/game/domain/storyState";
import { consumeExpansion, budgetAllowsExpansion } from "@/game/domain/storyBudget";

export type ApprovedEvent = EventCandidate & {
  readonly approvedAtTurn: number;
};

export type ApproveResult = {
  readonly approvedEvents: readonly ApprovedEvent[];
  readonly rejectedEvents: readonly EventCandidate[];
  readonly nextStoryState: StoryState;
};

const EVENT_TENSION_CHANGE = 10;
const MAX_APPROVED_PER_TURN = 1;

export function approveCandidateEvents(
  ss: StoryState,
  candidates: readonly EventCandidate[],
): ApproveResult {
  if (candidates.length === 0) {
    return { approvedEvents: [], rejectedEvents: [], nextStoryState: ss };
  }

  const approved: ApprovedEvent[] = [];
  const rejected: EventCandidate[] = [];
  let nextBudget = ss.budget;
  let tension = ss.tension;
  let approvedCount = 0;

  for (const candidate of candidates) {
    if (approvedCount >= MAX_APPROVED_PER_TURN) {
      break;
    }
    if (!budgetAllowsExpansion(nextBudget, "events")) {
      rejected.push(candidate);
      continue;
    }
    approved.push({ ...candidate, approvedAtTurn: ss.reducedThroughEventCount });
    nextBudget = consumeExpansion(nextBudget, "events");
    tension += EVENT_TENSION_CHANGE;
    approvedCount++;
  }

  if (approved.length === 0) {
    return { approvedEvents: [], rejectedEvents: rejected, nextStoryState: ss };
  }

  const approvedIds = new Set(approved.map((e) => e.id));
  const rejectedIds = new Set(rejected.map((e) => e.id));
  const remainingPool = candidates.filter(
    (c) => !approvedIds.has(c.id) && !rejectedIds.has(c.id),
  );

  const tension2 = clampTension(tension);
  const nextStoryState: StoryState = {
    ...ss,
    budget: nextBudget,
    tension: tension2,
    candidateEventPool: remainingPool,
    nextPacingNeed: derivePacingNeed({ ...ss, tension: tension2 }),
  };

  return { approvedEvents: approved, rejectedEvents: rejected, nextStoryState };
}
