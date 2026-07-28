import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** 开发专用 HTTP adapter：生产环境使用 404，不能以请求方式绕过 UI 隐藏。 */
export async function handleClearDevelopmentGameRequest(
  entryPoints: Pick<ServerGameEntryPoints, "developmentToolsEnabled" | "clearDevelopmentCurrentGame">
): Promise<Response> {
  if (!entryPoints.developmentToolsEnabled) {
    return json(404, { code: "NOT_FOUND" });
  }
  try {
    const result = await entryPoints.clearDevelopmentCurrentGame();
    if (result === "cleared" || result === "none") return json(200, { status: result });
    if (result === "disabled") return json(404, { code: "NOT_FOUND" });
    return json(503, { code: "INFRASTRUCTURE_FAILURE" });
  } catch {
    return json(503, { code: "INFRASTRUCTURE_FAILURE" });
  }
}
