import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { SceneSource, ScenePerformanceProposal } from "./sceneSource";
import { buildSceneGenerationContext } from "./sceneGenerationContext";
import { approveScenePerformance, type ApprovedSceneWriteBack } from "./approveAndWriteScene";
import { buildSelectableSceneCandidates, createDeterministicSceneSource } from "./deterministicSceneSource";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { evolveWorld } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";

export type GeneratePendingSceneDeps = {
  readonly repository: GameRepository;
  readonly sceneSource: SceneSource;
  /** Task 3：场景编排联动的世界演化源（幕推进/结局对时装配预览状态后再出场景）。 */
  readonly worldEvolutionSource?: WorldEvolutionSource;
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
  const immediateMove = generation.job.actionSummary.kind === "move";
  // 移动落点的地点、当前目标和可达候选已由刚提交的规则结果确定。此处不再
  // 为一键移动额外触发 live 世界演化；若确实候选不足，下面的受控补足分支
  // 仍会兜底。这样同步落点写回不会被与移动无关的 AI 调用拖慢。
  const need = immediateMove
    ? { kind: "none" as const }
    : deriveEvolutionNeed(record.worldState, record.storyState);
  // 未注入演化源时不主动演化：保持既有时景写回行为，仅当配置了 source 才装配预览。
  if (need.kind !== "none" && deps.worldEvolutionSource !== undefined) {
    const outcome = await evolveWorld({
      need,
      worldState: record.worldState,
      storyState: record.storyState,
      source: deps.worldEvolutionSource,
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

  // 目的地已经由刚刚提交并裁决的 move Action 唯一确定。此时若再等待 live
  // 表演源，玩家会在一次没有决策的移动后看见不必要的加载页。移动落点改走
  // 同一审批链上的确定性即时场景：地点、目标和候选仍来自本回合后的权威状态，
  // 只是不会为一键移动增加一次外部生成等待。对话、探索等仍使用配置的 source。
  const source = immediateMove
    ? createDeterministicSceneSource()
    : deps.sceneSource;

  let proposal: ScenePerformanceProposal;
  try {
    proposal = await source.generateScene(context);
  } catch {
    return "unavailable";
  }

  // 完整场景表演审批（Task 6）：核心结构非法（缺强制节拍/自创节拍 ID/
  // 错误 NPC 应答/forbidden fact/他人交互/过期目标/重复选项/无推进选项）→
  // 整场回退确定性 source，且 fallback 同样过同一审批，防止两套契约漂移。
  let approved: ApprovedSceneWriteBack | null = null;
  const approvedGenerated = approveScenePerformance({
    context,
    proposal,
    basedOnRevision: record.revision + 1,
    existingCandidateEventPool: record.storyState.candidateEventPool,
  });
  if (approvedGenerated.ok) {
    approved = approvedGenerated;
  } else {
    try {
      const fallbackProposal = await createDeterministicSceneSource().generateScene(context);
      const approvedFallback = approveScenePerformance({
        context,
        proposal: fallbackProposal,
        basedOnRevision: record.revision + 1,
        existingCandidateEventPool: record.storyState.candidateEventPool,
      });
      if (!approvedFallback.ok) return "unavailable";
      approved = approvedFallback;
    } catch {
      return "unavailable";
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
      },
      candidateEventPool: approved.candidateEventPool,
    },
  });

  if (!writeBack.ok) {
    return writeBack.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  }

  return "saved";
}
