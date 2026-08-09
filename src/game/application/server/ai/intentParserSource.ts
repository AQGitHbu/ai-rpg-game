import type {
  IntentContext,
  IntentParserResult,
  IntentParserSource,
} from "@/game/gameplay/rpg/intentParser";
import { asLocationId, asNpcId, asItemId } from "@/game/domain/scenarioBlueprint";

// ---------------------------------------------------------------------------
// Fixture：确定性硬编码映射，用于离线测试。
// 类型定义在 gameplay 层（intentParserSource.ts），此文件只含 fixture 实现。
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
            action: { type: "talk", npcId: asNpcId(npc.id), dialogueAct: "ask", utterance: trimmed },
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
