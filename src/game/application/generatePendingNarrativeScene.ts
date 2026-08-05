import type { GameRepository } from "./server/persistence/gameRepository";
import type { GameLogger } from "@/game/logging";
import type { GameState, ScenarioBlueprint } from "@/game/domain";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import { applyEndingToBlueprint, compileBlueprintExpansion } from "@/game/gameplay/rpg/narrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";
import { reconcileStoryMemory } from "@/game/gameplay/rpg/narrative";
import type { StoryEvalApprovalEvent } from "./storyEvalCaptureTypes";

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
  traceId?: string;
  /** Task 5：审批观察回调——透传给编排层。 */
  approvalObserver?: (event: StoryEvalApprovalEvent) => void;
  /** 评估专用重试上限；未传时保持正常运行时的三次尝试。 */
  maxRoleAttempts?: number;
  /** 评估专用 provider 失败退避；未传时保持正常运行时零额外等待。 */
  retryBackoffMs?: number;
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

  const traceId = deps.traceId ?? deps.newTraceId();
  const generated = await orchestrateNarrativeScene({
    traceId,
    blueprint: record.blueprint,
    state: record.state,
    ...deps.runtimeNarrativeSources,
    logger: deps.logger,
    approvalObserver: deps.approvalObserver,
    maxRoleAttempts: deps.maxRoleAttempts,
    retryBackoffMs: deps.retryBackoffMs,
  });
  const scene = generated.scene;
  deps.logger?.info("runtime_narrative_generation", {
    traceId,
    scope: "request",
    source: "rpg.application.generate_pending_narrative_scene",
    gameId: String(record.gameId),
    sceneId: scene.sceneId,
    provenance: generated.provenance,
    expansionApproved: generated.expansionDecision.ok
  });
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
  // 蓝图动态化：审批通过的扩展与场景同一次 CAS 落库；否则仅写场景。
  // Phase 14：审批通过的结局也并入同一次 CAS——blueprint.endings 追加
  // approvedEnding，state.mainStoryProgress.endingProposed 置 true。扩展与
  // 结局可能同时发生，统一构造 nextBlueprint + finalState 后走 applyBlueprintExpansion。
  const expansionApproved = generated.expansionDecision.ok;
  const endingApproved = generated.endingDecision?.ok === true;
  let nextBlueprint: ScenarioBlueprint = record.blueprint;
  let finalState: GameState = nextState;
  if (expansionApproved) {
    const compiled = compileBlueprintExpansion({
      blueprint: record.blueprint,
      state: nextState,
      expansion: generated.expansionDecision.expansion,
      occurredAt: deps.now(),
    });
    nextBlueprint = compiled.nextBlueprint;
    finalState = compiled.nextState;
  }
  if (endingApproved) {
    // approvedEnding.id 已在 orchestrateNarrativeScene 基于 record.blueprint.endings 铸造；
    // 扩展不修改 endings[]，故 id 在扩展后的 nextBlueprint 上仍唯一。
    nextBlueprint = applyEndingToBlueprint({
      blueprint: nextBlueprint,
      approvedEnding: generated.endingDecision.approvedEnding,
    });
    finalState = {
      ...finalState,
      mainStoryProgress: {
        ...finalState.mainStoryProgress,
        endingProposed: true,
      },
    };
  }
  const saved = (expansionApproved || endingApproved)
    ? await deps.repository.applyBlueprintExpansion({
        gameId: record.gameId,
        expectedRevision: record.revision,
        nextBlueprint,
        nextState: finalState,
      })
    : await deps.repository.applyResolvedAction({
        gameId: record.gameId,
        expectedRevision: record.revision,
        nextState: finalState,
      });
  if (!saved.ok) return saved.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  return "saved";
}
