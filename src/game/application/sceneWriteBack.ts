import type { GameRepository, ApplySceneWriteBackResult } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";

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
  return repo.applySceneWriteBack({
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    nextWorldState: input.nextWorldState,
    nextStoryState: input.nextStoryState,
  });
}
