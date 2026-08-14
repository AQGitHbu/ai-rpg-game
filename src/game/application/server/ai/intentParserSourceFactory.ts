import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser";
import { createIntentParserSource } from "./liveIntentParserSource";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";

// ---------------------------------------------------------------------------
// Composition 工厂：@ai-game/ai-transport 只允许出现在 application/server/ai
// （dependencyBoundaries 专项守卫）。composition root 不得直接导入 transport，
// 因此这里的工厂在 server/ai 内完成 transport 构建并委托 liveIntentParserSource。
// ---------------------------------------------------------------------------

export function createServerIntentParserSource(
  env: Record<string, string | undefined> = process.env,
): IntentParserSource {
  const aiConfig = parseAiRuntimeConfig(env);
  if (aiConfig.status !== "available") return createIntentParserSource(env);
  return createIntentParserSource(
    env,
    createOpenAiCompatibleTransport(),
    aiConfig.outputFormat === "json_object" ? "json_object" : "prompt_only",
  );
}
