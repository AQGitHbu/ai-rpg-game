import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";

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
  );
}
