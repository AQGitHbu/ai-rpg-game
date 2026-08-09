import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";

// POST /api/game/prologue/ack：确认序幕。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/prologue/ack",
    async () => {
      const result = await entryPoints.ackPrologue();
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
