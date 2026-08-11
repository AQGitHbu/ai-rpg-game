import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { SceneSource, ScenePackageProposal } from "./sceneSource";
import { buildSceneGenerationContext } from "./sceneGenerationContext";
import { approveScenePackage, type ApprovedSceneWriteBack } from "./approveAndWriteScene";
import { createDeterministicSceneSource } from "./deterministicSceneSource";
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
  const need = deriveEvolutionNeed(record.worldState, record.storyState);
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

  const scenarioRecord: GameRecord = {
    ...record,
    worldState: scenarioWs,
    storyState: scenarioSs,
  };

  const context = buildSceneGenerationContext(scenarioRecord);

  let proposal: ScenePackageProposal;
  try {
    proposal = await deps.sceneSource.generateScene(context);
  } catch {
    return "unavailable";
  }

  // 完整场景包审批（Task 25）：核心结构非法（旁空/未知台词NPC/forbidden fact/
  // 选项重复/选项目标非法）→ 整场回退确定性 source，且 fallback 同样过审批，
  // 防止两套契约漂移。
  let approved: ApprovedSceneWriteBack | null = null;
  const approvedGenerated = approveScenePackage({
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
      const approvedFallback = approveScenePackage({
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
