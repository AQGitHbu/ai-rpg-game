import { describe, it, expect } from "vitest";
import { approveExpansions } from "./approveExpansion";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ExpansionProposal } from "./expansionTypes";
import type { StoryBudget } from "@/game/domain/storyBudget";

describe("approveExpansions", () => {
  const loc1: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  const ws = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  const ss = createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 } });
  const deps = { genId: (prefix: string) => `${prefix}_test` };

  it("approves a valid location proposal", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget, deps);
    expect(result.approved.newLocations.length).toBe(1);
    expect(result.approved.newLocations[0]!.name).toBe("密林");
    expect(result.rejected).toEqual([]);
    expect(result.nextBudget.locations.expanded).toBe(1);
  });

  it("rejects location with too short name", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "林",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget, deps);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.reason).toBe("invalid_payload");
  });

  it("rejects location with broken connectFromLocationId", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_nonexistent",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget, deps);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("reference_broken");
  });

  it("rejects when budget exceeded", () => {
    const maxedBudget: StoryBudget = {
      ...ss.budget,
      locations: { ...ss.budget.locations, expanded: ss.budget.locations.max },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, maxedBudget, deps);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("budget_exceeded");
  });

  it("rejects when hard limit exceeded", () => {
    const hardLimitBudget: StoryBudget = {
      ...ss.budget,
      locations: { opening: 39, expanded: 1, max: 50 },
      hardLimit: { locations: 40, npcs: 30 },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, hardLimitBudget, deps);
    expect(result.approved.newLocations).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("hard_limit_exceeded");
  });

  it("approves a valid npc proposal", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "npc",
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
      locationId: "loc_1",
    }];
    const result = approveExpansions(proposals, ws, ss.budget, deps);
    expect(result.approved.newNpcs.length).toBe(1);
    expect(result.approved.newNpcs[0]!.name).toBe("老猎人");
    expect(result.nextBudget.npcs.expanded).toBe(1);
  });

  it("rejects npc with broken locationId reference", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "npc",
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
      locationId: "loc_nonexistent",
    }];
    const result = approveExpansions(proposals, ws, ss.budget, deps);
    expect(result.approved.newNpcs).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("reference_broken");
  });

  it("uses idOverride for location when provided", () => {
    const proposals: ExpansionProposal[] = [{
      kind: "location",
      name: "密林",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往",
    }];
    const result = approveExpansions(proposals, ws, ss.budget, deps, { kind: "location", id: "loc_custom_id" });
    expect(result.approved.newLocations[0]!.id).toBe(asLocationId("loc_custom_id"));
  });

  // ── Task 27：同批 ID 唯一与跨批引用 ──

  it("produces unique IDs for multiple entities of the same kind in one batch", () => {
    const proposals: ExpansionProposal[] = [
      {
        kind: "location",
        name: "密林",
        description: "一片幽暗的密林，传说中有猛兽出没。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "玩家要求前往",
      },
      {
        kind: "location",
        name: "洞窟",
        description: "一座幽深的山洞，深处隐约传来水声。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "玩家要求前往",
      },
    ];
    const result = approveExpansions(proposals, ws, ss.budget, { genId: (p) => `${p}_seq` });
    expect(result.approved.newLocations.length).toBe(2);
    const ids = result.approved.newLocations.map((l) => String(l.id));
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("approves a new location that references another newly-approved location in the same batch", () => {
    const proposals: ExpansionProposal[] = [
      {
        kind: "location",
        name: "密林",
        description: "一片幽暗的密林，传说中有猛兽出没。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "玩家要求前往",
      },
      {
        kind: "location",
        name: "林间空地",
        description: "密林深处一片被阳光照亮的小空地。",
        scale: "scene",
        connectFromLocationId: "loc_1",
        reason: "玩家要求前往",
      },
    ];
    // 带确定性 genId 序列，使第二个地点可引用第一个新地点 ID
    let seq = 0;
    const genId = (p: string) => `${p}_${++seq}`;
    const result = approveExpansions(proposals, ws, ss.budget, { genId });
    expect(result.approved.newLocations.length).toBe(2);
    expect(result.approved.newLocations[1]!.connectedLocationIds.length).toBe(1);
  });

  it("rejects an item proposal when events budget is exhausted", () => {
    const exhaustedBudget: StoryBudget = {
      ...ss.budget,
      events: { ...ss.budget.events, expanded: ss.budget.events.max },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "item",
      name: "锈剑",
      description: "一把已经生锈的铁剑。",
      kind_hint: "weapon",
      tags: [],
      locationId: "loc_1",
    }];
    const result = approveExpansions(proposals, ws, exhaustedBudget, deps);
    expect(result.approved.newItems).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("budget_exceeded");
  });

  it("rejects an enemy proposal when events budget is exhausted", () => {
    const exhaustedBudget: StoryBudget = {
      ...ss.budget,
      events: { ...ss.budget.events, expanded: ss.budget.events.max },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "enemy",
      name: "狼群",
      tier: "normal",
      stats: { hp: 30, attack: 5, defense: 1 },
      locationId: "loc_1",
      reason: "低张力需要敌对势力",
    }];
    const result = approveExpansions(proposals, ws, exhaustedBudget, deps);
    expect(result.approved.newEnemies).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("budget_exceeded");
  });

  it("rejects a fact proposal when events budget is exhausted", () => {
    const exhaustedBudget: StoryBudget = {
      ...ss.budget,
      events: { ...ss.budget.events, expanded: ss.budget.events.max },
    };
    const proposals: ExpansionProposal[] = [{
      kind: "fact",
      text: "传闻密林深处藏着失落的宝剑。",
      locationId: "loc_1",
      reason: "增加世界深度",
    }];
    const result = approveExpansions(proposals, ws, exhaustedBudget, deps);
    expect(result.approved.newFacts).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("budget_exceeded");
  });

  it("consumes events budget for approved item/enemy/fact", () => {
    const proposals: ExpansionProposal[] = [
      {
        kind: "item",
        name: "锈剑",
        description: "一把已经生锈的铁剑。",
        kind_hint: "weapon",
        tags: [],
        locationId: "loc_1",
      },
      {
        kind: "enemy",
        name: "狼群",
        tier: "normal",
        stats: { hp: 30, attack: 5, defense: 1 },
        locationId: "loc_1",
        reason: "低张力需要敌对势力",
      },
    ];
    const result = approveExpansions(proposals, ws, ss.budget, deps);
    expect(result.approved.newItems.length).toBe(1);
    expect(result.approved.newEnemies.length).toBe(1);
    expect(result.nextBudget.events.expanded).toBe(2);
  });
});
