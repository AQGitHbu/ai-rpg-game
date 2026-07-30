import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleEnsureNarrativeRequest } from "./ensureNarrativeHandler";

export async function POST(): Promise<Response> {
  return handleEnsureNarrativeRequest(getServerGameEntryPoints());
}
