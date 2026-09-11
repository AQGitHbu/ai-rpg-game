import { describe, expect, it } from "vitest";
import { parseBranchOption, type BranchOption } from "./narrativeBranch";

const option: BranchOption = {
  candidateId: "cand_a",
  dialogueAct: "offer",
  topic: { kind: "general" },
  target: { kind: "visit_location", locationId: "loc_1" },
  publicIntent: { text: "我跟你去一趟北岭。", facts: [], evidence: [], beatIds: [] },
  deferredLocation: null,
};

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...option, ...overrides };
}

describe("parseBranchOption", () => {
  it("accepts ordinary dialogue without a route target", () => {
    expect(parseBranchOption(raw({ target: null })).ok).toBe(true);
    expect(parseBranchOption(raw({ target: undefined })).ok).toBe(false);
  });

  it("accepts a fully typed route option", () => {
    expect(parseBranchOption(raw()).ok).toBe(true);
  });

  it("accepts every supported route target kind", () => {
    const targets: readonly BranchOption["target"][] = [
      { kind: "talk_to_npc", npcId: "npc_1" },
      { kind: "visit_location", locationId: "loc_1" },
      { kind: "obtain_item", itemId: "item_1" },
      { kind: "discover_fact", factId: "fact_1" },
      { kind: "defeat_enemy", enemyId: "enemy_1" },
    ];
    for (const target of targets) {
      expect(parseBranchOption(raw({ target })).ok).toBe(true);
    }
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(parseBranchOption(raw({ hiddenOutcome: "leak" })).ok).toBe(false);
  });

  it("rejects an unsupported dialogue act", () => {
    expect(parseBranchOption(raw({ dialogueAct: "murder" })).ok).toBe(false);
  });

  it("rejects an unknown route target kind", () => {
    expect(parseBranchOption(raw({ target: { kind: "teleport", locationId: "loc_1" } })).ok).toBe(false);
  });

  it("rejects a route target missing its entity id", () => {
    expect(parseBranchOption(raw({ target: { kind: "visit_location" } })).ok).toBe(false);
  });

  it("rejects an unknown structured topic kind", () => {
    expect(parseBranchOption(raw({ topic: { kind: "rumor", factId: "fact_1" } })).ok).toBe(false);
  });

  it("rejects an empty candidate id", () => {
    expect(parseBranchOption(raw({ candidateId: "" })).ok).toBe(false);
  });

  it("rejects an empty public intent", () => {
    expect(
      parseBranchOption(raw({ publicIntent: { text: "", facts: [], evidence: [], beatIds: [] } })).ok,
    ).toBe(false);
  });

  it("rejects a missing public intent", () => {
    expect(parseBranchOption(raw({ publicIntent: undefined })).ok).toBe(false);
  });

  it("accepts a deferred location definition", () => {
    expect(
      parseBranchOption(raw({
        target: { kind: "visit_location", locationId: "$deferred" },
        deferredLocation: {
          name: "北岭废驿",
          description: "官道旁废弃的驿站。",
          scale: "scene",
          placement: "world",
          connectFromLocationId: "loc_0",
        },
      })).ok,
    ).toBe(true);
  });

  it("rejects a deferred location with an unsupported placement", () => {
    expect(
      parseBranchOption(raw({
        deferredLocation: {
          name: "北岭废驿",
          description: "官道旁废弃的驿站。",
          scale: "town",
          placement: "town_building",
          connectFromLocationId: "loc_0",
        },
      })).ok,
    ).toBe(false);
  });
});
