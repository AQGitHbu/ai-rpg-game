import type { GameRecord, GameRepository } from "./server/persistence/gameRepository";
import type { GameLogger } from "@/game/logging";
import type { GameState, ScenarioBlueprint } from "@/game/domain";
import type { DirectorSource, NpcLineSource, SceneScriptSource, NarrativeGenerationProgress } from "./runtimeNarrative";
import { applyEndingToBlueprint, compileBlueprintExpansion } from "@/game/gameplay/rpg/narrative";
import {
  createDeterministicNarrativeFallback,
  orchestrateNarrativeScene,
  type OrchestrateSceneResult,
} from "./orchestrateNarrativeScene";
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
  /** 生产开局快速路径：初始场景只做一次角色尝试，失败立即使用 fallback。 */
  fastFirstScene?: boolean;
  /** 仅供 server composition root 维护进程内的脱敏生成进度。 */
  progressObserver?: (event: NarrativeProgressEvent) => void;
}>;

export type NarrativeProgressEvent = Readonly<{
  gameId: string;
  status: "running" | "terminal";
  progress?: NarrativeGenerationProgress;
  result?: GeneratePendingNarrativeSceneResult;
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
  const generation = record.state.narrative.generation;
  // A dialogue-response followup keeps the consumed followup as currentScene
  // while the next scene is being assembled (see performAction). That bridge
  // is identifiable by its trigger context; replacing it on completion is the
  // intended continuation. Any other pending-with-scene state is not ours.
  const followupBridgeActive =
    generation.status === "pending" &&
    generation.triggerContext?.kind === "dialogue_response";
  if (
    generation.status !== "pending" ||
    (record.state.narrative.currentScene !== null && !followupBridgeActive) ||
    record.state.ending !== null ||
    record.state.battle.status === "active"
  ) {
    return "not_pending";
  }
  const gameId = String(record.gameId);
  const finish = (result: GeneratePendingNarrativeSceneResult): GeneratePendingNarrativeSceneResult => {
    deps.progressObserver?.({ gameId, status: "terminal", result });
    return result;
  };

  // An older save or a concurrently evolved ruleset may leave a pending
  // marker after fewer than two actions remain. Clear only the marker; never
  // ask AI to invent a second option.
  if (!canQueueRuntimeNarrativeScene(record.blueprint, record.state)) {
    const cleared = await deps.repository.applyResolvedAction({
      gameId: record.gameId,
      expectedRevision: record.revision,
      nextState: {
        ...record.state,
        narrative: { ...record.state.narrative, generation: { status: "idle" } },
      },
    });
    if (!cleared.ok) return finish(cleared.code === "STALE_GAME_REVISION" ? "stale" : "unavailable");
    return finish("cleared");
  }

  const traceId = deps.traceId ?? deps.newTraceId();
  let generated;
  try {
    generated = await orchestrateNarrativeScene({
      traceId,
      blueprint: record.blueprint,
      state: record.state,
      ...deps.runtimeNarrativeSources,
      logger: deps.logger,
      approvalObserver: deps.approvalObserver,
      maxRoleAttempts: deps.maxRoleAttempts,
      retryBackoffMs: deps.retryBackoffMs,
      fastFirstScene: deps.fastFirstScene,
      progressObserver: (progress) => deps.progressObserver?.({ gameId, status: "running", progress }),
    });
  } catch {
    // Provider adapters and legacy saves must not leave the durable pending
    // marker behind. A deterministic scene is still actionable and lets the
    // player continue while the failure remains visible in server logs.
    deps.logger?.error("runtime_narrative_orchestration_failed", {
      traceId,
      scope: "request",
      source: "rpg.application.generate_pending_narrative_scene",
      gameId: String(record.gameId),
    });
    generated = createDeterministicNarrativeFallback({
      traceId,
      blueprint: record.blueprint,
      state: record.state,
    });
  }
  let scene = generated.scene;
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
    scene = remapExpandedScene(scene, compiled);
    finalState = {
      ...finalState,
      narrative: { ...finalState.narrative, currentScene: scene },
    };
  }
  if (generated.endingDecision?.ok === true) {
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
  if (!saved.ok) {
    if (saved.code === "STALE_GAME_REVISION" && !expansionApproved && !endingApproved) {
      const rebased = await rebaseAfterPrologueAck({ deps, original: record, generated, scene });
      if (rebased === "saved") return finish("saved");
      if (rebased === "unavailable") return finish("unavailable");
    }
    return finish(saved.code === "STALE_GAME_REVISION" ? "stale" : "unavailable");
  }
  return finish("saved");
}

/**
 * The prologue acknowledgement is a legitimate concurrent write: it changes
 * only `prologueShown` and does not change the gameplay facts used to compose
 * the first scene.  Reuse the already completed role calls against that
 * latest revision instead of throwing the scene away and making the player
 * wait for another provider round.
 */
async function rebaseAfterPrologueAck(args: {
  readonly deps: GeneratePendingNarrativeSceneDependencies;
  readonly original: GameRecord;
  readonly generated: OrchestrateSceneResult;
  readonly scene: NonNullable<GameState["narrative"]["currentScene"]>;
}): Promise<"saved" | "not_applicable" | "stale" | "unavailable"> {
  const loaded = await args.deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";
  const latest = loaded.record;
  if (
    latest.state.narrative.generation.status !== "pending" ||
    latest.state.narrative.currentScene !== null ||
    latest.state.ending !== null ||
    latest.state.battle.status === "active" ||
    String(latest.state.currentLocationId) !== String(args.original.state.currentLocationId) ||
    args.original.state.prologueShown ||
    !latest.state.prologueShown ||
    !sameStateExceptPrologue(args.original.state, latest.state)
  ) {
    return "not_applicable";
  }

  const presentedEvent = {
    type: "narrative_scene_presented" as const,
    sceneId: args.scene.sceneId,
    locationId: latest.state.currentLocationId,
    focusNpcId: args.generated.focusNpcId,
    revealedFactIds: args.scene.usedFactIds,
    pacing: args.generated.pacing,
    occurredAt: args.deps.now(),
  };
  const nextState: GameState = {
    ...latest.state,
    eventLedger: [...latest.state.eventLedger, presentedEvent],
    narrative: {
      currentScene: args.scene,
      generation: { status: "idle" },
      mode: latest.state.narrative.mode,
    },
  };
  const finalState = {
    ...nextState,
    storyMemory: reconcileStoryMemory({ state: nextState }),
  };
  const saved = await args.deps.repository.applyResolvedAction({
    gameId: latest.gameId,
    expectedRevision: latest.revision,
    nextState: finalState,
  });
  if (saved.ok) return "saved";
  return saved.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
}

function sameStateExceptPrologue(a: GameState, b: GameState): boolean {
  const { prologueShown: _a, ...withoutPrologueA } = a;
  const { prologueShown: _b, ...withoutPrologueB } = b;
  return JSON.stringify(withoutPrologueA) === JSON.stringify(withoutPrologueB);
}

function remapExpandedScene(
  scene: GameState["narrative"]["currentScene"],
  compiled: ReturnType<typeof compileBlueprintExpansion>,
): NonNullable<GameState["narrative"]["currentScene"]> {
  if (scene === null || scene.event === undefined) return scene as NonNullable<GameState["narrative"]["currentScene"]>;
  const event = scene.event;
  const resolvedEvent = event.kind === "investigate" && compiled.newFactId !== null && String(event.factId) === "runtime:new_fact"
    ? { ...event, factId: compiled.newFactId }
    : event.kind === "item" && compiled.newItemId !== null && String(event.itemId) === "runtime:new_item"
      ? { ...event, itemId: compiled.newItemId }
      : event.kind === "battle" && compiled.newEnemyId !== null && String(event.enemyId) === "runtime:new_enemy"
        ? { ...event, enemyId: compiled.newEnemyId }
        : event;
  const replacement = event.kind === "investigate" && compiled.newFactId !== null
    ? { from: "investigate:runtime:new_fact", to: `investigate:${String(compiled.newFactId)}` }
    : event.kind === "item" && compiled.newItemId !== null
      ? { from: "take_item:runtime:new_item", to: `take_item:${String(compiled.newItemId)}` }
      : event.kind === "battle" && compiled.newEnemyId !== null
        ? { from: "start_battle:runtime:new_enemy", to: `start_battle:${String(compiled.newEnemyId)}` }
        : null;
  return {
    ...scene,
    event: resolvedEvent,
    choices: scene.choices.map((choice) => replacement !== null && choice.actionKey === replacement.from
      ? { ...choice, actionKey: replacement.to }
      : choice) as unknown as typeof scene.choices,
  };
}
