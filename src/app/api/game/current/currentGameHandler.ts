import type { CurrentGameResult } from "@/game/application";
import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// ---------------------------------------------------------------------------
// GET /api/game/current 的 HTTP adapter（Task 4）：只做结果映射，无业务逻辑。
// 响应恰为三种形态之一，绝不返回 blueprint/state 原始 JSON：
//   200 { status: "none" }
//   200 { status: "active", view }
//   200 { status: "corrupt", reason } —— 真实数据损坏（可显示、可恢复提示）
//   503 { status: "corrupt", reason: "INFRASTRUCTURE_FAILURE" } —— 数据库不可用
//     （含 facade 契约外抛错兜底；body 形态一致，客户端统一按 reason 分支文案）
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

export async function handleCurrentGameRequest(
  entryPoints: Pick<ServerGameEntryPoints, "getCurrentGame">
): Promise<Response> {
  let result: CurrentGameResult;
  try {
    result = await entryPoints.getCurrentGame();
  } catch {
    // 契约外抛错（如投影异常）：对玩家同样是「暂不可用」，异常文本不外泄。
    return json(503, { status: "corrupt", reason: "INFRASTRUCTURE_FAILURE" });
  }
  switch (result.status) {
    case "none":
      return json(200, { status: "none" });
    case "active":
      return json(200, { status: "active", view: result.view });
    case "corrupt":
      return json(result.reason === "INFRASTRUCTURE_FAILURE" ? 503 : 200, {
        status: "corrupt",
        reason: result.reason
      });
  }
}
