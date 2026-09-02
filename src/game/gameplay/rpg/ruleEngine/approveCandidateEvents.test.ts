import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { approveCandidateEvents } from "./approveCandidateEvents";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/storyState";
import { asNpcId, asEnemyId, asLocationId, asGenerationId } from "@/game/domain/worldEntity";
import { createInitialWorldState } from "@/game/domain/worldState";
import { updateWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import type { NpcEntry, EnemyEntry } from "@/game/domain/worldState";

const NOW = () => "2026-08-09T00:00:00.000Z";

function makeWorldState(): ReturnType<typeof createInitialWorldState> {
  const ws = createInitialWorldState({
    generation: {
      generationId: asGenerationId("gen-1"),
      seed: "seed-1",
      templateVersion: "tpl-1",
      inputDigest: "digest",
      gameType: "wuxia",
    },
    player: { name: "P", identity: "hero", stats: { hp: 30, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_1"),
      name: "起点",
      description: "",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
  const npc: NpcEntry = {
    id: asNpcId("npc_1"),
    name: "老者",
    role: "导师",
    description: "",
    locationId: asLocationId("loc_1"),
    isCompanion: false,
    tags: [],
    met: true,
    memory: {
      npcId: asNpcId("npc_1"),
      knownFactIds: [],
      hiddenFactIds: [],
      interactionHistory: [],
      relationship: { affinity: 0 },
      emotion: "neutral",
      goals: [],
    },
  };
  const enemy: EnemyEntry = {
    id: asEnemyId("enemy_1"),
    name: "山贼",
    tier: "normal",
    stats: { hp: 10, attack: 5, defense: 2 },
    locationId: asLocationId("loc_1"),
    tags: [],
  };
  return updateWorldStateFixture(ws, { npcs: [npc], enemies: [enemy] });
}

function candidate(overrides?: Partial<EventCandidate>): EventCandidate {
  return {
    id: "c1",
    kind: "enemy_appears",
    involvedEntityIds: ["enemy_1", "loc_1"],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
    intendedPacing: "complicate",
    reason: "敌人现身",
    proposedAtTurn: 1,
    expiresAtTurn: 4,
    ...overrides,
  };
}

describe("approveCandidateEvents（经 ruleEngine 兼容再导出）", () => {
  const ss = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });

  it("approves events when budget allows", () => {
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [candidate()] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.length).toBe(0);
    expect(result.nextStoryState.budget.events.expanded).toBe(1);
  });

  it("rejects events when budget exhausted", () => {
    const exhaustedSs = {
      ...ss,
      budget: { ...ss.budget, events: { ...ss.budget.events, expanded: 6, max: 6 } },
    };
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: exhaustedSs, candidates: [candidate()] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.rejected.some((r) => r.reasonCode === "budget")).toBe(true);
  });

  it("empty pool returns same state", () => {
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.nextStoryState).toBe(ss);
  });

  it("approves at most 1 event per turn", () => {
    const a = candidate({ id: "c1" });
    const b = candidate({ id: "c2" });
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [a, b] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.map((c) => c.id)).toContain("c2");
  });

  it("emits candidate_event_approved audit event on approval", () => {
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [candidate()] }, { now: NOW });
    expect(result.drafts.some((e) => e.payload.type === "candidate_event_approved")).toBe(true);
  });
});
