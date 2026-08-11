import { createInitialWorldState, appendNpc, type WorldState, type NpcEntry, type QuestEntry, type QuestObjective } from "@/game/domain/worldState";
import { asGenerationId, asLocationId, asNpcId, asItemId, asEnemyId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

// 共享夹具：narrativeContext 纯函数测试用

export const LOC_1_ID = asLocationId("loc_1");
export const LOC_2_ID = asLocationId("loc_2");
export const NPC_1_ID = asNpcId("npc_1");
export const NPC_2_ID = asNpcId("npc_2");
export const ITEM_SEAL_ID = asItemId("item_seal");
export const ENEMY_WOLF_ID = asEnemyId("enemy_wolf");
export const FACT_1_ID = asFactId("fact_1");

export function makeNpc(id: typeof NPC_1_ID | typeof NPC_2_ID, name: string, role: string, met = false): NpcEntry {
  return {
    id, name, role, description: "t", locationId: LOC_1_ID, isCompanion: false, tags: [], met,
    memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
}

/** 基础世界：客栈 + 老板 + 盟誓印谱 + 野狼 + 未发现事实。 */
export function baseWorld(): WorldState {
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: LOC_1_ID, name: "客栈", description: "山脚小镇的客栈。", kind: "main",
      connectedLocationIds: [LOC_2_ID], npcIds: [NPC_1_ID], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  return {
    ...appendNpc(ws, makeNpc(NPC_1_ID, "老板", "客栈老板")),
    items: [{ id: ITEM_SEAL_ID, name: "盟誓印谱", description: "刻着盟约的印谱", kind: "quest", tags: [] }],
    enemies: [{ id: ENEMY_WOLF_ID, name: "野狼", tier: "normal", stats: { hp: 30, attack: 6, defense: 2 }, locationId: LOC_1_ID, tags: [] }],
    worldFacts: [{ factId: FACT_1_ID, text: "矿坑里藏着密道", discovered: false, source: "generated", locationId: LOC_1_ID }],
  };
}

export function quest(objectives: readonly QuestObjective[], overrides: Partial<QuestEntry> = {}): QuestEntry {
  return {
    id: asQuestId("quest_0"), name: "查明真相", description: "d", objectives,
    onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
    tags: [], kind: "main", stage: 1, status: "active", ...overrides,
  };
}

export function withQuest(ws: WorldState, q: QuestEntry): WorldState {
  return { ...ws, quests: [...ws.quests, q] };
}

export function withMet(ws: WorldState, npcId = NPC_1_ID): WorldState {
  return { ...ws, npcs: ws.npcs.map((n) => (n.id === npcId ? { ...n, met: true } : n)) };
}

export function withInventoryItem(ws: WorldState, itemId = ITEM_SEAL_ID): WorldState {
  return { ...ws, inventory: [...ws.inventory, itemId] };
}

export function withDiscoveredFact(ws: WorldState, factId = FACT_1_ID): WorldState {
  return { ...ws, worldFacts: ws.worldFacts.map((f) => (f.factId === factId ? { ...f, discovered: true } : f)) };
}

export function withBattle(ws: WorldState, battle: WorldState["battle"]): WorldState {
  return { ...ws, battle };
}

export function withAddedNpc(ws: WorldState, npc: NpcEntry): WorldState {
  return { ...ws, npcs: [...ws.npcs, npc] };
}

/** 幕推进后的世界：旧主线完成 + 新幕主线具象化 + 新 NPC 到场。 */
export function withNextAct(ws: WorldState): WorldState {
  const completedQuest = quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }], { status: "completed" });
  const nextQuest = quest([{ kind: "talk_to_npc", npcId: NPC_2_ID }], { id: asQuestId("quest_dyn_1"), name: "追查密信", stage: 2 });
  return {
    ...withAddedNpc(withMet(ws), makeNpc(NPC_2_ID, "信使", "传信人")),
    quests: [completedQuest, nextQuest],
  };
}

export function canonicalResolvedEvent(): ResolvedEvent {
  return {
    actionId: "action-1", status: "success", eventKind: "observe",
    facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
  };
}
