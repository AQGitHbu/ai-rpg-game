import type { ServerGameEntryPoints } from "@/game/application/server/compositionRoot";

export async function handleEnsureNarrativeRequest(
  entryPoints: Pick<ServerGameEntryPoints, "ensureNarrativeGeneration">,
): Promise<Response> {
  try {
    const result = await entryPoints.ensureNarrativeGeneration();
    if (result === "queued" || result === "already_running") {
      return Response.json({ status: "pending" }, { status: 202 });
    }
    if (result === "not_pending") {
      return Response.json({ status: "ready" }, { status: 200 });
    }
    return Response.json({ status: "unavailable" }, { status: 503 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
