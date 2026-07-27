import type { GameSessionView } from "@/game/application";

// ---------------------------------------------------------------------------
// POST /api/game/actions 的共享客户端请求模块（Phase 4 Task 4）。
// SceneActionPanel 与 TravelPanel 共用同一套 payload 构造、响应解析与
// 错误码 → 可读消息映射，保证两个面板的反馈行为一致。
// 只发往本地 /api/game/actions，不出现任何 AI/外部网络请求。
// ---------------------------------------------------------------------------

/** 客户端允许提交的行动 payload：intent + revision，别无其他字段。 */
export type GameActionPayload =
  | { readonly intent: { readonly type: "observe"; readonly locationId: string }; readonly revision: number }
  | { readonly intent: { readonly type: "talk"; readonly npcId: string }; readonly revision: number }
  | { readonly intent: { readonly type: "investigate"; readonly factId: string }; readonly revision: number }
  | { readonly intent: { readonly type: "move"; readonly locationId: string }; readonly revision: number };

/** 请求结果的稳定四态：成功 / 规则拒绝 / 版本冲突 / 其他错误。 */
export type GameActionOutcome =
  | { readonly kind: "success"; readonly view: GameSessionView; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "stale" }
  | { readonly kind: "error"; readonly message: string };

type ActionApiResponse = {
  readonly view?: GameSessionView;
  readonly feedback?: { readonly ok: boolean; readonly message: string };
  readonly code?: string;
};

/** 错误码映射为可读消息（与 Phase 3 SceneActionPanel 的文案一致）。 */
const ERROR_MESSAGES: Record<string, string> = {
  NO_ACTIVE_GAME: "没有可用的存档，请刷新页面。",
  CORRUPT_GAME: "存档数据已损坏，请刷新页面。",
  INFRASTRUCTURE_FAILURE: "本地服务暂时不可用，请稍后重试。",
  MALFORMED_JSON: "请求格式错误，请刷新页面。",
  UNEXPECTED_FIELDS: "请求包含未知字段，请刷新页面。",
  INVALID_INTENT: "行动意图不合法，请刷新页面。",
  INTERNAL_ERROR: "服务器内部错误，请稍后重试。"
};

export async function postGameAction(payload: GameActionPayload): Promise<GameActionOutcome> {
  try {
    const response = await fetch("/api/game/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const body = (await response.json().catch(() => null)) as ActionApiResponse | null;

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { kind: "error", message: "服务器返回了无法解析的响应，请重试。" };
    }

    // 成功或规则拒绝：body 含 view + feedback（拒绝时 view 不变，不写入）。
    if (body.view !== undefined && body.feedback !== undefined) {
      if (body.feedback.ok) {
        return { kind: "success", view: body.view, message: body.feedback.message };
      }
      return { kind: "rejected", message: body.feedback.message };
    }

    // 版本冲突：调用方触发重新请求 current-game。
    if (body.code === "STALE_GAME_REVISION") {
      return { kind: "stale" };
    }

    return { kind: "error", message: ERROR_MESSAGES[body.code ?? ""] ?? "未知错误，请重试。" };
  } catch {
    return { kind: "error", message: "网络异常，请检查连接后重试。" };
  }
}
