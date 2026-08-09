import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// POST /api/game/narrative/ensure：轮询并生成 pending 叙事场景。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/narrative/ensure",
    async () => {
      const result = await entryPoints.ensureNarrativeScene();
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
