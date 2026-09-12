import { repairFromSourceFailure, aiRepairAuditContext, persistedAiRepairReason } from "./aiGenerationRetry";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource, NarrativeBundleRepair } from "./narrativeBundleSource";
import { approveNarrativeBundle, type ApprovedNarrativeBundle } from "./approveNarrativeBundle";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { GameLogger } from "@/game/logging";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import { runBoundedAttempts } from "@/game/core/retry";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import { buildWorldDeltaEntityContextClosure } from "./entityContextProjection";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import { reconcileCommittedMemory } from "./reconcileCommittedMemory";
import { appendHistory, narrativeSceneHistoryEntries } from "@/game/domain/narrativeHistory";
import { asEndingId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

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

function deriveEvolutionNeed(storyState: StoryState, worldState: WorldState): EvolutionNeed {
  if (storyState.evolution.status === "needs_next_act") {
    return { kind: "next_act", act: storyState.currentAct };
  }
  if (storyState.evolution.status === "needs_ending_pair" && worldState.endings.length < 2) {
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
  const lastPresentedScene = narrative.lastPresentedScene;
  const worldState = record.worldState;
  const storyState = record.storyState;

  const transition: ObjectiveTransition = job.objectiveTransition;
  const evolutionNeed = deriveEvolutionNeed(storyState, worldState);

  const retryOrigin = deps.auditLink?.retry ?? (narrative.retryContext === undefined
    ? undefined
    : { origin: "manual_failed_job" as const, mechanism: "initial" as const, attempt: 0 });
  let lastFailureKind: AiFailureKind = "AI_RESPONSE_INVALID";
  let lastRepair: NarrativeBundleRepair | undefined;
  const bounded = await runBoundedAttempts<ApprovedNarrativeBundle, NarrativeBundleRepair>({
    maxAttempts: MAX_NARRATIVE_BUNDLE_ATTEMPTS,
    runAttempt: async (attempt, priorRepair) => {
      // 自动修复从 1 开始；本次循环若由手动重试启动，则以 retryContext
      // 的首次修复序号为偏移。该偏移不代表之前多次手动重试的累计次数。
      const repairHint: NarrativeBundleRepair | undefined = attempt > 1 && priorRepair !== undefined
        ? { ...priorRepair, attempt: attempt - 1 + (narrative.retryContext?.attempt ?? 0) }
        : narrative.retryContext;

      let sourceResult;
      try {
        sourceResult = await deps.source.generate({
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
              ? (retryOrigin ?? { origin: "normal", mechanism: "initial", attempt: 0 })
              : aiRepairAuditContext(repairHint, retryOrigin),
          },
          ...(repairHint === undefined ? {} : { contentRepair: repairHint }),
        });
      } catch {
        lastFailureKind = "AI_CALL_FAILED";
        lastRepair = { attempt, reason: "provider_failure", detail: "source_exception" };
        return { ok: false, retryable: true, reason: lastRepair };
      }

      if (!sourceResult.ok) {
        lastFailureKind = sourceResult.failure.kind;
        lastRepair = repairFromSourceFailure(sourceResult, attempt);
        return {
          ok: false,
          retryable: true,
          reason: lastRepair,
        };
      }

      lastFailureKind = "AI_RESPONSE_INVALID";
      if (sourceResult.kind !== "decision") {
        lastRepair = { attempt, reason: "invalid_schema", detail: "unexpected_source_kind" };
        return { ok: false, retryable: true, reason: lastRepair };
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
        lastRepair = { attempt, reason: "approval_rejected", rejectionCode: approvalResult.code, ...(approvalResult.detail === undefined ? {} : { detail: approvalResult.detail }) };
        return {
          ok: false,
          retryable: true,
          reason: lastRepair,
        };
      }

      return { ok: true, value: approvalResult.approved };
    },
  });

  async function failPendingJob(): Promise<GeneratePendingNarrativeBundleResult> {
    // Record provider_failed with same jobId
    const failedNarrative: NarrativeRuntimeState = {
      status: "provider_failed",
      mode: narrative.mode,
      job,
      failure: {
        kind: lastFailureKind,
        reason: persistedAiRepairReason(lastRepair ?? { attempt: 1, reason: "invalid_schema" }),
        phase: "scene",
        failedAt: deps.now(),
      },
      lastPresentedScene,
      ...(narrative.dialogueSession === undefined ? {} : { dialogueSession: narrative.dialogueSession }),
    };

    const failedStoryState: StoryState = {
      ...storyState,
      narrative: failedNarrative,
    };

    const savedFailure = await deps.repository.applyState({
      gameId: record.gameId,
      expectedRevision: record.revision,
      nextWorldState: worldState,
      nextStoryState: failedStoryState,
    });
    if (!savedFailure.ok) {
      return {
        ok: false,
        code: savedFailure.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
      };
    }

    return {
      ok: false,
      code: lastFailureKind,
      failureKind: lastFailureKind,
    };
  }

  if (!bounded.ok) return failPendingJob();

  const approved = bounded.value;
  const exitQuestId = job.actionSummary.kind === "abandon_quest" ? job.actionSummary.questId : undefined;
  const exitEndingId = exitQuestId !== undefined
    ? asEndingId(`ending_exit:${String(job.jobId)}`)
    : undefined;
  const exitEnding = exitEndingId === undefined
    ? undefined
    : {
        id: exitEndingId,
        name: "未竟之路",
        description: "你选择放下这份委托，故事在未完成的承诺与仍需承担的代价中收束。",
        requirements: [],
      } as const;
  const approvedWorldState = exitEnding === undefined
    ? approved.nextWorldState
    : {
        ...approved.nextWorldState,
        endings: [...approved.nextWorldState.endings, exitEnding],
        ending: { endingId: exitEnding.id, outcome: "failure" as const },
      };
  const approvedEventDrafts = exitEnding === undefined
    ? approved.eventDrafts
    : [
        ...approved.eventDrafts,
        {
          eventKey: `ending_reached:${exitEnding.id}`,
          episodeKey: String(job.turnId),
          actorIds: [PLAYER_ENTITY_ID],
          targetIds: [PLAYER_ENTITY_ID],
          locationId: approvedWorldState.currentLocationId,
          causeKeys: job.domainEventIds.map((eventId) => ({ kind: "event_id" as const, eventId })),
          factIds: [],
          questIds: [exitQuestId!],
          outcome: "failure" as const,
          salience: 100,
          payload: { type: "ending_reached" as const, endingId: exitEnding.id, outcome: "failure" as const },
        },
      ];

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

  const eventCommit = commitEventDrafts({
    ledger: record.worldState.eventLedger,
    drafts: approvedEventDrafts,
    source: {
      turnId: job.turnId,
      actionId: job.actionId,
      turnNumber: job.turnNumber,
      committedAt: deps.now(),
    },
    entityStore: approvedWorldState.entityStore,
  });
  if (!eventCommit.ok) {
    // 审批已通过：事件账本提交失败是内容/基础设施契约问题，不是审批拒绝。
    // 持久化独立稳定码，避免手动重试被"拒绝码"误导去修复已通过的内容；
    // 同时覆盖 lastRepair，防止残留上一轮失败原因被错误归因。
    deps.logger?.warn("narrative_bundle_event_commit_rejected", { code: eventCommit.code });
    lastRepair = { attempt: 1, reason: "invalid_schema", detail: "event_commit_failed" };
    return failPendingJob();
  }
  const nextWorldState = { ...approvedWorldState, eventLedger: eventCommit.ledger };

  const history = storyState.history ?? { entries: [] };
  const nextHistory = appendHistory(history, narrativeSceneHistoryEntries({
    history,
    scene: approved.currentScene,
    actionId: job.actionId,
    jobId: job.jobId,
    revision: record.revision + 1,
    turnNumber: job.turnNumber,
    eventIds: [...new Set([
      ...job.domainEventIds,
      ...eventCommit.appended.map((event) => event.eventId),
    ])],
  }));

  // The next story state includes the new world state from the bundle,
  // plus the ready narrative with the current scene and choice registry.
  // The scene event is committed in this same CAS, so memory must be rebuilt
  // from that final ledger before persistence validation.
  const nextStoryState: StoryState = {
    ...approved.nextStoryStatePreview,
    history: nextHistory,
    narrative: readyNarrative,
    memory: reconcileCommittedMemory({
      previous: approved.nextStoryStatePreview.memory,
      ledger: eventCommit.ledger,
    }),
  };

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
