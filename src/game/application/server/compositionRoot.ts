import { randomUUID } from "node:crypto";
import {
  createRequestLogContext,
  createServerLogRuntime,
  type RequestLogContext,
} from "@/game/logging/serverConsoleLogger";
import { asGameId, type GameId, type GameRepository } from "./persistence/gameRepository";
import { createServerSqliteClientFactory, type SqliteClient } from "./persistence/sqliteClient";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";
import { createSqliteNarrativeJobs } from "./persistence/sqliteNarrativeJobs";
import type {
  NarrativeJobRepository,
  StoredJob,
} from "./persistence/narrativeJobRepository";
import { createGame as createGameUseCase } from "../createGame";
import { performTurn } from "../performTurn";
import { projectGameSessionView } from "../gameSessionView";
import { createStageSource } from "../server/ai/sourceFactory";
import { createServerRpgAiClient } from "../server/ai/rpgAiClient";
import { parseAiRuntimeConfig } from "../server/ai/aiRuntimeConfig";
import { createTextAuditRecorder } from "../server/ai/textAuditRecorder";
import type {
  AiTextAuditRecorder,
  AiTextAuditContext,
  GameApiAuditMode,
} from "../server/ai/textAuditTypes";
import { generatePendingNarrativeBundle } from "../generatePendingNarrativeBundle";
import {
  projectInitializationView,
  type InitializationStatus,
  type InitializationView,
} from "../initializationStatus";
import {
  startInitialization,
  runInitialization,
  queryInitialization,
  controlInitialization,
} from "../narrativeGeneration/initializationJob";
import type { StageSource } from "../narrativeGeneration/stageSource";
import { commitState } from "../stateCommit";
import { buildChoiceMap } from "../buildChoiceMap";
import type { StoryState } from "@/game/domain/storyState";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import type { Interaction } from "@/game/domain/action";
import type { GameSessionView } from "../gameSessionView";
import type { GameTypeId, GameLength, GameSetup, NewGameInput } from "@/game/domain/newGame";
import { asGenerationId } from "@/game/domain/worldEntity";
import { deriveEndingSessionIdentity, matchesEndingSessionIdentity } from "./endingSessionIdentity";
import { BackgroundEnsureCoordinator } from "./ai/_shared/ensureCoordinator";
import { retryNarrativeGeneration } from "../retryNarrativeGeneration";
import type { AiRetryOrigin } from "./ai/textAuditTypes";

export type { RequestLogContext };

// ---------------------------------------------------------------------------
// 双状态模型的唯一 server-only 装配点。
// ---------------------------------------------------------------------------

/** HTTP 开局输入：核心收 gameType/gameLength，gameId 与 seed 由服务端装配。
 *  requestId 必填——它是持久初始化任务的幂等键，路由层已做形状校验。
 *  setup 为路由层已经通过 validateNewGameInput 的开局配置，
 *  世界生成源必须消费它（角色名/身份/世界观/故事开端）。 */
export type CreateGameHttpInput = {
  readonly requestId: string;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly restart?: { readonly identity: string; readonly expectedRevision: number };
  readonly setup?: GameSetup;
};

type PerformTurnEntryPointResult =
  | { readonly ok: true; readonly revision: number; readonly feedback: string; readonly view: GameSessionView }
  | { readonly ok: false; readonly code: string; readonly feedback?: string };

export type EnsureNarrativeOptions = { readonly retry?: true };
export type EnsureNarrativeEntryPointResult =
  | { readonly ok: true; readonly result: "queued" | "already_running" | "not_pending" }
  | {
      readonly ok: false;
      readonly code: "INVALID_INPUT" | "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "AI_GENERATION_FAILED" | "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" | "INFRASTRUCTURE_FAILURE";
      readonly failureKind?: AiFailureKind;
    };

/** 创建开局入口结果：202 语义由路由层映射（保留 view 供 200/409 复用判断）。 */
export type CreateGameEntryPointResult =
  | { readonly ok: true; readonly httpStatus: 200 | 202; readonly view: InitializationView }
  | { readonly ok: false; readonly code: string; readonly failureKind?: AiFailureKind };

export type InitializationEntryPointResult =
  | { readonly ok: true; readonly view: InitializationStatus }
  | { readonly ok: false; readonly code: string };

export type ControlInitializationEntryPointResult =
  | { readonly ok: true; readonly view: InitializationView }
  | { readonly ok: false; readonly code: string };

export type ServerGameEntryPoints = {
  createGame(input: CreateGameHttpInput, traceId?: string): Promise<CreateGameEntryPointResult>;
  getInitialization(requestId?: string, traceId?: string): Promise<InitializationEntryPointResult>;
  controlInitialization(
    input: { readonly requestId: string; readonly operation: "retry" | "cancel" },
    traceId?: string,
  ): Promise<ControlInitializationEntryPointResult>;
  performTurn(command: {
    actionId: string;
    interaction: Interaction;
    expectedRevision: number;
  }, traceId?: string): Promise<PerformTurnEntryPointResult>;
  getCurrentGame(traceId?: string): Promise<{ ok: boolean; status: string; view?: GameSessionView; revision?: number }>;
  ensureNarrativeScene(options?: EnsureNarrativeOptions, traceId?: string): Promise<EnsureNarrativeEntryPointResult>;
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
  "/api/game/initialization": "initialization_task",
  "/api/game/narrative/ensure": "ensure_narrative_scene",
  "/api/game/prologue/ack": "ack_prologue",
  "/api/game/dev/current": "dev_current",
};

const POLLING_AUDIT_ROUTES = new Set([
  "/api/game/current",
  "/api/game/initialization",
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
  retryOrigin?: AiRetryOrigin,
): Promise<void> {
  const detail = resolveGameApiDetail(audit?.gameApiMode, route);
  if (audit === undefined || detail === undefined) return;
  const trigger = ROUTE_TRIGGERS[route] ?? route;
  const context: AiTextAuditContext = {
    purpose: "game_api",
    trigger,
    ...(traceId !== undefined ? { traceId } : {}),
    ...(retryOrigin === undefined ? {} : { retry: { origin: retryOrigin, mechanism: "initial", attempt: 0 } }),
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
  externalRepository?: GameRepository & { close(): Promise<void> },
): ServerGameEntryPoints {
  const logRuntime = createServerLogRuntime(env);
  const { logger } = logRuntime;
  // Create the audit recorder before the AI client so it can be injected.
  const auditRecorder = externalAuditRecorder ?? createTextAuditRecorder(env, {
    onWriteFailure: () => logger.warn("ai_text_audit_write_failed", {}),
    onConfigIssue: (code) => logger.warn("ai_text_audit_config_issue", { code }),
  });
  // 测试缝隙：外部调用方可注入内存/桩 repository，便于在组合层直接锁定
  // "retry body → failed→pending CAS → 恰好一次 coordinator" 的组合断言。
  //
  // 共享 SQLite 连接：GameRepository 与 NarrativeJobRepository 必须共享同一
  // client——publish 要在同一 write transaction 内写游戏状态并标记任务已发布。
  // 记忆化工厂保证两者拿到同一连接实例。
  const baseClientFactory = createServerSqliteClientFactory(env);
  let sharedClient: SqliteClient | null = null;
  const sharedClientFactory = (): SqliteClient => {
    if (sharedClient === null) sharedClient = baseClientFactory();
    return sharedClient;
  };
  const repository = externalRepository ?? createSqliteGameRepository({
    clientFactory: sharedClientFactory,
    logError: (operation) => logger.error("sqlite_repository_failure", { operation }),
  });
  // 分阶段生成是唯一生产链路的任务仓储：初始化与决策共享同一张 narrative_jobs 表。
  const jobs = createSqliteNarrativeJobs({
    client: sharedClientFactory(),
    logError: (context, error) => logger.error("sqlite_narrative_jobs_failure", { context, error: String(error) }),
  });
  const now = () => new Date().toISOString();
  const aiConfig = parseAiRuntimeConfig(env);
  const aiEnabled = aiConfig.status === "available";
  // One provider transport/client per server composition root. Role policy,
  // thinking mode, budgets, and transient retries are centralized there.
  const aiClient = createServerRpgAiClient(env, logger, auditRecorder);
  // Unified source is the only runtime AI entry point for opening and decisions:
  // staged StageSource（每 stage 恰好一次 provider 调用）。旧整包源不再参与生产装配。
  const stageSource = createStageSource(env, logger, aiClient);

  // 初始化任务的后台执行：与决策共用 coordinator 去重，key 是 job id。
  const initializationCoordinator = new BackgroundEnsureCoordinator({
    loadPending: async () => {
      const slot = await jobs.getInitialization();
      if (!slot.ok) return { ok: false, result: "unavailable" };
      if (slot.value === null) return { ok: false, result: "not_pending" };
      if (slot.value.status !== "pending") return { ok: false, result: "not_pending" };
      return { ok: true, key: `init:${slot.value.id}` };
    },
    run: async (traceId?: string) => {
      const slot = await jobs.getInitialization();
      if (!slot.ok || slot.value === null) return "not_pending";
      const result = await runInitialization(slot.value.id, "init-worker", {
        jobs,
        source: stageSource,
        now,
        signal: new AbortController().signal,
        createdAt: now(),
      });
      if (!result.ok) {
        logger.warn("initialization_run_failed", { code: result.code, traceId });
        return "failed";
      }
      return "completed";
    },
    logKey: "runtime_initialization_task",
    logger,
  });

  const narrativeCoordinator = new BackgroundEnsureCoordinator({
    loadPending: async () => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, result: "unavailable" };
      if (current.status !== "active") return { ok: false, result: "not_pending" };
      const generation = current.record.storyState.narrative;
      if (generation.status === "provider_failed") return { ok: false, result: "failed" };
      if (generation.status !== "provider_pending") return { ok: false, result: "not_pending" };
      return {
        ok: true,
        key: `${current.record.gameId}:${generation.job.jobId}`,
      };
    },
    run: (traceId?: string, origin: AiRetryOrigin = "normal") => generatePendingNarrativeBundle({
      repository,
      jobs,
      source: stageSource,
      now,
      logger,
      auditLink: {
        ...(traceId !== undefined ? { traceId } : {}),
        retry: { origin, mechanism: "initial", attempt: 0 },
      },
    }).then((result) => {
      if (result.ok) return;
      // Best-effort: log failure but don't throw to avoid coordinator crash
      logger?.warn("narrative_bundle_generation_failed", {
        code: result.code,
        ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
      });
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

    // Task 5：为 /api/game/narrative/ensure 推断审计 retry 来源。不保存原始
    // body，也不依赖 handler 已消费的 body——通过 request.clone() 只读取布尔
    // retry，用于在 compact 事件 context.retry 区分普通轮询与手动失败重试。
    let auditRetryOrigin: AiRetryOrigin | undefined;
    if (route === "/api/game/narrative/ensure") {
      try {
        // 无 body / request 为 undefined 的普通轮询同样写 origin=normal，
        // 而不是省略 context.retry；仅当解析出布尔 retry===true 才标记手动重试。
        const retryBody = request === undefined ? "" : await request.clone().text();
        const parsedRetry = retryBody.length > 0 ? tryParseJson(retryBody) : undefined;
        auditRetryOrigin = parsedRetry !== undefined
          && typeof parsedRetry === "object"
          && parsedRetry !== null
          && (parsedRetry as Record<string, unknown>).retry === true
          ? "manual_failed_job"
          : "normal";
      } catch {
        // best-effort：无法读取时收敛为普通轮询来源，不阻塞审计也不泄露 body。
        auditRetryOrigin = "normal";
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
        undefined,
        auditRetryOrigin,
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
        auditRetryOrigin,
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

  /**
   * 触发一次后台初始化执行：经 coordinator 去重（同一 job 只跑一次），
   * 不等待 provider。返回 queued/already_running 视为已受理；failed/unavailable
   * 不算提交失败（任务已持久化，可经 GET 恢复），但把 durable 失败如实上报。
   */
  const scheduleInitializationRun = async (
    job: StoredJob,
    traceId?: string,
  ): Promise<{ ok: true } | { ok: false; code: string }> => {
    const result = await initializationCoordinator.ensure(
      traceId,
      job.initialization === null ? undefined : { origin: "normal" },
    );
    if (result === "unavailable") return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    return { ok: true };
  };

  return {
    createGame: async (input, traceId) => {
      // 首次开局也必须初始化游戏表；任务仓储只拥有任务表，发布事务不会建游戏表。
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      // restart 合法性先行校验：不通过就不创建任何持久任务。
      let replaceCurrent: { readonly expectedGameId: GameId; readonly expectedRevision: number } | undefined;
      if (input.restart !== undefined) {
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

      // requestId 必填已由路由层校验；requestId 相同即同一任务（幂等），
      // 服务器单槽 CAS 防止多 tab 并发覆写。
      const gameId = asGameId(randomUUID());
      const generationSeed = randomUUID();
      const started = await startInitialization(
        {
          requestId: input.requestId,
          gameId,
          gameType: input.gameType,
          gameLength: input.gameLength,
          seed: generationSeed,
          generation: {
            generationId: asGenerationId(`gen_${generationSeed}`),
            seed: generationSeed,
            templateVersion: "v2",
            inputDigest: "",
            gameType: input.gameType,
            ...(input.setup === undefined ? {} : { setup: input.setup }),
          },
          ...(input.setup === undefined ? {} : { setup: input.setup }),
          target: replaceCurrent === undefined
            ? { kind: "create" }
            : {
                kind: "replace",
                expectedGameId: String(replaceCurrent.expectedGameId),
                expectedRevision: replaceCurrent.expectedRevision,
                endingIdentity: input.restart?.identity ?? "",
              },
          now,
        },
        jobs,
      );
      if (!started.ok) {
        return { ok: false, code: started.code };
      }

      // 已发布：直接返回 200 视图，不重复调度。
      if (started.job.status === "published") {
        return {
          ok: true,
          httpStatus: 200,
          view: projectInitializationView(started.job, started.job.initialization!.requestId),
        };
      }

      // 未发布：返回 202 视图，并异步启动（或刷新）后台执行。
      // replace 目标必须原样进入发布载荷的 CAS，因此随 run 一起注入。
      const scheduled = await scheduleInitializationRun(started.job, traceId);
      if (!scheduled.ok) return { ok: false, code: scheduled.code };
      return {
        ok: true,
        httpStatus: 202,
        view: projectInitializationView(started.job, started.job.initialization!.requestId),
      };
    },
    getInitialization: async (requestId, _traceId) => {
      const slot = await queryInitialization(jobs);
      if (!slot.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      if (slot.value === null) {
        return { ok: true, view: { status: "none" } satisfies InitializationStatus };
      }
      // requestId query 只读指定任务；不匹配时按 none 处理，不泄露其他任务状态。
      const job = slot.value;
      const storedRequestId = job.initialization?.requestId;
      if (storedRequestId === undefined) return { ok: true, view: { status: "none" } };
      if (requestId !== undefined && requestId !== storedRequestId) {
        return { ok: true, view: { status: "none" } };
      }
      return { ok: true, view: projectInitializationView(job, storedRequestId) };
    },
    controlInitialization: async (command, traceId) => {
      const slot = await queryInitialization(jobs);
      if (!slot.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      if (slot.value === null) return { ok: false, code: "JOB_NOT_FOUND" };
      const job = slot.value;
      const storedRequestId = job.initialization?.requestId;
      if (storedRequestId === undefined || storedRequestId !== command.requestId) {
        return { ok: false, code: "JOB_NOT_FOUND" };
      }
      const controlled = await controlInitialization({
        jobId: job.id,
        operation: command.operation,
        expectedVersion: job.version,
        expectedCycle: job.cycle,
        now: now(),
      }, jobs);
      if (!controlled.ok) {
        return { ok: false, code: controlled.code === "JOB_CONFLICT" ? "JOB_CONFLICT" : "INFRASTRUCTURE_FAILURE" };
      }
      if (command.operation === "retry" && controlled.value.status === "pending") {
        const scheduled = await scheduleInitializationRun(controlled.value, traceId);
        if (!scheduled.ok) return { ok: false, code: scheduled.code };
      }
      return { ok: true, view: projectInitializationView(controlled.value, storedRequestId) };
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
      const result = await performTurn(
        { gameId: current.record.gameId, actionId: command.actionId, interaction: command.interaction, expectedRevision: command.expectedRevision, choiceMap },
        {
          repository,
          now,
          auditLink: { gameId: String(current.record.gameId), traceId },
        },
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
    ensureNarrativeScene: async (options = {}, traceId) => {
      const current = await repository.getCurrentGame();
      if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      if (current.status === "none") return { ok: false, code: "NO_ACTIVE_GAME" };
      if (current.status === "corrupt") return { ok: false, code: "INFRASTRUCTURE_FAILURE" };

      if (options.retry === true) {
        const retried = await retryNarrativeGeneration(repository, current.record.gameId, now);
        if (!retried.ok) return retried;
        if (retried.result === "requeued" || retried.result === "already_pending") {
          const queued = await narrativeCoordinator.ensure(traceId, { origin: "manual_failed_job" });
          if (queued === "failed") {
            const latest = await repository.getCurrentGame();
            if (latest.ok && latest.status === "active" && latest.record.storyState.narrative.status === "provider_failed") {
              const failureKind = latest.record.storyState.narrative.failure.kind;
              return { ok: false, code: "AI_GENERATION_FAILED", failureKind };
            }
            return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          }
          if (queued === "unavailable") return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          return { ok: true, result: queued === "not_pending" ? "not_pending" : queued };
        }
      }

      const generation = current.record.storyState.narrative;
      if (generation.status === "provider_failed") {
        return { ok: false, code: "AI_GENERATION_FAILED", failureKind: generation.failure.kind };
      }
      const result = await narrativeCoordinator.ensure(traceId);
      if (result === "failed") {
        const latest = await repository.getCurrentGame();
        if (latest.ok && latest.status === "active" && latest.record.storyState.narrative.status === "provider_failed") {
          return {
            ok: false,
            code: "AI_GENERATION_FAILED",
            failureKind: latest.record.storyState.narrative.failure.kind,
          };
        }
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
      if (result === "unavailable") return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      return { ok: true, result };
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
      // repository/log resources or the audit ledger.
      await narrativeCoordinator.waitForIdle();
      await initializationCoordinator.waitForIdle();
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
