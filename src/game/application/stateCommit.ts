import type { GameRepository, ApplyStateResult } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { reconcileCommittedMemory } from "./reconcileCommittedMemory";

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

/**
 * The prepared-continuation consumer and rule-owned presentation both pass
 * their complete next states through this one CAS. Scene write-back remains
 * reserved for provider-job completion and is never a second step of a turn.
 */
export async function commitState(
  repo: GameRepository,
  input: CommitStateInput,
): Promise<ApplyStateResult> {
  const nextStoryState: StoryState = {
    ...input.nextStoryState,
    memory: reconcileCommittedMemory({
      previous: input.nextStoryState.memory,
      ledger: input.nextWorldState.eventLedger,
    }),
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
