import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handlePerformActionRequest } from "./actionHandler";

// POST /api/game/actions：薄壳 route——只把生产单例入口注入 adapter，
// 参数校验与状态码映射全部在 actionHandler（可注入测试）。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/actions",
    (context) => handlePerformActionRequest(request, entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}
