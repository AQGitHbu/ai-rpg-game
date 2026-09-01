import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { resolveByType, autoResolveCurrentInvestigation } from "./resolveByType";
import { updateStoryMetrics } from "./updateStoryMetrics";
import { type EnemyEntry, type LocationEntry, type ItemEntry, type NpcEntry, type PlayerState, type QuestEntry, type WorldFactEntry, type WorldState } from "@/game/domain/worldState";
import { importNpcLayers, type NpcEntityRecord } from "@/game/domain/entity";
import { createInitialStoryState, type StoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asItemId, asFactId, asGenerationId, asEnemyId, asQuestId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import {
  createWorldStateFixture,
  createWorldStateFixtureWith,
  emptyProjection,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};
const PLAYER: PlayerState = { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } };

describe("resolveByType", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const BASE = emptyProjection({ player: PLAYER, locations: [loc1, loc2], currentLocationId: loc1.id });
  const ws = createWorldStateFixture({ generation: GENERATION, projection: BASE });
  const deps = { now: () => "2026-01-01", actionId: "act_x", turnNumber: 1 };

  it("move updates currentLocationId and adds event", () => {
    const result = resolveByType(ws, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
      expect(result.events[0]?.type).toBe("location_visited");
    }
  });

  it("move clears a resolved encounter so a later location can start another battle", () => {
    const afterBattle = {
      ...ws,
      battle: { status: "resolved" as const, enemyId: asEnemyId("enemy_old"), outcome: "victory" as const },
    };
    const result = resolveByType(afterBattle, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextWorldState.battle).toEqual({ status: "idle" });
  });

  it("talk marks npc as met", () => {
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
    };
    const wsWithNpc = createWorldStateFixtureWith({ generation: GENERATION, base: BASE }, { npcs: [npc] });
    const result = resolveByType(wsWithNpc, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const npc2 = result.nextWorldState.npcs.find((n) => n.id === asNpcId("npc_1"));
      expect(npc2?.met).toBe(true);
    }
  });

  it("ack_prologue returns unchanged state", () => {
    const result = resolveByType(ws, { type: "ack_prologue" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events).toHaveLength(0);
    }
  });

  it("explore emits location_explored primary event (Task 29)", () => {
    const result = resolveByType(ws, { type: "explore" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.map((e) => e.type)).toEqual(["location_explored"]);
      expect(result.nextWorldState.eventLedger.length).toBe(ws.eventLedger.length + 1);
    }
  });

});

describe("resolveByType status and stateChanges", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const BASE = emptyProjection({ player: PLAYER, locations: [loc1, loc2], currentLocationId: loc1.id });
  const ws = createWorldStateFixture({ generation: GENERATION, projection: BASE });
  const deps = { now: () => "2026-01-01", actionId: "act_x", turnNumber: 1 };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  it("move returns success status and stateChanges", () => {
    const result = resolveByType(ws, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges.length).toBeGreaterThan(0);
      expect(result.stateChanges.some((sc) => sc.path === "currentLocationId")).toBe(true);
    }
  });

  it("hostile bare ask has neutral outcome but remains partial_success", () => {
    const hostileNpc: NpcEntry = {
      ...npc1,
      id: asNpcId("npc_hostile"),
      name: "卫兵",
      memory: { ...npc1.memory, npcId: asNpcId("npc_hostile"), relationship: { affinity: -70 } },
    };
    const wsWithHostile = createWorldStateFixtureWith({ generation: GENERATION, base: BASE }, { npcs: [hostileNpc] });
    const result = resolveByType(wsWithHostile, { type: "talk", npcId: asNpcId("npc_hostile"), dialogueAct: "ask" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("partial_success");
    }
  });

  it("investigate undiscovered fact returns success", () => {
    const wsWithFact = createWorldStateFixtureWith({ generation: GENERATION, base: BASE }, {
      worldFacts: [{ factId: asFactId("fact_1"), text: "墙上刻字", source: "generated" as const, discovered: false }],
    });
    const result = resolveByType(wsWithFact, { type: "investigate", factId: asFactId("fact_1") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges.some((sc) => sc.path === "worldFacts[fact_1].discovered")).toBe(true);
    }
  });

  it("move during active battle returns blocked", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } };
    const result = resolveByType(wsInBattle, { type: "move", locationId: asLocationId("loc_2") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("blocked");
    }
  });

  it("freeform action returns success, appends player_intent_expressed event, but no stateChanges", () => {
    const result = resolveByType(ws, { type: "freeform", intent: "chat", rawText: "你好" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("success");
      expect(result.stateChanges).toEqual([]);
      expect(result.events.map((e) => e.type)).toEqual(["player_intent_expressed"]);
      expect(result.nextWorldState.eventLedger.length).toBe(ws.eventLedger.length + 1);
    }
  });
});

describe("resolveByType — attack", () => {
  const startingLocation: LocationEntry = {
    id: asLocationId("loc_1"), name: "荒野", description: "test", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const BASE = emptyProjection({
    player: { name: "侠客", identity: "剑客", stats: { hp: 30, attack: 6, defense: 4 } },
    locations: [startingLocation],
    currentLocationId: startingLocation.id,
  });
  function makeWorldWithEnemy(): WorldState {
    const enemy: EnemyEntry = {
      id: asEnemyId("enemy_1"), name: "山贼", tier: "normal",
      stats: { hp: 20, attack: 5, defense: 2 },
      locationId: asLocationId("loc_1"), tags: [],
    };
    return createWorldStateFixtureWith({ generation: GENERATION, base: BASE }, { enemies: [enemy] });
  }
  const deps = { now: () => "2026-01-01", actionId: "act_x", turnNumber: 1 };

  it("attack starts battle and returns active battle state", () => {
    const ws = makeWorldWithEnemy();
    const result = resolveByType(ws, { type: "attack", enemyId: asEnemyId("enemy_1") }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("active");
      expect(result.events.some((e) => e.type === "battle_started")).toBe(true);
      expect(result.status).toBe("success");
    }
  });

  it("battle_action attack resolves a round", () => {
    const ws = makeWorldWithEnemy();
    const started = resolveByType(ws, { type: "attack", enemyId: asEnemyId("enemy_1") }, deps);
    if (!started.ok) throw new Error("setup failed");
    const result = resolveByType(started.nextWorldState, { type: "battle_action", action: "attack" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events.some((e) => e.type === "battle_round_resolved")).toBe(true);
    }
  });

  it("battle_action flee ends battle", () => {
    const ws = makeWorldWithEnemy();
    const started = resolveByType(ws, { type: "attack", enemyId: asEnemyId("enemy_1") }, deps);
    if (!started.ok) throw new Error("setup failed");
    const result = resolveByType(started.nextWorldState, { type: "battle_action", action: "flee" }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState.battle.status).toBe("resolved");
    }
  });

  describe("give_item", () => {
    const giveLoc: LocationEntry = {
      id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    };
    const GIVE_BASE = emptyProjection({ player: PLAYER, locations: [giveLoc], currentLocationId: giveLoc.id });
    const npc: NpcEntry = {
      id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
      locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: true,
      memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 2 }, emotion: "neutral", goals: [] },
    };
    const item: ItemEntry = { id: asItemId("item_gift"), name: "铜钥匙", description: "旧钥匙", kind: "key", tags: [] };
    const wsWithGift = createWorldStateFixtureWith({ generation: GENERATION, base: GIVE_BASE }, {
      npcs: [npc],
      items: [item],
      inventory: [item.id],
    });
    const deps = { now: () => "2026-01-01", actionId: "act_give", turnNumber: 1 };

    it("移交背包物品：背包原子移除、item_given 落账、NPC 好感上升", () => {
      const result = resolveByType(wsWithGift, { type: "give_item", itemId: item.id, npcId: npc.id }, deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.nextWorldState.inventory).not.toContain(item.id);
        expect(result.events[0]).toMatchObject({ type: "item_given", itemId: item.id, npcId: npc.id });
        const after = result.nextWorldState.npcs.find((n) => n.id === npc.id);
        expect(after?.memory.relationship.affinity).toBe(3);
        expect(after?.memory.interactionHistory.at(-1)?.dialogueAct).toBe("offer");
        expect(result.status).toBe("success");
      }
    });

    it("战斗中无法给予", () => {
      const inBattle = { ...wsWithGift, battle: { status: "active" as const, enemyId: asEnemyId("enemy_1"), enemyHp: 10, playerHp: 10, round: 1 } };
      const result = resolveByType(inBattle, { type: "give_item", itemId: item.id, npcId: npc.id }, deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe("blocked");
        expect(result.nextWorldState.inventory).toContain(item.id);
      }
    });
  });
});

describe("resolveByType — talk 的窄 mutation batch", () => {
  const location: LocationEntry = {
    id: asLocationId("talk_loc"), name: "客栈", description: "", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const base = emptyProjection({ player: PLAYER, locations: [location], currentLocationId: location.id });

  function worldWithNpc(input: Partial<NpcEntry> = {}): WorldState {
    const npcId = asNpcId("talk_npc");
    const entry: NpcEntry = {
      id: npcId, name: "老板", role: "路人", description: "", locationId: location.id,
      isCompanion: false, tags: [], met: false,
      memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
      ...input,
    };
    const layers = importNpcLayers({ entry, createdAtTurn: 0 });
    const record: NpcEntityRecord = {
      core: { id: npcId, kind: "npc", name: entry.name, createdAtTurn: 0, lifecycle: "active" },
      identity: { role: entry.role, description: entry.description, tags: entry.tags, anchors: layers.anchors },
      position: { locationId: entry.locationId, locationOrder: 0 },
      dynamicState: layers.dynamicState,
      knowledge: layers.knowledge,
      relationships: entry.memory.relationship.affinity === 0 ? { outgoing: [] } : layers.relationships,
      history: layers.history,
    };
    const result = applyEntityMutations(createWorldStateFixture({ generation: GENERATION, projection: base }), [{ kind: "create_entities", records: [record] }]);
    if (!result.ok) throw new Error(`failed to create talk NPC: ${result.code}`);
    return result.worldState;
  }

  function npcRecord(ws: WorldState) {
    const record = entitiesOfKind(ws.entityStore, "npc")[0];
    if (record === undefined) throw new Error("missing talk NPC");
    return record;
  }

  function edge(ws: WorldState) {
    return npcRecord(ws).relationships.outgoing.find((item) => item.targetId === PLAYER_ENTITY_ID);
  }

  it("首次 support 在无 player edge 时写入 +3、met、history 摘要和 warm emotion", () => {
    const ws = worldWithNpc();
    const result = resolveByType(ws, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "talk_1", turnNumber: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const npc = result.nextWorldState.npcs[0]!;
    expect(edge(result.nextWorldState)?.dimensions.affinity).toBe(3);
    expect(npc.met).toBe(true);
    expect(npc.memory.interactionHistory).toHaveLength(1);
    expect(npc.memory.interactionHistory[0]).toMatchObject({ relationshipDelta: 3 });
    expect(npc.memory.interactionHistory[0]?.summary).toEqual(expect.stringContaining("首次见面"));
    expect(npc.memory.interactionHistory[0]?.summary).toEqual(expect.stringContaining("support"));
    expect(npc.memory.interactionHistory[0]?.summary).toEqual(expect.stringContaining("气氛融洽"));
    expect(npc.memory.interactionHistory[0]?.summary).toEqual(expect.stringContaining("+3"));
    expect(npc.memory.emotion).toBe("warm");
  });

  it("第二次 support 使用不同 actionId 时 affinity 到 6 且摘要为再次交谈", () => {
    const first = resolveByType(worldWithNpc(), { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "talk_1", turnNumber: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = resolveByType(first.nextWorldState, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "talk_2", turnNumber: 2 });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(edge(second.nextWorldState)?.dimensions.affinity).toBe(6);
      expect(second.nextWorldState.npcs[0]?.memory.interactionHistory[1]?.summary).toContain("再次交谈");
    }
  });

  it("重放相同 actionId 拒绝整次 talk，并保持每条原始 record 身份", () => {
    const first = resolveByType(worldWithNpc(), { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "talk_replay", turnNumber: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const beforeRecords = first.nextWorldState.entityStore.records;
    const replay = resolveByType(first.nextWorldState, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "talk_replay", turnNumber: 1 });
    expect(replay).toEqual({ ok: false, feedback: "世界状态不一致。" });
    expect(first.nextWorldState.entityStore.records).toHaveLength(beforeRecords.length);
    first.nextWorldState.entityStore.records.forEach((record, index) => expect(record).toBe(beforeRecords[index]));
  });

  it("bare ask 不建 player edge，只追加零 delta history 并保持 emotion", () => {
    const ws = worldWithNpc();
    const beforeNpc = npcRecord(ws);
    const result = resolveByType(ws, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "ask" }, { now: () => "2026-01-01", actionId: "ask_empty", turnNumber: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const afterNpc = npcRecord(result.nextWorldState);
      expect(afterNpc.relationships.outgoing).toHaveLength(0);
      expect(afterNpc.relationships).toBe(beforeNpc.relationships);
      expect(afterNpc.dynamicState.emotion).toBe("neutral");
      expect(afterNpc.history.interactions).toHaveLength(1);
      expect(afterNpc.history.interactions[0]?.relationshipDelta).toBe(0);
    }
  });

  it("talk 只写窄通道：knowledge identity 不变，而 history/dynamicState/relationships 改变", () => {
    const ws = worldWithNpc();
    const before = npcRecord(ws);
    const result = resolveByType(ws, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "narrow", turnNumber: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const after = npcRecord(result.nextWorldState);
      expect(after.knowledge).toBe(before.knowledge);
      expect(after.history).not.toBe(before.history);
      expect(after.dynamicState).not.toBe(before.dynamicState);
      expect(after.relationships).not.toBe(before.relationships);
    }
  });

  it("hostile threaten 返回 failure 但仍写入 threatened 的 fear/hostility/affinity 数值", () => {
    const ws = worldWithNpc({ met: true, memory: { npcId: asNpcId("talk_npc"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "neutral", goals: [] } });
    const result = resolveByType(ws, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "threaten" }, { now: () => "2026-01-01", actionId: "threaten", turnNumber: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("failure");
      expect(edge(result.nextWorldState)?.dimensions).toMatchObject({ affinity: -74, fear: 10, hostility: 4 });
    }
  });

  it("批次确实运行：WorldState 身份改变且只追加一个 eventLedger 事件", () => {
    const ws = worldWithNpc();
    const result = resolveByType(ws, { type: "talk", npcId: asNpcId("talk_npc"), dialogueAct: "support" }, { now: () => "2026-01-01", actionId: "event_batch", turnNumber: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextWorldState).not.toBe(ws);
      expect(result.nextWorldState.eventLedger).toHaveLength(ws.eventLedger.length + 1);
    }
  });
});

describe("resolveByType — investigate approaches", () => {
  const FACT_1_ID = asFactId("fact_1");
  const approachLoc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const deps = { now: () => "2026-01-01", actionId: "act_x", turnNumber: 1 };
  const APPROACH_BASE = emptyProjection({ player: PLAYER, locations: [approachLoc], currentLocationId: approachLoc.id });

  function worldWithApproaches(): WorldState {
    return createWorldStateFixtureWith({ generation: GENERATION, base: APPROACH_BASE }, {
      worldFacts: [{
        factId: FACT_1_ID,
        text: "车轮印",
        source: "generated",
        discovered: false,
        locationId: asLocationId("loc_1"),
        investigationApproaches: [
          { approachId: "careful", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
          { approachId: "risky", label: "翻查附近杂物", evidenceQuality: "noisy", tensionDelta: 12 },
        ],
      }],
    });
  }

  function storyWithDiscoverFact(): StoryState {
    return createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 } });
  }

  it("records clean versus noisy evidence and applies the declared tension cost", () => {
    const result = resolveByType(worldWithApproaches(), {
      type: "investigate", factId: FACT_1_ID, approachId: "risky",
    }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("investigate should succeed");
    expect(result.events[0]).toMatchObject({
      type: "fact_discovered", approachId: "risky", evidenceQuality: "noisy", tensionDelta: 12,
    });
    const nextStory = updateStoryMetrics(storyWithDiscoverFact(), result.events);
    expect(nextStory.tension).toBeGreaterThan(storyWithDiscoverFact().tension);
  });

  it("writes clean evidence with a small tension cost and marks the fact discovered", () => {
    const result = resolveByType(worldWithApproaches(), {
      type: "investigate", factId: FACT_1_ID, approachId: "careful",
    }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.events[0]).toMatchObject({
        type: "fact_discovered", approachId: "careful", evidenceQuality: "clean", tensionDelta: 4,
      });
      expect(result.nextWorldState.worldFacts[0]?.discovered).toBe(true);
      expect(result.stateChanges.some((change) => change.path.includes("discovered"))).toBe(true);
      expect(result.nextWorldState.eventLedger.length).toBe(worldWithApproaches().eventLedger.length + 1);
    }
  });
});

describe("autoResolveCurrentInvestigation", () => {
  const FACT_1_ID = asFactId("fact_1");
  const approachLoc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };

  const APPROACH_BASE = emptyProjection({ player: PLAYER, locations: [approachLoc], currentLocationId: approachLoc.id });
  const FACT_WITH_APPROACHES: WorldFactEntry = {
    factId: FACT_1_ID,
    text: "车轮印",
    source: "generated",
    discovered: false,
    locationId: asLocationId("loc_1"),
    investigationApproaches: [
      { approachId: "careful", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
      { approachId: "risky", label: "翻查附近杂物", evidenceQuality: "noisy", tensionDelta: 12 },
    ],
  };
  const FACT_APPROACHLESS: WorldFactEntry = {
    factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1"),
  };
  const QUEST_FACT: QuestEntry = {
    id: asQuestId("quest_fact"), name: "追查线索", description: "查明车轮印的来路",
    objectives: [{ kind: "discover_fact", factId: FACT_1_ID }],
    onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
    tags: [], kind: "main", stage: 1, status: "active",
  };
  const BOSS_NPC: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };

  function worldWithApproaches(overrides: WorldStateFixtureOverrides = {}): WorldState {
    return createWorldStateFixtureWith({ generation: GENERATION, base: APPROACH_BASE }, {
      worldFacts: [FACT_WITH_APPROACHES],
      ...overrides,
    });
  }

  function worldWithApproachlessFact(overrides: WorldStateFixtureOverrides = {}): WorldState {
    return createWorldStateFixtureWith({ generation: GENERATION, base: APPROACH_BASE }, {
      worldFacts: [FACT_APPROACHLESS],
      quests: [QUEST_FACT],
      ...overrides,
    });
  }

  function storyWithDiscoverFact(): StoryState {
    return createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 } });
  }

  it("automatically discovers an approach-less fact at a reveal boundary without exposing a player action", () => {
    const result = autoResolveCurrentInvestigation(worldWithApproachlessFact(), storyWithDiscoverFact());
    expect(result.events).toContainEqual(expect.objectContaining({ type: "fact_discovered", factId: FACT_1_ID }));
    expect(result.stateChanges.some((change) => change.path.includes("discovered"))).toBe(true);
  });

  it("emits the automatic event with omitted approach metadata and zero extra tension", () => {
    const result = autoResolveCurrentInvestigation(worldWithApproachlessFact(), storyWithDiscoverFact());
    const autoEvent = result.events[0];
    expect(autoEvent).toMatchObject({ type: "fact_discovered", factId: FACT_1_ID });
    if (autoEvent?.type === "fact_discovered") {
      expect(autoEvent.approachId).toBeUndefined();
      expect(autoEvent.evidenceQuality).toBeUndefined();
      expect(autoEvent.tensionDelta).toBeUndefined();
    }
    expect(updateStoryMetrics(storyWithDiscoverFact(), result.events).tension).toBe(42); // 30 + 12
  });

  it("returns no-op for a non-discover_fact current objective", () => {
    const ws = worldWithApproachlessFact({
      npcs: [BOSS_NPC],
      quests: [{
        id: asQuestId("quest_talk"), name: "交谈", description: "与老板交谈",
        objectives: [{ kind: "talk_to_npc", npcId: asNpcId("npc_1") }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "active",
      }],
    });
    const result = autoResolveCurrentInvestigation(ws, storyWithDiscoverFact());
    expect(result.events).toEqual([]);
    expect(result.nextWorldState).toBe(ws);
  });

  it("returns no-op when the approach-less fact is already discovered", () => {
    const ws = worldWithApproachlessFact({
      worldFacts: [{ ...FACT_APPROACHLESS, discovered: true }],
    });
    const result = autoResolveCurrentInvestigation(ws, storyWithDiscoverFact());
    expect(result.events).toEqual([]);
  });

  it("automatically discovers the current fact even when it has approved approaches", () => {
    const ws = worldWithApproaches({ quests: [QUEST_FACT] });
    const result = autoResolveCurrentInvestigation(ws, storyWithDiscoverFact());
    expect(result.events).toContainEqual(expect.objectContaining({ type: "fact_discovered", factId: FACT_1_ID }));
    expect(result.nextWorldState).not.toBe(ws);
  });
});
