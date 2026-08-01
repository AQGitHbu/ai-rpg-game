import type {
  RequestLogContext,
  ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";

function json(status: number, body: unknown, context?: RequestLogContext): Response {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string") context?.markResultCode(code);
  }
  return Response.json(body, { status });
}

/** 开发专用 HTTP adapter：生产环境使用 404，不能以请求方式绕过 UI 隐藏。 */
export async function handleClearDevelopmentGameRequest(
  entryPoints: Pick<ServerGameEntryPoints, "developmentToolsEnabled" | "clearDevelopmentCurrentGame">,
  context?: RequestLogContext
): Promise<Response> {
  if (!entryPoints.developmentToolsEnabled) {
    return json(404, { code: "NOT_FOUND" }, context);
  }
  try {
    const result = await entryPoints.clearDevelopmentCurrentGame(context?.traceId);
    if (result === "cleared" || result === "none") return json(200, { status: result }, context);
    if (result === "disabled") return json(404, { code: "NOT_FOUND" }, context);
    return json(503, { code: "INFRASTRUCTURE_FAILURE" }, context);
  } catch {
    return json(503, { code: "INFRASTRUCTURE_FAILURE" }, context);
  }
}
