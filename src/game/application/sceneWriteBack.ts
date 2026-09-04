import type { GameRepository, ApplySceneWriteBackResult } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { reconcileCommittedMemory } from "./reconcileCommittedMemory";

export type SceneWriteBackInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};

export async function writeBackScene(
  repo: GameRepository,
  input: SceneWriteBackInput,
): Promise<ApplySceneWriteBackResult> {
  const nextStoryState: StoryState = {
    ...input.nextStoryState,
    memory: reconcileCommittedMemory({
      previous: input.nextStoryState.memory,
      ledger: input.nextWorldState.eventLedger,
    }),
  };
  return repo.applySceneWriteBack({
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    nextWorldState: input.nextWorldState,
    nextStoryState,
  });
}
