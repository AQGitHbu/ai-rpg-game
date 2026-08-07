import type { GameRepositoryV2, ApplySceneWriteBackResult } from "./server/persistence/gameRepositoryV2";
import type { GameId } from "./server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";

export type SceneWriteBackInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextNarrative: StoryState["narrative"];
  readonly nextCandidateEventPool: StoryState["candidateEventPool"];
};

export async function writeBackScene(
  repo: GameRepositoryV2,
  input: SceneWriteBackInput,
): Promise<ApplySceneWriteBackResult> {
  return repo.applySceneWriteBack({
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    nextNarrative: input.nextNarrative,
    nextCandidateEventPool: input.nextCandidateEventPool,
  });
}
