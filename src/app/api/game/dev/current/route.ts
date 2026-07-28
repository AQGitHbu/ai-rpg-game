import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleClearDevelopmentGameRequest } from "./developmentGameHandler";

/** DELETE /api/game/dev/current：只在 development 环境清除当前本地试玩存档。 */
export async function DELETE(): Promise<Response> {
  return handleClearDevelopmentGameRequest(getServerGameEntryPoints());
}
