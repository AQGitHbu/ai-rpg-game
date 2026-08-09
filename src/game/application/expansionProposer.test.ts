import { describe, it, expect } from "vitest";
import { runExpansionOrchestration } from "./expansionProposer";
import { createInitialWorldState, type LocationEntry } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion/expansionSource";
import type { ExpansionProposal } from "@/game/gameplay/rpg/expansion/expansionTypes";
import type { RuleEngineResult, ValidationCode } from "@/game/gameplay/rpg/ruleEngine";

function makeWs() {
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

function makeSs() {
  return createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 3, npcs: 4, quests: 2, events: 10 },
  });
}

function rejection(code: ValidationCode): RuleEngineResult {
  return { ok: false, code, feedback: `rejected: ${code}` };
}

const strangerTalk = { type: "talk", npcId: asNpcId("npc_stranger"), dialogueAct: "ask" } as const;

function sourceWith(proposals: readonly ExpansionProposal[]): ExpansionSource {
  return { async propose() { return { proposals }; } };
}

describe("runExpansionOrchestration", () => {
  it("does not call source when trigger does not fire", async () => {
    let called = false;
    const source: ExpansionSource = { async propose() { called = true; return { proposals: [] }; } };
    const ws = makeWs();
    const result = await runExpansionOrchestration({
      initialResult: { ok: true, nextWorldState: ws, nextStoryState: makeSs(), resolvedEvent: { actionId: "a", status: "success", eventKind: "observe", facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [] } },
      ws,
      ss: makeSs(),
      action: { type: "explore" },
      actionId: "a1",
      expansionSource: source,
      now: () => "2026-01-01",
    });
    expect(called).toBe(false);
    expect(result.triggered).toBe(false);
  });

  it("calls source once when trigger fires and returns approved expansion", async () => {
    let calls = 0;
    const source: ExpansionSource = {
      async propose() {
        calls += 1;
        return { proposals: [{ kind: "npc", name: "陌生人", role: "路人", description: "一个你不认识的路人出现在这里。", locationId: "loc_1" }] };
      },
    };
    const ws = makeWs();
    const result = await runExpansionOrchestration({
      initialResult: rejection("UNKNOWN_NPC"),
      ws,
      ss: makeSs(),
      action: strangerTalk,
      actionId: "a2",
      expansionSource: source,
      now: () => "2026-01-01",
    });
    expect(calls).toBe(1);
    expect(result.triggered).toBe(true);
    expect(result.approved).not.toBeNull();
    expect(result.approved!.newNpcs.length).toBe(1);
  });

  it("degrades to no-proposal when source throws (zero-write, no crash)", async () => {
    const source: ExpansionSource = { async propose() { throw new Error("boom"); } };
    const ws = makeWs();
    const result = await runExpansionOrchestration({
      initialResult: rejection("UNKNOWN_NPC"),
      ws,
      ss: makeSs(),
      action: strangerTalk,
      actionId: "a3",
      expansionSource: source,
      now: () => "2026-01-01",
    });
    // source 抛错 → 按“无提案”降级：本轮不扩张、不写状态，行动按普通拒绝返回。
    expect(result.triggered).toBe(false);
    expect(result.approved).toBeNull();
  });
});
