import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { SceneSource, ScenePerformanceProposal } from "./sceneSource";
import { buildSceneGenerationContext } from "./sceneGenerationContext";
import { approveScenePerformance, type ApprovedSceneWriteBack } from "./approveAndWriteScene";
import { buildSelectableSceneCandidates, createDeterministicSceneSource } from "./deterministicSceneSource";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { evolveWorld } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { GameLogger } from "@/game/logging";
import type { LinearActionNarrativeState } from "@/game/domain/narrative";
import type { StructuredActionSummary } from "@/game/domain/pendingNarrativeJob";

export type GeneratePendingSceneDeps = {
  readonly repository: GameRepository;
  readonly sceneSource: SceneSource;
  /** Task 3：场景编排联动的世界演化源（幕推进/结局对时装配预览状态后再出场景）。 */
  readonly worldEvolutionSource?: WorldEvolutionSource;
  /** 生成提案经审批被拒时记录稳定原因，不能让 fallback 伪装成 AI 成功。 */
  readonly logger?: GameLogger;
  /** live 生产路径禁止把设计 AI 的失败静默写成确定性场景。 */
  readonly allowDeterministicFallback?: boolean;
  readonly now: () => string;
};

export type GeneratePendingSceneResult =
  | "saved"
  | "not_pending"
  | "stale"
  | "unavailable"
  | "legacy_pending";

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

  // Task 3：场景编排同样可能挂着演化需求（幕推进/结局对）。
  // 先把 delta 装配为预览记录（只读预览，不落库），再以预览世界/故事状态出场景，
  // 最后经 applySceneWriteBack 单次 CAS 一并写回实体与场景。
  let scenarioWs = record.worldState;
  let scenarioSs = record.storyState;
  const summary = generation.job.actionSummary;
  // 单线调查与移动/拾取同为规则已完全确定的即时反馈；但幕推进/结局对
  // 挂起时必须保留完整演化编排，不能被 fast path 短路。
  const immediateAction = (summary.kind === "move"
    || summary.kind === "take_item"
    || summary.kind === "investigate")
    && record.storyState.evolution.status !== "needs_next_act"
    && record.storyState.evolution.status !== "needs_ending_pair";
  // 移动落点和拾取结果都已由规则回合完全确定。它们是单动作反馈，不需要
  // 再调用 live 世界/场景源；直接用确定性场景完成 write-back，避免玩家在
  // 已经完成动作后等待“编排下一幕”。若确实候选不足，下面的受控补足分支
  // 仍会兜底。
  const need = immediateAction
    ? { kind: "none" as const }
    : deriveEvolutionNeed(record.worldState, record.storyState);
  // 未注入演化源时不主动演化：保持既有时景写回行为，仅当配置了 source 才装配预览。
  if (need.kind !== "none" && deps.worldEvolutionSource !== undefined) {
    const outcome = await evolveWorld({
      need,
      worldState: record.worldState,
      storyState: record.storyState,
      source: deps.worldEvolutionSource,
      allowDeterministicFallback: deps.allowDeterministicFallback === true,
      reason: "scene_evolution",
      now: deps.now,
    });
    if (outcome.ok) {
      scenarioWs = outcome.delta.previewWorldState;
      scenarioSs = outcome.delta.previewStoryState;
    }
  }

  let scenarioRecord: GameRecord = {
    ...record,
    worldState: scenarioWs,
    storyState: scenarioSs,
  };

  // Task 3：单线调查/移动优先消费上一次场景写回时 AI 预生成的权威叙事
  // （actionKind + 实体 ID 精确匹配）；未命中才走确定性兜底（消费即除）。
  const consumeEntry = immediateAction
    ? findMatchingQueueEntry(scenarioSs.narrative.linearNarrativeQueue, summary)
    : undefined;

  let context = buildSceneGenerationContext(scenarioRecord);

  // ready scene 必须有两个语义不同的合法选择。若当前世界只有一个候选，
  // 不让生成任务永久 pending，也不在客户端伪造按钮；通过同一世界演化审批、
  // 预算和 ID 铸造链补足可达内容，再基于批准后的预览状态生成场景。
  if (buildSelectableSceneCandidates(context).length < 2 && deps.worldEvolutionSource !== undefined) {
    const recovery = await evolveWorld({
      need: { kind: "pacing", pacingNeed: "complicate" },
      worldState: scenarioWs,
      storyState: scenarioSs,
      source: deps.worldEvolutionSource,
      allowDeterministicFallback: deps.allowDeterministicFallback === true,
      reason: "scene_candidate_shortage",
      now: deps.now,
    });
    if (recovery.ok) {
      scenarioWs = recovery.delta.previewWorldState;
      scenarioSs = recovery.delta.previewStoryState;
      scenarioRecord = {
        ...record,
        worldState: scenarioWs,
        storyState: scenarioSs,
      };
      context = buildSceneGenerationContext(scenarioRecord);
    }
  }

  if (buildSelectableSceneCandidates(context).length < 2) return "unavailable";

  // 物品拾取与移动一样，当前地点、物品事实和可达候选都由规则结果确定，
  // 使用同一审批链上的确定性即时场景；对话、探索等仍使用配置的 source。
  const source = immediateAction
    ? createDeterministicSceneSource()
    : deps.sceneSource;

  let proposal: ScenePerformanceProposal;
  try {
    proposal = await source.generateScene(context);
    if (consumeEntry !== undefined) {
      // 命中的预生成叙事已在写入时通过审批：以其正文覆盖确定性旁白首段，
      // 场景其余结构（节拍覆盖/选项/目标链接/事件）仍走同一审批链。
      proposal = {
        ...proposal,
        segments: proposal.segments.map((segment, index) =>
          index === 0 ? { ...segment, text: consumeEntry.narration } : segment),
        source: "generated",
      };
    }
  } catch {
    return "unavailable";
  }

  // 预生成叙事未命中时记录稳定失败码（确定性兜底不伪装成 AI 成功）。
  if (immediateAction && consumeEntry === undefined
    && (summary.kind === "investigate" || summary.kind === "move")) {
    deps.logger?.warn("linear_narrative_fallback", {
      actionKind: summary.kind,
      entityId: summary.kind === "investigate" ? String(summary.factId) : String(summary.locationId),
    });
  }

  // 移动/拾取是规则已完全确定的即时反馈，允许使用确定性场景；其余
  // 设计性场景在 live 运行时必须能证明 proposal 来自真实 API。
  if (!immediateAction && deps.allowDeterministicFallback === false && proposal.source !== "generated") {
    deps.logger?.warn("scene_generation_fallback_blocked", { reason: "live_required" });
    return "unavailable";
  }

  // 完整场景表演审批（Task 6）：核心结构非法（缺强制节拍/自创节拍 ID/
  // 错误 NPC 应答/forbidden fact/他人交互/过期目标/重复选项/无推进选项）时，
  // 先给 generated proposal 一次带拒绝码的内容修复机会；修复仍失败才
  // 回退确定性 source，且 fallback 同样过同一审批，防止两套契约漂移。
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
        const repairedProposal = await source.generateScene(repairContext);
        if (repairedProposal.source === "generated") {
          const repairedApproval = approveScenePerformance({
            context: repairContext,
            proposal: repairedProposal,
            basedOnRevision: record.revision + 1,
            existingCandidateEventPool: record.storyState.candidateEventPool,
            logger: deps.logger,
          });
          if (repairedApproval.ok) {
            approved = repairedApproval;
          } else {
            deps.logger?.warn("scene_generation_retry_rejected", { code: repairedApproval.code });
          }
        } else {
          deps.logger?.warn("scene_generation_retry_fallback", { reason: approvedGenerated.code });
        }
      } catch {
        deps.logger?.warn("scene_generation_retry_failed", { reason: approvedGenerated.code });
      }
    }

    if (approved === null) {
      if (!immediateAction && deps.allowDeterministicFallback === false) {
        deps.logger?.warn("scene_generation_fallback_blocked", { reason: approvedGenerated.code });
        return "unavailable";
      }
      try {
        const fallbackProposal = await createDeterministicSceneSource().generateScene(context);
        const approvedFallback = approveScenePerformance({
          context,
          proposal: fallbackProposal,
          basedOnRevision: record.revision + 1,
          existingCandidateEventPool: record.storyState.candidateEventPool,
          logger: deps.logger,
        });
        if (!approvedFallback.ok) return "unavailable";
        approved = approvedFallback;
      } catch {
        return "unavailable";
      }
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
        // Task 3：命中的预生成条目消费即除；未命中/非 immediate 路径沿用
        // 审批队列（确定性提案不携带预生成叙事 → 覆盖为空数组，保持 Task 2 语义）。
        linearNarrativeQueue: consumeEntry === undefined
          ? approved.linearNarrativeQueue
          : (scenarioSs.narrative.linearNarrativeQueue ?? []).filter((entry) => entry !== consumeEntry),
      },
      candidateEventPool: approved.candidateEventPool,
    },
  });

  if (!writeBack.ok) {
    return writeBack.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  }

  return "saved";
}

/**
 * 在 AI 预生成叙事队列中查找与 actionSummary 实体精确匹配的条目
 * （investigate→factId，move→locationId）；take_item 等无队列形态。
 * 返回原数组引用，消费时按引用移除恰好一条。
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
