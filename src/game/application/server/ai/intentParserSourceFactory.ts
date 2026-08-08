import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import { createV2IntentParserSource } from "./liveIntentParserSourceV2";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";

// ---------------------------------------------------------------------------
// Composition 工厂：@ai-game/ai-transport 只允许出现在 application/server/ai
// （dependencyBoundaries 专项守卫）。composition root 不得直接导入 transport，
// 因此这里的工厂在 server/ai 内完成 transport 构建并委托 liveIntentParserSourceV2。
// ---------------------------------------------------------------------------

export function createServerV2IntentParserSource(
  env: Record<string, string | undefined> = process.env,
): IntentParserSource {
  const aiConfig = parseAiRuntimeConfig(env);
  if (aiConfig.status !== "available") return createV2IntentParserSource(env);
  return createV2IntentParserSource(env, createOpenAiCompatibleTransport());
}