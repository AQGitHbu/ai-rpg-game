import type { NarrativeGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import type { GameRecord, GameRepository } from "./server/persistence/gameRepository";
import { commitState } from "./stateCommit";

export type MarkNarrativeGenerationFailedResult =
  | { readonly ok: true; readonly result: "failed" }
  | { readonly ok: false; readonly code: "STALE_GAME_REVISION" | "NO_ACTIVE_GAME" | "INFRASTRUCTURE_FAILURE" };

/**
 * Convert only the exact pending job represented by `record` into failed.
 * The CAS deliberately does not increment revision: the committed rule state,
 * scene token revision and job identity remain unchanged and can be retried.
 */
export async function markNarrativeGenerationFailed(
  repository: GameRepository,
  record: GameRecord,
  failure: NarrativeGenerationFailure,
): Promise<MarkNarrativeGenerationFailedResult> {
  const current = await repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  if (current.status === "none") return { ok: false, code: "NO_ACTIVE_GAME" };
  if (current.status === "corrupt") return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  if (current.record.revision !== record.revision) return { ok: false, code: "STALE_GAME_REVISION" };

  const generation = current.record.storyState.narrative.generation;
  const originalGeneration = record.storyState.narrative.generation;
  if (originalGeneration.status !== "pending") return { ok: false, code: "STALE_GAME_REVISION" };
  if (generation.status !== "pending" || generation.job.jobId !== originalGeneration.job.jobId) {
    return { ok: false, code: "STALE_GAME_REVISION" };
  }

  const nextStoryState = {
    ...current.record.storyState,
    narrative: {
      ...current.record.storyState.narrative,
      generation: {
        status: "failed" as const,
        job: generation.job,
        failure,
      },
    },
  };
  const committed = await commitState(repository, {
    gameId: current.record.gameId,
    expectedRevision: current.record.revision,
    nextWorldState: current.record.worldState,
    nextStoryState,
    incrementRevision: false,
    expectedNarrativeGeneration: { status: "pending", jobId: String(generation.job.jobId) },
  });
  if (committed === undefined || !committed.ok) {
    return { ok: false, code: committed?.code ?? "INFRASTRUCTURE_FAILURE" };
  }
  return { ok: true, result: "failed" };
}
