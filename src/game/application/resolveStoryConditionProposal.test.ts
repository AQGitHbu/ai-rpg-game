import { describe, expect, it } from "vitest";
import { asFactId, asGenerationId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { resolveStoryConditionProposal } from "./resolveStoryConditionProposal";

const LOCATION = asLocationId("loc_condition");
const NPC = asNpcId("npc_condition");
const FACT = asFactId("fact_condition");

function world() {
  return createWorldStateFixture({
    generation: { generationId: asGenerationId("gen:condition"), seed: "seed", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
    projection: {
      ...emptyProjection({
        player: { name: "玩家", identity: "旅人", stats: { hp: 10, attack: 2, defense: 1 } },
        locations: [{ id: LOCATION, name: "现场", description: "", kind: "main", connectedLocationIds: [], npcIds: [NPC], availableItemIds: [], tags: [] }],
        currentLocationId: LOCATION,
      }),
      npcs: [{ id: NPC, name: "记录者", role: "记录者", description: "", locationId: LOCATION, isCompanion: false, tags: [], met: true,
        memory: { npcId: NPC, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: ["确认账册"] } }],
      worldFacts: [{ factId: FACT, text: "账册", source: "generated", discovered: false, locationId: LOCATION }],
    },
  });
}

const symbols = new Map<string, string>([["keeper", NPC], ["ledger", FACT]]);

describe("resolveStoryConditionProposal", () => {
  it("resolves a zero-based goal ordinal to the NPC's real goal id", () => {
    const result = resolveStoryConditionProposal({
      proposal: { kind: "goal_status", npcId: "keeper", goalOrdinal: 0, status: "active" },
      worldState: world(), symbols,
    });
    expect(result).toEqual({ ok: true, condition: { kind: "goal_status", npcId: NPC, goalId: `${NPC}_goal_1`, status: "active" } });
  });

  it("rejects ambiguous, cross-NPC, out-of-range and unknown references", () => {
    expect(resolveStoryConditionProposal({
      proposal: { kind: "goal_status", npcId: "keeper", goalId: "other_goal", goalOrdinal: 0, status: "active" } as never, worldState: world(), symbols,
    }).ok).toBe(false);
    expect(resolveStoryConditionProposal({
      proposal: { kind: "knows_fact", actorId: "keeper", factId: "missing" }, worldState: world(), symbols,
    }).ok).toBe(false);
    expect(resolveStoryConditionProposal({
      proposal: { kind: "goal_status", npcId: "keeper", goalOrdinal: 4, status: "active" }, worldState: world(), symbols,
    }).ok).toBe(false);
  });
});
