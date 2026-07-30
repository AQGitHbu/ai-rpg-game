import type { GameRepository } from "./server/persistence/gameRepository";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";

export type GeneratePendingNarrativeSceneDependencies = Readonly<{
  repository: GameRepository;
  newTraceId: () => string;
  runtimeNarrativeSources: Readonly<{
    directorSource: DirectorSource;
    sceneScriptSource: SceneScriptSource;
    npcLineSource: NpcLineSource;
  }>;
}>;

export type GeneratePendingNarrativeSceneResult =
  | "saved"
  | "not_pending"
  | "cleared"
  | "stale"
  | "unavailable";

/**
 * Executes one durable pending narrative request. It intentionally owns no
 * process-local scheduling; callers may safely retry it after a restart.
 */
export async function generatePendingNarrativeScene(
  deps: GeneratePendingNarrativeSceneDependencies,
): Promise<GeneratePendingNarrativeSceneResult> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";
  const { record } = loaded;
  if (
    record.state.narrative.generation.status !== "pending" ||
    record.state.narrative.currentScene !== null ||
    record.state.ending !== null ||
    record.state.battle.status === "active"
  ) {
    return "not_pending";
  }

  // An older save or a concurrently evolved ruleset may leave a pending
  // marker after fewer than two actions remain. Clear only the marker; never
  // ask AI to invent a second option.
  if (!canQueueRuntimeNarrativeScene(record.blueprint, record.state)) {
    const cleared = await deps.repository.applyResolvedAction({
      gameId: record.gameId,
      expectedRevision: record.revision,
      nextState: {
        ...record.state,
        narrative: { ...record.state.narrative, currentScene: null, generation: { status: "idle" } },
      },
    });
    if (!cleared.ok) return cleared.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
    return "cleared";
  }

  const generated = await orchestrateNarrativeScene({
    traceId: deps.newTraceId(),
    blueprint: record.blueprint,
    state: record.state,
    ...deps.runtimeNarrativeSources,
  });
  const saved = await deps.repository.applyResolvedAction({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextState: {
      ...record.state,
      narrative: {
        currentScene: generated.scene,
        generation: { status: "idle" },
        mode: record.state.narrative.mode,
      },
    },
  });
  if (!saved.ok) return saved.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  return "saved";
}
