import type { GameRepository } from "./server/persistence/gameRepository";
import type { GameLogger } from "@/game/logging";
import type { GameState } from "@/game/domain";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";
import { reconcileStoryMemory } from "@/game/gameplay/rpg/narrative";

export type GeneratePendingNarrativeSceneDependencies = Readonly<{
  repository: GameRepository;
  newTraceId: () => string;
  /** 场景提交时刻：由 application/server 注入，不能复用 pending 请求时刻。 */
  now: () => string;
  runtimeNarrativeSources: Readonly<{
    directorSource: DirectorSource;
    sceneScriptSource: SceneScriptSource;
    npcLineSource: NpcLineSource;
  }>;
  logger?: GameLogger;
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
    logger: deps.logger,
  });
  const scene = generated.scene;
  // Phase 11：场景应用时提交一条 narrative_scene_presented 事件——只携带结构索引
  // （场景 ID、当前地点、焦点 NPC、已呈现的已发现事实、节奏标签、注入时间戳），
  // 绝不携带 narration、对白、choiceToken、actionKey 或 AI provenance。
  // pacing 取自导演受批准的 plan.pacing（经 orchestrateNarrativeScene 转发；
  // fallback 场景为内容推进器按当前主线阶段派生的受控值）。
  const presentedEvent = {
    type: "narrative_scene_presented" as const,
    sceneId: scene.sceneId,
    locationId: record.state.currentLocationId,
    focusNpcId: generated.focusNpcId,
    revealedFactIds: scene.usedFactIds,
    pacing: generated.pacing,
    occurredAt: deps.now()
  };
  let nextState: GameState = {
    ...record.state,
    eventLedger: [...record.state.eventLedger, presentedEvent],
    narrative: {
      currentScene: scene,
      generation: { status: "idle" },
      mode: record.state.narrative.mode,
    },
  };
  // 同一 CAS 写入前同步归约 memory：场景提交事件与既有事件一并进入 recent。
  nextState = {
    ...nextState,
    storyMemory: reconcileStoryMemory({ state: nextState })
  };
  const saved = await deps.repository.applyResolvedAction({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextState
  });
  if (!saved.ok) return saved.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  return "saved";
}
