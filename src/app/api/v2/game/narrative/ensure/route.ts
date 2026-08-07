import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

// POST /api/v2/game/narrative/ensure：轮询并生成 pending 叙事场景。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/narrative/ensure",
    async () => {
      const result = await entryPoints.ensureNarrativeSceneV2();
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
