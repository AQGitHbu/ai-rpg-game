import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleEnsureNarrativeRequest } from "./ensureNarrativeHandler";

export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/narrative/ensure",
    (context) => handleEnsureNarrativeRequest(entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}
