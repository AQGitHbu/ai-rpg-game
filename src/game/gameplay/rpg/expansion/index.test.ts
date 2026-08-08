import { describe, it, expect } from "vitest";
import { runExpansionProposer } from "./index";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import type { ExpansionProposal } from "./expansionTypes";

const talkProposal: ExpansionProposal = {
  kind: "npc",
  name: "陌生人",
  role: "路人",
  description: "一个你不认识的人，出现在了这里。",
  locationId: "loc_1",
};

const locationProposal: ExpansionProposal = {
  kind: "location",
  name: "未知之地",
  description: "一片尚未探索的神秘区域，充满了未知的危险。",
  scale: "scene",
  connectFromLocationId: "loc_1",
  reason: "玩家要求前往未知地点",
};

describe("runExpansionProposer（纯函数：触发→审批→应用→重演算）", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [asLocationId("loc_2")], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const deps = { now: () => "2026-01-01" };

  it("returns no trigger when initial result is success", () => {
    const initialResult: RuleEngineResult = {
      ok: true,
      nextWorldState: ws,
      nextStoryState: ss,
      resolvedEvent: {
        actionId: "a1", status: "success", eventKind: "travel",
        facts: [], stateChanges: [], costs: [], rewards: [],
        triggeredEvents: [], rejectedEffects: [],
      },
    };
    const result = runExpansionProposer(
      initialResult, ws, ss,
      { type: "move", locationId: asLocationId("loc_2") },
      "act_1",
      [locationProposal],
      deps,
    );
    expect(result.triggered).toBe(false);
    expect(result.approved).toBeNull();
  });

  it("triggers expansion for UNKNOWN_LOCATION, re-evaluates action", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const wsWithUnlocked = { ...ws, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_unknown")] };
    const result = runExpansionProposer(
      initialResult, wsWithUnlocked, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_2",
      [locationProposal],
      deps,
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
    expect(result.approved).not.toBeNull();
    expect(result.approved!.newLocations.length).toBe(1);
    expect(result.reEvaluatedResult).not.toBeNull();
    expect(result.reEvaluatedResult!.ok).toBe(true);
  });

  it("returns no trigger when no proposals were fetched (source absent)", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const result = runExpansionProposer(
      initialResult, ws, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_3",
      null,
      deps,
    );
    expect(result.triggered).toBe(false);
  });

  it("triggers expansion for UNKNOWN_NPC, re-evaluates action", () => {
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_NPC",
      feedback: "Action rejected: UNKNOWN_NPC",
    };
    const result = runExpansionProposer(
      initialResult, ws, ss,
      { type: "talk", npcId: asNpcId("npc_unknown"), dialogueAct: "ask" },
      "act_4",
      [talkProposal],
      deps,
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe("entity_not_found");
    expect(result.approved).not.toBeNull();
    expect(result.approved!.newNpcs.length).toBe(1);
    expect(result.reEvaluatedResult).not.toBeNull();
    expect(result.reEvaluatedResult!.ok).toBe(true);
  });

  it("is synchronous: no source parameter, no await (pure decision chain)", () => {
    // 纯函数不得引入异步副作用——通过同步返回值形态钉死该契约。
    const initialResult: RuleEngineResult = {
      ok: false,
      code: "UNKNOWN_LOCATION",
      feedback: "Action rejected: UNKNOWN_LOCATION",
    };
    const syncResult = runExpansionProposer(
      initialResult, { ...ws, unlockedLocationIds: [asLocationId("loc_1"), asLocationId("loc_unknown")] }, ss,
      { type: "move", locationId: asLocationId("loc_unknown") },
      "act_5",
      [locationProposal],
      deps,
    );
    expect(syncResult.triggered).toBe(true);
    expect(syncResult.approved).not.toBeNull();
  });
});
