import type { Action } from "@/game/domain/action";
import type { IntentContext } from "./intentContext";
import { asLocationId, asNpcId, asItemId, asFactId } from "@/game/domain/scenarioBlueprint";

const MOVE_VERBS = ["去", "前往", "到", "回", "进", "出"];
const TALK_VERBS = ["和", "与", "跟", "找", "问", "交谈", "聊聊", "说话"];
const TAKE_VERBS = ["拿", "取", "捡", "拿走", "拾起", "取走"];
const INVESTIGATE_VERBS = ["调查", "查看", "检查", "研究", "观察"];
const EXPLORE_VERBS = ["探索", "四处看看", "看看周围", "搜索"];
const REST_VERBS = ["休息", "睡觉", "歇息", "打坐"];

function matchesAny(text: string, verbs: readonly string[]): boolean {
  return verbs.some((v) => text.includes(v));
}

export function preClassifyFreeText(text: string, ctx: IntentContext): Action | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // 1. Move: text mentions a connected location name + move verb
  if (matchesAny(trimmed, MOVE_VERBS)) {
    for (const loc of ctx.connectedLocations) {
      if (trimmed.includes(loc.name)) {
        return { type: "move", locationId: asLocationId(loc.id) };
      }
    }
  }

  // 2. Talk: text mentions a present NPC name + talk verb
  if (matchesAny(trimmed, TALK_VERBS)) {
    for (const npc of ctx.presentNpcs) {
      if (trimmed.includes(npc.name)) {
        return { type: "talk", npcId: asNpcId(npc.id), dialogueAct: "ask", utterance: trimmed };
      }
    }
  }

  // 3. Take item: text mentions an available item name + take verb
  if (matchesAny(trimmed, TAKE_VERBS)) {
    for (const item of ctx.availableItems) {
      if (trimmed.includes(item.name)) {
        return { type: "take_item", itemId: asItemId(item.id) };
      }
    }
  }

  // 4. Investigate: text mentions a fact keyword + investigate verb
  if (matchesAny(trimmed, INVESTIGATE_VERBS)) {
    for (const fact of ctx.undiscoveredFacts) {
      if (trimmed.includes(fact.name)) {
        return { type: "investigate", factId: asFactId(fact.id), utterance: trimmed };
      }
    }
  }

  // 5. Explore
  if (matchesAny(trimmed, EXPLORE_VERBS)) {
    return { type: "explore" };
  }

  // 6. Rest
  if (matchesAny(trimmed, REST_VERBS)) {
    return { type: "rest" };
  }

  // 无法纯规则分类——需要 AI
  return null;
}
