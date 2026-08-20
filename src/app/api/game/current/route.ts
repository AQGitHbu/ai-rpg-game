import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// 当前存档在每次玩家行动、后台场景写回和结局重开后都会变化。若被 Next
// 静态化，浏览器会继续拿到上一局的快照，导致已创建的新局又显示旧结局。
export const dynamic = "force-dynamic";

// GET /api/game/current：canonical 当前游戏路由，委托 gameSessionView。
export async function GET(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "GET",
    "/api/game/current",
    async () => {
      const result = await entryPoints.getCurrentGame();
      if (result.ok) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(result), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
    request,
  );
}
