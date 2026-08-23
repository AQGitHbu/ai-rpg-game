import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { AiTextAuditRecorder, AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { LinearActionNarrative, SceneSource, ScenePerformanceProposal } from "./sceneSource";
import { sceneInvestigationResultFrom } from "./sceneSource";
import { buildSceneGenerationContext } from "./sceneGenerationContext";
import {
  approveLinearActionNarratives,
  approveScenePerformance,
  type ApprovedSceneWriteBack,
} from "./approveAndWriteScene";
import { buildSelectableSceneCandidates, buildSceneChoices, buildInvestigationOutcomeNarrative } from "./deterministicSceneSource";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { evolveWorld } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { GameLogger } from "@/game/logging";
import type { LinearActionNarrativeState } from "@/game/domain/narrative";
import type { StructuredActionSummary } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
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
  | "unavailable"
  | "legacy_pending";

/**
 * 单线叙事来源标记，仅用于 server logger 的结构化字段，不持久化到
 * StoryState / GameSessionView 或审计正文。
 */
export type NarrativeGenerationPath = "pre_generated_queue" | "live_scene";

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
 * 已审批的 linearNarrativeQueue 命中时，正文已经由 live AI 生成并通过审批；
 * 这里只补齐场景契约所需的节拍、目标链接和权威候选，不创建另一份 scene source。
 */
function buildQueuedGeneratedSceneProposal(
  context: ReturnType<typeof buildAuditedSceneGenerationContext>,
  narration: string,
  arrivalNpcLine?: Extract<LinearActionNarrativeState, { readonly actionKind: "move" }>["arrivalNpcLine"],
  queuedNarratives: readonly LinearActionNarrative[] = [],
): ScenePerformanceProposal {
  const beatIds = context.mandatoryBeats.length > 0
    ? context.mandatoryBeats.map((beat) => beat.beatId)
    : [ATMOSPHERE_BEAT_ID];
  if (buildSelectableSceneCandidates(context, arrivalNpcLine?.text).length < 2) {
    throw new Error("queued generated scene requires two legal candidates");
  }
  const after = context.objectiveTransition.after;
  const objectiveLink: ScenePerformanceProposal["objectiveLink"] = after === null
    ? null
    : {
        questId: String(after.questId),
        objectiveIndex: after.objectiveIndex,
        mode: context.objectiveTransition.mode === "advanced_act"
          ? "handoff"
          : context.objectiveTransition.mode === "progressed"
            ? "progress"
            : "hint",
      };
  const generatedArrivalNpcLine = arrivalNpcLine === undefined
    ? null
    : {
        npcId: String(arrivalNpcLine.npcId),
        text: arrivalNpcLine.text,
        emotion: arrivalNpcLine.emotion,
        answeredBeatIds: [],
        usedFactIds: arrivalNpcLine.usedFactIds.map(String),
        usedInteractionActionIds: [],
      };
  return {
    sceneId: `scene-${context.job.jobId}`,
    segments: beatIds.map((beatId) => ({ beatId, text: narration })),
    npcLine: generatedArrivalNpcLine,
    objectiveLink,
    choices: buildSceneChoices(context, generatedArrivalNpcLine?.text),
    ...(queuedNarratives.length === 0 ? {} : { linearActionNarratives: queuedNarratives }),
    source: "generated",
  };
}

function queuedStateToProposalNarrative(entry: LinearActionNarrativeState): LinearActionNarrative {
  if (entry.actionKind === "investigate") {
    return {
      actionKind: "investigate",
      factId: String(entry.factId),
      narration: entry.narration,
    };
  }
  return {
    actionKind: "move",
    locationId: String(entry.locationId),
    narration: entry.narration,
    ...(entry.arrivalNpcLine === undefined ? {} : {
      arrivalNpcLine: {
        npcId: String(entry.arrivalNpcLine.npcId),
        text: entry.arrivalNpcLine.text,
        emotion: entry.arrivalNpcLine.emotion,
        usedFactIds: entry.arrivalNpcLine.usedFactIds.map(String),
      },
    }),
  };
}

/**
 * 执行一个 pending 叙事场景请求（spec §7 + §11）。
 * 读 pending job → buildSceneGenerationContext → 调 SceneSource → 写回 idle。
 * 不再伪造 ResolvedEvent：source 只接收 job 驱动的上下文。
 */
export async function generatePendingScene(
  deps: GeneratePendingSceneDeps,
): Promise<GeneratePendingSceneResult> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";

  const { record } = loaded;
  const generation = record.storyState.narrative.generation;
  if (generation.status !== "pending") return "not_pending";

  // 运行期守卫：旧开发存档的 pending 可能没有 job（如 {status:"pending", requestedAt}）。
  // 稳定分类为 legacy_pending，绝不伪装成功恢复。
  if (!("job" in generation) || generation.job === undefined) return "legacy_pending";

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
  // take_item 是规则已确定的即时动作但不参与队列匹配（无预生成叙事）。
  // 只有 move/investigate 且演化未挂起时，才可能命中已审批预生成队列。
  const isQueueEligible = !evolutionBlocksImmediatePath
    && (summary.kind === "move" || summary.kind === "investigate");
  // 在任何 derivedNeed 计算/初始世界演化/scene_candidate_shortage 补救之前，
  // 直接从当前权威 record 查找预生成叙事；命中即跳过全部演化编排，绝不再
  // 为了补足候选调用 world/scene AI。后续消费统一沿用本次查找的 queuedEntry。
  const matchingQueueEntry = isQueueEligible
    ? findMatchingQueueEntry(record.storyState.narrative.linearNarrativeQueue, summary)
    : undefined;
  const queuedEntry = matchingQueueEntry !== undefined && !queueEntryHasArrivalNpcDialogue(record, matchingQueueEntry)
    ? undefined
    : matchingQueueEntry;
  if (matchingQueueEntry !== undefined && queuedEntry === undefined) {
    deps.logger?.warn("narrative_queue_incomplete", { reason: "missing_arrival_npc_dialogue" });
  }
  const hasPreGeneratedNarrative = queuedEntry !== undefined;
  const generationPath: NarrativeGenerationPath = hasPreGeneratedNarrative
    ? "pre_generated_queue"
    : "live_scene";
  // 移动落点和拾取结果都已由规则回合完全确定，但 AI mode 仍须由 live scene
  // source 提供表现；只有命中已审批队列或显式 offline fixture 才不发起 live
  // 调用。队列命中的正文已由 live AI 预生成并通过审批，世界无需再次演化。
  // AI 失败必须进入 failed，不改写为确定性成功。
  const derivedNeed = hasPreGeneratedNarrative
    ? { kind: "none" as const }
    : immediateAction
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

  // 队列命中不许进入世界演化补救：候选不足属于坏存档，必须无 AI 地稳定失败，
  // 且这种存档不一致异常不应落入下方通用 provider 异常分支被误报成 AI_CALL_FAILED。
  if (hasPreGeneratedNarrative) {
    if (buildSelectableSceneCandidates(context).length < 2) {
      deps.logger?.warn("world_state_inconsistent", {});
      return fail(sceneFailure("AI_RESPONSE_INVALID"));
    }
    deps.logger?.info("narrative_queue_hit", { generationPath });
  } else {
    // ready scene 必须有两个语义不同的合法选择。若当前世界只有一个候选，
    // 不让生成任务永久 pending，也不在客户端伪造按钮；生产链将候选不足视为
    // AI/审批失败，显式 offline fixture 才能注入演化 source 补足测试旅程。
    if (buildSelectableSceneCandidates(context).length < 2) {
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
    if (buildSelectableSceneCandidates(context).length < 2) return fail(sceneFailure("AI_RESPONSE_INVALID"));
    // 仅 move/investigate 的未命中记录 miss；take_item 等其余即时路径不参与队列。
    if (isQueueEligible) {
      deps.logger?.info("narrative_queue_miss", { generationPath });
    }
  }

  let proposal: ScenePerformanceProposal;
  try {
    if (queuedEntry !== undefined) {
      // 命中的预生成叙事已在写入时通过审批：以其正文作为场景唯一正文来源，
      // 场景其余结构（节拍覆盖/选项/目标链接/事件）仍走同一审批链。
      // Task 5：已结算的 investigate 结果把队列叙事作为 baseNarrative，
      // 叠加所选方式/证据质量/下一目标（与确定性节拍同一包装函数）；
      // 不得在场景写回阶段再次修改事件账本或 tension。
      proposal = buildQueuedGeneratedSceneProposal(
        context,
        queuedEntry.narration,
        queuedEntry.actionKind === "move" ? queuedEntry.arrivalNpcLine : undefined,
        (record.storyState.narrative.linearNarrativeQueue ?? [])
          .filter((entry) => entry !== queuedEntry)
          .map(queuedStateToProposalNarrative),
      );
      const investigationBeatId = context.mandatoryBeats.find((beat) => beat.kind === "fact_discovered")?.beatId;
      proposal = {
        ...proposal,
        segments: proposal.segments.map((segment, index) => {
          if (summary.kind === "investigate" && context.resolvedInvestigation !== undefined) {
            if (investigationBeatId !== undefined && segment.beatId !== investigationBeatId) return segment;
            if (investigationBeatId === undefined && index !== 0) return segment;
            const resolved = context.resolvedInvestigation;
            const fact = scenarioWs.worldFacts.find((entry) => String(entry.factId) === String(summary.factId));
            return {
              ...segment,
              text: buildInvestigationOutcomeNarrative({
                approachLabel: resolved.approachLabel,
                evidenceQuality: resolved.evidenceQuality,
                factText: fact?.text ?? "",
                baseNarrative: queuedEntry.narration,
                ...(context.objectiveTarget === null ? {} : { nextObjectiveLabel: context.objectiveTarget.entityName }),
              }),
            };
          }
          return { ...segment, text: queuedEntry.narration };
        }),
        source: "generated",
      };
    } else {
      const sceneResult = await deps.sceneSource.generateScene(context);
      if (!sceneResult.ok) return fail({ ...sceneResult.failure, phase: "scene", failedAt: deps.now() });
      proposal = sceneResult.proposal;
    }
  } catch {
    // 队列命中分支只做纯本地合成：候选已在 try 外校验，唯一可能抛出的存档问题
    // 属于状态不一致而非 provider 失败，绝不能误报成 AI_CALL_FAILED。
    if (hasPreGeneratedNarrative) {
      deps.logger?.warn("world_state_inconsistent", {});
      return fail(sceneFailure("AI_RESPONSE_INVALID"));
    }
    return fail(sceneFailure("AI_CALL_FAILED"));
  }

  // Task 5：已结算调查结果的叙事上下文随提案携带（覆盖确定性/live/stub 各来源）。
  const investigationResult = sceneInvestigationResultFrom(context);
  if (investigationResult !== undefined) {
    proposal = { ...proposal, investigationResult };
  }

  // 单线行动叙事是独立的可选产物：先从原始 generated proposal 中审批并
  // 暂存，不能等到整场 scene approval 成功后才提取。否则本轮只要 NPC/节拍/
  // 选项任一硬校验失败，不能连带抹掉本来合法的未来叙事；但核心场景仍须
  // 通过 live 内容修复，否则整个 pending job 进入 failed。
  let retainedLinearNarrativeQueue = proposal.source === "generated"
    ? approveLinearActionNarratives(proposal, context, undefined)
    : [];

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
    retainedLinearNarrativeQueue = approvedGenerated.linearNarrativeQueue;
    for (const code of approvedGenerated.qualityWarnings) {
      deps.logger?.warn("scene_quality_warning", { code });
    }
  } else {
    // 主场景被拒时，补发一次线性字段的可观测性校验；它不参与主场景
    // 的拒绝码，也不影响已暂存的合法队列。
    if (proposal.source === "generated") {
      approveLinearActionNarratives(proposal, context, deps.logger);
    }
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
          const repairedLinearNarrativeQueue = approveLinearActionNarratives(
            repairedProposal,
            repairContext,
            undefined,
          );
          if (retainedLinearNarrativeQueue.length === 0 && repairedLinearNarrativeQueue.length > 0) {
            retainedLinearNarrativeQueue = repairedLinearNarrativeQueue;
          }
          const repairedApproval = approveScenePerformance({
            context: repairContext,
            proposal: repairedProposal,
            basedOnRevision: record.revision + 1,
            existingCandidateEventPool: record.storyState.candidateEventPool,
            logger: deps.logger,
          });
          if (repairedApproval.ok) {
            approved = repairedApproval;
            retainedLinearNarrativeQueue = repairedApproval.linearNarrativeQueue.length > 0
              ? repairedApproval.linearNarrativeQueue
              : (retainedLinearNarrativeQueue.length > 0
                ? retainedLinearNarrativeQueue
                : repairedLinearNarrativeQueue);
            for (const code of repairedApproval.qualityWarnings) {
              deps.logger?.warn("scene_quality_warning", { code });
            }
          } else {
            approveLinearActionNarratives(repairedProposal, repairContext, deps.logger);
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

  const writeBack = await deps.repository.applySceneWriteBack({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextWorldState: scenarioWs,
    nextStoryState: {
      ...scenarioSs,
      narrative: {
        ...scenarioSs.narrative,
        currentScene: approved.scene,
        generation: { status: "idle" },
        choiceRegistry: approved.choiceRegistry,
        // Task 2：随同一次 scene CAS 覆盖式持久化预生成单线行动叙事；
        // 对话回合与非 immediateAction 路径同样是生成时机，必须一并写回。
        // Task 3：命中的预生成条目消费即除；即时行动未命中时保留其他未来条目，
        // 避免一次确定性兜底把后续 move/investigate 预生成叙事全部清空。
        // 非 immediate 路径仍以本次场景审批结果覆盖队列。
        linearNarrativeQueue: immediateAction
          ? (matchingQueueEntry === undefined
            ? (scenarioSs.narrative.linearNarrativeQueue ?? [])
            : removeMatchingQueueEntry(scenarioSs.narrative.linearNarrativeQueue, summary))
          : approved.linearNarrativeQueue,
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

/**
 * （investigate→factId，move→locationId）；take_item 等无队列形态。
 * 返回命中的条目；消费时使用 actionKind + 实体 ID 稳定匹配移除恰好一条。
 */
function findMatchingQueueEntry(
  queue: readonly LinearActionNarrativeState[] | undefined,
  summary: StructuredActionSummary,
): LinearActionNarrativeState | undefined {
  if (summary.kind === "investigate") {
    return (queue ?? []).find(
      (entry) => entry.actionKind === "investigate" && String(entry.factId) === String(summary.factId),
    );
  }
  if (summary.kind === "move") {
    return (queue ?? []).find(
      (entry) => entry.actionKind === "move" && String(entry.locationId) === String(summary.locationId),
    );
  }
  return undefined;
}

function queueEntryHasArrivalNpcDialogue(
  record: GameRecord,
  entry: LinearActionNarrativeState,
): boolean {
  if (entry.actionKind !== "move") return true;
  const context = buildSceneGenerationContext(record);
  const targetNpc = context.objectiveTarget === null
    ? undefined
    : context.presentNpcs.find((npc) => String(npc.id) === String(context.objectiveTarget?.entityId));
  return targetNpc === undefined
    || (entry.arrivalNpcLine !== undefined && String(entry.arrivalNpcLine.npcId) === String(targetNpc.id));
}

function removeMatchingQueueEntry(
  queue: readonly LinearActionNarrativeState[] | undefined,
  summary: StructuredActionSummary,
): readonly LinearActionNarrativeState[] {
  let removed = false;
  return (queue ?? []).filter((entry) => {
    if (removed) return true;
    const matches = summary.kind === "investigate"
      ? entry.actionKind === "investigate" && String(entry.factId) === String(summary.factId)
      : summary.kind === "move"
        ? entry.actionKind === "move" && String(entry.locationId) === String(summary.locationId)
        : false;
    if (!matches) return true;
    removed = true;
    return false;
  });
}
