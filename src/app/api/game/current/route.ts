import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleCurrentGameRequest } from "./currentGameHandler";

// GET /api/game/current：薄壳 route——只注入生产单例入口，
// 结果映射全部在 currentGameHandler（可注入测试）。
export async function GET(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "GET",
    "/api/game/current",
    (context) => handleCurrentGameRequest(entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}
