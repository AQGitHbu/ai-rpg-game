import type {
  RequestLogContext,
  ServerGameEntryPoints
} from "@/game/application/server/compositionRoot";

function response(
  status: number,
  body: { readonly status: string },
  context?: RequestLogContext
): Response {
  context?.markResultCode(body.status);
  return Response.json(body, { status });
}

export async function handleEnsureTownRequest(
  entryPoints: Pick<ServerGameEntryPoints, "ensureTownGeneration">,
  context?: RequestLogContext
): Promise<Response> {
  try {
    const result = await entryPoints.ensureTownGeneration(context?.traceId);
    if (result === "queued" || result === "already_running") {
      return response(202, { status: "pending" }, context);
    }
    if (result === "not_pending") {
      return response(200, { status: "ready" }, context);
    }
    return response(503, { status: "unavailable" }, context);
  } catch {
    return response(503, { status: "unavailable" }, context);
  }
}
