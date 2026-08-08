import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";
import { parseV2DialogueRequest, httpStatusForV2Code } from "@/game/application/http/v2RequestParser";

// POST /api/v2/game/npc/dialogue：NPC 自由对话。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/npc/dialogue",
    async () => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Task 10：严格解析；禁止 `as never` 把原始 body 送入 use case。
      const parsed = parseV2DialogueRequest(body);
      if (!parsed.ok) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: httpStatusForV2Code("INVALID_INPUT"),
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.handleNpcDialogueV2({
        npcId: parsed.npcId,
        text: parsed.text,
        expectedRevision: parsed.expectedRevision,
      });
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : httpStatusForV2Code(result.code),
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
