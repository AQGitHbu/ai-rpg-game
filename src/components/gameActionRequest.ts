import type { GameSessionView } from "@/game/application";
import type { AiFailureKind } from "@/game/application";
import type { InitializationStatus, InitializationView } from "@/game/application";

// ---------------------------------------------------------------------------
// POST /api/game/actions 的客户端请求模块。
// 服务端构建 choiceMap，客户端只发送 choiceToken + revision。
// ---------------------------------------------------------------------------

/** 玩家可提交的交互：固定选项（choiceToken）或自由文本（含目标 NPC）。 */
export type PlayerInteraction =
  | { readonly kind: "fixed_choice"; readonly choiceToken: string }
  | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId: string };

export type ActionPayload = {
  readonly interaction: PlayerInteraction;
  readonly revision: number;
};

export type ActionOutcome =
  | { readonly kind: "success"; readonly view: GameSessionView; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "ai-failure"; readonly message: string; readonly failureKind: AiFailureKind; readonly interaction: PlayerInteraction }
  | { readonly kind: "stale" }
  | { readonly kind: "error"; readonly message: string };

type ActionResponse = {
  readonly ok?: boolean;
  readonly revision?: number;
  readonly view?: GameSessionView;
  readonly feedback?: string;
  readonly code?: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  NO_ACTIVE_GAME: "没有可用的存档，请刷新页面。",
  INFRASTRUCTURE_FAILURE: "本地服务暂时不可用，请稍后重试。",
  STALE_GAME_REVISION: "版本冲突，请刷新页面。",
  ACTION_REJECTED: "行动被拒绝。",
  UNKNOWN_CHOICE: "选项无效，请刷新页面。",
  AI_CALL_FAILED: "AI 调用失败，请重试。",
  AI_RESPONSE_INVALID: "AI 返回格式不符合要求，请重试。",
  NARRATIVE_CONTINUATION_MISSING: "当前行动没有可消费的预备叙事。",
  NARRATIVE_CONTINUATION_INVALID: "预备叙事已失效，请刷新或重新开始。",
};

/**
 * actionId 生成器：浏览器使用 crypto.randomUUID()（Task 10，Spec §16.2）。
 * 测试环境可注入确定性 fallback；禁止用 Date.now() 作为唯一 actionId。
 */
function defaultActionIdGenerator(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 极旧/非安全上下文兜底：保持 UUID v4 形状，使服务端仍可执行同一严格契约。
  // 现代浏览器总会走上方 crypto.randomUUID；此分支只用于兼容和测试环境。
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (marker) => {
    const random = Math.floor(Math.random() * 16);
    const value = marker === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

let actionIdGenerator: () => string = defaultActionIdGenerator;

/** 测试注入：返回当前 actionId 生成器。 */
export function getActionIdGenerator(): () => string {
  return actionIdGenerator;
}

/** 测试注入：设置确定性 actionId 生成器。 */
export function setActionIdGenerator(generator: () => string): void {
  actionIdGenerator = generator;
}

export async function postAction(payload: ActionPayload): Promise<ActionOutcome> {
  try {
    const response = await fetch("/api/game/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionId: actionIdGenerator(),
        interaction: payload.interaction,
        expectedRevision: payload.revision,
      }),
    });

    const body = (await response.json().catch(() => null)) as ActionResponse | null;

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "error", message: "服务器返回了无法解析的响应。" };
    }

    if (body.ok === true) {
      if (body.view !== undefined) {
        return { kind: "success", view: body.view, message: body.feedback ?? "操作成功" };
      }
      return { kind: "error", message: "操作成功但无法获取最新状态。" };
    }

    if (body.ok === false) {
      if (body.code === "STALE_GAME_REVISION") return { kind: "stale" };
      if (body.code === "AI_CALL_FAILED" || body.code === "AI_RESPONSE_INVALID") {
        return {
          kind: "ai-failure",
          message: ERROR_MESSAGES[body.code],
          failureKind: body.code,
          interaction: payload.interaction,
        };
      }
      const msg = ERROR_MESSAGES[body.code ?? ""] ?? body.feedback ?? "未知错误。";
      return { kind: "rejected", message: msg };
    }

    return { kind: "error", message: "未知响应格式。" };
  } catch {
    return { kind: "error", message: "网络异常，请检查连接后重试。" };
  }
}

/** GET /api/game/current 的响应类型。 */
export type CurrentGameResponse = {
  readonly ok: boolean;
  readonly status: string;
  readonly view?: GameSessionView;
  readonly revision?: number;
  readonly code?: string;
};

export async function fetchCurrentGame(): Promise<CurrentGameResponse> {
  try {
    const response = await fetch("/api/game/current");
    const body = (await response.json().catch(() => null)) as CurrentGameResponse | null;
    if (body === null) return { ok: false, status: "error" };
    return body;
  } catch {
    return { ok: false, status: "error" };
  }
}

/** POST /api/game/narrative/ensure — 轮询场景生成。 */
export type EnsureNarrativeOutcome =
  | { readonly ok: true; readonly result: "queued" | "already_running" | "not_pending" }
  | {
      readonly ok: false;
      readonly code: "INVALID_INPUT" | "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "AI_GENERATION_FAILED" | "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" | "NARRATIVE_CONTINUATION_MISSING" | "NARRATIVE_CONTINUATION_INVALID" | "INFRASTRUCTURE_FAILURE";
      readonly failureKind?: AiFailureKind;
    };

export async function ensureNarrative(options?: { readonly retry?: true }): Promise<EnsureNarrativeOutcome> {
  try {
    const response = await fetch("/api/game/narrative/ensure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options?.retry === true ? { retry: true } : {}),
    });
    const body = (await response.json().catch(() => null)) as EnsureNarrativeOutcome | null;
    if (body !== null && typeof body === "object" && "ok" in body) return body;
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  } catch {
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
}

export async function retryNarrative(): Promise<EnsureNarrativeOutcome> {
  return ensureNarrative({ retry: true });
}

/** POST /api/game/prologue/ack — 确认序幕。 */
export async function ackPrologue(): Promise<boolean> {
  try {
    const response = await fetch("/api/game/prologue/ack", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 初始化任务（Plan 2026-09-09 / Task 11）。
//
// 服务器初始化槽是唯一权威：客户端只读安全状态、只发控制操作。
// 网络失败必须与「服务器没有任务」区分 —— 否则 UI 会把暂时不可达的
// 恢复路径误报成「可以重新开局」，从而创建出第二个任务并重复计费。
// ---------------------------------------------------------------------------

export type InitializationRequestOutcome =
  | { readonly ok: true; readonly view: InitializationStatus }
  | { readonly ok: false; readonly message: string };

const INITIALIZATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  JOB_NOT_FOUND: "初始化任务不存在或已失效。",
  INVALID_INPUT: "请求参数无效。",
  JOB_CONFLICT: "初始化任务状态已变化，请刷新后重试。",
  INFRASTRUCTURE_FAILURE: "本地服务暂时不可用，请稍后重试。",
};

const INITIALIZATION_STATUSES: ReadonlySet<string> = new Set([
  "pending", "failed", "published", "cancelled",
]);

/** 只接受服务端投影允许的字段；任何多余或畸形字段都视为不可解析。 */
function asInitializationView(body: Record<string, unknown>): InitializationView | null {
  if (typeof body.requestId !== "string" || body.requestId === "") return null;
  if (typeof body.status !== "string" || !INITIALIZATION_STATUSES.has(body.status)) return null;
  return {
    requestId: body.requestId,
    status: body.status as InitializationView["status"],
    ...(typeof body.failureKind === "string" ? { failureKind: body.failureKind as AiFailureKind } : {}),
    ...(typeof body.revision === "number" ? { revision: body.revision } : {}),
  };
}

function parseInitializationResponse(body: unknown): InitializationRequestOutcome {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "服务器返回了无法解析的响应。" };
  }
  const record = body as Record<string, unknown>;
  if (record.ok === true) {
    if (record.status === "none") return { ok: true, view: { status: "none" } };
    const view = asInitializationView(record);
    return view === null
      ? { ok: false, message: "服务器返回了无法解析的响应。" }
      : { ok: true, view };
  }
  const code = typeof record.code === "string" ? record.code : "";
  return {
    ok: false,
    message: INITIALIZATION_ERROR_MESSAGES[code] ?? "初始化任务读取失败，请稍后重试。",
  };
}

/** GET /api/game/initialization：无 requestId 读当前槽；有则只读指定任务。 */
export async function fetchInitialization(requestId?: string): Promise<InitializationRequestOutcome> {
  const url = requestId === undefined
    ? "/api/game/initialization"
    : `/api/game/initialization?requestId=${encodeURIComponent(requestId)}`;
  try {
    const response = await fetch(url, { method: "GET" });
    const body = (await response.json().catch(() => null)) as unknown;
    return parseInitializationResponse(body);
  } catch {
    return { ok: false, message: INITIALIZATION_ERROR_MESSAGES.INFRASTRUCTURE_FAILURE! };
  }
}

async function controlInitialization(
  requestId: string,
  operation: "retry" | "cancel",
): Promise<InitializationRequestOutcome> {
  try {
    const response = await fetch("/api/game/initialization", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, operation }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return parseInitializationResponse(body);
  } catch {
    return { ok: false, message: INITIALIZATION_ERROR_MESSAGES.INFRASTRUCTURE_FAILURE! };
  }
}

/** 同任务重开一次有界尝试周期；绝不创建新任务。 */
export async function retryInitialization(requestId: string): Promise<InitializationRequestOutcome> {
  return controlInitialization(requestId, "retry");
}

/** 令在途结果失效；成功后玩家可以用新 requestId 重新提交开局。 */
export async function cancelInitialization(requestId: string): Promise<InitializationRequestOutcome> {
  return controlInitialization(requestId, "cancel");
}
