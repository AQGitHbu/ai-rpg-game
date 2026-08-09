import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// DELETE /api/game/dev/current：开发环境清除当前本地试玩存档。
export async function DELETE(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "DELETE",
    "/api/game/dev/current",
    async () => {
      const result = await entryPoints.clearDevelopmentCurrentGame();
      if (result.status === "cleared" || result.status === "none") {
        return new Response(JSON.stringify({ status: result.status }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "NOT_FOUND" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
