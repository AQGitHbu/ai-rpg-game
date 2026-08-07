import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

// POST /api/v2/game/prologue/ack：确认序幕。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/prologue/ack",
    async () => {
      const result = await entryPoints.ackPrologueV2();
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
