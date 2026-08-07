import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import type { Action } from "@/game/domain/action";
import { asLocationId, asNpcId, asItemId } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// IntentParserSource：可注入的 AI 意图解析 port。
// 生产环境注入 live source（小模型），测试/离线注入 fixture source。
// ---------------------------------------------------------------------------

export type IntentParserResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unclassifiable" | "service_error" };

export type IntentParserSource = {
  readonly sourceVersion: string;
  parseIntent(text: string, ctx: IntentContext): Promise<IntentParserResult>;
};

// ---------------------------------------------------------------------------
// Fixture：确定性硬编码映射，用于离线测试。
// 策略：按关键词匹配 IntentContext 中的实体名，命中则返回对应 Action。
// ---------------------------------------------------------------------------

export function createFixtureIntentParserSource(): IntentParserSource {
  return {
    sourceVersion: "fixture-intent-v1",
    async parseIntent(text: string, ctx: IntentContext): Promise<IntentParserResult> {
      const trimmed = text.trim();
      if (trimmed.length === 0) return { ok: false, reason: "unclassifiable" };

      // 尝试匹配 NPC 名（无动词要求，AI 路径更宽松）
      for (const npc of ctx.presentNpcs) {
        if (trimmed.includes(npc.name)) {
          return {
            ok: true,
            action: { type: "talk", npcId: asNpcId(npc.id), utterance: trimmed },
          };
        }
      }

      // 尝试匹配地点名
      for (const loc of ctx.connectedLocations) {
        if (trimmed.includes(loc.name)) {
          return {
            ok: true,
            action: { type: "move", locationId: asLocationId(loc.id) },
          };
        }
      }

      // 尝试匹配物品名
      for (const item of ctx.availableItems) {
        if (trimmed.includes(item.name)) {
          return {
            ok: true,
            action: { type: "take_item", itemId: asItemId(item.id) },
          };
        }
      }

      return { ok: false, reason: "unclassifiable" };
    },
  };
}
