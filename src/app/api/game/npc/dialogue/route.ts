import { getServerGameEntryPoints } from "@/game/application/server/compositionRoot";
import { handleNpcDialogueRequest } from "./dialogueHandler";

// POST /api/game/npc/dialogue：薄壳 route——只把生产单例入口注入 adapter，
// 参数校验与状态码映射全部在 dialogueHandler（可注入测试）。
export async function POST(request: Request): Promise<Response> {
  return handleNpcDialogueRequest(request, getServerGameEntryPoints());
}
