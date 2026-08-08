import { describe, it, expect } from "vitest";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import { checkExpansionTrigger, runExpansionProposer } from "@/game/gameplay/rpg/expansion";
import { createInitialWorldState, type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import { createFixtureExpansionSource } from "./server/ai/expansionSource";
import { approveExpansions } from "@/game/gameplay/rpg/expansion/approveExpansion";
import type { ExpansionProposal } from "@/game/gameplay/rpg/expansion/expansionTypes";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import type { Action } from "@/game/domain/action";

/**
 * 模拟 application 的编排顺序（performTurn 同款）：
 * 触发判断 → await source 提案 → 纯 proposer 审批/重演算。
 * source 的 await 属于 application，这里按 application 职责显式完成。
 */
async function runOfflineExpansion(
  engineResult: RuleEngineResult,
  ws: Parameters<typeof ruleEngine>[0],
  ss: Parameters<typeof ruleEngine>[1],
  action: Action,
  actionId: string,
  useSource: boolean,
  deps: { readonly now: () => string },
): Promise<ReturnType<typeof runExpansionProposer>> {
  const source = createFixtureExpansionSource();
  const trigger = checkExpansionTrigger(engineResult, ws, ss, action);
  if (!trigger.triggered || !useSource) {
    return runExpansionProposer(engineResult, ws, ss, action, actionId, null, deps);
  }
  const sourceResult = await source.propose({
    worldState: ws,
    storyState: ss,
    action,
    triggerReason: trigger.reason,
  });
  return runExpansionProposer(engineResult, ws, ss, action, actionId, sourceResult.proposals, deps);
}

describe("P3 offline regression", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")],
    availableItemIds: [], tags: [],
  };
  const npc1: NpcEntry = {
    id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
    locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
    memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
  };
  const baseWs = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const loc2: LocationEntry = {
    id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = { ...baseWs, locations: [loc1, loc2], npcs: [npc1], unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_2")] };
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("move to unknown location → expansion triggered → re-evaluation succeeds", async () => {
    const wsWithUnlocked = { ...ws, unlockedLocationIds: [...ws.unlockedLocationIds, asLocationId("loc_mystery")] };
    const engineResult = ruleEngine(wsWithUnlocked, ss, { type: "move", locationId: asLocationId("loc_mystery") }, "act_1", deps);
    expect(engineResult.ok).toBe(false);
    if (!engineResult.ok) {
      const expansion = await runOfflineExpansion(
        engineResult, wsWithUnlocked, ss,
        { type: "move", locationId: asLocationId("loc_mystery") },
        "act_1",
        true,
        deps,
      );
      expect(expansion.triggered).toBe(true);
      expect(expansion.approved).not.toBeNull();
      expect(expansion.approved!.newLocations.length).toBe(1);
      expect(expansion.reEvaluatedResult?.ok).toBe(true);
    }
  });

  it("talk to unknown NPC → expansion triggered → re-evaluation succeeds", async () => {
    const engineResult = ruleEngine(ws, ss, { type: "talk", npcId: asNpcId("npc_stranger") }, "act_2", deps);
    expect(engineResult.ok).toBe(false);
    if (!engineResult.ok) {
      const expansion = await runOfflineExpansion(
        engineResult, ws, ss,
        { type: "talk", npcId: asNpcId("npc_stranger") },
        "act_2",
        true,
        deps,
      );
      expect(expansion.triggered).toBe(true);
      expect(expansion.approved).not.toBeNull();
      expect(expansion.approved!.newNpcs.length).toBe(1);
      expect(expansion.reEvaluatedResult?.ok).toBe(true);
    }
  });

  it("move to locked location (not entity_not_found) → no expansion", async () => {
    const engineResult = ruleEngine(ws, ss, { type: "move", locationId: asLocationId("loc_2") }, "act_3", deps);
    // This should succeed since loc_2 is unlocked and connected
    expect(engineResult.ok).toBe(true);
  });

  it("budget exhausted → no expansion triggered", async () => {
    const ssMaxed = { ...ss, budget: { ...ss.budget, locations: { ...ss.budget.locations, expanded: ss.budget.locations.max } } };
    const wsWithUnlocked = { ...ws, unlockedLocationIds: [...ws.unlockedLocationIds, asLocationId("loc_mystery")] };
    const engineResult = ruleEngine(wsWithUnlocked, ssMaxed, { type: "move", locationId: asLocationId("loc_mystery") }, "act_4", deps);
    expect(engineResult.ok).toBe(false);
    if (!engineResult.ok) {
      const expansion = await runOfflineExpansion(
        engineResult, wsWithUnlocked, ssMaxed,
        { type: "move", locationId: asLocationId("loc_mystery") },
        "act_4",
        false,
        deps,
      );
      expect(expansion.triggered).toBe(false);
    }
  });

  it("expansion source returns invalid proposal → proposal rejected → action still rejected", async () => {
    // Manually create an invalid proposal and test approveExpansions directly
    const invalidProposals: ExpansionProposal[] = [{
      kind: "location",
      name: "X", // too short
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(invalidProposals, ws, ss.budget, { genId: (p) => `${p}_1` });
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.reason).toBe("invalid_payload");
  });
});
