import type { CommittedNarrativeEvent, NarrativeEventDraft, TurnId } from "@/game/domain/events";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { unresolvedStoryThreadIds } from "@/game/domain/storyThreads";
import { advanceStoryThreads } from "@/game/gameplay/rpg/storyThreads";
import { reconcileConfidentialityPromises } from "@/game/gameplay/rpg/storyInteraction";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { reconcileNpcGoals } from "@/game/gameplay/rpg/npcGoals";
import { reconcileQuests } from "./reconcileQuests";
import { advanceStoryReveal } from "@/game/gameplay/rpg/worldEvolution";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";

export type ReconcileStoryConsequencesInput = Readonly<{
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly triggerEvents: readonly CommittedNarrativeEvent[];
  readonly source: Readonly<{
    readonly actionId: string;
    readonly turnId: TurnId;
    readonly turnNumber: number;
  }>;
}>;

export type ReconcileStoryConsequencesResult = Readonly<{
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly drafts: readonly NarrativeEventDraft[];
}>;

function uniqueEvents(events: readonly CommittedNarrativeEvent[]): readonly CommittedNarrativeEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = String(event.eventId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function completedDialogueSession(events: readonly CommittedNarrativeEvent[]) {
  const completed = events.find((event) => event.payload.type === "npc_dialogue_completed");
  return completed?.payload.type === "npc_dialogue_completed"
    ? { npcId: String(completed.payload.npcId), completed: true as const }
    : undefined;
}

/**
 * Reconcile only consequences of events that already exist in the ledger.
 * It never resolves an Action, creates a fact, or chooses an ending stance.
 */
export function reconcileStoryConsequences(
  input: ReconcileStoryConsequencesInput,
): ReconcileStoryConsequencesResult {
  const triggerEvents = uniqueEvents(input.triggerEvents);
  const triggerIds = new Set(triggerEvents.map((event) => String(event.eventId)));

  const goals = reconcileNpcGoals({
    worldState: input.worldState,
    triggerEvents,
    actionId: input.source.actionId,
    turnId: input.source.turnId,
    turnNumber: input.source.turnNumber,
  });
  const dialogueSession = completedDialogueSession(triggerEvents);
  const objectiveRef = currentObjectiveOf(goals.worldState, input.storyState);
  const objectiveQuest = objectiveRef === null ? undefined : goals.worldState.quests.find((quest) => String(quest.id) === String(objectiveRef.questId));
  const objective = objectiveQuest?.objectives[objectiveRef?.objectiveIndex ?? -1];
  const talkSession = dialogueSession
    ?? (objective?.kind === "talk_to_npc"
      ? { npcId: String(objective.npcId), completed: false as const }
      : undefined);
  const quests = reconcileQuests(goals.worldState, { now: () => "" }, talkSession === undefined ? undefined : {
    talkToNpcSession: talkSession,
    ...(dialogueSession === undefined ? {} : {
      actionContext: {
        participantNpcId: dialogueSession.npcId,
        actionId: input.source.actionId,
        turnNumber: input.source.turnNumber,
        turnId: input.source.turnId,
        actionWasAlreadyUsed: false,
      },
    }),
  });
  const reveal = advanceStoryReveal({
    worldState: quests.nextWorldState,
    storyState: input.storyState,
  });
  const drafts = [...goals.drafts, ...quests.drafts];
  const progression = advanceStoryProgression(reveal.worldState, reveal.storyState, drafts);
  const withConfidentiality = reconcileConfidentialityPromises(reveal.worldState, progression.nextStoryState);
  const threads = advanceStoryThreads({
    worldState: withConfidentiality,
    threads: progression.nextStoryState.threads,
    eventIds: [...triggerIds].map((eventId) => triggerEvents.find((event) => String(event.eventId) === eventId)!.eventId),
    triggerEvents,
  });
  return {
    worldState: withConfidentiality,
    storyState: {
      ...progression.nextStoryState,
      threads,
      unresolvedThreads: unresolvedStoryThreadIds(threads),
    },
    drafts,
  };
}
