import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { SceneSource, SceneSourceResult } from "./sceneSource";
import { buildSceneGenerationContext } from "./sceneGenerationContext";
import { approveSceneEventProposals, approveScenePackage } from "./approveAndWriteScene";
import { createDeterministicSceneSource } from "./deterministicSceneSource";

export type GeneratePendingSceneV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly sceneSource: SceneSource;
  readonly now: () => string;
};

export type GeneratePendingSceneV2Result =
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
export async function generatePendingSceneV2(
  deps: GeneratePendingSceneV2Deps,
): Promise<GeneratePendingSceneV2Result> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";

  const { record } = loaded;
  const generation = record.storyState.narrative.generation;
  if (generation.status !== "pending") return "not_pending";

  // 运行期守卫：旧开发存档的 pending 可能没有 job（如 {status:"pending", requestedAt}）。
  // 稳定分类为 legacy_pending，绝不伪装成功恢复。
  if (!("job" in generation) || generation.job === undefined) return "legacy_pending";

  const context = buildSceneGenerationContext(record);

  let result: SceneSourceResult;
  try {
    result = await deps.sceneSource.generateScene(context);
  } catch {
    return "unavailable";
  }

  // 完整场景包审批（Task 25）：核心结构非法（旁空/未知台词NPC/forbidden fact/
  // 选项重复/选项目标非法）→ 整场回退确定性 source，且 fallback 同样过审批，
  // 防止两套契约漂移。
  let scene = result.scene;
  const approvedScene = approveScenePackage({ context, scene });
  if (!approvedScene.ok) {
    const fallbackResult = await createDeterministicSceneSource().generateScene(context);
    const approvedFallback = approveScenePackage({ context, scene: fallbackResult.scene });
    if (!approvedFallback.ok) return "unavailable";
    scene = approvedFallback.scene;
  }

  // 候选事件审批：schema 解析 + 去重 + FIFO 上限，非法/path patch 候选丢弃不拖垮场景。
  const approved = approveSceneEventProposals({
    existingPool: record.storyState.candidateEventPool,
    proposals: result.eventProposals,
  });
  if (!approved.ok) return "unavailable";

  const writeBack = await deps.repository.applySceneWriteBack({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextNarrative: {
      ...record.storyState.narrative,
      currentScene: scene,
      generation: { status: "idle" },
    },
    nextCandidateEventPool: approved.nextCandidateEventPool,
  });

  if (!writeBack.ok) {
    return writeBack.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  }

  return "saved";
}