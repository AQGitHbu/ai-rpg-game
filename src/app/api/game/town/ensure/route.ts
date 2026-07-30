import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleEnsureTownRequest } from "./ensureTownHandler";

export async function POST(): Promise<Response> {
  return handleEnsureTownRequest(getServerGameEntryPoints());
}
