import type { GameRepository } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource } from "./narrativeBundleSource";
import { approveNarrativeBundle, type ApprovedNarrativeBundle } from "./approveNarrativeBundle";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { GameLogger } from "@/game/logging";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import type { NarrativeBundleState } from "@/game/domain/narrativeBundle";
import { runBoundedAttempts } from "@/game/core/retry";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";

// ---------------------------------------------------------------------------
// Task 7: Atomic pending-job generation orchestrator.
// Calls NarrativeBundleSource once, calls approveNarrativeBundle once,
// commits world+scene+choiceRegistry+bundle in one CAS.
// When approval fails, performs no partial world/scene write.
// ---------------------------------------------------------------------------

export type GeneratePendingNarrativeBundleResult =
  | { readonly ok: true; readonly revision: number }
  | {
      readonly ok: false;
      readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "NOT_PENDING" | "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" | "INFRASTRUCTURE_FAILURE";
      readonly failureKind?: AiFailureKind;
    };

export type GeneratePendingNarrativeBundleDeps = {
  readonly repository: GameRepository;
  readonly source: NarrativeBundleSource;
  readonly now: () => string;
  readonly logger?: GameLogger;
  readonly auditLink?: AiTextAuditLink;
};

function deriveEvolutionNeed(storyState: StoryState): EvolutionNeed {
  if (storyState.evolution.status === "needs_next_act") {
    return { kind: "next_act", act: storyState.currentAct + 1 };
  }
  if (storyState.evolution.status === "needs_ending_pair") {
    return { kind: "ending_pair", finalAct: storyState.targetActs };
  }
  return { kind: "none" };
}

export async function generatePendingNarrativeBundle(
  deps: GeneratePendingNarrativeBundleDeps,
): Promise<GeneratePendingNarrativeBundleResult> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };

  const { record } = current;
  const narrative = record.storyState.narrative;
  if (narrative.status !== "provider_pending") {
    return { ok: false, code: "NOT_PENDING" };
  }

  const job = narrative.job;
  const worldState = record.worldState;
  const storyState = record.storyState;

  const transition: ObjectiveTransition = job.objectiveTransition;
  const evolutionNeed = deriveEvolutionNeed(storyState);

  const bounded = await runBoundedAttempts<
    ApprovedNarrativeBundle,
    "source_failed" | "approval_failed"
  >({
    maxAttempts: 2,
    runAttempt: async (attempt) => {
      const repairHint = attempt > 1
        ? { attempt: 1 as const, reason: "approval_rejected" as const }
        : undefined;

      const sourceResult = await deps.source.generate({
        kind: "decision",
        worldState,
        storyState,
        job,
        ...(deps.auditLink === undefined ? {} : { auditLink: deps.auditLink }),
        ...(repairHint === undefined ? {} : { contentRepair: repairHint }),
      });

      if (!sourceResult.ok) {
        return { ok: false, retryable: true, reason: "source_failed" as const };
      }

      if (sourceResult.kind !== "decision") {
        return { ok: false, retryable: true, reason: "source_failed" as const };
      }
      const approvalResult = approveNarrativeBundle({
        proposal: sourceResult.proposal,
        worldState,
        storyState,
        transition,
        evolutionNeed,
        jobId: job.jobId,
        basedOnRevision: record.revision,
        now: deps.now,
        ...(deps.auditLink === undefined ? {} : { auditLink: deps.auditLink }),
      });

      if (!approvalResult.ok) {
        return { ok: false, retryable: true, reason: "approval_failed" as const };
      }

      return { ok: true, value: approvalResult.approved };
    },
  });

  if (!bounded.ok) {
    // Record provider_failed with same jobId
    const failedNarrative: NarrativeRuntimeState = {
      status: "provider_failed",
      mode: narrative.mode,
      job,
      failure: {
        kind: "AI_RESPONSE_INVALID",
        phase: "scene",
        failedAt: deps.now(),
      },
      lastPresentedScene: narrative.lastPresentedScene,
      ...(narrative.dialogueSession === undefined ? {} : { dialogueSession: narrative.dialogueSession }),
    };

    const failedStoryState: StoryState = {
      ...storyState,
      narrative: failedNarrative,
    };

    await deps.repository.applyState({
      gameId: record.gameId,
      expectedRevision: record.revision,
      nextWorldState: worldState,
      nextStoryState: failedStoryState,
    });

    return {
      ok: false,
      code: "AI_RESPONSE_INVALID",
      failureKind: "AI_RESPONSE_INVALID",
    };
  }

  const approved = bounded.value;

  // Build the ready narrative with the approved bundle
  const readyNarrative: NarrativeRuntimeState = {
    status: "ready",
    mode: narrative.mode,
    currentScene: approved.currentScene,
    choiceRegistry: approved.choiceRegistry,
    ...(approved.bundle.steps.length > 0
      ? {} // Bundle steps exist - they carry continuation data
      : {}),
  };

  // The next story state includes the new world state from the bundle,
  // plus the ready narrative with the current scene and choice registry.
  const nextStoryState: StoryState = {
    ...approved.nextStoryStatePreview,
    narrative: readyNarrative,
  };

  const commitResult = await deps.repository.applyState({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState: approved.nextWorldState,
    nextStoryState,
  });

  if (!commitResult.ok) {
    return {
      ok: false,
      code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
    };
  }

  return { ok: true, revision: commitResult.record.revision };
}
