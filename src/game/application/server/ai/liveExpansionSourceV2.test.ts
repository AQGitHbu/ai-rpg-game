import { describe, it, expect } from "vitest";
import {
  parseExpansionProposals,
  filterProposalsByExistingLocations,
  createLiveExpansionSourceV2,
} from "./liveExpansionSourceV2";
import type { AiTransport, AiCompletionResult } from "@ai-game/ai-transport";
import type { WorldState } from "@/game/domain/worldState";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { asLocationId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ExpansionSourceContext } from "@/game/gameplay/rpg/expansion/expansionSource";
import { createInitialStoryState } from "@/game/domain/storyState";

function okCompletion(content: string): AiCompletionResult {
  return { ok: true, content, latencyMs: 10 };
}

function failCompletion(): AiCompletionResult {
  return { ok: false, code: "service_error", retryable: false, latencyMs: 10 };
}

function makeTransport(overrides: Partial<AiTransport> = {}): AiTransport {
  return {
    complete: async () => failCompletion(),
    stream: async () => ({ ok: false as const, code: "service_error" as const, retryable: false, latencyMs: 10 }),
    ...overrides,
  };
}

function makeContext(): ExpansionSourceContext {
  return {
    worldState: makeWs(),
    storyState: createInitialStoryState({
      gameLength: "short",
      initialEntityCounts: { locations: 3, npcs: 4, quests: 2, events: 10 },
    }),
    action: { type: "explore" },
    triggerReason: "low_tension",
  };
}

function makeWs(): WorldState {
  const loc: LocationEntry = {
    id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
    connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
  };
  return createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc,
    startingItemIds: [],
  });
}

describe("parseExpansionProposals", () => {
  it("parses a valid location proposal", () => {
    const result = parseExpansionProposals([{
      kind: "location", name: "密林", description: "一片幽暗的密林，野兽出没其中。", scale: "scene", connectFromLocationId: "loc_1", reason: "玩家前往",
    }]);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe("location");
    if (result[0]!.kind === "location") {
      expect(result[0]!.name).toBe("密林");
    }
  });

  it("drops unknown kinds", () => {
    const result = parseExpansionProposals([{ kind: "portal", name: "x" }, { kind: "npc", name: "老猎人", role: "猎人", description: "一个沉默寡言的老猎人。", locationId: "loc_1" }]);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe("npc");
  });

  it("drops proposals with overlong fields", () => {
    const longDesc = "x".repeat(300);
    const result = parseExpansionProposals([{
      kind: "location", name: "密林", description: longDesc, scale: "scene", connectFromLocationId: "loc_1", reason: "r",
    }]);
    expect(result).toEqual([]);
  });

  it("drops non-object / malformed entries", () => {
    const result = parseExpansionProposals([null, 42, "text", { kind: "fact", locationId: "loc_1" }]);
    expect(result).toEqual([]);
  });

  it("drops entries with missing required fields", () => {
    const result = parseExpansionProposals([{ kind: "npc", name: "老猎人", role: "猎人", description: "一个沉默寡言的老猎人。", locationId: "" }]);
    expect(result).toEqual([]);
  });

  it("parses a valid enemy proposal", () => {
    const result = parseExpansionProposals([{
      kind: "enemy", name: "狼群", tier: "normal", stats: { hp: 30, attack: 5, defense: 1 }, locationId: "loc_1", reason: "低张力",
    }]);
    expect(result.length).toBe(1);
    expect(result[0]!.kind).toBe("enemy");
  });

  it("drops enemy with non-numeric stats", () => {
    const result = parseExpansionProposals([{
      kind: "enemy", name: "狼群", tier: "normal", stats: { hp: "many", attack: 5, defense: 1 }, locationId: "loc_1",
    }]);
    expect(result).toEqual([]);
  });
});

describe("filterProposalsByExistingLocations", () => {
  it("keeps proposals referencing existing locations", () => {
    const proposals = [
      { kind: "location" as const, name: "密林", description: "一片幽暗的密林，野兽出没其中。", scale: "scene" as const, connectFromLocationId: "loc_1", reason: "r" },
      { kind: "npc" as const, name: "老猎人", role: "猎人", description: "一个沉默寡言的老猎人。", locationId: "loc_1" },
    ];
    const filtered = filterProposalsByExistingLocations(proposals, makeWs());
    expect(filtered.length).toBe(2);
  });

  it("drops proposals referencing non-existent locations (越权引用)", () => {
    const proposals = [
      { kind: "npc" as const, name: "老猎人", role: "猎人", description: "一个沉默寡言的老猎人。", locationId: "loc_missing" },
    ];
    const filtered = filterProposalsByExistingLocations(proposals, makeWs());
    expect(filtered).toEqual([]);
  });
});

describe("createLiveExpansionSourceV2", () => {
  it("returns fixture proposals when no transport/config (确定性兜底)", async () => {
    const source = createLiveExpansionSourceV2({});
    const result = await source.propose(makeContext());
    expect(Array.isArray(result.proposals)).toBe(true);
  });

  it("returns empty proposals on provider failure", async () => {
    const source = createLiveExpansionSourceV2({
      transport: makeTransport({ complete: async () => failCompletion() }),
      config: { baseUrl: "https://x", model: "m", apiKey: "k" },
    });
    const result = await source.propose(makeContext());
    expect(result.proposals).toEqual([]);
  });

  it("returns empty proposals on invalid JSON", async () => {
    const source = createLiveExpansionSourceV2({
      transport: makeTransport({ complete: async () => okCompletion("not json at all") }),
      config: { baseUrl: "https://x", model: "m", apiKey: "k" },
    });
    const result = await source.propose(makeContext());
    expect(result.proposals).toEqual([]);
  });

  it("returns empty proposals when source throws", async () => {
    const source = createLiveExpansionSourceV2({
      transport: makeTransport({ complete: async () => { throw new Error("boom"); } }),
      config: { baseUrl: "https://x", model: "m", apiKey: "k" },
    });
    const result = await source.propose(makeContext());
    expect(result.proposals).toEqual([]);
  });

  it("parses valid proposals from AI and filters bad references", async () => {
    const source = createLiveExpansionSourceV2({
      transport: makeTransport({
        complete: async () => okCompletion(JSON.stringify({
          proposals: [
            { kind: "npc", name: "老猎人", role: "猎人", description: "一个沉默寡言的老猎人。", locationId: "loc_1" },
            { kind: "npc", name: "幽灵", role: "路人", description: "一个不属于这里的幽灵。", locationId: "loc_nope" },
            { kind: "weird", name: "x" },
          ],
        })),
      }),
      config: { baseUrl: "https://x", model: "m", apiKey: "k" },
    });
    const result = await source.propose(makeContext());
    expect(result.proposals.length).toBe(1);
    expect(result.proposals[0]!.kind).toBe("npc");
  });
});
