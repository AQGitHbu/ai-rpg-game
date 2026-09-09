import { repairFromSourceFailure, aiRepairAuditContext } from "./aiGenerationRetry";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { AiTextAuditRecorder, AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { SceneSource, ScenePerformanceProposal } from "./sceneSource";
import { sceneInvestigationResultFrom } from "./sceneSource";
import { buildSceneGenerationContext, isFinalDialogueHandoff } from "./sceneGenerationContext";
import { buildSelectableSceneCandidates } from "./deterministicSceneSource";
import {
  approveScenePerformance,
  type ApprovedSceneWriteBack,
} from "./approveAndWriteScene";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { evolveWorld } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { NarrativeSceneRequestKind } from "@/game/domain/pendingNarrativeJob";
import { providerAllowedFor } from "@/game/gameplay/rpg/narrativeExecution";
import type { GameLogger } from "@/game/logging";
import type { StructuredActionSummary } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import type { NarrativeGenerationRepairReason } from "@/game/domain/narrativeGenerationFailure";
import { markNarrativeGenerationFailed } from "./markNarrativeGenerationFailed";
import { runBoundedAttempts } from "@/game/core/retry";
import { buildWorldDeltaEntityContextClosure } from "./entityContextProjection";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";

export type GeneratePendingSceneDeps = {
  readonly repository: GameRepository;
  readonly sceneSource: SceneSource;
  /** Task 3：场景编排联动的世界演化源（幕推进/结局对时装配预览状态后再出场景）。 */
  readonly worldEvolutionSource?: WorldEvolutionSource;
  readonly logger?: GameLogger;
  readonly now: () => string;
  /** AI 文本审计记录器，记录场景写回为 story_text 事件。 */
  readonly textAuditRecorder?: AiTextAuditRecorder;
  /** 审计关联 link：traceId/gameId/jobId/turnNumber，只用于日志关联。 */
  readonly auditLink?: AiTextAuditLink;
};

export type GeneratePendingSceneResult =
  | "saved"
  | "not_pending"
  | "stale"
  | "failed"
  | "unavailable";

function buildAuditedSceneGenerationContext(
  record: GameRecord,
  auditLink: AiTextAuditLink | undefined,
  retryContext: Extract<GameRecord["storyState"]["narrative"], { status: "provider_pending" }>["retryContext"] | undefined,
) {
  const context = buildSceneGenerationContext(record);
  const repairAttempt = retryContext === undefined
    ? undefined
    : { attempt: retryContext.attempt, reason: retryContext.reason };
  const retry = retryContext === undefined
    ? auditLink?.retry
    : aiRepairAuditContext(retryContext, auditLink?.retry);
  return {
    ...context,
    ...(repairAttempt === undefined ? {} : { repairAttempt }),
    auditLink: {
      ...auditLink,
      gameId: String(record.gameId),
      jobId: String(context.job.jobId),
      turnNumber: context.job.turnNumber,
      ...(retry === undefined ? {} : { retry }),
    },
    auditTrigger: deriveSceneTrigger(context.job.actionSummary, context.job),
  };
}

function withSceneRepairContext<TContext extends ReturnType<typeof buildAuditedSceneGenerationContext>>(
  context: TContext,
  repairAttempt: { readonly attempt: 1; readonly reason: NarrativeGenerationRepairReason },
): TContext {
  return {
    ...context,
    repairAttempt,
    auditLink: {
      ...context.auditLink,
      retry: aiRepairAuditContext(repairAttempt, context.auditLink?.retry),
    },
  } as TContext;
}

/**
 * A completed formal NPC handoff is the only point at which the provider job
 * may prepare the next world boundary. If the current act still has a linear
 * tail, materialize the following act now so battle resolution cannot become
 * an accidental world-AI trigger. Likewise, a final-act tail gets its ending
 * pair before the deterministic battle path reaches it.
 */
function derivePreparedBoundaryNeed(
  worldState: GameRecord["worldState"],
  storyState: GameRecord["storyState"],
  sceneRequestKind: NarrativeSceneRequestKind,
): EvolutionNeed {
  if (sceneRequestKind !== "npc_handoff") return { kind: "none" };

  const currentQuest = worldState.quests.find((quest) =>
    quest.kind === "main"
    && quest.stage === storyState.currentAct
    && quest.status === "active",
  );
  if (currentQuest === undefined) return { kind: "none" };

  if (storyState.currentAct >= storyState.targetActs && worldState.endings.length < 2) {
    return { kind: "ending_pair", finalAct: storyState.currentAct };
  }

  const nextAct = storyState.currentAct + 1;
  const nextActAlreadyMaterialized = worldState.quests.some((quest) =>
    quest.kind === "main" && quest.stage === nextAct,
  );
  if (storyState.currentAct < storyState.targetActs && !nextActAlreadyMaterialized) {
    return { kind: "next_act", act: nextAct };
  }
  return { kind: "none" };
}

/**
 * 执行一个 pending 叙事场景请求（spec §7 + §11）。
 * 读 provider_pending job → buildSceneGenerationContext → 调 SceneSource → 写回 ready。
 * 不再伪造 ResolvedEvent：source 只接收 job 驱动的上下文。
 */
export async function generatePendingScene(
  deps: GeneratePendingSceneDeps,
): Promise<GeneratePendingSceneResult> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";

  const { record } = loaded;
  const generation = record.storyState.narrative;
  if (generation.status !== "provider_pending") return "not_pending";

  const fail = async (failure: NarrativeGenerationFailure): Promise<GeneratePendingSceneResult> => {
    const marked = await markNarrativeGenerationFailed(deps.repository, record, failure);
    if (marked.ok) return "failed";
    return marked.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  };

  const sceneFailure = (
    kind: "AI_CALL_FAILED" | "AI_RESPONSE_INVALID",
    reason?: NarrativeGenerationRepairReason,
  ): NarrativeGenerationFailure => ({
    kind,
    phase: "scene",
    failedAt: deps.now(),
    ...(reason === undefined ? {} : { reason }),
  });

  if (!providerAllowedFor(generation.job.generationKind)) {
    deps.logger?.warn("provider_trigger_rejected", {
      runtimeStatus: generation.status,
      generationKind: generation.job.generationKind,
    });
    return fail(sceneFailure("AI_RESPONSE_INVALID", "invalid_schema"));
  }

  // Task 3：场景编排同样可能挂着演化需求（幕推进/结局对）。
  // 先把 delta 装配为预览记录（只读预览，不落库），再以预览世界/故事状态出场景，
  // 最后经 applySceneWriteBack 单次 CAS 一并写回实体与场景。
  let scenarioWs = record.worldState;
  let scenarioSs = record.storyState;
  let eventDrafts: readonly import("@/game/domain/events").NarrativeEventDraft[] = [];
  const derivedNeed = deriveEvolutionNeed(record.worldState, record.storyState);
  // 结局对已具象化后，规则层在最终选择回合仍可能保留
  // needs_ending_pair 标记；不能再次向 source 请求同一对结局并把合法收尾判成重复。
  const naturalNeed = derivedNeed.kind === "ending_pair" && record.worldState.endings.length >= 2
    ? { kind: "none" as const }
    : derivedNeed.kind === "next_act" && record.worldState.quests.some((quest) =>
        quest.kind === "main" && quest.stage === derivedNeed.act,
      )
      ? { kind: "none" as const }
      : derivedNeed;
  const proactiveNeed = derivePreparedBoundaryNeed(
    record.worldState,
    record.storyState,
    generation.job.sceneRequestKind ?? "opening",
  );
  const structuralNeed = naturalNeed.kind === "next_act" || naturalNeed.kind === "ending_pair"
    ? naturalNeed
    : { kind: "none" as const };
  const need = structuralNeed.kind !== "none"
    ? structuralNeed
    : proactiveNeed.kind !== "none"
      ? proactiveNeed
      : naturalNeed;
  // 未注入演化源时不主动演化：保持既有时景写回行为，仅当配置了 source 才装配预览。
  if (need.kind !== "none") {
    const outcome = await evolveWorld({
      need,
      worldState: record.worldState,
      storyState: record.storyState,
      source: deps.worldEvolutionSource,
      reason: "scene_evolution",
      entityContextClosure: buildWorldDeltaEntityContextClosure({
        worldState: record.worldState,
        storyState: record.storyState,
        job: generation.job,
      }),
      auditLink: { ...deps.auditLink, gameId: String(record.gameId), jobId: String(generation.job.jobId), turnNumber: generation.job.turnNumber },
      eventContext: {
        turnId: generation.job.turnId,
        turnNumber: generation.job.turnNumber,
        actionId: generation.job.actionId,
        domainEventIds: generation.job.domainEventIds,
        episodeKey: String(generation.job.turnId),
        eventKey: `blueprint_expanded:${generation.job.jobId}:scene_evolution`,
      },
      now: deps.now,
    });
    if (outcome.ok) {
      for (const category of outcome.approved.logCategories ?? []) {
        deps.logger?.warn(category, {});
      }
      scenarioWs = outcome.delta.previewWorldState;
      scenarioSs = outcome.delta.previewStoryState;
      eventDrafts = [...eventDrafts, ...outcome.delta.eventDrafts];
    } else if (outcome.failure !== undefined) {
      return fail({ ...outcome.failure, phase: "scene", failedAt: deps.now() });
    } else {
      return fail(sceneFailure("AI_RESPONSE_INVALID"));
    }
  }

  let scenarioRecord: GameRecord = {
    ...record,
    worldState: scenarioWs,
    storyState: scenarioSs,
  };

  let context = buildAuditedSceneGenerationContext(scenarioRecord, deps.auditLink, generation.retryContext);

  // Candidate capacity is a provider-job concern: the job may ask the world
  // evolution source for enough rule-owned entities before the single scene
  // write-back. This path is unreachable from deterministic action turns,
  // which never create a provider_pending job for linear actions.
  if (buildSelectableSceneCandidates(context).length < (isFinalDialogueHandoff(context) ? 1 : 2)) {
    const recovery = await evolveWorld({
      need: { kind: "pacing", pacingNeed: "complicate" },
      worldState: scenarioWs,
      storyState: scenarioSs,
      source: deps.worldEvolutionSource,
      reason: "scene_candidate_shortage",
      entityContextClosure: buildWorldDeltaEntityContextClosure({
        worldState: scenarioWs,
        storyState: scenarioSs,
        job: generation.job,
      }),
      auditLink: {
        ...deps.auditLink,
        gameId: String(record.gameId),
        jobId: String(generation.job.jobId),
        turnNumber: generation.job.turnNumber,
      },
      eventContext: {
        turnId: generation.job.turnId,
        turnNumber: generation.job.turnNumber,
        actionId: generation.job.actionId,
        domainEventIds: generation.job.domainEventIds,
        episodeKey: String(generation.job.turnId),
        eventKey: `blueprint_expanded:${generation.job.jobId}:scene_candidate_shortage`,
      },
      now: deps.now,
    });
    if (!recovery.ok) {
      if (recovery.failure !== undefined) return fail({ ...recovery.failure, phase: "scene", failedAt: deps.now() });
      return fail(sceneFailure("AI_RESPONSE_INVALID"));
    }
    for (const category of recovery.approved.logCategories ?? []) {
      deps.logger?.warn(category, {});
    }
    scenarioWs = recovery.delta.previewWorldState;
    scenarioSs = recovery.delta.previewStoryState;
    eventDrafts = [...eventDrafts, ...recovery.delta.eventDrafts];
    scenarioRecord = { ...record, worldState: scenarioWs, storyState: scenarioSs };
    context = buildAuditedSceneGenerationContext(scenarioRecord, deps.auditLink, generation.retryContext);
  }

  type SceneAttemptValue = {
    readonly proposal: ScenePerformanceProposal;
    readonly approved: ApprovedSceneWriteBack;
    readonly context: ReturnType<typeof buildAuditedSceneGenerationContext>;
  };
  let terminalFailure: NarrativeGenerationFailure = sceneFailure("AI_RESPONSE_INVALID");
  const bounded = await runBoundedAttempts<SceneAttemptValue, NarrativeGenerationRepairReason>({
    maxAttempts: 2,
    runAttempt: async (attempt, priorReason) => {
      const attemptContext = attempt === 1
        ? context
        : withSceneRepairContext(context, {
            attempt: 1,
            reason: priorReason ?? "invalid_schema",
          });
      let sceneResult;
      try {
        sceneResult = await deps.sceneSource.generateScene(attemptContext);
      } catch (error) {
        deps.logger?.warn("scene_generation_source_exception", {
          message: error instanceof Error ? error.message.slice(0, 240) : "unknown_error",
        });
        terminalFailure = sceneFailure("AI_CALL_FAILED", "source_exception");
        return { ok: false, retryable: false, reason: "source_exception" };
      }
      if (!sceneResult.ok) {
        const { reason } = repairFromSourceFailure(sceneResult, attempt);
        terminalFailure = sceneFailure(sceneResult.failure.kind, reason);
        return {
          ok: false,
          retryable: attempt === 1 && sceneResult.repairReason !== undefined,
          reason,
        };
      }

      let proposal = sceneResult.proposal;
      const investigationResult = sceneInvestigationResultFrom(attemptContext);
      if (investigationResult !== undefined) proposal = { ...proposal, investigationResult };

      const approvedGenerated = approveScenePerformance({
        context: attemptContext,
        proposal,
        basedOnRevision: record.revision + 1,
        existingCandidateEventPool: record.storyState.candidateEventPool,
        worldState: scenarioWs,
        logger: deps.logger,
      });
      if (approvedGenerated.ok) {
        for (const code of approvedGenerated.qualityWarnings) {
          deps.logger?.warn("scene_quality_warning", { code });
        }
        return { ok: true, value: { proposal, approved: approvedGenerated, context: attemptContext } };
      }

      if (proposal.source === "generated") {
        deps.logger?.warn("scene_generation_rejected", { code: approvedGenerated.code });
      }
      const repairReason = `approval:${approvedGenerated.code}` as const;
      terminalFailure = sceneFailure("AI_RESPONSE_INVALID", repairReason);
      const canRepair = attempt === 1 && proposal.source === "generated";
      if (canRepair) {
        deps.logger?.warn("scene_generation_content_retry", {
          reason: repairReason,
          attempt,
        });
      }
      return { ok: false, retryable: canRepair, reason: repairReason };
    },
  });
  if (!bounded.ok) return fail(terminalFailure);
  const { approved, context: acceptedContext } = bounded.value;
  context = acceptedContext;
  eventDrafts = [...eventDrafts, ...approved.eventDrafts];

  const pendingRuntime = scenarioSs.narrative;
  if (pendingRuntime.status !== "provider_pending") {
    return fail(sceneFailure("AI_RESPONSE_INVALID"));
  }

  const eventCommit = commitEventDrafts({
    ledger: record.worldState.eventLedger,
    drafts: eventDrafts,
    source: {
      turnId: generation.job.turnId,
      actionId: generation.job.actionId,
      turnNumber: generation.job.turnNumber,
      committedAt: deps.now(),
    },
    entityStore: scenarioWs.entityStore,
  });
  if (!eventCommit.ok) {
    deps.logger?.warn("scene_event_commit_rejected", { code: eventCommit.code });
    return fail(sceneFailure("AI_RESPONSE_INVALID"));
  }
  const committedScenarioWs = { ...scenarioWs, eventLedger: eventCommit.ledger };

  const writeBack = await deps.repository.applySceneWriteBack({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState: committedScenarioWs,
    nextStoryState: {
      ...scenarioSs,
      memory: rebuildEpisodicMemory(eventCommit.ledger),
      narrative: {
        status: "ready",
        mode: pendingRuntime.mode,
        currentScene: approved.scene,
        choiceRegistry: approved.choiceRegistry,
        preparedContinuation: approved.preparedContinuation,
        ...(pendingRuntime.dialogueSession === undefined
          ? {}
          : { dialogueSession: pendingRuntime.dialogueSession }),
      },
      candidateEventPool: approved.candidateEventPool,
    },
  });

  if (!writeBack.ok) {
    return writeBack.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  }

  // Record the story_text audit event for the approved scene write-back.
  if (deps.textAuditRecorder?.enabled) {
    const trigger = deriveSceneTrigger(context.job.actionSummary, context.job);
    try {
      await deps.textAuditRecorder.record({
        kind: "story_text",
        context: {
          purpose: "final_story_text",
          trigger,
          ...(context.auditLink ?? {}),
          gameId: record.gameId,
          jobId: context.job.jobId,
          actionId: context.job.actionId,
          turnNumber: context.job.turnNumber,
          revision: record.revision + 1,
          action: context.job.actionSummary,
        },
        source: approved.scene.source,
        path: "normal",
        scene: approved.scene,
        visibleText: {
          narration: approved.scene.narration,
          npcLine: approved.scene.npcLine,
          npcDialogues: approved.scene.npcDialogues,
          choices: approved.scene.choices,
        },
        ...(approved.qualityWarnings.length === 0
          ? {}
          : { qualityWarnings: approved.qualityWarnings }),
      });
    } catch {
      // best-effort: audit write failure never blocks the game flow
      deps.logger?.warn("ai_text_audit_write_failed", {});
    }
  }

  return "saved";
}

/**
 * Derive a stable trigger value from the structured action summary and pending job.
 * actionId starting with start_ = initial_opening; talk with utterance = free_text_dialogue;
 * talk without utterance = talk_choice; others use action type + _action suffix.
 */
function deriveSceneTrigger(
  summary: StructuredActionSummary,
  job: { actionId: string; utterance?: string },
): string {
  if (job.actionId.startsWith("start_")) return "initial_opening";
  if (summary.kind === "talk") {
    return job.utterance !== undefined && job.utterance !== "" ? "free_text_dialogue" : "talk_choice";
  }
  switch (summary.kind) {
    case "explore": return "explore_action";
    case "investigate": return "investigate_action";
    case "move": return "move_action";
    case "take_item": return "take_item_action";
    case "give_item": return "give_item_action";
    case "attack": return "attack_action";
    case "battle_action": return "battle_action";
    case "ack_prologue": return "ack_prologue_action";
    case "freeform": return "freeform_action";
    default: return "explore_action";
  }
}
