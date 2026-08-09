import { randomUUID } from "node:crypto";
import type { GameLogDetails, GameLogger } from "@/game/logging";
import {
  createRequestLogContext,
  createServerLogRuntime,
  type RequestLogContext,
} from "@/game/logging/serverConsoleLogger";
import { asGameId, type GameId } from "./persistence/gameRepository";
import { createServerSqliteClientFactory } from "./persistence/sqliteClient";
import { createSqliteGameRepositoryV2 } from "./persistence/sqliteGameRepositoryV2";
import type { GameRepositoryV2 } from "./persistence/gameRepositoryV2";
import { createGameV2, type WorldGenerationSource } from "../createGameV2";
import { performActionV2 } from "../performActionV2";
import { projectGameSessionView } from "../gameSessionViewV2";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion/expansionSource";
import { createV2WorldGenerationSource, createV2SceneSource, createV2ExpansionSource } from "../server/ai/v2SourceFactory";
import { createServerV2IntentParserSource } from "../server/ai/intentParserSourceFactory";
import { parseAiRuntimeConfig } from "../server/ai/aiRuntimeConfig";
import { generatePendingSceneV2 } from "../generatePendingSceneV2";
import { handleNpcDialogueV2 } from "../handleNpcDialogueV2";
import { commitState } from "../stateCommit";
import { buildChoiceMap } from "../buildChoiceMap";
import type { SceneSource } from "../sceneSource";
import type { StoryState } from "@/game/domain/storyState";
import type { NpcId } from "@/game/domain/scenarioBlueprint";
import type { Interaction, Action } from "@/game/domain/action";
import type { ActionChoiceMap } from "../actionConverter";
import type { GameSessionViewV2 } from "../gameSessionViewV2";
import type { GameTypeId, GameLength } from "@/game/domain/newGame";

export type { RequestLogContext };

// ---------------------------------------------------------------------------
// V2 composition root：P1 双状态模型的 server-only 装配点。
// 与 V1 compositionRoot 并行存在，互不干扰。V1 路由保持不动。
// ---------------------------------------------------------------------------

/** V2 HTTP 开局输入：P1 阶段只收 gameType/gameLength，gameId 与 seed 由服务端装配。 */
export type CreateGameV2HttpInput = {
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
};

export type ServerGameV2EntryPoints = {
  createGameV2(input: CreateGameV2HttpInput, traceId?: string): Promise<{ ok: boolean; revision?: number; code?: string }>;
  performActionV2(command: {
    actionId: string;
    interaction: Interaction;
    expectedRevision: number;
    choiceMap: ActionChoiceMap;
  }, traceId?: string): Promise<{ ok: boolean; revision?: number; feedback?: string; code?: string }>;
  getCurrentGameV2(traceId?: string): Promise<{ ok: boolean; status: string; view?: GameSessionViewV2; revision?: number }>;
  ensureNarrativeSceneV2(traceId?: string): Promise<{ ok: boolean; result?: string }>;
  ackPrologueV2(traceId?: string): Promise<{ ok: boolean; revision?: number; code?: string }>;
  handleNpcDialogueV2(command: { npcId: NpcId; text: string; expectedRevision: number }, traceId?: string): Promise<{ ok: boolean; kind?: string; npcSpeech?: string; revision?: number; code?: string }>;
  clearDevelopmentCurrentGameV2(traceId?: string): Promise<{ status: "cleared" | "none" | "disabled" }>;
  executeHttpRequest(
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    traceId?: string,
  ): Promise<Response>;
  close(): Promise<void>;
};

export function createServerGameV2EntryPoints(
  env: Record<string, string | undefined> = process.env,
): ServerGameV2EntryPoints {
  const logRuntime = createServerLogRuntime(env);
  const { logger } = logRuntime;
  const repository = createSqliteGameRepositoryV2({
    clientFactory: createServerSqliteClientFactory(env),
    logError: (operation) => logger.error("sqlite_repository_v2_failure", { operation }),
  });
  const now = () => new Date().toISOString();
  const aiConfig = parseAiRuntimeConfig(env);
  const aiEnabled = aiConfig.status === "available";
  const source = createV2WorldGenerationSource(env, logger);
  // Task 28：AI 可用注入 live 扩张源，否则确定性 fixture（不再直接注入 createFixtureExpansionSource）。
  const expansionSource = createV2ExpansionSource(env, logger);
  const sceneSource = createV2SceneSource(env, logger);
  // Task 9：对话自由输入统一走 performTurn 回合入口，AI 可用时注入 live 意图源，否则规则源。
  // transport 构建收敛在 server/ai 工厂内（@ai-game/ai-transport 边界守卫）。
  const intentParserSource = createServerV2IntentParserSource(env);

  const executeHttpRequest = async (
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    incomingTraceId?: string,
  ): Promise<Response> => {
    const context = createRequestLogContext({ method, route, traceId: incomingTraceId });
    logger.info("http_request_started_v2", {
      traceId: context.traceId,
      scope: "request",
      source: `rpg.http.v2.${method.toLowerCase()}.${route}`,
      method,
      route,
    });
    try {
      const response = await handler(context);
      logger.info("http_request_completed_v2", {
        traceId: context.traceId,
        scope: "request",
        source: `rpg.http.v2.${method.toLowerCase()}.${route}`,
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
      logger.error("http_request_failed_v2", {
        traceId: context.traceId,
        scope: "request",
        source: `rpg.http.v2.${method.toLowerCase()}.${route}`,
        method,
        route,
        durationMs: Date.now() - context.startedAtMs,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw error;
    }
  };

  return {
    createGameV2: async (input, _traceId) => {
      const gameId = asGameId(randomUUID());
      const result = await createGameV2(
        { gameId, gameType: input.gameType, gameLength: input.gameLength, seed: randomUUID() },
        { repository, source, now, aiEnabled },
      );
      if (result.ok) return { ok: true, revision: result.revision };
      return { ok: false, code: result.code };
    },
    performActionV2: async (command, _traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok || current.status !== "active") return { ok: false, feedback: "No active game" };
      // Build choiceMap server-side from current state (spec §4.3: server maps choiceToken → Action)
      const choiceMap = buildChoiceMap(current.record.worldState, current.record.storyState);
      const result = await performActionV2(
        { gameId: current.record.gameId, actionId: command.actionId, interaction: command.interaction, expectedRevision: command.expectedRevision, choiceMap },
        { repository, now, expansionSource },
      );
      if (result.ok) {
        // Return updated view so the client can render without a separate GET
        const updated = await repository.getCurrentGame();
        if (updated.ok && updated.status === "active") {
          const view = projectGameSessionView(updated.record.worldState, updated.record.storyState, updated.record.revision);
          return { ok: true, revision: result.revision, feedback: result.feedback, view };
        }
        return { ok: true, revision: result.revision, feedback: result.feedback };
      }
      return { ok: false, code: result.code, feedback: result.feedback };
    },
    getCurrentGameV2: async (_traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, status: "error" };
      if (current.status === "none") return { ok: true, status: "none" };
      if (current.status === "corrupt") return { ok: false, status: "corrupt" };
      const view = projectGameSessionView(current.record.worldState, current.record.storyState, current.record.revision);
      return { ok: true, status: "active", view, revision: current.record.revision };
    },
    ensureNarrativeSceneV2: async (_traceId) => {
      const result = await generatePendingSceneV2({ repository, sceneSource, now });
      return { ok: result === "saved", result };
    },
    ackPrologueV2: async (_traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
      const nextStoryState: StoryState = { ...current.record.storyState, prologueShown: true };
      const commit = await commitState(repository, {
        gameId: current.record.gameId,
        expectedRevision: current.record.revision,
        nextWorldState: current.record.worldState,
        nextStoryState,
      });
      if (!commit.ok) return { ok: false, code: commit.code };
      return { ok: true, revision: commit.record.revision };
    },
    handleNpcDialogueV2: async (command, _traceId) => {
      const result = await handleNpcDialogueV2(command, { repository, now, intentParserSource });
      if (result.ok) {
        // Return updated view for narrative_trigger so client can render pending state
        if (result.kind === "narrative_trigger") {
          const updated = await repository.getCurrentGame();
          if (updated.ok && updated.status === "active") {
            const view = projectGameSessionView(updated.record.worldState, updated.record.storyState, updated.record.revision);
            return { ok: true, kind: result.kind, npcSpeech: undefined, revision: result.revision, view };
          }
        }
        return { ok: true, kind: result.kind, npcSpeech: result.kind === "chat" ? result.npcSpeech : undefined, revision: result.revision };
      }
      return { ok: false, code: result.code };
    },
    clearDevelopmentCurrentGameV2: async (_traceId) => {
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

let productionV2EntryPoints: ServerGameV2EntryPoints | null = null;

export function getServerGameV2EntryPoints(): ServerGameV2EntryPoints {
  if (productionV2EntryPoints === null) {
    productionV2EntryPoints = createServerGameV2EntryPoints();
  }
  return productionV2EntryPoints;
}
