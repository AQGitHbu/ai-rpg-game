import { describe, it, expect } from "vitest";
import type {
  ExpansionProposal,
  ApprovedExpansion,
  ExpansionRejection,
  ExpansionTriggerReason,
  ExpansionResult,
} from "./expansionTypes";

describe("ExpansionTypes", () => {
  it("ExpansionProposal for location has kind=location", () => {
    const p: ExpansionProposal = {
      kind: "location",
      name: "密林深处",
      description: "一片幽暗的密林，传说中有猛兽出没。",
      scale: "scene",
      connectFromLocationId: "loc_1",
      reason: "玩家要求前往未知地点",
    };
    expect(p.kind).toBe("location");
  });

  it("ExpansionProposal for npc has kind=npc", () => {
    const p: ExpansionProposal = {
      kind: "npc",
      name: "老猎人",
      role: "猎人",
      description: "一个沉默寡言的老猎人。",
      locationId: "loc_1",
    };
    expect(p.kind).toBe("npc");
  });

  it("ApprovedExpansion carries Entry objects", () => {
    const a: ApprovedExpansion = {
      newLocations: [],
      newNpcs: [],
      newItems: [],
      newEnemies: [],
      newFacts: [],
      budgetConsumed: { locations: 0, npcs: 0, items: 0, enemies: 0, facts: 0 },
    };
    expect(a.newLocations).toEqual([]);
  });

  it("ExpansionResult noExpansion when trigger not met", () => {
    const r: ExpansionResult = {
      triggered: false,
      reason: "no_trigger",
      approved: null,
      nextBudget: null,
      reEvaluatedResult: null,
      rejectedProposals: [],
    };
    expect(r.triggered).toBe(false);
  });
});
