import { randomUUID } from "node:crypto";
import type { GameLogDetails, GameLogger } from "@/game/logging";
import {
  createRequestLogContext,
  createServerLogRuntime,
  type RequestLogContext,
} from "@/game/logging/serverConsoleLogger";
import { asGameId, type GameId } from "./persistence/gameRepository";
import { createServerSqliteClientFactory } from "./persistence/sqliteClient";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";
import type { GameRepository } from "./persistence/gameRepository";
import { createGame, type WorldGenerationSource } from "../createGame";
import { performTurn } from "../performTurn";
import { projectGameSessionView } from "../gameSessionView";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion";
import { createWorldGenerationSource, createSceneSource, createExpansionSource } from "../server/ai/sourceFactory";
import { createServerIntentParserSource } from "../server/ai/intentParserSourceFactory";
import { parseAiRuntimeConfig } from "../server/ai/aiRuntimeConfig";
import { generatePendingScene } from "../generatePendingScene";
import { commitState } from "../stateCommit";
import { buildChoiceMap } from "../buildChoiceMap";
import type { SceneSource } from "../sceneSource";
import type { StoryState } from "@/game/domain/storyState";
import type { Interaction } from "@/game/domain/action";
import type { GameSessionView } from "../gameSessionView";
import type { GameTypeId, GameLength, GameSetup } from "@/game/domain/newGame";
import { deriveEndingSessionIdentity, matchesEndingSessionIdentity } from "./endingSessionIdentity";

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
  createGame(input: CreateGameHttpInput, traceId?: string): Promise<{ ok: boolean; revision?: number; code?: string }>;
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
  const source = createWorldGenerationSource(env, logger);
  // Task 28：AI 可用注入 live 扩张源，否则确定性 fixture（不再直接注入 createFixtureExpansionSource）。
  const expansionSource = createExpansionSource(env, logger);
  const sceneSource = createSceneSource(env, logger);
  // Task 9：对话自由输入统一走 performTurn 回合入口，AI 可用时注入 live 意图源，否则规则源。
  // transport 构建收敛在 server/ai 工厂内（@ai-game/ai-transport 边界守卫）。
  const intentParserSource = createServerIntentParserSource(env);

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
    createGame: async (input, _traceId) => {
      const gameId = asGameId(randomUUID());
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
          seed: randomUUID(),
          ...(input.setup === undefined ? {} : { setup: input.setup }),
          ...(replaceCurrent === undefined ? {} : { replaceCurrent }),
        },
        { repository, source, now, aiEnabled },
      );
      if (result.ok) return { ok: true, revision: result.revision };
      return { ok: false, code: result.code };
    },
    performTurn: async (command, _traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Infrastructure error" };
      if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME", feedback: "No active game" };
      // Build choiceMap server-side from current state (spec §4.3: server maps choiceToken → Action)
      const choiceMap = buildChoiceMap(
        current.record.worldState,
        current.record.storyState,
        current.record.revision,
      );
      const result = await performTurn(
        { gameId: current.record.gameId, actionId: command.actionId, interaction: command.interaction, expectedRevision: command.expectedRevision, choiceMap },
        { repository, now, expansionSource, intentParserSource },
      );
      if (result.ok) {
        // Return updated view so the client can render without a separate GET
        const updated = await repository.getCurrentGame();
        if (updated.ok && updated.status === "active") {
          const view = projectGameSessionView(
            updated.record.worldState,
            updated.record.storyState,
            updated.record.revision,
            deriveEndingSessionIdentity(updated.record.gameId, updated.record.revision),
          );
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
    ensureNarrativeScene: async (_traceId) => {
      const result = await generatePendingScene({ repository, sceneSource, now });
      return { ok: result === "saved", result };
    },
    ackPrologue: async (_traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
      // prologueShown 是 UI 元数据，不改变世界状态：不递增 revision，
      // 避免破坏基于当前 revision 铸造的 choiceToken（否则场景固定选项全部失效）。
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
      if (!commit.ok) return { ok: false, code: commit.code };
      return { ok: true, revision: commit.record.revision };
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

let productionEntryPoints: ServerGameEntryPoints | null = null;

export function getServerGameEntryPoints(): ServerGameEntryPoints {
  if (productionEntryPoints === null) {
    productionEntryPoints = createServerGameEntryPoints();
  }
  return productionEntryPoints;
}
