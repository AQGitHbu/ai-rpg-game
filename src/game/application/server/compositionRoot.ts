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
import { createTextAuditRecorder } from "../server/ai/textAuditRecorder";
import type {
  AiTextAuditRecorder,
  AiTextAuditContext,
  AiTextAuditLink,
  GameApiAuditMode,
} from "../server/ai/textAuditTypes";
import { generatePendingScene } from "../generatePendingScene";
import { buildSceneGenerationContext } from "../sceneGenerationContext";
import { approveScenePerformance } from "../approveAndWriteScene";
import {
  battleVictoryRequiresWorldEvolution,
  prewarmBattleVictoryScene,
  type BattleScenePrewarm,
} from "./battleScenePrewarm";
import { createDeterministicSceneSource } from "../deterministicSceneSource";
import { commitState } from "../stateCommit";
import { buildChoiceMap } from "../buildChoiceMap";
import type { StoryState } from "@/game/domain/storyState";
import type { Action, Interaction } from "@/game/domain/action";
import type { GameSessionView } from "../gameSessionView";
import type { GameTypeId, GameLength, GameSetup } from "@/game/domain/newGame";
import { deriveEndingSessionIdentity, matchesEndingSessionIdentity } from "./endingSessionIdentity";
import { BackgroundEnsureCoordinator } from "./ai/_shared/ensureCoordinator";

export type { RequestLogContext };

/**
 * 规则结果已经完全确定、应在同一个 action 请求中完成场景写回的动作。
 * investigate 与 move/take_item 一样不需要等待后台场景编排；若遗漏，
 * action 响应会先返回 pending，客户端只能通过轮询短暂看到等待层。
 */
export function shouldCompleteSceneInAction(action: Pick<Action, "type"> | undefined): boolean {
  return action?.type === "move"
    || action?.type === "take_item"
    || action?.type === "investigate";
}

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
    request?: Request,
  ): Promise<Response>;
  close(): Promise<void>;
};

/** Stable trigger values for canonical API routes. */
const ROUTE_TRIGGERS: Readonly<Record<string, string>> = {
  "/api/game": "create_game",
  "/api/game/actions": "perform_turn",
  "/api/game/current": "get_current_game",
  "/api/game/narrative/ensure": "ensure_narrative_scene",
  "/api/game/prologue/ack": "ack_prologue",
  "/api/game/dev/current": "dev_current",
};

const POLLING_AUDIT_ROUTES = new Set([
  "/api/game/current",
  "/api/game/narrative/ensure",
]);

function resolveGameApiDetail(
  mode: GameApiAuditMode | undefined,
  route: string,
): "compact" | "full" | undefined {
  if (mode === "off") return undefined;
  if (mode === "full" || !POLLING_AUDIT_ROUTES.has(route)) return "full";
  return "compact";
}

/** Best-effort JSON parse; returns undefined on failure. */
function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

const SENSITIVE_AUDIT_KEY = /^(?:api[_-]?key|authorization|cookie|set-cookie|baseurl|url|endpoint|access[_-]?token|secret|password)$/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function sanitizeAuditText(text: string): string {
  return text.replace(URL_PATTERN, "[REDACTED_URL]");
}

function sanitizeAuditValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeAuditText(value);
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = SENSITIVE_AUDIT_KEY.test(key) ? "[REDACTED]" : sanitizeAuditValue(nested);
  }
  return result;
}

function sanitizeAuditBody(
  rawBody: string | null,
  parsed: unknown,
): { readonly rawBody: string | null; readonly json?: unknown } {
  if (rawBody === null) return { rawBody: null };
  if (parsed !== undefined) {
    const json = sanitizeAuditValue(parsed);
    return { rawBody: JSON.stringify(json), json };
  }
  return { rawBody: sanitizeAuditText(rawBody) };
}

/** Record a game_api audit event. Best-effort, never throws. */
async function recordGameApiExchange(
  audit: AiTextAuditRecorder | undefined,
  route: string,
  method: string,
  traceId: string | undefined,
  requestRawBody: string | null,
  requestJson: unknown,
  requestHasBody: boolean,
  responseRawBody: string | null,
  responseJson: unknown,
  responseHasBody: boolean,
  httpStatus: number,
  durationMs: number,
  errorName?: string,
): Promise<void> {
  const detail = resolveGameApiDetail(audit?.gameApiMode, route);
  if (audit === undefined || detail === undefined) return;
  const trigger = ROUTE_TRIGGERS[route] ?? route;
  const context: AiTextAuditContext = {
    purpose: "game_api",
    trigger,
    ...(traceId !== undefined ? { traceId } : {}),
  };
  try {
    if (detail === "compact") {
      await audit!.record({
        kind: "game_api",
        detail,
        route,
        method,
        context,
        request: { hasBody: requestHasBody },
        response: {
          hasBody: responseHasBody,
          ...(errorName !== undefined ? { errorName } : {}),
        },
        httpStatus,
        durationMs,
      });
      return;
    }

    const safeRequest = sanitizeAuditBody(requestRawBody, requestJson);
    const safeResponse = sanitizeAuditBody(responseRawBody, responseJson);
    await audit.record({
      kind: "game_api",
      detail,
      route,
      method,
      context,
      request: safeRequest,
      response: {
        ...safeResponse,
        ...(errorName !== undefined ? { errorName } : {}),
      },
      httpStatus,
      durationMs,
    });
  } catch {
    // best-effort: never throw
  }
}

export function createServerGameEntryPoints(
  env: Record<string, string | undefined> = process.env,
  externalAuditRecorder?: AiTextAuditRecorder,
): ServerGameEntryPoints {
  const logRuntime = createServerLogRuntime(env);
  const { logger } = logRuntime;
  // Create the audit recorder before the AI client so it can be injected.
  const auditRecorder = externalAuditRecorder ?? createTextAuditRecorder(env, {
    onWriteFailure: () => logger.warn("ai_text_audit_write_failed", {}),
    onConfigIssue: (code) => logger.warn("ai_text_audit_config_issue", { code }),
  });
  const repository = createSqliteGameRepository({
    clientFactory: createServerSqliteClientFactory(env),
    logError: (operation) => logger.error("sqlite_repository_failure", { operation }),
  });
  const now = () => new Date().toISOString();
  const aiConfig = parseAiRuntimeConfig(env);
  const aiEnabled = aiConfig.status === "available";
  // One provider transport/client per server composition root. Role policy,
  // thinking mode, budgets, and transient retries are centralized there.
  const aiClient = createServerRpgAiClient(env, logger, auditRecorder);
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
      auditLink: { gameId: String(record.gameId) },
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
  const ensureBattleScenePrewarm = (
    record: Parameters<typeof prewarmBattleVictoryScene>[0],
    traceId?: string,
  ): void => {
    const battle = record.worldState.battle;
    if (battle.status !== "active" || battle.battleKey === undefined) return;
    if (battleScenePrewarmCache.has(battle.battleKey) || battleScenePrewarmPromises.has(battle.battleKey)) return;
    // 先把无网络的战后提案放进内存，确保玩家无论战斗多快结束，都不会
    // 因 live provider 的慢响应在胜利后看到“正在处理”。live 结果回来后
    // 会覆盖 fallback，并在最后一击前优先使用 generated。
    void ensureBattleSceneFallback(record);
    const promise = prewarmBattleVictoryScene(record, {
      sceneSource,
      logger,
      now,
      auditLink: { gameId: String(record.gameId), ...(traceId === undefined ? {} : { traceId }) },
    })
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
  const applyPrewarmedBattleScene = async (
    record: Parameters<typeof prewarmBattleVictoryScene>[0],
    prewarm: BattleScenePrewarm,
    auditLink?: AiTextAuditLink,
  ): Promise<boolean> => {
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
    // Record the prewarmed story_text audit event.
    if (auditRecorder.enabled) {
      const summary = context.job.actionSummary;
      const trigger = summary.kind === "battle_action" ? "battle_action" : "explore_action";
      try {
        await auditRecorder.record({
          kind: "story_text",
          context: {
            purpose: "final_story_text",
            trigger,
            gameId: record.gameId,
            jobId: context.job.jobId,
            actionId: context.job.actionId,
            turnNumber: context.job.turnNumber,
            revision: record.revision + 1,
            action: context.job.actionSummary,
            ...(auditLink?.traceId !== undefined ? { traceId: auditLink.traceId } : {}),
          },
          source: approved.scene.source,
          path: "prewarmed",
          scene: approved.scene,
          visibleText: {
            narration: approved.scene.narration,
            npcLine: approved.scene.npcLine,
            npcDialogues: approved.scene.npcDialogues,
            choices: approved.scene.choices,
          },
        });
      } catch {
        // best-effort: audit write failure never blocks the game flow
        logger.warn("ai_text_audit_write_failed", {});
      }
    }
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
        const applied = await applyPrewarmedBattleScene(current.record, prewarm, { traceId });
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
    run: (traceId?: string) => generatePendingScene({
      repository,
      sceneSource,
      worldEvolutionSource,
      logger,
      allowDeterministicFallback: true,
      now,
      textAuditRecorder: auditRecorder,
      ...(traceId !== undefined ? { auditLink: { traceId } } : {}),
    }),
    logKey: "runtime_narrative_task",
    logger,
  });

  const executeHttpRequest = async (
    method: string,
    route: string,
    handler: (context: RequestLogContext) => Promise<Response>,
    incomingTraceId?: string,
    request?: Request,
  ): Promise<Response> => {
    const context = createRequestLogContext({ method, route, traceId: incomingTraceId });
    const apiAuditDetail = resolveGameApiDetail(auditRecorder.gameApiMode, route);
    const shouldCaptureApiBodies = apiAuditDetail === "full";
    const requestHasBody = request !== undefined && request.body !== null;
    logger.info("http_request_started", {
      traceId: context.traceId,
      scope: "request",
      source: `rpg.http.${method.toLowerCase()}.${route}`,
      method,
      route,
    });

    // Read request body for audit (best-effort)
    let requestRawBody: string | null = null;
    let requestJson: unknown = undefined;
    if (request !== undefined && shouldCaptureApiBodies) {
      try {
        requestRawBody = await request.clone().text();
        if (requestRawBody.length > 0) {
          requestJson = tryParseJson(requestRawBody);
        }
      } catch {
        // best-effort: leave null
      }
    }

    try {
      const response = await handler(context);

      // Read response body for audit (best-effort)
      let responseRawBody: string | null = null;
      let responseJson: unknown = undefined;
      const responseHasBody = response.body !== null;
      if (shouldCaptureApiBodies) {
        try {
          const cloned = response.clone();
          responseRawBody = await cloned.text();
          if (responseRawBody.length > 0) {
            responseJson = tryParseJson(responseRawBody);
          }
        } catch {
          // best-effort: leave null
        }
      }

      // Record the game_api exchange
      await recordGameApiExchange(
        auditRecorder,
        route,
        method,
        context.traceId,
        requestRawBody,
        requestJson,
        requestHasBody,
        responseRawBody,
        responseJson,
        responseHasBody,
        response.status,
        Date.now() - context.startedAtMs,
      );

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
      const errorName = error instanceof Error ? error.name : "UnknownError";

      // Record the game_api exchange with error
      await recordGameApiExchange(
        auditRecorder,
        route,
        method,
        context.traceId,
        requestRawBody,
        requestJson,
        requestHasBody,
        null,
        undefined,
        false,
        500,
        Date.now() - context.startedAtMs,
        errorName,
      );

      logger.error("http_request_failed", {
        traceId: context.traceId,
        scope: "request",
        source: `rpg.http.${method.toLowerCase()}.${route}`,
        method,
        route,
        durationMs: Date.now() - context.startedAtMs,
        errorName,
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
        {
          repository,
          source,
          now,
          aiEnabled,
          ...(traceId === undefined ? {} : { auditLink: { traceId } }),
        },
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
        {
          repository,
          now,
          worldEvolutionSource,
          intentParserSource,
          allowDeterministicWorldEvolutionFallback: true,
          auditLink: { gameId: String(current.record.gameId), traceId },
        },
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
            ensureBattleScenePrewarm(readyRecord, traceId);
          }
          // 目标已锁定的一键移动、规则已完全确定的拾取动作，以及结束战斗的
          // 最后一击，不应该再经历“先完成动作、再等 AI 编排”的两段等待。
          // 战斗开始时已并行准备 API 与确定性战后提案；最后一击只使用已在
          // 内存中的提案写回，普通战斗回合仍保持低延迟规则路径。
          if (view.narrativeGeneration.status === "pending") {
            const shouldCompleteSynchronously = shouldCompleteSceneInAction(submittedAction);
            const resolvedBattle = readyRecord.worldState.battle;
            const isVictoryAction = submittedAction?.type === "battle_action"
              && resolvedBattle.status === "resolved"
              && resolvedBattle.outcome === "victory"
              && resolvedBattle.battleKey !== undefined;
            let battlePrewarmPending = false;
            let victoryNeedsNormalGeneration = false;
            if (isVictoryAction) {
              victoryNeedsNormalGeneration = battleVictoryRequiresWorldEvolution(readyRecord);
              if (victoryNeedsNormalGeneration) {
                // 胜利刚刚完成主线目标时，预热提案仍基于战斗中的旧实体集合；
                // 必须走完整 pending-scene 编排，让 world evolution 先具象化
                // 下一幕/结局对，再生成并审批对应场景。
                battleScenePrewarmCache.delete(resolvedBattle.battleKey);
                const evolvedSceneResult = await generatePendingScene({
                  repository,
                  sceneSource,
                  worldEvolutionSource,
                  logger,
                  allowDeterministicFallback: true,
                  now,
                  textAuditRecorder: auditRecorder,
                  auditLink: { traceId, gameId: readyRecord.gameId },
                });
                if (evolvedSceneResult === "saved") {
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
                // fallback 提案在战斗开始时并行准备；若玩家极快结束战斗，
                // 这里仅等待本地确定性计算（通常为毫秒级），绝不等待 API。
                let prewarm = battleScenePrewarmCache.get(resolvedBattle.battleKey);
                if (prewarm === undefined) {
                  prewarm = await ensureBattleSceneFallback(readyRecord) ?? undefined;
                }
                if (prewarm !== undefined) {
                  const usedPrewarm = await applyPrewarmedBattleScene(readyRecord, prewarm, { traceId, gameId: readyRecord.gameId });
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
            }
            if (shouldCompleteSynchronously) {
              const immediateSceneResult = await generatePendingScene({
                repository,
                sceneSource,
                worldEvolutionSource,
                logger,
                allowDeterministicFallback: true,
                now,
                textAuditRecorder: auditRecorder,
                auditLink: { traceId, gameId: readyRecord.gameId },
              });
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
            // 普通胜利若 live/fallback 预热仍未返回，交给预热 promise 接管；
            // 需要世界演化的胜利若同步编排未完成，则立即走 coordinator 恢复。
            if (
              view.narrativeGeneration.status === "pending"
              && !battlePrewarmPending
              && (!isVictoryAction || victoryNeedsNormalGeneration)
            ) {
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
      // Stop accepting the runtime's remaining background work before closing
      // repository/log resources or the audit ledger. Prewarm promises are not
      // owned by BackgroundEnsureCoordinator, so drain both maps explicitly.
      await narrativeCoordinator.waitForIdle();
      await Promise.allSettled([
        ...battleScenePrewarmPromises.values(),
        ...battleSceneFallbackPromises.values(),
      ]);
      try {
        await repository.close();
      } finally {
        try {
          await auditRecorder.close();
        } finally {
          await logRuntime.close();
        }
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
