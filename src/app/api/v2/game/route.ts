import { getServerGameV2EntryPoints, type CreateGameV2HttpInput } from "@/game/application/server/compositionRootV2";

// POST /api/v2/game：V2 并行路由——委托 createGameV2。
// V1 路由 /api/game 保持不动，互不干扰。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game",
    async () => {
      let body: { gameType: string; gameLength: string };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (typeof body.gameType !== "string" || typeof body.gameLength !== "string") {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 契约外只做类型收窄断言，枚举合法性由域层校验（与 V1 createGameHandler 同一约定）。
      const result = await entryPoints.createGameV2({
        gameType: body.gameType as CreateGameV2HttpInput["gameType"],
        gameLength: body.gameLength as CreateGameV2HttpInput["gameLength"],
      });
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
