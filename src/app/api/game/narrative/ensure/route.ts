import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { parseEnsureNarrativeBody, httpStatusForCode } from "@/game/application/requestParser";

function statusForEnsureFailure(result: { readonly code?: string; readonly failureKind?: string }): number {
  if (result.code === "AI_GENERATION_FAILED" && result.failureKind === "AI_RESPONSE_INVALID") return 502;
  return httpStatusForCode(result.code);
}

// POST /api/game/narrative/ensure：轮询 pending 叙事；{ retry: true } 才恢复 failed job。
export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/narrative/ensure",
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
      const parsed = parseEnsureNarrativeBody(body);
      if (!parsed.ok) {
        return new Response(JSON.stringify(parsed), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result = await entryPoints.ensureNarrativeScene(
        parsed.retry === true ? { retry: true } : {},
        request.headers.get("x-request-trace-id") ?? undefined,
      );
      return new Response(JSON.stringify(result), {
        status: result.ok ? 200 : statusForEnsureFailure(result),
        headers: { "Content-Type": "application/json" },
      });
    },
    request.headers.get("x-request-trace-id") ?? undefined,
    request,
  );
}
