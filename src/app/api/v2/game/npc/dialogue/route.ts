import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

// POST /api/v2/game/npc/dialogue：NPC 自由对话。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/npc/dialogue",
    async () => {
      let body: { npcId: string; text: string; expectedRevision: number };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (typeof body.npcId !== "string" || typeof body.text !== "string" || typeof body.expectedRevision !== "number") {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.handleNpcDialogueV2({
        npcId: body.npcId as never,
        text: body.text,
        expectedRevision: body.expectedRevision,
      });
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : 409,
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
