import type { GameEvent } from "@/game/domain/events";
import {
  projectEntityStore,
  type EntityCompatibilityProjection,
} from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { asGenerationId, asLocationId, asNpcId, asItemId, asEnemyId, asFactId, asQuestId } from "@/game/domain/worldEntity";
import type {
  EnemyEntry, ItemEntry, LocationEntry, NpcEntry, QuestEntry, QuestObjective, WorldFactEntry, WorldState,
} from "@/game/domain/worldState";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";

// 共享夹具：narrativeContext 纯函数测试用。
//
// 初始世界一次传入完整兼容投影——loc_1 的连接边指向 loc_2，因此 loc_2 必须与
// loc_1 同批具象化（旧夹具只建了 loc_1，连接引用悬空）。此后凡是要改写 13 个
// 兼容字段的用例一律经 withEntityProjection 重建 store，禁止 spread 单条 legacy
// 实体数组（那样只会让兼容字段与 entityStore 失同步）。

export const LOC_1_ID = asLocationId("loc_1");
export const LOC_2_ID = asLocationId("loc_2");
export const NPC_1_ID = asNpcId("npc_1");
export const NPC_2_ID = asNpcId("npc_2");
export const ITEM_SEAL_ID = asItemId("item_seal");
export const ENEMY_WOLF_ID = asEnemyId("enemy_wolf");
export const FACT_1_ID = asFactId("fact_1");

export const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};

export function makeNpc(id: typeof NPC_1_ID | typeof NPC_2_ID, name: string, role: string, met = false): NpcEntry {
  return {
    id, name, role, description: "t", locationId: LOC_1_ID, isCompanion: false, tags: [], met,
    memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
}

/** 客栈：玩家所在，老板在场，连通镇外山道。 */
const LOC_1: LocationEntry = {
  id: LOC_1_ID, name: "客栈", description: "山脚小镇的客栈。", kind: "main",
  connectedLocationIds: [LOC_2_ID], npcIds: [NPC_1_ID], availableItemIds: [], tags: [],
};
/** 山道：起始投影里就要存在，名册与物品均为空， unlocked/visited 沿用旧夹具（不含它）。 */
const LOC_2: LocationEntry = {
  id: LOC_2_ID, name: "山道", description: "镇外的山道。", kind: "main",
  connectedLocationIds: [LOC_1_ID], npcIds: [], availableItemIds: [], tags: [],
};
const ITEM_SEAL: ItemEntry = {
  id: ITEM_SEAL_ID, name: "盟誓印谱", description: "刻着盟约的印谱", kind: "quest", tags: [],
};
const ENEMY_WOLF: EnemyEntry = {
  id: ENEMY_WOLF_ID, name: "野狼", tier: "normal", stats: { hp: 30, attack: 6, defense: 2 },
  locationId: LOC_1_ID, tags: [],
};
const FACT_1: WorldFactEntry = {
  factId: FACT_1_ID, text: "矿坑里藏着密道", discovered: false, source: "generated", locationId: LOC_1_ID,
};

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [LOC_1, LOC_2],
  currentLocationId: LOC_1_ID,
  unlockedLocationIds: [LOC_1_ID],
  visitedLocationIds: [LOC_1_ID],
  npcs: [makeNpc(NPC_1_ID, "老板", "客栈老板")],
  items: [ITEM_SEAL],
  inventory: [],
  worldFacts: [FACT_1],
  quests: [],
  enemies: [ENEMY_WOLF],
  defeatedEnemyIds: [],
  factions: [],
};

/** 与 createInitialWorldState 一致：开局事件仍在账本里。 */
const INITIALIZED_LEDGER: readonly GameEvent[] = [{ type: "game_initialized", generation: GENERATION }];

/** 基础世界：客栈 + 老板 + 盟誓印谱 + 野狼 + 未发现事实（外加 loc_1 连通的山道）。 */
export function baseWorld(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { eventLedger: INITIALIZED_LEDGER, ...overrides },
  );
}

/** 兼容字段改写的唯一入口：覆盖项连同当前投影一起经生产组装点重建 store。 */
export function withEntityProjection(ws: WorldState, overrides: WorldStateFixtureOverrides): WorldState {
  return createWorldStateFixtureWith(
    { generation: ws.generation, base: projectEntityStore(ws.entityStore) },
    {
      battle: ws.battle,
      endings: ws.endings,
      ending: ws.ending,
      eventLedger: ws.eventLedger,
      ...overrides,
    },
  );
}

export function quest(objectives: readonly QuestObjective[], overrides: Partial<QuestEntry> = {}): QuestEntry {
  return {
    id: asQuestId("quest_0"), name: "查明真相", description: "d", objectives,
    onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
    tags: [], kind: "main", stage: 1, status: "active", ...overrides,
  };
}

export function withQuest(ws: WorldState, q: QuestEntry): WorldState {
  return withEntityProjection(ws, { quests: [...ws.quests, q] });
}

export function withMet(ws: WorldState, npcId = NPC_1_ID): WorldState {
  return withEntityProjection(ws, { npcs: ws.npcs.map((n) => (n.id === npcId ? { ...n, met: true } : n)) });
}

export function withInventoryItem(ws: WorldState, itemId = ITEM_SEAL_ID): WorldState {
  return withEntityProjection(ws, { inventory: [...ws.inventory, itemId] });
}

export function withDiscoveredFact(ws: WorldState, factId = FACT_1_ID): WorldState {
  return withEntityProjection(ws, { worldFacts: ws.worldFacts.map((f) => (f.factId === factId ? { ...f, discovered: true } : f)) });
}

/** battle 不是实体字段：直接改写兼容的非实体段即可。 */
export function withBattle(ws: WorldState, battle: WorldState["battle"]): WorldState {
  return { ...ws, battle };
}

export function withAddedNpc(ws: WorldState, npc: NpcEntry): WorldState {
  return withEntityProjection(ws, { npcs: [...ws.npcs, npc] });
}

/** 幕推进后的世界：旧主线完成 + 新幕主线具象化 + 新 NPC 到场。 */
export function withNextAct(ws: WorldState): WorldState {
  const completedQuest = quest([{ kind: "talk_to_npc", npcId: NPC_1_ID }], { status: "completed" });
  const nextQuest = quest([{ kind: "talk_to_npc", npcId: NPC_2_ID }], { id: asQuestId("quest_dyn_1"), name: "追查密信", stage: 2 });
  const grown = withAddedNpc(withMet(ws), makeNpc(NPC_2_ID, "信使", "传信人"));
  return withEntityProjection(grown, { quests: [completedQuest, nextQuest] });
}

export function canonicalResolvedEvent(): ResolvedEvent {
  return {
    actionId: "action-1", status: "success", eventKind: "observe",
    facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
  };
}
