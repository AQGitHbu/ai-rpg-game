import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleClearDevelopmentGameRequest } from "./developmentGameHandler";

/** DELETE /api/game/dev/current：只在 development 环境清除当前本地试玩存档。 */
export async function DELETE(request: Request): Promise<Response> {
  const entryPoints = getServerGameEntryPoints();
  return entryPoints.executeHttpRequest(
    "DELETE",
    "/api/game/dev/current",
    (context) => handleClearDevelopmentGameRequest(entryPoints, context),
    request.headers.get("x-request-trace-id") ?? undefined
  );
}
