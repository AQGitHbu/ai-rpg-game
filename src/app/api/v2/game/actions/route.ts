import { getServerGameV2EntryPoints } from "@/game/application/server/compositionRootV2";
import { parseV2ActionRequest, httpStatusForV2Code } from "@/game/application/http/v2RequestParser";

// POST /api/v2/game/actions：V2 并行路由——委托 performActionV2。
// V1 路由 /api/game/actions 保持不动，互不干扰。
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
      const result = await entryPoints.performActionV2({
        actionId: parsed.actionId,
        interaction: parsed.interaction,
        expectedRevision: parsed.expectedRevision,
        // 服务端从当前存档重建 choiceMap（composition root 内部 buildChoiceMap），
        // 客户端不再发送 actionKey/choiceMap（Spec §8.3）。
        choiceMap: new Map(),
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
