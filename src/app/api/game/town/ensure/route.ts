import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleEnsureTownRequest } from "./ensureTownHandler";

export async function POST(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "POST",
    "/api/game/town/ensure",
    (context) => handleEnsureTownRequest(entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}
