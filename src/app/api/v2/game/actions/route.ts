import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";

// POST /api/v2/game/actions：V2 并行路由——委托 performActionV2。
// V1 路由 /api/game/actions 保持不动，互不干扰。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/actions",
    async () => {
      let body: {
        actionId: string;
        interaction: { kind: string; choiceToken?: string; text?: string; targetNpcId?: string };
        expectedRevision: number;
        choiceMap: ReadonlyMap<string, unknown>;
      };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (typeof body.actionId !== "string" || typeof body.expectedRevision !== "number") {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.performActionV2({
        actionId: body.actionId,
        interaction: body.interaction as never,
        expectedRevision: body.expectedRevision,
        choiceMap: body.choiceMap as never,
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
