import type { GameState, NpcId, ScenarioBlueprint } from "@/game/domain";

// ---------------------------------------------------------------------------
// 纯规则 NPC 自由输入分类器（spec §4.2）。
// 零 AI、零 IO、零随机；判断在 50ms 内完成。
// 不映射到 PlayerIntent，不触发 resolveAction。
// ---------------------------------------------------------------------------

const EXPLORATION_VERBS = ["去", "找", "调查", "探索", "战斗", "查看", "搜索", "进入"];

function isShortText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 4 || /^[，。！？、；：""''（）\s]+$/.test(trimmed);
}

function hitQuestKeywords(text: string, blueprint: ScenarioBlueprint, state: GameState): boolean {
  const activeQuestIds = new Set(
    state.quests.filter((q) => q.status === "active").map((q) => String(q.questId))
  );
  return blueprint.quests.some((quest) => {
    if (!activeQuestIds.has(String(quest.id))) return false;
    const keywords = [quest.name, quest.description].filter(Boolean);
    return keywords.some((kw) => text.includes(kw));
  });
}

function hitBlueprintEntityNames(text: string, blueprint: ScenarioBlueprint): boolean {
  const names = [
    ...blueprint.locations.map((loc) => loc.name),
    ...blueprint.npcs.map((npc) => npc.name),
    ...blueprint.items.map((item) => item.name),
  ];
  return names.some((name) => text.includes(name));
}

function hasExplorationIntent(text: string): boolean {
  return EXPLORATION_VERBS.some((verb) => text.includes(verb));
}

export function classifyFreeDialogue(
  blueprint: ScenarioBlueprint,
  state: GameState,
  npcId: NpcId,
  playerText: string,
): "chat" | "narrative" {
  const text = playerText.trim();
  if (isShortText(text)) return "chat";

  // NPC 不在当前地点时无法触发叙事场景
  const npcState = state.npcs.find((n) => n.npcId === npcId);
  if (npcState === undefined || npcState.locationId !== state.currentLocationId) return "chat";

  if (hitQuestKeywords(text, blueprint, state)) return "narrative";
  if (hitBlueprintEntityNames(text, blueprint)) return "narrative";
  if (hasExplorationIntent(text)) return "narrative";

  return "chat";
}

// ---------------------------------------------------------------------------
// Phase 13：自由输入语气分类器。纯规则，零 AI。
// 与 classifyFreeDialogue 并列，供 handleNpcDialogue 在关系变化中使用。
// ---------------------------------------------------------------------------

export type DialogueTone = "positive" | "neutral" | "negative";

/** 中文语气关键词表。纯规则匹配，不调 AI。 */
const POSITIVE_KEYWORDS = ["谢谢", "帮忙", "你好", "佩服", "感激", "请", "拜托", "劳驾", "请问", "感谢"];
const NEGATIVE_KEYWORDS = ["混蛋", "滚", "威胁", "少管闲事", "闭嘴", "该死", "可恶", "别烦", "滚开", "去死"];

export function classifyDialogueTone(text: string): DialogueTone {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "neutral";

  for (const kw of NEGATIVE_KEYWORDS) {
    if (trimmed.includes(kw)) return "negative";
  }
  for (const kw of POSITIVE_KEYWORDS) {
    if (trimmed.includes(kw)) return "positive";
  }

  // 问句倾向中性（但"你吃饭了吗？"不触发关系变化）
  return "neutral";
}
