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

export async function postV2Action(payload: V2ActionPayload): Promise<V2ActionOutcome> {
  try {
    const response = await fetch("/api/v2/game/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionId: `act_${Date.now()}`,
        interaction: payload.interaction,
        expectedRevision: payload.revision,
      }),
    });

    const body = (await response.json().catch(() => null)) as V2ActionResponse | null;

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "error", message: "服务器返回了无法解析的响应。" };
    }

    if (body.ok === true && body.view !== undefined) {
      return { kind: "success", view: body.view, message: body.feedback ?? "操作成功" };
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
  | { readonly kind: "narrative_trigger"; readonly revision: number }
  | { readonly kind: "error"; readonly message: string };

export async function postV2Dialogue(npcId: string, text: string, revision: number): Promise<V2DialogueResult> {
  try {
    const response = await fetch("/api/v2/game/npc/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ npcId, text, expectedRevision: revision }),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean; kind?: string; npcSpeech?: string; revision?: number; code?: string;
    } | null;
    if (body?.ok === true && body.kind === "chat") {
      return { kind: "chat", npcSpeech: body.npcSpeech ?? "...", revision: body.revision ?? revision };
    }
    if (body?.ok === true && body.kind === "narrative_trigger") {
      return { kind: "narrative_trigger", revision: body.revision ?? revision };
    }
    return { kind: "error", message: "对话失败。" };
  } catch {
    return { kind: "error", message: "网络异常。" };
  }
}
