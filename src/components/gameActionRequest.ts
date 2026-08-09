import type { GameSessionView } from "@/game/application";

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
export async function ensureNarrative(): Promise<boolean> {
  try {
    const response = await fetch("/api/game/narrative/ensure", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
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
