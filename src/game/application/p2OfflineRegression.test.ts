import { describe, it, expect } from "vitest";
import { convertInteraction } from "./actionConverter";
import { createFixtureIntentParserSource } from "./server/ai/intentParserSource";
import { buildIntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import { createInitialWorldState, appendLocation, appendNpc, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asItemId, asGenerationId, asEnemyId } from "@/game/domain/scenarioBlueprint";

describe("P2 offline regression", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [asItemId("item_1")], tags: [],
  };
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const hostileNpc: NpcEntry = {
    id: asNpcId("npc_h"), name: "卫兵", role: "守卫", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_h"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: -70 }, emotion: "hostile", goals: [] },
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ws = { ...appendLocation(appendNpc(baseWs, npc1), loc2), unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const deps = { now: () => "2026-01-01" };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });

  it("free text → pre-classify → ruleEngine → commit (zero AI)", async () => {
    const ctx = buildIntentContext(ws);
    const converted = await convertInteraction(
      { kind: "free_text", text: "去街道看看" },
      new Map(),
      { intentContext: ctx },
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.action.type).toBe("move");
      const result = ruleEngine(ws, ss, converted.action, "act_1", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedEvent.status).toBe("success");
        expect(result.resolvedEvent.stateChanges.length).toBeGreaterThan(0);
        expect(result.nextWorldState.currentLocationId).toBe(asLocationId("loc_2"));
      }
    }
  });

  it("free text → AI fixture → talk → ruleEngine → commit", async () => {
    const ctx = buildIntentContext(ws);
    const source = createFixtureIntentParserSource();
    const converted = await convertInteraction(
      { kind: "free_text", text: "老板你好" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.action.type).toBe("talk");
      const result = ruleEngine(ws, ss, converted.action, "act_2", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedEvent.status).toBe("success");
        const npc = result.nextWorldState.npcs.find((n) => n.id === asNpcId("npc_1"));
        expect(npc?.met).toBe(true);
      }
    }
  });

  it("free text → freeform → no world change", async () => {
    const ctx = buildIntentContext(ws);
    const source = createFixtureIntentParserSource();
    const converted = await convertInteraction(
      { kind: "free_text", text: "我的武功升到一百级" },
      new Map(),
      { intentContext: ctx, intentParserSource: source },
    );
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.action.type).toBe("freeform");
      const result = ruleEngine(ws, ss, converted.action, "act_3", deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolvedEvent.status).toBe("success");
        expect(result.resolvedEvent.stateChanges).toEqual([]);
        expect(result.nextWorldState).toBe(ws);
      }
    }
  });

  it("partial_success: talk to hostile npc", () => {
    const wsWithHostile = appendNpc(ws, hostileNpc);
    const result = ruleEngine(wsWithHostile, ss, { type: "talk", npcId: asNpcId("npc_h") }, "act_4", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("partial_success");
    }
  });

  it("blocked: move during battle", () => {
    const wsInBattle = { ...ws, battle: { status: "active" as const, enemyId: asEnemyId("e1"), playerHp: 50, enemyHp: 30, round: 1 } };
    const result = ruleEngine(wsInBattle, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_5", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedEvent.status).toBe("blocked");
      expect(result.resolvedEvent.stateChanges).toEqual([]);
    }
  });
});
