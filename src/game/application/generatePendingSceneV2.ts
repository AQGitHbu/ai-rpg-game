import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { SceneSource } from "./sceneSource";
import { buildSceneGenerationContext } from "./sceneGenerationContext";

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

  let result;
  try {
    result = await deps.sceneSource.generateScene(context);
  } catch {
    return "unavailable";
  }

  const writeBack = await deps.repository.applySceneWriteBack({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextNarrative: {
      ...record.storyState.narrative,
      currentScene: result.scene,
      generation: { status: "idle" },
    },
    nextCandidateEventPool: [
      ...record.storyState.candidateEventPool,
      ...result.eventProposals.map((p) => ({
        id: p.id,
        description: p.description,
        proposedAtTurn: p.proposedAtTurn,
      })),
    ].slice(-8), // FIFO max 8
  });

  if (!writeBack.ok) {
    return writeBack.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  }

  return "saved";
}