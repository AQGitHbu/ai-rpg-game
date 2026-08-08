import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";

// ---------------------------------------------------------------------------
// POST /api/v2/game/actions 的 V2 客户端请求模块。
// V2 简化：服务端构建 choiceMap，客户端只发送 choiceToken + revision。
// ---------------------------------------------------------------------------

export type V2ActionPayload =
  | { readonly interaction: { readonly kind: "fixed_choice"; readonly choiceToken: string }; readonly revision: number }
  | { readonly interaction: { readonly kind: "free_text"; readonly text: string; readonly targetNpcId?: string }; readonly revision: number };

export type V2ActionOutcome =
  | { readonly kind: "success"; readonly view: GameSessionViewV2; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "stale" }
  | { readonly kind: "error"; readonly message: string };

type V2ActionResponse = {
  readonly ok?: boolean;
  readonly revision?: number;
  readonly view?: GameSessionViewV2;
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
  // 极旧/非安全上下文兜底：随机数 + 时间戳 + 计数器，仍非唯一时间戳。
  const rand = Math.random().toString(36).slice(2, 10);
  const counter = actionIdCounter++;
  return `act_${rand}_${Date.now().toString(36)}_${counter}`;
}

let actionIdCounter = 0;
let actionIdGenerator: () => string = defaultActionIdGenerator;

/** 测试注入：返回当前 actionId 生成器。 */
export function getActionIdGenerator(): () => string {
  return actionIdGenerator;
}

/** 测试注入：设置确定性 actionId 生成器。 */
export function setActionIdGenerator(generator: () => string): void {
  actionIdGenerator = generator;
}

export async function postV2Action(payload: V2ActionPayload): Promise<V2ActionOutcome> {
  try {
    const response = await fetch("/api/v2/game/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionId: actionIdGenerator(),
        interaction: payload.interaction,
        expectedRevision: payload.revision,
      }),
    });

    const body = (await response.json().catch(() => null)) as V2ActionResponse | null;

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "error", message: "服务器返回了无法解析的响应。" };
    }

    if (body.ok === true) {
      // V2 API returns view in response; if missing, fetch current game
      if (body.view !== undefined) {
        return { kind: "success", view: body.view, message: body.feedback ?? "操作成功" };
      }
      // Fallback: fetch current game to get view
      const currentRes = await fetch("/api/v2/game/current");
      const currentBody = (await currentRes.json().catch(() => null)) as { view?: GameSessionViewV2 } | null;
      if (currentBody?.view !== undefined) {
        return { kind: "success", view: currentBody.view, message: body.feedback ?? "操作成功" };
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

/** GET /api/v2/game/current 的响应类型。 */
export type V2CurrentGameResponse = {
  readonly ok: boolean;
  readonly status: string;
  readonly view?: GameSessionViewV2;
  readonly revision?: number;
  readonly code?: string;
};

export async function fetchV2CurrentGame(): Promise<V2CurrentGameResponse> {
  try {
    const response = await fetch("/api/v2/game/current");
    const body = (await response.json().catch(() => null)) as V2CurrentGameResponse | null;
    if (body === null) return { ok: false, status: "error" };
    return body;
  } catch {
    return { ok: false, status: "error" };
  }
}

/** POST /api/v2/game/narrative/ensure — 轮询场景生成。 */
export async function ensureV2Narrative(): Promise<boolean> {
  try {
    const response = await fetch("/api/v2/game/narrative/ensure", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/** POST /api/v2/game/prologue/ack — 确认序幕。 */
export async function ackV2Prologue(): Promise<boolean> {
  try {
    const response = await fetch("/api/v2/game/prologue/ack", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/** POST /api/v2/game/npc/dialogue — NPC 自由对话。 */
export type V2DialogueResult =
  | { readonly kind: "chat"; readonly npcSpeech: string; readonly revision: number }
  | { readonly kind: "narrative_trigger"; readonly revision: number; readonly view?: GameSessionViewV2 }
  | { readonly kind: "error"; readonly message: string };

export async function postV2Dialogue(npcId: string, text: string, revision: number): Promise<V2DialogueResult> {
  try {
    const response = await fetch("/api/v2/game/npc/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ npcId, text, expectedRevision: revision }),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean; kind?: string; npcSpeech?: string; revision?: number; code?: string; view?: GameSessionViewV2;
    } | null;
    if (body?.ok === true && body.kind === "chat") {
      return { kind: "chat", npcSpeech: body.npcSpeech ?? "...", revision: body.revision ?? revision };
    }
    if (body?.ok === true && body.kind === "narrative_trigger") {
      return { kind: "narrative_trigger", revision: body.revision ?? revision, view: body.view };
    }
    return { kind: "error", message: "对话失败。" };
  } catch {
    return { kind: "error", message: "网络异常。" };
  }
}
