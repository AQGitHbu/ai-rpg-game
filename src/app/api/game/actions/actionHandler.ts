import {
  asFactId,
  asLocationId,
  asNpcId,
  type PerformActionResult,
  type PlayerIntent
} from "@/game/application";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// POST /api/game/actions 的 HTTP adapter（Phase 3 Task 4）。
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

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** 顶层允许的字段：intent + revision，其余一律拒收。 */
const ALLOWED_TOP_FIELDS: ReadonlySet<string> = new Set(["intent", "revision"]);

/** intent 允许的字段（按 type 区分）：type + 对应 targetId。 */
const ALLOWED_INTENT_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "locationId",
  "npcId",
  "factId"
]);

const VALID_INTENT_TYPES: ReadonlySet<string> = new Set([
  "observe",
  "talk",
  "investigate"
]);

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
    return { ok: false, detail: "intent.type 必须是 observe/talk/investigate 之一" };
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
    default:
      return { ok: false, detail: "未知 intent.type" };
  }
}

export async function handlePerformActionRequest(
  request: Request,
  entryPoints: Pick<ServerGameEntryPoints, "performAction">
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json(400, { code: "MALFORMED_JSON" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json(400, { code: "MALFORMED_JSON" });
  }
  const body = parsed as Record<string, unknown>;

  // 顶层白名单外字段一律拒收。
  const unexpected = Object.keys(body)
    .filter((key) => !ALLOWED_TOP_FIELDS.has(key))
    .sort();
  if (unexpected.length > 0) {
    return json(400, { code: "UNEXPECTED_FIELDS", fields: unexpected });
  }

  // 校验 revision。
  const revision = body["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return json(400, { code: "INVALID_INTENT", detail: "revision 必须是非负整数" });
  }

  // 校验 intent。
  const intentResult = parseIntent(body["intent"]);
  if (!intentResult.ok) {
    return json(400, { code: "INVALID_INTENT", detail: intentResult.detail });
  }

  let result: PerformActionResult;
  try {
    result = await entryPoints.performAction({
      intent: intentResult.intent,
      expectedRevision: revision
    });
  } catch {
    return json(500, { code: "INTERNAL_ERROR" });
  }

  if (result.ok) {
    return json(200, { view: result.view, feedback: result.feedback });
  }

  switch (result.code) {
    case "ACTION_REJECTED":
      return json(200, {
        code: result.code,
        view: result.view,
        feedback: result.feedback
      });
    case "STALE_GAME_REVISION":
      return json(409, { code: result.code, view: result.view });
    case "NO_ACTIVE_GAME":
      return json(404, { code: result.code });
    case "CORRUPT_GAME":
      return json(500, { code: result.code });
    case "INFRASTRUCTURE_FAILURE":
      return json(503, { code: result.code });
  }
}
