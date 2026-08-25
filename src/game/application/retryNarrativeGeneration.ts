import type { GameId } from "./server/persistence/gameRepository";
import type { GameRepository } from "./server/persistence/gameRepository";
import { commitState } from "./stateCommit";
import { providerAllowedFor } from "@/game/gameplay/rpg/narrativeExecution";

export type RetryNarrativeGenerationResult =
  | { readonly ok: true; readonly result: "requeued" | "already_pending" | "not_failed"; readonly jobId?: string }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "AI_RESPONSE_INVALID" | "INFRASTRUCTURE_FAILURE" };

/** Restore the same failed job to pending with a revision-preserving CAS. */
export async function retryNarrativeGeneration(
  repository: GameRepository,
  gameId: GameId,
  _now: () => string,
): Promise<RetryNarrativeGenerationResult> {
  const current = await repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  if (current.status === "none") return { ok: false, code: "NO_ACTIVE_GAME" };
  if (current.status === "corrupt") return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  if (current.record.gameId !== gameId) return { ok: false, code: "STALE_GAME_REVISION" };

  const generation = current.record.storyState.narrative;
  if (generation.status === "provider_pending") {
    return { ok: true, result: "already_pending", jobId: String(generation.job.jobId) };
  }
  if (generation.status !== "provider_failed") return { ok: true, result: "not_failed" };
  if (!providerAllowedFor(generation.job.generationKind)) {
    return { ok: false, code: "AI_RESPONSE_INVALID" };
  }

  // 同一个 failed job 的下一次生成必须知道上一次失败的稳定原因；
  // 旧存档没有 reason 时使用安全兜底，仍保证一次自动内容修复预算。
  const repairReason = generation.failure.reason
    ?? (generation.failure.kind === "AI_RESPONSE_INVALID" ? "invalid_schema" : "provider_failure");

  const committed = await commitState(repository, {
    gameId,
    expectedRevision: current.record.revision,
    nextWorldState: current.record.worldState,
    nextStoryState: {
      ...current.record.storyState,
      narrative: {
        status: "provider_pending",
        mode: generation.mode,
        job: generation.job,
        lastPresentedScene: generation.lastPresentedScene,
        retryContext: { attempt: 1, reason: repairReason },
        ...(generation.dialogueSession === undefined ? {} : { dialogueSession: generation.dialogueSession }),
      },
    },
    incrementRevision: false,
    expectedNarrativeJob: { status: "provider_failed", jobId: String(generation.job.jobId) },
  });
  if (!committed.ok) return { ok: false, code: committed.code };
  return { ok: true, result: "requeued", jobId: String(generation.job.jobId) };
}
