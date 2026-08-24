import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { AiTextAuditRecorder, AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { SceneSource, ScenePerformanceProposal } from "./sceneSource";
import { sceneInvestigationResultFrom } from "./sceneSource";
import { buildSceneGenerationContext, isFinalDialogueHandoff } from "./sceneGenerationContext";
import {
  approveScenePerformance,
  type ApprovedSceneWriteBack,
} from "./approveAndWriteScene";
import { buildSelectableSceneCandidates } from "./deterministicSceneSource";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { evolveWorld } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { GameLogger } from "@/game/logging";
import type { StructuredActionSummary } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { markNarrativeGenerationFailed } from "./markNarrativeGenerationFailed";

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
) {
  const context = buildSceneGenerationContext(record);
  return {
    ...context,
    auditLink: {
      ...auditLink,
      gameId: String(record.gameId),
      jobId: String(context.job.jobId),
      turnNumber: context.job.turnNumber,
    },
    auditTrigger: deriveSceneTrigger(context.job.actionSummary, context.job),
  };
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

  const sceneFailure = (kind: "AI_CALL_FAILED" | "AI_RESPONSE_INVALID"): NarrativeGenerationFailure => ({
    kind,
    phase: "scene",
    failedAt: deps.now(),
  });

  // Task 3：场景编排同样可能挂着演化需求（幕推进/结局对）。
  // 先把 delta 装配为预览记录（只读预览，不落库），再以预览世界/故事状态出场景，
  // 最后经 applySceneWriteBack 单次 CAS 一并写回实体与场景。
  let scenarioWs = record.worldState;
  let scenarioSs = record.storyState;
  const summary = generation.job.actionSummary;
  // 幕推进/结局对挂起时必须保留完整演化编排，不能被 fast path 短路。
  const evolutionBlocksImmediatePath = record.storyState.evolution.status === "needs_next_act"
    || record.storyState.evolution.status === "needs_ending_pair";
  // 单线调查与移动/拾取同为规则已完全确定的即时反馈（保留既有规则写回语义）。
  const immediateAction = (summary.kind === "move"
    || summary.kind === "take_item"
    || summary.kind === "investigate")
    && !evolutionBlocksImmediatePath;
  const derivedNeed = immediateAction
    ? { kind: "none" as const }
    : deriveEvolutionNeed(record.worldState, record.storyState);
  // 结局对已具象化后，规则层在最终选择回合仍可能保留
  // needs_ending_pair 标记；不能再次向 source 请求同一对结局并把合法收尾判成重复。
  const need = derivedNeed.kind === "ending_pair" && record.worldState.endings.length >= 2
    ? { kind: "none" as const }
    : derivedNeed;
  // 未注入演化源时不主动演化：保持既有时景写回行为，仅当配置了 source 才装配预览。
  if (need.kind !== "none") {
    const outcome = await evolveWorld({
      need,
      worldState: record.worldState,
      storyState: record.storyState,
      source: deps.worldEvolutionSource,
      reason: "scene_evolution",
      auditLink: { ...deps.auditLink, gameId: String(record.gameId), jobId: String(generation.job.jobId), turnNumber: generation.job.turnNumber },
      now: deps.now,
    });
    if (outcome.ok) {
      for (const category of outcome.approved.logCategories ?? []) {
        deps.logger?.warn(category, {});
      }
      scenarioWs = outcome.delta.previewWorldState;
      scenarioSs = outcome.delta.previewStoryState;
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

  let context = buildAuditedSceneGenerationContext(scenarioRecord, deps.auditLink);

  // ready scene 必须有两个语义不同的合法选择。若当前世界只有一个候选，
  // 不让生成任务永久 pending，也不在客户端伪造按钮；显式 offline fixture
  // 可以注入演化 source 补足测试旅程。
  if (buildSelectableSceneCandidates(context).length < (isFinalDialogueHandoff(context) ? 1 : 2)) {
    const recovery = await evolveWorld({
      need: { kind: "pacing", pacingNeed: "complicate" },
      worldState: scenarioWs,
      storyState: scenarioSs,
      source: deps.worldEvolutionSource,
      reason: "scene_candidate_shortage",
      auditLink: { ...deps.auditLink, gameId: String(record.gameId), jobId: String(generation.job.jobId), turnNumber: generation.job.turnNumber },
      now: deps.now,
    });
    if (recovery.ok) {
      for (const category of recovery.approved.logCategories ?? []) {
        deps.logger?.warn(category, {});
      }
      scenarioWs = recovery.delta.previewWorldState;
      scenarioSs = recovery.delta.previewStoryState;
      scenarioRecord = {
        ...record,
        worldState: scenarioWs,
        storyState: scenarioSs,
      };
      context = buildAuditedSceneGenerationContext(scenarioRecord, deps.auditLink);
    } else if (recovery.failure !== undefined) {
      return fail({ ...recovery.failure, phase: "scene", failedAt: deps.now() });
    } else {
      return fail(sceneFailure("AI_RESPONSE_INVALID"));
    }
  }
  if (buildSelectableSceneCandidates(context).length < (isFinalDialogueHandoff(context) ? 1 : 2)) {
    return fail(sceneFailure("AI_RESPONSE_INVALID"));
  }

  let proposal: ScenePerformanceProposal;
  try {
    const sceneResult = await deps.sceneSource.generateScene(context);
    if (!sceneResult.ok) return fail({ ...sceneResult.failure, phase: "scene", failedAt: deps.now() });
    proposal = sceneResult.proposal;
  } catch (error) {
    deps.logger?.warn("scene_generation_source_exception", {
      message: error instanceof Error ? error.message.slice(0, 240) : "unknown_error",
    });
    return fail(sceneFailure("AI_CALL_FAILED"));
  }

  // Task 5：已结算调查结果的叙事上下文随提案携带（覆盖确定性/live/stub 各来源）。
  const investigationResult = sceneInvestigationResultFrom(context);
  if (investigationResult !== undefined) {
    proposal = { ...proposal, investigationResult };
  }

  // 完整场景表演审批（Task 6）：核心结构非法（缺强制节拍/自创节拍 ID/
  // 错误 NPC 应答/forbidden fact/他人交互/过期目标/重复选项/无推进选项）时，
  // 先给 generated proposal 一次带拒绝码的内容修复机会；修复仍失败就持久化
  // AI_RESPONSE_INVALID，不写入 deterministic 场景。
  let approved: ApprovedSceneWriteBack | null = null;
  const approvedGenerated = approveScenePerformance({
    context,
    proposal,
    basedOnRevision: record.revision + 1,
    existingCandidateEventPool: record.storyState.candidateEventPool,
    logger: deps.logger,
  });
  if (approvedGenerated.ok) {
    approved = approvedGenerated;
    for (const code of approvedGenerated.qualityWarnings) {
      deps.logger?.warn("scene_quality_warning", { code });
    }
  } else {
    // live source 已成功取得并解析响应、但审批拒绝时先给同一上下文一次
    // 内容修复机会。修复提示携带结构化拒绝码，避免完全重复同一个请求；
    // repairAttempt 也限制整个 pending 回合最多一次内容重试。
    if (proposal.source === "generated") {
      deps.logger?.warn("scene_generation_rejected", { code: approvedGenerated.code });
    }
    if (!immediateAction
      && proposal.source === "generated"
      && context.repairAttempt === undefined
      && proposal.contentRepairAttempt === undefined) {
      const repairContext = {
        ...context,
        repairAttempt: { attempt: 1, reason: `approval:${approvedGenerated.code}` },
      };
      try {
        deps.logger?.warn("scene_generation_content_retry", {
          reason: `approval:${approvedGenerated.code}`,
          attempt: 1,
        });
        const repairedResult = await deps.sceneSource.generateScene(repairContext);
        if (repairedResult.ok && repairedResult.proposal.source === "generated") {
          const repairedProposal = repairedResult.proposal;
          const repairedApproval = approveScenePerformance({
            context: repairContext,
            proposal: repairedProposal,
            basedOnRevision: record.revision + 1,
            existingCandidateEventPool: record.storyState.candidateEventPool,
            logger: deps.logger,
          });
          if (repairedApproval.ok) {
            approved = repairedApproval;
            for (const code of repairedApproval.qualityWarnings) {
              deps.logger?.warn("scene_quality_warning", { code });
            }
          } else {
            deps.logger?.warn("scene_generation_retry_rejected", { code: repairedApproval.code });
          }
        }
      } catch {
        deps.logger?.warn("scene_generation_retry_failed", { reason: approvedGenerated.code });
      }
    }

    if (approved === null) {
      return fail(sceneFailure("AI_RESPONSE_INVALID"));
    }
  }

  const pendingRuntime = scenarioSs.narrative;
  if (pendingRuntime.status !== "provider_pending") {
    return fail(sceneFailure("AI_RESPONSE_INVALID"));
  }

  const writeBack = await deps.repository.applySceneWriteBack({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState: scenarioWs,
    nextStoryState: {
      ...scenarioSs,
      narrative: {
        status: "ready",
        mode: pendingRuntime.mode,
        currentScene: approved.scene,
        choiceRegistry: approved.choiceRegistry,
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
