import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser";
import { createIntentParserSource } from "./liveIntentParserSource";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import { createServerRpgAiClient, type RpgAiClient } from "./rpgAiClient";

// ---------------------------------------------------------------------------
// Composition 工厂：@ai-game/ai-transport 只允许出现在 application/server/ai
// （dependencyBoundaries 专项守卫）。composition root 将同一个 RpgAiClient
// 注入这里，独立工厂调用时才按需创建 client。
// ---------------------------------------------------------------------------

export function createServerIntentParserSource(
  env: Record<string, string | undefined> = process.env,
  aiClient?: RpgAiClient,
): IntentParserSource {
  const aiConfig = parseAiRuntimeConfig(env);
  const client = aiClient ?? createServerRpgAiClient(env);
  if (aiConfig.status !== "available" || client === undefined) return createIntentParserSource(env);
  return createIntentParserSource(
    env,
    undefined,
    aiConfig.outputFormat === "json_object" ? "json_object" : "prompt_only",
    client,
  );
}
