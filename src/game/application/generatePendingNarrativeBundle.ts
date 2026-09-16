import { prepareNpcNarrativeContext } from "./prepareNpcNarrativeContext";
import type { NpcDeliberationSource } from "./npcDeliberationSource";
import type { NarrativeBundleSourceContext } from "./narrativeBundleSource";
import { repairFromCandidateReview, repairFromSourceFailure, aiRepairAuditContext, persistedAiRepairReason } from "./aiGenerationRetry";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { NarrativeBundleSource, NarrativeBundleRepair, NarrativeCandidateRevision, NarrativeAuthorDraftRevision } from "./narrativeBundleSource";
import { approveNarrativeBundle, type ApprovedNarrativeBundle } from "./approveNarrativeBundle";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { GameLogger } from "@/game/logging";
import type { StoryState } from "@/game/domain/storyState";
import type { NarrativeMemoryContext } from "@/game/domain/narrativeMemoryContext";
import type { MemoryAttemptGuard, PreparedNarrativeMemory, NarrativeMemorySummaryRepository } from "./narrativeMemorySummaryRepository";
import type { NarrativeMemoryPreparationInput } from "./prepareNarrativeMemoryPackage";
import { deriveStructuralEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import { runBoundedAttempts } from "@/game/core/retry";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import { buildWorldDeltaEntityContextClosure } from "./entityContextProjection";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import { reconcileCommittedMemory } from "./reconcileCommittedMemory";
import { appendHistory, narrativeSceneHistoryEntries } from "@/game/domain/narrativeHistory";
import { asEndingId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import {
  candidateReviewMatches,
  hashNarrativeCandidate,
  type CandidateReviewResult,
  type NarrativeCandidateReviewer,
} from "./narrativeCandidateReview";


// A next-act package contains five independently unique world entities. A
// provider repair may correct one named collision at a time, so leave room for
// the complete bounded repair chain before exposing a manual retry to players.
const MAX_NARRATIVE_BUNDLE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Task 7: Atomic pending-job generation orchestrator.
// Calls NarrativeBundleSource once per candidate version, performs a pure
// preflight and (when injected) one semantic review plus a final approval,
// then commits world+scene+choiceRegistry+bundle in one CAS.
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
  readonly signal?: AbortSignal;
  readonly npcDeliberationSource?: NpcDeliberationSource;
  readonly repository: GameRepository;
  readonly source: NarrativeBundleSource;
  readonly now: () => string;
  readonly domainTime?: (key: string) => string;
  readonly logger?: GameLogger;
  readonly auditLink?: AiTextAuditLink;
  /** Optional semantic reviewer; production composition injects the live reviewer. */
  readonly reviewer?: NarrativeCandidateReviewer;
  /** Server-owned lease identity; injected so recovery tests remain deterministic. */
  readonly leaseId?: () => string;
  /** Optional P2 preparation hook; its result is frozen for every candidate version. */
  readonly prepareMemoryContext?: (input: Readonly<{ record: import("./server/persistence/gameRepository").GameRecord; job: import("@/game/domain/pendingNarrativeJob").PendingNarrativeJob; signal: AbortSignal }>) => Promise<NarrativeMemoryContext | null>;
  /** Optional server-owned preparation that can be frozen and recovered by job epoch. */
  readonly prepareMemoryPackage?: (input: NarrativeMemoryPreparationInput) => Promise<PreparedNarrativeMemory | null>;
  readonly memorySummaryRepository?: NarrativeMemorySummaryRepository;
};

const NARRATIVE_LEASE_DURATION_MS = 10 * 60 * 1000;

function createLeaseId(deps: GeneratePendingNarrativeBundleDeps): string {
  if (deps.leaseId !== undefined) return deps.leaseId();
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `narrative-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function leaseExpiresAt(now: string): string {
  const timestamp = Date.parse(now);
  return new Date((Number.isNaN(timestamp) ? Date.now() : timestamp) + NARRATIVE_LEASE_DURATION_MS).toISOString();
}

function narrativeAttemptPredicate(
  narrative: Extract<StoryState["narrative"], { readonly status: "provider_pending" }>,
) {
  return {
    status: "provider_pending" as const,
    jobId: String(narrative.job.jobId),
    epoch: narrative.job.attempt.epoch,
    leaseId: narrative.job.attempt.leaseId,
    candidateVersion: narrative.job.attempt.candidateVersion,
    candidateHash: narrative.job.attempt.candidateHash,
  } as const;
}

function memoryAttemptGuard(record: import("./server/persistence/gameRepository").GameRecord, job: import("@/game/domain/pendingNarrativeJob").PendingNarrativeJob, now: string): MemoryAttemptGuard | null {
  if (job.attempt.leaseId === null) return null;
  return {
    key: { gameId: record.gameId, generationId: record.worldState.generation.generationId, jobId: job.jobId, epoch: job.attempt.epoch },
    expectedRevision: record.revision,
    expectedNarrativeJob: {
      status: "provider_pending",
      jobId: String(job.jobId),
      epoch: job.attempt.epoch,
      leaseId: job.attempt.leaseId,
      candidateVersion: job.attempt.candidateVersion,
      candidateHash: job.attempt.candidateHash,
    },
    now,
  };
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

  let job = narrative.job;
  const lastPresentedScene = narrative.lastPresentedScene;
  const worldState = record.worldState;
  const storyState = record.storyState;

  const durableRecovery = job.attempt !== undefined
    && deps.repository.claimNarrativeJob !== undefined
    && deps.repository.reserveNarrativeCandidate !== undefined
    && deps.repository.recordNarrativeCandidateHash !== undefined
    && deps.repository.reserveNarrativeHttpAttempt !== undefined;
  let durableRecord = record;
  let durableMutationFailure: string | undefined;
  let leaseLost = false;
  const requestController = new AbortController();
  const requestSignal = deps.signal === undefined ? requestController.signal : AbortSignal.any([requestController.signal, deps.signal]);
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  const stopLeaseHeartbeat = () => {
    if (leaseTimer !== undefined) clearInterval(leaseTimer);
    leaseTimer = undefined;
  };
  if (durableRecovery) {
    const claim = await deps.repository.claimNarrativeJob!({
      gameId: record.gameId,
      expectedRevision: record.revision,
      jobId: String(job.jobId),
      now: deps.now(),
      leaseId: createLeaseId(deps),
      leaseExpiresAt: leaseExpiresAt(deps.now()),
    });
    if (!claim.ok) {
      return { ok: false, code: claim.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE" };
    }
    durableRecord = claim.record;
    const claimedNarrative = durableRecord.storyState.narrative;
    if (claimedNarrative.status !== "provider_pending") {
      return { ok: false, code: "STALE_GAME_REVISION" };
    }
    job = claimedNarrative.job;
    if (deps.repository.renewNarrativeJobLease !== undefined) {
      const renewLease = async () => {
        if (leaseLost) return;
        const currentNarrative = durableRecord.storyState.narrative;
        if (currentNarrative.status !== "provider_pending") return;
        const renewed = await deps.repository.renewNarrativeJobLease!({
          gameId: durableRecord.gameId,
          expectedRevision: durableRecord.revision,
          expectedNarrativeJob: narrativeAttemptPredicate(currentNarrative),
          now: deps.now(),
          leaseExpiresAt: leaseExpiresAt(deps.now()),
        });
        if (!renewed.ok) {
          leaseLost = true;
          durableMutationFailure = renewed.code;
          requestController.abort();
          return;
        }
        durableRecord = renewed.record;
        const renewedNarrative = durableRecord.storyState.narrative;
        if (renewedNarrative.status === "provider_pending") job = renewedNarrative.job;
      };
      leaseTimer = setInterval(() => { void renewLease(); }, 60_000);
      // A heartbeat must never keep a CLI/test process alive after the caller
      // has stopped awaiting this generation.
      if (typeof leaseTimer === "object" && "unref" in leaseTimer) leaseTimer.unref();
    }
  }

  const reserveDurableHttpAttempt = async (): Promise<boolean> => {
    if (!durableRecovery) return false;
    const currentNarrative = durableRecord.storyState.narrative;
    if (currentNarrative.status !== "provider_pending") {
      durableMutationFailure = "STALE_GAME_REVISION";
      return false;
    }
    const httpAttempt = await deps.repository.reserveNarrativeHttpAttempt!({
      gameId: durableRecord.gameId,
      expectedRevision: durableRecord.revision,
      expectedNarrativeJob: narrativeAttemptPredicate(currentNarrative),
    });
    if (!httpAttempt.ok) {
      durableMutationFailure = httpAttempt.code;
      return false;
    }
    durableRecord = httpAttempt.record;
    const httpNarrative = durableRecord.storyState.narrative;
    if (httpNarrative.status === "provider_pending") job = httpNarrative.job;
    return true;
  };

  let effectiveContext: NarrativeBundleSourceContext | undefined;
  let fixedMemoryContext: NarrativeMemoryContext | null = null;
  let fixedNpcMemoryContext: NarrativeMemoryContext | undefined;
  let fixedPromptMaxEstimatedTokens: number | undefined;
  let fixedMemoryAudit: AiTextAuditLink["memory"];
  const attachFixedMemory = (prepared: PreparedNarrativeMemory, preparedHash: string | null) => {
    fixedMemoryContext = prepared.player;
    fixedNpcMemoryContext = prepared.npc;
    fixedPromptMaxEstimatedTokens = prepared.policy.promptMaxEstimatedTokens;
    fixedMemoryAudit = { observerId: String(prepared.player.observerId), sourceFingerprint: prepared.sourceFingerprint,
      ...(preparedHash === null ? {} : { preparedHash }), coveredThroughSequence: prepared.player.coveredThroughSequence,
      historyIds: prepared.player.overviewHistoryIds, eventIds: prepared.player.overviewEventIds.map(String),
      rawCount: prepared.player.uncovered.length, recallCount: prepared.player.recalled.length,
    };
  };
  // This closure belongs to one worker and its immutable gameplay snapshot.
  // Cache only authorized outward data, never request controls or failures.
  let authorizedOutward: Extract<NarrativeBundleSourceContext, { kind: "decision" }>["npcOutward"];
  const generateCandidate: NarrativeBundleSource["generate"] = async (context) => {
    if (context.signal?.aborted) return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" }, repairReason: "provider_failure", repairDetail: "aborted" };
    const budgetedContext = context.kind === "decision" && fixedPromptMaxEstimatedTokens !== undefined
      ? { ...context, maxEstimatedTokens: fixedPromptMaxEstimatedTokens }
      : context;
    const prepared = budgetedContext.kind === "decision" && authorizedOutward !== undefined
      ? { ok: true as const, context: { ...budgetedContext, npcOutward: authorizedOutward } }
      : deps.npcDeliberationSource === undefined ? { ok: true as const, context: budgetedContext }
        : await prepareNpcNarrativeContext(budgetedContext, deps.npcDeliberationSource, fixedNpcMemoryContext);
    if (!prepared.ok) return prepared;
    if (prepared.context.kind === "decision") authorizedOutward = prepared.context.npcOutward;
    effectiveContext = prepared.context;
    const generated = await deps.source.generate(prepared.context);
    if (!generated.ok || generated.kind !== "decision" || prepared.context.kind !== "decision"
      || prepared.context.npcOutward === undefined) return generated;
    const byKey = new Map((generated.proposal.interactionProposals ?? []).map((proposal) => [proposal.proposalKey, proposal]));
    const selectedAliases = new Set([
      ...generated.proposal.currentScene.choices,
      ...generated.proposal.continuationScenes.flatMap((step) => step.scene.choices),
    ].map((choice) => choice.candidateId));
    for (const proposal of prepared.context.npcOutward.flatMap((outward) => outward.interactionProposals)) {
      if (!selectedAliases.has(`interaction:${proposal.proposalKey}`) && !byKey.has(proposal.proposalKey)) continue;
      const previous = byKey.get(proposal.proposalKey);
      if (previous !== undefined && hashNarrativeCandidate({ ...generated.proposal, interactionProposals: [previous] })
        !== hashNarrativeCandidate({ ...generated.proposal, interactionProposals: [proposal] })) {
        return { ok: false, failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" }, repairReason: "invalid_schema", repairDetail: "npc_interaction_proposal_conflict" };
      }
      byKey.set(proposal.proposalKey, proposal);
    }
    return { ...generated, proposal: { ...generated.proposal,
      interactionProposals: [...byKey.values()], npcOutwardProposals: prepared.context.npcOutward,
    } };
  };
  const source: NarrativeBundleSource = durableRecovery
    ? {
        generate: async (context) => {
          if (context.kind !== "decision") {
            return deps.source.generate(context);
          }
          if (leaseLost) {
            return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" }, repairReason: "provider_failure", repairDetail: "lease_lost" };
          }
          const currentNarrative = durableRecord.storyState.narrative;
          if (currentNarrative.status !== "provider_pending") {
            durableMutationFailure = "STALE_GAME_REVISION";
            return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" }, repairReason: "provider_failure", repairDetail: "lease_lost" };
          }
          const reserved = await deps.repository.reserveNarrativeCandidate!({
            gameId: durableRecord.gameId,
            expectedRevision: durableRecord.revision,
            expectedNarrativeJob: narrativeAttemptPredicate(currentNarrative),
          });
          if (!reserved.ok) {
            durableMutationFailure = reserved.code;
            return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" }, repairReason: "provider_failure", repairDetail: reserved.code };
          }
          durableRecord = reserved.record;
          const reservedNarrative = durableRecord.storyState.narrative;
          if (reservedNarrative.status !== "provider_pending") {
            durableMutationFailure = "STALE_GAME_REVISION";
            return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" }, repairReason: "provider_failure", repairDetail: "lease_lost" };
          }
          job = reservedNarrative.job;
          const generated = await generateCandidate({
            ...context,
            candidateVersion: job.attempt.candidateVersion,
            worldState: durableRecord.worldState,
            storyState: durableRecord.storyState,
            job,
            reserveHttpAttempt: reserveDurableHttpAttempt,
          });
          if (generated.ok && generated.kind === "decision") {
            const candidateHash = hashNarrativeCandidate(generated.proposal);
            const recorded = await deps.repository.recordNarrativeCandidateHash!({
              gameId: durableRecord.gameId,
              expectedRevision: durableRecord.revision,
              expectedNarrativeJob: narrativeAttemptPredicate(
                durableRecord.storyState.narrative as Extract<StoryState["narrative"], { readonly status: "provider_pending" }>,
              ),
              candidateHash,
            });
            if (!recorded.ok) {
              durableMutationFailure = recorded.code;
              return { ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" }, repairReason: "provider_failure", repairDetail: recorded.code };
            }
            durableRecord = recorded.record;
            const hashedNarrative = durableRecord.storyState.narrative;
            if (hashedNarrative.status === "provider_pending") job = hashedNarrative.job;
          }
          return generated;
        },
      }
    : { generate: generateCandidate };

  const transition: ObjectiveTransition = job.objectiveTransition;
  const evolutionNeed = deriveStructuralEvolutionNeed(worldState, storyState);

  const retryOrigin = deps.auditLink?.retry ?? (narrative.retryContext === undefined
    ? undefined
    : { origin: "manual_failed_job" as const, mechanism: "initial" as const, attempt: 0 });
  let lastFailureKind: AiFailureKind = "AI_RESPONSE_INVALID";
  let lastRepair: NarrativeBundleRepair | undefined;
  let candidateRevision: NarrativeCandidateRevision | undefined;
  let authorDraftRevision: NarrativeAuthorDraftRevision | undefined;
  let memoryPreparationFailure = false;
  let memoryReservationFailure: string | undefined;
  const reserveMemoryAttempt = async (kind: "reserveBatchUpdate" | "reserveHttpAttempt"): Promise<boolean> => {
    if (requestSignal.aborted) return false;
    const guard = durableRecovery ? memoryAttemptGuard(durableRecord, job, deps.now()) : null;
    const reserve = deps.memorySummaryRepository?.[kind];
    let result;
    try {
      result = guard === null || reserve === undefined
        ? { ok: false as const, code: "UNAVAILABLE" as const }
        : await reserve(guard);
    } catch {
      result = { ok: false as const, code: "UNAVAILABLE" as const };
    }
    if (result.ok) return true;
    if (result.code === "BUDGET_EXHAUSTED") return false;
    memoryReservationFailure = result.code;
    if (result.code === "STALE_ATTEMPT") {
      leaseLost = true;
      durableMutationFailure = "STALE_GAME_REVISION";
    }
    requestController.abort();
    return false;
  };
  const memoryGuard = durableRecovery ? memoryAttemptGuard(durableRecord, job, deps.now()) : null;
  if (deps.memorySummaryRepository?.loadPrepared !== undefined && memoryGuard !== null) {
    const loaded = await deps.memorySummaryRepository.loadPrepared(memoryGuard.key);
    if (!loaded.ok) {
      memoryPreparationFailure = true;
      lastFailureKind = "AI_CALL_FAILED";
      lastRepair = { attempt: 1, reason: "provider_failure", detail: loaded.code };
    } else if (loaded.prepared !== null) {
      attachFixedMemory(loaded.prepared, loaded.preparedHash);
    } else if (job.attempt.candidateVersion > 0) {
      // A later candidate belongs to the same frozen generation attempt. It
      // must never be regenerated with a different memory package after a
      // crash or cache loss.
      memoryPreparationFailure = true;
      lastFailureKind = "AI_CALL_FAILED";
      lastRepair = { attempt: 1, reason: "provider_failure", detail: "memory_preparation_missing" };
    } else if (deps.prepareMemoryPackage !== undefined && deps.memorySummaryRepository.freezePrepared !== undefined) {
      try {
        const next = await deps.prepareMemoryPackage({ record: durableRecord, job, signal: requestSignal,
          reserveBatchUpdate: () => reserveMemoryAttempt("reserveBatchUpdate"),
          reserveSummaryHttpAttempt: () => reserveMemoryAttempt("reserveHttpAttempt"),
        });
        if (requestSignal.aborted || next === null) throw new Error(memoryReservationFailure ?? "memory_preparation_missing");
        const freezeGuard = memoryAttemptGuard(durableRecord, job, deps.now());
        if (freezeGuard === null) throw new Error("STALE_ATTEMPT");
        {
          const frozen = await deps.memorySummaryRepository.freezePrepared({ ...freezeGuard, next });
          if (!frozen.ok) {
            memoryPreparationFailure = true;
            lastFailureKind = "AI_CALL_FAILED";
            lastRepair = { attempt: 1, reason: "provider_failure", detail: frozen.code };
          } else {
            attachFixedMemory(frozen.prepared, frozen.preparedHash);
          }
        }
      } catch (error) {
        memoryPreparationFailure = true;
        lastFailureKind = "AI_CALL_FAILED";
        const code = error instanceof Error && ["MEMORY_CONTEXT_OVERFLOW", "CANCELLED", "STALE_ATTEMPT", "memory_preparation_missing"].includes(error.message)
          ? error.message : "memory_preparation_failed";
        lastRepair = { attempt: 1, reason: code === "MEMORY_CONTEXT_OVERFLOW" ? "context_budget_exceeded" : "provider_failure", detail: memoryReservationFailure ?? code };
      }
    }
  }
  if (!memoryPreparationFailure && fixedMemoryContext === null && deps.prepareMemoryContext !== undefined) {
    try {
      fixedMemoryContext = await deps.prepareMemoryContext({ record: durableRecord, job, signal: requestSignal });
    } catch {
      memoryPreparationFailure = true;
      lastFailureKind = "AI_CALL_FAILED";
      lastRepair = { attempt: 1, reason: "provider_failure", detail: "memory_preparation_failed" };
    }
  }
  const revisionFindings: NarrativeBundleRepair[] = [];
  const bounded = await runBoundedAttempts<ApprovedNarrativeBundle, NarrativeBundleRepair>({
    maxAttempts: durableRecovery
      ? Math.max(1, MAX_NARRATIVE_BUNDLE_ATTEMPTS - job.attempt.candidateVersion)
      : MAX_NARRATIVE_BUNDLE_ATTEMPTS,
    runAttempt: async (attempt, priorRepair) => {
      if (memoryPreparationFailure) {
        const reason = lastRepair ?? { attempt, reason: "provider_failure" as const, detail: "memory_preparation_failed" };
        return { ok: false, retryable: false, reason };
      }
      if (priorRepair !== undefined) revisionFindings.push(priorRepair);
      // 自动修复从 1 开始；本次循环若由手动重试启动，则以 retryContext
      // 的首次修复序号为偏移。该偏移不代表之前多次手动重试的累计次数。
      const repairHint: NarrativeBundleRepair | undefined = attempt > 1 && priorRepair !== undefined
        ? { ...priorRepair, attempt: attempt - 1 + (narrative.retryContext?.attempt ?? 0) }
        : narrative.retryContext;

      let sourceResult;
      try {
        sourceResult = await source.generate({
          kind: "decision",
          ...(candidateRevision === undefined ? {} : { candidateRevision: { ...candidateRevision, findings: [...revisionFindings] } }),
          ...(authorDraftRevision === undefined ? {} : { authorDraftRevision: { ...authorDraftRevision, findings: [...revisionFindings] } }),
          candidateVersion: durableRecovery ? job.attempt.candidateVersion : attempt,
          signal: requestSignal,
          worldState,
          storyState,
          job,
          ...(fixedMemoryContext === null ? {} : { memoryContext: fixedMemoryContext }),
          auditLink: {
            ...(deps.auditLink ?? {}),
            ...(fixedMemoryAudit === undefined ? {} : { memory: fixedMemoryAudit }),
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
        candidateRevision = undefined;
        authorDraftRevision = undefined;
        lastFailureKind = "AI_CALL_FAILED";
        lastRepair = { attempt, reason: "provider_failure", detail: "source_exception" };
        return { ok: false, retryable: true, reason: lastRepair };
      }

      if (!sourceResult.ok) {
        lastFailureKind = sourceResult.failure.kind;
        lastRepair = repairFromSourceFailure(sourceResult, attempt);
        if (sourceResult.repairReason === "invalid_schema" && sourceResult.rejectedDraft !== undefined) {
          candidateRevision = undefined;
          authorDraftRevision = {
            candidateVersion: durableRecovery ? job.attempt.candidateVersion : attempt,
            draft: sourceResult.rejectedDraft,
            findings: [...revisionFindings, lastRepair],
          };
        } else {
          candidateRevision = undefined;
          authorDraftRevision = undefined;
        }
        return {
          ok: false,
          retryable: durableMutationFailure === undefined,
          reason: lastRepair,
        };
      }

      lastFailureKind = "AI_RESPONSE_INVALID";
      if (sourceResult.kind !== "decision") {
        candidateRevision = undefined;
        authorDraftRevision = undefined;
        lastRepair = { attempt, reason: "invalid_schema", detail: "unexpected_source_kind" };
        return { ok: false, retryable: true, reason: lastRepair };
      }
      const candidateVersion = durableRecovery ? job.attempt.candidateVersion : attempt;
      const candidateHash = hashNarrativeCandidate(sourceResult.proposal);
      authorDraftRevision = undefined;
      candidateRevision = { candidateVersion, candidateHash, proposal: sourceResult.proposal, findings: [...revisionFindings] };
      const approvalInput = {
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
        candidateVersion,
        candidateHash,
      };
      // The first approval is a pure structural/rule preflight. It ensures a
      // malformed candidate never consumes a semantic-review request.
      const preflight = approveNarrativeBundle(approvalInput);

      if (!preflight.ok) {
        if (preflight.code === "STALE_CANDIDATE_REVIEW") {
          lastRepair = { attempt, reason: "invalid_schema", detail: "stale_candidate_review" };
          return { ok: false, retryable: false, reason: lastRepair };
        }
        lastRepair = { attempt, reason: "approval_rejected", rejectionCode: preflight.code, ...(preflight.detail === undefined ? {} : { detail: preflight.detail }) };
        return {
          ok: false,
          retryable: true,
          reason: lastRepair,
        };
      }

      let approved = preflight.approved;
      if (deps.reviewer !== undefined) {
        let review: CandidateReviewResult;
        try {
          review = await deps.reviewer.reviewNarrativeCandidate({
            context: {
              ...(effectiveContext?.kind === "decision" ? effectiveContext : {}),
              kind: "decision",
              candidateVersion,
              signal: requestSignal,
              worldState: preflight.approved.nextWorldState,
              reviewWorldState: preflight.approved.nextWorldState,
              generationContract: preflight.approved.generationContract,
              reviewScenes: [
                preflight.approved.currentScene,
                ...preflight.approved.bundle.steps.map(step => step.scene),
                ...(preflight.approved.bundle.endingOutcomes ?? []).map(outcome => outcome.scene),
              ],
              storyState: preflight.approved.nextStoryStatePreview,
              job: { ...job, objectiveTransition: preflight.approved.objectiveTransition },
              auditLink: {
                ...(deps.auditLink ?? {}),
                ...(fixedMemoryAudit === undefined ? {} : { memory: fixedMemoryAudit }),
                gameId: String(record.gameId),
                jobId: String(job.jobId),
                turnNumber: job.turnNumber,
              },
              reserveHttpAttempt: durableRecovery ? reserveDurableHttpAttempt : undefined,
              ...(repairHint === undefined ? {} : { contentRepair: repairHint }),
            },
            proposal: sourceResult.proposal,
            candidateVersion,
            candidateHash,
          });
        } catch {
          review = {
            ok: false,
            candidateVersion,
            candidateHash,
            failure: "PROVIDER_FAILURE",
          };
        }

        if (!review.ok) {
          if ("defects" in review) {
            if (review.defects.length === 0
              || review.defects.some((defect) => !candidateReviewMatches(defect, candidateVersion, candidateHash))) {
              lastFailureKind = "AI_RESPONSE_INVALID";
              lastRepair = { attempt, reason: "invalid_schema", detail: "candidate_review_invalid" };
              return { ok: false, retryable: false, reason: lastRepair };
            }
            lastFailureKind = "AI_RESPONSE_INVALID";
            lastRepair = repairFromCandidateReview(review.defects, attempt);
            return { ok: false, retryable: true, reason: lastRepair };
          }
          lastFailureKind = review.failure === "PROVIDER_FAILURE" ? "AI_CALL_FAILED" : "AI_RESPONSE_INVALID";
          lastRepair = {
            attempt,
            reason: review.failure === "PROVIDER_FAILURE" ? "provider_failure" : "invalid_schema",
            detail: review.failure === "PROVIDER_FAILURE" ? "candidate_review_provider_failure" : "candidate_review_uncertain",
          };
          return { ok: false, retryable: false, reason: lastRepair };
        }
        if (!candidateReviewMatches(review, candidateVersion, candidateHash)) {
          lastFailureKind = "AI_RESPONSE_INVALID";
          lastRepair = { attempt, reason: "invalid_schema", detail: "candidate_review_invalid" };
          return { ok: false, retryable: false, reason: lastRepair };
        }
        const finalApproval = approveNarrativeBundle({
          ...approvalInput,
          candidateReview: review,
        });
        if (!finalApproval.ok) {
          if (finalApproval.code === "STALE_CANDIDATE_REVIEW") {
            lastRepair = { attempt, reason: "invalid_schema", detail: "stale_candidate_review" };
            return { ok: false, retryable: false, reason: lastRepair };
          }
          lastRepair = {
            attempt,
            reason: "approval_rejected",
            rejectionCode: finalApproval.code,
            ...(finalApproval.detail === undefined ? {} : { detail: finalApproval.detail }),
          };
          return { ok: false, retryable: true, reason: lastRepair };
        }
        approved = finalApproval.approved;
      }

      return { ok: true, value: approved };
    },
  });

  async function failPendingJob(): Promise<GeneratePendingNarrativeBundleResult> {
    stopLeaseHeartbeat();
    // Record provider_failed with same jobId
    const currentNarrative = durableRecord.storyState.narrative;
    const currentJob = currentNarrative.status === "provider_pending" ? currentNarrative.job : job;
    const failedJob = durableRecovery
      ? {
          ...currentJob,
          attempt: { ...currentJob.attempt, leaseId: null, leaseExpiresAt: null, status: "failed" as const },
        }
      : currentJob;
    const failedNarrative: NarrativeRuntimeState = {
      status: "provider_failed",
      mode: narrative.mode,
      job: failedJob,
      failure: {
        kind: lastFailureKind,
        reason: persistedAiRepairReason(lastRepair ?? { attempt: 1, reason: "invalid_schema" }),
        phase: "scene",
        failedAt: deps.domainTime?.(`failed:${job.jobId}:${job.attempt?.epoch ?? 0}`) ?? deps.now(),
      },
      lastPresentedScene,
      ...(narrative.dialogueSession === undefined ? {} : { dialogueSession: narrative.dialogueSession }),
    };

    const failedStoryState: StoryState = {
      ...(durableRecovery ? durableRecord.storyState : storyState),
      narrative: failedNarrative,
    };

    const savedFailure = await deps.repository.applyState({
      gameId: record.gameId,
      expectedRevision: durableRecord.revision,
      nextWorldState: durableRecord.worldState,
      nextStoryState: failedStoryState,
      ...(durableRecovery && currentNarrative.status === "provider_pending"
        ? { expectedNarrativeJob: narrativeAttemptPredicate(currentNarrative) }
        : {}),
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

  if (memoryPreparationFailure) return failPendingJob();

  if (!bounded.ok) return failPendingJob();
  if (requestSignal.aborted) {
    lastFailureKind = "AI_CALL_FAILED";
    lastRepair = { attempt: 1, reason: "provider_failure", detail: "aborted" };
    return failPendingJob();
  }

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
  // Approval binds generated scenes to the revision they will be written at so
  // ordinary choice tokens remain valid. A story exit instead publishes the
  // already-approved terminal scene for the action that created this job.
  // Its displayed turn must therefore match the action, ending event, and
  // History entries rather than the later generation write-back revision.
  const publishedCurrentScene = exitEnding === undefined
    ? approved.currentScene
    : { ...approved.currentScene, turn: job.turnNumber };

  // Build the ready narrative with the approved bundle
  const readyNarrative: NarrativeRuntimeState = {
    status: "ready",
    mode: narrative.mode,
    currentScene: publishedCurrentScene,
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
      committedAt: deps.domainTime?.(`committed:${job.jobId}:${job.attempt?.epoch ?? 0}`) ?? deps.now(),
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
    scene: publishedCurrentScene,
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

  if (requestSignal.aborted) {
    lastFailureKind = "AI_CALL_FAILED";
    lastRepair = { attempt: 1, reason: "provider_failure", detail: "aborted" };
    return failPendingJob();
  }
  const commitResult = await deps.repository.applyState({
    gameId: record.gameId,
    expectedRevision: durableRecord.revision,
    nextWorldState,
    nextStoryState,
    ...(durableRecovery && durableRecord.storyState.narrative.status === "provider_pending"
      ? { expectedNarrativeJob: narrativeAttemptPredicate(durableRecord.storyState.narrative) }
      : {}),
  });

  if (!commitResult.ok) {
    stopLeaseHeartbeat();
    return {
      ok: false,
      code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
    };
  }

  stopLeaseHeartbeat();
  return { ok: true, revision: commitResult.record.revision };
}
