import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { SceneSource } from "./sceneSource";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

export type GeneratePendingSceneV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly sceneSource: SceneSource;
  readonly now: () => string;
};

export type GeneratePendingSceneV2Result = "saved" | "not_pending" | "stale" | "unavailable";

/**
 * Executes one pending narrative scene request (spec §7 + §11).
 * Reads pending state → calls SceneSource → writes back via applySceneWriteBack.
 * Only touches storyState.narrative + candidateEventPool.
 */
export async function generatePendingSceneV2(
  deps: GeneratePendingSceneV2Deps,
): Promise<GeneratePendingSceneV2Result> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";

  const { record } = loaded;
  const generation = record.storyState.narrative.generation;
  if (generation.status !== "pending") return "not_pending";

  // Build a minimal ResolvedEvent for the scene source
  const resolvedEvent: ResolvedEvent = {
    actionId: `scene_${record.revision}`,
    status: "success",
    eventKind: "observe",
    facts: [],
    stateChanges: [],
    costs: [],
    rewards: [],
    triggeredEvents: [],
    rejectedEffects: [],
    stateVersion: record.worldState.eventLedger.length,
  };

  const result = await deps.sceneSource.generateScene({
    worldState: record.worldState,
    storyState: record.storyState,
    resolvedEvent,
  });

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
