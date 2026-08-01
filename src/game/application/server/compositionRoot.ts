import { randomUUID } from "node:crypto";
import type { NewGameInput } from "@/game/domain";
import type { GameLogDetails, GameLogger } from "@/game/logging";
import {
  createRequestLogContext,
  createServerLogRuntime,
  type RequestLogContext
} from "@/game/logging/serverConsoleLogger";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";
import {
  createGame,
  type CreateGameDependencies,
  type CreateGameResult
} from "../createGame";
import type { ScenarioGenerationEvent } from "../scenarioGeneration";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateSource,
} from "../scenarioGeneration";
import { getCurrentGame, type CurrentGameResult } from "../getCurrentGame";
import {
  performAction,
  type PerformActionCommand,
  type PerformActionDependencies,
  type PerformActionResult
} from "../performAction";
import {
  handleNpcDialogue,
  type HandleNpcDialogueCommand,
  type HandleNpcDialogueDependencies,
  type HandleNpcDialogueResult
} from "../handleNpcDialogue";
import { asGameId, type GameId } from "./persistence/gameRepository";
import { createScenarioCandidateSource } from "./ai/scenarioCandidateSourceFactory";
import { createRuntimeNarrativeSources } from "./ai/runtimeNarrativeSourceFactory";
import { createTownPlanSource } from "./ai/townPlanSourceFactory";
import {
  RuntimeNarrativeTaskCoordinator,
  type NarrativeEnsureResult,
} from "./ai/runtimeNarrativeTaskCoordinator";
import {
  TownPlanTaskCoordinator,
  type TownEnsureResult,
} from "./ai/townPlanTaskCoordinator";
import { createServerSqliteClientFactory } from "./persistence/sqliteClient";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";

export type { RequestLogContext };

type Phase1Fixture = { input: NewGameInput; seed: string };
const PHASE10_JOURNEY_BASELINE = wuxiaFixture as unknown as Phase1Fixture;

/** The journey baseline must never make an opening-world provider request. */
function createOfflineJourneyScenarioSource(): ScenarioCandidateSource {
  return {
    async generate() {
      return {
        ok: false,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "unavailable",
        category: "service_error",
        diagnostics: ["OFFLINE_PHASE10_JOURNEY_BASELINE"],
      };
    },
  };
}

export type OfflineJourneyGameResult = CreateGameResult | {
  readonly ok: false;
  readonly code: "DEVELOPMENT_TOOLS_DISABLED";
};

// ---------------------------------------------------------------------------
// production composition root（Task 3）：server-only 层唯一的真实依赖装配点。
// 只有这里把真实 SQLite repository（经 sqliteClient 的 env 配置助手解析路径）、
// UUID gameId provider、随机 seed 与真实时钟注入 use case——application 本体
// 始终不读 process.env / 文件路径 / libsql 类型。
// 公开入口只接受 NewGameInput：seed、gameId、数据库路径、生成来源均无从由
// 调用方（API/浏览器）指定。
// ---------------------------------------------------------------------------

/** API 层（Task 4）可直接使用的入口：不暴露 repository、libsql 或路径配置。 */
export type ServerGameEntryPoints = {
  /** 由 server composition root 决定，客户端与 API adapter 不读取环境变量。 */
  readonly developmentToolsEnabled: boolean;
  /** 创建当前本地存档：只承载浏览器允许提交的开局资料。 */
  createGame(input: NewGameInput, traceId?: string): Promise<CreateGameResult>;
  /** 开发专用：使用 Phase 10 离线完整旅程的固定开局基线，零 AI 调用。 */
  createOfflineJourneyGame(traceId?: string): Promise<OfflineJourneyGameResult>;
  /** 读取当前本地存档的 read model。 */
  getCurrentGame(traceId?: string): Promise<CurrentGameResult>;
  /** 执行玩家行动：纯规则裁决 + 原子续存档。 */
  performAction(command: PerformActionCommand, traceId?: string): Promise<PerformActionResult>;
  /** NPC 自由输入：纯规则分类→闲聊回应或排队叙事场景；自身零 AI 调用。 */
  handleNpcDialogue(command: HandleNpcDialogueCommand, traceId?: string): Promise<HandleNpcDialogueResult>;
  /** 快速启动或恢复当前存档的后台叙事生成；绝不等待 provider。 */
  ensureNarrativeGeneration(traceId?: string): Promise<NarrativeEnsureResult>;
  /** 快速启动或恢复当前存档的后台小镇规划生成；绝不等待 provider。 */
  ensureTownGeneration(traceId?: string): Promise<TownEnsureResult>;
  /** 仅 development composition 可调用；生产环境一律返回 disabled。 */
  clearDevelopmentCurrentGame(traceId?: string): Promise<"cleared" | "none" | "disabled" | "unavailable">;
  /** API adapter 统一使用的请求生命周期与 trace 入口。 */
  executeHttpRequest(
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    traceId?: string
  ): Promise<Response>;
  /** 释放底层 SQLite 客户端：测试清理临时文件 / 进程收尾用；重复调用安全。 */
  close(): Promise<void>;
};

/** 仅供 server 侧 smoke/结构化日志观察生成阶段，绝不由浏览器或 API 提供。 */
export type ServerGameEntryPointOptions = {
  readonly generationObserver?: (event: ScenarioGenerationEvent) => void;
};

function stableResultDetails(result: unknown): GameLogDetails {
  if (result === null || typeof result !== "object") return {};
  const value = result as Record<string, unknown>;
  const view = value.view !== null && typeof value.view === "object"
    ? value.view as Record<string, unknown>
    : undefined;
  const gameId = typeof value.gameId === "string"
    ? value.gameId
    : typeof view?.gameId === "string" ? view.gameId : undefined;
  const currentLocation = view?.currentLocation;
  const currentLocationId = currentLocation !== null && typeof currentLocation === "object" &&
    typeof (currentLocation as Record<string, unknown>).id === "string"
    ? (currentLocation as Record<string, unknown>).id as string
    : undefined;
  const revision = typeof view?.revision === "number" && Number.isInteger(view.revision)
    ? view.revision
    : undefined;
  const battle = view?.battle;
  const battleStatus = battle === null ? "idle" : battle !== undefined ? "active" : undefined;
  const narrativeGeneration = view?.narrativeGeneration;
  const narrativeGenerationStatus = narrativeGeneration !== null && typeof narrativeGeneration === "object" &&
    typeof (narrativeGeneration as Record<string, unknown>).status === "string"
    ? (narrativeGeneration as Record<string, unknown>).status as string
    : undefined;
  const townStatus = typeof view?.townStatus === "string" ? view.townStatus : undefined;
  const activeQuests = Array.isArray(view?.activeQuests) ? view.activeQuests.length : undefined;
  const storyEvents = Array.isArray(view?.storyEvents) ? view.storyEvents.length : undefined;
  return {
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.source === "string" ? { resultSource: value.source } : {}),
    ...(gameId === undefined ? {} : { gameId, saveId: gameId }),
    ...(currentLocationId === undefined ? {} : { currentLocationId }),
    ...(revision === undefined ? {} : { revision }),
    ...(battleStatus === undefined ? {} : { battleStatus }),
    ...(narrativeGenerationStatus === undefined ? {} : { narrativeGenerationStatus }),
    ...(townStatus === undefined ? {} : { townStatus }),
    ...(activeQuests === undefined ? {} : { activeQuestCount: activeQuests }),
    ...(storyEvents === undefined ? {} : { storyEventCount: storyEvents })
  };
}

function stableIntentDetails(command: PerformActionCommand): GameLogDetails {
  const intent = command.intent as unknown as Record<string, unknown>;
  const details: Record<string, unknown> = {
    intentType: typeof intent.type === "string" ? intent.type : "unknown",
    expectedRevision: command.expectedRevision
  };
  for (const key of ["locationId", "npcId", "factId", "itemId", "enemyId", "action"] as const) {
    if (typeof intent[key] === "string") details[key] = intent[key];
  }
  return details;
}

function stableNpcDialogueDetails(command: HandleNpcDialogueCommand): GameLogDetails {
  return {
    npcId: String(command.npcId),
    expectedRevision: command.expectedRevision,
    textLength: command.text.length
  };
}

async function runLoggedUseCase<T>(
  logger: GameLogger,
  operation: string,
  work: () => Promise<T>,
  extraDetails: GameLogDetails = {},
  requestedTraceId?: string
): Promise<T> {
  const traceId = requestedTraceId ?? randomUUID();
  const source = `rpg.server.${operation}`;
  const startedAt = Date.now();
  logger.info(`${operation}_started`, { traceId, scope: "request", source, ...extraDetails });
  try {
    const result = await work();
    logger.info(`${operation}_completed`, {
      traceId,
      scope: "request",
      source,
      durationMs: Date.now() - startedAt,
      ...extraDetails,
      ...stableResultDetails(result)
    });
    return result;
  } catch (error) {
    logger.error(`${operation}_failed`, {
      traceId,
      scope: "request",
      source,
      durationMs: Date.now() - startedAt,
      ...extraDetails,
      errorName: error instanceof Error ? error.name : "UnknownError"
    });
    throw error;
  }
}

/**
 * 装配一套真实入口：env 记录仅经 sqliteClient 的工厂解析 GAME_DB_PATH，
 * 测试注入指向 tmp/ 的记录，生产默认 process.env（本层是唯一允许读取处）。
 */
export function createServerGameEntryPoints(
  env: Record<string, string | undefined> = process.env,
  options: ServerGameEntryPointOptions = {}
): ServerGameEntryPoints {
  const logRuntime = createServerLogRuntime(env);
  const { logger } = logRuntime;
  logger.info("server_runtime_started", { scope: "system", source: "rpg.server" });
  const repository = createSqliteGameRepository({
    clientFactory: createServerSqliteClientFactory(env),
    logError: (operation) => logger.error("sqlite_repository_failure", { operation })
  });
  const runtimeNarrativeSources = createRuntimeNarrativeSources(env, { logger });
  const dependencies: CreateGameDependencies = {
    repository,
    // 生产 provider：UUID 存档 ID、随机 seed、真实时钟（ISO 8601）。
    newGameId: (): GameId => asGameId(randomUUID()),
    newSeed: () => randomUUID(),
    now: () => new Date().toISOString(),
    // Phase 4B：按 AI 运行时配置装配 source——配置有效走 live，否则 unavailable
    // （玩家稳定走 fallback）。fixture source 绝不按 env 切入生产。
    // traceId 只进 source 请求与脱敏审计；observer 仅接收脱敏阶段事件。
    scenarioCandidateSource: createScenarioCandidateSource(env, { logger }),
    newTraceId: () => randomUUID(),
    generationObserver: options.generationObserver ?? ((event) => {
      logger.info("scenario_generation_lifecycle", {
        traceId: event.traceId,
        scope: "request",
        source: "rpg.server.create_game",
        stage: event.stage,
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        ...(event.category === undefined ? {} : { category: event.category })
      });
    }),
    runtimeNarrativeSources,
  };
  const performDeps: PerformActionDependencies = {
    repository,
    now: () => new Date().toISOString(),
    newTraceId: () => randomUUID(),
    runtimeNarrativeSources
  };
  // 与 performDeps 共享同一 repository/时钟/sources 引用：对话触发的 pending
  // 与行动触发的 pending 走完全相同的持久化与恢复链路。
  const npcDialogueDeps: HandleNpcDialogueDependencies = {
    repository,
    now: () => new Date().toISOString(),
    runtimeNarrativeSources
  };
  const offlineJourneyDependencies: CreateGameDependencies = {
    ...dependencies,
    scenarioCandidateSource: createOfflineJourneyScenarioSource(),
    runtimeNarrativeMode: "offline",
  };
  const narrativeCoordinator = new RuntimeNarrativeTaskCoordinator({
    repository,
    newTraceId: () => randomUUID(),
    now: () => new Date().toISOString(),
    runtimeNarrativeSources,
    logger
  }, logger);
  const townPlanCoordinator = new TownPlanTaskCoordinator({
    repository,
    newTraceId: () => randomUUID(),
    now: () => new Date().toISOString(),
    townPlanSource: createTownPlanSource(env, { logger }),
    logger,
  }, logger);
  const executeHttpRequest = async (
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    incomingTraceId?: string
  ): Promise<Response> => {
    const context = createRequestLogContext({ method, route, traceId: incomingTraceId });
    const source = `rpg.http.${method.toLowerCase()}.${route}`;
    logger.info("http_request_started", {
      traceId: context.traceId,
      scope: "request",
      source,
      method,
      route
    });
    try {
      const response = await handler(context);
      logger.info("http_request_completed", {
        traceId: context.traceId,
        scope: "request",
        source,
        method,
        route,
        httpStatus: response.status,
        resultCode: context.resultCode(),
        durationMs: Date.now() - context.startedAtMs
      });
      const headers = new Headers(response.headers);
      headers.set("X-Request-Trace-Id", context.traceId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (error) {
      logger.error("http_request_failed", {
        traceId: context.traceId,
        scope: "request",
        source,
        method,
        route,
        durationMs: Date.now() - context.startedAtMs,
        errorName: error instanceof Error ? error.name : "UnknownError"
      });
      throw error;
    }
  };
  return {
    developmentToolsEnabled: env.NODE_ENV === "development",
    // 刻意不透传 command.seed：浏览器/API 无法指定 seed 或 gameId。
    createGame: (input, traceId) => runLoggedUseCase(
      logger,
      "create_game",
      () => createGame({ input }, dependencies),
      { gameType: input.gameType },
      traceId
    ),
    createOfflineJourneyGame: (traceId) => {
      if (env.NODE_ENV !== "development") {
        logger.warn("offline_journey_create_rejected", {
          scope: "request",
          source: "rpg.server.create_offline_journey_game",
          code: "DEVELOPMENT_TOOLS_DISABLED"
        });
        return Promise.resolve({ ok: false, code: "DEVELOPMENT_TOOLS_DISABLED" });
      }
      return runLoggedUseCase(logger, "create_offline_journey_game", () => createGame({
          input: PHASE10_JOURNEY_BASELINE.input,
          seed: PHASE10_JOURNEY_BASELINE.seed,
        }, offlineJourneyDependencies), {}, traceId);
    },
    getCurrentGame: (traceId) => runLoggedUseCase(
      logger,
      "get_current_game",
      () => getCurrentGame({ repository }),
      {},
      traceId
    ),
    performAction: (command, traceId) => runLoggedUseCase(
      logger,
      "perform_action",
      () => performAction(command, performDeps),
      stableIntentDetails(command),
      traceId
    ),
    handleNpcDialogue: (command, traceId) => runLoggedUseCase(
      logger,
      "handle_npc_dialogue",
      () => handleNpcDialogue(command, { ...npcDialogueDeps, traceId, logger }),
      stableNpcDialogueDetails(command),
      traceId
    ),
    ensureNarrativeGeneration: (traceId) => runLoggedUseCase(
      logger,
      "ensure_narrative_generation",
      () => narrativeCoordinator.ensure(traceId),
      {},
      traceId
    ),
    ensureTownGeneration: (traceId) => runLoggedUseCase(
      logger,
      "ensure_town_generation",
      () => townPlanCoordinator.ensure(traceId),
      {},
      traceId
    ),
    clearDevelopmentCurrentGame: async (traceId) => {
      return runLoggedUseCase(logger, "clear_development_current_game", async () => {
        if (env.NODE_ENV !== "development") return "disabled";
        const result = await repository.clearCurrentGame();
        if (!result.ok) return "unavailable";
        return result.status;
      }, {}, traceId);
    },
    executeHttpRequest,
    close: async () => {
      try {
        await repository.close();
      } finally {
        await logRuntime.close();
      }
    }
  };
}

// 进程内单例：API route（Task 4）共用同一 repository/客户端，惰性创建。
let productionEntryPoints: ServerGameEntryPoints | null = null;

/** 生产入口单例：首次调用时按 process.env 装配，此后复用同一连接。 */
export function getServerGameEntryPoints(): ServerGameEntryPoints {
  if (productionEntryPoints === null) {
    productionEntryPoints = createServerGameEntryPoints();
  }
  return productionEntryPoints;
}
