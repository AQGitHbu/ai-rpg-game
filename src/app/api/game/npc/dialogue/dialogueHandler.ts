import { asNpcId } from "@/game/application";
import type { HandleNpcDialogueResult } from "@/game/application/index.v1";
import type {
  RequestLogContext,
  ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// POST /api/game/npc/dialogue 的 HTTP adapter（NPC 自由输入）。
// 只做参数/响应映射，无业务逻辑；分类/降级/CAS 编排全部在
// handleNpcDialogue use case。route.ts 保持薄壳注入生产单例。
//
// 请求体只接受 { npcId, text, revision }，拒绝未知字段。
//
// 状态码映射（响应只含稳定代码与安全 body，绝无 SQL/state/seed/异常文本）：
//   200 { kind: "chat", npcSpeech, view }          —— 闲聊回应（零写入）
//   200 { kind: "narrative_trigger", view }        —— 已排队叙事场景
//   200 { code: "ACTION_REJECTED", view, feedback } —— 拒绝（pending 守卫等）
//   409 { code: "STALE_GAME_REVISION", view }      —— 版本冲突
//   404 { code: "NO_ACTIVE_GAME" }                 —— 无存档
//   500 { code: "CORRUPT_GAME" }                   —— 存档损坏
//   503 { code: "INFRASTRUCTURE_FAILURE" }         —— 基础设施失败
//   400 { code: "MALFORMED_JSON" }                 —— JSON 不合法
//   400 { code: "UNEXPECTED_FIELDS", fields }      —— 白名单外字段
//   400 { code: "INVALID_INTENT", detail }         —— 字段结构不对
//   500 { code: "INTERNAL_ERROR" }                 —— facade 契约外抛错兜底
// ---------------------------------------------------------------------------

function json(status: number, body: unknown, context?: RequestLogContext): Response {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string") context?.markResultCode(code);
  }
  return Response.json(body, { status });
}

/** 顶层允许的字段：npcId + text + revision，其余一律拒收。 */
const ALLOWED_TOP_FIELDS: ReadonlySet<string> = new Set(["npcId", "text", "revision"]);

export async function handleNpcDialogueRequest(
  request: Request,
  entryPoints: Pick<ServerGameEntryPoints, "handleNpcDialogue">,
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

  // 校验 npcId。
  const npcId = body["npcId"];
  if (typeof npcId !== "string" || npcId.length === 0) {
    return json(400, { code: "INVALID_INTENT", detail: "npcId 必须是非空字符串" }, context);
  }

  // 校验 text：拒绝空白输入（分类器的短文本规则只处理有内容的短句）。
  const text = body["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    return json(400, { code: "INVALID_INTENT", detail: "text 必须是非空字符串" }, context);
  }

  // 校验 revision。
  const revision = body["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return json(400, { code: "INVALID_INTENT", detail: "revision 必须是非负整数" }, context);
  }

  let result: HandleNpcDialogueResult;
  try {
    result = await entryPoints.handleNpcDialogue({
      npcId: asNpcId(npcId),
      text,
      expectedRevision: revision
    }, context?.traceId);
  } catch {
    return json(500, { code: "INTERNAL_ERROR" }, context);
  }

  if (result.ok) {
    if (result.kind === "chat") {
      return json(200, { kind: result.kind, npcSpeech: result.npcSpeech, view: result.view }, context);
    }
    return json(200, { kind: result.kind, view: result.view }, context);
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
