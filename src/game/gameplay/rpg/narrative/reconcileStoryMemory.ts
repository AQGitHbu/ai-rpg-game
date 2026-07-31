import type {
  GameEvent,
  GameState,
  LocationId,
  NpcContinuityMemory,
  NpcId,
  StoryMemoryEntry,
  StoryMemoryState
} from "@/game/domain";
import {
  STORY_MEMORY_RECENT_LIMIT,
  STORY_MEMORY_VERSION,
  storyMemoryOf
} from "@/game/domain";

// Phase 11 gameplay 纯 reducer：从 eventLedger 的 cursor 之后归约结构化剧情记忆。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §5。
// 纯函数：不读 IO/Date/process.env/随机数；不变异输入；不保存 AI 文案/token。
// eventLedger 是事实源；reducedThroughEventCount 必等于输入 eventLedger.length；
// 未知/不映射的事件只推进 cursor，绝不伪造条目。

/** reducer 输入：当前权威状态（含 eventLedger 与可选 storyMemory cursor）。 */
export type ReconcileStoryMemoryInput = {
  readonly state: GameState;
};

/**
 * 归约剧情记忆：处理 cursor 之后的事件，追加结构里程碑并更新 NPC 接触，
 * 截断 recent 到 STORY_MEMORY_RECENT_LIMIT。输入不可变。
 */
export function reconcileStoryMemory({ state }: ReconcileStoryMemoryInput): StoryMemoryState {
  const previous = storyMemoryOf(state);
  const ledger = state.eventLedger;
  // cursor 永不回退：若旧值越界（损坏存档），钳到 ledger 末尾安全推进。
  const start = Math.min(previous.reducedThroughEventCount, ledger.length);

  const newEntries: StoryMemoryEntry[] = [];
  const contacts: NpcContinuityMemory[] = previous.npcContacts.map((contact) => ({ ...contact }));

  for (let index = start; index < ledger.length; index++) {
    const event = ledger[index];
    const turn = index;
    const entry = mapEventToEntry(event, turn, state);
    if (entry !== null) newEntries.push(entry);
    const contact = contactUpdateFromEvent(event, turn, state);
    if (contact !== null) upsertContact(contacts, contact);
  }

  const recent = [...previous.recent, ...newEntries].slice(-STORY_MEMORY_RECENT_LIMIT);
  return {
    version: STORY_MEMORY_VERSION,
    reducedThroughEventCount: ledger.length,
    recent,
    npcContacts: contacts
  };
}

/** 将规则事件映射为结构里程碑；不映射的事件返回 null（仅推进 cursor）。 */
function mapEventToEntry(event: GameEvent, turn: number, state: GameState): StoryMemoryEntry | null {
  switch (event.type) {
    case "location_visited":
      return { kind: "location", locationId: event.locationId, turn };
    case "npc_met": {
      const locationId = resolveNpcLocation(state, event.npcId);
      if (locationId === null) return null; // NPC 不在状态：不伪造地点，只推进 cursor
      return { kind: "npc", npcId: event.npcId, locationId, turn };
    }
    case "fact_discovered":
      return { kind: "fact", factId: event.factId, turn };
    case "quest_unlocked":
      return { kind: "quest", questId: event.questId, status: "unlocked", turn };
    case "quest_completed":
      return { kind: "quest", questId: event.questId, status: "completed", turn };
    case "quest_failed":
      return { kind: "quest", questId: event.questId, status: "failed", turn };
    case "item_obtained":
      return { kind: "item", itemId: event.itemId, locationId: event.locationId, turn };
    case "battle_resolved":
      return { kind: "battle", enemyId: event.enemyId, outcome: event.outcome, turn };
    case "narrative_scene_presented":
      return {
        kind: "scene",
        sceneId: event.sceneId,
        locationId: event.locationId,
        focusNpcId: event.focusNpcId,
        pacing: event.pacing,
        turn
      };
    // game_initialized / location_observed / battle_started / battle_round_resolved /
    // enemy_defeated / narrative_choice / town_plan_generated / ending_reached：
    // 不映射为里程碑（信息经本章进展或任务/战斗视图单独呈现），只推进 cursor。
    default:
      return null;
  }
}

/** 从事件派生 NPC 接触更新（npc_met 与 scene focusNpcId）；其他事件返回 null。 */
function contactUpdateFromEvent(event: GameEvent, turn: number, state: GameState): NpcContinuityMemory | null {
  switch (event.type) {
    case "npc_met": {
      const locationId = resolveNpcLocation(state, event.npcId);
      if (locationId === null) return null;
      // Phase 13：按 interactionKind 生成安全摘要（旧存档缺省时不生成）
      let summary: string | undefined;
      if (event.interactionKind === "ask_main_quest") {
        summary = "你向NPC询问了重要线索。";
      } else if (event.interactionKind === "greet") {
        summary = "你初次结识了这位NPC。";
      }
      return {
        npcId: event.npcId,
        lastContactTurn: turn,
        lastLocationId: locationId,
        ...(summary !== undefined ? { lastInteractionSummary: summary } : {}),
      };
    }
    case "narrative_scene_presented": {
      if (event.focusNpcId === null) return null;
      return { npcId: event.focusNpcId, lastContactTurn: turn, lastLocationId: event.locationId };
    }
    default:
      return null;
  }
}

/** NPC 在 state.npcs 中的固定地点（NPC 不移动）；不存在返回 null。 */
function resolveNpcLocation(state: GameState, npcId: NpcId): LocationId | null {
  return state.npcs.find((npc) => npc.npcId === npcId)?.locationId ?? null;
}

/** 替换匹配 npcId 的接触或追加一条；操作本地副本，不触碰输入。 */
function upsertContact(contacts: NpcContinuityMemory[], contact: NpcContinuityMemory): void {
  const index = contacts.findIndex((entry) => entry.npcId === contact.npcId);
  if (index === -1) contacts.push(contact);
  // Scene events only advance the contact time/location. Preserve the last
  // explicit interaction summary until a later npc_met event provides a new
  // one, so an NPC does not forget the player's greeting after one scene.
  else contacts[index] = { ...contacts[index], ...contact };
}
