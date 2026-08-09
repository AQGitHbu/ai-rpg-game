import { getServerGameEntryPoints, type CreateGameHttpInput } from "@/game/application/server/compositionRoot";

// POST /api/game：V2 并行路由——委托 createGame。
// V1 路由 /api/game 保持不动，互不干扰。
// 接受完整 NewGameInput（与 V1 表单兼容），但 V2 目前只使用 gameType + gameLength。
// 额外字段（角色名、世界观等）保留供未来 AI 世界生成器使用。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game",
    async () => {
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 只校验 V2 必需字段；额外字段（characterName 等）透传但当前不使用。
      if (typeof body.gameType !== "string" || typeof body.gameLength !== "string") {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 契约外只做类型收窄断言，枚举合法性由域层校验（与 V1 createGameHandler 同一约定）。
      const result = await entryPoints.createGame({
        gameType: body.gameType as CreateGameHttpInput["gameType"],
        gameLength: body.gameLength as CreateGameHttpInput["gameLength"],
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
