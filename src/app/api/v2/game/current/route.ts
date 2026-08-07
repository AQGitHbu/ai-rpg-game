import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

// GET /api/v2/game/current：V2 并行路由——委托 gameSessionViewV2。
// V1 路由 /api/game/current 保持不动，互不干扰。
export async function GET(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "GET",
    "/api/v2/game/current",
    async () => {
      const result = await entryPoints.getCurrentGameV2();
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
