import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import type {
  RequestLogContext,
  ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";
import type { PerformActionResult } from "@/game/application";

// ---------------------------------------------------------------------------
// POST /api/game/prologue/ack（Phase 14 Task 6）：薄壳 route——标记序幕已播放。
// 只接受 { revision }，委托 performAction 执行幂等 ack_prologue intent。
// 状态码映射与 /api/game/actions 一致（复用同一 performAction 返回形状）。
// ---------------------------------------------------------------------------

/** 统一的 JSON 响应：记录稳定 code 供请求日志脱敏审计。 */
function json(status: number, body: unknown, context?: RequestLogContext): Response {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string") context?.markResultCode(code);
  }
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/prologue/ack",
    (context) => handlePrologueAckRequest(request, entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}

/** 解析 revision 并委托 performAction 执行幂等 ack_prologue intent。 */
async function handlePrologueAckRequest(
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
  const revision = body["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) {
    return json(400, { code: "INVALID_INTENT", detail: "revision 必须是非负整数" }, context);
  }

  let result: PerformActionResult;
  try {
    result = await entryPoints.performAction(
      { intent: { type: "ack_prologue" }, expectedRevision: revision },
      context?.traceId
    );
  } catch {
    return json(500, { code: "INTERNAL_ERROR" }, context);
  }

  if (result.ok) {
    return json(200, { view: result.view, feedback: result.feedback }, context);
  }

  switch (result.code) {
    case "ACTION_REJECTED":
      return json(200, { code: result.code, view: result.view, feedback: result.feedback }, context);
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
