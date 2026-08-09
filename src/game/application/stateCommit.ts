import type { GameRepository, ApplyStateResult } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { reconcileMaterializedView } from "@/game/domain/materializedView";

export type CommitStateInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};

export async function commitState(
  repo: GameRepository,
  input: CommitStateInput,
): Promise<ApplyStateResult> {
  const view = reconcileMaterializedView(
    {
      recentBeats: input.nextStoryState.recentBeats as never[],
      npcContacts: input.nextStoryState.npcContacts as never[],
      reducedThroughEventCount: input.nextStoryState.reducedThroughEventCount,
    },
    input.nextWorldState.eventLedger,
    input.nextWorldState.currentLocationId,
  );

  const nextStoryState: StoryState = {
    ...input.nextStoryState,
    recentBeats: view.recentBeats,
    npcContacts: view.npcContacts,
    reducedThroughEventCount: view.reducedThroughEventCount,
  };

  return repo.applyState({
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    nextWorldState: input.nextWorldState,
    nextStoryState,
  });
}
