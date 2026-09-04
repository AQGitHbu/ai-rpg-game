import type { GameRepository } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource, NarrativeBundleRepair } from "./narrativeBundleSource";
import { approveNarrativeBundle, type ApprovedNarrativeBundle } from "./approveNarrativeBundle";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { GameLogger } from "@/game/logging";
import type { StoryState } from "@/game/domain/storyState";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import { runBoundedAttempts } from "@/game/core/retry";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import { buildWorldDeltaEntityContextClosure } from "./entityContextProjection";
import { commitEventDrafts } from "@/game/domain/eventLedger";

// A next-act package contains five independently unique world entities. A
// provider repair may correct one named collision at a time, so leave room for
// the complete bounded repair chain before exposing a manual retry to players.
const MAX_NARRATIVE_BUNDLE_ATTEMPTS = 4;

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
    return { kind: "next_act", act: storyState.currentAct };
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

  const bounded = await runBoundedAttempts<ApprovedNarrativeBundle, NarrativeBundleRepair>({
    maxAttempts: MAX_NARRATIVE_BUNDLE_ATTEMPTS,
    runAttempt: async (attempt, priorRepair) => {
      const repairHint = attempt > 1 ? priorRepair : undefined;

      const sourceResult = await deps.source.generate({
        kind: "decision",
        worldState,
        storyState,
        job,
        auditLink: {
          ...(deps.auditLink ?? {}),
          gameId: String(record.gameId),
          jobId: String(job.jobId),
          turnNumber: job.turnNumber,
          retry: repairHint === undefined
            ? (deps.auditLink?.retry ?? { origin: "normal", mechanism: "initial", attempt: 0 })
            : { origin: deps.auditLink?.retry?.origin ?? "normal", mechanism: "content_repair", attempt: repairHint.attempt, reason: repairHint.reason },
        },
        ...(repairHint === undefined ? {} : { contentRepair: repairHint }),
      });

      if (!sourceResult.ok) {
        return {
          ok: false,
          retryable: true,
          reason: {
            attempt: 1,
            reason: sourceResult.repairReason ?? "invalid_json",
            ...(sourceResult.repairDetail === undefined ? {} : { detail: sourceResult.repairDetail }),
          },
        };
      }

      if (sourceResult.kind !== "decision") {
        return { ok: false, retryable: true, reason: { attempt: 1, reason: "invalid_schema" } };
      }
      const approvalResult = approveNarrativeBundle({
        proposal: sourceResult.proposal,
        worldState,
        storyState,
        transition,
        evolutionNeed,
        jobId: job.jobId,
        mandatoryBeats: job.mandatoryBeats,
        entityContextClosure: buildWorldDeltaEntityContextClosure({ worldState, storyState, job }),
        // applyState commits the approved scene in the next record revision.
        // Choice tokens must be forged against that revision, otherwise the
        // read model correctly treats every newly-generated choice as stale.
        basedOnRevision: record.revision + 1,
        eventContext: {
          turnId: job.turnId,
          turnNumber: job.turnNumber,
          actionId: job.actionId,
          domainEventIds: job.domainEventIds,
          episodeKey: String(job.turnId),
          eventKey: `blueprint_expanded:${job.jobId}:bundle`,
        },
        now: deps.now,
        ...(deps.auditLink === undefined ? {} : { auditLink: deps.auditLink }),
      });

      if (!approvalResult.ok) {
        return {
          ok: false,
          retryable: true,
          reason: {
            attempt: 1,
            reason: "approval_rejected",
            rejectionCode: approvalResult.code,
            ...(approvalResult.detail === undefined ? {} : { detail: approvalResult.detail }),
          },
        };
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
    narrativeBundle: approved.bundle,
    ...(narrative.dialogueSession === undefined
      ? {}
      : { dialogueSession: narrative.dialogueSession }),
  };

  // The next story state includes the new world state from the bundle,
  // plus the ready narrative with the current scene and choice registry.
  const nextStoryState: StoryState = {
    ...approved.nextStoryStatePreview,
    narrative: readyNarrative,
  };

  const eventCommit = commitEventDrafts({
    ledger: record.worldState.eventLedger,
    drafts: approved.eventDrafts,
    source: {
      turnId: job.turnId,
      actionId: job.actionId,
      turnNumber: job.turnNumber,
      committedAt: deps.now(),
    },
    entityStore: approved.nextWorldState.entityStore,
  });
  if (!eventCommit.ok) {
    return { ok: false, code: "AI_RESPONSE_INVALID", failureKind: "AI_RESPONSE_INVALID" };
  }
  const nextWorldState = { ...approved.nextWorldState, eventLedger: eventCommit.ledger };

  const commitResult = await deps.repository.applyState({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState,
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
