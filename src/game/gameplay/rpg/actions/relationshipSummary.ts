// ---------------------------------------------------------------------------
// Phase 13：NPC 关系摘要投影器。
// 从 StoryMemory 的 npcContacts 中提取最近交互摘要。
// 纯函数，零 AI、零 IO、零随机。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { storyMemoryOf } from "@/game/domain";

export function projectRelationshipSummary(
  state: GameState,
  _blueprint: ScenarioBlueprint,
  npcId: string,
): string {
  const contact = storyMemoryOf(state).npcContacts.find(
    (c) => String(c.npcId) === npcId,
  );
  if (contact === undefined) return "";
  return contact.lastInteractionSummary ?? "";
}