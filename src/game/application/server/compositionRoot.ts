import { randomUUID } from "node:crypto";
import {
  createRequestLogContext,
  createServerLogRuntime,
  type RequestLogContext,
} from "@/game/logging/serverConsoleLogger";
import { asGameId, type GameId } from "./persistence/gameRepository";
import { createServerSqliteClientFactory } from "./persistence/sqliteClient";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";
import { createGame } from "../createGame";
import { performTurn } from "../performTurn";
import { projectGameSessionView } from "../gameSessionView";
import { createOpeningGenerationSource, createSceneSource, createWorldEvolutionSource } from "../server/ai/sourceFactory";
import { createServerIntentParserSource } from "../server/ai/intentParserSourceFactory";
import { createServerRpgAiClient } from "../server/ai/rpgAiClient";
import { parseAiRuntimeConfig } from "../server/ai/aiRuntimeConfig";
import { generatePendingScene } from "../generatePendingScene";
import { buildSceneGenerationContext } from "../sceneGenerationContext";
import { approveScenePerformance } from "../approveAndWriteScene";
import { prewarmBattleVictoryScene, type BattleScenePrewarm } from "./battleScenePrewarm";
import { createDeterministicSceneSource } from "../deterministicSceneSource";
import { commitState } from "../stateCommit";
import { buildChoiceMap } from "../buildChoiceMap";
import type { StoryState } from "@/game/domain/storyState";
import type { Interaction } from "@/game/domain/action";
import type { GameSessionView } from "../gameSessionView";
import type { GameTypeId, GameLength, GameSetup } from "@/game/domain/newGame";
import { deriveEndingSessionIdentity, matchesEndingSessionIdentity } from "./endingSessionIdentity";
import { BackgroundEnsureCoordinator } from "./ai/_shared/ensureCoordinator";

export type { RequestLogContext };

// ---------------------------------------------------------------------------
// 双状态模型的唯一 server-only 装配点。
// ---------------------------------------------------------------------------

/** HTTP 开局输入：核心收 gameType/gameLength，gameId 与 seed 由服务端装配。
 *  setup 为路由层已经通过 validateNewGameInput 的开局配置，
 *  世界生成源必须消费它（角色名/身份/世界观/故事开端）。 */
export type CreateGameHttpInput = {
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly restart?: { readonly identity: string; readonly expectedRevision: number };
  readonly setup?: GameSetup;
};

type PerformTurnEntryPointResult =
  | { readonly ok: true; readonly revision: number; readonly feedback: string; readonly view: GameSessionView }
  | { readonly ok: false; readonly code: string; readonly feedback?: string };

export type ServerGameEntryPoints = {
  createGame(input: CreateGameHttpInput, traceId?: string): Promise<{
    ok: boolean;
    revision?: number;
    code?: string;
    generationSource?: "generated" | "fallback";
  }>;
  performTurn(command: {
    actionId: string;
    interaction: Interaction;
    expectedRevision: number;
  }, traceId?: string): Promise<PerformTurnEntryPointResult>;
  getCurrentGame(traceId?: string): Promise<{ ok: boolean; status: string; view?: GameSessionView; revision?: number }>;
  ensureNarrativeScene(traceId?: string): Promise<{ ok: boolean; result?: string }>;
  ackPrologue(traceId?: string): Promise<{ ok: boolean; revision?: number; code?: string }>;
  clearDevelopmentCurrentGame(traceId?: string): Promise<{ status: "cleared" | "none" | "disabled" }>;
  executeHttpRequest(
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    traceId?: string,
  ): Promise<Response>;
  close(): Promise<void>;
};

export function createServerGameEntryPoints(
  env: Record<string, string | undefined> = process.env,
): ServerGameEntryPoints {
  const logRuntime = createServerLogRuntime(env);
  const { logger } = logRuntime;
  const repository = createSqliteGameRepository({
    clientFactory: createServerSqliteClientFactory(env),
    logError: (operation) => logger.error("sqlite_repository_failure", { operation }),
  });
  const now = () => new Date().toISOString();
  const aiConfig = parseAiRuntimeConfig(env);
  const aiEnabled = aiConfig.status === "available";
  // One provider transport/client per server composition root. Role policy,
  // thinking mode, budgets, and transient retries are centralized there.
  const aiClient = createServerRpgAiClient(env, logger);
  const openingGenerationSources = new Map<string, "generated" | "fallback">();
  const source = createOpeningGenerationSource(env, logger, (marker) => {
    openingGenerationSources.set(marker.seed, marker.source);
  }, aiClient);
  // Task 3：AI 可用注入 live 世界演化源，否则确定性源（不再直接注入 deterministic）。
  const worldEvolutionSource = createWorldEvolutionSource(env, logger, aiClient);
  const sceneSource = createSceneSource(env, logger, aiClient);
  // 战斗只保留胜利/失败两态后，战斗开始即后台预热胜利场景。API 提案和
  // 确定性提案并行准备：API 优先用于剧情质量，确定性提案只负责保证最后
  // 一击不会再打开叙事等待。预热结果只存 server memory，最终写回仍以
  // 最后一击的权威 World/Story 记录为准。
  const battleScenePrewarmCache = new Map<string, BattleScenePrewarm>();
  const battleScenePrewarmPromises = new Map<string, Promise<BattleScenePrewarm | null>>();
  const battleSceneFallbackPromises = new Map<string, Promise<BattleScenePrewarm | null>>();
  const deterministicSceneSource = createDeterministicSceneSource();
  const ensureBattleSceneFallback = (record: Parameters<typeof prewarmBattleVictoryScene>[0]): Promise<BattleScenePrewarm | null> => {
    const battle = record.worldState.battle;
    if (battle.status !== "active" || battle.battleKey === undefined) return Promise.resolve(null);
    const cached = battleScenePrewarmCache.get(battle.battleKey);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = battleSceneFallbackPromises.get(battle.battleKey);
    if (existing !== undefined) return existing;
    const promise = prewarmBattleVictoryScene(record, {
      sceneSource: deterministicSceneSource,
      logger,
      now,
      requireGenerated: false,
    })
      .then((prewarm) => {
        if (prewarm !== null && !battleScenePrewarmCache.has(prewarm.battleKey)) {
          battleScenePrewarmCache.set(prewarm.battleKey, prewarm);
        }
        return prewarm;
      })
      .catch(() => null)
      .finally(() => {
        battleSceneFallbackPromises.delete(battle.battleKey!);
      });
    battleSceneFallbackPromises.set(battle.battleKey, promise);
    return promise;
  };
  const ensureBattleScenePrewarm = (record: Parameters<typeof prewarmBattleVictoryScene>[0]): void => {
    const battle = record.worldState.battle;
    if (battle.status !== "active" || battle.battleKey === undefined) return;
    if (battleScenePrewarmCache.has(battle.battleKey) || battleScenePrewarmPromises.has(battle.battleKey)) return;
    // 先把无网络的战后提案放进内存，确保玩家无论战斗多快结束，都不会
    // 因 live provider 的慢响应在胜利后看到“正在处理”。live 结果回来后
    // 会覆盖 fallback，并在最后一击前优先使用 generated。
    void ensureBattleSceneFallback(record);
    const promise = prewarmBattleVictoryScene(record, { sceneSource, logger, now })
      .then(async (prewarm) => {
        if (prewarm !== null) {
          const current = await repository.getCurrentGame();
          if (current.ok
            && current.status === "active"
            && current.record.worldState.battle.status === "active"
            && current.record.worldState.battle.battleKey === prewarm.battleKey) {
            battleScenePrewarmCache.set(prewarm.battleKey, prewarm);
          }
        }
        return prewarm;
      })
      .catch(() => null)
      .finally(() => {
        battleScenePrewarmPromises.delete(battle.battleKey!);
      });
    battleScenePrewarmPromises.set(battle.battleKey, promise);
  };
  const applyPrewarmedBattleScene = async (record: Parameters<typeof prewarmBattleVictoryScene>[0], prewarm: BattleScenePrewarm): Promise<boolean> => {
    const generation = record.storyState.narrative.generation;
    if (generation.status !== "pending" || !("job" in generation) || generation.job === undefined) return false;
    const context = buildSceneGenerationContext(record);
    const approved = approveScenePerformance({
      context,
      proposal: prewarm.proposal,
      basedOnRevision: record.revision,
      existingCandidateEventPool: record.storyState.candidateEventPool,
    });
    if (!approved.ok) {
      logger.warn("battle_scene_prewarm_rejected", { battleKey: prewarm.battleKey, code: approved.code });
      return false;
    }
    const writeBack = await repository.applySceneWriteBack({
      gameId: record.gameId,
      expectedRevision: record.revision,
      nextWorldState: record.worldState,
      nextStoryState: {
        ...record.storyState,
        candidateEventPool: approved.candidateEventPool,
        narrative: {
          ...record.storyState.narrative,
          currentScene: approved.scene,
          generation: { status: "idle" },
          choiceRegistry: approved.choiceRegistry,
        },
      },
    });
    if (!writeBack.ok) return false;
    logger.info("battle_scene_prewarm_used", { battleKey: prewarm.battleKey });
    return true;
  };
  const deferBattleSceneToPrewarm = (battleKey: string, traceId?: string): boolean => {
    const pending = battleScenePrewarmPromises.get(battleKey);
    if (pending === undefined) return false;
    void pending.then(async () => {
      const current = await repository.getCurrentGame();
      if (!current.ok || current.status !== "active") return;
      if (current.record.worldState.battle.status !== "resolved"
        || current.record.worldState.battle.battleKey !== battleKey
        || current.record.storyState.narrative.generation.status !== "pending") return;
      const prewarm = battleScenePrewarmCache.get(battleKey);
      if (prewarm !== undefined) {
        const applied = await applyPrewarmedBattleScene(current.record, prewarm);
        if (applied) {
          battleScenePrewarmCache.delete(battleKey);
          return;
        }
      }
      await narrativeCoordinator.ensure(traceId);
    }).catch(() => {
      // The normal narrative polling path will retry after a failed prewarm.
    });
    return true;
  };
  // Task 9：对话自由输入统一走 performTurn 回合入口，AI 可用时注入 live 意图源，否则规则源。
  // transport 构建收敛在 server/ai 工厂内（@ai-game/ai-transport 边界守卫）。
  const intentParserSource = createServerIntentParserSource(env, aiClient);
  const narrativeCoordinator = new BackgroundEnsureCoordinator({
    loadPending: async () => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, result: "unavailable" };
      if (current.status !== "active") return { ok: false, result: "not_pending" };
      const generation = current.record.storyState.narrative.generation;
      if (generation.status !== "pending") return { ok: false, result: "not_pending" };
      if (!("job" in generation) || generation.job === undefined) {
        return { ok: false, result: "unavailable" };
      }
      const battle = current.record.worldState.battle;
      if (battle.status === "resolved"
        && battle.battleKey !== undefined
        && battleScenePrewarmPromises.has(battle.battleKey)) {
        return { ok: false, result: "already_running" };
      }
      return {
        ok: true,
        key: `${current.record.gameId}:${generation.job.jobId}`,
      };
    },
    run: () => generatePendingScene({ repository, sceneSource, worldEvolutionSource, logger, allowDeterministicFallback: true, now }),
    logKey: "runtime_narrative_task",
    logger,
  });

  const executeHttpRequest = async (
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    incomingTraceId?: string,
  ): Promise<Response> => {
    const context = createRequestLogContext({ method, route, traceId: incomingTraceId });
    logger.info("http_request_started", {
      traceId: context.traceId,
      scope: "request",
      source: `rpg.http.${method.toLowerCase()}.${route}`,
      method,
      route,
    });
    try {
      const response = await handler(context);
      logger.info("http_request_completed", {
        traceId: context.traceId,
        scope: "request",
        source: `rpg.http.${method.toLowerCase()}.${route}`,
        method,
        route,
        httpStatus: response.status,
        durationMs: Date.now() - context.startedAtMs,
      });
      const headers = new Headers(response.headers);
      headers.set("X-Request-Trace-Id", context.traceId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      logger.error("http_request_failed", {
        traceId: context.traceId,
        scope: "request",
        source: `rpg.http.${method.toLowerCase()}.${route}`,
        method,
        route,
        durationMs: Date.now() - context.startedAtMs,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  };

  return {
    createGame: async (input, traceId) => {
      const gameId = asGameId(randomUUID());
      const generationSeed = randomUUID();
      let replaceCurrent: { readonly expectedGameId: GameId; readonly expectedRevision: number } | undefined;
      if (input.restart !== undefined) {
        const current = await repository.getCurrentGame();
        if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
        if (
          current.record.revision !== input.restart.expectedRevision
          || !matchesEndingSessionIdentity(current.record.gameId, current.record.revision, input.restart.identity)
        ) {
          return { ok: false, code: "STALE_GAME_REVISION" };
        }
        if (current.record.worldState.ending === null) {
          return { ok: false, code: "GAME_NOT_ENDED" };
        }
        replaceCurrent = {
          expectedGameId: current.record.gameId,
          expectedRevision: input.restart.expectedRevision,
        };
      }
      const result = await createGame(
        {
          gameId,
          gameType: input.gameType,
          gameLength: input.gameLength,
          seed: generationSeed,
          ...(input.setup === undefined ? {} : { setup: input.setup }),
          ...(replaceCurrent === undefined ? {} : { replaceCurrent }),
        },
        { repository, source, now, aiEnabled },
      );
      if (result.ok) {
        const generationSource = openingGenerationSources.get(generationSeed);
        openingGenerationSources.delete(generationSeed);
        // 开局存档已经包含首场景 pending job；立即排队，让序幕阅读时间覆盖生成延迟。
        await narrativeCoordinator.ensure(traceId);
        return {
          ok: true,
          revision: result.revision,
          ...(generationSource === undefined ? {} : { generationSource }),
        };
      }
      openingGenerationSources.delete(generationSeed);
      return { ok: false, code: result.code };
    },
    performTurn: async (command, traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Infrastructure error" };
      if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME", feedback: "No active game" };
      // Build choiceMap server-side from current state (spec §4.3: server maps choiceToken → Action)
      const choiceMap = buildChoiceMap(
        current.record.worldState,
        current.record.storyState,
        current.record.revision,
      );
      const submittedAction = command.interaction.kind === "fixed_choice"
        ? choiceMap.get(command.interaction.choiceToken)
        : undefined;
      const result = await performTurn(
        { gameId: current.record.gameId, actionId: command.actionId, interaction: command.interaction, expectedRevision: command.expectedRevision, choiceMap },
        { repository, now, worldEvolutionSource, intentParserSource, allowDeterministicWorldEvolutionFallback: true },
      );
      if (result.ok) {
        // Return updated view so the client can render without a separate GET
        const updated = await repository.getCurrentGame();
        if (updated.ok && updated.status === "active") {
          let readyRecord = updated.record;
          let view = projectGameSessionView(
            updated.record.worldState,
            updated.record.storyState,
            updated.record.revision,
            deriveEndingSessionIdentity(updated.record.gameId, updated.record.revision),
          );
          if (readyRecord.worldState.battle.status === "active") {
            ensureBattleScenePrewarm(readyRecord);
          }
          // 目标已锁定的一键移动、规则已完全确定的拾取动作，以及结束战斗的
          // 最后一击，不应该再经历“先完成动作、再等 AI 编排”的两段等待。
          // 战斗开始时已并行准备 API 与确定性战后提案；最后一击只使用已在
          // 内存中的提案写回，普通战斗回合仍保持低延迟规则路径。
          if (view.narrativeGeneration.status === "pending") {
            const shouldCompleteSceneInAction = submittedAction?.type === "move"
              || submittedAction?.type === "take_item";
            const resolvedBattle = readyRecord.worldState.battle;
            const isVictoryAction = submittedAction?.type === "battle_action"
              && resolvedBattle.status === "resolved"
              && resolvedBattle.outcome === "victory"
              && resolvedBattle.battleKey !== undefined;
            let battlePrewarmPending = false;
            if (isVictoryAction) {
              // fallback 提案在战斗开始时并行准备；若玩家极快结束战斗，
              // 这里仅等待本地确定性计算（通常为毫秒级），绝不等待 API。
              let prewarm = battleScenePrewarmCache.get(resolvedBattle.battleKey);
              if (prewarm === undefined) {
                prewarm = await ensureBattleSceneFallback(readyRecord) ?? undefined;
              }
              if (prewarm !== undefined) {
                const usedPrewarm = await applyPrewarmedBattleScene(readyRecord, prewarm);
                if (usedPrewarm) {
                  battleScenePrewarmCache.delete(resolvedBattle.battleKey);
                  const refreshed = await repository.getCurrentGame();
                  if (refreshed.ok && refreshed.status === "active") {
                    readyRecord = refreshed.record;
                    view = projectGameSessionView(
                      readyRecord.worldState,
                      readyRecord.storyState,
                      readyRecord.revision,
                      deriveEndingSessionIdentity(readyRecord.gameId, readyRecord.revision),
                    );
                  }
                }
              } else {
                // 仅在本地提案确实不可用时保留 live promise 的异步接管。
                battlePrewarmPending = deferBattleSceneToPrewarm(resolvedBattle.battleKey, traceId);
              }
            }
            if (shouldCompleteSceneInAction) {
              const immediateSceneResult = await generatePendingScene({ repository, sceneSource, worldEvolutionSource, logger, allowDeterministicFallback: true, now });
              if (immediateSceneResult === "saved") {
                const refreshed = await repository.getCurrentGame();
                if (refreshed.ok && refreshed.status === "active") {
                  readyRecord = refreshed.record;
                  view = projectGameSessionView(
                    readyRecord.worldState,
                    readyRecord.storyState,
                    readyRecord.revision,
                    deriveEndingSessionIdentity(readyRecord.gameId, readyRecord.revision),
                  );
                }
              }
            }
            // 如果 live 预热仍未返回，最后一击也不再同步调用 coordinator；
            // 只有 live/fallback 两条预热都不可用时，客户端轮询才负责恢复。
            if (view.narrativeGeneration.status === "pending" && !battlePrewarmPending && !isVictoryAction) {
              await narrativeCoordinator.ensure(traceId);
            }
          }
          return { ok: true, revision: result.revision, feedback: result.feedback, view };
        }
        return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Unable to read saved game" };
      }
      return { ok: false, code: result.code, feedback: result.feedback };
    },
    getCurrentGame: async (_traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, status: "error" };
      if (current.status === "none") return { ok: true, status: "none" };
      if (current.status === "corrupt") return { ok: false, status: "corrupt" };
      const view = projectGameSessionView(
        current.record.worldState,
        current.record.storyState,
        current.record.revision,
        deriveEndingSessionIdentity(current.record.gameId, current.record.revision),
      );
      return { ok: true, status: "active", view, revision: current.record.revision };
    },
    ensureNarrativeScene: async (traceId) => {
      const result = await narrativeCoordinator.ensure(traceId);
      return { ok: result !== "unavailable", result };
    },
    ackPrologue: async (_traceId) => {
      // 与后台场景 CAS 撞车时重新读取一次；确认是单调、幂等的 UI 元数据，
      // 不递增 revision，避免使已经铸造的 scene choice token 失效。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await repository.getCurrentGame();
        if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
        if (current.record.storyState.prologueShown) {
          return { ok: true, revision: current.record.revision };
        }
        const nextStoryState: StoryState = {
          ...current.record.storyState,
          prologueShown: true,
        };
        const commit = await commitState(repository, {
          gameId: current.record.gameId,
          expectedRevision: current.record.revision,
          nextWorldState: current.record.worldState,
          nextStoryState,
          incrementRevision: false,
        });
        if (commit.ok) return { ok: true, revision: commit.record.revision };
        if (commit.code !== "STALE_GAME_REVISION") return { ok: false, code: commit.code };
      }
      return { ok: false, code: "STALE_GAME_REVISION" };
    },
    clearDevelopmentCurrentGame: async (_traceId) => {
      // Only allow in development environment
      if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
        return { status: "disabled" };
      }
      const result = await repository.clearCurrentGame();
      if (result.ok) return { status: "cleared" };
      return { status: "disabled" };
    },
    executeHttpRequest,
    close: async () => {
      try {
        await repository.close();
      } finally {
        await logRuntime.close();
      }
    },
  };
}

// Next 的不同 route bundle 会各自求值模块级变量。叙事回合在 action route
// 里立即 ensure，而客户端随后会在 narrative/ensure route 轮询；若只用模块级
// singleton，两条 route 会各自创建 coordinator，对同一个 pending job 并发调用
// AI。把唯一入口挂到进程级 globalThis，才能让两条 route 共用同一把去重锁。
const ENTRY_POINTS_GLOBAL_KEY = Symbol.for("ai-rpg-game.server-entry-points");
type EntryPointsGlobal = typeof globalThis & {
  [ENTRY_POINTS_GLOBAL_KEY]?: ServerGameEntryPoints;
};

let productionEntryPoints: ServerGameEntryPoints | null = null;

export function getServerGameEntryPoints(): ServerGameEntryPoints {
  const runtime = globalThis as EntryPointsGlobal;
  const shared = runtime[ENTRY_POINTS_GLOBAL_KEY];
  if (shared !== undefined) {
    productionEntryPoints = shared;
    return shared;
  }
  if (productionEntryPoints === null) {
    productionEntryPoints = createServerGameEntryPoints();
  }
  runtime[ENTRY_POINTS_GLOBAL_KEY] = productionEntryPoints;
  return productionEntryPoints;
}
