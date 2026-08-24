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
  /** 是否递增 revision（默认 true）；元数据更新（如 prologueShown）传 false。 */
  readonly incrementRevision?: boolean;
  readonly expectedNarrativeJob?: {
    readonly status: "provider_pending" | "provider_failed";
    readonly jobId: string;
  };
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
    ...(input.incrementRevision === undefined ? {} : { incrementRevision: input.incrementRevision }),
    ...(input.expectedNarrativeJob === undefined ? {} : { expectedNarrativeJob: input.expectedNarrativeJob }),
  });
}
