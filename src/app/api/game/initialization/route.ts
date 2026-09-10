import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { isValidRequestId } from "@/game/application/initializationStatus";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTROL_ALLOWED_KEYS = new Set(["requestId", "operation"]);

function statusForCode(code: string): number {
  switch (code) {
    case "JOB_NOT_FOUND": return 404;
    case "INVALID_INPUT": return 400;
    case "JOB_CONFLICT": return 409;
    default: return 503;
  }
}

// GET /api/game/initialization：读取当前初始化槽的安全状态；无任务返回 none。
// 可选 ?requestId= 只读指定任务；不匹配按 none 处理。不自动重试失败任务。
export async function GET(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "GET",
    "/api/game/initialization",
    async () => {
      const requestId = new URL(request.url).searchParams.get("requestId") ?? undefined;
      if (requestId !== undefined && !isValidRequestId(requestId)) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.getInitialization(requestId ?? undefined);
      if (!result.ok) {
        return new Response(JSON.stringify({ ok: false, code: result.code }), {
          status: statusForCode(result.code),
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, ...result.view }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
    request,
  );
}

// POST /api/game/initialization：{requestId, operation:"retry"|"cancel"}。
// retry 只恢复同任务；cancel 使在途结果失效。exact-key 校验，未知字段 400。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/initialization",
    async () => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!isRecord(body)) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!Object.keys(body).every((key) => CONTROL_ALLOWED_KEYS.has(key))) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!isValidRequestId(body.requestId)
        || (body.operation !== "retry" && body.operation !== "cancel")) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.controlInitialization({
        requestId: body.requestId,
        operation: body.operation,
      });
      if (!result.ok) {
        return new Response(JSON.stringify({ ok: false, code: result.code }), {
          status: statusForCode(result.code),
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, ...result.view }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
    request,
  );
}
