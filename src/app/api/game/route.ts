import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleCreateGameRequest } from "./createGameHandler";

// POST /api/game：薄壳 route——只把生产单例入口注入 adapter，
// 参数校验与状态码映射全部在 createGameHandler（可注入测试）。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game",
    (context) => handleCreateGameRequest(request, entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}
