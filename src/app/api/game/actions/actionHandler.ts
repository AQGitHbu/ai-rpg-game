import {
  asEnemyId,
  asFactId,
  asItemId,
  asLocationId,
  asNpcId,
  type PerformActionResult,
  type PlayerIntent
} from "@/game/application";
import type {
  RequestLogContext,
  ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// POST /api/game/actions 的 HTTP adapter（Phase 3 Task 4 + Phase 4 Task 4）。
// 只做参数/响应映射，无业务逻辑。route.ts 保持薄壳注入生产单例。
//
// 请求体只接受 { intent: { type, ...targetId }, revision }，
// 拒绝未知字段（freeText、seed、gameId、state、blueprint、actionLabel 等）。
//
// 状态码映射（响应只含稳定代码与安全 body，绝无 SQL/state/seed/异常文本）：
//   200 { view, feedback }                     —— 成功
//   200 { code: "ACTION_REJECTED", view, feedback } —— 规则拒绝（不写入）
//   409 { code: "STALE_GAME_REVISION", view }  —— 版本冲突
//   404 { code: "NO_ACTIVE_GAME" }             —— 无存档
//   500 { code: "CORRUPT_GAME" }               —— 存档损坏
//   503 { code: "INFRASTRUCTURE_FAILURE" }     —— 基础设施失败
//   400 { code: "MALFORMED_JSON" }             —— JSON 不合法
//   400 { code: "UNEXPECTED_FIELDS", fields }  —— 出现允许字段之外的字段
//   400 { code: "INVALID_INTENT", detail }     —— intent 结构不对
//   500 { code: "INTERNAL_ERROR" }             —— facade 契约外抛错兜底
// ---------------------------------------------------------------------------

function json(status: number, body: unknown, context?: RequestLogContext): Response {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string") context?.markResultCode(code);
  }
  return Response.json(body, { status });
}

/** 顶层允许的字段：intent + revision，其余一律拒收。 */
const ALLOWED_TOP_FIELDS: ReadonlySet<string> = new Set(["intent", "revision"]);

/** intent 允许的字段（按 type 区分）：type + 对应 targetId/action。 */
const ALLOWED_INTENT_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "locationId",
  "npcId",
  "factId",
  "itemId",
  "enemyId",
  "action",
  "choiceToken"
]);

const VALID_INTENT_TYPES: ReadonlySet<string> = new Set([
  "observe",
  "talk",
  "investigate",
  "move",
  "take_item",
  "start_battle",
  "battle_action",
  "narrative_choice",
  "ack_prologue"
]);

/** battle_action 允许的 action 值。 */
const VALID_BATTLE_ACTIONS: ReadonlySet<string> = new Set(["attack", "guard", "withdraw"]);

/** 每种 intent 唯一允许的目标字段：携带其他目标字段（伪造载荷）一律拒收。 */
const INTENT_TARGET_FIELD: Readonly<Record<string, readonly string[]>> = {
  observe: ["locationId"],
  talk: ["npcId"],
  investigate: ["factId"],
  move: ["locationId"],
  take_item: ["itemId"],
  start_battle: ["enemyId"],
  battle_action: ["action"],
  narrative_choice: ["choiceToken"],
  ack_prologue: []
};

/** 从原始 JSON 构造 PlayerIntent；校验失败返回错误详情。 */
function parseIntent(raw: unknown):
  | { readonly ok: true; readonly intent: PlayerIntent }
  | { readonly ok: false; readonly detail: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, detail: "intent 必须是对象" };
  }
  const obj = raw as Record<string, unknown>;

  // 白名单外字段一律拒收。
  const unexpected = Object.keys(obj)
    .filter((key) => !ALLOWED_INTENT_FIELDS.has(key))
    .sort();
  if (unexpected.length > 0) {
    return { ok: false, detail: `intent 含未知字段：${unexpected.join(", ")}` };
  }

  const type = obj["type"];
  if (typeof type !== "string" || !VALID_INTENT_TYPES.has(type)) {
    return { ok: false, detail: "intent.type 必须是 observe/talk/investigate/move/take_item/start_battle/battle_action/narrative_choice/ack_prologue 之一" };
  }

  // 除 type + 本类型目标字段外，携带其他目标字段（如 take_item 附带 locationId）一律拒收。
  const targetFields = INTENT_TARGET_FIELD[type];
  const extraTargets = Object.keys(obj)
    .filter((key) => key !== "type" && !targetFields.includes(key))
    .sort();
  if (extraTargets.length > 0) {
    return { ok: false, detail: `${type} 不接受字段：${extraTargets.join(", ")}` };
  }

  switch (type) {
    case "observe": {
      const locationId = obj["locationId"];
      if (typeof locationId !== "string" || locationId.length === 0) {
        return { ok: false, detail: "observe 需要 locationId 字符串" };
      }
      return { ok: true, intent: { type: "observe", locationId: asLocationId(locationId) } };
    }
    case "talk": {
      const npcId = obj["npcId"];
      if (typeof npcId !== "string" || npcId.length === 0) {
        return { ok: false, detail: "talk 需要 npcId 字符串" };
      }
      return { ok: true, intent: { type: "talk", npcId: asNpcId(npcId) } };
    }
    case "investigate": {
      const factId = obj["factId"];
      if (typeof factId !== "string" || factId.length === 0) {
        return { ok: false, detail: "investigate 需要 factId 字符串" };
      }
      return { ok: true, intent: { type: "investigate", factId: asFactId(factId) } };
    }
    case "move": {
      const locationId = obj["locationId"];
      if (typeof locationId !== "string" || locationId.length === 0) {
        return { ok: false, detail: "move 需要 locationId 字符串" };
      }
      return { ok: true, intent: { type: "move", locationId: asLocationId(locationId) } };
    }
    case "take_item": {
      const itemId = obj["itemId"];
      if (typeof itemId !== "string" || itemId.length === 0) {
        return { ok: false, detail: "take_item 需要 itemId 字符串" };
      }
      return { ok: true, intent: { type: "take_item", itemId: asItemId(itemId) } };
    }
    case "start_battle": {
      const enemyId = obj["enemyId"];
      if (typeof enemyId !== "string" || enemyId.length === 0) {
        return { ok: false, detail: "start_battle 需要 enemyId 字符串" };
      }
      return { ok: true, intent: { type: "start_battle", enemyId: asEnemyId(enemyId) } };
    }
    case "battle_action": {
      const action = obj["action"];
      if (typeof action !== "string" || !VALID_BATTLE_ACTIONS.has(action)) {
        return { ok: false, detail: "battle_action.action 必须是 attack/guard/withdraw 之一" };
      }
      return {
        ok: true,
        intent: { type: "battle_action", action: action as "attack" | "guard" | "withdraw" }
      };
    }
    case "ack_prologue": {
      // Phase 14：幂等标记 intent，无参数。
      return { ok: true, intent: { type: "ack_prologue" } };
    }
    case "narrative_choice": {
      const choiceToken = obj["choiceToken"];
      if (typeof choiceToken !== "string" || choiceToken.length === 0) {
        return { ok: false, detail: "narrative_choice 需要 choiceToken 字符串" };
      }
      return { ok: true, intent: { type: "narrative_choice", choiceToken } };
    }
    default:
      return { ok: false, detail: "未知 intent.type" };
  }
}

export async function handlePerformActionRequest(
  request: Request,
  entryPoints: Pick<ServerGameEntryPoints, "performAction">,
  context?: RequestLogContext
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(400, { code: "MALFORMED_JSON" }, context);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json(400, { code: "MALFORMED_JSON" }, context);
  }
  const body = parsed as Record<string, unknown>;

  // 顶层白名单外字段一律拒收。
  const unexpected = Object.keys(body)
    .filter((key) => !ALLOWED_TOP_FIELDS.has(key))
    .sort();
  if (unexpected.length > 0) {
    return json(400, { code: "UNEXPECTED_FIELDS", fields: unexpected }, context);
  }

  // 校验 revision。
  const revision = body["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return json(400, { code: "INVALID_INTENT", detail: "revision 必须是非负整数" }, context);
  }

  // 校验 intent。
  const intentResult = parseIntent(body["intent"]);
  if (!intentResult.ok) {
    return json(400, { code: "INVALID_INTENT", detail: intentResult.detail }, context);
  }

  let result: PerformActionResult;
  try {
    result = await entryPoints.performAction({
      intent: intentResult.intent,
      expectedRevision: revision
    }, context?.traceId);
  } catch {
    return json(500, { code: "INTERNAL_ERROR" }, context);
  }

  if (result.ok) {
    return json(200, { view: result.view, feedback: result.feedback }, context);
  }

  switch (result.code) {
    case "ACTION_REJECTED":
      return json(200, {
        code: result.code,
        view: result.view,
        feedback: result.feedback
      }, context);
    case "STALE_GAME_REVISION":
      return json(409, { code: result.code, view: result.view }, context);
    case "NO_ACTIVE_GAME":
      return json(404, { code: result.code }, context);
    case "CORRUPT_GAME":
      return json(500, { code: result.code }, context);
    case "INFRASTRUCTURE_FAILURE":
      return json(503, { code: result.code }, context);
  }
}
