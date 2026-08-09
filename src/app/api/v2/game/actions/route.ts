import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";
import { parseV2ActionRequest, httpStatusForV2Code } from "@/game/application/http/v2RequestParser";

// POST /api/v2/game/actions：固定选项与 NPC 自定义输入的唯一 V2 行动入口。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameV2EntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/v2/game/actions",
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
      // Task 10：严格 discriminated union 解析，禁止 `as never` 把原始 body 送入 use case。
      const parsed = parseV2ActionRequest(body);
      if (!parsed.ok) {
        return new Response(JSON.stringify({ ok: false, code: "INVALID_INPUT" }), {
          status: httpStatusForV2Code("INVALID_INPUT"),
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.performTurnV2({
        actionId: parsed.actionId,
        interaction: parsed.interaction,
        expectedRevision: parsed.expectedRevision,
      });
      if (result.ok) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Task 10：按稳定业务语义映射 HTTP 状态，不再把一切失败统一映射为 409。
      return new Response(JSON.stringify(result), {
        status: httpStatusForV2Code(result.code),
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
  );
}
